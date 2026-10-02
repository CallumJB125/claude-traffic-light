// A bounded, staff-only view of the selected team's active boards. Shared
// session reports never establish current runner identity or verified work.
import { HubError } from './db.js';
import { cardView, runCost } from './views.js';
import { runnerConnectionProblem } from './runner-authority.js';

const ATTENTION = ['blocked', 'parked', 'failed', 'orphaned', 'unresponsive', 'handed_over'];
const WORK = ['queued', 'claimed', 'running', 'quiet', 'suspended', 'reconnecting', 'handing_over'];
const clean = (value, max = 140) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max);
const slots = (values) => values.map(() => '?').join(',');
const scope = 'b.org_id = ? AND b.archived_at IS NULL AND c.archived_at IS NULL';

export function teamOverview(hub, member, query, { cred = null } = {}) {
  if (cred && !hub.accounts?.credValid(cred)) throw new HubError('UNAUTHENTICATED', 'sign in again');
  const fresh = hub.activeMember(member?.id);
  const org = fresh && hub.db.get('SELECT id, name FROM orgs WHERE id = ? AND deleted_at IS NULL', fresh.org_id);
  if (!org || fresh.org_id !== member.org_id || (fresh.user_id && !hub.db.get('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', fresh.user_id))) throw new HubError('NOT_FOUND', 'team not found');
  for (const key of query.keys()) if (!['org', 'team'].includes(key) || query.getAll(key).length !== 1) throw new HubError('VALIDATION', 'invalid overview options');
  const count = `COUNT(c.id) AS total,
    COALESCE(SUM(CASE WHEN c.column_name != 'done' THEN 1 ELSE 0 END), 0) AS open,
    COALESCE(SUM(CASE WHEN c.run_state IN (${slots(ATTENTION)}) THEN 1 ELSE 0 END), 0) AS attention,
    COALESCE(SUM(CASE WHEN c.column_name = 'in_review' THEN 1 ELSE 0 END), 0) AS review,
    COALESCE(SUM(CASE WHEN c.column_name = 'done' THEN 1 ELSE 0 END), 0) AS done`;
  const totals = hub.db.get(`SELECT ${count} FROM cards c JOIN boards b ON b.id = c.board_id WHERE ${scope}`, ...ATTENTION, org.id);
  const boards = hub.db.all(`SELECT b.id, b.name, ${count} FROM boards b LEFT JOIN cards c ON c.board_id = b.id AND c.archived_at IS NULL
    WHERE b.org_id = ? AND b.archived_at IS NULL GROUP BY b.id ORDER BY attention DESC, open DESC, b.name, b.id LIMIT 61`, ...ATTENTION, org.id);
  const projectCount = hub.db.get('SELECT COUNT(*) AS n FROM boards WHERE org_id = ? AND archived_at IS NULL', org.id).n;
  const rows = (condition, params = []) => hub.db.all(`SELECT c.*, b.name AS board_name FROM cards c JOIN boards b ON b.id = c.board_id
    WHERE ${scope} AND ${condition} ORDER BY c.updated_at DESC, c.id LIMIT 21`, org.id, ...params);
  const project = (row) => {
    const view = cardView(hub, row, fresh.id), run = hub.run(row.active_run_id) ?? hub.latestRun(row.id);
    const connection = run && hub.runners.get(run.device_id);
    const current = !!run && row.active_run_id === run.id && run.fence === row.fence && !run.ended_at && !runnerConnectionProblem(hub, connection)
      && run.on_behalf_of === connection.member_id && hub.activeMember(connection.member_id)?.org_id === org.id;
    const freshHeartbeat = current && !!connection.generation && hub.lease(run.id)?.hb_connection_generation === connection.generation;
    let activity = 'no_live_run';
    if (row.active_run_id) {
      activity = !freshHeartbeat || view.live?.hb_age_ms == null || view.live.hb_age_ms > 30_000 ? 'disconnected'
        : ['blocked', 'parked'].includes(view.run_state) ? 'waiting'
          : view.live?.green ? 'working' : view.live?.child_alive ? 'quiet' : 'idle';
    }
    return {
      id: row.id, key: row.key, title: clean(row.title), board: { id: row.board_id, name: clean(row.board_name) },
      state: view.run_state, column: row.column_name, updated_at: row.updated_at,
      owner: view.run?.owner ?? null, ai: view.run?.ai ?? view.target?.ai ?? null, ai_label: view.run?.ai_label ?? view.target?.ai_label ?? null,
      activity, activity_source: 'hub', actor_current: current, assignee_ids: view.assignee_ids,
      assignees: view.assignee_ids.map((id) => hub.activeMember(id)).filter((m) => m?.org_id === org.id).map((m) => ({ member_id: m.id, name: clean(m.display_name) })),
      attention: { kind: view.ask?.kind ?? view.blocked_kind ?? view.fail_kind ?? null, summary: view.ask?.summary ? clean(view.ask.summary, 120) : null, can_approve: view.viewer_can_approve },
      evidence: view.evidence, cost: run ? runCost(hub, run) : null,
      handover: view.handover ? { version: view.handover.version, age_ms: view.handover.synced_age_ms } : null,
      overlap_count: view.overlaps.length,
    };
  };
  const list = (result) => ({ items: result.slice(0, 20).map(project), truncated: result.length > 20 });
  return {
    generated_at: hub.iso(), team: { id: org.id, name: clean(org.name) }, scope: 'active_boards', board_count: projectCount,
    totals, boards: boards.slice(0, 60).map((b) => ({ ...b, name: clean(b.name) })), boards_truncated: boards.length > 60,
    attention: list(rows(`c.run_state IN (${slots(ATTENTION)})`, ATTENTION)),
    work: list(rows(`c.run_state IN (${slots(WORK)})`, WORK)),
    review: list(rows("c.column_name = 'in_review'")), recent: list(rows('1 = 1')),
  };
}
