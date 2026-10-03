// Durable participant context. Authority comes from the current socket or
// staff credential, never the packet/message, provider label or receipt.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { remoteScope, remoteMutation } from './remote/context.js';
import { HubError } from './db.js';
import { can } from './permissions.js';
import { runnerConnectionProblem } from './runner-authority.js';
import { cleanPacketText, packetRelativePath } from '../shared/packet-text.js';
import { AI_IDS, aiOfDispatch } from '../shared/ai.js';
import { limitOrThrow } from './ratelimit.js';
import { safeEqual } from './auth.js';
import { requireRows } from './quotas.js';

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
    if (!m || m.org_id !== member.org_id || m.user_id !== member.user_id || !this.db.get('SELECT id FROM orgs WHERE id = ? AND deleted_at IS NULL', m.org_id)
      || (m.user_id && !this.db.get('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', m.user_id))) throw missing();
    if (cred) {
      const principal = cred.kind === 'device' ? this.db.get('SELECT user_id FROM user_devices WHERE id = ?', cred.id)
        : cred.kind === 'session' ? this.db.get('SELECT user_id FROM sessions WHERE id = ?', cred.id) : null;
      if (!principal || principal.user_id !== m.user_id) throw new HubError('FORBIDDEN', 'credential does not belong to this membership');
    }
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
  human(member, cardId, cred, write = false, options = {}) {
    const remote = options.remote == null ? null : remoteScope(options.remote, member, write);
    if (this.hub.config.auth === 'accounts' && !cred && !remote) throw new HubError('UNAUTHENTICATED', 'staff credential required');
    const m = this.staff(member, cred, write);
    const row = this.card(cardId, m), boardIds = remote?.boardIds ?? options.boardIds;
    if (boardIds != null && (!Array.isArray(boardIds) || boardIds.length < 1 || boardIds.length > 32
      || boardIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(id)))) throw new HubError('VALIDATION', 'choose 1–32 boards');
    if (boardIds && !boardIds.includes(row.board_id)) throw missing();
    return { row, member: m, run: null, connection: null, provider: null, actor_key: remote?.actor_key ?? `member:${m.id}`, boardIds };
  }
  author(record) {
    const remote = record.actor_key?.startsWith('remote:');
    const application = remote ? this.hub.remoteAuthority?.application(record.actor_key.slice(7)) : null;
    return { kind: record.author_run_id ? 'run' : 'member', member_id: record.author_member_id, account_id: record.author_user_id,
      name: text(this.hub.memberName(record.author_member_id), 200), run_id: record.author_run_id, device_id: record.author_device_id,
      provider: record.provider, identity_source: record.author_run_id ? 'hub_run' : remote ? 'remote_grant' : 'staff_credential', ...(remote ? { application, application_verified: false } : {}) };
  }
  packetEvidence(id, cardId, repoId) {
    // A same-card row alone cannot prove repository provenance. Evidence is
    // bound to the run that produced it; unbound and former-repo rows are not
    // available as packet artifacts in the card's current repository.
    return typeof id === 'string' ? this.db.get(`SELECT e.* FROM evidence e JOIN runs r ON r.id=e.run_id
      WHERE e.id=? AND e.card_id=? AND r.card_id=e.card_id AND r.repo_id IS ?`, id, cardId, repoId) : null;
  }
  cleanData(value, scope) {
    only(value, FIELDS, FIELDS);
    for (const [k, max] of [['decisions', 20], ['artifacts', 32], ['reportedChecks', 20]]) if (!Array.isArray(value[k]) || value[k].length > max) throw new HubError('VALIDATION', 'too many task context entries');
    const data = { brief: text(value.brief, 4000), decisions: value.decisions.map((s) => text(s, 500)), progress: text(value.progress, 4000),
      nextAction: text(value.nextAction, 2000), artifacts: value.artifacts.map((a) => {
        if (a?.kind === 'path') { only(a, ['kind', 'path'], ['path']); const p = packetRelativePath(a.path); if (!p) throw new HubError('VALIDATION', 'artifact must be a permitted relative path'); return { kind: 'path', path: p }; }
        if (a?.kind === 'evidence') {
          only(a, ['kind', 'id'], ['id']);
          const e = this.packetEvidence(a.id, scope.row.id, scope.row.repo_id);
          if (!e) throw new HubError('VALIDATION', 'evidence must belong to this task and current repository'); return { kind: 'evidence', id: e.id };
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
    const row = this.hub.card(record.card_id), authorRun = this.hub.run(record.author_run_id);
    if (!row || row.repo_id !== record.repo_id || (record.author_run_id && (!authorRun || authorRun.card_id !== row.id
      || authorRun.repo_id !== row.repo_id || authorRun.fence !== record.fence || authorRun.device_id !== record.author_device_id
      || authorRun.on_behalf_of !== record.author_member_id))) throw missing();
    const evidence = data.artifacts.filter(a => a.kind === 'evidence').map(a => {
      const e = this.packetEvidence(a.id, row.id, row.repo_id);
      // Do not alter immutable, content-hash-bound data to disguise a stale
      // artifact. Refuse the now-unavailable version instead.
      if (!e) throw missing();
      return { id: a.id, kind: e.kind, verification: e.verification, result: e.result,
        summary: e.summary == null ? null : text(e.summary, 1000), ref: text(e.ref, 1000) };
    });
    const active = this.hub.run(row.active_run_id);
    const currentRun = active && !active.ended_at && active.card_id === row.id && active.repo_id === row.repo_id && active.fence === row.fence;
    return { schemaVersion: 1, id: record.id, card_id: record.card_id, repo_id: record.repo_id, fence: record.fence, version: record.version,
      content_hash: record.content_hash, at: record.created_at, author: this.author(record), data,
      evidence, observed: { source: 'hub', packet_run_id: record.author_run_id, active_run_id: currentRun ? active.id : null,
        current_state: row.run_state ?? 'todo' },
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
  staffReadPacket(member, cardId, params, cred = null, options = {}) {
    const initial = this.human(member, cardId, cred, false, options);
    return this.hub.withBoard(initial.row.board_id, () => this.readPacket(this.human(member, cardId, cred, false, options), params));
  }
  staffWritePacket(member, cardId, body, cred = null, options = {}) {
    only(body, ['request_id', 'expected_version', 'expected_fence', 'data'], ['expected_fence']);
    if (!integer(body.expected_fence)) throw new HubError('VALIDATION', 'choose the current task fence');
    const initial = this.human(member, cardId, cred, true, options), { expected_fence, ...data } = body;
    return this.hub.withBoard(initial.row.board_id, () => {
      const scope = this.human(member, cardId, cred, true, options);
      if (scope.row.fence !== expected_fence) throw new HubError('FENCED', 'task ownership changed; reload before saving');
      if (options.remote != null) return this.hub.txn(() => remoteMutation(options.remote, member, () => this.writePacket(scope, data)));
      return this.writePacket(scope, data);
    });
  }

  recipient(scope, runId) {
    const run = this.hub.run(runId), member = run && this.hub.activeMember(run.on_behalf_of);
    if (!run || !member || !can(member, 'card.write') || member.org_id !== scope.member.org_id) throw missing();
    const row = this.card(run.card_id, member), device = this.hub.device(run.device_id);
    if (scope.boardIds && !scope.boardIds.includes(row.board_id)) throw missing();
    if (!device || device.revoked_at || device.member_id !== member.id || run.ended_at || row.active_run_id !== run.id
      || row.fence !== run.fence || row.repo_id !== run.repo_id || run.repo_id !== scope.row.repo_id) throw missing();
    if (this.hub.config.auth === 'accounts') {
      const enrollment = this.db.get('SELECT * FROM runner_enrollments WHERE device_id = ? AND member_id = ? AND revoked_at IS NULL', device.id, member.id);
      if (!enrollment || this.hub.enrolments.problem(enrollment)) throw missing();
    }
    if (member.user_id && !this.hub.accounts?.liveUser(member.user_id)) throw missing();
    return { run, row, member, provider: aiOfDispatch(run) };
  }
  visibleMessage(scope, message) {
    const source = this.hub.card(message.card_id), board = source && this.hub.board(source.board_id);
    return !!source && !!board && board.org_id === scope.member.org_id && !source.archived_at && !board.archived_at
      && (!scope.boardIds || scope.boardIds.includes(source.board_id))
      && source.repo_id === message.repo_id && message.repo_id === scope.row.repo_id
      && !!this.db.get('SELECT 1 x FROM board_repos WHERE board_id = ? AND repo_id = ?', source.board_id, source.repo_id);
  }
  messageProjection(scope, message) {
    const reply = message.reply_to && this.db.get('SELECT * FROM task_messages WHERE id = ?', message.reply_to);
    const seed = this.db.get('SELECT m.* FROM task_messages m JOIN task_message_threads t ON t.id = m.thread_id WHERE t.id = ? AND m.card_id = t.seed_card_id AND m.reply_to IS NULL ORDER BY m.rowid LIMIT 1', message.thread_id);
    return { id: message.id, request_id: message.request_id, thread_id: seed && this.visibleMessage(scope, seed) ? message.thread_id : null, card_id: message.card_id, card_key: this.hub.card(message.card_id)?.key,
      repo_id: message.repo_id, fence: message.fence, kind: message.kind, body: message.body, reply_to: reply && this.visibleMessage(scope, reply) ? message.reply_to : null, depth: message.depth,
      at: message.created_at, author: this.author(message), for_agent: false, auto_resume: false, grants_execution: false,
      deliveries: this.db.all('SELECT * FROM task_message_recipients WHERE message_id = ?', message.id).filter((r) => {
        if (!scope.boardIds) return true;
        const run = this.hub.run(r.run_id), card = run && this.hub.card(run.card_id);
        return card && scope.boardIds.includes(card.board_id);
      }).map((r) => {
        const run = this.hub.run(r.run_id);
        let current = false; try { const now = this.recipient(scope, r.run_id); current = now.run.fence === r.fence && now.run.device_id === r.device_id; } catch { /* stale delivery remains history */ }
        const receipt = this.db.get('SELECT * FROM task_message_receipts WHERE message_id = ? AND recipient_run_id = ? AND recipient_fence = ? ORDER BY acknowledged_at IS NOT NULL DESC, received_at IS NOT NULL DESC, rowid DESC LIMIT 1', message.id, r.run_id, r.fence);
        const connection = this.hub.runners.get(r.device_id);
        return { recipient_run_id: r.run_id, recipient_card_id: run?.card_id ?? null, fence: r.fence,
          recipient_member_id: run?.on_behalf_of ?? null, recipient_name: run ? text(this.hub.memberName(run.on_behalf_of), 200) : null,
          provider: run ? aiOfDispatch(run) : null,
          current_recipient: current, state: receipt?.acknowledged_at ? 'acknowledged' : !current ? 'superseded' : receipt?.received_at ? 'received' : 'pending',
          received_at: receipt?.received_at ?? null, acknowledged_at: receipt?.acknowledged_at ?? null,
          receipt_connection_current: !!receipt && !!connection && !runnerConnectionProblem(this.hub, connection) && receipt.connection_generation === connection.generation,
          acknowledgement_source: receipt?.acknowledged_at ? 'agent_reported' : null };
      }) };
  }
  sendMessage(scope, body) {
    only(body, ['request_id', 'kind', 'body', 'recipient_run_ids', 'thread_id', 'reply_to'], ['request_id', 'kind', 'body', 'recipient_run_ids']);
    if (!scope.row.repo_id) throw new HubError('NO_REPO', 'task messages need a linked repository');
    if (!['status', 'question', 'handoff', 'coordination'].includes(body.kind)) throw new HubError('VALIDATION', 'invalid task message kind');
    const message = text(body.body, 4000), request = requestId(body.request_id);
    if (!message.trim() || !Array.isArray(body.recipient_run_ids) || body.recipient_run_ids.length < 1 || body.recipient_run_ids.length > 4
      || body.recipient_run_ids.some((id) => typeof id !== 'string' || !UUID.test(id))) throw new HubError('VALIDATION', 'choose 1–4 current recipient runs and a message');
    const recipients = [...new Set(body.recipient_run_ids.map((id) => id.toLowerCase()))].sort();
    if (body.thread_id != null && (typeof body.thread_id !== 'string' || !UUID.test(body.thread_id))
      || body.reply_to != null && (typeof body.reply_to !== 'string' || !UUID.test(body.reply_to))) throw new HubError('VALIDATION', 'invalid message thread');
    const fingerprint = digest({ card: scope.row.id, repo: scope.row.repo_id, fence: scope.row.fence, kind: body.kind, body: message,
      recipients, thread: body.thread_id ?? null, reply_to: body.reply_to ?? null });
    const targets = recipients.map((id) => this.recipient(scope, id));
    const prior = this.db.get('SELECT * FROM task_messages WHERE actor_key = ? AND request_id = ?', scope.actor_key, request);
    if (scope.run && targets.some((r) => r.run.id === scope.run.id)) throw new HubError('VALIDATION', 'send a task message to another run');
    let reply = null, thread = null;
    if (body.reply_to) {
      reply = this.db.get('SELECT * FROM task_messages WHERE id = ?', body.reply_to);
      if (!reply || !this.visibleMessage(scope, reply) || (body.thread_id && body.thread_id !== reply.thread_id)) throw missing();
      if (scope.run && reply.author_run_id !== scope.run.id && !this.db.get('SELECT 1 x FROM task_message_recipients WHERE message_id = ? AND run_id = ? AND fence = ?', reply.id, scope.run.id, scope.run.fence)) throw missing();
      thread = this.db.get('SELECT * FROM task_message_threads WHERE id = ? AND org_id = ? AND repo_id = ?', reply.thread_id, scope.member.org_id, scope.row.repo_id);
      if (!thread) throw missing();
    } else {
      if (body.thread_id) throw new HubError('VALIDATION', 'a thread continuation must reply to an authorized message');
      // One hub-seeded origin thread per authenticated run. Omitting a
      // thread ID cannot reset its finite conversation budget.
      if (scope.run) thread = this.db.get('SELECT * FROM task_message_threads WHERE seed_run_id = ?', scope.run.id);
    }
    if (prior) { if (prior.request_hash !== fingerprint) throw new HubError('CONFLICT', 'request id belongs to another message'); return { message: this.messageProjection(scope, prior) }; }
    const depth = reply ? reply.depth + 1 : 0;
    if (depth > 3 || (thread && (this.db.get('SELECT COUNT(*) n FROM task_messages WHERE thread_id = ?', thread.id).n >= 32
      || scope.run && this.db.get('SELECT COUNT(*) n FROM task_messages WHERE thread_id = ? AND author_run_id IS NOT NULL', thread.id).n >= 8))) throw new HubError('QUOTA_EXCEEDED', 'task conversation limit reached; ask a person before continuing');
    if (this.db.get('SELECT COUNT(*) n FROM task_messages WHERE card_id = ?', scope.row.id).n >= 1000) throw new HubError('QUOTA_EXCEEDED', 'task message limit reached');
    limitOrThrow(this.hub, 'communication_write_member', scope.member.id);
    return this.hub.txn(() => {
      requireRows(this.hub, scope.member.org_id, 'comments');
      if (!thread) {
        thread = { id: randomUUID(), org_id: scope.member.org_id, repo_id: scope.row.repo_id, seed_card_id: scope.row.id,
          seed_member_id: scope.member.id, seed_run_id: scope.run?.id ?? null, created_at: this.hub.iso() };
        this.db.insert('task_message_threads', thread);
      }
      const record = { id: randomUUID(), thread_id: thread.id, card_id: scope.row.id, repo_id: scope.row.repo_id, fence: scope.row.fence,
        author_member_id: scope.member.id, author_user_id: scope.member.user_id ?? null, author_run_id: scope.run?.id ?? null,
        author_device_id: scope.run?.device_id ?? null, provider: scope.provider, actor_key: scope.actor_key, request_id: request,
        request_hash: fingerprint, kind: body.kind, body: message, reply_to: reply?.id ?? null, depth, comment_id: randomUUID(), created_at: this.hub.iso() };
      this.db.insert('comments', { id: record.comment_id, card_id: scope.row.id, author_member_id: scope.member.id,
        author_run_id: scope.run?.id ?? null, source: scope.run ? 'agent' : 'web', trusted: 1, body: message, for_agent: 0,
        reply_to: reply?.card_id === scope.row.id ? reply.comment_id : null, created_at: record.created_at });
      this.db.insert('task_messages', record);
      for (const target of targets) this.db.insert('task_message_recipients', { message_id: record.id, run_id: target.run.id, fence: target.run.fence, device_id: target.run.device_id });
      this.hub.journal({ board_id: scope.row.board_id, card_id: scope.row.id, run_id: scope.run?.id ?? null,
        actor_kind: scope.run ? 'runner' : 'member', actor_id: scope.run?.device_id ?? scope.member.id, kind: 'message.create',
        payload: { message_id: record.id, thread_id: thread.id, comment_id: record.comment_id, kind: record.kind, for_agent: false, content_hmac: this.hub.refHash(message) } });
      this.hub.later(() => this.hub.broadcastCard(scope.row.id));
      return { message: this.messageProjection(scope, record) };
    });
  }
  receiptToken(receipt) {
    const binding = JSON.stringify([receipt.id, receipt.message_id, receipt.recipient_run_id, receipt.recipient_fence, receipt.connection_generation]);
    return `bmr1.${receipt.id}.${createHmac('sha256', this.hub.secret).update(`task-receipt:${binding}`).digest('base64url')}`;
  }
  deliveryAttempt(scope, message) {
    if (!scope.connection.generation) throw new HubError('FORBIDDEN', 'server connection generation required');
    const args = [message.id, scope.run.id, scope.run.fence];
    let receipt = this.db.get('SELECT * FROM task_message_receipts WHERE message_id = ? AND recipient_run_id = ? AND recipient_fence = ? AND connection_generation = ?', ...args, scope.connection.generation);
    if (!receipt) {
      // Keep at most eight transport attempts per exact delivery. An expired
      // attempt cannot acknowledge a later host connection.
      this.db.run('DELETE FROM task_message_receipts WHERE message_id = ? AND recipient_run_id = ? AND recipient_fence = ? AND id NOT IN (SELECT id FROM task_message_receipts WHERE message_id = ? AND recipient_run_id = ? AND recipient_fence = ? ORDER BY rowid DESC LIMIT 7)', ...args, ...args);
      receipt = { id: randomUUID(), message_id: message.id, recipient_run_id: scope.run.id, recipient_fence: scope.run.fence,
        connection_generation: scope.connection.generation, received_at: null, acknowledged_at: null, created_at: this.hub.iso() };
      this.db.insert('task_message_receipts', receipt);
    }
    return { receipt_id: receipt.id, receipt_token: this.receiptToken(receipt), state: receipt.acknowledged_at ? 'acknowledged' : receipt.received_at ? 'received' : 'pending' };
  }
  runnerListMessages(ctx, params) {
    only(params, []); const scope = this.runner(ctx); limitOrThrow(this.hub, 'communication_read_member', scope.member.id);
    return this.hub.txn(() => {
      const incoming = this.db.all(`SELECT m.* FROM task_messages m JOIN task_message_recipients r ON r.message_id = m.id
        JOIN cards c ON c.id = m.card_id JOIN boards b ON b.id = c.board_id
        WHERE r.run_id = ? AND r.fence = ? AND r.device_id = ? AND m.repo_id = ? AND c.repo_id = m.repo_id AND b.org_id = ?
          AND c.archived_at IS NULL AND b.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM board_repos linked WHERE linked.board_id = c.board_id AND linked.repo_id = m.repo_id)
          AND NOT EXISTS (SELECT 1 FROM task_message_receipts a WHERE a.message_id = m.id AND a.recipient_run_id = r.run_id AND a.recipient_fence = r.fence AND a.acknowledged_at IS NOT NULL)
        ORDER BY m.created_at, m.rowid LIMIT 21`, scope.run.id, scope.run.fence, scope.run.device_id, scope.run.repo_id, scope.member.org_id)
        .filter((m) => this.visibleMessage(scope, m));
      const history = this.db.all('SELECT * FROM task_messages WHERE card_id = ? AND repo_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20', scope.row.id, scope.run.repo_id);
      const peers = this.db.all(`SELECT r.id FROM runs r JOIN cards c ON c.id = r.card_id JOIN boards b ON b.id = c.board_id
        WHERE r.repo_id = ? AND b.org_id = ? AND r.id != ? AND r.ended_at IS NULL AND c.active_run_id = r.id AND c.fence = r.fence
          AND c.archived_at IS NULL AND b.archived_at IS NULL ORDER BY r.started_at DESC, r.id LIMIT 40`, scope.run.repo_id, scope.member.org_id, scope.run.id);
      return { inbox: incoming.slice(0, 20).map((m) => ({ ...this.messageProjection(scope, m), delivery: this.deliveryAttempt(scope, m) })),
        truncated: incoming.length > 20, history: history.map((m) => this.messageProjection(scope, m)),
        peers: peers.flatMap(({ id }) => { try { const p = this.recipient(scope, id); return [{ run_id: id, card_id: p.row.id, card_key: p.row.key, title: text(p.row.title, 200),
          member_id: p.member.id, name: text(p.member.display_name, 200), provider: p.provider, identity_source: 'hub_run' }]; } catch { return []; } }).slice(0, 20),
        auto_resume: false };
    });
  }
  acknowledge(scope, body, agent) {
    only(body, ['receipt_id', 'receipt_token'], ['receipt_id', 'receipt_token']);
    if (typeof body.receipt_id !== 'string' || !UUID.test(body.receipt_id) || typeof body.receipt_token !== 'string' || body.receipt_token.length > 150) throw new HubError('VALIDATION', 'invalid message receipt');
    const receipt = this.db.get('SELECT * FROM task_message_receipts WHERE id = ? AND recipient_run_id = ? AND recipient_fence = ? AND connection_generation = ?', body.receipt_id, scope.run.id, scope.run.fence, scope.connection.generation);
    const message = receipt && this.db.get('SELECT * FROM task_messages WHERE id = ?', receipt.message_id);
    if (!receipt || !message || !this.visibleMessage(scope, message) || !safeEqual(body.receipt_token, this.receiptToken(receipt))) throw new HubError('FORBIDDEN', 'receipt does not belong to this current host connection');
    if (agent && !receipt.received_at) throw new HubError('CONFLICT', 'host has not reported receipt');
    return this.hub.txn(() => {
      const now = this.hub.iso();
      if (agent && !receipt.acknowledged_at) this.db.run('UPDATE task_message_receipts SET acknowledged_at = ? WHERE id = ?', now, receipt.id);
      if (!agent && !receipt.received_at) this.db.run('UPDATE task_message_receipts SET received_at = ? WHERE id = ?', now, receipt.id);
      if (agent && !receipt.acknowledged_at || !agent && !receipt.received_at) this.hub.journal({ board_id: scope.row.board_id, card_id: scope.row.id, run_id: scope.run.id,
        actor_kind: 'runner', actor_id: scope.run.device_id, kind: 'message.receipt', payload: { message_id: message.id, receipt_id: receipt.id, state: agent ? 'acknowledged' : 'received', source: agent ? 'agent_reported' : 'host' } });
      return { message_id: message.id, state: agent || receipt.acknowledged_at ? 'acknowledged' : 'received', acknowledgement_source: agent || receipt.acknowledged_at ? 'agent_reported' : null };
    });
  }
  runnerSendMessage(ctx, body) { return this.sendMessage(this.runner(ctx), body); }
  runnerAckMessage(ctx, body) { return this.acknowledge(this.runner(ctx), body, true); }
  runnerReceivedMessages(ctx, body) {
    only(body, ['receipts'], ['receipts']);
    if (!Array.isArray(body.receipts) || body.receipts.length < 1 || body.receipts.length > 20) throw new HubError('VALIDATION', 'choose 1–20 receipts');
    const scope = this.runner(ctx);
    return this.hub.txn(() => ({ receipts: body.receipts.map((r) => this.acknowledge(scope, r, false)) }));
  }
  staffPeers(scope) {
    if (!scope.row.repo_id) return [];
    const boardFilter = scope.boardIds ? `AND c.board_id IN (${scope.boardIds.map(() => '?').join(',')})` : '';
    const candidates = this.db.all(`SELECT r.id FROM runs r JOIN cards c ON c.id = r.card_id JOIN boards b ON b.id = c.board_id
      WHERE r.repo_id = ? AND b.org_id = ? AND r.ended_at IS NULL AND c.active_run_id = r.id AND c.fence = r.fence
        AND c.archived_at IS NULL AND b.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM board_repos linked WHERE linked.board_id = c.board_id AND linked.repo_id = r.repo_id)
        ${boardFilter} ORDER BY r.started_at DESC, r.id LIMIT 40`,
    scope.row.repo_id, scope.member.org_id, ...(scope.boardIds ?? []));
    return candidates.flatMap(({ id }) => {
      try { const p = this.recipient(scope, id); return [{ run_id: id, card_id: p.row.id, card_key: p.row.key, title: text(p.row.title, 200),
        member_id: p.member.id, name: text(p.member.display_name, 200), provider: p.provider, identity_source: 'hub_run' }]; } catch { return []; }
    }).slice(0, 20);
  }
  staffListMessages(member, cardId, cred = null, options = {}) {
    const initial = this.human(member, cardId, cred, false, options);
    return this.hub.withBoard(initial.row.board_id, () => {
      const scope = this.human(member, cardId, cred, false, options);
      const boardFilter = scope.boardIds ? `AND source.board_id IN (${scope.boardIds.map(() => '?').join(',')})` : '';
      const messages = this.db.all(`SELECT DISTINCT m.* FROM task_messages m LEFT JOIN task_message_recipients r ON r.message_id = m.id
        LEFT JOIN runs recipient ON recipient.id = r.run_id JOIN cards source ON source.id = m.card_id JOIN boards b ON b.id = source.board_id
        WHERE (m.card_id = ? OR recipient.card_id = ?) AND m.repo_id = ? AND source.repo_id = m.repo_id AND b.org_id = ?
          AND source.archived_at IS NULL AND b.archived_at IS NULL ${boardFilter}
          AND EXISTS (SELECT 1 FROM board_repos linked WHERE linked.board_id = source.board_id AND linked.repo_id = m.repo_id)
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT 51`, cardId, cardId, scope.row.repo_id, scope.member.org_id, ...(scope.boardIds ?? []))
        .filter((m) => this.visibleMessage(scope, m));
      return { messages: messages.slice(0, 50).map((m) => this.messageProjection(scope, m)), truncated: messages.length > 50,
        peers: this.staffPeers(scope), auto_resume: false };
    });
  }
  staffSendMessage(member, cardId, body, cred = null, options = {}) {
    only(body, ['request_id', 'expected_fence', 'kind', 'body', 'recipient_run_ids', 'thread_id', 'reply_to'], ['expected_fence']);
    if (!integer(body.expected_fence)) throw new HubError('VALIDATION', 'choose the current task fence');
    const initial = this.human(member, cardId, cred, true, options), { expected_fence, ...params } = body;
    return this.hub.withBoard(initial.row.board_id, () => {
      const scope = this.human(member, cardId, cred, true, options);
      if (scope.row.fence !== expected_fence) throw new HubError('FENCED', 'task ownership changed; reload before sending');
      if (options.remote != null) return this.hub.txn(() => remoteMutation(options.remote, member, () => this.sendMessage(scope, params)));
      return this.sendMessage(scope, params);
    });
  }
}
