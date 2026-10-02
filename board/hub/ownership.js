// Expiring coordination, based on current server authority and host heartbeat.
// A path intent never authorizes edits, approvals, dispatch or integration.
import { randomUUID } from 'node:crypto';
import { CODEX_PLAN_PERMISSION } from '../shared/protocol.js';
import { PLAN_APPROVAL_LABEL } from '../shared/states.js';
import { AI_LABELS, aiOfDispatch } from '../shared/ai.js';
import { packetRelativePath, cleanPacketText } from '../shared/packet-text.js';
import { TeamCommunication } from './communication.js';
import { HubError, json } from './db.js';
import { limitOrThrow } from './ratelimit.js';

export const OWNERSHIP_TTL_MS = 30_000;
// Normalize each validated intent once. Literals and terminal /** prefixes
// share conservative ancestor/descendant semantics at exact segment boundaries.
const segments = (path) => path.replace(/\/\*\*$/, '').split('/');
const node = () => ({ terminal: false, children: new Map() });
function peerIndex(paths) {
  const root = node();
  for (const path of paths) {
    let current = root;
    for (const segment of segments(path)) {
      if (current.terminal) break;
      let child = current.children.get(segment);
      if (!child) { child = node(); current.children.set(segment, child); }
      current = child;
    }
    // A parent covers all its descendants; redundant source paths need no
    // extra nodes. This index is discarded before processing the next peer.
    current.terminal = true;
    current.children.clear();
  }
  return root;
}
function intersectsIndex(root, pathSegments) {
  let current = root;
  for (const segment of pathSegments) {
    if (current.terminal) return true;
    current = current.children.get(segment);
    if (!current) return false;
  }
  return current.terminal || current.children.size > 0;
}
export function ownershipPath(value) {
  const p = typeof value === 'string' ? packetRelativePath(value.replace(/\/$/, '')) : null;
  // Literal files/directories and a terminal /** directory prefix only. This
  // avoids unbounded wildcard matching from a participant's path claim.
  return p && !/[\s<>"'`;&|{}()[\]#]/u.test(p) && p.length <= 500
    && (!/[*?]/.test(p) || p.endsWith('/**') && !/[*?]/.test(p.slice(0, -3))) ? p : null;
}

export class TaskOwnership {
  constructor(hub) { this.hub = hub; this.db = hub.db; this.live = new Map(); }
  register(run, row, { known = false } = {}) {
    const prior = this.db.get('SELECT * FROM task_ownership WHERE run_id=?', run.id);
    if (prior) return prior;
    const at = this.hub.iso();
    this.db.insert('task_ownership', { run_id: run.id, org_id: this.hub.board(row.board_id).org_id, board_id: row.board_id,
      card_id: row.id, repo_id: run.repo_id, member_id: run.on_behalf_of, device_id: run.device_id, provider: aiOfDispatch(run), fence: run.fence,
      plan_required: known ? Number(this.hub.labels(row).includes(PLAN_APPROVAL_LABEL)) : 1,
      generation: randomUUID(), paths: '[]', intent_version: 0, hub_epoch: this.hub.epoch,
      connection_generation: this.hub.runners.get(run.device_id)?.generation ?? null, created_at: at, updated_at: at });
    return this.db.get('SELECT * FROM task_ownership WHERE run_id=?', run.id);
  }
  scope(ctx) {
    const scope = new TeamCommunication(this.hub).runner(ctx);
    if (!scope.connection.repos.has(scope.run.repo_id)) throw new HubError('FORBIDDEN', 'repository is no longer opted in');
    return scope;
  }
  editable(record, run, row) {
    if (!record.plan_required) return true;
    const permission = this.db.get('SELECT * FROM permission_requests WHERE run_id=? AND tool=? ORDER BY created_at,rowid LIMIT 1', run.id, CODEX_PLAN_PERMISSION);
    const member = permission && this.hub.activeMember(permission.answered_by);
    if (permission?.state !== 'allowed' || !member || !json(permission.approvers, []).includes(member.id) || !this.hub.canWrite(member) || member.org_id !== record.org_id
      || member.user_id && !this.db.get('SELECT 1 x FROM users WHERE id=? AND deleted_at IS NULL', member.user_id)) return false;
    const policy = this.hub.runners.get(run.device_id)?.repos.get(run.repo_id);
    return this.hub.isAdmin(member) || [run.on_behalf_of, run.dispatched_by, ...this.hub.assignees(row.id), ...(policy?.approvals_from ?? [])].includes(member.id);
  }
  declare(ctx, paths, expectedGeneration) {
    const scope = this.scope(ctx);
    // Declarations also return a projection. Spend the shared member budget
    // before registration or durable changes, never after a successful write.
    limitOrThrow(this.hub, 'ownership_read_member', scope.member.id);
    const record = this.register(scope.run, scope.row);
    if (record.board_id !== scope.row.board_id || record.repo_id !== scope.row.repo_id || record.fence !== scope.row.fence) throw new HubError('CONFLICT', 'ownership scope changed');
    const live = this.live.get(scope.run.id);
    if (record.intent_version && (record.hub_epoch !== this.hub.epoch || record.connection_generation !== scope.connection.generation
      || record.expires_at && (!live || live.deadline <= this.hub.mono()))) throw new HubError('CONFLICT', 'fresh host heartbeat required before revising expired ownership');
    if (record.intent_version && expectedGeneration !== record.generation) throw new HubError('CONFLICT', 'ownership generation changed; read current overlap context');
    if (expectedGeneration != null && expectedGeneration !== record.generation) throw new HubError('CONFLICT', 'ownership generation changed');
    const clean = [...new Set(paths.map(ownershipPath).filter(Boolean))].slice(0, 200);
    const generation = randomUUID();
    this.db.run('UPDATE task_ownership SET paths=?,generation=?,intent_version=intent_version+1,expires_at=NULL,hub_epoch=?,connection_generation=?,updated_at=? WHERE run_id=?',
      JSON.stringify(clean), generation, this.hub.epoch, scope.connection.generation, this.hub.iso(), scope.run.id);
    this.hub.later(() => this.live.delete(scope.run.id));
    return this.project(this.db.get('SELECT * FROM task_ownership WHERE run_id=?', scope.run.id));
  }
  heartbeat(run, row, connection, heartbeat, rx) {
    const record = this.db.get('SELECT * FROM task_ownership WHERE run_id=?', run.id);
    if (!record?.intent_version || !json(record.paths, []).length) return;
    let scope;
    try { scope = this.scope({ run, row, connection }); } catch { this.live.delete(run.id); return; }
    if (record.board_id !== scope.row.board_id || record.repo_id !== scope.row.repo_id || record.fence !== scope.row.fence) { this.live.delete(run.id); return; }
    const lease = this.hub.lease(run.id), deadline = rx + OWNERSHIP_TTL_MS;
    const before = this.live.get(run.id);
    const eligible = this.editable(record, scope.run, scope.row) && ['running', 'quiet'].includes(scope.row.run_state)
      && heartbeat.child_alive === true && heartbeat.read_only !== true && heartbeat.gate === 'open'
      && lease?.hb_connection_generation === connection.generation && deadline > this.hub.mono();
    const generation = record.hub_epoch !== this.hub.epoch || record.connection_generation !== connection.generation
      || before?.deadline <= this.hub.mono() || eligible && !before || !eligible && before ? randomUUID() : record.generation;
    if (!eligible) {
      this.live.delete(run.id);
      this.db.run('UPDATE task_ownership SET generation=?,hub_epoch=?,connection_generation=?,last_hb_at=?,expires_at=NULL WHERE run_id=?', generation, this.hub.epoch, connection.generation, this.hub.iso(), run.id);
      return;
    }
    this.live.set(run.id, { generation, deadline, connection: connection.generation, epoch: this.hub.epoch });
    this.db.run('UPDATE task_ownership SET generation=?,hub_epoch=?,connection_generation=?,last_hb_at=?,expires_at=? WHERE run_id=?',
      generation, this.hub.epoch, connection.generation, this.hub.iso(), new Date(this.hub.wallMs() + deadline - this.hub.mono()).toISOString(), run.id);
  }
  project(record) {
    if (!record) return null;
    const run = this.hub.run(record.run_id), row = this.hub.card(record.card_id), connection = this.hub.runners.get(record.device_id), lease = this.hub.lease(record.run_id), live = this.live.get(record.run_id);
    if (!run || !row || row.board_id !== record.board_id || row.repo_id !== record.repo_id || this.hub.board(row.board_id)?.org_id !== record.org_id) return null;
    let state = 'planned', reason = 'awaiting_heartbeat';
    if (row?.column_name === 'in_review' && run?.ended_at) { state = 'awaiting_review'; reason = 'run_ended'; }
    else {
      let scope;
      try { scope = this.scope({ run, row, connection }); } catch { reason = 'not_current'; }
      if (scope) {
        reason = !this.editable(record, run, row) || lease?.read_only ? 'read_only' : !live || live.generation !== record.generation ? 'awaiting_heartbeat'
          : live.epoch !== this.hub.epoch ? 'hub_restarted' : live.connection !== connection.generation || lease?.hb_connection_generation !== connection.generation ? 'connection_changed'
            : live.deadline <= this.hub.mono() ? 'expired' : !lease?.child_alive ? 'idle'
              : !['running', 'quiet'].includes(row.run_state) ? 'waiting' : null;
        if (reason === null) state = 'editing';
      }
    }
    return { generation: record.generation, intent_version: record.intent_version, run_id: record.run_id, card_id: record.card_id,
      board_id: record.board_id, repo_id: record.repo_id, fence: record.fence,
      author: { member_id: record.member_id, account_id: this.hub.member(record.member_id)?.user_id ?? null,
        name: cleanPacketText(this.hub.memberName(record.member_id) ?? 'Participant', 200), provider: record.provider,
        provider_label: AI_LABELS[record.provider], identity_source: 'hub_run' },
      paths: json(record.paths, []).slice(0, 20), paths_truncated: json(record.paths, []).length > 20,
      state, reason, expires_at: state === 'editing' ? record.expires_at : null,
      advisory: true, grants_execution: false, global_filesystem_lock: false };
  }
  snapshot(ctx, { boardIds = null } = {}) {
    // Internal response after declare() already consumed the member quota.
    // Read-only RPCs must enter through runnerRead(), staff through staffRead().
    const scope = this.scope(ctx);
    return this.snapshotFor(scope, { boardIds });
  }
  runnerRead(ctx, options = {}) {
    const scope = this.scope(ctx);
    limitOrThrow(this.hub, 'ownership_read_member', scope.member.id);
    return this.snapshotFor(scope, options);
  }
  staffRead(member, cardId, cred = null, options = {}) {
    const communication = new TeamCommunication(this.hub);
    const initial = communication.human(member, cardId, cred);
    limitOrThrow(this.hub, 'ownership_read_member', initial.member.id);
    return this.hub.withBoard(initial.row.board_id, () => {
      const scope = communication.human(member, cardId, cred);
      scope.run = this.hub.run(scope.row.active_run_id);
      return this.snapshotFor(scope, options);
    });
  }
  snapshotFor(scope, { boardIds = null } = {}) {
    if (boardIds != null && (!Array.isArray(boardIds) || !boardIds.length || boardIds.length > 32
      || boardIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(id)))) throw new HubError('VALIDATION', 'invalid board narrowing');
    const args = [scope.member.org_id, scope.row.repo_id];
    const narrow = boardIds ? `AND o.board_id IN (${boardIds.map(() => '?').join(',')})` : ''; if (boardIds) args.push(...boardIds);
    if (boardIds && !boardIds.includes(scope.row.board_id)) throw new HubError('NOT_FOUND', 'task not found');
    const rows = this.db.all(`SELECT o.* FROM task_ownership o JOIN cards c ON c.id=o.card_id JOIN boards b ON b.id=o.board_id JOIN members m ON m.id=o.member_id
      WHERE o.org_id=? AND o.repo_id=? ${narrow} AND b.org_id=o.org_id AND c.board_id=o.board_id AND c.repo_id=o.repo_id
      AND b.archived_at IS NULL AND c.archived_at IS NULL AND m.removed_at IS NULL AND m.org_id=o.org_id
      AND (m.user_id IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.id=m.user_id AND u.deleted_at IS NULL))
      AND EXISTS(SELECT 1 FROM board_repos br WHERE br.board_id=o.board_id AND br.repo_id=o.repo_id)
      AND (c.active_run_id=o.run_id OR (c.column_name='in_review' AND o.fence=c.fence)) AND o.intent_version>0
      ORDER BY o.updated_at DESC,o.run_id LIMIT 51`, ...args);
    const selected = rows.slice(0, 50), intents = selected.map((r) => this.project(r));
    const own = scope.run && this.db.get('SELECT * FROM task_ownership WHERE run_id=?', scope.run.id);
    const paths = own ? json(own.paths, []) : [];
    const ownSegments = paths.map(segments);
    return { ownership: this.project(own), ownership_intents: intents, ownership_truncated: rows.length > 50,
      ownership_overlaps: selected.flatMap((p, index) => {
        if (p.run_id === scope.run?.id) return [];
        const projection = intents[index], peers = peerIndex(json(p.paths, []));
        const overlapping = paths.filter((_, i) => intersectsIndex(peers, ownSegments[i]));
        return overlapping.length ? [{ run_id: p.run_id, card_id: p.card_id, board_id: p.board_id, state: projection.state,
          paths: overlapping.slice(0, 20), paths_truncated: overlapping.length > 20 }] : [];
      }), advisory: true, grants_execution: false };
  }
}
