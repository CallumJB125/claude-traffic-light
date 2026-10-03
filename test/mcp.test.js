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

test('buddy_status: an unusable local status response still returns observed disk state', async () => {
  const root = fixture({ config: base, sessions: { a: session('a') } });
  try {
    for (const live of [{}, { look: null }, { look: [] }]) {
      const status = await M.buddyStatus({ root, now: NOW, online: true, live });
      assert.equal(status.reason, 'session');
      assert.equal(status.sessionCount, 1);
      assert.equal(status.currentTool, 'Bash');
      assert.equal(status.look.lamp, 'green');
      assert.equal(status.app.running, false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('buddy_status: a pending permission request forces the ask when answering from the widget is on', async () => {
  const req = { id: 'h-a-1', sessionId: 'a', cwd: '/w/a', tool: 'Bash', summary: 'rm -rf x', createdAt: iso(2000) };
  const root = fixture({ config: { ...base, askFromWidget: true }, sessions: { a: session('a') }, requests: [req] });
  const st = await M.buddyStatus({ root, now: NOW, online: true, live: null });
  assert.equal(st.reason, 'pending-permission');
  assert.equal(st.look.lamp, 'red');
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

test('buddy_pending_requests lists waiting requests; nothing in the server can answer them', () => {
  const req = { id: 'h-a-1', sessionId: 'a', cwd: '/w/a', tool: 'Bash', summary: 'ls', createdAt: iso(5000) };
  const expired = { id: 'h-b-1', sessionId: 'b', cwd: '/w/b', tool: 'Bash', summary: 'ls', createdAt: iso(120000) };
  const root = fixture({ config: { askFromWidget: true }, requests: [req, expired] });
  const p = M.buddyPendingRequests({ root, now: NOW });
  assert.equal(p.askFromWidget, true);
  assert.deepEqual(p.requests.map((r) => r.id), ['h-a-1']);
  assert.equal(p.requests[0].answered, false);
  assert.equal(p.requests[0].ageMs, 5000);
  assert.equal(M.answerRequest, undefined);
  assert.ok(!M.TOOLS.some((t) => /answer/.test(t.name)));
  assert.deepEqual(fs.readdirSync(path.join(root, 'requests')).sort(), ['h-a-1.json', 'h-b-1.json']);
});

test('buddy_model_mix: reads transcripts from the given projects dir', async () => {
  const root = fixture({ config: base });
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mcp-projects-'));
  const r = await M.buddyModelMix({ root, now: NOW, projectsDir });
  assert.equal(r.transcripts.turns, 0);
  assert.deepEqual([r.week.turns, r.today.turns], [0, 0]);
  assert.match(r.recommendation, /No Opus turns/);
});

test('buddy_spend: today, this week and runaways from the transcripts, with the saved budgets', async () => {
  const root = fixture({ config: { ...base, spend: { dailyBudget: 50, mode: 'subscription' } } });
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mcp-projects-'));
  // Midday, so the 5 minutes can't straddle a day or week boundary.
  const now = new Date(2026, 8, 30, 12).getTime();
  const lines = [[5, 'claude-opus-5'], [3, 'claude-opus-5'], [2, 'claude-mystery-9']].map(([min, model], i) => JSON.stringify({
    type: 'assistant', sessionId: 'burn', cwd: '/w/hot', timestamp: new Date(now - min * 60000).toISOString(), requestId: `r${i}`,
    message: { id: `m${i}`, model, usage: { input_tokens: 0, output_tokens: 1000000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }));
  fs.mkdirSync(path.join(projectsDir, 'p'));
  fs.writeFileSync(path.join(projectsDir, 'p', 'burn.jsonl'), `${lines.join('\n')}\n`);
  const r = await M.buddySpend({ root, now, projectsDir });
  assert.equal(r.mode, 'subscription');
  assert.equal(r.today.spent, 50);
  assert.equal(r.level, 'exceeded');
  assert.equal(r.runaway.length, 1);
  assert.equal(r.runaway[0].burn, '$50.00 in 5 min');
  assert.match(r.summary, /^\$50\.00 today of a \$50\.00 budget \(100%\).*API-price equivalent.*Runaway: hot \$50\.00 in 5 min/);
  assert.deepEqual([r.unpriced.today, r.unpriced.week], [1, 1]);
  assert.match(r.summary, /1 turn this week unpriced/);
});

test('the server exposes exactly the eleven buddy_ tools, all read-only', () => {
  assert.deepEqual(M.TOOLS.map((t) => t.name), ['buddy_status', 'buddy_sessions', 'buddy_why', 'buddy_rules', 'buddy_recent_transitions', 'buddy_model_mix', 'buddy_git_status', 'buddy_spend', 'buddy_usage_history', 'buddy_health', 'buddy_pending_requests']);
  assert.deepEqual(M.TOOLS.filter((t) => t.readOnly === false).map((t) => t.name), []);
});

test('stdio: the server starts, lists eleven tools and answers buddy_status and buddy_health end to end', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const root = fixture({ config: base, sessions: { a: session('a', { updatedAt: new Date().toISOString() }) } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp-server.js')],
    // A port nothing listens on, so the real widget can't answer for the fixture.
    env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_TRAFFIC_LIGHT_HOME: root, CLAUDE_TRAFFIC_LIGHT_PORT: '1' },
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    // The same synthetic home on every host, without an installed Codex profile.
    const health = JSON.parse((await client.callTool({ name: 'buddy_health', arguments: {} })).content[0].text);
    assert.equal(health.checks.length, 8);
    assert.equal(health.checks.find((c) => c.id === 'signal').status, 'fail');
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
  assert.deepEqual(entry, { type: 'stdio', command: '/Applications/Claude Buddy.app/Contents/MacOS/Claude Buddy', args: [path.join('/Applications/Claude Buddy.app/Contents/Resources/app.asar', 'mcp-server.js')], env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.deepEqual(McpInstall.launch({ packaged: false, dir: '/repo', root: '/r' }), { type: 'stdio', command: 'node', args: [path.join('/repo', 'mcp-server.js')], env: { CLAUDE_TRAFFIC_LIGHT_HOME: '/r' } });
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
  assert.throws(() => McpInstall.install({ home: taken, entry }), /isn't Plexiform's/);
  assert.equal(McpInstall.uninstall({ home: taken }).changed, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(taken, '.claude.json'), 'utf8')), theirs);
});

test('buddy_usage_history answers from the permanent record, by range and group, with folder names only', async () => {
  const History = require('../usage-history.js');
  const root = fixture({ config: { ...base, spend: { mode: 'api' } } });
  const at = (t) => new Date(t).getTime();
  const turn = (id, ts, model, cwd, out) => ({ id, ts: at(ts), sessionId: 's', cwd, project: cwd.split('/').pop(), model, input: 0, output: out, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  const store = History.open({ root });
  History.record(store, [
    turn('a', '2026-08-10T10:00:00', 'claude-opus-5-5', '/Users/me/secret-client/alpha', 1e6),
    turn('b', '2026-08-20T10:00:00', 'claude-sonnet-5-5', '/Users/me/other/alpha', 1e6),
    turn('c', '2026-09-02T10:00:00', 'claude-opus-5-5', '/Users/me/secret-client/beta', 1e6),
    turn('d', '2026-08-11T10:00:00', 'mystery-9', '/Users/me/x/gamma', 1000),
  ]);
  History.flush(store);
  const now = at('2026-09-30T12:00:00');
  const aug = await M.buddyUsageHistory({ root, range: '2026-08', groupBy: 'family', now });
  assert.deepEqual(aug.range, { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(aug.rows.map((r) => [r.key, r.turns, r.cost]), [['opus', 1, 25], ['sonnet', 1, 10], ['unpriced', 1, 0]]);
  assert.match(aug.summary, /^\$35\.00 across 3 turns from 2026-08-01 to 2026-08-31\. 1 turn on unpriced models \(mystery-9\)/);
  const byProject = await M.buddyUsageHistory({ root, range: 'all', groupBy: 'project', now });
  assert.deepEqual(byProject.rows.map((r) => r.key).sort(), ['alpha', 'beta', 'gamma']);
  assert.equal(byProject.rows.find((r) => r.key === 'alpha').turns, 2, 'same folder name merges');
  assert.doesNotMatch(JSON.stringify(byProject), /\/Users\/me|secret-client/);
  assert.equal((await M.buddyUsageHistory({ root, range: '2026-09-01..2026-09-30', now })).total.turns, 1);
  await assert.rejects(M.buddyUsageHistory({ root, range: '2020-01-01..2026-09-30', now }), /between 1 and 400 days/);
  await assert.rejects(M.buddyUsageHistory({ root, range: 'last week', now }), /range is/);
  await assert.rejects(M.buddyUsageHistory({ root, groupBy: 'cwd', now }), /groupBy is/);
  const empty = await M.buddyUsageHistory({ root: fixture({ config: base }), now });
  assert.match(empty.summary, /Nothing is recorded yet/);
});

test('buddy_usage_history: "all" starts at the first recorded day and says when the cap cut it short; day maths survives DST', async () => {
  const History = require('../usage-history.js');
  const root = fixture({ config: base });
  const store = History.open({ root });
  const t = (id, iso) => ({ id, ts: new Date(iso).getTime(), sessionId: 's', cwd: '/w/a', project: 'a', model: 'claude-opus-5-5', input: 0, output: 1e5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  History.record(store, [t('a', '2026-08-01T10:00:00'), t('b', '2026-09-20T10:00:00')]);
  History.flush(store);
  const now = new Date('2026-09-30T12:00:00').getTime();
  const all = await M.buddyUsageHistory({ root, range: 'all', now });
  assert.equal(all.range.from, '2026-08-01', 'all starts where the record does');
  assert.doesNotMatch(all.summary, /last 400 days/);
  const old = History.open({ root: fixture({ config: base }) });
  History.record(old, [t('c', '2024-01-05T10:00:00'), t('d', '2026-09-20T10:00:00')]);
  History.flush(old);
  const capped = await M.buddyUsageHistory({ root: old.dir.replace(/[\\/]usage[\\/]daily$/, ''), range: 'all', now });
  assert.match(capped.summary, /the last 400 days/);
  assert.equal(capped.total.turns, 1, 'only what is inside the cap is counted');
  // 7d around a DST change: 7 calendar days, not 6 or 8
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['-e', `const M = require(${JSON.stringify(require.resolve('../mcp-server.js'))}); M.buddyUsageHistory({ root: ${JSON.stringify(root)}, range: '7d', now: new Date('2026-11-03T00:30:00').getTime() }).then((x) => console.log(JSON.stringify(x.range)));`], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { from: '2026-10-28', to: '2026-11-03' });
});

test('buddy_health: hooks from this copy, the app answering, MCP registered — all ok', async () => {
  const Claude = require('../adapters/claude-code.js');
  const root = fixture({ config: base, sessions: { a: session('a', { updatedAt: iso(90000) }) } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mcp-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-w-a'), { recursive: true });
  fs.writeFileSync(Claude.configPath(home), JSON.stringify(Claude.apply({}, M.hookRuntime(root), { home })));
  McpInstall.install({ home, entry: McpInstall.launch({ packaged: false, dir: path.join(__dirname, '..'), root: process.env.CLAUDE_TRAFFIC_LIGHT_HOME }) });
  const statfs = () => ({ bavail: 1e6, bsize: 1e6 });
  const h = await M.buddyHealth({ root, home, now: NOW, live: { look: {} }, statfs, mcpConnected: true });
  const by = (id) => h.checks.find((c) => c.id === id);
  assert.equal(h.ok, true, JSON.stringify(h.checks, null, 1));
  assert.equal(h.problems, 0);
  assert.equal(by('hooks').status, 'ok');
  assert.equal(by('last-hook').detail, '2 min ago.');
  assert.equal(by('signal').status, 'ok');
  assert.equal(by('mcp').detail, 'Registered, and this answer came through it.');
  assert.equal(by('version').detail, `Version ${require('../package.json').version}. Updates: not set up yet.`);
  assert.equal(h.likelyCause, undefined);
});

test('buddy_health: an app that moved, not running, no hook yet — each with its fix and a likely cause', async () => {
  const Claude = require('../adapters/claude-code.js');
  const Runtime = require('../adapters/runtime.js');
  const root = fixture({ config: base });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mcp-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const gone = Runtime.make({ execPath: '/Applications/Old Buddy.app/Contents/MacOS/Claude Buddy', hooksDir: '/Applications/Old Buddy.app/Contents/Resources/hooks', dataDir: root, platform: 'darwin' });
  fs.writeFileSync(Claude.configPath(home), JSON.stringify(Claude.apply({}, gone)));
  const h = await M.buddyHealth({ root, home, now: NOW, live: null, statfs: () => ({ bavail: 1e6, bsize: 1e6 }) });
  const by = (id) => h.checks.find((c) => c.id === id);
  assert.equal(h.ok, false);
  assert.equal(by('hooks').status, 'fail');
  assert.equal(by('hooks').fix, 'reinstall-hooks');
  assert.match(by('hooks').detail, /^Points at a copy of Buddy that was moved or deleted \(\/Applications\/#[0-9a-f]{6} #[0-9a-f]{6}\/Contents\/Resources\/hooks\/set-status\.js\)\.$/);
  assert.equal(by('signal').status, 'fail');
  assert.equal(by('mcp').fix, 'enable-mcp');
  assert.equal(by('last-hook').status, 'warn');
  assert.match(h.likelyCause, /^Hooks: Points at a copy of Buddy that was moved or deleted/);
  assert.match(h.note, /Nothing here is fixed for you/);
});

test('buddy_health: hookRuntime matches what main.js installs, packaged or not', () => {
  const data = path.resolve(path.sep, 'data');
  const source = path.resolve(path.sep, 'src', 'buddy');
  const resources = path.resolve(path.sep, 'A', 'Claude Buddy.app', 'Contents', 'Resources');
  const executable = path.resolve(path.sep, 'A', 'Claude Buddy.app', 'Contents', 'MacOS', 'Claude Buddy');
  const dev = M.hookRuntime(data, source);
  assert.equal(dev.node, true);
  assert.equal(dev.hooksDir, path.join(source, 'hooks'));
  const app = M.hookRuntime(data, path.join(resources, 'app.asar'), executable);
  assert.equal(app.execPath, executable);
  assert.equal(app.hooksDir, path.join(resources, 'hooks'));
  assert.equal(app.dataDir, data);
});

test('one character: status and why report the single global character, migrated from old per-rule bodies', async () => {
  const rules = [{ id: 'a', name: 'a', when: { signal: ['tool-use'] }, then: { lamp: 'green', body: 'octopus' } }];
  const root = fixture({ sessions: { s1: session('s1') }, config: { ...base, rules, rulesVersion: 10 } });
  const st = await M.buddyStatus({ root, now: NOW, online: true, live: null });
  assert.deepEqual(st.character, { body: 'octopus', bodyColor: null });
  assert.equal(st.look.body, 'octopus');
  assert.equal(st.channels.body, undefined);
  const why = M.buddyWhy({ root, now: NOW, online: true, query: 'body' });
  assert.equal(why.kind, 'character');
  assert.equal(why.value.body, 'octopus');
});
