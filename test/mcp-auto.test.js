'use strict';
// src/mcp-auto.js (plan-agent-awareness §3.9, AW6, AW15): the bus-only profile
// registered for Claude Code (~/.claude.json) and Codex (`codex mcp add`, a
// fake CLI here), marked, recorded, reversible, never over a foreign entry,
// and never re-added after Undo. Scratch homes only: nothing here touches the
// person's own ~/.claude.json or ~/.codex.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const McpAuto = require('../src/mcp-auto.js');
const McpInstall = require('../mcp-install.js');
const Codex = require('../adapters/codex.js');
const Fake = require('./helpers/fake-codex.js');
const { testTempDir } = require('./helpers/tmp');

const PACKAGED = { packaged: true, execPath: '/Applications/Plexiform.app/Contents/MacOS/Plexiform', appPath: '/Applications/Plexiform.app/Contents/Resources/app.asar', dir: '/repo' };
const DEV = { packaged: false, execPath: '/x/electron', appPath: '/repo', dir: '/repo' };
const ON = { agentAwareness: { enabled: true }, agentBus: { enabled: true }, mcpBusUserOff: false };

function world(t, { launch = PACKAGED, config = ON, codex = true, mode = '' } = {}) {
  const dir = testTempDir('pf-mcpauto-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const root = path.join(home, '.claude-traffic-light');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const bin = Fake.write(path.join(dir, 'bin'));
  const state = { config: { ...config } };
  const logs = [];
  const make = (o = {}) => McpAuto.create({ rootDir: root, home, config: () => state.config, launch: o.launch || launch, platform: 'darwin', codexBin: () => (codex ? bin : null),
    codexEnv: { PATH: '/usr/bin:/bin', CODEX_HOME: codexHome, FAKE_CODEX_MODE: o.mode ?? mode }, log: (m) => logs.push(m),
    // The fake CLI stands in for OpenAI's signed codex; the real check (trustedCodex) has its own test below.
    ...(o.realTrust ? {} : { trustCodexBin: async (b) => b }), ...(o.extra || {}) });
  const claudeJson = () => { try { return JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')); } catch { return null; } };
  const record = () => JSON.parse(fs.readFileSync(path.join(root, 'mcp-auto.json'), 'utf8'));
  return { dir, home, root, codexHome, bin, state, logs, make, claudeJson, record, codexServers: () => Fake.servers(codexHome), codexCalls: () => Fake.calls(codexHome) };
}

test('AW6: a fresh home gets plexiform-bus in Claude Code and Codex, the bus_session hook, a record and a one-time notice; running again changes nothing', async (t) => {
  const w = world(t);
  const auto = w.make();
  const s = await auto.sync();
  assert.deepEqual([s.claude.state, s.codex.state, s.codexHook.state], ['ours', 'ours', 'needs-approval']);
  const entry = w.claudeJson().mcpServers['plexiform-bus'];
  assert.deepEqual(entry, McpInstall.launch({ ...PACKAGED, profile: 'bus' }));
  assert.equal(entry.env.PLEXIFORM_MCP, 'bus-v1:packaged');
  assert.deepEqual(entry.args.slice(-2), ['--profile', 'bus']);
  assert.ok(!('claude-buddy' in w.claudeJson().mcpServers), 'never the full server');
  const codex = w.codexServers()['plexiform-bus'];
  assert.deepEqual(codex, { command: entry.command, args: entry.args, env: entry.env }, '`codex mcp get` shows the same profile');
  assert.deepEqual(w.codexCalls().map((c) => c[1]), ['get', 'add', 'get'], 'Codex writes are read back');
  assert.ok(Codex.isBusHookInstalled({ home: w.home }));
  const rec = w.record();
  assert.equal(rec.claude.name, 'plexiform-bus');
  assert.equal(rec.codex.name, 'plexiform-bus');
  assert.match(rec.claude.entry_hash, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(rec).includes('numStartups') && !JSON.stringify(rec).includes('mcpServers'), 'never a copy of either config');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(w.root, 'mcp-auto.json')).mode & 0o777, 0o600);
  assert.deepEqual(auto.notices().map((n) => [n.handle, n.action]), [['bus-added', 'undo'], ['bus-codex-hook', 'dismiss']]);
  assert.match(auto.notices()[0].title, /Claude Code and Codex/);
  assert.match(auto.notices()[0].meta, /Codex asks you before each bus_handoff/);
  assert.equal(auto.notices()[1].title, "Approve Plexiform's Codex hook in Codex (/hooks)");
  assert.deepEqual(auto.caps(), { claude: true, codex: true });
  // Again: no writes anywhere.
  const before = fs.statSync(path.join(w.home, '.claude.json')).mtimeMs;
  const hooks = fs.readFileSync(path.join(w.codexHome, 'hooks.json'), 'utf8');
  const again = await w.make().sync();
  assert.deepEqual([again.claude.changed, again.codex.changed, again.codexHook.changed], [false, false, false]);
  assert.equal(fs.statSync(path.join(w.home, '.claude.json')).mtimeMs, before);
  assert.equal(fs.readFileSync(path.join(w.codexHome, 'hooks.json'), 'utf8'), hooks);
  assert.deepEqual(w.codexCalls().slice(3).map((c) => c[1]), ['get'], 'only a read the second time');
  // Plexiform never writes Codex hook trust.
  assert.ok(!/trusted_hash/.test(hooks));
});

test('the bus_session hook is a separate SessionStart group; the lifecycle handlers keep their bytes and their places', async (t) => {
  const w = world(t);
  const Runtime = require('../adapters/runtime.js');
  const rt = Runtime.make({ execPath: PACKAGED.execPath, platform: 'darwin', dataDir: w.root, hooksDir: '/Applications/Plexiform.app/Contents/Resources/hooks' });
  const lifecycle = JSON.parse(JSON.stringify(Codex.applyActivity({}, rt)));
  fs.writeFileSync(path.join(w.codexHome, 'hooks.json'), JSON.stringify(lifecycle, null, 2));
  await w.make().sync();
  const after = JSON.parse(fs.readFileSync(path.join(w.codexHome, 'hooks.json'), 'utf8'));
  for (const ev of Codex.LIFECYCLE_EVENTS) assert.deepEqual(after.hooks[ev][0], lifecycle.hooks[ev][0], ev);
  assert.deepEqual(after.hooks.SessionStart[1], { hooks: [{ type: 'mcp_tool', server: 'plexiform-bus', tool: 'bus_session', input: {}, timeout: 5 }] });
  assert.ok(Codex.checkActivity(after, rt), 'the lifecycle install still checks out');
  // Uninstalling activity leaves the bus hook alone, and the reverse (ours is the last SessionStart group here).
  assert.equal(Codex.uninstallBusHook({ home: w.home }).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.codexHome, 'hooks.json'), 'utf8')), lifecycle);
});

