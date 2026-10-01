// Durable participant context. Authority comes from the current socket or
// staff credential, never the packet/message, provider label or receipt.
import { createHash, randomUUID } from 'node:crypto';
import { HubError } from './db.js';
import { can } from './permissions.js';
import { runnerConnectionProblem } from './runner-authority.js';
import { cleanPacketText, packetRelativePath } from '../shared/packet-text.js';
import { AI_IDS, aiOfDispatch } from '../shared/ai.js';
import { limitOrThrow } from './ratelimit.js';

const FIELDS = ['brief', 'decisions', 'progress', 'nextAction', 'artifacts', 'reportedChecks'];
const missing = () => new HubError('NOT_FOUND', 'task context not found');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function only(value, keys, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k)) || required.some((k) => !Object.hasOwn(value, k))) throw new HubError('VALIDATION', 'unknown or missing task context fields');
}
function text(value, max) {
  try { return cleanPacketText(value, max); } catch { throw new HubError('VALIDATION', 'task context text is too long or invalid'); }
}
function requestId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HubError('VALIDATION', 'request_id must be a UUID');
  return value.toLowerCase();
}

export class TeamCommunication {
  constructor(hub) { this.hub = hub; this.db = hub.db; }
  staff(member, cred, write = false) {
    if (cred && !this.hub.accounts?.credValid(cred)) throw new HubError('UNAUTHENTICATED', 'sign in again');
    const m = this.hub.activeMember(member?.id);
    if (!m || m.org_id !== member.org_id || !this.db.get('SELECT id FROM orgs WHERE id = ? AND deleted_at IS NULL', m.org_id)
      || (m.user_id && !this.db.get('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', m.user_id))) throw missing();
    if (!can(m, write ? 'card.write' : 'board.read')) throw new HubError('FORBIDDEN', 'task context is read only');
    if (this.hub.viaScope.getStore()) throw new HubError('FORBIDDEN', 'task context requires a staff credential or authenticated run');
    return m;
  }
  card(cardId, member) {
    const row = this.hub.card(cardId), board = row && this.hub.board(row.board_id);
    if (!row || !board || board.org_id !== member.org_id) throw missing();
    if (row.archived_at || board.archived_at) throw new HubError('CONFLICT', 'task or board is archived');
    if (row.repo_id && (!this.db.get('SELECT id FROM repos WHERE id = ? AND org_id = ?', row.repo_id, member.org_id)
      || !this.db.get('SELECT 1 x FROM board_repos WHERE board_id = ? AND repo_id = ?', row.board_id, row.repo_id))) throw missing();
    return row;
  }
  runner(ctx) {
    const { connection } = ctx;
    if (!connection || runnerConnectionProblem(this.hub, connection)) throw new HubError('FORBIDDEN', 'current authenticated runner connection required');
    const run = this.hub.run(ctx.run.id), m = this.staff(this.hub.member(connection.member_id), null, true), row = this.card(ctx.row.id, m);
    if (!run || run.id !== row.active_run_id || run.card_id !== row.id || run.device_id !== connection.device_id || run.on_behalf_of !== m.id
      || run.ended_at || run.fence !== row.fence || run.fence !== ctx.run.fence || run.repo_id !== row.repo_id) throw new HubError('FENCED', 'run is no longer current');
    const provider = aiOfDispatch(run);
    if (!AI_IDS.includes(provider)) throw new HubError('FORBIDDEN', 'run provider is unavailable');
    return { row, member: m, run, connection, provider, actor_key: `run:${run.id}:${run.fence}` };
  }
  human(member, cardId, cred, write = false) {
    const m = this.staff(member, cred, write);
    return { row: this.card(cardId, m), member: m, run: null, connection: null, provider: null, actor_key: `member:${m.id}` };
  }
  author(record) {
    return { kind: record.author_run_id ? 'run' : 'member', member_id: record.author_member_id, account_id: record.author_user_id,
      name: text(this.hub.memberName(record.author_member_id), 200), run_id: record.author_run_id, device_id: record.author_device_id,
      provider: record.provider, identity_source: record.author_run_id ? 'hub_run' : 'staff_credential' };
  }
  cleanData(value, scope) {
    only(value, FIELDS, FIELDS);
    for (const [k, max] of [['decisions', 20], ['artifacts', 32], ['reportedChecks', 20]]) if (!Array.isArray(value[k]) || value[k].length > max) throw new HubError('VALIDATION', 'too many task context entries');
    const data = { brief: text(value.brief, 4000), decisions: value.decisions.map((s) => text(s, 500)), progress: text(value.progress, 4000),
      nextAction: text(value.nextAction, 2000), artifacts: value.artifacts.map((a) => {
        if (a?.kind === 'path') { only(a, ['kind', 'path'], ['path']); const p = packetRelativePath(a.path); if (!p) throw new HubError('VALIDATION', 'artifact must be a permitted relative path'); return { kind: 'path', path: p }; }
        if (a?.kind === 'evidence') {
          only(a, ['kind', 'id'], ['id']);
          const e = typeof a.id === 'string' && this.db.get('SELECT id FROM evidence WHERE id = ? AND card_id = ?', a.id, scope.row.id);
          if (!e) throw new HubError('VALIDATION', 'evidence must belong to this task'); return { kind: 'evidence', id: e.id };
        }
        throw new HubError('VALIDATION', 'unknown artifact type');
      }), reportedChecks: value.reportedChecks.map((s) => text(s, 500)) };
    if (Buffer.byteLength(JSON.stringify(data)) > 64 * 1024) throw new HubError('PAYLOAD_TOO_LARGE', 'task packet exceeds 64 KiB');
    return data;
  }
  packetProjection(record) {
    if (!record) return null;
    const data = JSON.parse(record.data);
    if (digest(data) !== record.content_hash) throw new HubError('CONFLICT', 'packet version cannot be verified');
    return { schemaVersion: 1, id: record.id, card_id: record.card_id, repo_id: record.repo_id, fence: record.fence, version: record.version,
      content_hash: record.content_hash, at: record.created_at, author: this.author(record), data,
      evidence: data.artifacts.filter((a) => a.kind === 'evidence').map((a) => {
        const e = this.db.get('SELECT * FROM evidence WHERE id = ? AND card_id = ?', a.id, record.card_id);
        return { id: a.id, kind: e?.kind ?? null, verification: e?.verification ?? 'unavailable', result: e?.result ?? null,
          summary: e?.summary == null ? null : text(e.summary, 1000), ref: e ? text(e.ref, 1000) : null };
      }), observed: { source: 'hub', packet_run_id: record.author_run_id, active_run_id: this.hub.card(record.card_id)?.active_run_id ?? null,
        current_state: this.hub.card(record.card_id)?.run_state ?? 'todo' },
      reports_verified: false, grants_execution: false };
  }
  readPacket(scope, params = {}) {
    only(params, ['version']);
    if (params.version != null && !integer(params.version, 1)) throw new HubError('VALIDATION', 'choose a packet version');
    const record = params.version == null ? this.db.get('SELECT * FROM task_packets WHERE card_id = ? ORDER BY version DESC LIMIT 1', scope.row.id)
      : this.db.get('SELECT * FROM task_packets WHERE card_id = ? AND version = ?', scope.row.id, params.version);
    // A card moved to a different repository cannot export its old context.
    if (record && record.repo_id !== scope.row.repo_id) throw missing();
    return { packet: this.packetProjection(record) };
  }
  writePacket(scope, body) {
    only(body, ['request_id', 'expected_version', 'data'], ['request_id', 'expected_version', 'data']);
    if (!integer(body.expected_version)) throw new HubError('VALIDATION', 'choose the current packet version');
    const request = requestId(body.request_id), data = this.cleanData(body.data, scope);
    const fingerprint = digest({ card: scope.row.id, repo: scope.row.repo_id, fence: scope.row.fence, expected_version: body.expected_version, data });
    const prior = this.db.get('SELECT * FROM task_packets WHERE actor_key = ? AND request_id = ?', scope.actor_key, request);
    if (prior) { if (prior.request_hash !== fingerprint) throw new HubError('CONFLICT', 'request id belongs to another packet'); return { packet: this.packetProjection(prior) }; }
    const latest = this.db.get('SELECT version FROM task_packets WHERE card_id = ? ORDER BY version DESC LIMIT 1', scope.row.id)?.version ?? 0;
    if (latest !== body.expected_version) throw new HubError('VERSION_CONFLICT', 'packet changed; reload before saving');
    if (latest >= 100) throw new HubError('QUOTA_EXCEEDED', 'task packet version limit reached');
    limitOrThrow(this.hub, 'communication_write_member', scope.member.id);
    return this.hub.txn(() => {
      const record = { id: randomUUID(), card_id: scope.row.id, version: latest + 1, repo_id: scope.row.repo_id, fence: scope.row.fence,
        author_member_id: scope.member.id, author_user_id: scope.member.user_id ?? null, author_run_id: scope.run?.id ?? null,
        author_device_id: scope.run?.device_id ?? null, provider: scope.provider, actor_key: scope.actor_key, request_id: request,
        request_hash: fingerprint, content_hash: digest(data), data: JSON.stringify(data), created_at: this.hub.iso() };
      this.db.insert('task_packets', record);
      this.hub.journal({ board_id: scope.row.board_id, card_id: scope.row.id, run_id: scope.run?.id ?? null,
        actor_kind: scope.run ? 'runner' : 'member', actor_id: scope.run?.device_id ?? scope.member.id,
        kind: 'packet.version', payload: { packet_id: record.id, version: record.version, content_hmac: this.hub.refHash(record.data) } });
      this.hub.later(() => this.hub.broadcastCard(scope.row.id));
      return { packet: this.packetProjection(record) };
    });
  }
  runnerReadPacket(ctx, params) { return this.readPacket(this.runner(ctx), params); }
  runnerWritePacket(ctx, body) { return this.writePacket(this.runner(ctx), body); }
  staffReadPacket(member, cardId, params, cred = null) {
    const initial = this.human(member, cardId, cred);
    return this.hub.withBoard(initial.row.board_id, () => this.readPacket(this.human(member, cardId, cred), params));
  }
  staffWritePacket(member, cardId, body, cred = null) {
    only(body, ['request_id', 'expected_version', 'expected_fence', 'data'], ['expected_fence']);
    if (!integer(body.expected_fence)) throw new HubError('VALIDATION', 'choose the current task fence');
    const initial = this.human(member, cardId, cred, true), { expected_fence, ...data } = body;
    return this.hub.withBoard(initial.row.board_id, () => {
      const scope = this.human(member, cardId, cred, true);
      if (scope.row.fence !== expected_fence) throw new HubError('FENCED', 'task ownership changed; reload before saving');
      return this.writePacket(scope, data);
    });
  }
}
