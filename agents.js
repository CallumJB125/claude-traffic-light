// Reads every *other* agent a session has running from disk, and the mode it
// is running them under. Claude Code's own SubagentStart/Stop hooks already
// put subagents in the session file (see hooks/set-status.js); everything
// here only exists on disk, so main.js polls it every couple of seconds.
//
// Layout, all under the session's own project folder plus ~/.claude/teams:
//
//   .omc/state/subagent-tracking.json
//     { agents: [{ agent_id, agent_type, started_at, parent_mode, status }],
//       total_spawned, total_completed, total_failed, last_updated }
//   .omc/state/mission-state.json
//     { missions: [{ id, status, workerCount, taskCounts,
//                    agents: [{ name, role, status, currentStep, updatedAt }] }] }
//   .omc/state/sessions/<sessionId>/ralph-state.json
//     { active, iteration, max_iterations, started_at, session_id, ... }
//   .omc/state/sessions/<sessionId>/ultrawork-state.json
//     { active, started_at, reinforcement_count, ... }
//   .omc/state/sessions/<sessionId>/team-state.json
//     { active, session_id, team_name, stage }
//   ~/.claude/teams/session-<first 8 of sessionId>/config.json
//     { name, leadSessionId, members: [{ agentId, name, agentType, tmuxPaneId, joinedAt }] }
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEAMS_DIR = path.join(os.homedir(), '.claude', 'teams');
// A team config outlives the run that wrote it, so a member that joined this
// long ago is treated as gone rather than shown forever.
const TEAM_MEMBER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// OMC and Claude Code use several vocabularies for the same three states.
function agentStatus(s) {
  const v = String(s || '').toLowerCase();
  if (/complete|done|finish|success|fail|error|cancel/.test(v)) return 'done';
  if (/block|wait|pending|idle|queue/.test(v)) return 'waiting';
  return 'working';
}

// An OMC subagent records the mode that spawned it; that mode is the better
// label for a teammate or a loop worker than the generic "subagent".
function kindOf(parentMode) {
  if (parentMode === 'team') return 'teammate';
  if (parentMode === 'ralph' || parentMode === 'ultrawork') return parentMode;
  return 'subagent';
}

// session: { sessionId, cwd }. opts.stateDir / opts.teamsDir exist so the
// tests can point at fixtures.
function scanAgents(session, opts = {}) {
  const cwd = (session && session.cwd) || '';
  const id = (session && session.sessionId) || '';
  const stateDir = opts.stateDir || (cwd ? path.join(cwd, '.omc', 'state') : null);
  const teamsDir = opts.teamsDir || TEAMS_DIR;
  const now = opts.now || Date.now();
  const out = { mode: null, iteration: 0, agents: [] };
  const add = (a) => { if (a.id && !out.agents.some((x) => x.id === a.id)) out.agents.push(a); };

  if (stateDir) {
    const tracked = readJson(path.join(stateDir, 'subagent-tracking.json'));
    for (const a of (tracked && Array.isArray(tracked.agents) ? tracked.agents : [])) {
      add({
        id: String(a.agent_id || a.agentId || ''),
        name: String(a.agent_type || 'agent').split(':').pop(),
        kind: kindOf(a.parent_mode),
        status: agentStatus(a.status),
        since: a.started_at || null,
        parent: id || null,
      });
    }
    // Mission state names the team's workers and what each one is doing.
    const mission = readJson(path.join(stateDir, 'mission-state.json'));
    for (const m of (mission && Array.isArray(mission.missions) ? mission.missions : [])) {
      if (agentStatus(m.status) === 'done') continue;
      for (const a of Array.isArray(m.agents) ? m.agents : []) {
        add({
          id: `mission:${m.id}:${a.name}`,
          name: String(a.name || a.role || 'agent'),
          kind: 'teammate',
          status: agentStatus(a.status),
          since: a.updatedAt || null,
          parent: id || null,
        });
      }
    }
    if (id) {
      const dir = path.join(stateDir, 'sessions', id);
      const ralph = readJson(path.join(dir, 'ralph-state.json'));
      const ultra = readJson(path.join(dir, 'ultrawork-state.json'));
      const team = readJson(path.join(dir, 'team-state.json'));
      // Team is the widest mode, then the loop, then plain parallel work.
      if (team && team.active) out.mode = 'team';
      else if (ralph && ralph.active) out.mode = 'ralph';
      else if (ultra && ultra.active) out.mode = 'ultrawork';
      if (ralph && ralph.active) out.iteration = Number(ralph.iteration) || 0;
    }
  }

  // Claude Code's native agent teams: one tmux pane per member.
  if (id) {
    const cfg = readJson(path.join(teamsDir, `session-${id.slice(0, 8)}`, 'config.json'));
    const members = cfg && cfg.leadSessionId === id && Array.isArray(cfg.members) ? cfg.members : [];
    let live = 0;
    for (const m of members) {
      if (m.tmuxPaneId === 'leader' || m.agentType === 'team-lead') continue;
      if (m.joinedAt && now - m.joinedAt > TEAM_MEMBER_MAX_AGE_MS) continue;
      live += 1;
      add({
        id: String(m.agentId || m.name || ''),
        name: String(m.name || 'agent'),
        kind: 'teammate',
        status: 'working',
        since: m.joinedAt ? new Date(m.joinedAt).toISOString() : null,
        parent: id,
      });
    }
    if (live && !out.mode) out.mode = 'team';
  }

  out.agents = out.agents.slice(0, 32);
  return out;
}

// The session file's own subagent entries (owned by the hooks) plus everything
// the scan found, without duplicating an agent both of them know about.
function mergeAgents(existing, found) {
  const mine = (Array.isArray(existing) ? existing : []).filter((a) => a && a.kind === 'subagent' && !found.some((x) => x.id === a.id));
  return mine.concat(found);
}

module.exports = { scanAgents, mergeAgents, agentStatus, readJson, TEAMS_DIR, TEAM_MEMBER_MAX_AGE_MS };