test('skipped for Claude when Plexiform\'s full server is registered (it has the bus tools); a recorded plexiform-bus is then removed', async (t) => {
  const w = world(t);
  await w.make().sync();
  McpInstall.install({ home: w.home, entry: McpInstall.launch(PACKAGED) });
  const s = await w.make().sync();
  assert.equal(s.claude.state, 'full');
  assert.deepEqual(Object.keys(w.claudeJson().mcpServers), [McpInstall.NAME]);
  assert.equal(w.record().claude, null);
  assert.equal(s.codex.state, 'ours', 'Codex still gets the bus profile');
});

test('AW6: a foreign plexiform-bus (no marker) is reported and never touched, in Claude Code and in Codex', async (t) => {
  const w = world(t);
  const foreign = { type: 'stdio', command: 'npx', args: ['-y', 'someone-elses-bus'] };
  fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify({ numStartups: 4, mcpServers: { 'plexiform-bus': foreign } }));
  fs.writeFileSync(path.join(w.codexHome, 'fake-mcp.json'), JSON.stringify({ 'plexiform-bus': { command: 'npx', args: ['x'], env: {} } }));
  const auto = w.make();
  const s = await auto.sync();
  assert.deepEqual([s.claude.state, s.codex.state, s.codexHook.state], ['foreign', 'foreign', 'off']);
  assert.deepEqual(w.claudeJson(), { numStartups: 4, mcpServers: { 'plexiform-bus': foreign } });
  assert.deepEqual(w.codexServers()['plexiform-bus'], { command: 'npx', args: ['x'], env: {} });
  assert.ok(!w.codexCalls().some((c) => c[1] === 'add' || c[1] === 'remove'));
  assert.ok(!fs.existsSync(path.join(w.codexHome, 'hooks.json')), 'no hook for a server that is not ours');
  assert.deepEqual(auto.notices(), [], 'nothing was added, so nothing to undo');
  assert.deepEqual(auto.caps(), { claude: false, codex: false });
  // Turning everything off leaves them alone too.
  w.state.config = { ...ON, mcpBusUserOff: true };
  await w.make().sync();
  assert.deepEqual(w.claudeJson().mcpServers['plexiform-bus'], foreign);
  assert.ok(w.codexServers()['plexiform-bus']);
});

