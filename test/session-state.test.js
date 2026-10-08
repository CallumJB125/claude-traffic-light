const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const A = require('../agents.js');
const SET_STATUS = path.join(__dirname, '..', 'hooks', 'set-status.js');
const HOST = os.hostname().split('.')[0];

// ── agents.js: native team members ─────────────────────────────────────────
const NOW = 1789040000000;
const LEAD = 'lead0001-aaaa-bbbb';
function scanTeam(members, inboxes = {}) {
  const teamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-teams-'));
  const dir = path.join(teamsDir, `session-${LEAD.slice(0, 8)}`);
  fs.mkdirSync(path.join(dir, 'inboxes'), { recursive: true });
  const lead = { agentId: 'team-lead@x', name: 'team-lead', agentType: 'team-lead', tmuxPaneId: 'leader', joinedAt: NOW - 60000 };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ leadSessionId: LEAD, members: [lead, ...members] }));
  for (const [name, msgs] of Object.entries(inboxes)) fs.writeFileSync(path.join(dir, 'inboxes', `${name}.json`), JSON.stringify(msgs));
  return A.scanAgents({ sessionId: LEAD, cwd: '' }, { teamsDir, now: NOW });
}
const member = (name, extra = {}) => ({ agentId: `${name}@x`, name, agentType: 'executor', tmuxPaneId: `%${name}`, joinedAt: NOW - 600000, ...extra });
const msg = (agoMs, read = false) => ({ from: 'team-lead', text: 'go', timestamp: new Date(NOW - agoMs).toISOString(), read });

test('teams: isActive drives working/done; a never-started member is dropped', () => {
  const recent = { joinedAt: NOW - 60000 };
  const r = scanTeam(
    [
      member('active', { isActive: true, ...recent }),
      member('finished', { isActive: false, ...recent }),
      member('never', recent),
      member('fresh', recent),
      member('noinbox', recent),
      member('readold', recent),
    ],
    {
      never: [msg(A.NEVER_STARTED_MS + 60000), msg(1000)],
      fresh: [msg(60000)],
      readold: [msg(A.NEVER_STARTED_MS + 60000, true)],
    },
  );
  const by = Object.fromEntries(r.agents.map((a) => [a.name, a.status]));
  assert.deepEqual(by, { active: 'working', finished: 'done', fresh: 'working', noinbox: 'working', readold: 'working' });
  assert.ok(!('never' in by), 'oldest unread message older than 5 min → never started');
  assert.equal(r.mode, 'team');
});

test('teams: finished members alone do not make it team mode; the 6 h cap still applies', () => {
  assert.equal(scanTeam([member('finished', { isActive: false })]).mode, null);
  const old = scanTeam([member('ancient', { joinedAt: NOW - A.TEAM_MEMBER_MAX_AGE_MS - 1 }), member('ancientActive', { isActive: true, joinedAt: NOW - A.TEAM_MEMBER_MAX_AGE_MS - 1 })]);
  assert.deepEqual(old.agents, []);
});

