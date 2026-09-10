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
//     { name, leadSessionId, members: [{ agentId, name, agentType, tmuxPaneId, joinedAt, isActive? }] }
//   ~/.claude/teams/session-<first 8 of sessionId>/inboxes/<member name>.json
//     [{ from, text, timestamp, read }]
const fs = require('fs');
const path = require('path');
const os = require('os');

//   ~/.claude/projects/<cwd with non-alphanumerics as '-'>/<sessionId>.jsonl
//     a tmux teammate is its own Claude Code session; its first lines carry
//     { teamName: 'session-<id8>', agentName: <member name>, cwd }
const TEAMS_DIR = path.join(os.homedir(), '.claude', 'teams');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// Claude Code keeps isActive:true on a teammate that finished its task and
// is idling in its pane until the lead shuts it down, so the member's own
// transcript going quiet this long is what marks it waiting.
const IDLE_AFTER_MS = 3 * 60 * 1000;
const RESOLVE_RETRY_MS = 60 * 1000;
const HEAD_BYTES = 64 * 1024;
const transcripts = new Map();
// A team config outlives the run that wrote it, so a member that joined this
// long ago is treated as gone rather than shown forever.
const TEAM_MEMBER_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// A member with no isActive whose oldest unread message has sat this long
// never picked up its first message: it was spawned but never ran.
const NEVER_STARTED_MS = 5 * 60 * 1000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function neverStarted(teamDir, name, now) {
  const inbox = readJson(path.join(teamDir, 'inboxes', `${path.basename(String(name || ''))}.json`));
  const unread = (Array.isArray(inbox) ? inbox : [])
    .filter((msg) => msg && !msg.read)
    .map((msg) => Date.parse(msg.timestamp || ''))
    .filter(Number.isFinite);
  return unread.length > 0 && now - Math.min(...unread) > NEVER_STARTED_MS;
}

function readHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Regex rather than JSON.parse: the head may cut a long first prompt in half,
// and inside a string value the quotes are escaped so they cannot match.
function headField(head, key) {
  const m = head.match(new RegExp(`"${key}":"([^"]*)"`));
  return m ? m[1] : null;
}

// Only files touched since the member joined can be its transcript, so a
// long-lived project folder costs one stat per stale file and no reads.
function findTranscript(dirs, teamName, agentName, since) {
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(dir, n);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < since) continue;
      const head = readHead(file);
      if (headField(head, 'teamName') === teamName && headField(head, 'agentName') === agentName) return file;
    }
  }
  return null;
}

// mtime of the member's transcript, or null when it cannot be found. The
// path is resolved once per member; a miss is retried at most once a minute.
function heartbeat(m, teamName, cwds, projectsDir, cache, now) {
  const key = `${m.agentId || m.name}@${m.joinedAt || 0}`;
  let hit = cache.get(key);
  if (!hit || (!hit.file && now - hit.triedAt >= RESOLVE_RETRY_MS)) {
    const dirs = [...new Set(cwds.filter(Boolean))].map((c) => path.join(projectsDir, c.replace(/[^a-zA-Z0-9]/g, '-')));
    hit = { file: dirs.length ? findTranscript(dirs, teamName, String(m.name || ''), m.joinedAt || 0) : null, triedAt: now };
    cache.set(key, hit);
  }
  if (!hit.file) return null;
  try {
    return fs.statSync(hit.file).mtimeMs;
  } catch {
    cache.delete(key);
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

  // Claude Code's native agent teams: one tmux pane per member. A running
  // member carries isActive:true, a finished one isActive:false; one that
  // never ran has no isActive at all. A live member whose transcript has gone
  // quiet is idling in its pane: waiting. No transcript found stays working.
  // (tmux can't help here: #{window_activity} is per window, not per pane.)
  if (id) {
    const teamDir = path.join(teamsDir, `session-${id.slice(0, 8)}`);
    const cfg = readJson(path.join(teamDir, 'config.json'));
    const members = cfg && cfg.leadSessionId === id && Array.isArray(cfg.members) ? cfg.members : [];
    const teamName = (cfg && cfg.name) || path.basename(teamDir);
    const projectsDir = opts.projectsDir || PROJECTS_DIR;
    const cache = opts.transcripts || transcripts;
    let live = 0;
    for (const m of members) {
      if (m.tmuxPaneId === 'leader' || m.agentType === 'team-lead') continue;
      if (m.joinedAt && now - m.joinedAt > TEAM_MEMBER_MAX_AGE_MS) continue;
      if (m.isActive !== true && m.isActive !== false && neverStarted(teamDir, m.name, now)) continue;
      let status = 'done';
      let beat = null;
      if (m.isActive !== false) {
        beat = heartbeat(m, teamName, [m.cwd, cwd], projectsDir, cache, now);
        status = beat !== null && now - beat > IDLE_AFTER_MS ? 'waiting' : 'working';
        live += 1;
      }
      add({
        id: String(m.agentId || m.name || ''),
        name: String(m.name || 'agent'),
        kind: 'teammate',
        status,
        since: m.joinedAt ? new Date(m.joinedAt).toISOString() : null,
        heartbeat: beat === null ? null : new Date(beat).toISOString(),
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

// Only a SessionEnd hook removes a session file, so a session that was killed
// (closed terminal, crash, tmux kill) leaves its file behind for good, and
// every poll keeps stat-ing and parsing it. Delete files untouched for longer
// than `maxAgeMs` — judged by mtime alone, so a young file is kept even if it
// doesn't parse. Temp files from a writer killed between write and rename go
// the same way. → the names removed.
function sweepStaleFiles(dir, maxAgeMs, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs <= maxAgeMs) continue;
      fs.rmSync(file, { force: true });
      removed.push(name);
    } catch { /* removed under us */ }
  }
  return removed;
}

module.exports = { scanAgents, mergeAgents, agentStatus, readJson, sweepStaleFiles, TEAMS_DIR, PROJECTS_DIR, TEAM_MEMBER_MAX_AGE_MS, NEVER_STARTED_MS, IDLE_AFTER_MS, RESOLVE_RETRY_MS };
