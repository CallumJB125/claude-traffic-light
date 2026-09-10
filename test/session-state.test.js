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
  const r = scanTeam(
    [
      member('active', { isActive: true }),
      member('finished', { isActive: false }),
      member('never', {}),
      member('fresh', {}),
      member('noinbox', {}),
      member('readold', {}),
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
  return { transcript, scan, proj };
}

test('teams: an active member whose transcript went quiet is waiting; fresh or missing is working', () => {
  const f = teamFixture([
    member('fresh', { isActive: true }),
    member('idle', { isActive: true }),
    member('lost', { isActive: true }),
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

test('set-status: turn-failed and permission-denied end the turn\'s working clock', () => {
  for (const end of ['turn-failed', 'permission-denied']) {
    const home = tmpHome();
    run(home, 'prompt-submit', { session_id: 'f' });
    assert.ok(read(home, 'f').workingSince);
    run(home, end, { session_id: 'f' });
    assert.equal(read(home, 'f').workingSince, null, end);
    run(home, 'subagent-done', { session_id: 'f', agent_id: 'x' });
    assert.equal(read(home, 'f').signal, end, `${end} is a turn end for bookkeeping too`);
  }
});

test('set-status: a PermissionRequest marks the session as asking, still passing through unanswered', () => {
  const home = tmpHome();
  run(home, 'prompt-submit', { session_id: 'pr', cwd: '/x/p' });
  const r = run(home, 'permission-request', { session_id: 'pr', cwd: '/x/p', tool_name: 'Bash', tool_input: { command: 'ls' } }, { CLAUDE_TRAFFIC_LIGHT_ASK_MS: '200' });
  assert.equal(r.stdout.toString(), '', 'no decision → Claude Code shows its own dialog');
  const d = read(home, 'pr');
  assert.deepEqual([d.signal, d.tool, d.workingSince], ['permission-ask', 'Bash', null]);
  assert.deepEqual(fs.readdirSync(path.join(home, 'requests')), [], 'request cleaned up');
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
