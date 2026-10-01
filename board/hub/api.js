// Member-facing operations behind the HTTP API (CONTRACT §5.2). Every state
// change is hub.apply() → states.step() inside the board's queue; the rest are
// plain row edits that never touch run state.

import { randomUUID } from 'node:crypto';
import { normalizeRemoteUrl } from '../shared/scope.js';
import { PLAN_APPROVAL_LABEL, isReservedLabel } from '../shared/states.js';
import { LABEL_COLORS, CODEX_PLAN_PERMISSION } from '../shared/protocol.js';
import { classifyPair, kindOf } from '../shared/overlap.js';
import { sponsorLine, alertsFor } from '../shared/cardface.js';
import { HubError, json } from './db.js';
import { newDeviceToken, sha256hex } from './auth.js';
import { cardView, cardDetail, boardSnapshot, publicLogin, labelDef, EMAIL_ONLY, LOCAL_ONLY, emailOnlyIdentity } from './views.js';
import { feedEvent, isFeedKind } from './hub.js';
import { can } from './permissions.js';
import { limitOrThrow } from './ratelimit.js';
import { quotaFor, teamName, createTeamBoard } from './identity/teams.js';
import { AI_IDS, AI_BACKENDS, aiOfDispatch, BUDGET_MAX_USD, runnerAis, readiness } from '../shared/ai.js';
import { insertCardRecord } from './card-record.js';
import { remoteScope, remoteMutation } from './remote/context.js';

const ACTION_EVENTS = {
  dispatch: 'dispatch', cancel: 'cancel', stop: 'stop', retry: 'retry', take_over: 'take_over', hand_over: 'hand_over',
  take_over_with_claude: 'redispatch', take_over_myself: 'take_myself', request_changes: 'request_changes',
  approve_done: 'approve_done', answer: 'answer',
};

const str = (v, max, name, { required = false } = {}) => {
  if (v == null || v === '') { if (required) throw new HubError('VALIDATION', `${name} required`); return null; }
  if (typeof v !== 'string' || v.length > max) throw new HubError('VALIDATION', `${name} must be a string ≤ ${max}`);
  return v;
};

// Card labels (D96): at most 20, each 1–50 characters once trimmed.
const MAX_CARD_LABELS = 20;
function cardLabels(v) {
  if (!Array.isArray(v) || v.length > MAX_CARD_LABELS || v.some((l) => typeof l !== 'string' || !l.trim() || l.trim().length > 50)) {
    throw new HubError('VALIDATION', `labels must be at most ${MAX_CARD_LABELS} strings of 1–50 characters`);
  }
  return v.map((l) => l.trim());
}

const COLORS = new Set(LABEL_COLORS);
function colorToken(v, name, { nullable = false } = {}) {
  if (v == null && nullable) return null;
  if (!COLORS.has(v)) throw new HubError('VALIDATION', `${name} must be one of ${LABEL_COLORS.join(', ')}`);
  return v;
}

function labelName(v) {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 50) throw new HubError('VALIDATION', 'name must be 1–50 characters');
  if (isReservedLabel(v)) throw new HubError('VALIDATION', 'via: and policy labels are reserved', { reason: 'RESERVED_LABEL' });
  return v.trim();
}

// A rename or strip rewrites every card holding the label in one transaction;
// past this many it is refused before anything is written (D91).
export const LABEL_REWRITE_MAX = 2000;

const archivedError = () => new HubError('CONFLICT', 'this card is archived: restore it first', { reason: 'ARCHIVED' });

export class Api {
  constructor(hub) {
    this.hub = hub;
    this.db = hub.db;
  }

  // ── access ────────────────────────────────────────────────────────────────
  boardFor(member, boardId) {
    const b = this.hub.board(boardId);
    if (!b || b.org_id !== member.org_id) throw new HubError('NOT_FOUND', 'board not found');
    return b;
  }

  cardFor(member, cardId) {
    const row = this.hub.card(cardId);
    if (!row) throw new HubError('NOT_FOUND', 'card not found');
    this.boardFor(member, row.board_id);
    return row;
  }

  orgMember(member, id) {
    const m = this.hub.activeMember(id);
    if (!m || m.org_id !== member.org_id) throw new HubError('VALIDATION', 'unknown member');
    return m;
  }

  requireWrite(member) {
    if (!this.hub.canWrite(member)) throw new HubError('FORBIDDEN', 'viewers cannot change the board');
  }

  // HTTP credentials are private server context, never fields of a card body.
  // Recheck after body reads and after waiting for the board queue: a revoked
  // account or removed/downgraded membership cannot finish an earlier write.
  currentMember(member, cred = null) {
    if (cred) {
      if (!['device', 'session'].includes(cred.kind) || !this.hub.accounts?.credValid(cred)) throw new HubError('UNAUTHENTICATED', 'sign in again');
      const owner = cred.kind === 'device'
        ? this.db.get('SELECT user_id FROM user_devices WHERE id = ?', cred.id)
        : this.db.get('SELECT user_id FROM sessions WHERE id = ?', cred.id);
      if (!owner || owner.user_id !== member?.user_id) throw new HubError('UNAUTHENTICATED', 'credential does not belong to this member');
    }
    const current = this.hub.activeMember(member?.id);
    const org = current && this.db.get('SELECT 1 AS x FROM orgs WHERE id = ? AND deleted_at IS NULL', current.org_id);
    const user = current?.user_id == null || this.db.get('SELECT 1 AS x FROM users WHERE id = ? AND deleted_at IS NULL', current.user_id);
    if (!current || current.org_id !== member.org_id || current.user_id !== member.user_id || !org || !user) throw new HubError('FORBIDDEN', 'current membership cannot access this board');
    return current;
  }

  currentWriter(member, cred = null, remote = null) {
    if (remote != null) {
      if (this.hub.viaScope.getStore()) throw new HubError('FORBIDDEN', 'remote authority cannot replace an integration actor');
      remoteScope(remote, member, true);
    }
    const current = this.currentMember(member, cred);
    if (!this.hub.canWrite(current)) throw new HubError('FORBIDDEN', 'current membership cannot change this board');
    return current;
  }

  collaborationScope(member, { boardId = null, cardId = null, allowArchived = false }, cred = null) {
    const current = this.currentWriter(member, cred);
    const card = cardId ? this.cardFor(current, cardId) : null;
    const board = this.boardFor(current, card?.board_id ?? boardId);
    this.writableBoard(board.id);
    if (card?.archived_at && !allowArchived) throw archivedError();
    return current;
  }

  requireAdmin(member) {
    if (!this.hub.isAdmin(member)) throw new HubError('FORBIDDEN', 'admin only');
  }

  writableBoard(boardId) {
    if (this.hub.board(boardId)?.archived_at) throw new HubError('CONFLICT', 'this board is archived: restore it first', { reason: 'BOARD_ARCHIVED' });
  }

  withWritableBoard(boardId, fn, { member = null, cred = null, remote = null } = {}) {
    return this.hub.withBoard(boardId, () => {
      const current = member ? this.currentWriter(member, cred, remote) : null;
      if (current) this.boardFor(current, boardId);
      this.writableBoard(boardId);
      if (remote != null) {
        const scope = remoteScope(remote, member, true);
        if (!scope.boardIds.includes(boardId)) throw new HubError('NOT_FOUND', 'selected board unavailable');
        return this.hub.txn(() => remoteMutation(remote, member, () => fn(current)));
      }
      return fn(current);
    });
  }

