'use strict';
// Step 3 follow-ups from the PR #34 security re-review (pr34-rereview-2.md L1, L3, L4, L5):
// - L1: owners.json is the person's own file, so it can be stuffed: the load keeps at most 200 pins, the dead-process
//   checks run in the background (never inside a roster build), and a full table evicts its oldest pin, never all.
// - L3: a claude-buddy registration this copy wrote before --disable-sigusr1 is rewritten with it; anything else is not.
// - L4: a dev launch adds --disable-sigusr1 only on a node that has it; without it nothing binds, and Health says why.
// - L5: the npm test scripts bound every test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const McpAuto = require('../src/mcp-auto.js');
const McpInstall = require('../mcp-install.js');
const Health = require('../src/health.js');
const Fake = require('./helpers/fake-codex.js');
const { testTempDir } = require('./helpers/tmp');
const { world, START } = require('./helpers/bind-world.js');

const until = async (f, ms = 5000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };

test('L1: 2000 live pins in owners.json: the roster build does not wait on them, at most 200 are kept, and the oldest go first', async (t) => {
  const w = world(t);
  const file = path.join(w.root, 'awareness', 'owners.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const junk = Array.from({ length: 2000 }, (_, i) => { w.proc(10000 + i, {}); return [`claude|junk${i}`, 10000 + i, START]; });
  fs.writeFileSync(file, JSON.stringify({ v: 1, owners: junk }), { mode: 0o600 });
  // Each start-time check of a stuffed pin takes 5 ms, as a real ps does at best.
  let pinChecks = 0;
  const slow = (f, args, opts, cb) => {
    const pid = Number(args[args.indexOf('-p') + 1]);
    if (f === '/bin/ps' && args.includes('lstart=') && pid >= 10000) { pinChecks += 1; return setTimeout(() => w.exec(f, args, opts, cb), 5); }
    return w.exec(f, args, opts, cb);
  };
  const aw = w.make({ execFile: slow });
  const t0 = Date.now();
  const roster = await aw.build();
  const took = Date.now() - t0;
  assert.equal(roster.self['claude|X'].verified, true);
  assert.ok(took < 2000, `the build took ${took} ms behind the pin checks`);
  // X and T were pinned on top of the newest 200: the two oldest of those went, nothing else.
  assert.ok(await until(() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).owners.some((e) => e[0] === `codex|${w.T}`); } catch { return false; } }), 'saved');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).owners.map((e) => e[0]);
  assert.equal(saved.length, 200);
  assert.ok(saved.includes('claude|X') && saved.includes(`codex|${w.T}`));
  assert.ok(!saved.includes('claude|junk0') && !saved.includes('claude|junk1799'), 'beyond the newest 200: never loaded');
  assert.ok(!saved.includes('claude|junk1800') && !saved.includes('claude|junk1801'), 'the oldest evicted');
  assert.ok(saved.includes('claude|junk1802') && saved.includes('claude|junk1999'), 'and only those');
  // The background check covers only what was kept.
  assert.ok(await until(() => pinChecks >= 198), String(pinChecks));
  assert.ok(pinChecks <= 200, `${pinChecks} pin checks`);
  // A full table still refuses a rewritten file for a pinned live session (the pin was not cleared).
  const other = w.proc(700, { exe: w.CLAUDE, cwd: w.repoA, signed: 'claude', args: 'claude' });
  const kid = w.mcpChild(701, 700, w.repoA, w.procs.get(101));
  kid.env = kid.env.replace('CLAUDE_PID=100', 'CLAUDE_PID=700');
  w.stdio(kid, other, 'unix');
  w.state.sessions = [w.claudeSession('X', { claudePid: 700 }), w.codexSession()];
  assert.equal((await aw.bindCaller(w.call(701))).reason, 'OWNER');
});