// A teammate's own transcript is its heartbeat: fresh → working, quiet → waiting.
const TEAM_CWD = '/work/proj';
function teamFixture(members) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-beat-'));
  const teamsDir = path.join(root, 'teams');
  const projectsDir = path.join(root, 'projects');
  const teamName = `session-${LEAD.slice(0, 8)}`;
  fs.mkdirSync(path.join(teamsDir, teamName), { recursive: true });
  fs.writeFileSync(path.join(teamsDir, teamName, 'config.json'), JSON.stringify({ name: teamName, leadSessionId: LEAD, members }));
  const proj = path.join(projectsDir, TEAM_CWD.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const transcript = (name, ageMs) => {
    const file = path.join(proj, `${name}-sid.jsonl`);
    const lines = [
      { type: 'mode', sessionId: `${name}-sid` },
      { type: 'user', sessionId: `${name}-sid`, teamName, agentName: name, cwd: TEAM_CWD, message: { content: 'x'.repeat(100000) } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.utimesSync(file, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000);
  };
  const scan = (opts = {}) => A.scanAgents({ sessionId: LEAD, cwd: TEAM_CWD }, { teamsDir, projectsDir, now: NOW, transcripts: new Map(), ...opts });
  const config = (ms) => fs.writeFileSync(path.join(teamsDir, teamName, 'config.json'), JSON.stringify({ name: teamName, leadSessionId: LEAD, members: ms }));
  return { transcript, scan, proj, config };
}

test('teams: an active member whose transcript went quiet is waiting; fresh or just-joined-missing is working', () => {
  const f = teamFixture([
    member('fresh', { isActive: true }),
    member('idle', { isActive: true }),
    member('lost', { isActive: true, joinedAt: NOW - 60000 }),
    member('finished', { isActive: false }),
  ]);
  f.transcript('fresh', 10000);
  f.transcript('idle', 10 * 60 * 1000);
  f.transcript('finished', 10 * 60 * 1000);
  const by = Object.fromEntries(f.scan().agents.map((a) => [a.name, a]));
  assert.equal(by.fresh.status, 'working');
  assert.equal(by.fresh.heartbeat, new Date(NOW - 10000).toISOString());
  assert.equal(by.idle.status, 'waiting');
  assert.equal(by.idle.heartbeat, new Date(NOW - 10 * 60 * 1000).toISOString());
  assert.equal(by.lost.status, 'working');
  assert.equal(by.lost.heartbeat, null);
  assert.equal(by.finished.status, 'done');
  assert.ok(A.IDLE_AFTER_MS < 10 * 60 * 1000 && A.IDLE_AFTER_MS > 10000);
});

test('teams: a member that joined after its transcript last changed is not matched to it', () => {
  const f = teamFixture([member('late', { isActive: true, joinedAt: NOW - 60000 })]);
  f.transcript('late', 10 * 60 * 1000);
  const [a] = f.scan().agents;
  assert.equal(a.status, 'working');
  assert.equal(a.heartbeat, null);
});

test('teams: no transcript since join counts quiet from joinedAt, so it turns waiting after IDLE_AFTER_MS', () => {
  const f = teamFixture([
    member('never-wrote-old', { isActive: true, joinedAt: NOW - A.IDLE_AFTER_MS - 1 }),
    member('never-wrote-new', { isActive: true, joinedAt: NOW - A.IDLE_AFTER_MS + 1 }),
    member('stale-old', { isActive: true, joinedAt: NOW - A.IDLE_AFTER_MS - 1 }),
    member('stale-new', { isActive: true, joinedAt: NOW - A.IDLE_AFTER_MS + 1 }),
    member('normal', { isActive: true, joinedAt: NOW - 3600000 }),
  ]);
  f.transcript('stale-old', 2 * A.IDLE_AFTER_MS);
  f.transcript('stale-new', 2 * A.IDLE_AFTER_MS);
  f.transcript('normal', 10000);
  const by = Object.fromEntries(f.scan().agents.map((a) => [a.name, a]));
  assert.equal(by['never-wrote-old'].status, 'waiting');
  assert.equal(by['never-wrote-new'].status, 'working');
  assert.equal(by['stale-old'].status, 'waiting');
  assert.equal(by['stale-new'].status, 'working');
  assert.equal(by['never-wrote-old'].heartbeat, null);
  assert.equal(by.normal.status, 'working');
  assert.equal(by.normal.heartbeat, new Date(NOW - 10000).toISOString());
});

test('teams: a waiting null-beat member finds a transcript written later within one short retry', () => {
  const f = teamFixture([member('slow', { isActive: true, joinedAt: NOW - 10 * 60 * 1000 })]);
  const transcripts = new Map();
  assert.equal(f.scan({ transcripts }).agents[0].status, 'waiting');
  f.transcript('slow', -20000);
  assert.equal(f.scan({ transcripts, now: NOW + 1000 }).agents[0].status, 'waiting', 'not rescanned inside the short retry');
  const a = f.scan({ transcripts, now: NOW + A.NULL_BEAT_RETRY_MS + 1 }).agents[0];
  assert.equal(a.status, 'working');
  assert.equal(a.heartbeat, new Date(NOW + 20000).toISOString());
});

test('teams: a member with no joinedAt that leaves and rejoins gets a fresh first-seen', () => {
  const m = member('nojoin', { isActive: true, joinedAt: undefined });
  const f = teamFixture([m]);
  const transcripts = new Map();
  f.scan({ transcripts });
  assert.equal(f.scan({ transcripts, now: NOW + A.IDLE_AFTER_MS + 1 }).agents[0].status, 'waiting');
  f.config([{ ...m, isActive: false }]);
  assert.equal(f.scan({ transcripts, now: NOW + A.IDLE_AFTER_MS + 2 }).agents[0].status, 'done');
  f.config([m]);
  assert.equal(f.scan({ transcripts, now: NOW + A.IDLE_AFTER_MS + 3 }).agents[0].status, 'working');
  f.config([{ ...m, tmuxPaneId: '%new' }]);
  assert.equal(f.scan({ transcripts, now: NOW + 2 * A.IDLE_AFTER_MS }).agents[0].status, 'working', 'a new pane is a new member');
});

test('teams: a member with no joinedAt and no transcript is timed from when it was first seen', () => {
  const f = teamFixture([member('nojoin', { isActive: true, joinedAt: undefined })]);
  const transcripts = new Map();
  assert.equal(f.scan({ transcripts }).agents[0].status, 'working');
  assert.equal(f.scan({ transcripts, now: NOW + A.IDLE_AFTER_MS - 1 }).agents[0].status, 'working');
  assert.equal(f.scan({ transcripts, now: NOW + A.IDLE_AFTER_MS + 1 }).agents[0].status, 'waiting');
});

test('teams: transcript path is cached; an unresolved member is rescanned at most once a minute', (t) => {
  const f = teamFixture([member('found', { isActive: true }), member('missing', { isActive: true })]);
  f.transcript('found', 10000);
  const transcripts = new Map();
  const readdir = t.mock.method(fs, 'readdirSync');
  const projCalls = () => readdir.mock.calls.filter((c) => String(c.arguments[0]) === f.proj).length;
  f.scan({ transcripts });
  const first = projCalls();
  assert.ok(first >= 1);
  f.scan({ transcripts, now: NOW + 2000 });
  assert.equal(projCalls(), first, 'no rescan within a minute');
  f.transcript('found', 0);
  const again = f.scan({ transcripts, now: NOW + A.RESOLVE_RETRY_MS + 1 });
  assert.equal(projCalls(), first + 1, 'only the unresolved member rescans after a minute');
  assert.equal(again.agents.find((a) => a.name === 'found').heartbeat, new Date(NOW).toISOString());
});

// ── hooks/set-status.js ─────────────────────────────────────────────────────
function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-state-'));
}
function run(home, signal, payload, env = {}) {
  const r = spawnSync(process.execPath, [SET_STATUS, signal], {
    env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, ...env },
    input: payload === undefined ? '' : JSON.stringify(payload),
  });
  assert.equal(r.status, 0, r.stderr.toString());
  return r;
}
const sessionFile = (home, sid) => path.join(home, 'sessions', `${HOST}-${sid}.json`);
const read = (home, sid) => JSON.parse(fs.readFileSync(sessionFile(home, sid), 'utf8'));

test('set-status: a background agent survives the main turn\'s stop, and ends on SubagentStop', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'bg' });
  run(home, 'subagent-start', { session_id: 'bg', agent_id: 'ag-1', agent_type: 'executor' });
  run(home, 'stop', { session_id: 'bg' });
  const stopped = read(home, 'bg');
  assert.deepEqual(stopped.agents.map((a) => [a.id, a.status]), [['ag-1', 'working']]);
  assert.equal(stopped.agentsAt, null);
  run(home, 'subagent-done', { session_id: 'bg', agent_id: 'ag-1' });
  const d = read(home, 'bg');
  assert.deepEqual(d.agents.map((a) => [a.id, a.status]), [['ag-1', 'done']]);
  assert.equal(d.updatedAt, stopped.updatedAt, 'a late subagent-done leaves updatedAt alone');
  assert.ok(Date.parse(d.agentsAt) >= Date.parse(stopped.updatedAt), 'and sets agentsAt');
});

test('set-status: after the turn ends, agent and task events are bookkeeping, not a restarted turn', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'late' });
  run(home, 'tool-use', { session_id: 'late', tool_name: 'Agent' });
  run(home, 'subagent-start', { session_id: 'late', agent_id: 'ag-1', agent_type: 'executor' });
  run(home, 'tool-use', { session_id: 'late', tool_name: 'Bash', agent_id: 'ag-1' });
  assert.equal(read(home, 'late').signal, 'tool-use', 'mid-turn, a subagent\'s tool use is still a real signal');
  run(home, 'stop', { session_id: 'late' });
  const stopped = read(home, 'late');
  assert.equal(stopped.workingSince, null);

  run(home, 'subagent-start', { session_id: 'late', agent_id: 'ag-2', agent_type: 'explore' });
  run(home, 'task-created', { session_id: 'late' });
  run(home, 'tool-done', { session_id: 'late', tool_name: 'Read', agent_id: 'ag-2' });
  run(home, 'subagent-done', { session_id: 'late', agent_id: 'ag-1' });
  run(home, 'task-done', { session_id: 'late' });
  const d = read(home, 'late');
  assert.equal(d.signal, 'stop', 'the turn stays over');
  assert.equal(d.workingSince, null, 'no new working clock');
  assert.equal(d.tool, stopped.tool, 'a background agent\'s tool does not replace the session tool');
  assert.deepEqual(d.agents.map((a) => [a.id, a.status]), [['ag-1', 'done'], ['ag-2', 'working']]);
  assert.deepEqual(d.tasks, { created: 1, done: 1 });
  assert.equal(d.updatedAt, stopped.updatedAt, 'bookkeeping never counts as the session moving');
  assert.ok(Date.parse(d.agentsAt) > Date.parse(stopped.updatedAt), 'it stamps agentsAt instead');

  run(home, 'tool-use', { session_id: 'late', tool_name: 'Edit' });
  assert.equal(read(home, 'late').signal, 'tool-use', 'a main-thread event (no agent_id) is real again');
});

