import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { HubError } from './db.js';
import { can } from './permissions.js';
import { insertCardRecord } from './card-record.js';
import { cardView } from './views.js';
import { workCaptureView } from './work-capture-view.js';
import { cleanPacketText } from '../shared/packet-text.js';
import { normalizeRemoteUrl } from '../shared/scope.js';
import { limitOrThrow } from './ratelimit.js';

const PROVIDERS = new Set(['codex', 'cursor', 'gemini', 'hermes', 'claude']);
const STATUSES = new Set(['working', 'waiting', 'review', 'idle', 'ended']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const missing = () => new HubError('NOT_FOUND', 'capture destination not found');
const conflict = (reason) => new HubError('CONFLICT', 'this observation already has a fixed destination', { reason });
function only(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !keys.includes(k))) throw new HubError('VALIDATION', 'unknown capture fields');
}
function identity(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new HubError('VALIDATION', 'invalid observation identity');
  return value;
}
function text(value, max, required = false) {
  let s; try { s = cleanPacketText(value, max).trim(); } catch { throw new HubError('VALIDATION', 'invalid capture text'); }
  if (required && !s) throw new HubError('VALIDATION', 'capture title required');
  return s;
}
function report(body) {
  only(body, ['install_id', 'provider', 'session_id', 'task_id', 'repo_id', 'title', 'status', 'summary']);
  if (!UUID.test(body.install_id) || !PROVIDERS.has(body.provider) || !STATUSES.has(body.status)) throw new HubError('VALIDATION', 'invalid capture identity or status');
  const session = identity(body.session_id), task = identity(body.task_id);
  if (!session && !task) throw new HubError('VALIDATION', 'session_id or task_id required');
  if (body.repo_id != null && (typeof body.repo_id !== 'string' || !UUID.test(body.repo_id))) throw new HubError('VALIDATION', 'invalid repo_id');
  return { identity: [body.install_id.toLowerCase(), body.provider, session, task], provider: body.provider, repo_id: body.repo_id ?? null,
    title: text(body.title, 200, true), status: body.status, ...(Object.hasOwn(body, 'summary') ? { summary: text(body.summary, 2000) } : {}) };
}