test('L1: dead pins are dropped in the background, in batches', async (t) => {
  const w = world(t);
  const file = path.join(w.root, 'awareness', 'owners.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // 50 pins whose processes are gone.
  fs.writeFileSync(file, JSON.stringify({ v: 1, owners: Array.from({ length: 50 }, (_, i) => [`claude|gone${i}`, 20000 + i, START]) }), { mode: 0o600 });
  let inFlight = 0;
  let peak = 0;
  const counting = (f, args, opts, cb) => {
    const pid = Number(args[args.indexOf('-p') + 1]);
    if (f === '/bin/ps' && pid >= 20000) { inFlight += 1; peak = Math.max(peak, inFlight); return setTimeout(() => w.exec(f, args, opts, (...r) => { inFlight -= 1; cb(...r); }), 2); }
    return w.exec(f, args, opts, cb);
  };
  await w.make({ execFile: counting }).build();
  assert.ok(await until(() => !fs.readFileSync(file, 'utf8').includes('gone')), 'dropped');
  assert.ok(peak <= 10, `${peak} checks at once`);
});

const PACKAGED = { packaged: true, execPath: '/Applications/Plexiform.app/Contents/MacOS/Plexiform', appPath: '/Applications/Plexiform.app/Contents/Resources/app.asar', dir: '/repo' };
function mcpWorld(t, config = { agentAwareness: { enabled: true }, agentBus: { enabled: true } }) {
  const dir = testTempDir('pf-l3-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const root = path.join(home, '.claude-traffic-light');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const bin = Fake.write(path.join(dir, 'bin'));
  const state = { config };
  const make = (launch = PACKAGED) => McpAuto.create({ rootDir: root, home, config: () => state.config, launch, codexBin: () => bin, codexEnv: { PATH: '/usr/bin:/bin', CODEX_HOME: codexHome }, trustCodexBin: async (b) => b });
  const claudeJson = () => JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  return { home, root, codexHome, state, make, claudeJson };
}
const withoutFlag = (e) => ({ ...e, args: e.args.filter((a) => a !== '--disable-sigusr1') });

test('L3: Plexiform\'s own claude-buddy from before --disable-sigusr1 is rewritten with it; the person\'s other servers and keys are untouched', async (t) => {
  const w = mcpWorld(t);
  const old = withoutFlag(McpInstall.launch(PACKAGED));
  const mine = { type: 'stdio', command: 'npx', args: ['-y', 'my-own-server'] };
  fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify({ numStartups: 9, projects: { '/x': { a: 1 } }, mcpServers: { 'my-own': mine, 'claude-buddy': old } }, null, 2));
  const s = await w.make().sync();
  assert.equal(s.claude.state, 'full');
  const after = w.claudeJson();
  assert.deepEqual(after.mcpServers['claude-buddy'], McpInstall.launch(PACKAGED));
  assert.equal(after.mcpServers['claude-buddy'].args[0], '--disable-sigusr1');
  assert.deepEqual(after.mcpServers['my-own'], mine);
  assert.equal(after.numStartups, 9);
  assert.deepEqual(after.projects, { '/x': { a: 1 } });
  assert.ok(!('plexiform-bus' in after.mcpServers), 'the full server carries the bus tools');
});

test('L3: a claude-buddy that is not exactly this copy\'s old entry (edited, another copy, or turned off) is left alone', async (t) => {
  for (const [label, entry, config] of [
    ['edited', { ...withoutFlag(McpInstall.launch(PACKAGED)), args: [`${PACKAGED.appPath}/mcp-server.js`, '--verbose'] }, undefined],
    ['another copy', withoutFlag(McpInstall.launch({ ...PACKAGED, execPath: '/Applications/Plexiform Beta.app/Contents/MacOS/Plexiform', appPath: '/Applications/Plexiform Beta.app/Contents/Resources/app.asar' })), undefined],
    ['extra env', { ...withoutFlag(McpInstall.launch(PACKAGED)), env: { ELECTRON_RUN_AS_NODE: '1', DEBUG: '1' } }, undefined],
    ['mcpUserOff', withoutFlag(McpInstall.launch(PACKAGED)), { agentAwareness: { enabled: true }, mcpUserOff: true }],
  ]) {
    const w = mcpWorld(t, config);
    fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify({ mcpServers: { 'claude-buddy': entry } }));
    await w.make().sync();
    assert.deepEqual(w.claudeJson().mcpServers['claude-buddy'], entry, label);
  }
});

test('L3: a recorded plexiform-bus without the flag is re-pointed in Claude Code and in Codex', async (t) => {
  const w = mcpWorld(t);
  const want = McpInstall.launch({ ...PACKAGED, profile: 'bus' });
  const old = withoutFlag(want);
  fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify({ mcpServers: { 'plexiform-bus': old } }));
  fs.writeFileSync(path.join(w.codexHome, 'fake-mcp.json'), JSON.stringify({ 'plexiform-bus': { command: old.command, args: old.args, env: old.env } }));
  fs.mkdirSync(w.root, { recursive: true });
  fs.writeFileSync(path.join(w.root, 'mcp-auto.json'), JSON.stringify({ claude: { name: 'plexiform-bus', added_at: 'x', entry_hash: '0'.repeat(16) }, codex: { name: 'plexiform-bus', added_at: 'x', entry_hash: '0'.repeat(16) } }));
  const s = await w.make().sync();
  assert.deepEqual([s.claude.state, s.codex.state], ['ours', 'ours']);
  assert.deepEqual(w.claudeJson().mcpServers['plexiform-bus'], want);
  assert.deepEqual(Fake.servers(w.codexHome)['plexiform-bus'].args, want.args);
});