test('set-status: turn-failed ends the turn\'s working clock', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'f' });
  assert.ok(read(home, 'f').workingSince);
  run(home, 'turn-failed', { session_id: 'f' });
  assert.equal(read(home, 'f').workingSince, null);
  run(home, 'subagent-done', { session_id: 'f', agent_id: 'x' });
  assert.equal(read(home, 'f').signal, 'turn-failed', 'a turn end for bookkeeping too');
});

test('set-status: a session-start is a fresh idle session, but a compaction mid-turn carries on working', () => {
  const home = tmpHome();
  run(home, 'session-start', { session_id: 'ss', source: 'startup' });
  assert.deepEqual([read(home, 'ss').signal, read(home, 'ss').workingSince], ['session-start', null]);
  run(home, 'prompt-submit', { session_id: 'ss' });
  run(home, 'tool-use', { session_id: 'ss', tool_name: 'Bash' });
  const before = read(home, 'ss');
  run(home, 'compact', { session_id: 'ss' });
  run(home, 'session-start', { session_id: 'ss', source: 'compact' });
  const d = read(home, 'ss');
  assert.deepEqual([d.signal, d.workingSince, d.touchedAt], ['compact', before.workingSince, before.touchedAt]);
  run(home, 'tool-use', { session_id: 'ss', tool_name: 'Read' });
  run(home, 'session-start', { session_id: 'ss', source: 'compact' });
  assert.equal(read(home, 'ss').via, 'session-start/compact');
});

test('set-status: auto-compaction leaves background agents working; a real session-start ends them', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'ca' });
  run(home, 'subagent-start', { session_id: 'ca', agent_id: 'bg-1', agent_type: 'executor' });
  run(home, 'session-start', { session_id: 'ca', source: 'compact' });
  assert.deepEqual(read(home, 'ca').agents.map((a) => [a.id, a.status]), [['bg-1', 'working']]);
  run(home, 'session-start', { session_id: 'ca', source: 'startup' });
  assert.deepEqual(read(home, 'ca').agents.map((a) => [a.id, a.status]), [['bg-1', 'done']]);
});

test('set-status: the session keeps the cwd it started in; a cd or a subagent\'s cwd never relabels it', () => {
  const home = tmpHome();
  run(home, 'session-start', { session_id: 'cw', source: 'startup', cwd: '/proj' });
  run(home, 'prompt-submit', { session_id: 'cw', cwd: '/proj' });
  run(home, 'tool-use', { session_id: 'cw', tool_name: 'Bash', cwd: '/proj/memory' });
  assert.equal(read(home, 'cw').cwd, '/proj', 'a Bash cd on the main thread');
  run(home, 'subagent-start', { session_id: 'cw', agent_id: 'ag-1', agent_type: 'executor', cwd: '/wt/lane-a' });
  run(home, 'tool-done', { session_id: 'cw', tool_name: 'Read', agent_id: 'ag-1', cwd: '/wt/lane-a' });
  run(home, 'subagent-done', { session_id: 'cw', agent_id: 'ag-1', cwd: '/wt/lane-a' });
  assert.equal(read(home, 'cw').cwd, '/proj', 'a subagent\'s events carry its own cwd');
  run(home, 'session-start', { session_id: 'cw', source: 'compact', cwd: '/proj/memory' });
  assert.equal(read(home, 'cw').cwd, '/proj', 'a compaction is the same session');
  run(home, 'session-start', { session_id: 'cw', source: 'resume', cwd: '/elsewhere' });
  assert.equal(read(home, 'cw').cwd, '/elsewhere', 'a resume starts afresh where it was opened');
  run(home, 'prompt-submit', { session_id: 'first', cwd: '/first' });
  assert.equal(read(home, 'first').cwd, '/first', 'no session-start seen: the first event\'s cwd');
});

test('set-status: a subagent the parent stopped (TaskStop) is retired as stopped, never done', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'ts' });
  run(home, 'subagent-start', { session_id: 'ts', agent_id: 'ag-1', agent_type: 'executor' });
  run(home, 'subagent-start', { session_id: 'ts', agent_id: 'ag-2', agent_type: 'executor' });
  run(home, 'tool-use', { session_id: 'ts', tool_name: 'TaskStop', tool_input: { task_id: 'ag-1' } });
  assert.equal(read(home, 'ts').agents.find((a) => a.id === 'ag-1').status, 'working', 'asking to stop is not stopped');
  run(home, 'tool-done', { session_id: 'ts', tool_name: 'TaskStop', tool_input: { task_id: 'ag-1' } });
  assert.deepEqual(read(home, 'ts').agents.map((a) => [a.id, a.status]), [['ag-1', 'stopped'], ['ag-2', 'working']]);
  run(home, 'stop', { session_id: 'ts' });
  run(home, 'tool-done', { session_id: 'ts', tool_name: 'TaskStop', tool_input: { task_id: 'ag-2' } });
  assert.deepEqual(read(home, 'ts').agents.map((a) => [a.id, a.status]), [['ag-1', 'stopped'], ['ag-2', 'stopped']], 'after the turn too');
});

test('set-status: a subagent\'s own tool events stamp its lastAt', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'la' });
  run(home, 'subagent-start', { session_id: 'la', agent_id: 'ag-1', agent_type: 'executor' });
  const started = read(home, 'la').agents[0];
  assert.equal(started.lastAt, undefined);
  run(home, 'tool-use', { session_id: 'la', tool_name: 'Bash', agent_id: 'ag-1' });
  const a = read(home, 'la').agents[0];
  assert.ok(Date.parse(a.lastAt) >= Date.parse(started.since));
  assert.equal(a.status, 'working');
});

test('set-status: a permission denial mid-turn keeps the turn, its clock and the ignored timer', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'pd' });
  run(home, 'tool-use', { session_id: 'pd', tool_name: 'Bash' });
  const before = read(home, 'pd');
  run(home, 'permission-denied', { session_id: 'pd', tool_name: 'Bash' });
  const d = read(home, 'pd');
  assert.deepEqual([d.signal, d.tool, d.workingSince, d.touchedAt], ['permission-denied', 'Bash', before.workingSince, before.touchedAt]);
  run(home, 'stop', { session_id: 'pd' });
  run(home, 'permission-denied', { session_id: 'pd', tool_name: 'Bash', agent_id: 'ag-9' });
  assert.equal(read(home, 'pd').signal, 'stop', 'a background agent\'s denial after the turn is bookkeeping');
});

