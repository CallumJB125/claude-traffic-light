'use strict';

// Lane C of the Burst v0.20 integration: the whitelisting normalizers for loose ends,
// keep-awake, mods and Finder (against the real 0.20.36 fixture and a 0.19 server), the
// strict body builders of the new MUTATE_ALLOW entries, and the burst:view / burst:action
// IPC paths through the native consent dialog.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Client = require('../src/burst-client.js');
const Ipc = require('../src/burst-ipc.js');
const { createFakeBurst, stateV019 } = require('./fixtures/fake-burst.js');
const { testTempDir } = require('./helpers/tmp');

const { createBurstClient, MUTATE_ALLOW, normalizeLooseEnds, normalizeKeepAwake, normalizeMods, normalizeFinder } = Client;
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'burst-0.20.36.json'), 'utf8'));
const NEW_MUTATIONS = ['keep-awake', 'mod-action', 'panel-install', 'finder-install', 'console-repair', 'console-restore-config'];

const BIN = (home) => path.join(home, '.local', 'bin', 'claude-burst');
function makeHome(cfg) {
  const home = testTempDir('burst-lane-c-');
  fs.mkdirSync(path.dirname(BIN(home)), { recursive: true });
  fs.writeFileSync(BIN(home), '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify(cfg));
  return home;
}
const routes020 = (extra = {}) => ({ ...Object.fromEntries(Object.entries(FIXTURE).map(([p, body]) => [p, { body: p === '/api/state' ? { ...body, pid: process.pid } : body }])), ...extra });
const consoleStatus = (version) => ({ version, dashboard_up: false, checks: [{ name: 'Gateway service', ok: false, detail: 'not loaded' }], log_tail: [] });

// Gateway + console fakes, both trusted (launchd pid = listener pid = this process, exe = the fake binary).
async function setup({ gateway, console: consoleRoutes = { '/api/console': { body: consoleStatus('0.20.36') } }, t } = {}) {
  const gw = await createFakeBurst(gateway);
  const con = await createFakeBurst(consoleRoutes);
  const home = makeHome({ admin_listen: `127.0.0.1:${gw.port}`, console_listen: `127.0.0.1:${con.port}` });
  const inspect = { launchdPid: async () => process.pid, listenerPid: async (p) => (p === gw.port || p === con.port ? process.pid : null), exePath: async () => BIN(home) };
  const client = createBurstClient({ home, platform: 'darwin', inspect, timeoutMs: 2000 });
  const done = async () => { await gw.close(); await con.close(); fs.rmSync(home, { recursive: true, force: true }); };
  t?.after(done);
  return { gw, con, home, client, done };
}
const posts = (fake) => fake.requests.filter((r) => r.method === 'POST');

// A richer loose-ends answer than the fixture's empty report, in Burst's own shape (internal/looseends).
const looseReport = {
  report: {
    at: 1792401162, scanned: 4,
    repos: [
      { root: '/Users/owner/code/plexiform', branch: 'main', upstream: 'origin/main', uncommitted: [{ path: '/Users/owner/code/plexiform/src/a.js', status: ' M', mtime: 1 }, { path: '/Users/owner/code/plexiform/notes/secret plan.md', status: '??', mtime: 2 }], unpushed: [{ hash: 'abc123', when: 3, subject: 'wip' }], ahead: 2, stashes: [{ ref: 'stash@{0}', when: 4, subject: 'WIP on main: try thing' }] },
      { root: '/Users/owner/code/other', branch: 'feat', no_remote: true, ahead: 0, error: 'git: timed out' },
      { branch: 'nameless' },
    ],
  },
  stale: { files: 1, commits: 2, stashes: 0 }, stale_hours: 24, within_days: 30,
};

test('normalizeLooseEnds: counts and names only, in a fixed key set; the 0.20.36 fixture (no loose repos) normalizes too', () => {
  const v = normalizeLooseEnds(looseReport);
  assert.deepEqual(Object.keys(v).sort(), ['kind', 'repos', 'scanned', 'stale', 'staleHours', 'withinDays']);
  assert.deepEqual({ ...v, repos: undefined }, { kind: 'ok', scanned: 4, stale: { files: 1, commits: 2, stashes: 0 }, staleHours: 24, withinDays: 30, repos: undefined });
  assert.equal(v.repos.length, 2, 'a repo without a root is dropped');
  assert.deepEqual(v.repos[0], { path: '/Users/owner/code/plexiform', branch: 'main', noRemote: false, uncommitted: 2, unpushed: 2, stashes: 1, names: ['a.js', 'secret plan.md'], stashNames: ['WIP on main: try thing'], error: '' });
  assert.deepEqual(v.repos[1], { path: '/Users/owner/code/other', branch: 'feat', noRemote: true, uncommitted: 0, unpushed: 0, stashes: 0, names: [], stashNames: [], error: 'git: timed out' });
  const text = JSON.stringify(v);
  assert.ok(!text.includes('abc123') && !text.includes(' M') && !text.includes('mtime'), 'no hashes, statuses or times');
  assert.deepEqual(normalizeLooseEnds(FIXTURE['/api/loose-ends']), { kind: 'ok', scanned: 4, stale: { files: 0, commits: 0, stashes: 0 }, staleHours: 24, withinDays: 30, repos: [] });
  assert.deepEqual(normalizeLooseEnds(null).repos, []);
});

test('normalizeKeepAwake: mode, idle limit and whether sleep is held, from the 0.20.36 /api/mac', () => {
  const v = normalizeKeepAwake(FIXTURE['/api/mac']);
  assert.deepEqual(v, { kind: 'ok', mode: 'off', idleLimit: 0, held: true, heldKnown: true, onAc: true, appliedMode: '', daemon: 'off', problem: '' });
  const on = normalizeKeepAwake({ keep_awake: { mode: 'ac', idle_minutes: 90, live: { sleep_disabled: true, applied_mode: 'ac' }, daemon: 'stale', problem: 'the keep-awake daemon runs an older copy', hotspot_password: 'x' } });
  assert.deepEqual(on, { kind: 'ok', mode: 'ac', idleLimit: 90, held: true, heldKnown: false, onAc: false, appliedMode: 'ac', daemon: 'stale', problem: 'the keep-awake daemon runs an older copy' });
  assert.equal(normalizeKeepAwake({ keep_awake: { mode: 'banana', daemon: 'odd' } }).mode, 'off');
  assert.equal(normalizeKeepAwake(undefined).held, false);
});

test('normalizeMods: the burst-session mod from /api/mod-status and the usage panel from /api/mac, one list', () => {
  const v = normalizeMods(FIXTURE['/api/mod-status'], FIXTURE['/api/mac']);
  assert.equal(v.kind, 'ok');
  assert.equal(v.claudeVersion, '2.1.302');
  assert.deepEqual(v.mods.map((m) => m.id), ['burst-session', 'usage-panel']);
  const [mod, panel] = v.mods;
  assert.deepEqual({ ...mod, options: undefined, last: undefined }, { id: 'burst-session', name: 'Burst session mod', installed: true, current: true, version: '0.12.4', supported: true, source: '/Users/owner/claude-burst/mods/burst-session', error: '', hint: '', options: undefined, last: undefined });
  assert.deepEqual(mod.options, { toasts: true, handoff: true, handoffInPath: true });
  assert.equal(mod.last, null);
  assert.deepEqual(panel, { id: 'usage-panel', name: 'Usage panel', installed: true, current: true, version: '', supported: true, source: '/Users/owner/claude-code-cost-sidebar', error: '', hint: '', running: false, last: null });
  const busy = normalizeMods({ installed: false, supported: true, last: { action: 'install', started: 'x', ok: false, output: 'long log' } }, { panel: { installed: false, running: true } });
  assert.deepEqual(busy.mods[0].last, { action: 'install', running: true, ok: false });
  assert.equal(busy.mods[1].running, true);
  assert.ok(!JSON.stringify(busy).includes('long log'), 'script output never reaches the renderer');
  for (const m of normalizeMods(null, null).mods) assert.equal(m.installed, false);
});

test('normalizeFinder: ghostty plus per-shortcut install state; unknown keys and notes are dropped', () => {
  const v = normalizeFinder({
    ghostty: true,
    shortcuts: [
      { key: 'claude', name: 'Launch Claude Code in Ghostty', group: 'Launch Claude Code', option: 'New session', tool: 'claude', note: 'long note', installed: true, ours: true, launcher: true, tool_found: true, bypass_on: false, bypass_ok: true },
      { key: 'omc-interop', name: 'Launch OMC and Codex side by side in Ghostty', group: 'Launch OMC', option: 'Side by side with Codex', tool: 'omc', also: 'codex', installed: false, ours: false, launcher: false, tool_found: false, missing: 'codex', bypass_on: true, bypass_ok: false },
      { key: 'evil', name: 'x', installed: true },
    ],
  });
  assert.equal(v.kind, 'ok');
  assert.equal(v.ghostty, true);
  assert.deepEqual(v.shortcuts.map((s) => s.key), ['claude', 'omc-interop']);
  assert.deepEqual(v.shortcuts[0], { key: 'claude', name: 'Launch Claude Code in Ghostty', group: 'Launch Claude Code', option: 'New session', tool: 'claude', installed: true, ours: true, launcher: true, toolFound: true, missing: '', bypassOn: false, bypassOk: true });
  assert.deepEqual(v.shortcuts[1], { key: 'omc-interop', name: 'Launch OMC and Codex side by side in Ghostty', group: 'Launch OMC', option: 'Side by side with Codex', tool: 'omc', installed: false, ours: false, launcher: false, toolFound: false, missing: 'codex', bypassOn: true, bypassOk: false });
  assert.ok(!JSON.stringify(v).includes('long note'));
  assert.deepEqual(normalizeFinder({}), { kind: 'ok', ghostty: false, shortcuts: [] });
});

test('client reads: against the 0.20.36 fixture every new read is normalized; before detect() all are unsupported', async (t) => {
  const finderBody = { ghostty: true, shortcuts: [{ key: 'ghostty', name: 'Open Ghostty here', group: 'Open Ghostty', option: 'Plain terminal', installed: true, ours: true, launcher: true, tool_found: true, bypass_ok: true }] };
  const h = await setup({ gateway: routes020({ '/api/finder': { body: finderBody } }), t });
  assert.deepEqual(await h.client.looseEnds(), { kind: 'unsupported' });
  assert.equal(h.client.capabilities(), null);
  const d = await h.client.detect();
  assert.equal(d.kind, 'present');
  assert.equal(h.client.capabilities().mods, true);
  assert.equal((await h.client.looseEnds()).kind, 'ok');
  assert.equal((await h.client.keepAwake()).mode, 'off');
  assert.equal((await h.client.mods()).mods[1].installed, true);
  assert.deepEqual((await h.client.finder()).shortcuts.map((s) => s.key), ['ghostty']);
});

test('client reads: against a 0.19 server all four are {kind:"unsupported"} and no 0.20 route is ever requested', async (t) => {
  const h = await setup({ gateway: { '/api/state': { body: stateV019() }, '/api/mac': { body: FIXTURE['/api/mac'] }, '/api/mod-status': { body: FIXTURE['/api/mod-status'] } }, t });
  assert.equal((await h.client.detect()).kind, 'present');
  for (const name of ['looseEnds', 'keepAwake', 'mods', 'finder']) assert.deepEqual(await h.client[name](), { kind: 'unsupported' }, name);
  assert.ok(!h.gw.requests.some((r) => /loose-ends|finder|mod-status|\/api\/mac/.test(r.url)), 'nothing beyond state and upgrade-status was read');
  // The raw reads other code relies on are unchanged (mac() for This Mac, modStatus() for the optimiser band).
  assert.equal((await h.client.mac()).keep_awake.mode, 'off');
  assert.equal((await h.client.modStatus()).installed, true);
});

test('MUTATE_ALLOW: the six lane C entries, each with a capability and a strict body builder', () => {
  for (const k of NEW_MUTATIONS) assert.ok(MUTATE_ALLOW[k], k);
  assert.deepEqual(NEW_MUTATIONS.map((k) => MUTATE_ALLOW[k].path), ['/api/keep-awake', '/api/mod-action', '/api/panel-install', '/api/finder-install', '/api/console/repair', '/api/console/restore-config']);
  assert.deepEqual(NEW_MUTATIONS.map((k) => MUTATE_ALLOW[k].capability), ['keepAwake', 'mods', 'mods', 'finder', 'consoleRepair', 'consoleRepair']);
  assert.deepEqual(NEW_MUTATIONS.map((k) => MUTATE_ALLOW[k].target || 'gateway'), ['gateway', 'gateway', 'gateway', 'gateway', 'console', 'console']);
  assert.ok(!('handoff-taken' in MUTATE_ALLOW), 'the mod\'s own callback is not ours to send');
  assert.ok(!Object.values(MUTATE_ALLOW).some((m) => /tether|wifi|join|password/i.test(m.path)));

  const body = (k, a) => MUTATE_ALLOW[k].body(a);
  const rejects = (k, a) => assert.throws(() => body(k, a), { code: 'bad_request' }, `${k} ${JSON.stringify(a)}`);
  // keep-awake: mode from mac.go's keepAwakeModes, idle 0..1440, off always sends idle 0.
  assert.deepEqual(body('keep-awake', { mode: 'ac', idleMinutes: 90 }), { mode: 'ac', idle_minutes: 90 });
  assert.deepEqual(body('keep-awake', { mode: 'always' }), { mode: 'always', idle_minutes: 0 });
  assert.deepEqual(body('keep-awake', { mode: 'off', idleMinutes: 50 }), { mode: 'off', idle_minutes: 0 });
  for (const a of [{}, { mode: 'on' }, { mode: 'ac', idleMinutes: -1 }, { mode: 'ac', idleMinutes: 1441 }, { mode: 'ac', idleMinutes: 1.5 }, { mode: 'ac', idleMinutes: '10' }]) rejects('keep-awake', a);
  // mod-action: install (= update), remove, or one option with a boolean.
  assert.deepEqual(body('mod-action', { action: 'install' }), { action: 'install' });
  assert.deepEqual(body('mod-action', { action: 'remove', on: true }), { action: 'remove' });
  assert.deepEqual(body('mod-action', { action: 'toasts', on: false }), { action: 'toasts', toasts: false });
  assert.deepEqual(body('mod-action', { action: 'handoff_in_path', on: true }), { action: 'handoff_in_path', handoff_in_path: true });
  for (const a of [{}, { action: 'update' }, { action: 'pin' }, { action: 'uninstall' }, { action: 'toasts' }, { action: 'handoff', on: 'yes' }]) rejects('mod-action', a);
  // panel-install: install or remove, nothing else.
  assert.deepEqual(body('panel-install', { action: 'install' }), { action: 'install' });
  assert.deepEqual(body('panel-install', { action: 'remove', extra: 1 }), { action: 'remove' });
  for (const a of [{}, { action: 'update' }, { action: 'fetch' }]) rejects('panel-install', a);
  // finder-install: install/remove with optional known keys; bypass needs keys and on.
  assert.deepEqual(body('finder-install', { action: 'install' }), { action: 'install' });
  assert.deepEqual(body('finder-install', { action: 'remove', keys: ['claude', 'ghostty'] }), { action: 'remove', keys: ['claude', 'ghostty'] });
  assert.deepEqual(body('finder-install', { action: 'bypass', keys: ['omc'], on: true }), { action: 'bypass', keys: ['omc'], on: true });
  for (const a of [{}, { action: 'install', keys: [] }, { action: 'install', keys: ['../x'] }, { action: 'install', keys: 'claude' }, { action: 'bypass', on: true }, { action: 'bypass', keys: ['claude'] }, { action: 'open' }]) rejects('finder-install', a);
  // Console actions carry no args at all.
  assert.deepEqual(body('console-repair', { anything: 1 }), {});
  assert.deepEqual(body('console-restore-config', {}), {});
});

test('mutate: a 0.20.36 gateway gets exactly the built body; a 0.19 gateway or console is refused as unsupported before any POST', async (t) => {
  const h = await setup({ gateway: routes020({ '/api/keep-awake': { body: { script: '/tmp/x', detail: 'Saved.' } }, '/api/panel-install': { body: { ok: true, started: true } } }), console: { '/api/console': { body: consoleStatus('0.20.36') }, '/api/console/repair': { body: { detail: 'A Terminal window is repairing Burst.' } } }, t });
  const r = await h.client.mutate('keep-awake', { mode: 'ac', idleMinutes: 30 });
  assert.deepEqual(r, { ok: true, data: { script: '/tmp/x', detail: 'Saved.' } });
  assert.deepEqual(posts(h.gw).map((p) => [p.url, JSON.parse(p.body), p.headers['x-claude-burst-admin']]), [['/api/keep-awake', { mode: 'ac', idle_minutes: 30 }, '1']]);
  await h.client.mutate('panel-install', { action: 'install' });
  assert.deepEqual(JSON.parse(posts(h.gw)[1].body), { action: 'install' });
  const c = await h.client.mutate('console-repair', {});
  assert.equal(c.ok, true);
  assert.deepEqual(posts(h.con).map((p) => p.url), ['/api/console/repair']);
  await assert.rejects(h.client.mutate('mod-action', { action: 'pin' }), { code: 'bad_request' });
  await assert.rejects(h.client.mutate('finder-install', { action: 'bypass', keys: ['nope'], on: true }), { code: 'bad_request' });

  const old = await setup({ gateway: { '/api/state': { body: stateV019() }, '/api/keep-awake': { body: {} } }, console: { '/api/console': { body: consoleStatus('0.19.0') }, '/api/console/repair': { body: {} }, '/api/console/restore-config': { body: {} } }, t });
  await assert.rejects(old.client.mutate('keep-awake', { mode: 'off' }), { code: 'unsupported' });
  await assert.rejects(old.client.mutate('console-repair', {}), { code: 'unsupported' });
  await assert.rejects(old.client.mutate('console-restore-config', {}), { code: 'unsupported' });
  assert.equal(posts(old.gw).length + posts(old.con).length, 0);
  // The 0.19 restart still works: consoleRepair gating is per entry.
  old.con.requests.length = 0;
});

// ---- IPC: burst:view kinds and burst:action kinds through the native consent dialog ----

async function ipcHarness({ answer = 1, gateway, console: consoleRoutes, t } = {}) {
  const h = await setup({ gateway, console: consoleRoutes, t });
  const handlers = {};
  const dialogs = [];
  const api = Ipc.register({
    utilityHandle: (c, allowed, f) => { handlers[c] = (e, ...a) => (allowed(e) ? f(e, ...a) : null); },
    settingsOnly: (e) => e.from === 'settings', accountAllowed: () => false, sessionsAllowed: (e) => e.from === 'sessions', optimiserAllowed: (e) => e.from === 'optimiser', usageAllowed: (e) => e.from === 'usage',
    isMac: true, client: h.client, home: h.home, dialog: { showMessageBox: async (o) => { dialogs.push(o); return { response: answer }; } }, shell: {}, scriptDir: '/x',
  });
  await api.refresh(true);
  return { ...h, api, handlers, dialogs };
}
const OPT = { from: 'optimiser' };

test('burst:view: loose-ends, keep-awake, mods and finder answer {ok, view} from the optimiser, usage and settings pages, and {ok:false, unsupported} on 0.19', async (t) => {
  const h = await ipcHarness({ gateway: routes020({ '/api/finder': { body: { ghostty: false, shortcuts: [] } } }), t });
  const le = await h.handlers['burst:view'](OPT, 'loose-ends');
  assert.deepEqual(le, { ok: true, view: { kind: 'ok', scanned: 4, stale: { files: 0, commits: 0, stashes: 0 }, staleHours: 24, withinDays: 30, repos: [] } });
  assert.deepEqual(await h.handlers['burst:view']({ from: 'settings' }, 'keep-awake'), { ok: true, view: { kind: 'ok', mode: 'off', idleLimit: 0, held: true, heldKnown: true, onAc: true, appliedMode: '', daemon: 'off', problem: '' } });
  const mods = await h.handlers['burst:view']({ from: 'usage' }, 'mods');
  assert.equal(mods.ok, true);
  assert.deepEqual(mods.view.mods.map((m) => [m.id, m.installed, m.current]), [['burst-session', true, true], ['usage-panel', true, true]]);
  assert.deepEqual(await h.handlers['burst:view']({ from: 'sessions' }, 'finder'), { ok: true, view: { kind: 'ok', ghostty: false, shortcuts: [] } });
  assert.equal(await h.handlers['burst:view']({ from: 'widget' }, 'mods'), null, 'the widget has no sender right');
  // The existing views keep their shape and gain `ok`.
  const route = await h.handlers['burst:view'](OPT, 'route');
  assert.equal(route.ok, true);
  assert.ok(route.view && typeof route.view === 'object');

  const old = await ipcHarness({ gateway: { '/api/state': { body: stateV019() }, '/api/upgrade-status': { body: {} }, '/api/settings': { body: {} } }, t });
  for (const name of ['loose-ends', 'keep-awake', 'mods', 'finder']) {
    assert.deepEqual(await old.handlers['burst:view'](OPT, name), { ok: false, view: { kind: 'unsupported' }, unsupported: true, error: 'This Burst does not support that. Update Burst first.', reason: 'This Burst does not support that. Update Burst first.' }, name);
  }
});

test('burst:action: each lane C kind shows its own consent sentence; cancel sends nothing, confirm sends one POST', async (t) => {
  const gateway = routes020({ '/api/keep-awake': { body: { detail: 'Saved.' } }, '/api/mod-action': { body: { ok: true, started: true } }, '/api/panel-install': { body: { ok: true, started: true } }, '/api/finder-install': { body: { done: ['claude'] } } });
  const consoleRoutes = { '/api/console': { body: consoleStatus('0.20.36') }, '/api/console/repair': { body: { detail: 'repairing' } }, '/api/console/restore-config': { body: { detail: 'config.json loads as it is, so nothing was restored.' } } };
  const no = await ipcHarness({ answer: 0, gateway, console: consoleRoutes, t });
  const cases = [
    [{ kind: 'keep-awake', args: { mode: 'ac', idleMinutes: 45 } }, 'Keep this Mac awake', /lid-awake-root\.sh.*45-minute idle limit|45-minute idle limit.*lid-awake-root\.sh/s],
    [{ kind: 'keep-awake', args: { mode: 'off' } }, 'Let this Mac sleep', /power settings back/],
    [{ kind: 'mod-install' }, 'Install Burst\'s session mod', /update-mod\.sh.*Claude Code plugin/s],
    [{ kind: 'mod-update' }, 'Install Burst\'s session mod', /installs or updates/],
    [{ kind: 'mod-remove' }, 'Remove Burst\'s session mod', /uninstall/],
    [{ kind: 'panel-install' }, 'Install the usage panel', /claude-panel-setup\.sh/],
    [{ kind: 'panel-remove' }, 'Remove the usage panel', /claude-panel-uninstall\.sh/],
    [{ kind: 'finder-install', args: { keys: ['claude'] } }, 'Add Finder shortcuts', /1 ticked Quick Action into ~\/Library\/Services/],
    [{ kind: 'finder-remove' }, 'Remove Finder shortcuts', /~\/Library\/Services/],
    [{ kind: 'console-repair' }, 'Repair Burst', /repair\.sh/],
    [{ kind: 'console-restore-config' }, 'Restore last good config', /config\.json that loaded/],
  ];
  for (const [req, title, detail] of cases) {
    assert.deepEqual(await no.handlers['burst:action'](OPT, req), { ok: false, cancelled: true }, req.kind);
    const d = no.dialogs.at(-1);
    assert.equal(d.title, title, req.kind);
    assert.match(d.detail, detail, req.kind);
    assert.deepEqual(d.buttons, ['Cancel', title]);
  }
  assert.equal(no.dialogs.length, cases.length);
  assert.equal(posts(no.gw).length + posts(no.con).length, 0, 'cancel sends nothing');

  const yes = await ipcHarness({ answer: 1, gateway, console: consoleRoutes, t });
  assert.deepEqual(await yes.handlers['burst:action'](OPT, { kind: 'keep-awake', args: { mode: 'always' } }), { ok: true, data: { detail: 'Saved.' } });
  assert.deepEqual(await yes.handlers['burst:action']({ from: 'settings' }, { kind: 'mod-update' }), { ok: true, data: { ok: true, started: true } });
  assert.deepEqual(await yes.handlers['burst:action'](OPT, { kind: 'finder-install', args: { keys: ['claude', 'ghostty'] } }), { ok: true, data: { done: ['claude'] } });
  assert.deepEqual(await yes.handlers['burst:action'](OPT, { kind: 'console-restore-config' }), { ok: true, data: { detail: 'config.json loads as it is, so nothing was restored.' } });
  assert.deepEqual(posts(yes.gw).map((p) => [p.url, JSON.parse(p.body)]), [['/api/keep-awake', { mode: 'always', idle_minutes: 0 }], ['/api/mod-action', { action: 'install' }], ['/api/finder-install', { action: 'install', keys: ['claude', 'ghostty'] }]]);
  assert.deepEqual(posts(yes.con).map((p) => p.url), ['/api/console/restore-config']);
  // The generic channel reaches the same entries with the same consent.
  assert.deepEqual(await yes.handlers['burst-action'](OPT, 'mod-action', { action: 'toasts', on: false }), { ok: true, data: { ok: true, started: true } });
  assert.equal(yes.dialogs.at(-1).title, 'Turn session toasts off');
});

test('burst:action: bad args never reach a dialog; 0.19 answers unsupported before the dialog; the widget is refused', async (t) => {
  const h = await ipcHarness({ gateway: routes020({ '/api/keep-awake': { body: {} } }), t });
  assert.deepEqual(await h.handlers['burst:action'](OPT, { kind: 'keep-awake', args: { mode: 'on' } }), { ok: false, error: 'Bad request.', reason: 'Bad request.' });
  assert.deepEqual(await h.handlers['burst:action'](OPT, { kind: 'keep-awake', args: { mode: 'ac', idleMinutes: 9999 } }), { ok: false, error: 'Bad request.', reason: 'Bad request.' });
  assert.deepEqual(await h.handlers['burst:action'](OPT, { kind: 'finder-install', args: { keys: ['evil'] } }), { ok: false, error: 'Bad request.', reason: 'Bad request.' });
  assert.deepEqual(await h.handlers['burst:action'](OPT, { kind: 'install' }), { ok: false, error: 'Not available.', reason: 'Not available.' }, 'Terminal-script kinds stay settings-only');
  assert.equal(await h.handlers['burst:action']({ from: 'widget' }, { kind: 'console-repair' }), null);
  assert.equal(h.dialogs.length, 0);
  assert.equal(posts(h.gw).length, 0);

  const old = await ipcHarness({ gateway: { '/api/state': { body: stateV019() }, '/api/upgrade-status': { body: {} }, '/api/keep-awake': { body: {} }, '/api/mod-action': { body: {} } }, console: { '/api/console': { body: consoleStatus('0.19.0') }, '/api/console/repair': { body: {} } }, t });
  const unsupported = { ok: false, unsupported: true, error: 'This Burst does not support that. Update Burst first.', reason: 'This Burst does not support that. Update Burst first.' };
  assert.deepEqual(await old.handlers['burst:action'](OPT, { kind: 'keep-awake', args: { mode: 'off' } }), unsupported);
  assert.deepEqual(await old.handlers['burst:action'](OPT, { kind: 'mod-install' }), unsupported);
  assert.equal(old.dialogs.length, 0, 'gateway actions are refused before any dialog on 0.19');
  // Console actions are checked against the console's own version, after consent.
  assert.deepEqual(await old.handlers['burst:action'](OPT, { kind: 'console-repair' }), unsupported);
  assert.equal(old.dialogs.length, 1);
  assert.equal(posts(old.gw).length + posts(old.con).length, 0);
});