test('L4: a dev launch adds --disable-sigusr1 only on a node that has it (22.14+, 23.7+); the packaged app always', () => {
  for (const [v, ok] of [['v22.13.1', false], ['v22.14.0', true], ['v22.23.2', true], ['v23.6.0', false], ['v23.7.0', true], ['v24.0.0', true], ['v20.19.0', false], ['v18.20.0', false], ['unknown', false], [null, false], ['', false]]) {
    assert.equal(McpInstall.nodeHasFlags(v), ok, String(v));
    const l = McpInstall.launch({ packaged: false, dir: '/repo', profile: 'bus', nodeVersion: v });
    assert.equal(l.args.includes('--disable-sigusr1'), ok, String(v));
    assert.deepEqual(l.args.slice(-3), ['/repo/mcp-server.js', '--profile', 'bus'], 'the server still starts');
  }
  assert.equal(McpInstall.launch({ ...PACKAGED, nodeVersion: 'v18.0.0' }).args[0], '--disable-sigusr1', 'Electron\'s own node');
});

test('L4: fail closed: a registered launch without --disable-sigusr1 never binds a caller, even when the command line matches exactly', async (t) => {
  const w = world(t);
  const kid = w.procs.get(201);
  kid.args = kid.args.replace(' --disable-sigusr1', '');
  const flagless = [{ command: w.procs.get(201).exe, args: kid.args.split(' ').slice(1) }];
  const aw = w.make({ servers: () => flagless });
  assert.equal((await aw.bindCaller({ ...w.call(201), threadId: w.T })).reason, 'NOT_OUR_SERVER');
});

test('L4: Health says why when the dev node is too old (and nothing for the packaged app or before the version is known)', () => {
  const row = (mcpNode) => Health.runChecks({ mcpNode }).checks.find((c) => c.id === 'mcp-node');
  const old = row({ version: 'v20.11.0', flags: false });
  assert.equal(old.status, 'warn');
  assert.match(old.detail, /node v20\.11\.0 is older than 22\.14/);
  assert.match(old.detail, /no particular session/);
  assert.match(old.next, /Node 22\.14 or later/);
  assert.match(row({ version: 'unknown', flags: false }).detail, /^The node on your PATH/);
  assert.equal(row({ version: 'v22.14.0', flags: true }), undefined);
  assert.equal(row({ version: null, flags: false }), undefined);
  assert.equal(row(null), undefined);
});

test('L5: every node --test in the npm test scripts has a --test-timeout', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['package.json', 'remote/package.json']) {
    const script = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')).scripts.test;
    const runs = script.split('&&').map((s) => s.trim()).filter((s) => s.startsWith('node --test'));
    assert.ok(runs.length > 0, f);
    // Node applies it to each test file's whole run too, and the slowest files take 40-50 s alone (more under the
    // full suite's load): 5 minutes bounds a hang without cutting a slow file off.
    for (const r of runs) assert.ok(Number((/--test-timeout=(\d+)/.exec(r) || [])[1]) >= 120000, `${f}: ${r}`);
  }
});

test('L5 (PR #35 review): keys the person added to the old claude-buddy (timeout, alwaysAllow) survive the rewrite; only args change', async (t) => {
  const w = mcpWorld(t);
  const old = { ...withoutFlag(McpInstall.launch(PACKAGED)), timeout: 30000, alwaysAllow: ['buddy_sessions'] };
  fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify({ mcpServers: { 'claude-buddy': old } }, null, 2));
  await w.make().sync();
  assert.deepEqual(w.claudeJson().mcpServers['claude-buddy'], { ...old, args: McpInstall.launch(PACKAGED).args });
});

test('L5 (PR #35 review): the old-entry check is made on what the atomic edit read, so an edit landing after the first look is kept', async (t) => {
  const w = mcpWorld(t);
  const file = path.join(w.home, '.claude.json');
  const old = withoutFlag(McpInstall.launch(PACKAGED));
  const edited = { ...old, args: [...old.args, '--verbose'] };
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'claude-buddy': old } }, null, 2));
  // The person's edit lands right after Plexiform first reads the file.
  let once = false;
  const racing = { ...McpInstall, status(o) { const r = McpInstall.status(o); if (!once) { once = true; fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'claude-buddy': edited } }, null, 2)); } return r; } };
  const auto = McpAuto.create({ rootDir: w.root, home: w.home, config: () => w.state.config, launch: PACKAGED, mcpInstall: racing, codexBin: () => null, codexEnv: { PATH: '/usr/bin:/bin', CODEX_HOME: w.codexHome }, trustCodexBin: async (b) => b });
  await auto.sync();
  assert.deepEqual(w.claudeJson().mcpServers['claude-buddy'], edited);
});