export class WorkCapture {
  constructor(hub) { this.hub = hub; this.db = hub.db; hub.workCaptureSeen ??= new Map(); }
  // Only the private account HTTP handler supplies these credentials. Legacy
  // integration/runner/remote grants have no capture authority.
  user(userId, cred) {
    if (this.hub.viaScope.getStore() || !['device', 'session'].includes(cred?.kind) || !this.hub.accounts?.credValid(cred)) throw new HubError('UNAUTHENTICATED', 'sign in again');
    const owner = cred.kind === 'device' ? this.db.get('SELECT user_id FROM user_devices WHERE id=?', cred.id) : this.db.get('SELECT user_id FROM sessions WHERE id=?', cred.id);
    if (!owner || owner.user_id !== userId || !this.db.get('SELECT id FROM users WHERE id=? AND deleted_at IS NULL', userId)) throw new HubError('UNAUTHENTICATED', 'credential does not belong to this account');
    return `user:${userId}`;
  }
  staff(member, cred, write = false) {
    const m = this.hub.activeMember(member?.id);
    if (!m || m.org_id !== member.org_id || m.user_id !== member.user_id || !this.db.get('SELECT id FROM orgs WHERE id=? AND deleted_at IS NULL', m.org_id)) throw missing();
    let principal;
    if (this.hub.config.auth === 'accounts') principal = this.user(m.user_id, cred);
    else if (this.hub.config.auth === 'local' && !cred && m.id === this.hub.localMemberId && m.role === 'owner' && !this.hub.viaScope.getStore()) principal = `local:${m.id}`;
    else throw new HubError('FORBIDDEN', 'capture requires an account or the embedded local owner');
    if (!can(m, write ? 'card.write' : 'board.read')) throw new HubError('FORBIDDEN', 'current membership cannot capture work');
    return { member: m, principal };
  }
  routes(userId, cred) {
    const principal = this.user(userId, cred);
    limitOrThrow(this.hub, 'capture_routes_user', principal);
    const rows = this.db.all(`SELECT r.canonical_url,b.org_id AS team_id,b.id AS board_id,r.id AS repo_id,m.role,o.name AS team_name,b.name AS board_name
      FROM members m JOIN orgs o ON o.id=m.org_id JOIN boards b ON b.org_id=o.id JOIN board_repos br ON br.board_id=b.id JOIN repos r ON r.id=br.repo_id AND r.org_id=o.id
      WHERE m.user_id=? AND m.removed_at IS NULL AND o.deleted_at IS NULL AND b.archived_at IS NULL
      ORDER BY o.id,b.id,r.id LIMIT 201`, userId);
    this.user(userId, cred);
    const routes = rows.slice(0, 200).flatMap((r) => {
      const canonical = normalizeRemoteUrl(`https://${r.canonical_url}`);
      // Do not expose malformed trusted legacy metadata as a routing identity.
      if (canonical !== r.canonical_url || /[\s?#@]/.test(canonical)) return [];
      return [{ canonical_url: canonical, team_id: r.team_id, board_id: r.board_id, repo_id: r.repo_id, role: r.role,
        team_name: text(r.team_name, 200), board_name: text(r.board_name, 200) }];
    });
    return { routes, complete: rows.length <= 200, truncated: rows.length > 200 };
  }
  destination(member, boardId, repoId, cred) {
    const scope = this.staff(member, cred, true), board = this.hub.board(boardId);
    if (!board || board.org_id !== scope.member.org_id) throw missing();
    if (board.archived_at) throw new HubError('CONFLICT', 'board is archived', { reason: 'BOARD_ARCHIVED' });
    if (repoId == null && this.hub.config.auth !== 'local') throw missing();
    if (repoId != null && !this.db.get('SELECT r.id FROM repos r JOIN board_repos br ON br.repo_id=r.id WHERE r.id=? AND r.org_id=? AND br.board_id=?', repoId, board.org_id, boardId)) throw missing();
    return scope;
  }
  sourceHash(identity) {
    let key = this.db.meta('work_capture_identity_key');
    if (!key) { key = randomBytes(32).toString('hex'); this.db.setMeta('work_capture_identity_key', key); }
    return createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(identity)).digest('hex');
  }
  result(row, memberId) {
    const current = this.hub.card(row.card_id);
    const card = current?.board_id === row.board_id ? current : null;
    return { card: card ? cardView(this.hub, card, memberId) : null, capture: workCaptureView(this.hub, row.card_id) };
  }
  observe(member, boardId, body, cred = null) {
    const data = report(body), initial = this.destination(member, boardId, data.repo_id, cred), hash = this.sourceHash(data.identity);
    limitOrThrow(this.hub, 'capture_report_user', initial.principal);
    // The ordinary board queue is the only write queue. A synchronous txn also
    // arbitrates simultaneous first reports to DIFFERENT boards for this user.
    return this.hub.withBoard(boardId, () => {
      const scope = this.destination(member, boardId, data.repo_id, cred);
      let row;
      this.hub.txn(() => {
        row = this.db.get('SELECT * FROM work_capture_cards WHERE principal=? AND source_hash=?', scope.principal, hash);
        if (row && (row.board_id !== boardId || row.repo_id !== data.repo_id)) throw conflict('CAPTURE_DESTINATION_PINNED');
        if (row && row.tracking !== 'active') return;
        const now = this.hub.iso();
        const column = ['review', 'ended'].includes(data.status) ? 'in_review' : data.status === 'working' ? 'in_progress' : row?.managed_column ?? 'in_progress';
        if (!row) {
          const counts = this.db.get('SELECT COUNT(*) AS total,COALESCE(SUM(created_at>?),0) AS recent FROM work_capture_cards WHERE principal=?', new Date(this.hub.clock.wall() - 3_600_000).toISOString(), scope.principal);
          if (counts.total >= 2000 || counts.recent >= 20) throw new HubError('RATE_LIMITED', 'automatic work card limit reached', { retry_after_ms: 3_600_000 });
          const cardId = randomUUID(), id = randomUUID(), summary = data.summary ?? '';
          insertCardRecord(this.hub, boardId, scope.member.id, { title: data.title, body: summary, repo_id: data.repo_id, column_name: column }, { id: cardId, now });
          this.db.insert('work_capture_cards', { id, principal: scope.principal, user_id: scope.member.user_id ?? null, member_id: scope.member.id, board_id: boardId, repo_id: data.repo_id,
            source_hash: hash, provider: data.provider, card_id: cardId, reported_status: data.status, managed_title: data.title, managed_body: summary, managed_column: column, created_at: now, received_at: now });
          this.hub.journal({ board_id: boardId, card_id: cardId, actor_kind: 'member', actor_id: scope.member.id, kind: 'card.create', payload: { capture_id: id, source: 'local_observation', provider: data.provider,
            title_hmac: this.hub.refHash(data.title), body_hmac: this.hub.refHash(summary), repo_id: data.repo_id, column_name: column } });
          this.hub.feed(cardId, 'created', {}, { actor: scope.member.id });
          row = this.db.get('SELECT * FROM work_capture_cards WHERE id=?', id);
        } else {
          const card = this.hub.card(row.card_id);
          if (!card) { this.db.run("UPDATE work_capture_cards SET tracking='deleted' WHERE id=?", row.id); row = this.db.get('SELECT * FROM work_capture_cards WHERE id=?', row.id); return; }
          if (card.board_id !== boardId) throw conflict('CAPTURE_CARD_MOVED');
          // Historical runs also take precedence; no automatic reauthorization
          // after a completed run or a human changes the repo back again.
          if (card.run_state != null || this.hub.latestRun(card.id)) {
            this.db.run('UPDATE work_capture_cards SET title_managed=0,body_managed=0,column_managed=0 WHERE id=?', row.id);
            row = this.db.get('SELECT * FROM work_capture_cards WHERE id=?', row.id);
          }
          const set = {};
          if (row.title_managed && card.title !== data.title) set.title = data.title;
          if (row.body_managed && Object.hasOwn(data, 'summary') && card.body !== data.summary) set.body = data.summary;
          if (row.column_managed && card.column_name !== column) set.column_name = column;
          this.db.run('UPDATE work_capture_cards SET reported_status=?,received_at=?,managed_title=?,managed_body=?,managed_column=? WHERE id=?', data.status, now,
            set.title ?? row.managed_title, set.body ?? row.managed_body, set.column_name ?? row.managed_column, row.id);
          if (Object.keys(set).length) {
            this.db.run(`UPDATE cards SET ${Object.keys(set).map((k) => `${k}=?`).join(',')},version=version+1,updated_at=? WHERE id=?`, ...Object.values(set), now, card.id);
            this.hub.journal({ board_id: boardId, card_id: card.id, actor_kind: 'member', actor_id: scope.member.id, kind: 'card.update', payload: { capture_id: row.id, source: 'local_observation',
              title_hmac: this.hub.refHash(set.title), body_hmac: this.hub.refHash(set.body), column_name: set.column_name ?? null } });
          }
          row = this.db.get('SELECT * FROM work_capture_cards WHERE id=?', row.id);
        }
        this.hub.later(() => { this.hub.workCaptureSeen.set(row.id, { mono: this.hub.mono(), epoch: this.hub.epoch }); this.hub.broadcastCard(row.card_id); });
      });
      return this.result(row, scope.member.id);
    });
  }
  stop(member, cardId, body, cred = null) {
    only(body, []);
    const initial = this.staff(member, cred), before = this.db.get('SELECT * FROM work_capture_cards WHERE card_id=? AND principal=?', cardId, initial.principal);
    if (!before || this.hub.board(before.board_id)?.org_id !== initial.member.org_id) throw missing();
    return this.hub.withBoard(before.board_id, () => {
      const scope = this.staff(member, cred), row = this.db.get('SELECT * FROM work_capture_cards WHERE id=? AND principal=?', before.id, scope.principal);
      if (!row || this.hub.board(row.board_id)?.org_id !== scope.member.org_id) throw missing();
      this.hub.txn(() => {
        if (row.tracking !== 'active') return;
        this.db.run("UPDATE work_capture_cards SET tracking='stopped' WHERE id=?", row.id);
        this.hub.journal({ board_id: row.board_id, card_id: row.card_id, actor_kind: 'member', actor_id: scope.member.id, kind: 'capture.stop', payload: { capture_id: row.id } });
        this.hub.later(() => { this.hub.workCaptureSeen.delete(row.id); this.hub.broadcastCard(cardId); });
      });
      return this.result(this.db.get('SELECT * FROM work_capture_cards WHERE id=?', row.id), scope.member.id);
    });
  }
}
