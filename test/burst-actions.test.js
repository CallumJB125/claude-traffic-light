'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Actions = require('../src/burst-actions.js');
const View = require('../src/burst-view.js');
const Ipc = require('../src/burst-ipc.js');

const H = '/Users/test';
const co = { dir: '/Users/test/claude-burst', exists: true };

test('scripts: fixed commands per action (snapshot)', () => {
  const s = (k, mode) => Actions.buildScript(k, { home: H, mode, checkout: co }).body.split('\n').filter((l) => !l.startsWith('#!') && !l.startsWith('# ') && !/^(rc=|echo|\[\[|exit)/.test(l));
  assert.deepEqual(s('install', 'transparent'), ["cd '/Users/test/claude-burst' || exit 1", "CLAUDE_BURST_REPO='/Users/test/claude-burst' CLAUDE_BURST_MODE=transparent ./install.sh", '']);
  assert.deepEqual(s('enable'), ["'/Users/test/.local/bin/claude-burst' enable", '']);
  assert.deepEqual(s('off'), ['if [[ -x \'/Users/test/.local/bin/burst-off\' ]]; then \'/Users/test/.local/bin/burst-off\'; else echo "burst-off is not installed (Burst older than v0.11). See ROLLBACK.md in the Burst checkout."; fi', '']);
  assert.deepEqual(s('repair'), ["cd '/Users/test/claude-burst' || exit 1", "CLAUDE_BURST_REPO='/Users/test/claude-burst' ./scripts/repair.sh", '']);
  assert.deepEqual(s('uninstall'), ["cd '/Users/test/claude-burst' || exit 1", './install.sh uninstall', '']);
  assert.match(s('update', 'base-url').join('\n'), /git fetch --tags --quiet origin[\s\S]*CLAUDE_BURST_MODE=base-url CLAUDE_BURST_FORCE=1 \.\/install\.sh/);
});

test('first install clones into ~/claude-burst only when it is absent; no find ~ search', () => {
  const b = Actions.buildScript('install', { home: H, mode: 'base-url', checkout: { dir: co.dir, exists: false } }).body;
  assert.match(b, /git clone 'https:\/\/github.com\/andrewbakercloudscale\/claude-burst.git' '\/Users\/test\/claude-burst'/);
  assert.ok(!/find ~/.test(b));
  assert.ok(!/git clone/.test(Actions.buildScript('install', { home: H, checkout: co }).body));
});

test('no user string reaches a script: bad kind/mode throw, paths are quoted', () => {
  assert.throws(() => Actions.buildScript('rm -rf ~', { home: H, checkout: co }), { code: 'bad_kind' });
  assert.throws(() => Actions.buildScript('install', { home: H, mode: 'x; reboot', checkout: co }), { code: 'bad_mode' });
  const b = Actions.buildScript('install', { home: "/Users/o'brien", checkout: { dir: "/Users/o'brien/claude-burst", exists: true } }).body;
  assert.match(b, /'\/Users\/o'\\''brien\/claude-burst'/);
  assert.throws(() => Actions.buildScript('repair', { home: H, checkout: { dir: co.dir, exists: false } }), { code: 'no_checkout' });
});

test('runInTerminal writes an executable script and launches it via the stub, not a real Terminal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-scripts-'));
  const launched = [];
  const r = await Actions.runInTerminal('off', { home: H, dir, launch: async (f) => launched.push(f), checkout: co });
  assert.deepEqual(launched, [path.join(dir, 'burst-off.command')]);
  assert.equal(fs.statSync(r.file).mode & 0o777, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('consent text copies the README changes; transparent adds CA/hosts/pf; off has no terms', () => {
  const base = View.consent('install', { mode: 'base-url', command: 'x' });
  assert.match(base.changes.join(' '), /~\/.claude\/settings\.json[\s\S]*LaunchAgent/);
  assert.ok(!/trusted root CA/.test(base.changes.join(' ')));
  const tr = View.consent('install', { mode: 'transparent', command: 'x' });
  assert.match(tr.changes.join(' '), /\/etc\/hosts entry, a pf redirect and a trusted root CA \(name-constrained to api\.anthropic\.com, in the System keychain\)/);
  assert.match(tr.terms, /Consumer Terms prohibit account sharing/);
  assert.match(tr.undo, /burst-off[\s\S]*install\.sh uninstall/);
  assert.equal(View.consent('off', {}).terms, '');
  assert.equal(View.consent('bogus', {}), null);
});

const present = (over = {}, upgrade = null) => ({ kind: 'present', installed: true, capabilities: { upgradeStatus: true, testConnection: true }, upgrade, state: { version: '0.19.0', mode: 'base-url', active: true, route: 'PRIMARY', until: '', rejected: [], primaryFailures: 0, ...over } });

test('view: chip states and "Turn Burst off" in every on state', () => {
  assert.equal(View.statusView(present()).chip.label, 'Primary');
  assert.equal(View.statusView(present({ rejected: [{ model: 'm', until: '' }] })).chip.label, 'Limit near');
  assert.equal(View.statusView(present({ primaryFailures: 2 })).chip.label, 'Limit near');
  assert.match(View.statusView(present({ route: 'SECONDARY', until: '2026-10-06T14:05:00' })).chip.label, /^Secondary until \d\d:\d\d$/);
  assert.equal(View.statusView({ kind: 'untrusted', reason: 'r' }).chip.label, 'Untrusted');
  for (const d of [present(), present({ route: 'SECONDARY' }), present({ primaryFailures: 3 })]) assert.ok(View.statusView(d).actions.some((a) => a.kind === 'off'));
  assert.equal(View.statusView(present({ active: false })).chip.label, 'Burst off');
  assert.equal(View.statusView({ kind: 'broken', state: { version: '0.19.0' } }).actions[0].kind, 'repair');
  assert.deepEqual(View.statusView({ kind: 'not_installed' }).actions.map((a) => a.kind), ['install']);
  assert.ok(View.statusView(present({}, { canUpgrade: true, upToDate: false })).actions.some((a) => a.kind === 'update'));
});

test('view: non-mac gets the honest text, no actions, no chip', () => {
  const v = View.statusView({ kind: 'unsupported' }, { platform: 'win32' });
  assert.equal(v.detail, 'Burst runs on macOS only. Not available on Windows or Linux.');
  assert.deepEqual(v.actions, []);
  assert.equal(v.chip, null);
});

function harness({ response = 1, detect } = {}) {
  const handlers = {};
  const launched = [];
  const dialogs = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-ipc-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-iph-'));
  fs.mkdirSync(path.join(home, 'claude-burst', '.git'), { recursive: true });
  fs.writeFileSync(path.join(home, 'claude-burst', 'install.sh'), '');
  const client = { detect: async () => detect, adminUrl: () => 'http://127.0.0.1:7788/', requestUpgrade: async () => { launched.push('api-upgrade'); }, testConnection: async () => ({ ok: true }) };
  const opened = [];
  const api = Ipc.register({
    utilityHandle: (ch, allowed, fn) => { handlers[ch] = (e, ...a) => (allowed(e) ? fn(e, ...a) : null); },
    settingsOnly: (e) => e.ok === true, isMac: true, client, home, scriptDir: dir, launch: async (f) => launched.push(f),
    dialog: { showMessageBox: async (o) => { dialogs.push(o); return { response }; } }, shell: { openExternal: async (u) => opened.push(u) },
  });
  return { handlers, launched, dialogs, api, opened, ok: { ok: true } };
}

test('ipc: only the settings page may call; consent dialog shows before anything runs; cancel runs nothing', async () => {
  const h = harness({ response: 0, detect: present() });
  await h.handlers['burst:status'](h.ok);
  assert.equal(await h.handlers['burst:action']({ ok: false }, { kind: 'off' }), null);
  const r = await h.handlers['burst:action'](h.ok, { kind: 'off' });
  assert.equal(r.cancelled, true);
  assert.equal(h.dialogs.length, 1);
  assert.match(h.dialogs[0].detail, /Terminal will run: .*burst-off/);
  assert.deepEqual(h.launched, []);
});

test('ipc: confirm runs the fixed script via the stub; transparent consent names the CA, hosts and pf', async () => {
  const h = harness({ response: 1, detect: { kind: 'not_installed' } });
  await h.handlers['burst:status'](h.ok);
  const r = await h.handlers['burst:action'](h.ok, { kind: 'install', mode: 'transparent' });
  assert.equal(r.ok, true);
  assert.match(h.dialogs[0].detail, /trusted root CA[\s\S]*Consumer Terms/);
  assert.equal(h.launched.length, 1);
  assert.match(fs.readFileSync(h.launched[0], 'utf8'), /CLAUDE_BURST_MODE=transparent \.\/install\.sh/);
});

test('ipc: unknown kinds are refused before any dialog; update uses the API only when Burst offers it', async () => {
  const h = harness({ response: 1, detect: present({}, { canUpgrade: true, upToDate: false }) });
  await h.handlers['burst:status'](h.ok);
  assert.equal((await h.handlers['burst:action'](h.ok, { kind: 'force' })).ok, false);
  assert.equal(h.dialogs.length, 0);
  await h.handlers['burst:action'](h.ok, { kind: 'update' });
  assert.deepEqual(h.launched, ['api-upgrade']);
});

test('tray: Turn Burst off appears in on states and not when not installed', async () => {
  const on = harness({ detect: present() });
  await on.handlers['burst:status'](on.ok);
  assert.equal(on.api.trayItems()[0].label, 'Turn Burst off…');
  const none = harness({ detect: { kind: 'not_installed' } });
  await none.handlers['burst:status'](none.ok);
  assert.deepEqual(none.api.trayItems(), []);
});

test('non-mac: static text, no polling interval, burst-client never loaded', async () => {
  const handlers = {};
  const before = Object.keys(require.cache).filter((k) => k.endsWith('burst-client.js')).length;
  Ipc.register({ utilityHandle: (c, a, f) => { handlers[c] = f; }, settingsOnly: () => true, isMac: false, dialog: {}, shell: {}, scriptDir: '/x' });
  const v = await handlers['burst:status']({});
  assert.equal(v.nextPollMs, 0);
  assert.equal(v.detail, View.MAC_ONLY);
  assert.deepEqual((await handlers['burst:action']({}, { kind: 'off' })).ok, false);
  assert.equal(Object.keys(require.cache).filter((k) => k.endsWith('burst-client.js')).length, before);
});

test('main.js wiring is a require+register line and one tray spread', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /require\('\.\/src\/burst-ipc\.js'\)\.register\(\{ utilityHandle, settingsOnly, isMac: IS_MAC/);
  assert.match(src, /\.\.\.BurstIpc\.trayItems\(\),/);
});