test('set-status: a failed turn stays failed through the idle nudge, keeping why it failed', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'nf' });
  run(home, 'turn-failed', { session_id: 'nf', hook_event_name: 'StopFailure', error: 'unknown', error_details: 'TypeError: fetch failed' });
  const failed = read(home, 'nf');
  assert.deepEqual([failed.signal, failed.failKind, failed.failReason], ['turn-failed', 'network', 'unknown: TypeError: fetch failed']);

  run(home, 'notification', { session_id: 'nf', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  const nudged = read(home, 'nf');
  assert.deepEqual([nudged.signal, nudged.failKind, nudged.failReason, nudged.via, nudged.signalSince], ['turn-failed', 'network', failed.failReason, 'turn-failed', failed.signalSince], 'the nudge is bookkeeping');
  assert.ok(Date.parse(nudged.updatedAt) >= Date.parse(failed.updatedAt), 'but it does stamp updatedAt');

  run(home, 'prompt-submit', { session_id: 'nf' });
  const retried = read(home, 'nf');
  assert.equal(retried.signal, 'prompt-submit', 'a retry is working again');
  assert.deepEqual([retried.failKind, retried.failReason], [undefined, undefined]);
});

test('set-status: a StopFailure is classified network / limit / error; asks and limits still break through', () => {
  const kind = (payload) => {
    const home = tmpHome();
    run(home, 'turn-failed', { session_id: 'k', ...payload });
    const d = read(home, 'k');
    return [d.failKind, d.failReason];
  };
  assert.deepEqual(kind({ error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: 'API Error: Rate limit reached' }), ['limit', 'rate_limit: 429 Too Many Requests']);
  assert.deepEqual(kind({ error: 'server_error', last_assistant_message: 'API Error: 529 overloaded_error' }), ['limit', 'server_error: API Error: 529 overloaded_error']);
  assert.deepEqual(kind({ error: 'unknown', error_details: 'Connection error.' }), ['network', 'unknown: Connection error.']);
  assert.deepEqual(kind({ error: 'authentication_failed' }), ['error', 'authentication_failed']);
  assert.deepEqual(kind({}), ['error', null]);
  assert.equal(kind({ error_details: 'x'.repeat(300) })[1].length, 120);

  const home = tmpHome();
  run(home, 'turn-failed', { session_id: 'b', error: 'unknown' });
  run(home, 'notification', { session_id: 'b', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.equal(read(home, 'b').signal, 'permission-ask');
  run(home, 'turn-failed', { session_id: 'b', error: 'unknown' });
  run(home, 'tool-use', { session_id: 'b', tool_name: 'Bash' });
  assert.equal(read(home, 'b').signal, 'tool-use', 'a tool use clears it');
});

const { fakeApp } = require('./fake-app.js');

test('set-status: a PermissionRequest marks the session as asking, still passing through unanswered', async () => {
  const home = tmpHome();
  const srv = await fakeApp(home);
  const port = String(srv.port);
  try {
    run(home, 'prompt-submit', { session_id: 'pr', cwd: '/x/p' });
    const r = run(home, 'permission-request', { session_id: 'pr', cwd: '/x/p', tool_name: 'Bash', tool_input: { command: 'ls' } }, { CLAUDE_TRAFFIC_LIGHT_ASK_MS: '200', CLAUDE_TRAFFIC_LIGHT_PORT: port });
    assert.equal(r.stdout.toString(), '', 'no decision → Claude Code shows its own dialog');
    const d = read(home, 'pr');
    assert.deepEqual([d.signal, d.tool, d.workingSince], ['permission-ask', 'Bash', null]);
    assert.deepEqual(fs.readdirSync(path.join(home, 'requests')), [], 'request cleaned up');
  } finally { srv.close(); }
});

test('set-status: a PermissionRequest with the app down still marks asking, but writes no request', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'pd', cwd: '/x/p' });
  const t0 = Date.now();
  const r = run(home, 'permission-request', { session_id: 'pd', cwd: '/x/p', tool_name: 'Bash', tool_input: { command: 'ls' } }, { CLAUDE_TRAFFIC_LIGHT_PORT: '1' });
  assert.ok(Date.now() - t0 < 10000, 'does not wait out the ask window');
  assert.equal(r.stdout.toString(), '');
  assert.equal(read(home, 'pd').signal, 'permission-ask');
  assert.equal(fs.existsSync(path.join(home, 'requests')), false, 'no request file');
});

test('set-status: the app\'s port file wins over the env port when probing', async () => {
  const home = tmpHome();
  const srv = await fakeApp(home);
  try {
    fs.writeFileSync(path.join(home, 'port'), String(srv.port));
    run(home, 'permission-request', { session_id: 'pf', tool_name: 'Bash', tool_input: { command: 'ls' } }, { CLAUDE_TRAFFIC_LIGHT_ASK_MS: '300', CLAUDE_TRAFFIC_LIGHT_PORT: '1' });
    assert.ok(fs.existsSync(path.join(home, 'requests')), 'probe reached the port from the file, so the request was written');
  } finally { srv.close(); }
});

test('set-status: writes are atomic — no temp files are left behind', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'at' });
  run(home, 'tool-use', { session_id: 'at', tool_name: 'Bash' });
  assert.deepEqual(fs.readdirSync(path.join(home, 'sessions')), [`${HOST}-at.json`]);
});

test('set-status: a half-written previous file is re-read instead of wiping state', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const file = sessionFile(home, 'rt');
  const since = new Date(Date.now() - 60000).toISOString();
  const full = JSON.stringify({
    sessionId: 'rt', signal: 'tool-use', tool: 'Bash', workingSince: since, tasks: { created: 2, done: 1 },
    agents: [{ id: 'ag-9', name: 'executor', kind: 'subagent', status: 'working', since: new Date().toISOString() }],
    mode: 'ralph', iteration: 3, updatedAt: new Date(Date.now() - 5000).toISOString(),
  });
  fs.writeFileSync(file, full.slice(0, 40));
  const child = spawn(process.execPath, [SET_STATUS, 'tool-done'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_READ_RETRY_MS: '800' } });
  child.stdin.end(JSON.stringify({ session_id: 'rt', tool_name: 'Read' }));
  let err = '';
  child.stderr.on('data', (b) => { err += b; });
  setTimeout(() => fs.writeFileSync(file, full), 250);
  return new Promise((resolve) => child.on('exit', (code) => {
    assert.equal(code, 0);
    assert.equal(err, '', 'the retry saw the finished write');
    const d = read(home, 'rt');
    assert.equal(d.signal, 'tool-done');
    assert.equal(d.workingSince, since);
    assert.deepEqual(d.tasks, { created: 2, done: 1 });
    assert.deepEqual(d.agents.map((a) => a.id), ['ag-9']);
    assert.deepEqual([d.mode, d.iteration], ['ralph', 3]);
    resolve();
  }));
});

