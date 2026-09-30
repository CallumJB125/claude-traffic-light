// Member-facing operations behind the HTTP API (CONTRACT §5.2). Every state
// change is hub.apply() → states.step() inside the board's queue; the rest are
// plain row edits that never touch run state.

import { randomUUID } from 'node:crypto';
import { normalizeRemoteUrl } from '../shared/scope.js';
import { PLAN_APPROVAL_LABEL } from '../shared/states.js';
import { classifyPair, kindOf } from '../shared/overlap.js';
import { sponsorLine, alertsFor } from '../shared/cardface.js';
import { HubError, json } from './db.js';
import { newDeviceToken, sha256hex } from './auth.js';
import { cardView, cardDetail, boardSnapshot, publicLogin, EMAIL_ONLY, LOCAL_ONLY, emailOnlyIdentity } from './views.js';
import { feedEvent, isFeedKind } from './hub.js';

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

  requireAdmin(member) {
    if (!this.hub.isAdmin(member)) throw new HubError('FORBIDDEN', 'admin only');
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  me(member) {
    const org = this.db.get('SELECT id, name FROM orgs WHERE id = ?', member.org_id);
    const boards = this.db.all('SELECT id, name, key_prefix FROM boards WHERE org_id = ? ORDER BY name', member.org_id);
    return { member: publicMember(member), org, boards };
  }

  snapshot(member, boardId) {
    this.boardFor(member, boardId);
    return boardSnapshot(this.hub, boardId, member.id);
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
      notifications: this.hub.notifications.filter((n) => n.board_id === boardId && n.to.includes(member.id)).slice(-50),
    };
  }

  overlapPreview(member, cardId, targetMemberId) {
    const row = this.cardFor(member, cardId);
    const tid = targetMemberId || member.id;
    const target = this.orgMember(member, tid);
    const prev = this.hub.latestRun(cardId);
    const self = {
      run_id: 'preview', repo_id: row.repo_id, branch: null, title: row.title, body: row.body,
      touched_paths: prev ? json(prev.touched_paths, []) : [], planned_paths: prev ? json(prev.planned_paths, []) : [],
    };
    const overlaps = [];
    if (row.repo_id) {
      for (const other of this.hub.liveRunsInRepo(row.repo_id)) {
        if (other.card_id === row.id) continue;
        const sig = classifyPair(self, other);
        if (!sig.length) continue;
        const level = sig.reduce((a, s) => ({ high: 3, medium: 2, low: 1 }[s.level] > { high: 3, medium: 2, low: 1 }[a] ? s.level : a), 'low');
        overlaps.push({ other_card_id: other.card_id, other_key: other.card_key, other_owner: other.owner_name, level, kind: kindOf(level), reasons: sig.map((s) => s.reason), paths: [...new Set(sig.flatMap((s) => s.paths))], age_ms: 0 });
      }
    }
    const dev = [...this.hub.runners.values()].find((c) => c.member_id === tid && c.repos.has(row.repo_id));
    const sponsor = sponsorLine({ target: { member_id: tid, name: target.display_name, is_viewer: tid === member.id, device_name: dev?.device.name } }) ?? '';
    return { overlaps, sponsor };
  }

  // ── cards ─────────────────────────────────────────────────────────────────
  async createCard(member, boardId, body) {
    this.requireWrite(member);
    const board = this.boardFor(member, boardId);
    const title = str(body.title, 200, 'title', { required: true });
    const text = str(body.body, 20_000, 'body') ?? '';
    const acceptance = str(body.acceptance, 10_000, 'acceptance');
    const baseRef = str(body.base_ref, 200, 'base_ref');
    const labels = body.labels ?? [];
    if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string' || l.length > 50)) throw new HubError('VALIDATION', 'labels must be strings');
    if (body.repo_id != null && !this.db.get('SELECT 1 AS x FROM board_repos WHERE board_id = ? AND repo_id = ?', boardId, body.repo_id)) throw new HubError('NOT_FOUND', 'repo not on this board');
    if (body.budget_usd != null && !(typeof body.budget_usd === 'number' && body.budget_usd >= 0)) throw new HubError('VALIDATION', 'budget_usd must be ≥ 0');
    const assignees = body.assignees ?? [];
    if (!Array.isArray(assignees)) throw new HubError('VALIDATION', 'assignees must be an array');
    for (const a of assignees) this.orgMember(member, a);
    return this.hub.withBoard(boardId, () => {
      const id = randomUUID();
      const now = this.hub.iso();
      this.hub.txn(() => {
        const b = this.hub.board(boardId);
        this.db.run('UPDATE boards SET next_key = next_key + 1 WHERE id = ?', boardId);
        this.db.insert('cards', {
          id, board_id: boardId, key: `${board.key_prefix}-${b.next_key}`, title, body: text, acceptance, repo_id: body.repo_id ?? null,
          base_ref: baseRef, labels: JSON.stringify(labels), budget_cents: body.budget_usd != null ? Math.round(body.budget_usd * 100) : null,
          created_by: member.id, created_at: now, updated_at: now, state_since: now,
        });
        for (const a of new Set(assignees)) this.db.insert('card_assignees', { card_id: id, member_id: a, role: 'collaborator' });
        const c = this.hub.card(id);
        this.hub.journal({ board_id: boardId, card_id: id, actor_kind: 'member', actor_id: member.id, kind: 'card.create', payload: {
          key: c.key, title, body: text, acceptance, repo_id: c.repo_id, base_ref: baseRef, labels: c.labels, budget_cents: c.budget_cents, column_name: c.column_name, assignees: [...new Set(assignees)], request_id: body.request_id ?? null,
        } });
        this.hub.feed(id, 'created', {}, { actor: member.id });
        this.hub.later(() => this.hub.broadcastCard(id));
      });
      return { card: cardView(this.hub, this.hub.card(id), member.id) };
    });
  }

  async patchCard(member, cardId, body) {
    this.requireWrite(member);
    const row0 = this.cardFor(member, cardId);
    return this.hub.withBoard(row0.board_id, () => {
      const row = this.hub.card(cardId);
      if (!Number.isSafeInteger(body.version) || body.version !== row.version) throw new HubError('VERSION_CONFLICT', 'card changed since you loaded it', { version: row.version });
      const set = {};
      if ('title' in body) set.title = str(body.title, 200, 'title', { required: true });
      if ('body' in body) set.body = str(body.body, 20_000, 'body') ?? '';
      if ('acceptance' in body) set.acceptance = str(body.acceptance, 10_000, 'acceptance');
      if ('base_ref' in body) set.base_ref = str(body.base_ref, 200, 'base_ref');
      if ('labels' in body) {
        if (!Array.isArray(body.labels) || body.labels.some((l) => typeof l !== 'string')) throw new HubError('VALIDATION', 'labels must be strings');
        set.labels = JSON.stringify(body.labels);
      }
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
      this.hub.txn(() => {
        const fields = {};
        for (const k of Object.keys(set)) if (set[k] !== row[k]) fields[k] = [row[k], set[k]];
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
    });
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

  async action(member, cardId, action, body) {
    const type = ACTION_EVENTS[action];
    if (!type) throw new HubError('NOT_FOUND', `unknown action ${action}`);
    const row0 = this.cardFor(member, cardId);
    return this.hub.withBoard(row0.board_id, () => this.actionLocked(member, cardId, action, type, body));
  }

  actionLocked(member, cardId, action, type, body) {
    const row = this.hub.card(cardId);
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
        if (body.backend != null && body.backend !== 'claude_cli') throw new HubError('VALIDATION', 'only claude_cli is dispatchable in Phase 1');
        let target = body.target_member_id ?? null;
        if (target == null && action === 'retry') target = rel.run?.on_behalf_of ?? null;
        if (target != null) this.orgMember(member, target);
        const existing = this.db.get('SELECT * FROM dispatches WHERE request_id = ?', body.request_id);
        if (existing && existing.card_id !== cardId) throw new HubError('CONFLICT', 'request_id belongs to another card');
        ctx.duplicate_request = !!existing;
        ctx.needs_confirm = this.hub.needsConfirm(me, target ?? me, row.repo_id);
        Object.assign(event, { request_id: body.request_id, target_member_id: target, backend: 'claude_cli' });
        // A budget given with the dispatch becomes the card's cap: the offer
        // carries it and the runner passes it to --max-budget-usd.
        if (body.budget_usd != null) {
          if (!(typeof body.budget_usd === 'number' && Number.isFinite(body.budget_usd) && body.budget_usd > 0)) throw new HubError('VALIDATION', 'budget_usd must be > 0');
          const cents = Math.round(body.budget_usd * 100);
          ctx.policy_ok = this.policyOk(row, cents);
          if (!existing && cents !== row.budget_cents) {
            opts.pre = () => {
              this.db.run('UPDATE cards SET budget_cents = ? WHERE id = ?', cents, cardId);
              this.hub.journal({ board_id: row.board_id, card_id: cardId, actor_kind: 'member', actor_id: me, kind: 'card.update', payload: { fields: { budget_cents: [row.budget_cents, cents] }, request_id: body.request_id } });
            };
          }
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
        const target = body.target_member_id ?? rel.run?.on_behalf_of ?? null;
        Object.assign(event, { request_id: body.request_id, target_member_id: target, comment });
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

  async answerPermission(member, prId, body) {
    const pr0 = this.db.get('SELECT * FROM permission_requests WHERE id = ?', prId);
    if (!pr0) throw new HubError('NOT_FOUND', 'permission request not found');
    const row0 = this.cardFor(member, pr0.card_id);
    if (!['allow', 'deny'].includes(body.decision)) throw new HubError('VALIDATION', 'decision must be allow or deny');
    const scope = body.scope ?? 'once';
    if (!['once', 'run'].includes(scope)) throw new HubError('VALIDATION', 'scope must be once or run');
    return this.hub.withBoard(row0.board_id, () => {
      const pr = this.db.get('SELECT * FROM permission_requests WHERE id = ?', prId);
      if (!['open', 'parked'].includes(pr.state)) {
        throw new HubError('ALREADY_ANSWERED', 'another approver answered first', { answered_by: this.hub.memberName(pr.answered_by), state: pr.state });
      }
      if (!json(pr.approvers, []).includes(member.id)) throw new HubError('FORBIDDEN', 'not an approver of this request');
      const cardId = pr.card_id;
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
    });
  }

  // ── comments ──────────────────────────────────────────────────────────────
  insertComment(member, cardId, { body, for_agent = false, reply_to = null }) {
    const id = randomUUID();
    const replyTo = reply_to && this.db.get('SELECT 1 AS x FROM comments WHERE id = ? AND card_id = ?', reply_to, cardId) ? reply_to : null;
    this.db.insert('comments', { id, card_id: cardId, author_member_id: member.id, source: 'web', trusted: 1, body, for_agent: for_agent ? 1 : 0, reply_to: replyTo, created_at: this.hub.iso() });
    this.hub.journal({ card_id: cardId, actor_kind: 'member', actor_id: member.id, kind: 'comment.create', payload: { comment_id: id, source: 'web', for_agent: !!for_agent } });
    return id;
  }

  async comment(member, cardId, body) {
    const row0 = this.cardFor(member, cardId);
    if (!this.hub.canWrite(member)) throw new HubError('FORBIDDEN', 'viewers cannot comment');
    const text = str(body.body, 10_000, 'body', { required: true });
    return this.hub.withBoard(row0.board_id, () => {
      let id;
      this.hub.txn(() => {
        id = this.insertComment(member, cardId, { body: text, for_agent: body.for_agent === true, reply_to: body.reply_to });
        this.hub.feed(cardId, 'comment', { comment_id: id }, { actor: member.id });
      });
      if (body.for_agent === true) this.hub.deliverComments(cardId);
      const c = this.db.get('SELECT * FROM comments WHERE id = ?', id);
      return { comment: { id, author_name: member.display_name, source: c.source, trusted: true, body: c.body, for_agent: !!c.for_agent, reply_to: c.reply_to, created_age_ms: 0 } };
    });
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
    this.db.run('INSERT OR IGNORE INTO board_repos (board_id, repo_id) VALUES (?, ?)', boardId, repo.id);
    this.audit(member.id, 'board.repo.add', `${boardId}:${repo.id}`);
    return { ok: true };
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
      this.db.run('UPDATE devices SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL', now, m.id);
      this.audit(member.id, 'member.remove', m.id);
    });
    for (const d of devices) this.hub.runners.get(d.id)?.close(4403, 'member removed');
    this.hub.memberChanged(m.id);
    return { ok: true };
  }

  audit(actor, action, target, detail = null) {
    this.db.insert('audit', { actor, action, target, detail, at: this.hub.iso() });
  }
}

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