test('AW15: Undo persists the opt-out, removes what was added, and nothing re-adds it', async (t) => {
  const w = world(t);
  const auto = w.make();
  await auto.sync();
  assert.ok(!(McpInstall.NAME in w.claudeJson().mcpServers), 'the full server is never added');
  let undone = 0;
  const r = await auto.act('bus-added', 'undo', { undo: async () => { undone += 1; w.state.config = { ...w.state.config, mcpBusUserOff: true }; } });
  assert.equal(r.ok, true);
  assert.equal(undone, 1);
  assert.equal(McpAuto.effective(w.state.config), false);
  await auto.sync();
  assert.ok(!('plexiform-bus' in w.claudeJson().mcpServers));
  assert.ok(!('plexiform-bus' in w.codexServers()));
  assert.ok(!Codex.isBusHookInstalled({ home: w.home }));
  assert.deepEqual(auto.notices(), []);
  // Later starts never bring it back.
  for (let i = 0; i < 2; i += 1) await w.make().sync();
  assert.ok(!('plexiform-bus' in w.claudeJson().mcpServers));
  assert.ok(!w.codexCalls().slice(-2).some((c) => c[1] === 'add'));
  // A card that is gone is refused.
  assert.equal((await auto.act('bus-added', 'undo', {})).ok, true, 'Undo twice is harmless');
  assert.equal((await auto.act('nope', 'undo', {})).ok, false);
});

test('AW6: with both switches off, only recorded entries that still carry the marker are removed', async (t) => {
  const w = world(t);
  await w.make().sync();
  // Someone replaced the Claude entry with their own server of the same name.
  const cj = w.claudeJson();
  cj.mcpServers['plexiform-bus'] = { type: 'stdio', command: 'mine', args: [] };
  fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify(cj));
  w.state.config = { agentAwareness: { enabled: false }, agentBus: { enabled: false }, mcpBusUserOff: false };
  const s = await w.make().sync();
  assert.equal(s.claude.state, 'off');
  assert.deepEqual(w.claudeJson().mcpServers['plexiform-bus'], { type: 'stdio', command: 'mine', args: [] }, 'not ours any more: kept');
  assert.ok(!('plexiform-bus' in w.codexServers()), 'still ours: removed');
  assert.equal(w.record().claude, null);
  assert.equal(w.record().codex, null);
  // One switch on is enough to add it back.
  w.state.config = { agentAwareness: { enabled: true }, agentBus: { enabled: false } };
  assert.equal(McpAuto.effective(w.state.config), true);
});

test('dev and packaged builds never re-point each other\'s entry', async (t) => {
  const w = world(t);
  await w.make().sync();
  const packaged = w.claudeJson().mcpServers['plexiform-bus'];
  const s = await w.make({ launch: DEV }).sync();
  assert.deepEqual([s.claude.state, s.codex.state], ['other-channel', 'other-channel']);
  assert.deepEqual(w.claudeJson().mcpServers['plexiform-bus'], packaged);
  assert.equal(w.codexServers()['plexiform-bus'].env.PLEXIFORM_MCP, 'bus-v1:packaged');
  // And back: the packaged app finds its own entry unchanged.
  const p = await w.make().sync();
  assert.deepEqual([p.claude.changed, p.codex.changed], [false, false]);
});

test('Codex: missing binary, a re-read mismatch and a failing CLI are reported; Claude Code is registered regardless', async (t) => {
  const w = world(t, { codex: false });
  const auto = w.make();
  const s = await auto.sync();
  assert.deepEqual([s.claude.state, s.codex.state], ['ours', 'missing']);
  assert.match(auto.notices()[0].title, /to Claude Code$/, 'the notice names only what was added');
  const w2 = world(t, { mode: 'drop' });
  assert.equal((await w2.make().sync()).codex.state, 'mismatch');
  assert.equal(w2.record().codex, undefined, 'nothing recorded for an entry Codex did not keep');
  const w3 = world(t, { mode: 'fail' });
  assert.deepEqual((await w3.make().sync()).codex, { state: 'error', error: 'failed' });
});