test('set-status: a file that stays unreadable is logged and replaced', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(sessionFile(home, 'bad'), '{"sessionId": "bad", "sig');
  const r = run(home, 'tool-use', { session_id: 'bad', tool_name: 'Bash' }, { CLAUDE_TRAFFIC_LIGHT_READ_RETRY_MS: '5' });
  assert.match(r.stderr.toString(), /unreadable/);
  assert.equal(read(home, 'bad').signal, 'tool-use');
});

test('set-status: a Notification is mapped by notification_type, not by its text', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'nt' });
  run(home, 'tool-use', { session_id: 'nt', tool_name: 'Bash' });
  run(home, 'notification', { session_id: 'nt', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  const ask = read(home, 'nt');
  assert.deepEqual([ask.signal, ask.askKind, ask.prevSignal, ask.via], ['permission-ask', 'notification', 'tool-use', 'notification/permission_prompt']);
  assert.equal(ask.signalSince, ask.updatedAt);

  run(home, 'notification', { session_id: 'nt', notification_type: 'auth_success', message: 'Please confirm you are signed in' });
  assert.deepEqual(read(home, 'nt'), ask, 'auth_success is bookkeeping: no write, whatever the text says');

  run(home, 'stop', { session_id: 'nt' });
  run(home, 'notification', { session_id: 'nt', notification_type: 'idle_prompt', message: 'Claude is waiting for your permission' });
  assert.equal(read(home, 'nt').signal, 'idle-nudge', 'the type wins over permission-ish text');

  run(home, 'notification', { session_id: 'nt', notification_type: 'elicitation_dialog', message: 'An MCP server wants input' });
  const el = read(home, 'nt');
  assert.deepEqual([el.signal, el.askKind, el.prevSignal], ['permission-ask', 'notification', 'idle-nudge']);
  assert.equal(el.via, 'notification/elicitation_dialog after-stop', 'an ask after the turn ended is tagged for the log');
});

test('set-status: with no notification_type the message text decides; a limit is a limit either way', () => {
  const home = tmpHome();
  run(home, 'notification', { session_id: 'rx', message: 'Claude needs your permission to use Bash' });
  assert.deepEqual([read(home, 'rx').signal, read(home, 'rx').via], ['permission-ask', 'notification/regex']);
  run(home, 'notification', { session_id: 'rx', message: 'Claude is waiting for your input' });
  assert.equal(read(home, 'rx').signal, 'idle-nudge');
  run(home, 'notification', { session_id: 'rx', notification_type: 'idle_prompt', message: "You've reached your usage limit" });
  assert.equal(read(home, 'rx').signal, 'limit-hit');
});

test('set-status: AskUserQuestion is an ask until its PostToolUse', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'q' });
  run(home, 'tool-use', { session_id: 'q', tool_name: 'AskUserQuestion' });
  const q = read(home, 'q');
  assert.deepEqual([q.signal, q.tool, q.askKind, q.via], ['permission-ask', 'AskUserQuestion', 'question', 'tool-use/AskUserQuestion']);
  run(home, 'tool-done', { session_id: 'q', tool_name: 'AskUserQuestion' });
  const d = read(home, 'q');
  assert.deepEqual([d.signal, d.askKind, d.prevSignal], ['tool-done', null, 'permission-ask']);
  assert.ok(d.workingSince, 'the turn is working again');
});

test('set-status: a permission denial in a turn that carries on goes back to working', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'dn' });
  run(home, 'permission-denied', { session_id: 'dn', tool_name: 'Bash' });
  run(home, 'tool-use', { session_id: 'dn', tool_name: 'Read' });
  const d = read(home, 'dn');
  assert.deepEqual([d.signal, d.tool], ['tool-use', 'Read']);
  assert.ok(d.workingSince);
});

// ── agents.js: sweeping session files no stale window can show ──────────────
test('sweepStaleFiles deletes only .json/.tmp files older than maxAge, by mtime alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-sweep-'));
  const now = Date.now();
  const put = (name, ageMs, body = '{}') => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, body);
    const t = new Date(now - ageMs);
    fs.utimesSync(f, t, t);
  };
  const DAY = 86400000;
  put('old.json', 2 * DAY);
  put('old-unparsable.json', 2 * DAY, '{"half');
  put('host-abc.json.1234.tmp', 2 * DAY);
  put('young.json', DAY / 2);
  put('young-unparsable.json', 60000, '{"half');
  put('young.json.99.tmp', 1000);
  put('old-notes.txt', 2 * DAY);
  const removed = A.sweepStaleFiles(dir, DAY, now).sort();
  assert.deepEqual(removed, ['host-abc.json.1234.tmp', 'old-unparsable.json', 'old.json']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['old-notes.txt', 'young-unparsable.json', 'young.json', 'young.json.99.tmp']);
  assert.deepEqual(A.sweepStaleFiles(path.join(dir, 'missing'), DAY, now), []);
});

// ── Concurrent writers (hooks/session-state.js) ─────────────────────────────
const SessionState = require('../hooks/session-state.js');
const Rules = require('../rules.js');
const EMIT = path.join(__dirname, '..', 'hooks', 'emit.js');

function runAsync(home, signal, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SET_STATUS, signal], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home } });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('set-status: parallel SubagentStart/Stop hooks lose no agent (the lock)', async () => {
  const home = tmpHome();
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
  run(home, 'prompt-submit', { session_id: 'par', cwd: '/w' });
  await Promise.all(ids.map((id) => runAsync(home, 'subagent-start', { session_id: 'par', cwd: '/w', agent_id: id, agent_type: 'executor' })));
  assert.deepEqual(read(home, 'par').agents.map((a) => a.id).sort(), ids, 'every parallel start recorded');
  await Promise.all(ids.map((id) => runAsync(home, 'subagent-done', { session_id: 'par', cwd: '/w', agent_id: id })));
  run(home, 'stop', { session_id: 'par', cwd: '/w' });
  const d = read(home, 'par');
  assert.deepEqual(d.agents.filter((a) => a.status === 'working').map((a) => a.id), [], 'no stop lost, so no phantom working agent');
  assert.equal(Rules.effectiveSignal(d).signal, 'stop', 'the finished turn reads as finished');
  assert.deepEqual(fs.readdirSync(path.join(home, 'sessions')), [`${HOST}-par.json`], 'no lock or temp file left behind');
});

