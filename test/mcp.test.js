const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const M = require('../mcp-server.js');
const McpInstall = require('../mcp-install.js');

const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const iso = (agoMs) => new Date(NOW - agoMs).toISOString();

function fixture({ sessions = {}, config = null, requests = [], log = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mcp-'));
  fs.mkdirSync(path.join(root, 'sessions'));
  fs.mkdirSync(path.join(root, 'requests'));
  for (const [name, data] of Object.entries(sessions)) fs.writeFileSync(path.join(root, 'sessions', `${name}.json`), typeof data === 'string' ? data : JSON.stringify(data));
  if (config) fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  for (const r of requests) fs.writeFileSync(path.join(root, 'requests', `${r.id}.json`), JSON.stringify(r));
  if (log) fs.writeFileSync(path.join(root, 'app.log'), log);
  return root;
}
const session = (id, extra = {}) => ({ sessionId: id, host: 'h', cwd: `/w/${id}`, signal: 'tool-use', tool: 'Bash', updatedAt: iso(1000), ...extra });
// seasonal off so a December test run can't paint a Santa hat into the look.
const base = { seasonal: false };

test('buddy_status: resolves the look and names the rule behind each channel', async () => {
  const root = fixture({ config: base, sessions: { a: session('a') } });
  const st = await M.buddyStatus({ root, now: NOW, online: true, live: null });
  assert.equal(st.reason, 'session');
  assert.equal(st.look.lamp, 'green');
  assert.equal(st.channels.lamp.ruleId, 'working');
  assert.equal(st.lampOwner.rule, 'Claude is working');
  assert.equal(st.firedNames[0], 'Claude is working');
  assert.equal(st.sessionCount, 1);
  assert.equal(st.currentTool, 'Bash');
  assert.equal(st.app.running, false);
});

test('buddy_status: no sessions is idle; offline adds the No network rule', async () => {
  const root = fixture({ config: base });
  assert.equal((await M.buddyStatus({ root, now: NOW, online: true, live: null })).reason, 'idle');
  const off = await M.buddyStatus({ root, now: NOW, online: false, live: null });
  assert.equal(off.channels.lamp.ruleId, 'offline');
  assert.equal(off.online.value, false);
});

test('buddy_status: compares against the running app when it answers', async () => {
  const root = fixture({ config: base, sessions: { a: session('a') } });
  const st = await M.buddyStatus({ root, now: NOW, online: true, live: null });
  const same = await M.buddyStatus({ root, now: NOW, online: true, live: { look: st.look } });
  assert.equal(same.app.agrees, true);
  const other = await M.buddyStatus({ root, now: NOW, online: true, live: { look: { ...st.look, pose: 'walk' } } });
  assert.equal(other.app.agrees, false);
});

test('buddy_status: a pending permission request forces the ask when answering from the widget is on', async () => {
  const req = { id: 'h-a-1', sessionId: 'a', cwd: '/w/a', tool: 'Bash', summary: 'rm -rf x', createdAt: iso(2000) };
  const root = fixture({ config: { ...base, askFromWidget: true }, sessions: { a: session('a') }, requests: [req] });
  const st = await M.buddyStatus({ root, now: NOW, online: true, live: null });
  assert.equal(st.reason, 'pending-permission');
  assert.equal(st.look.lamp, 'amber');
  assert.equal(st.pendingRequests, 1);
});

test('buddy_sessions: live and dropped sessions, with staleness and agent heartbeats', () => {
  const root = fixture({
    config: base,
    sessions: {
      a: session('a', { agents: [{ id: 'x', name: 'explore', kind: 'subagent', status: 'working', since: iso(30000) }] }),
      old: session('old', { updatedAt: iso(7 * 60000) }),
      broken: '{"half":',
    },
  });
  const { sessions } = M.buddySessions({ root, now: NOW });
  const byFile = Object.fromEntries(sessions.map((s) => [s.file, s]));
  assert.equal(byFile['a.json'].live, true);
  assert.equal(byFile['a.json'].agents[0].heartbeatAgoMs, 30000);
  assert.equal(byFile['a.json'].staleInMs, 6 * 60000 - 1000);
  assert.equal(byFile['old.json'].live, false);
  assert.match(byFile['old.json'].dropped, /stale/);
  assert.equal(byFile['broken.json'].live, false);
});

test('buddy_sessions: a finished turn with a working subagent is presented as tool-use (promoted)', () => {
  const root = fixture({ config: base, sessions: { a: session('a', { signal: 'stop', agents: [{ id: 'x', status: 'working', since: iso(60000) }] }) } });
  const [s] = M.buddySessions({ root, now: NOW }).sessions;
  assert.equal(s.signal, 'stop');
  assert.equal(s.presented, 'tool-use');
  assert.equal(s.via, 'promoted-agents');
  assert.equal(s.live, true);
});

test('buddy_why: a rule below the lamp owner is "not reached"; a non-matching one says which clause failed', () => {
  const root = fixture({ config: base, sessions: { a: session('a', { signal: 'permission-ask', askKind: 'request' }) } });
  const working = M.buddyWhy({ root, now: NOW, online: true, query: 'working' });
  assert.equal(working.kind, 'rule');
  assert.equal(working.firing, false);
  assert.match(working.verdict, /not firing: no session matches/);
  assert.match(working.sessions[0].failed[0], /signal permission-ask not in/);
  const ask = M.buddyWhy({ root, now: NOW, online: true, query: 'Needs your input' });
  assert.equal(ask.firing, true);
  assert.equal(ask.owns.includes('lamp'), true);
  assert.match(ask.verdict, /owns the lamp/);
});

test('buddy_why: disabled rules and lamp-owner cut-off are explained', () => {
  const rules = [
    { id: 'top', name: 'Top', when: { signal: ['tool-use'] }, then: { lamp: 'red' } },
    { id: 'below', name: 'Below', when: { signal: ['tool-use'] }, then: { pose: 'wave' } },
    { id: 'off', name: 'Off', enabled: false, when: { signal: ['tool-use'] }, then: { eyes: 'happy' } },
    { id: 'nudge', name: 'Nudge', when: { signal: ['idle-nudge'] }, then: { lamp: 'green' } },
  ];
  const root = fixture({ config: { ...base, rules, rulesVersion: 999 }, sessions: { a: session('a') } });
  assert.match(M.buddyWhy({ root, now: NOW, online: true, query: 'below' }).verdict, /not reached: resolution stopped at the lamp owner "Top"/);
  assert.equal(M.buddyWhy({ root, now: NOW, online: true, query: 'off' }).verdict, 'disabled (would match if enabled)');
  const pose = M.buddyWhy({ root, now: NOW, online: true, query: 'pose' });
  assert.equal(pose.kind, 'channel');
  assert.equal(pose.owner, null);
  assert.match(pose.candidates.find((c) => c.ruleId === 'below').verdict, /resolution stopped/);
  assert.equal(M.buddyWhy({ root, now: NOW, online: true, query: 'nope' }).kind, 'unknown');
});

test('buddy_rules: priority order with locked rules first and compact when/then', () => {
  const root = fixture({ config: base });
  const { rules } = M.buddyRules({ root });
  assert.ok(rules.length > 5);
  const firstUnlocked = rules.findIndex((r) => !r.locked);
  assert.ok(rules.slice(firstUnlocked).every((r) => !r.locked));
  assert.deepEqual(Object.keys(rules[0]), ['priority', 'id', 'name', 'enabled', 'locked', 'when', 'then']);
  assert.ok(!('tool' in rules[0].when), 'null clauses are left out');
});

test('buddy_recent_transitions: parses [state] lines newest first, across the rotated log', () => {
  const root = fixture({
    log: [
      '2026-09-11T11:00:00.000Z [log] [state] aaaa1111 work/my proj — → tool-use (hook signal)',
      '2026-09-11T11:00:01.000Z [log] [router] something else',
      '2026-09-11T11:00:02.000Z [log] [state] aaaa1111 work/my proj tool-use → turn-failed [network] (hook signal) +3 unlogged',
      '2026-09-11T11:00:03.000Z [log] [state] bbbb2222 x stop → tool-use (promoted-agents)',
      '',
    ].join('\n'),
  });
  fs.writeFileSync(path.join(root, 'app.log.old'), '2026-09-11T10:00:00.000Z [log] [state] aaaa1111 work/my proj stop → permission-ask (hysteresis-held)\n');
  const r = M.buddyRecentTransitions({ root, limit: 10 });
  assert.equal(r.total, 4);
  assert.deepEqual(r.transitions[0], { at: '2026-09-11T11:00:03.000Z', session: 'bbbb2222', project: 'x', from: 'stop', to: 'tool-use', failKind: null, cause: 'promoted-agents', unlogged: 0 });
  assert.deepEqual(r.transitions[1], { at: '2026-09-11T11:00:02.000Z', session: 'aaaa1111', project: 'work/my proj', from: 'tool-use', to: 'turn-failed', failKind: 'network', cause: 'hook signal', unlogged: 3 });
  assert.equal(r.transitions[2].from, null);
  assert.equal(r.transitions[3].cause, 'hysteresis-held');
  assert.equal(M.buddyRecentTransitions({ root, session: 'bbbb2222aaaa' }).total, 1);
  assert.equal(M.buddyRecentTransitions({ root, limit: 1 }).transitions.length, 1);
});

test('buddy_pending_requests + buddy_answer_request: the widget\'s own answer file', () => {
  const req = { id: 'h-a-1', sessionId: 'a', cwd: '/w/a', tool: 'Bash', summary: 'ls', createdAt: iso(5000) };
  const expired = { id: 'h-b-1', sessionId: 'b', cwd: '/w/b', tool: 'Bash', summary: 'ls', createdAt: iso(120000) };
  const root = fixture({ config: { askFromWidget: true }, requests: [req, expired] });
  const p = M.buddyPendingRequests({ root, now: NOW });
  assert.equal(p.askFromWidget, true);
  assert.deepEqual(p.requests.map((r) => r.id), ['h-a-1']);
  assert.equal(p.requests[0].answered, false);
  assert.equal(p.requests[0].ageMs, 5000);

  assert.equal(M.answerRequest(root, 'h-a-1', 'maybe').ok, false);
  assert.equal(M.answerRequest(root, '../../etc', 'allow').ok, false);
  assert.equal(M.answerRequest(root, 'h-nope', 'allow').ok, false);
  assert.deepEqual(M.answerRequest(root, 'h-a-1', 'allow'), { ok: true, id: 'h-a-1', decision: 'allow' });
  assert.equal(fs.readFileSync(path.join(root, 'requests', 'h-a-1.answer'), 'utf8'), 'allow');
  assert.equal(M.buddyPendingRequests({ root, now: NOW }).requests[0].answered, true);
});

test('buddy_router_status: config, overrides and the decisions tail', () => {
  const root = fixture({ config: { routerEnabled: true, routerPolicy: 'frugal', routerProjects: { bondly: 'opus' } } });
  fs.mkdirSync(path.join(root, 'router'));
  fs.writeFileSync(path.join(root, 'router', 'decisions.jsonl'), ['a', 'b', 'c'].map((m) => JSON.stringify({ model: m })).join('\n'));
  const r = M.buddyRouterStatus({ root, limit: 2 });
  assert.equal(r.enabled, true);
  assert.equal(r.policy, 'frugal');
  assert.deepEqual(r.projectOverrides, { bondly: 'opus' });
  assert.deepEqual(r.decisions.map((d) => d.model), ['c', 'b']);
  assert.equal(typeof r.launcher.installed, 'boolean');
});

test('buddy_savings: reads transcripts from the given projects dir', async () => {
  const root = fixture({ config: base });
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mcp-projects-'));
  const r = await M.buddySavings({ root, now: NOW, projectsDir });
  assert.equal(r.transcripts.turns, 0);
  assert.equal(typeof r.savings, 'object');
  assert.equal(typeof r.subscriber, 'boolean');
});

test('the server exposes exactly the nine buddy_ tools', () => {
  assert.deepEqual(M.TOOLS.map((t) => t.name), ['buddy_status', 'buddy_sessions', 'buddy_why', 'buddy_rules', 'buddy_recent_transitions', 'buddy_savings', 'buddy_router_status', 'buddy_pending_requests', 'buddy_answer_request']);
  assert.deepEqual(M.TOOLS.filter((t) => t.readOnly === false).map((t) => t.name), ['buddy_answer_request']);
});

test('stdio: the server starts, lists nine tools and answers buddy_status end to end', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const root = fixture({ config: base, sessions: { a: session('a', { updatedAt: new Date().toISOString() }) } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp-server.js')],
    // A port nothing listens on, so the real widget can't answer for the fixture.
    env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: root, CLAUDE_TRAFFIC_LIGHT_PORT: '1' },
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    const r = await client.callTool({ name: 'buddy_status', arguments: {} });
    const st = JSON.parse(r.content[0].text);
    assert.equal(st.sessionCount, 1);
    assert.equal(st.look.lamp, 'green');
    const bad = await client.callTool({ name: 'buddy_answer_request', arguments: { id: 'nope', decision: 'allow' } });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
  }
});