test('the Codex hook notice goes once a Codex session binds through bus_session, or when dismissed', async (t) => {
  const w = world(t);
  const auto = w.make();
  await auto.sync();
  assert.ok(auto.notices().some((n) => n.handle === 'bus-codex-hook'));
  await auto.codexHookSeen();
  assert.ok(!auto.notices().some((n) => n.handle === 'bus-codex-hook'));
  assert.equal(auto.status().codexHook.state, 'approved');
  assert.equal((await w.make().sync()).codexHook.state, 'approved', 'remembered across starts');
  const w2 = world(t);
  const a2 = w2.make();
  await a2.sync();
  assert.equal((await a2.act('bus-codex-hook', 'dismiss')).ok, true);
  assert.ok(!a2.notices().some((n) => n.handle === 'bus-codex-hook'));
});

test('an unreadable ~/.claude.json is never written', async (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.home, '.claude.json'), '{ not json');
  const s = await w.make().sync();
  assert.equal(s.claude.state, 'error');
  assert.equal(fs.readFileSync(path.join(w.home, '.claude.json'), 'utf8'), '{ not json');
});

test('main wires it once per start after ready, deferred, and only the installed app (or a dev sandbox) registers', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /const MCP_AUTO_ON = \(app\.isPackaged && AUTO_INSTALL_HOOKS\) \|\| IS_DEV_RUN;/);
  assert.match(main, /app\.whenReady\(\)\.then\(\(\) => \{ const t = setTimeout\(\(\) => \{ registerBusTools\(\)/);
  assert.match(main, /codexEnv: IS_DEV_RUN \? \{ \.\.\.process\.env, CODEX_HOME: path\.join\(MCP_AUTO_HOME, '\.codex'\) \}/);
  // The AI tools page remembers the full server's switch now.
  assert.match(main, /saveConfig\(\{ mcpUserOff: !on \}\)/);
  // src/mcp-auto.js itself does only async fs; its sync writes are mcp-install.js and the Codex adapter's.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-auto.js'), 'utf8');
  assert.ok(!/\b[a-zA-Z]+Sync\s*\(/.test(src));
});

// ── PR #34 security review regressions ──────────────────────────────────────

test('review #5: turning Plexiform\'s Claude integration off (mcpUserOff) keeps plexiform-bus out of Claude Code too, and takes a recorded one out', async (t) => {
  const w = world(t, { config: { ...ON, mcpUserOff: true } });
  const s = await w.make().sync();
  assert.equal(s.claude.state, 'off');
  assert.ok(!w.claudeJson() || !('plexiform-bus' in (w.claudeJson().mcpServers || {})), 'nothing written to ~/.claude.json');
  assert.equal(s.codex.state, 'ours', 'Codex is not covered by the Claude opt-out');
  assert.equal(McpAuto.claudeOn(w.state.config), false);
  // Opting out after it was added removes ours in the same sync.
  const w2 = world(t);
  await w2.make().sync();
  assert.ok('plexiform-bus' in w2.claudeJson().mcpServers);
  w2.state.config = { ...ON, mcpUserOff: true };
  const s2 = await w2.make().sync();
  assert.equal(s2.claude.state, 'off');
  assert.ok(!('plexiform-bus' in w2.claudeJson().mcpServers));
  assert.equal(w2.record().claude, null);
  const a2 = w2.make();
  await a2.sync();
  assert.deepEqual(a2.caps(), { claude: false, codex: true });
});

test('review #4: Undo, off and uninstall never move a SessionStart group: our bus hook goes only while it is the last one', async (t) => {
  const w = world(t);
  await w.make().sync();
  const file = path.join(w.codexHome, 'hooks.json');
  // The person adds a hook after ours (or applyActivity re-appends the lifecycle group after an app move).
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const theirs = { hooks: [{ type: 'command', command: '/usr/local/bin/my-start-hook', timeout: 5 }] };
  cfg.hooks.SessionStart.push(theirs);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  const before = fs.readFileSync(file, 'utf8');
  const idx = (c) => c.hooks.SessionStart.findIndex((g) => g.hooks[0].command === '/usr/local/bin/my-start-hook');
  const r = Codex.uninstallBusHook({ home: w.home });
  assert.deepEqual([r.ok, r.changed, r.kept], [true, false, true]);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing written: their hook keeps its index, so Codex keeps its approval');
  // Off: kept, recorded as kept, and Home says what to do.
  w.state.config = { ...ON, mcpBusUserOff: true };
  const auto = w.make();
  await auto.sync();
  assert.equal(idx(JSON.parse(fs.readFileSync(file, 'utf8'))), idx(cfg));
  assert.equal(w.record().codexHook.kept, true);
  assert.deepEqual(auto.notices().map((n) => n.handle), ['bus-codex-hook-kept']);
  assert.equal((await auto.act('bus-codex-hook-kept', 'dismiss')).ok, true);
  assert.deepEqual(auto.notices(), []);
  // Install with ours already present somewhere: never stripped and re-appended.
  assert.equal(Codex.installBusHook({ home: w.home }).changed, false);
  assert.equal(idx(JSON.parse(fs.readFileSync(file, 'utf8'))), idx(cfg));
  // Uninstall-all reports it as left in place, not removed.
  const UninstallAll = require('../adapters/uninstall-all.js');
  const res = UninstallAll.run({ home: w.home, mcp: null, codexBin: null }).find((x) => x.id === 'codex-bus-hook');
  assert.equal(res.changed, false);
  assert.match(res.kept, /lose their approval/);
  // Last again (their hook removed by the person): ours goes.
  const now = JSON.parse(fs.readFileSync(file, 'utf8'));
  now.hooks.SessionStart.pop();
  fs.writeFileSync(file, JSON.stringify(now, null, 2));
  assert.deepEqual((({ changed, kept }) => [changed, kept])(Codex.uninstallBusHook({ home: w.home })), [true, false]);
  assert.ok(!Codex.isBusHookInstalled({ home: w.home }));
});

test('review #11: main runs only OpenAI\'s signed codex; an unsigned codex in ~/.local/bin is never run', async (t) => {
  const w = world(t);
  const s = await w.make({ realTrust: true }).sync();
  assert.equal(s.codex.state, 'untrusted');
  assert.deepEqual(w.codexCalls(), [], 'the fake codex was never executed');
  assert.equal(s.claude.state, 'ours');
  // trustedCodex: ChatGPT.app's launcher script resolves to the binary beside it, and only a signed one passes.
  const root = path.join(w.dir, 'x', 'node_modules', '@openai', 'codex', 'codex-cli');
  const real = path.join(root, 'CodexCLI.app', 'Contents', 'MacOS', 'codex');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(real, 'binary', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'bin', 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  const realReal = fs.realpathSync(real);
  const asked = [];
  const run = async (file, args) => { asked.push([file, ...args]); if (args[args.length - 1] !== realReal) throw new Error('unsigned'); return ''; };
  const opts = { home: w.home, codexHome: w.codexHome, run, platform: 'darwin' };
  assert.equal(await McpAuto.trustedCodex(path.join(root, 'bin', 'codex'), opts), realReal);
  assert.deepEqual(asked[0].slice(0, 3), ['/usr/bin/codesign', '--verify', '--strict']);
  assert.match(asked[0][3], /^-R=identifier "codex" and anchor apple generic and certificate leaf\[subject\.OU\] = "2DC432GLL2"$/);
  assert.equal(await McpAuto.trustedCodex(path.join(root, 'bin', 'codex'), { ...opts, run: async () => { throw new Error('unsigned'); } }), null);
  assert.equal(await McpAuto.trustedCodex(w.bin, opts), null, 'not where codex installs');
  assert.equal(await McpAuto.trustedCodex(path.join(root, 'bin', 'codex'), { ...opts, platform: 'linux' }), null, 'no signature to check elsewhere: not run');
  // The real ChatGPT.app codex on this Mac, when there is one (codesign only; codex is never run).
  const app = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  if (process.platform === 'darwin' && fs.existsSync(app)) {
    const execRun = (file, args) => new Promise((resolve, reject) => require('node:child_process').execFile(file, args, (e, o) => (e ? reject(e) : resolve(o))));
    assert.equal(await McpAuto.trustedCodex(app, { home: w.home, codexHome: w.codexHome, run: execRun }), '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  }
});

test('review #12: Home actions and the hook-seen mark wait for a running sync, so neither loses the other\'s record change', async (t) => {
  const w = world(t);
  const { execFile } = require('node:child_process');
  const slow = (file, args, opts, cb) => setTimeout(() => execFile(file, args, opts, cb), 150);
  const auto = w.make({ extra: { execFile: slow } });
  const sync = auto.sync();
  await new Promise((r) => setTimeout(r, 40));
  const acted = auto.act('bus-codex-hook', 'dismiss');
  const seen = auto.codexHookSeen();
  await Promise.all([sync, acted, seen]);
  const rec = w.record();
  assert.equal(rec.codex && rec.codex.name, 'plexiform-bus', 'the sync\'s Codex entry is recorded');
  assert.equal(rec.hookNoticeDismissed, true, 'the dismissal is kept');
  assert.match(String(rec.codexHookSeenAt), /^\d{4}-/, 'the hook-seen mark is kept');
});

test('T1/9a: on a platform that cannot bind the caller nothing is added, no notice is offered, and the reason is UNSUPPORTED_PLATFORM', async (t) => {
  const w = world(t);
  for (const platform of ['linux', 'win32']) {
    const auto = w.make({ extra: { platform } });
    const s = await auto.sync();
    for (const k of ['claude', 'codex', 'codexHook']) {
      assert.equal(s[k].state, 'unsupported');
      assert.equal(s[k].reason, 'UNSUPPORTED_PLATFORM');
    }
    assert.match(s.claude.message, /only tell which AI session is calling on a Mac/);
    assert.equal(w.claudeJson(), null, 'no ~/.claude.json written');
    assert.deepEqual(w.codexServers(), {}, 'Codex untouched');
    assert.deepEqual(w.codexCalls(), []);
    assert.deepEqual(auto.notices(), [], 'no Inbox "added" item');
  }
});

test('9a: off macOS, turning the bus off or pressing Undo still removes what an earlier version added', async (t) => {
  const w = world(t);
  await w.make().sync(); // as an older build did on this machine
  assert.ok('plexiform-bus' in w.claudeJson().mcpServers);
  const lin = w.make({ extra: { platform: 'linux' } });
  assert.equal((await lin.sync()).claude.state, 'unsupported');
  assert.ok('plexiform-bus' in w.claudeJson().mcpServers, 'still on: the person has not turned it off');
  w.state.config = { ...w.state.config, mcpBusUserOff: true };
  const s = await lin.sync();
  assert.equal(s.claude.state, 'off');
  assert.ok(!('plexiform-bus' in w.claudeJson().mcpServers));
  assert.ok(!('plexiform-bus' in w.codexServers()));
  assert.ok(!Codex.isBusHookInstalled({ home: w.home }));
  // Undo
  const w2 = world(t);
  await w2.make().sync();
  const lin2 = w2.make({ extra: { platform: 'linux' } });
  await lin2.sync();
  const r = await lin2.act('bus-added', 'undo', { undo: async () => { w2.state.config = { ...w2.state.config, mcpBusUserOff: true }; } });
  assert.equal(r.ok, true);
  await lin2.sync();
  assert.ok(!('plexiform-bus' in w2.claudeJson().mcpServers));
  assert.deepEqual(lin2.notices(), []);
});

test('9a: off macOS the full server entry in ~/.claude.json is left byte-identical (no re-registration)', async (t) => {
  const w = world(t);
  const old = { ...McpInstall.launch(PACKAGED) };
  old.args = old.args.filter((a) => !McpInstall.NODE_FLAGS.includes(a));
  fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify({ mcpServers: { [McpInstall.NAME]: old } }, null, 2));
  const before = fs.readFileSync(path.join(w.home, '.claude.json'));
  await w.make({ extra: { platform: 'linux' } }).sync();
  assert.deepEqual(fs.readFileSync(path.join(w.home, '.claude.json')), before);
});

test('AW-S3: the Preferences switch off removes only what Plexiform added; on again re-adds it through the normal path, and a foreign same-named entry is never touched', async (t) => {
  const w = world(t);
  await w.make().sync();
  const cj = w.claudeJson();
  const foreign = { type: 'stdio', command: 'mine', args: [] };
  // Off by the switch (mcpBusUserOff true), both Claude Code and Codex lose their entries.
  w.state.config = { ...ON, mcpBusUserOff: true };
  await w.make().sync();
  assert.ok(!('plexiform-bus' in w.claudeJson().mcpServers));
  assert.ok(!('plexiform-bus' in w.codexServers()));
  // On again: re-added, nothing else in ~/.claude.json changed.
  w.state.config = { ...ON, mcpBusUserOff: false };
  const s = await w.make().sync();
  assert.deepEqual([s.claude.state, s.codex.state], ['ours', 'ours']);
  assert.deepEqual(w.claudeJson(), cj);
  assert.ok(w.codexServers()['plexiform-bus']);
  assert.equal(w.record().claude.name, 'plexiform-bus');
  // A user's own same-named entry survives the switch going off and on.
  const c2 = w.claudeJson();
  c2.mcpServers['plexiform-bus'] = foreign;
  fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify(c2));
  for (const off of [true, false]) { w.state.config = { ...ON, mcpBusUserOff: off }; await w.make().sync(); }
  assert.deepEqual(w.claudeJson().mcpServers['plexiform-bus'], foreign);
});