test('withLock: waits for a live lock, breaks a stale one, and never hangs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-lock-'));
  const file = path.join(dir, 's.json');
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - SessionState.STALE_LOCK_MS - 1000);
  fs.utimesSync(lock, old, old);
  assert.equal(SessionState.withLock(file, () => fs.existsSync(lock)), true, 'stale lock broken and taken');
  assert.ok(!fs.existsSync(lock), 'released after');

  fs.writeFileSync(lock, '');
  const t0 = Date.now();
  fs.writeFileSync(file, 'newer-input');
  let wrote = false;
  assert.equal(SessionState.withLock(file, () => { wrote = true; fs.writeFileSync(file, 'lost-input'); }, 100), undefined);
  assert.equal(wrote, false, 'a timed-out writer cannot erase a newer input');
  assert.equal(fs.readFileSync(file, 'utf8'), 'newer-input');
  assert.ok(Date.now() - t0 >= 100);
  assert.ok(fs.existsSync(lock), 'someone else\'s lock is not removed by a writer that never held it');
  assert.equal(SessionState.withLockOrSkip(file, () => 'ran'), undefined, 'the app skips instead of waiting');
  fs.rmSync(lock);
  assert.equal(SessionState.withLockOrSkip(file, () => 'ran'), 'ran');
});

test('TURN_END: the hooks and the rules engine share one list', () => {
  assert.deepEqual([...SessionState.TURN_END].sort(), [...Rules.TURN_END].sort());
});

test('emit.js: a bare signal keeps agents, mode and cwd, and a failed turn ends the turn', () => {
  const home = tmpHome();
  const emit = (...args) => {
    const r = spawnSync(process.execPath, [EMIT, ...args], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home }, input: '' });
    assert.equal(r.status, 0, r.stderr.toString());
  };
  emit('prompt-submit', '--source', 'cursor', '--session', 'c1', '--cwd', '/w/proj');
  const file = path.join(home, 'sessions', `${HOST}-cursor-c1.json`);
  const d0 = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(d0.touchedAt, 'a prompt is a touch');
  fs.writeFileSync(file, JSON.stringify({ ...d0, agents: [{ id: 't', kind: 'teammate', status: 'working' }], mode: 'team', iteration: 3 }));
  emit('turn-failed', '--source', 'cursor', '--session', 'c1');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([d.signal, d.workingSince, d.mode, d.iteration, d.agents.length, d.cwd, d.touchedAt], ['turn-failed', null, 'team', 3, 1, '/w/proj', d0.touchedAt]);
});

test('emit.js: reported work metadata persists across progress, resets for a new task and never chooses a board', () => {
  const home = tmpHome();
  const emit = (...args) => {
    const r = spawnSync(process.execPath, [EMIT, ...args, '--source', 'codex', '--session', 'work'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home }, input: '' });
    assert.equal(r.status, 0, r.stderr.toString());
  };
  const file = path.join(home, 'sessions', `${HOST}-codex-work.json`);
  const state = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  emit('tool-use', '--cwd', '/work/app', '--task', 'build', '--title', 'Build app', '--summary', 'Updating routing');
  assert.deepEqual([state().taskId, state().taskTitle, state().taskSummary], ['build', 'Build app', 'Updating routing']);
  emit('stop');
  assert.equal(state().taskSummary, 'Updating routing');
  emit('tool-use', '--task', 'next', '--board', 'arbitrary-board', '--run', 'arbitrary-run');
  assert.deepEqual([state().taskId, state().taskTitle, state().taskSummary], ['next', null, null]);
  assert.equal(state().board_id, undefined); assert.equal(state().run_id, undefined);
  emit('tool-use', '--task', '../bad'); assert.equal(state().taskId, 'next');
});

test('emit.js: bare source and session cannot select a file outside the sessions directory', () => {
  const home = tmpHome();
  const r = spawnSync(process.execPath, [EMIT, 'tool-use', '--source', 'codex/../../escape', '--session', '../../../outside'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home }, input: '' });
  assert.equal(r.status, 0, r.stderr.toString());
  const files = fs.readdirSync(path.join(home, 'sessions'));
  assert.equal(files.length, 1); assert.ok(files[0].startsWith(`${HOST}-custom-`));
  assert.ok(!fs.existsSync(path.join(home, 'outside.json')));
});

test('emit.js: bare signals get the same guards — a late subagent-done keeps "finished", the idle nudge keeps a failure', () => {
  const home = tmpHome();
  const emit = (...args) => {
    const r = spawnSync(process.execPath, [EMIT, ...args, '--source', 'cursor', '--session', 'g1'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home }, input: '' });
    assert.equal(r.status, 0, r.stderr.toString());
  };
  const file = path.join(home, 'sessions', `${HOST}-cursor-g1.json`);
  const readG = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  emit('tool-use', '--tool', 'Bash');
  emit('stop');
  const stopped = readG();
  emit('subagent-done');
  const d = readG();
  assert.deepEqual([d.signal, d.tool, d.updatedAt], ['stop', stopped.tool, stopped.updatedAt], 'not green, and not the session moving');
  assert.ok(d.agentsAt, 'bookkeeping stamps agentsAt');
  emit('turn-failed');
  emit('idle-nudge');
  assert.equal(readG().signal, 'turn-failed');
});

test('applyBareSignal (/signal): a held signal keeps the stored tool; a landed one takes the new tool', () => {
  const prev = { sessionId: 's', signal: 'stop', tool: 'Edit', updatedAt: '2026-09-30T10:00:00.000Z' };
  const held = SessionState.applyBareSignal(prev, { sessionId: 's', host: 'h', source: 'x', signal: 'subagent-start', tool: 'Agent' }, '2026-09-30T10:01:00.000Z');
  assert.deepEqual([held.signal, held.tool, held.updatedAt, held.agentsAt], ['stop', 'Edit', prev.updatedAt, '2026-09-30T10:01:00.000Z']);
  const landed = SessionState.applyBareSignal(prev, { sessionId: 's', host: 'h', source: 'x', signal: 'tool-use', tool: 'Bash' }, '2026-09-30T10:01:00.000Z');
  assert.deepEqual([landed.signal, landed.tool, landed.updatedAt], ['tool-use', 'Bash', '2026-09-30T10:01:00.000Z']);
});

test('set-status: touchedAt moves when you act, not when Claude does', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'tc', cwd: '/w' });
  const t0 = read(home, 'tc').touchedAt;
  assert.ok(t0);
  run(home, 'tool-use', { session_id: 'tc', tool_name: 'Bash' });
  run(home, 'stop', { session_id: 'tc' });
  run(home, 'idle-nudge', { session_id: 'tc' });
  assert.equal(read(home, 'tc').touchedAt, t0, 'working, finishing and the idle nudge are Claude, not you');
  run(home, 'tool-use', { session_id: 'tc', tool_name: 'AskUserQuestion' });
  run(home, 'tool-done', { session_id: 'tc', tool_name: 'AskUserQuestion' });
  assert.notEqual(read(home, 'tc').touchedAt, t0, 'answering a question is a touch');
  const t1 = read(home, 'tc').touchedAt;
  run(home, 'session-start', { session_id: 'tc', source: 'compact' });
  assert.equal(read(home, 'tc').touchedAt, t1, 'an auto-compact is not you');
});

