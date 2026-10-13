// Team-board execution metadata only. These cards already belong to the team;
// no private provider session, transcript, tool input or runner path is read.
import { HubError } from './db.js';
import { TeamCommunication } from './communication.js';
import { leaseView } from './views.js';
import { runnerConnectionProblem } from './runner-authority.js';
import { AI_IDS, AI_LABELS, aiOfDispatch } from '../shared/ai.js';
import { TTL_MS } from '../shared/liveness.js';
import { cleanPacketText } from '../shared/packet-text.js';
import { can } from './permissions.js';

export const TEAM_SESSION_MAX = 200;
const text = (value, max) => cleanPacketText(typeof value === 'string' ? value.slice(0, 8192) : '', 8192)
  .replace(/[\p{Cc}\p{Cf}\u034f\ufe00-\ufe0f]/gu, '').slice(0, max);
const STATES = new Set(['claimed', 'running', 'quiet', 'blocked', 'suspended', 'reconnecting', 'unresponsive', 'orphaned', 'handing_over']);
const deliveryBindings = new WeakMap();

// HTTP awaits even a synchronous handler. Revalidate the captured principal and
// rebuild current rows in its synchronous last-delivery guard, after that gap.
export function guardTeamSessionDirectory(hub, result) {
  const bound = deliveryBindings.get(result);
  if (!bound || bound.hub !== hub) throw new HubError('FORBIDDEN', 'current team directory read required');
  Object.assign(result, teamSessionDirectory(hub, bound.actor, bound.credential));
}

export function teamSessionDirectory(hub, member, cred = null) {
  if (hub.config.auth === 'accounts' && !cred) throw new HubError('UNAUTHENTICATED', 'staff credential required');
  const communication = new TeamCommunication(hub);
  const me = communication.staff(member, cred, false);
  const team = hub.db.get('SELECT id, name FROM orgs WHERE id = ? AND deleted_at IS NULL', me.org_id);
  const rows = hub.db.all(`SELECT c.* FROM cards c JOIN boards b ON b.id = c.board_id
    JOIN runs r ON r.id = c.active_run_id
    WHERE b.org_id = ? AND b.archived_at IS NULL AND c.archived_at IS NULL
      AND r.card_id = c.id AND r.fence = c.fence AND r.ended_at IS NULL
    ORDER BY r.started_at DESC, r.id LIMIT ?`, me.org_id, TEAM_SESSION_MAX + 1);
  const sessions = [];
  for (const row of rows.slice(0, TEAM_SESSION_MAX)) {
    if (!STATES.has(row.run_state)) continue;
    // Reuse the same-team, same-repository, current ownership, device and
    // enrollment checks used by task messages, independently of discovery SQL.
    let target;
    try { target = communication.recipient({ member: me, row, boardIds: [row.board_id] }, row.active_run_id); }
    catch { continue; }
    const { run, member: owner } = target;
    const provider = aiOfDispatch(run);
    if (!AI_IDS.includes(provider)) continue;
    const connection = hub.runners.get(run.device_id);
    const accepted = !!connection && !runnerConnectionProblem(hub, connection)
      && connection.member_id === owner.id && connection.repos.has(row.repo_id);
    const live = accepted ? leaseView(hub, row) : null;
    const hbAge = Number.isFinite(live?.hb_age_ms) && live.hb_age_ms >= 0 ? live.hb_age_ms : null;
    const online = accepted && hbAge !== null && hbAge <= TTL_MS && live.child_alive === true;
    const input = hub.db.get("SELECT 1 x FROM asks WHERE card_id = ? AND run_id = ? AND state = 'open' LIMIT 1", row.id, run.id)
      || hub.db.get("SELECT 1 x FROM permission_requests WHERE card_id = ? AND run_id = ? AND state = 'open' LIMIT 1", row.id, run.id);
    sessions.push({ ref: run.id, owner: { id: owner.id, user_id: owner.user_id ?? null, name: text(hub.memberName(owner.id), 80) || 'Teammate', self: owner.id === me.id },
      board: { id: row.board_id, name: text(hub.board(row.board_id).name, 80) || 'Board' },
      card: { id: row.id, key: text(row.key, 80), title: text(row.title, 200) || 'Untitled task', fence: row.fence, repo_id: row.repo_id },
      provider: { id: provider, label: AI_LABELS[provider] }, state: row.run_state,
      online, hb_age_ms: hbAge, input_needed: online && !!input, canSend: online && can(me, 'card.write') });
  }
  const result = { schema: 1, status: rows.length > TEAM_SESSION_MAX ? 'partial' : 'complete',
    team: { id: team.id, name: text(team.name, 80) || 'Team' },
    principal: { user_id: me.user_id ?? null, member_id: me.id, role: me.role }, observed_at: Date.parse(hub.iso()),
    message_contract: 'task-inbox', sessions };
  deliveryBindings.set(result, { hub, actor: Object.freeze({ id: me.id, org_id: me.org_id, user_id: me.user_id }),
    credential: cred ? Object.freeze({ kind: cred.kind, id: cred.id }) : null });
  return result;
}
