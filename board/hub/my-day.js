import { HubError, json } from './db.js';
import { cardView } from './views.js';
import { runnerConnectionProblem } from './runner-authority.js';
const STAFF = new Set(['owner', 'admin', 'member', 'viewer']);
export const MY_DAY_MAX = 500;
// A fixed, bounded read of the current principal's own work and actionable decisions.
export function myDay(hub, { member = null, userId = null, cred = null } = {}) {
  if (userId) {
    const owner = cred?.kind === 'device' ? hub.db.get('SELECT user_id FROM user_devices WHERE id = ?', cred.id) : cred?.kind === 'session' ? hub.db.get('SELECT user_id FROM sessions WHERE id = ?', cred.id) : null;
    if (!cred || !owner || !hub.accounts?.credValid(cred) || owner.user_id !== userId || !hub.db.get('SELECT 1 x FROM users WHERE id = ? AND deleted_at IS NULL', userId)) throw new HubError('UNAUTHENTICATED', 'sign in again');
  }
  const members = userId ? hub.db.all('SELECT m.* FROM members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? AND m.removed_at IS NULL AND o.deleted_at IS NULL ORDER BY m.id LIMIT 65', userId) : [hub.activeMember(member?.id)].filter(Boolean);
  if (!userId && (!members.length || members[0].org_id !== member.org_id || !hub.db.get('SELECT 1 x FROM orgs WHERE id = ? AND deleted_at IS NULL', member.org_id))) throw new HubError('FORBIDDEN', 'current membership cannot read this work');
  const cards = [], decisions = [], agents = []; let partial = members.length > 64, visitedBoards = 0, inspected = 0;
  outer: for (const me of members.slice(0, 64)) {
    if (!STAFF.has(me.role)) continue;
    const boards = hub.db.all('SELECT b.id, b.name, o.name team_name FROM boards b JOIN orgs o ON o.id = b.org_id WHERE b.org_id = ? AND b.archived_at IS NULL ORDER BY b.id LIMIT 33', me.org_id);
    if (boards.length > 32) partial = true;
    for (const board of boards.slice(0, 32)) {
      if (++visitedBoards > 32 || inspected >= 2000) { partial = true; break outer; }
      const rows = hub.db.all(`SELECT c.* FROM cards c WHERE c.board_id = ? AND c.archived_at IS NULL
        AND (c.repo_id IS NULL OR EXISTS(SELECT 1 FROM board_repos br JOIN repos r ON r.id = br.repo_id WHERE br.board_id = c.board_id AND br.repo_id = c.repo_id AND r.org_id = ?))
        AND (c.created_by = ? OR EXISTS(SELECT 1 FROM card_assignees a WHERE a.card_id = c.id AND a.member_id = ?)
          OR EXISTS(SELECT 1 FROM runs r WHERE r.id = c.active_run_id AND (r.on_behalf_of = ? OR r.dispatched_by = ?))
          OR EXISTS(SELECT 1 FROM dispatches d WHERE d.card_id = c.id AND d.state = 'pending' AND (d.dispatched_by = ? OR d.target_member_id = ?))
          OR EXISTS(SELECT 1 FROM permission_requests p WHERE p.card_id = c.id AND ((p.run_id = c.active_run_id AND p.state = 'open') OR (c.run_state = 'parked' AND p.state = 'parked')))
          OR EXISTS(SELECT 1 FROM asks a WHERE a.card_id = c.id AND (a.run_id = c.active_run_id OR c.run_state = 'parked') AND a.state = 'open'))
        ORDER BY COALESCE(c.due_date, '9999-12-31'), c.key LIMIT ?`, board.id, me.org_id, ...Array(6).fill(me.id), Math.min(MY_DAY_MAX + 1, 2001 - inspected));
      if (rows.length > MY_DAY_MAX || inspected + rows.length > 2000) partial = true;
      for (const row of rows.slice(0, Math.min(MY_DAY_MAX, 2000 - inspected))) {
        inspected++;
        const assignees = hub.assignees(row.id), run = hub.run(row.active_run_id), dispatch = hub.pendingDispatch(row.id), decisionRun = run ?? (row.run_state === 'parked' ? hub.latestRun(row.id) : null);
        const own = row.created_by === me.id || assignees.includes(me.id) || run?.on_behalf_of === me.id || run?.dispatched_by === me.id || dispatch?.dispatched_by === me.id || dispatch?.target_member_id === me.id;
        const context = { board_id: board.id, board_name: board.name, team_name: board.team_name, team_id: me.org_id, member_id: me.id };
        if (own && cards.length < MY_DAY_MAX) cards.push({ ...context, card: cardView(hub, row, me.id) }); else if (own) partial = true;
        if (me.role !== 'viewer') {
          const permissions = hub.db.all("SELECT * FROM permission_requests WHERE card_id = ? AND state IN ('open','parked') ORDER BY created_at LIMIT 501", row.id);
          for (const p of permissions) if (p.run_id === decisionRun?.id && (p.state === 'open' || row.run_state === 'parked') && json(p.approvers, []).includes(me.id)) {
            if (decisions.length < MY_DAY_MAX) decisions.push({ ...context, card_id: row.id, key: row.key, title: row.title, kind: 'permission', id: p.id, summary: p.input_summary?.slice(0, 500) ?? p.tool }); else partial = true;
          }
          const canAnswer = hub.isAdmin(me) || [decisionRun?.on_behalf_of, decisionRun?.dispatched_by, dispatch?.dispatched_by, ...assignees].includes(me.id);
          if (canAnswer) for (const ask of hub.openAsks(row.id)) if (ask.run_id === decisionRun?.id) {
            if (decisions.length < MY_DAY_MAX) decisions.push({ ...context, card_id: row.id, key: row.key, title: row.title, kind: 'question', id: ask.id, summary: ask.text.slice(0, 500) }); else partial = true;
          }
        }
        if (run?.on_behalf_of === me.id && !run.ended_at && agents.length < MY_DAY_MAX) {
          const connection = hub.runners.get(run.device_id);
          const accepted = !!connection && !runnerConnectionProblem(hub, connection) && connection.member_id === me.id && connection.repos.has(row.repo_id);
          const card = cardView(hub, row, me.id);
          agents.push({ ...context, card_id: row.id, key: row.key, ai_label: card.run?.ai_label, run_state: row.run_state, connection: accepted ? 'accepted' : 'unavailable', live: accepted ? card.live : null, cost_source: 'unavailable' });
        }
      }
    }
  }
  return { principal: userId ? { user_id: userId } : { member_id: member.id }, status: partial ? 'partial' : 'complete', cards, decisions, agents };
}