test('userTouched: a notification ask counts only once it outlived the classifier', () => {
  const now = Date.parse('2026-09-11T12:00:00Z');
  const ask = (ms, askKind = 'notification') => ({ signal: 'permission-ask', askKind, signalSince: new Date(now - ms).toISOString() });
  assert.equal(SessionState.userTouched(ask(300), 'tool-use', { now }), false, 'auto mode settled it in 300 ms');
  assert.equal(SessionState.userTouched(ask(5000), 'tool-use', { now }), true);
  assert.equal(SessionState.userTouched(ask(10, 'request'), 'tool-use', { now }), true, 'a blocking request is always you');
  assert.equal(SessionState.userTouched(ask(5000), 'stop', { now }), false, 'a turn end is not an answer');
  assert.equal(SessionState.userTouched(null, 'prompt-submit', { bookkeeping: true, now }), false);
});

test('withLock: breaking a stale lock never deletes a live one, and release only frees your own', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-lock2-'));
  const file = path.join(dir, 's.json');
  const lock = `${file}.lock`;
  // A waiter judged the old lock stale, but by the time it acts a fresh lock
  // holds the name: simulated by a fresh lock whose stat the breaker sees as old.
  fs.writeFileSync(lock, 'someone-else');
  const realStat = fs.statSync;
  let calls = 0;
  fs.statSync = (p, ...rest) => {
    const st = realStat(p, ...rest);
    if (p === lock && calls++ === 0) return { ...st, mtimeMs: Date.now() - SessionState.STALE_LOCK_MS - 1000, ino: -1 };
    return st;
  };
  try {
    assert.equal(SessionState.withLockOrSkip(file, () => 'ran'), undefined, 'did not take the live lock');
  } finally {
    fs.statSync = realStat;
  }
  assert.equal(fs.readFileSync(lock, 'utf8'), 'someone-else', 'the live lock was put back, not deleted');
  assert.deepEqual(fs.readdirSync(dir), ['s.json.lock'], 'nothing left aside');
  // A holder whose lock was taken over (it slept past STALE_LOCK_MS) must not
  // free the new holder's lock on its way out.
  fs.rmSync(lock);
  SessionState.withLock(file, () => fs.writeFileSync(lock, 'new-holder'));
  assert.equal(fs.readFileSync(lock, 'utf8'), 'new-holder');
});

// ── Sessions whose Claude process is gone ───────────────────────────────────
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  return Number(r.stdout.trim());
}

test('processGone: only a recorded, local, exited pid counts as gone', () => {
  const dead = deadPid();
  assert.equal(SessionState.processGone({ claudePid: process.pid, host: HOST }, HOST), false, 'alive');
  assert.equal(SessionState.processGone({ claudePid: dead, host: HOST }, HOST), true, 'exited');
  assert.equal(SessionState.processGone({ claudePid: dead, host: 'other-mac' }, HOST), false, 'another machine\'s pid means nothing here');
  assert.equal(SessionState.processGone({ host: HOST }, HOST), false, 'no pid recorded (older hook, other agent)');
});

test('set-status: records the Claude process, looking past a shell in between', { skip: process.platform === 'win32' }, () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'pid1', cwd: '/w' });
  assert.equal(read(home, 'pid1').claudePid, process.pid, 'a hook run directly: its parent');
  // `; true` stops sh from exec-ing node in its place, so sh stays the parent.
  const r = spawnSync('/bin/sh', ['-c', `"${process.execPath}" "${SET_STATUS}" prompt-submit; true`], {
    env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home },
    input: JSON.stringify({ session_id: 'pid2', cwd: '/w' }),
  });
  assert.equal(r.status, 0, r.stderr.toString());
  assert.equal(read(home, 'pid2').claudePid, process.pid, 'the shell\'s parent, not the shell');
});

test('a session killed mid-question is dropped, not shown as "Needs your input"', () => {
  const M = require('../mcp-server.js');
  const now = Date.now();
  const ask = { sessionId: 'k', host: HOST, cwd: '/w', signal: 'permission-ask', askKind: 'question', updatedAt: new Date(now - 60000).toISOString() };
  const config = { workingStaleMinutes: 10, waitingStaleHours: 2 };
  assert.equal(M.classifySession({ ...ask, claudePid: process.pid }, config, now).live, true, 'still running: the ask stands');
  const gone = M.classifySession({ ...ask, claudePid: deadPid() }, config, now);
  assert.equal(gone.live, false);
  assert.match(gone.dropped, /exited without a SessionEnd/);
});

test('retryTransient: Windows retries EPERM/EACCES/EBUSY a few times; other OSes and other errors fail at once', () => {
  const failing = (codes) => { let n = 0; return () => { const c = codes[n++]; if (c) { const e = new Error(c); e.code = c; throw e; } return 'ok'; }; };
  const sleeps = [];
  const sleep = (ms) => sleeps.push(ms);
  assert.equal(SessionState.retryTransient(failing(['EPERM', 'EBUSY', 'EACCES']), { platform: 'win32', sleep }), 'ok');
  assert.equal(sleeps.length, 3);
  assert.throws(() => SessionState.retryTransient(failing(['EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM']), { platform: 'win32', sleep }), { code: 'EPERM' }, 'gives up after 5 tries');
  assert.throws(() => SessionState.retryTransient(failing(['ENOENT']), { platform: 'win32', sleep }), { code: 'ENOENT' });
  const before = sleeps.length;
  assert.throws(() => SessionState.retryTransient(failing(['EPERM']), { platform: 'darwin', sleep }), { code: 'EPERM' });
  assert.equal(sleeps.length, before, 'macOS never sleeps or retries');
});