  listBoards(member, { includeArchived = false } = {}) {
    return { boards: this.hub.boardList(member.org_id, { includeArchived }) };
  }

  createBoard(member, body) {
    return createTeamBoard(this.hub, member, body, (id) => this.audit(member.id, 'board.create', id));
  }

  updateBoard(member, boardId, body) {
    if (!can(member, 'board.rename')) throw new HubError('FORBIDDEN', 'only admins can rename boards');
    this.boardFor(member, boardId);
    const name = teamName(body.name);
    return this.withWritableBoard(boardId, () => this.hub.txn(() => {
      if (!can(this.hub.activeMember(member.id), 'board.rename')) throw new HubError('FORBIDDEN', 'only admins can rename boards');
      const before = this.hub.board(boardId);
      if (before.name !== name) {
        this.db.run('UPDATE boards SET name = ? WHERE id = ?', name, boardId);
        this.audit(member.id, 'board.rename', boardId);
        this.hub.journal({ board_id: boardId, actor_kind: 'member', actor_id: member.id, kind: 'board.rename', payload: { name: [before.name, name] } });
        this.hub.later(() => this.hub.broadcastBoards(member.org_id));
      }
      return { board: this.hub.boardList(member.org_id).find((b) => b.id === boardId) };
    }));
  }