// ── Registration in ~/.claude.json ─────────────────────────────────────────
const entry = McpInstall.launch({ packaged: true, execPath: '/Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy', appPath: '/Applications/Claude Buddy.app/Contents/Resources/app.asar', dir: '/x' });

test('mcp-install: launch runs the packaged app as node, or plain node in dev', () => {
  assert.deepEqual(entry, { type: 'stdio', command: '/Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy', args: ['/Applications/Claude Buddy.app/Contents/Resources/app.asar/mcp-server.js'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.deepEqual(McpInstall.launch({ packaged: false, dir: '/repo', root: '/r' }), { type: 'stdio', command: 'node', args: ['/repo/mcp-server.js'], env: { CLAUDE_TRAFFIC_LIGHT_HOME: '/r' } });
});

test('mcp-install: idempotent install/uninstall that keeps every other key and server', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mcp-home-'));
  const file = path.join(home, '.claude.json');
  const foreign = { numStartups: 42, projects: { '/w': { mcpServers: { local: { command: 'x' } } } }, mcpServers: { other: { type: 'stdio', command: 'npx', args: ['-y', 'other'] } } };
  fs.writeFileSync(file, JSON.stringify(foreign));

  assert.equal(McpInstall.install({ home, entry }).changed, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after.mcpServers.other, foreign.mcpServers.other);
  assert.deepEqual(after.mcpServers['claude-buddy'], entry);
  assert.equal(after.numStartups, 42);
  assert.deepEqual(after.projects, foreign.projects);
  assert.equal(McpInstall.install({ home, entry }).changed, false, 'second install is a no-op');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers).length, 2);
  assert.deepEqual(McpInstall.status({ home, entry }), { installed: true, current: true, name: 'claude-buddy', path: file, entry, error: null });

  const moved = { ...entry, args: ['/elsewhere/app.asar/mcp-server.js'] };
  assert.equal(McpInstall.status({ home, entry: moved }).current, false);
  assert.equal(McpInstall.install({ home, entry: moved }).changed, true, 'a moved app updates its own entry');

  assert.equal(McpInstall.uninstall({ home }).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), foreign);
  assert.equal(McpInstall.uninstall({ home }).changed, false);
});

test('mcp-install: creates the file when missing; never clobbers an unparsable file or a foreign same-named server', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mcp-home-'));
  McpInstall.install({ home, entry });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')), { mcpServers: { 'claude-buddy': entry } });

  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mcp-home-'));
  fs.writeFileSync(path.join(bad, '.claude.json'), '{"oops":');
  assert.throws(() => McpInstall.install({ home: bad, entry }));
  assert.equal(fs.readFileSync(path.join(bad, '.claude.json'), 'utf8'), '{"oops":');
  assert.match(McpInstall.status({ home: bad, entry }).error, /JSON/);

  const taken = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mcp-home-'));
  const theirs = { mcpServers: { 'claude-buddy': { command: 'someone-else' } } };
  fs.writeFileSync(path.join(taken, '.claude.json'), JSON.stringify(theirs));
  assert.throws(() => McpInstall.install({ home: taken, entry }), /isn't Claude Buddy's/);
  assert.equal(McpInstall.uninstall({ home: taken }).changed, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(taken, '.claude.json'), 'utf8')), theirs);
});