test('tryLock: on Windows a lock that cannot be created for EPERM is contention, elsewhere an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-lock-'));
  const lock = path.join(dir, 'missing-dir', 'x.lock');
  // ENOENT (no directory) stays an error everywhere.
  assert.throws(() => SessionState.tryLock(lock, 't', 'win32'), { code: 'ENOENT' });
  const real = fs.writeFileSync;
  fs.writeFileSync = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
  try {
    assert.equal(SessionState.tryLock(path.join(dir, 'y.lock'), 't', 'win32'), false);
    assert.throws(() => SessionState.tryLock(path.join(dir, 'y.lock'), 't', 'darwin'), { code: 'EPERM' });
  } finally { fs.writeFileSync = real; }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('set-status: unrelated parallel completion preserves the original question and waiting clock', () => {
  const home = tmpHome(), sid = 'parallel-q';
  run(home, 'prompt-submit', { session_id: sid });
  run(home, 'tool-use', { session_id: sid, tool_name: 'AskUserQuestion', tool_use_id: 'q-a', tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } });
  const original = read(home, sid);
  run(home, 'tool-done', { session_id: sid, tool_name: 'Read', tool_use_id: 'read-b' });
  const after = read(home, sid);
  assert.equal(after.signal, 'permission-ask'); assert.equal(after.updatedAt, original.updatedAt);
  assert.equal(after.touchedAt, original.touchedAt, 'sibling tool completion is not a human answer');
  assert.deepEqual(after.ask, original.ask);
  run(home, 'session-start', { session_id: sid, source: 'compact' });
  assert.equal(read(home, sid).signal, 'permission-ask', 'compaction cannot answer a question');
  run(home, 'tool-done', { session_id: sid, tool_name: 'AskUserQuestion', tool_use_id: 'q-a' });
  assert.equal(read(home, sid).signal, 'tool-done'); assert.deepEqual(read(home, sid).claudeInputRequests, []);
});
test('set-status: parallel child questions use both tool and agent identity', () => {
  const home = tmpHome(), sid = 'parallel-children';
  run(home, 'prompt-submit', { session_id: sid });
  for (const agent_id of ['a', 'b']) {
    run(home, 'subagent-start', { session_id: sid, agent_id });
    run(home, 'tool-use', { session_id: sid, agent_id, tool_name: 'AskUserQuestion', tool_use_id: 'shared-id' });
  }
  assert.deepEqual(read(home, sid).agents.map(a => a.status), ['waiting', 'waiting']);
  run(home, 'tool-done', { session_id: sid, tool_name: 'AskUserQuestion', tool_use_id: 'shared-id' });
  assert.equal(read(home, sid).claudeInputRequests.length, 2, 'parent receipt cannot clear either child');
  run(home, 'tool-done', { session_id: sid, agent_id: 'a', tool_name: 'AskUserQuestion', tool_use_id: 'shared-id' });
  let result = read(home, sid);
  assert.equal(result.signal, 'permission-ask'); assert.deepEqual(result.agents.map(a => a.status), ['working', 'waiting']);
  assert.equal(result.claudeInputRequests[0].agentId, 'b');
  run(home, 'subagent-done', { session_id: sid, agent_id: 'b' });
  result = read(home, sid);
  assert.equal(result.signal, 'tool-done'); assert.equal(result.agents[1].status, 'done');
  run(home, 'tool-use', { session_id: sid, tool_name: 'AskUserQuestion', tool_use_id: 'q-c' });
  run(home, 'stop', { session_id: sid });
  assert.deepEqual(read(home, sid).claudeInputRequests, []); assert.equal(read(home, sid).signal, 'stop');
});

test('set-status: foreground stop and next prompt preserve a background agent input until that agent ends', () => {
  const home = tmpHome(), sid = 'background-input';
  run(home, 'prompt-submit', { session_id: sid });
  run(home, 'subagent-start', { session_id: sid, agent_id: 'bg' });
  run(home, 'tool-use', { session_id: sid, agent_id: 'bg', tool_name: 'AskUserQuestion', tool_use_id: 'bg-q' });
  for (const signal of ['stop', 'prompt-submit']) {
    run(home, signal, { session_id: sid });
    assert.equal(read(home, sid).signal, 'permission-ask');
    assert.equal(read(home, sid).claudeInputRequests[0].agentId, 'bg');
  }
  run(home, 'subagent-done', { session_id: sid, agent_id: 'bg' });
  assert.deepEqual(read(home, sid).claudeInputRequests, []);
});

test('set-status: a newly asked parallel question refreshes aggregate input evidence while old questions keep their own clocks', () => {
  const home = tmpHome(), sid = 'old-new-input';
  run(home, 'prompt-submit', { session_id: sid });
  run(home, 'tool-use', { session_id: sid, tool_name: 'AskUserQuestion', tool_use_id: 'old-q' });
  const old = read(home, sid), oldAt = new Date(Date.now() - 300_000).toISOString();
  old.updatedAt = oldAt; old.claudeInputRequests[0].askedAt = oldAt;
  fs.writeFileSync(sessionFile(home, sid), JSON.stringify(old));
  run(home, 'tool-use', { session_id: sid, tool_name: 'AskUserQuestion', tool_use_id: 'fresh-q' });
  const fresh = read(home, sid);
  assert.equal(fresh.claudeInputRequests[0].askedAt, oldAt);
  assert.equal(require('../hooks/session-machine').classify(fresh, { now: Date.now(), waitingStaleMs: 60_000 }).live, true, 'new input is current despite older unanswered input');
  assert.equal(fresh.updatedAt, fresh.claudeInputRequests[1].askedAt);
  run(home, 'tool-done', { session_id: sid, tool_name: 'Read', tool_use_id: 'unrelated' });
  assert.equal(read(home, sid).updatedAt, fresh.updatedAt, 'ordinary work does not refresh the input evidence');
});

// ── agents.js: mtime-gated JSON reads ───────────────────────────────────────
test('createJsonReader serves an unchanged old file from memory and re-reads a changed one', () => {
  let reads = 0;
  const files = { '/a.json': { text: '{"n":1}', mtimeMs: 1000, size: 7 } };
  const fake = {
    statSync: (f) => { if (!files[f]) throw new Error('ENOENT'); return files[f]; },
    readFileSync: (f) => { reads += 1; return files[f].text; },
  };
  const read = A.createJsonReader(fake, () => 1_000_000);
  assert.deepEqual(read('/a.json'), { n: 1 });
  assert.deepEqual(read('/a.json'), { n: 1 });
  assert.equal(reads, 1);
  files['/a.json'] = { text: '{"n":2}', mtimeMs: 2000, size: 7 };
  assert.deepEqual(read('/a.json'), { n: 2 });
  assert.equal(reads, 2);
  delete files['/a.json'];
  assert.equal(read('/a.json'), null);
});

test('createJsonReader never caches a file written within the racy window', () => {
  let reads = 0;
  const fake = {
    statSync: () => ({ mtimeMs: 999_500, size: 7 }),
    readFileSync: () => { reads += 1; return '{"n":1}'; },
  };
  const read = A.createJsonReader(fake, () => 1_000_000);
  read('/b.json'); read('/b.json');
  assert.equal(reads, 2);
});

test('createJsonReader returns null for malformed JSON without throwing', () => {
  const fake = { statSync: () => ({ mtimeMs: 1, size: 3 }), readFileSync: () => '{x' };
  assert.equal(A.createJsonReader(fake, () => 1_000_000)('/c.json'), null);
});