  setBoardArchived(member, boardId, archived) {
    if (!can(member, 'board.archive')) throw new HubError('FORBIDDEN', 'only admins can archive or restore boards');
    this.boardFor(member, boardId);
    return this.hub.withBoard(boardId, () => this.hub.txn(() => {
      if (!can(this.hub.activeMember(member.id), 'board.archive')) throw new HubError('FORBIDDEN', 'only admins can archive or restore boards');
      const board = this.hub.board(boardId);
      if (!!board.archived_at === archived) return { board: this.hub.boardList(member.org_id, { includeArchived: true }).find((b) => b.id === boardId) };
      if (archived) {
        if (this.db.get('SELECT COUNT(*) AS n FROM boards WHERE org_id = ? AND archived_at IS NULL', member.org_id).n <= 1) throw new HubError('CONFLICT', 'the last active board cannot be archived', { reason: 'LAST_ACTIVE_BOARD' });
        if (this.db.get(`SELECT 1 AS x FROM cards c LEFT JOIN runs r ON r.card_id = c.id
          WHERE c.board_id = ? AND (r.ended_at IS NULL AND r.id IS NOT NULL OR c.active_run_id IS NOT NULL
          OR c.run_state IN ('queued','claimed','running','quiet','blocked','parked','suspended','reconnecting','unresponsive','orphaned','handing_over')) LIMIT 1`, boardId)) throw new HubError('CONFLICT', 'stop active runs before archiving this board', { reason: 'ACTIVE_RUN' });
      }
      const at = archived ? this.hub.iso() : null;
      this.db.run('UPDATE boards SET archived_at = ? WHERE id = ?', at, boardId);
      const kind = archived ? 'board.archive' : 'board.restore';
      this.audit(member.id, kind, boardId);
      this.hub.journal({ board_id: boardId, actor_kind: 'member', actor_id: member.id, kind, payload: { archived_at: at } });
      this.hub.later(() => this.hub.broadcastBoards(member.org_id));
      return { board: this.hub.boardList(member.org_id, { includeArchived: true }).find((b) => b.id === boardId) };
    }));
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  me(member) {
    const org = this.db.get('SELECT id, name FROM orgs WHERE id = ?', member.org_id);
    const boards = this.hub.boardList(member.org_id);
    return { member: publicMember(member), org, boards };
  }

  snapshot(member, boardId, { includeArchived = false } = {}) {
    this.boardFor(member, boardId);
    return boardSnapshot(this.hub, boardId, member.id, { includeArchived });
  }

  detail(member, cardId) {
    const row = this.cardFor(member, cardId);
    return cardDetail(this.hub, row, member.id, (e) => (isFeedKind(e.kind) ? feedEvent(this.hub, e) : null));
  }

  handover(member, cardId) {
    this.cardFor(member, cardId);
    const h = this.hub.handoverDoc(cardId);
    return { doc: h.doc, ages: h.ages, markdown: h.markdown };
  }

  // GET /api/boards/:id/journal — this board's rows only (every card on it is in the board's repos).
  journalPage(member, boardId, { after_seq, limit } = {}) {
    this.boardFor(member, boardId);
    const after = Number.isSafeInteger(Number(after_seq)) ? Number(after_seq) : 0;
    const n = Math.min(Math.max(Number.isSafeInteger(Number(limit)) ? Number(limit) : 200, 1), 1000);
    const rows = this.db.all('SELECT * FROM journal WHERE board_id = ? AND seq > ? ORDER BY seq LIMIT ?', boardId, after, n)
      .map((j) => ({ ...j, payload: json(j.payload, {}) }));
    return { rows, next_after_seq: rows.length ? rows.at(-1).seq : after };
  }

  alerts(member, boardId) {
    const snap = this.snapshot(member, boardId);
    return {
      alerts: alertsFor(member.id, snap.cards),
      notifications: this.hub.notifications.filter((n) => n.board_id === boardId && n.to.includes(member.id) && !this.hub.card(n.card_id)?.archived_at).slice(-50),
    };
  }

  overlapPreview(member, cardId, targetMemberId, repoId) {
    const row = this.cardFor(member, cardId);
    if (repoId && !this.db.get('SELECT 1 AS x FROM board_repos WHERE board_id = ? AND repo_id = ?', row.board_id, repoId)) throw new HubError('NOT_FOUND', 'repo not on this board');
    const selectedRepo = repoId || row.repo_id;
    const tid = targetMemberId || member.id;
    const target = this.orgMember(member, tid);
    const prev = this.hub.latestRun(cardId);
    const self = {
      run_id: 'preview', repo_id: selectedRepo, branch: null, title: row.title, body: row.body,
      touched_paths: prev ? json(prev.touched_paths, []) : [], planned_paths: prev ? json(prev.planned_paths, []) : [],
    };
    const overlaps = [];
    if (selectedRepo) {
      for (const other of this.hub.liveRunsInRepo(selectedRepo)) {
        if (other.card_id === row.id) continue;
        const sig = classifyPair(self, other);
        if (!sig.length) continue;
        const level = sig.reduce((a, s) => ({ high: 3, medium: 2, low: 1 }[s.level] > { high: 3, medium: 2, low: 1 }[a] ? s.level : a), 'low');
        overlaps.push({ other_card_id: other.card_id, other_key: other.card_key, other_owner: other.owner_name, other_provider_label: other.provider_label ?? 'Agent', level, kind: kindOf(level), reasons: sig.map((s) => s.reason), paths: [...new Set(sig.flatMap((s) => s.paths))], age_ms: 0 });
      }
    }
    const dev = [...this.hub.runners.values()].find((c) => c.member_id === tid && c.repos.has(selectedRepo));
    const sponsor = sponsorLine({ target: { member_id: tid, name: target.display_name, is_viewer: tid === member.id, device_name: dev?.device.name } }) ?? '';
    const runners = [...this.hub.runners.values()].filter((c) => c.ready && c.member_id === tid && c.repos.has(selectedRepo)).map((c) => ({
      device_name: c.device.name,
      ai: (c.ai ?? runnerAis(undefined)).map((a) => ({ id: a.id, label: a.label, available: [null, 'may_need_sign_in'].includes(readiness(a)), reason: readiness(a), budget: a.capabilities.budget, legacy: a.legacy })),
    }));
    return { overlaps, sponsor, runners, can_use_no_budget: tid === member.id || this.hub.isAdmin(member) };
  }

  // ── cards ─────────────────────────────────────────────────────────────────
  async createCard(member, boardId, body, { cred = null, remote = null } = {}) {
    member = this.currentWriter(member, cred, remote);
    this.boardFor(member, boardId);
    const title = str(body.title, 200, 'title', { required: true });
    const text = str(body.body, 20_000, 'body') ?? '';
    const acceptance = str(body.acceptance, 10_000, 'acceptance');
    const baseRef = str(body.base_ref, 200, 'base_ref');
    const labels = cardLabels(body.labels ?? []);
    const cover = colorToken(body.cover, 'cover', { nullable: true });
    if (body.repo_id != null && !this.db.get('SELECT 1 AS x FROM board_repos WHERE board_id = ? AND repo_id = ?', boardId, body.repo_id)) throw new HubError('NOT_FOUND', 'repo not on this board');
    if (body.budget_usd != null && !(typeof body.budget_usd === 'number' && body.budget_usd >= 0)) throw new HubError('VALIDATION', 'budget_usd must be ≥ 0');
    const assignees = body.assignees ?? [];
    if (!Array.isArray(assignees)) throw new HubError('VALIDATION', 'assignees must be an array');
    for (const a of assignees) this.orgMember(member, a);
    // An integration's request_id is durable (integration_requests, D42): a
    // redelivery after a restart or a swept dedupe row returns the same card.
    const via = this.hub.viaScope.getStore();
    const once = via?.member_id === member.id && typeof body.request_id === 'string' && body.request_id
      ? { connection_id: via.connection_id, request_id: body.request_id } : null;
    return this.withWritableBoard(boardId, (current) => {
      member = current;
      if (body.repo_id != null && !this.db.get('SELECT 1 AS x FROM board_repos WHERE board_id = ? AND repo_id = ?', boardId, body.repo_id)) throw new HubError('NOT_FOUND', 'repo not on this board');
      for (const a of assignees) this.orgMember(member, a);
      const id = randomUUID();
      const now = this.hub.iso();
      let prior = null;
      this.hub.txn(() => {
        prior = once && this.db.get('SELECT card_id FROM integration_requests WHERE connection_id = ? AND request_id = ?', once.connection_id, once.request_id)?.card_id;
        if (prior) return;
        insertCardRecord(this.hub, boardId, member.id, {
          title, body: text, acceptance, repo_id: body.repo_id ?? null,
          base_ref: baseRef, labels: JSON.stringify(labels), budget_cents: body.budget_usd != null ? Math.round(body.budget_usd * 100) : null, cover,
        }, { id, now, assignees });
        if (once) this.db.insert('integration_requests', { ...once, card_id: id, created_at: now });
        const c = this.hub.card(id);
        // An integration's card text and external identifiers (the act()
        // external_ref, base_ref, request_id) are external: the append-only
        // journal can never erase them, so they go in as keyed hashes
        // (hub.refHash: a plain hash of a short title is guessable) and its
        // labels only as via:<provider> (D41); the text lives in `cards`,
        // where replay and the Dashboard read it.
        const common = { key: c.key, repo_id: c.repo_id, budget_cents: c.budget_cents, column_name: c.column_name, cover: c.cover, assignees: [...new Set(assignees)] };
        const payload = via?.member_id === member.id
          ? {
            ...common, title_hmac: this.hub.refHash(title), body_hmac: this.hub.refHash(text), acceptance_hmac: this.hub.refHash(acceptance), connection_id: via.connection_id,
            external_ref_hmac: this.hub.refHash(via.external_ref), base_ref_hmac: this.hub.refHash(baseRef), request_id_hmac: this.hub.refHash(body.request_id),
            labels: JSON.stringify(labels.filter((l) => l.startsWith('via:'))),
          }
          : { ...common, title, body: text, acceptance, base_ref: baseRef, labels: c.labels, request_id: body.request_id ?? null };
        this.hub.journal({ board_id: boardId, card_id: id, actor_kind: 'member', actor_id: member.id, kind: 'card.create', payload });
        this.hub.feed(id, 'created', {}, { actor: member.id });
        this.hub.later(() => this.hub.broadcastCard(id));
      });
      // The same request naming another board is not a replay of this one.
      if (prior && this.hub.card(prior).board_id !== boardId) throw new HubError('CONFLICT', 'this request_id already created a card on another board');
      return { card: cardView(this.hub, this.hub.card(prior ?? id), member.id) };
    }, { member, cred, remote });
  }

  async patchCard(member, cardId, body, { cred = null, remote = null } = {}) {
    member = this.currentWriter(member, cred, remote);
    const row0 = this.cardFor(member, cardId);
    return this.withWritableBoard(row0.board_id, (current) => {
      member = current;
      const row = this.cardFor(member, cardId);
      if (row.board_id !== row0.board_id) throw new HubError('CONFLICT', 'card moved while waiting');
      if (row.archived_at) throw archivedError();
      if (!Number.isSafeInteger(body.version) || body.version !== row.version) throw new HubError('VERSION_CONFLICT', 'card changed since you loaded it', { version: row.version });
      const set = {};
      if ('title' in body) set.title = str(body.title, 200, 'title', { required: true });
      if ('body' in body) set.body = str(body.body, 20_000, 'body') ?? '';
      if ('acceptance' in body) set.acceptance = str(body.acceptance, 10_000, 'acceptance');
      if ('base_ref' in body) set.base_ref = str(body.base_ref, 200, 'base_ref');
      if ('labels' in body) set.labels = JSON.stringify(cardLabels(body.labels));
      if ('cover' in body) set.cover = colorToken(body.cover, 'cover', { nullable: true });
      if ('repo_id' in body && body.repo_id !== row.repo_id) {
        if (row.run_state != null) throw new HubError('CONFLICT', 'repo cannot change while a run state exists');
        if (body.repo_id != null && !this.db.get('SELECT 1 AS x FROM board_repos WHERE board_id = ? AND repo_id = ?', row.board_id, body.repo_id)) throw new HubError('NOT_FOUND', 'repo not on this board');
        set.repo_id = body.repo_id;
      }
      if ('column' in body && body.column !== row.column_name) {
        if (row.run_state != null) throw new HubError('CONFLICT', 'column is driven by the run while a run state exists');
        if (!['todo', 'in_progress', 'in_review', 'done'].includes(body.column)) throw new HubError('VALIDATION', 'bad column');
        set.column_name = body.column;
      }
      if ('assignees' in body) {
        if (!Array.isArray(body.assignees)) throw new HubError('VALIDATION', 'assignees must be an array');
        for (const a of body.assignees) this.orgMember(member, a);
      }
      // A card an integration created holds external text; a person's edit
      // must not journal it in the clear either (D41), so those fields go in
      // as keyed hashes under *_hmac names (replay never reads them as text).
      const external = this.externalCard(cardId);
      this.hub.txn(() => {
        const fields = {};
        for (const k of Object.keys(set)) {
          if (set[k] === row[k]) continue;
          if (external && EXTERNAL_TEXT.has(k)) fields[`${k}_hmac`] = [this.hub.refHash(row[k]), this.hub.refHash(set[k])];
          else fields[k] = [row[k], set[k]];
        }
        if ('assignees' in body) fields.assignees = [this.hub.assignees(cardId), [...new Set(body.assignees)]];
        set.version = row.version + 1;
        set.updated_at = this.hub.iso();
        this.hub.journal({ board_id: row.board_id, card_id: cardId, actor_kind: 'member', actor_id: member.id, kind: 'card.update', payload: { fields, request_id: body.request_id ?? null } });
        const keys = Object.keys(set);
        this.db.run(`UPDATE cards SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => set[k]), cardId);
        if ('assignees' in body) {
          this.db.run("DELETE FROM card_assignees WHERE card_id = ? AND role = 'collaborator'", cardId);
          for (const a of new Set(body.assignees)) this.db.run("INSERT OR IGNORE INTO card_assignees (card_id, member_id, role) VALUES (?, ?, 'collaborator')", cardId, a);
        }
        this.hub.later(() => this.hub.broadcastCard(cardId));
      });
      return { card: cardView(this.hub, this.hub.card(cardId), member.id) };
    }, { member, cred, remote });
  }

  // External integration/client feedback/workflow context never enters the permanent
  // journal in the clear, including when staff later edit its card (D41).
  externalCard(cardId) {
    return !!this.db.get(
      "SELECT 1 AS x FROM integration_requests WHERE card_id = ? UNION ALL SELECT 1 FROM journal WHERE card_id = ? AND kind = 'card.create' AND (actor_kind = 'integration' OR json_extract(payload, '$.client_feedback_id') IS NOT NULL OR json_extract(payload, '$.workflow_instance_id') IS NOT NULL OR json_extract(payload, '$.capture_id') IS NOT NULL) LIMIT 1",
      cardId, cardId);
  }

  // ── archive (D94) ─────────────────────────────────────────────────────────
  // Only a card with no live run: no run yet, or done / failed. Idempotent.
  async archive(member, cardId, body, { cred = null } = {}) {
    member = this.currentWriter(member, cred);
    this.requireWrite(member);
    const row0 = this.cardFor(member, cardId);
    return this.withWritableBoard(row0.board_id, (current) => {
      member = current;
      const row = this.cardFor(member, cardId);
      if (row.board_id !== row0.board_id) throw new HubError('CONFLICT', 'card moved while waiting');
      if (!row.archived_at) {
        if (row.run_state != null && row.run_state !== 'done' && row.run_state !== 'failed') {
          throw new HubError('CONFLICT', 'stop, cancel or finish the run before archiving', { reason: 'RUN_ACTIVE' });
        }
        const now = this.hub.iso();
        this.hub.txn(() => {
          this.db.run('UPDATE cards SET archived_at = ?, archived_by = ?, version = version + 1, updated_at = ? WHERE id = ?', now, member.id, now, cardId);
          this.hub.journal({ board_id: row.board_id, card_id: cardId, actor_kind: 'member', actor_id: member.id, kind: 'card.archive', payload: { request_id: body.request_id ?? null, archived_at: now, archived_by: member.id } });
          this.hub.later(() => this.hub.broadcastRemove(row.board_id, cardId));
        });
      }
      return { card: cardView(this.hub, this.hub.card(cardId), member.id) };
    }, { member, cred });
  }

  async restore(member, cardId, body, { cred = null } = {}) {
    member = this.currentWriter(member, cred);
    this.requireWrite(member);
    const row0 = this.cardFor(member, cardId);
    return this.withWritableBoard(row0.board_id, (current) => {
      member = current;
      const row = this.cardFor(member, cardId);
      if (row.board_id !== row0.board_id) throw new HubError('CONFLICT', 'card moved while waiting');
      if (row.archived_at) {
        this.hub.txn(() => {
          this.db.run('UPDATE cards SET archived_at = NULL, archived_by = NULL, version = version + 1, updated_at = ? WHERE id = ?', this.hub.iso(), cardId);
          this.hub.journal({ board_id: row.board_id, card_id: cardId, actor_kind: 'member', actor_id: member.id, kind: 'card.restore', payload: { request_id: body.request_id ?? null } });
          this.hub.later(() => this.hub.broadcastCard(cardId));
        });
      }
      return { card: cardView(this.hub, this.hub.card(cardId), member.id) };
    }, { member, cred });
  }

  // ── label registry (D91) ──────────────────────────────────────────────────
  listLabels(member, boardId) {
    this.boardFor(member, boardId);
    return { labels: this.hub.labelRegistry(boardId) };
  }

  labelByName(boardId, name) {
    return this.db.get('SELECT * FROM board_labels WHERE board_id = ? AND name = ? COLLATE NOCASE', boardId, String(name).trim());
  }

  requireLabel(member, action) {
    if (!can(member, action)) throw new HubError('FORBIDDEN', action === 'label.manage' ? 'only admins can rename or delete labels' : 'viewers cannot change labels');
  }

  // POST: create, or recolour the entry of that name (its spelling stays: renaming is an admin's).
  async createLabel(member, boardId, body, { cred = null } = {}) {
    member = this.currentWriter(member, cred);
    this.boardFor(member, boardId);
    this.requireLabel(member, 'label.write');
    const name = labelName(body.name);
    const color = colorToken(body.color, 'color');
    const description = 'description' in body ? str(body.description, 200, 'description') : undefined;
    return this.withWritableBoard(boardId, (current) => {
      member = current;
      this.requireLabel(member, 'label.write');
      const old = this.labelByName(boardId, name);
      if (old) return { label: this.updateLabelLocked(member, boardId, old, { color, description }, body.request_id).label };
      const plan = this.db.get('SELECT o.plan FROM orgs o JOIN boards b ON b.org_id = o.id WHERE b.id = ?', boardId).plan;
      const limit = quotaFor(plan, 'labels');
      if (this.db.get('SELECT COUNT(*) AS n FROM board_labels WHERE board_id = ?', boardId).n >= limit) {
        throw new HubError('QUOTA_EXCEEDED', `this team's plan allows at most ${limit} labels per board`, { resource: 'labels', limit });
      }
      const id = randomUUID();
      const now = this.hub.iso();
      this.hub.txn(() => {
        this.db.insert('board_labels', { id, board_id: boardId, name, color, description: description ?? null, created_by: member.id, created_at: now, updated_at: now });
        this.hub.journal({ board_id: boardId, actor_kind: 'member', actor_id: member.id, kind: 'label.create', payload: { label_id: id, name, color, request_id: body.request_id ?? null } });
        this.hub.later(() => this.hub.broadcastLabels(boardId));
      });
      return { label: labelDef(this.db.get('SELECT * FROM board_labels WHERE id = ?', id)) };
    }, { member, cred });
  }

  async patchLabel(member, boardId, name, body, { cred = null } = {}) {
    member = this.currentWriter(member, cred);
    this.boardFor(member, boardId);
    this.requireLabel(member, 'label.write');
    if (isReservedLabel(name)) throw new HubError('VALIDATION', 'via: and policy labels are reserved', { reason: 'RESERVED_LABEL' });
    const patch = {
      name: 'name' in body ? labelName(body.name) : undefined,
      color: 'color' in body ? colorToken(body.color, 'color') : undefined,
      description: 'description' in body ? str(body.description, 200, 'description') : undefined,
    };
    return this.withWritableBoard(boardId, (current) => {
      member = current;
      this.requireLabel(member, 'label.write');
      const old = this.labelByName(boardId, name);
      if (!old) throw new HubError('NOT_FOUND', 'label not found');
      return this.updateLabelLocked(member, boardId, old, patch, body.request_id);
    }, { member, cred });
  }

  updateLabelLocked(member, boardId, old, { name, color, description }, requestId) {
    const fields = {};
    if (name !== undefined && name !== old.name) fields.name = [old.name, name];
    if (color !== undefined && color !== old.color) fields.color = [old.color, color];
    const describe = description !== undefined && description !== (old.description ?? null);
    if (!fields.name && !fields.color && !describe) return { label: labelDef(old), cards_updated: 0 };
    let hits = [];
    if (fields.name) {
      this.requireLabel(member, 'label.manage');
      const clash = this.labelByName(boardId, name);
      if (clash && clash.id !== old.id) throw new HubError('CONFLICT', 'a label with that name exists');
      hits = this.labelRewrite(boardId, old.name, name);
      limitOrThrow(this.hub, 'label_rewrite_board', boardId);
    }
    this.hub.txn(() => {
      this.db.run('UPDATE board_labels SET name = ?, color = ?, description = ?, updated_at = ? WHERE id = ?',
        name ?? old.name, color ?? old.color, description !== undefined ? description : old.description, this.hub.iso(), old.id);
      // The description is free text and the journal can never erase it: only that it changed.
      this.hub.journal({ board_id: boardId, actor_kind: 'member', actor_id: member.id, kind: 'label.update', payload: { label_id: old.id, fields, ...(describe ? { description_changed: true } : {}), request_id: requestId ?? null } });
      this.applyRewrite(member, boardId, hits, { cause: 'label.rename', label_id: old.id, request_id: requestId ?? null });
      this.hub.later(() => this.hub.broadcastLabels(boardId));
    });
    return { label: labelDef(this.db.get('SELECT * FROM board_labels WHERE id = ?', old.id)), cards_updated: hits.length };
  }

  async deleteLabel(member, boardId, name, body, { cred = null } = {}) {
    member = this.currentWriter(member, cred);
    this.boardFor(member, boardId);
    this.requireLabel(member, 'label.manage');
    if (isReservedLabel(name)) throw new HubError('VALIDATION', 'via: and policy labels are reserved', { reason: 'RESERVED_LABEL' });
    const strip = body.strip === true;
    return this.withWritableBoard(boardId, (current) => {
      member = current;
      this.requireLabel(member, 'label.manage');
      const old = this.labelByName(boardId, name);
      if (!old) throw new HubError('NOT_FOUND', 'label not found');
      const hits = strip ? this.labelRewrite(boardId, old.name, null) : [];
      if (strip) limitOrThrow(this.hub, 'label_rewrite_board', boardId);
      this.hub.txn(() => {
        this.db.run('DELETE FROM board_labels WHERE id = ?', old.id);
        this.hub.journal({ board_id: boardId, actor_kind: 'member', actor_id: member.id, kind: 'label.delete', payload: { label_id: old.id, name: old.name, strip, request_id: body.request_id ?? null } });
        this.applyRewrite(member, boardId, hits, { cause: 'label.delete', label_id: old.id, request_id: body.request_id ?? null });
        this.hub.later(() => this.hub.broadcastLabels(boardId));
      });
      return { ok: true, cards_updated: hits.length };
    }, { member, cred });
  }

  // Every card on the board (archived ones too) holding `from`, ignoring case,
  // with its labels after the rewrite (`to` null = removed). Refused before
  // anything is written when it would touch more than LABEL_REWRITE_MAX cards.
  labelRewrite(boardId, from, to) {
    const key = from.toLowerCase();
    const hits = [];
    for (const c of this.db.all("SELECT id, labels FROM cards WHERE board_id = ? AND labels != '[]'", boardId)) {
      const labels = json(c.labels, []);
      if (!labels.some((l) => typeof l === 'string' && l.toLowerCase() === key)) continue;
      const after = [...new Set(labels.flatMap((l) => (typeof l === 'string' && l.toLowerCase() === key ? (to == null ? [] : [to]) : [l])))];
      hits.push({ id: c.id, before: c.labels, after: JSON.stringify(after) });
    }
    if (hits.length > LABEL_REWRITE_MAX) throw new HubError('CONFLICT', `this label is on more than ${LABEL_REWRITE_MAX} cards`, { reason: 'TOO_MANY_CARDS', cards: hits.length });
    return hits;
  }

  // One card.update per card, with a version bump, so replay and open
  // editors (VERSION_CONFLICT) see an ordinary edit. Inside the caller's txn.
  applyRewrite(member, boardId, hits, { cause, label_id, request_id }) {
    const now = this.hub.iso();
    for (const h of hits) {
      const fields = this.externalCard(h.id) ? { labels_hmac: [this.hub.refHash(h.before), this.hub.refHash(h.after)] } : { labels: [h.before, h.after] };
      this.db.run('UPDATE cards SET labels = ?, version = version + 1, updated_at = ? WHERE id = ?', h.after, now, h.id);
      this.hub.journal({ board_id: boardId, card_id: h.id, actor_kind: 'member', actor_id: member.id, kind: 'card.update', payload: { fields, cause, label_id, request_id } });
      this.hub.later(() => this.hub.broadcastCard(h.id));
    }
  }

  // ── actions → step() ──────────────────────────────────────────────────────
  relations(row) {
    const run = this.hub.run(row.active_run_id) ?? this.hub.latestRun(row.id);
    const d = this.hub.pendingDispatch(row.id) ?? this.hub.lastDispatch(row.id);
    return {
      run, dispatch: d, assignees: this.hub.assignees(row.id),
      dispatcher: run && row.active_run_id ? run.dispatched_by : d?.dispatched_by ?? run?.dispatched_by ?? null,
      owner: run?.on_behalf_of ?? null,
    };
  }

  policyOk(row, budgetCents = row.budget_cents) {
    const labels = this.hub.labels(row);
    if (labels.includes('never_auto')) return false;
    if (budgetCents != null && this.hub.cardSpentCents(row.id) >= budgetCents) return false;
    return true;
  }

  async action(member, cardId, action, body, { cred = null } = {}) {
    member = this.currentWriter(member, cred);
    const type = ACTION_EVENTS[action];
    if (!type) throw new HubError('NOT_FOUND', `unknown action ${action}`);
    const row0 = this.cardFor(member, cardId);
    return this.withWritableBoard(row0.board_id, (current) => {
      const row = this.cardFor(current, cardId);
      if (row.board_id !== row0.board_id) throw new HubError('CONFLICT', 'card moved while waiting');
      this.requireActionRepo(row, action);
      return this.actionLocked(current, cardId, action, type, body);
    }, { member, cred });
  }

  requireActionRepo(row, action) {
    if (['dispatch', 'retry', 'take_over_with_claude', 'request_changes'].includes(action) && row.repo_id != null
      && !this.db.get('SELECT 1 AS x FROM board_repos WHERE board_id = ? AND repo_id = ?', row.board_id, row.repo_id)) throw new HubError('NOT_FOUND', 'repo not on this board');
  }

  actionLocked(member, cardId, action, type, body) {
    const row = this.hub.card(cardId);
    if (row.archived_at) throw archivedError();
    const rel = this.relations(row);
    const me = member.id;
    const admin = this.hub.isAdmin(member);
    const involved = (...ids) => admin || ids.flat().includes(me);
    const ctx = {
      has_repo: !!row.repo_id, can_write: this.hub.canWrite(member), policy_ok: this.policyOk(row),
      can_cancel: involved(rel.dispatch?.state === 'pending' ? rel.dispatch.dispatched_by : null, rel.assignees),
      can_stop: involved(rel.dispatcher, rel.owner, rel.assignees),
      can_hand_over: [rel.owner, rel.dispatcher, ...rel.assignees].includes(me),
      confirmed: body.confirm === true,
      require_plan_approval: this.hub.labels(row).includes(PLAN_APPROVAL_LABEL),
    };
    const event = { type, by: me };
    const opts = { ctx, actor: me };

    switch (action) {
      case 'dispatch':
      case 'retry':
      case 'take_over_with_claude': {
        if (!body.request_id) throw new HubError('VALIDATION', 'request_id required');
        const ai = body.ai ?? (body.backend === 'codex_cli' ? 'codex' : action === 'retry' ? aiOfDispatch(rel.dispatch ?? rel.run) : 'claude');
        if (!AI_IDS.includes(ai) || (body.backend != null && body.backend !== AI_BACKENDS[ai])) throw new HubError('VALIDATION', 'invalid AI or mismatched backend');
        let target = body.target_member_id ?? null;
        if (target == null && action === 'retry') target = rel.run?.on_behalf_of ?? null;
        if (target != null) this.orgMember(member, target);
        const existing = this.db.get('SELECT * FROM dispatches WHERE request_id = ?', body.request_id);
        if (existing && existing.card_id !== cardId) throw new HubError('CONFLICT', 'request_id belongs to another card');
        ctx.duplicate_request = !!existing;
        ctx.needs_confirm = this.hub.needsConfirm(me, target ?? me, row.repo_id);
        const supplied = Object.hasOwn(body, 'budget_usd');
        const mode = supplied ? (body.budget_usd === null ? 'none' : 'cap') : action === 'retry' ? rel.dispatch?.budget_mode ?? null : null;
        let cents = supplied && body.budget_usd === null ? null : row.budget_cents;
        if (supplied && body.budget_usd !== null) {
          const max = this.hub.boardSettings(row.board_id).max_budget_usd;
          if (!(typeof body.budget_usd === 'number' && Number.isFinite(body.budget_usd) && body.budget_usd >= 0.5 && body.budget_usd <= BUDGET_MAX_USD) || (!admin && Number.isFinite(max) && body.budget_usd > max)) throw new HubError('VALIDATION', 'budget must be between $0.50 and the allowed maximum');
          cents = Math.round(body.budget_usd * 100);
        }
        if (mode === 'none' && (target ?? me) !== me && !admin) throw new HubError('POLICY_DENIED', 'a budget is required on a teammate’s machine', { reason: 'BUDGET_REQUIRED' });
        if (ai === 'codex' && mode !== 'none') throw new HubError('POLICY_DENIED', 'Codex does not provide a native spend cap; explicitly choose no budget', { reason: 'BUDGET_UNSUPPORTED' });
        const oldDefault = this.hub.boardSettings(row.board_id).default_budget_usd;
        const beforeCap = rel.dispatch?.budget_mode === 'none' ? null : row.budget_cents ?? (Number.isFinite(oldDefault) ? Math.round(oldDefault * 100) : null);
        if (supplied && this.hub.cardSpentCents(cardId) > 0 && beforeCap != null && (cents == null || cents > beforeCap) && !involved(rel.dispatcher, rel.owner)) throw new HubError('FORBIDDEN', 'only the runner owner, dispatcher or an admin may raise the budget');
        ctx.policy_ok = this.policyOk(row, mode === 'none' ? null : cents);
        if (mode !== 'none') {
          const effective = cents ?? Math.round((this.hub.boardSettings(row.board_id).default_budget_usd ?? 5) * 100);
          if (effective - this.hub.cardSpentCents(cardId) < 50) ctx.policy_ok = false;
        }
        if (row.fail_kind === 'budget' && rel.run?.terminal_reason === 'budget_device') throw new HubError('POLICY_DENIED', 'the machine owner must change their local limit', { reason: 'DEVICE_LIMIT' });
        if (!existing && row.fail_kind === 'budget' && (!involved(rel.dispatcher, rel.owner) || mode === 'none' || cents == null || cents < Math.max(row.budget_cents ?? 0, this.hub.cardSpentCents(cardId)) + 50)) throw new HubError('POLICY_DENIED', 'increase the budget as its owner before continuing', { reason: 'BUDGET_TOO_LOW' });
        if (existing && (existing.backend !== AI_BACKENDS[ai] || existing.target_member_id !== target || existing.budget_mode !== mode || (mode === 'cap' && existing.budget_cents !== cents))) throw new HubError('CONFLICT', 'request_id already belongs to another dispatch choice');
        Object.assign(event, { request_id: body.request_id, target_member_id: target, backend: AI_BACKENDS[ai], ai, budget_mode: mode, budget_cents: mode === 'cap' ? cents : null });
        if (supplied && !existing && cents !== row.budget_cents) {
            opts.pre = () => {
              this.db.run('UPDATE cards SET budget_cents = ? WHERE id = ?', cents, cardId);
              this.hub.journal({ board_id: row.board_id, card_id: cardId, actor_kind: 'member', actor_id: me, kind: 'card.update', payload: { fields: { budget_cents: [row.budget_cents, cents] }, request_id: body.request_id } });
            };
        }
        break;
      }
      case 'hand_over': {
        const t = body.target;
        if (!t || !['queue', 'member', 'self'].includes(t.kind)) throw new HubError('VALIDATION', 'target.kind must be queue|member|self');
        if (t.kind === 'member') this.orgMember(member, t.member_id);
        event.target = { kind: t.kind, ...(t.kind === 'member' ? { member_id: t.member_id } : t.kind === 'self' ? { member_id: me } : {}), by: me };
        break;
      }
      case 'request_changes': {
        const comment = str(body.comment, 10_000, 'comment', { required: true });
        if (!body.request_id) throw new HubError('VALIDATION', 'request_id required');
        if (body.target_member_id != null) this.orgMember(member, body.target_member_id);
        const target = body.target_member_id ?? rel.run?.on_behalf_of ?? null;
        if (rel.dispatch?.budget_mode === 'none' && target !== me && !admin) throw new HubError('POLICY_DENIED', 'only the machine owner or an admin can assign uncapped work');
        ctx.needs_confirm = this.hub.needsConfirm(me, target ?? me, row.repo_id);
        const remaining = this.hub.remainingBudgetCents(row, rel.dispatch);
        ctx.policy_ok = this.policyOk(row, rel.dispatch?.budget_mode === 'none' ? null : row.budget_cents) && (remaining == null || remaining >= 50);
        Object.assign(event, { request_id: body.request_id, target_member_id: target, comment, ai: aiOfDispatch(rel.dispatch ?? rel.run), backend: rel.dispatch?.backend ?? rel.run?.backend ?? 'claude_cli', budget_mode: rel.dispatch?.budget_mode ?? null, budget_cents: rel.dispatch?.budget_cents ?? null });
        opts.pre = () => this.insertComment(member, cardId, { body: comment, for_agent: true });
        break;
      }
      case 'answer': {
        const ask = body.ask_id ? this.db.get('SELECT * FROM asks WHERE id = ? AND card_id = ?', body.ask_id, cardId) : null;
        if (!ask) throw new HubError('NOT_FOUND', 'ask not found');
        if (ask.state !== 'open') throw new HubError('ALREADY_ANSWERED', 'already answered', { answered_by: this.hub.memberName(ask.answered_by) });
        const answer = str(body.answer, 10_000, 'answer', { required: true });
        ctx.can_answer = involved(rel.dispatcher, rel.owner, rel.assignees);
        ctx.open_asks_remaining = this.hub.openAsks(cardId).filter((a) => a.id !== ask.id).length + this.hub.openPermissions(cardId).length;
        opts.extra = { answer: { ask_id: ask.id, answer, answered_by: { member_id: me, name: member.display_name } } };
        opts.pre = () => {
          const r = this.db.run("UPDATE asks SET state = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE id = ? AND state = 'open'", answer, me, this.hub.iso(), ask.id);
          if (Number(r.changes) === 0) throw new HubError('ALREADY_ANSWERED', 'already answered');
          this.hub.journal({ board_id: row.board_id, card_id: cardId, run_id: ask.run_id, actor_kind: 'member', actor_id: me, kind: 'ask.answer', payload: { ask_id: ask.id, by: me } });
        };
        break;
      }
      default:
        break;
    }

    const res = this.hub.apply(cardId, event, opts);
    if (!res.ok) throw new HubError(res.error.code, res.error.message, stripErr(res.error));
    return { card: cardView(this.hub, this.hub.card(cardId), me), ...(res.run_id ? { run_id: res.run_id } : {}) };
  }

  async answerPermission(member, prId, body, { cred = null } = {}) {
    member = this.currentWriter(member, cred);
    const pr0 = this.db.get('SELECT * FROM permission_requests WHERE id = ?', prId);
    if (!pr0) throw new HubError('NOT_FOUND', 'permission request not found');
    const row0 = this.cardFor(member, pr0.card_id);
    if (!['allow', 'deny'].includes(body.decision)) throw new HubError('VALIDATION', 'decision must be allow or deny');
    const scope = body.scope ?? 'once';
    if (!['once', 'run'].includes(scope)) throw new HubError('VALIDATION', 'scope must be once or run');
    return this.withWritableBoard(row0.board_id, (current) => {
      member = current;
      const pr = this.db.get('SELECT * FROM permission_requests WHERE id = ?', prId);
      if (!pr || pr.card_id !== row0.id) throw new HubError('NOT_FOUND', 'permission request not found');
      const row = this.cardFor(member, pr.card_id);
      if (row.board_id !== row0.board_id) throw new HubError('CONFLICT', 'card moved while waiting');
      if (pr.tool === CODEX_PLAN_PERMISSION && this.hub.viaScope.getStore()) throw new HubError('FORBIDDEN', 'a human must authorize Codex edits');
      if (!['open', 'parked'].includes(pr.state)) {
        throw new HubError('ALREADY_ANSWERED', 'another approver answered first', { answered_by: this.hub.memberName(pr.answered_by), state: pr.state });
      }
      if (!json(pr.approvers, []).includes(member.id)) throw new HubError('FORBIDDEN', 'not an approver of this request');
      const cardId = pr.card_id;
      if (this.hub.card(cardId).archived_at) throw archivedError();
      const ctx = {
        can_answer: true,
        open_asks_remaining: this.hub.openAsks(cardId).length + this.hub.openPermissions(cardId).filter((p) => p.id !== prId).length,
      };
      const state = body.decision === 'allow' ? 'allowed' : 'denied';
      const res = this.hub.apply(cardId, { type: 'answer', by: member.id }, {
        ctx, actor: member.id,
        extra: { answer: { permission_request_id: prId, decision: body.decision, scope, answered_by: { member_id: member.id, name: member.display_name } } },
        pre: () => {
          const r = this.db.run("UPDATE permission_requests SET state = ?, scope = ?, answered_by = ?, answered_at = ? WHERE id = ? AND state IN ('open','parked')", state, scope, member.id, this.hub.iso(), prId);
          if (Number(r.changes) === 0) throw new HubError('ALREADY_ANSWERED', 'another approver answered first');
          this.hub.journal({ card_id: cardId, run_id: pr.run_id, actor_kind: 'member', actor_id: member.id, kind: 'permission.answer', payload: { permission_request_id: prId, decision: body.decision, scope } });
        },
      });
      if (!res.ok) throw new HubError(res.error.code, res.error.message, stripErr(res.error));
      const after = this.db.get('SELECT * FROM permission_requests WHERE id = ?', prId);
      return {
        permission_request: { id: after.id, tool: after.tool, input_summary: after.input_summary, state: after.state, scope: after.scope, approvers: json(after.approvers, []), answered_by_name: member.display_name },
        card: cardView(this.hub, this.hub.card(cardId), member.id),
      };
    }, { member, cred });
  }

  // ── comments ──────────────────────────────────────────────────────────────
  insertComment(member, cardId, { body, for_agent = false, reply_to = null }) {
    const id = randomUUID();
    const replyTo = reply_to && this.db.get('SELECT 1 AS x FROM comments WHERE id = ? AND card_id = ?', reply_to, cardId) ? reply_to : null;
    // Text an integration wrote (inside its actVia scope) is outside text:
    // never trusted, so it can never reach a running agent (deliverComments).
    const byIntegration = this.hub.viaScope.getStore()?.member_id === member.id;
    const source = byIntegration ? 'integration' : 'web';
    this.db.insert('comments', { id, card_id: cardId, author_member_id: member.id, source, trusted: byIntegration ? 0 : 1, body, for_agent: for_agent ? 1 : 0, reply_to: replyTo, created_at: this.hub.iso() });
    this.hub.journal({ card_id: cardId, actor_kind: 'member', actor_id: member.id, kind: 'comment.create', payload: { comment_id: id, source, for_agent: !!for_agent } });
    return id;
  }

  async comment(member, cardId, body, { cred = null, remote = null } = {}) {
    member = this.currentWriter(member, cred, remote);
    const row0 = this.cardFor(member, cardId);
    const text = str(body.body, 10_000, 'body', { required: true });
    return this.withWritableBoard(row0.board_id, (current) => {
      member = current;
      const row = this.cardFor(member, cardId);
      if (row.board_id !== row0.board_id) throw new HubError('CONFLICT', 'card moved while waiting');
      if (row.archived_at) throw archivedError();
      let id;
      this.hub.txn(() => {
        id = this.insertComment(member, cardId, { body: text, for_agent: body.for_agent === true, reply_to: body.reply_to });
        this.hub.feed(cardId, 'comment', { comment_id: id }, { actor: member.id });
      });
      if (body.for_agent === true) this.hub.deliverComments(cardId);
      const c = this.db.get('SELECT * FROM comments WHERE id = ?', id);
      return { comment: { id, author_name: member.display_name, source: c.source, trusted: !!c.trusted, body: c.body, for_agent: !!c.for_agent, reply_to: c.reply_to, created_age_ms: 0 } };
    }, { member, cred, remote });
  }

  // ── devices, repos, members ───────────────────────────────────────────────
  listDevices(member) {
    const rows = this.hub.isAdmin(member)
      ? this.db.all('SELECT d.* FROM devices d JOIN members m ON m.id = d.member_id WHERE m.org_id = ? ORDER BY d.created_at', member.org_id)
      : this.db.all('SELECT * FROM devices WHERE member_id = ? ORDER BY created_at', member.id);
    return { devices: rows.map((d) => ({ id: d.id, member_id: d.member_id, name: d.name, kind: d.kind, online: this.hub.runners.get(d.id)?.ready === true, last_seen_age_ms: this.hub.ageOf(d.last_seen_at), created_age_ms: this.hub.ageOf(d.created_at), revoked: d.revoked_at != null })) };
  }

  createDevice(member, body) {
    this.requireWrite(member);
    const name = str(body.name, 100, 'name', { required: true });
    const cf = str(body.cf_service_token_id, 200, 'cf_service_token_id');
    const token = newDeviceToken();
    const id = randomUUID();
    this.db.insert('devices', { id, member_id: member.id, name, kind: 'runner', token_hash: sha256hex(token), cf_service_token_id: cf, created_at: this.hub.iso() });
    this.audit(member.id, 'device.create', id);
    return { device_id: id, device_token: token };
  }

  revokeDevice(member, id) {
    const d = this.hub.device(id);
    const owner = d && this.hub.member(d.member_id);
    if (!d || owner.org_id !== member.org_id) throw new HubError('NOT_FOUND', 'device not found');
    if (d.member_id !== member.id && !this.hub.isAdmin(member)) throw new HubError('FORBIDDEN', 'not your device');
    this.db.run('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', this.hub.iso(), id);
    this.hub.runners.get(id)?.close(4403, 'device revoked');
    this.hub.presence.dropDevice(id);
    this.audit(member.id, 'device.revoke', id);
    return { ok: true };
  }

  listRepos(member) {
    return { repos: this.db.all('SELECT * FROM repos WHERE org_id = ? ORDER BY short_name', member.org_id).map(publicRepo) };
  }

  createRepo(member, body) {
    this.requireAdmin(member);
    const canonical = normalizeRemoteUrl(body.url);
    if (!canonical) throw new HubError('VALIDATION', 'url is not a network git remote');
    if (this.db.get('SELECT 1 AS x FROM repos WHERE org_id = ? AND canonical_url = ?', member.org_id, canonical)) throw new HubError('CONFLICT', 'repo exists');
    const id = randomUUID();
    this.db.insert('repos', {
      id, org_id: member.org_id, canonical_url: canonical, short_name: str(body.short_name, 100, 'short_name') ?? canonical.split('/').pop(),
      default_branch: str(body.default_branch, 200, 'default_branch') ?? 'main',
    });
    this.audit(member.id, 'repo.create', id);
    return { repo: publicRepo(this.hub.repo(id)) };
  }

  addBoardRepo(member, boardId, body) {
    this.requireAdmin(member);
    this.boardFor(member, boardId);
    const repo = this.hub.repo(body.repo_id);
    if (!repo || repo.org_id !== member.org_id) throw new HubError('NOT_FOUND', 'repo not found');
    return this.withWritableBoard(boardId, () => {
      this.db.run('INSERT OR IGNORE INTO board_repos (board_id, repo_id) VALUES (?, ?)', boardId, repo.id);
      this.audit(member.id, 'board.repo.add', `${boardId}:${repo.id}`);
      return { ok: true };
    });
  }

  // Access maps members by email only (any IdP, e.g. the one-time PIN), so a
  // GitHub login/id is optional. Without one the row gets a private
  // placeholder (never shown: publicMember reports github_login null).
  createMember(member, body) {
    this.requireAdmin(member);
    const email = str(body.email, 320, 'email', { required: true });
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HubError('VALIDATION', 'email is not an address');
    const given = str(body.github_login, 100, 'github_login');
    if (given?.startsWith(EMAIL_ONLY) || given?.startsWith(LOCAL_ONLY)) throw new HubError('VALIDATION', 'bad github_login');
    if (body.github_id != null && !Number.isSafeInteger(body.github_id)) throw new HubError('VALIDATION', 'github_id must be an integer');
    const login = given ?? emailOnlyIdentity(email).github_login;
    const githubId = body.github_id ?? emailOnlyIdentity(email).github_id;
    const display = str(body.display_name, 100, 'display_name') ?? given ?? email.split('@')[0];
    const role = body.role ?? 'member';
    if (!['owner', 'admin', 'member', 'viewer'].includes(role)) throw new HubError('VALIDATION', 'bad role');
    if (role === 'owner' && member.role !== 'owner') throw new HubError('FORBIDDEN', 'only an owner can add an owner');
    const id = randomUUID();
    try {
      this.db.insert('members', { id, org_id: member.org_id, github_id: githubId, github_login: login, email, display_name: display, role, created_at: this.hub.iso() });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HubError('CONFLICT', 'member exists');
      throw e;
    }
    this.audit(member.id, 'member.create', id);
    return { member: publicMember(this.hub.member(id)) };
  }

  // Soft removal: no more sign-in, their devices are revoked and their live
  // sockets closed. Runs, comments and the journal keep referring to the row.
  removeMember(member, id) {
    this.requireAdmin(member);
    const m = this.hub.activeMember(id);
    if (!m || m.org_id !== member.org_id) throw new HubError('NOT_FOUND', 'member not found');
    if (m.id === member.id) throw new HubError('FORBIDDEN', 'you cannot remove yourself');
    if (m.role === 'owner' && member.role !== 'owner') throw new HubError('FORBIDDEN', 'only an owner can remove an owner');
    const now = this.hub.iso();
    const devices = this.db.all('SELECT id FROM devices WHERE member_id = ? AND revoked_at IS NULL', m.id);
    this.hub.txn(() => {
      this.db.run('UPDATE members SET removed_at = ? WHERE id = ?', now, m.id);
      this.hub.dropMemberPending(m.id);
      this.db.run('UPDATE devices SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL', now, m.id);
      this.audit(member.id, 'member.remove', m.id);
    });
    for (const d of devices) {
      this.hub.runners.get(d.id)?.close(4403, 'member removed');
      this.hub.presence.dropDevice(d.id);
    }
    this.hub.memberChanged(m.id);
    return { ok: true };
  }

  audit(actor, action, target, detail = null) {
    this.db.insert('audit', { actor, action, target, detail, at: this.hub.iso() });
  }
}

const EXTERNAL_TEXT = new Set(['title', 'body', 'acceptance', 'base_ref', 'labels']);

function stripErr(e) {
  const { code, message, ...rest } = e;
  return rest;
}

export function publicMember(m) {
  return { id: m.id, github_login: publicLogin(m), display_name: m.display_name, role: m.role, avatar_url: m.github_id > 0 ? `https://avatars.githubusercontent.com/u/${m.github_id}` : null };
}

function publicRepo(r) {
  return { id: r.id, canonical_url: r.canonical_url, short_name: r.short_name, default_branch: r.default_branch, aliases: json(r.aliases, []) };
}
