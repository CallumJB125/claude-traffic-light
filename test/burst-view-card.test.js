'use strict';

// B4: the Burst card shows keep-awake, Remote Control and the mods list with one Install/Update
// action per mod; each part is hidden (null) when the running Burst lacks the capability.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const View = require('../src/burst-view.js');
const Ipc = require('../src/burst-ipc.js');
const FIXTURE = require('./fixtures/burst-0.20.36.json');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const MAC = FIXTURE['/api/mac'];
const MODS = FIXTURE['/api/mod-status'];
const state = (over = {}) => ({ version: '0.20.36', mode: 'base-url', active: true, route: 'PRIMARY', until: '', rejected: [], primaryFailures: 0, caTrusted: false, hostsEntry: false, remoteControlExpected: false, compaction: null, ...over });
const present = (caps = { keepAwake: true, mods: true, looseEnds: true }, over = {}, extra = {}) => ({ kind: 'present', installed: true, capabilities: { upgradeStatus: true, remoteControl: caps.remoteControl ?? true, ...caps }, upgrade: null, state: state(over), ...extra });
const card = (d, o = {}) => View.cardView(d, { platform: 'darwin', mac: MAC, modStatus: MODS, ...o });

test('cardView = statusView + keepAwake, remoteControl, mods from the v0.20.36 fixture', () => {
  const v = card(present());
  assert.equal(v.kind, 'on');
  assert.equal(v.action, null);
  assert.deepEqual(v.keepAwake, { mode: 'off', on: false, held: true, pending: false, label: 'Off', text: 'Burst is not keeping this Mac awake: a closed lid is held open by another program right now.' });
  assert.deepEqual(v.remoteControl, { expected: false, label: 'Off while Burst is on', text: 'Claude Code’s Remote Control is off while Burst is in base-URL mode. Reinstall Burst in transparent mode to have both.'.replace('’', '\'') });
  assert.deepEqual(v.mods.map((m) => [m.id, m.installed, m.current, m.version, m.supported, m.action]), [
    ['burst-session', true, true, '0.12.4', true, null],
    ['usage-panel', true, true, '', true, null],
  ], 'both up to date on the capture: no action');
  assert.equal(v.mods[0].status, 'Installed, version 0.12.4, up to date');
  assert.equal(v.mods[1].status, 'Installed, not running');
});

test('keep-awake and Remote Control read back the states a person needs to act on', () => {
  const on = card(present({ keepAwake: true, mods: true }, { mode: 'transparent', remoteControlExpected: true }), { mac: { keep_awake: { mode: 'always', live: { sleep_disabled: true } } }, modStatus: null });
  assert.deepEqual(on.keepAwake, { mode: 'always', on: true, held: true, pending: false, label: 'On: plugged in and on battery', text: 'Burst keeps this Mac awake while AI is working, on battery too. Right now the Mac stays awake with the lid shut.' });
  assert.equal(on.remoteControl.label, 'Expected to work');
  assert.match(on.remoteControl.text, /transparent mode/);
  const ac = View.keepAwakeView({ keep_awake: { mode: 'ac', live: { sleep_disabled: false } } });
  assert.equal(ac.label, 'On: plugged in only');
  assert.match(ac.text, /would sleep with the lid shut/);
  assert.equal(View.keepAwakeView({ keep_awake: { mode: 'off', live: { sleep_disabled: false } } }).text, 'Burst is not keeping this Mac awake: a closed lid puts it to sleep, which stops running sessions.');
  assert.equal(View.keepAwakeView(null), null);
  assert.equal(View.keepAwakeView({ panel: {} }), null, 'no keep_awake block: no row');
  assert.equal(View.remoteControlView({ mode: 'base-url' }), null, 'a 0.19 state has no remoteControlExpected: no row');
});

test('mods: one Install or Update action per mod, action kinds mod-install / mod-update with the mod id; unsupported gets none', () => {
  const rows = View.modsView({ modStatus: { ...MODS, installed: false }, mac: { panel: { installed: false } } });
  assert.deepEqual(rows.map((m) => m.action), [{ kind: 'mod-install', label: 'Install', args: { mod: 'burst-session' } }, { kind: 'mod-install', label: 'Install', args: { mod: 'usage-panel' } }]);
  assert.deepEqual(rows.map((m) => m.status), ['Not installed', 'Not installed']);
  const stale = View.modsView({ modStatus: { ...MODS, current: false, version: '0.11.0' } });
  assert.deepEqual(stale.map((m) => m.action), [{ kind: 'mod-update', label: 'Update', args: { mod: 'burst-session' } }]);
  assert.equal(stale[0].status, 'Installed, version 0.11.0, update available');
  const unsupported = View.modsView({ modStatus: { ...MODS, supported: false, installed: false } });
  assert.equal(unsupported[0].action, null);
  assert.equal(unsupported[0].status, 'Not supported by Claude Code 2.1.302');
  assert.equal(View.modsView({}), null, 'nothing read: no list');
  for (const m of [...rows, ...stale]) { assert.ok(m.name && m.what && m.status, m.id); assert.ok(!/\bmod\b/i.test(m.what) || m.id === 'burst-session', 'plain words'); }
});

test('hidden when the capability is false: a 0.19 Burst shows the plain card, as does a Burst that is off or not installed', () => {
  const old = card(present({ keepAwake: false, mods: false, looseEnds: false, remoteControl: false }, { version: '0.19.0' }));
  assert.equal(old.kind, 'on');
  assert.equal(old.keepAwake, null);
  assert.equal(old.mods, null);
  assert.equal(old.remoteControl, null, 'verifier fix 4: a 0.19 Burst never reports Remote Control, so there is no row');
  assert.equal(card(present({ keepAwake: false, mods: false }, { remoteControlExpected: undefined })).remoteControl, null);
  for (const d of [{ kind: 'not_installed' }, { kind: 'checking' }, { kind: 'unreachable', installed: true, misses: 1 }, { kind: 'unsupported' }]) {
    const v = card(d);
    assert.equal(v.keepAwake, null, d.kind); assert.equal(v.remoteControl, null, d.kind); assert.equal(v.mods, null, d.kind);
    assert.ok(v.detail, 'never an empty card');
  }
  const failedReads = card(present(), { mac: null, modStatus: null });
  assert.equal(failedReads.keepAwake, null, 'a failed read hides the row rather than inventing one');
  assert.equal(failedReads.mods, null);
});

test('burst:status carries the card rows from cached reads, gated on the detected capabilities', async () => {
  const handlers = {};
  const reads = [];
  let detect = present();
  const client = { detect: async () => detect, adminUrl: () => 'http://127.0.0.1:7788/', mac: async () => { reads.push('mac'); return MAC; }, modStatus: async () => { reads.push('modStatus'); return { ...MODS, current: false }; }, looseEnds: async () => FIXTURE['/api/loose-ends'] };
  Ipc.register({ utilityHandle: (ch, allowed, fn) => { handlers[ch] = (e, ...a) => (allowed(e) ? fn(e, ...a) : null); }, settingsOnly: (e) => e.ok === true, isMac: true, client, home: '/nonexistent', scriptDir: '/nonexistent', launch: async () => {}, dialog: { showMessageBox: async () => ({ response: 0 }) }, shell: { openExternal: async () => {} }, snapshotFile: null });
  const ok = { ok: true };
  let v = await handlers['burst:status'](ok);
  await new Promise((r) => setTimeout(r, 10));
  v = await handlers['burst:status'](ok);
  assert.deepEqual(reads.sort(), ['mac', 'modStatus'], 'one read each, cached');
  assert.equal(v.keepAwake.mode, 'off');
  assert.equal(v.remoteControl.expected, false);
  assert.deepEqual(v.mods[0].action, { kind: 'mod-update', label: 'Update', args: { mod: 'burst-session' } });
  assert.ok(v.actions.length > 0 && 'nextPollMs' in v, 'the old card fields stay');
  // The loose-ends IPC: raw report for the optimiser page, {ok:false, reason} without the capability.
  const le = await handlers['burst:loose-ends'](ok);
  assert.equal(le.ok, true);
  assert.equal(le.report.report.scanned, 4);
  assert.ok(ok && handlers['burst:loose-ends']({ ok: false }) === null, 'only its pages');
  detect = present({ keepAwake: false, mods: false, looseEnds: false }, { version: '0.19.0' });
  await handlers['burst:action'](ok, { kind: 'retry' });
  v = await handlers['burst:status'](ok);
  assert.equal(v.keepAwake, null); assert.equal(v.mods, null);
  const none = await handlers['burst:loose-ends'](ok);
  assert.deepEqual(none, { ok: false, reason: 'This Burst has no loose-ends check (needs v0.20 or newer).', report: null });
});

test('This Mac page draws the rows and sends a mod action as burst:action with the kind and the mod id only', () => {
  const page = read('buddy-window/account.js');
  assert.match(page, /factLine\('Keep awake', v\.keepAwake\.label, v\.keepAwake\.text\)/);
  assert.match(page, /factLine\('Remote Control', v\.remoteControl\.label, v\.remoteControl\.text\)/);
  assert.match(page, /for \(const m of v\.mods \|\| \[\]\)/);
  assert.match(page, /api\.burstAction\(m\.action\.kind, '', m\.action\.args\)/, 'verifier fix 2: mod kinds are burst:action kinds (ACTION_KINDS), not allow-list ids');
  assert.match(page, /drawFacts\(v\);/);
  const bridge = read('buddy-window/account-preload.js');
  assert.match(bridge, /burstAction: \(kind, mode, args\) => ipcRenderer\.invoke\('burst:action', \{ kind: str\(kind\), mode: str\(mode\), \.\.\.\(args && typeof args === 'object' \? \{ args: strArgs\(args\) \} : \{\}\) \}\)/);
  assert.match(bridge, /\/\^\[a-z\]\{1,20\}\$\/\.test\(k\) && typeof v === 'string' && v\.length <= 60/, 'args are short string fields only');
});

// Verifier fix 2, end to end: a click on a mod row's button reaches burst-ipc's `burst:action` handler as
// {kind:'mod-install', args:{mod}} and lands on the right mutation after exactly one native dialog. Before,
// the row went over `burst-action` with the kind as an id, which only knows allow-list ids: "Unknown action."
test('This Mac page: clicking Install on a mod row opens one dialog and sends panel-install (usage panel) or mod-action (session mod)', async () => {
  const { JSDOM } = require('jsdom');
  const handlers = {};
  let dialogs = 0;
  const mutated = [];
  const detect = present({ keepAwake: true, mods: true, looseEnds: true });
  const client = { detect: async () => detect, adminUrl: () => 'http://127.0.0.1:7788/', mac: async () => ({ ...MAC, panel: { installed: false } }), modStatus: async () => ({ ...MODS, installed: false }), mutate: async (id, args) => { mutated.push([id, args]); return { data: null }; } };
  Ipc.register({ utilityHandle: (ch, allowed, fn) => { handlers[ch] = (e, ...a) => (allowed(e) ? fn(e, ...a) : null); }, settingsOnly: () => true, isMac: true, client, home: '/nonexistent', scriptDir: '/nonexistent', launch: async () => {}, dialog: { showMessageBox: async () => { dialogs++; return { response: 1 }; } }, shell: { openExternal: async () => {} }, snapshotFile: null });
  await handlers['burst:status']({});
  await new Promise((r) => setTimeout(r, 10));
  const dom = new JSDOM('<!doctype html><main id="acct"></main>', { url: 'file:///account.html?screen=thismac', runScripts: 'outside-only', pretendToBeVisual: true });
  const unexpected = [];
  dom.window.buddyAccount = new Proxy({
    state: async () => ({ ok: true, brand: { name: 'Plexiform', copy: {}, defaultHost: 'app.plexiform.dev', machine: 'Mac', localBoard: 'My board (this Mac)' }, signedInHubs: [], accounts: [], hubs: [], workCapture: null }),
    onChanged() {},
    burstStatus: () => handlers['burst:status']({}),
    burstAction: (kind, mode, args) => handlers['burst:action']({}, { kind: String(kind), mode: String(mode), ...(args && typeof args === 'object' ? { args } : {}) }),
    burstRunAction: (...a) => { unexpected.push(a); return Promise.resolve({ ok: false, error: 'Unknown action.' }); },
    keepAwakeGet: async () => ({ on: false, label: '' }), macView: async () => null, burstSetCompaction: async () => ({ ok: true }),
  }, { get: (t, k) => t[k] ?? (async () => ({ ok: true })) });
  dom.window.eval(read('buddy-window/account.js'));
  await new Promise((r) => setTimeout(r, 30));
  const d = dom.window.document;
  const rows = [...d.querySelectorAll('[data-mod]')];
  assert.deepEqual(rows.map((r) => r.dataset.mod), ['burst-session', 'usage-panel']);
  rows.find((r) => r.dataset.mod === 'usage-panel').querySelector('button[data-action]').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dialogs, 1, 'one consent dialog');
  assert.deepEqual(mutated, [['panel-install', { action: 'install' }]]);
  const status = d.querySelector('.acct-section.burst-card p[role="status"]') || [...d.querySelectorAll('p[role="status"]')].find((p) => /Installing/.test(p.textContent));
  assert.ok(status && /Installing Usage panel/.test(status.textContent), 'the row reports what started, not "Unknown action."');
  rows.find((r) => r.dataset.mod === 'burst-session').querySelector('button[data-action]').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dialogs, 2);
  assert.deepEqual(mutated[1], ['mod-action', { action: 'install' }]);
  assert.deepEqual(unexpected, [], 'nothing went over burst-action by kind');
  // The card root is the Burst section; it is not dimmed while Burst answers (verifier fix 7).
  const sec = [...d.querySelectorAll('.acct-section')].find((x) => x.querySelector('h2') && x.querySelector('h2').textContent === 'Claude Burst');
  assert.ok(sec && !sec.classList.contains('dimmed'));
  dom.window.close();
});


// Verifier fix 4: the Remote Control row is built only for a Burst that is on, in a known mode, with the
// `remoteControl` capability (0.20+). 0.19, off and an unknown mode give null, so the card never claims it.
test('remoteControl row: only on + known mode + 0.20 capability; 0.19, off and an unknown mode give null', () => {
  const on = card(present({ keepAwake: false, mods: false }, { mode: 'transparent', remoteControlExpected: true }));
  assert.equal(on.remoteControl.label, 'Expected to work');
  assert.equal(card(present({ keepAwake: false, mods: false }, { mode: 'base-url', remoteControlExpected: false })).remoteControl.label, 'Off while Burst is on');
  assert.equal(card(present({ keepAwake: false, mods: false, remoteControl: false }, { version: '0.19.0', remoteControlExpected: false })).remoteControl, null, '0.19');
  assert.equal(card(present({ keepAwake: false, mods: false }, { active: false, remoteControlExpected: false })).remoteControl, null, 'off');
  assert.equal(card(present({ keepAwake: false, mods: false }, { mode: '', remoteControlExpected: false })).remoteControl, null, 'unknown mode');
  assert.equal(card(present({ keepAwake: false, mods: false }, { mode: 'weird', remoteControlExpected: true })).remoteControl, null, 'unknown mode');
  const { CAPABILITY_FLOORS, capabilitiesFor } = require('../src/burst-client.js');
  assert.deepEqual(CAPABILITY_FLOORS.remoteControl, [0, 20, 0]);
  assert.equal(capabilitiesFor('0.19.0').remoteControl, false);
  assert.equal(capabilitiesFor('0.20.36').remoteControl, true);
});

// Verifier fix 7: the card root gets class `dimmed` (CSS opacity .6) when the view is dimmed (gateway_stale).
test('This Mac page: the Burst card root carries class dimmed when the view is, and its headline is the view\'s', async () => {
  const { JSDOM } = require('jsdom');
  const stale = { ok: true, kind: 'gateway_stale', headline: 'Burst is not responding', detail: 'Showing the last known state from 9 s ago.', chip: { tone: 'amber', label: 'Not responding' }, actions: [{ kind: 'repair', label: 'Repair', primary: true }], action: { kind: 'repair', label: 'Repair' }, dimmed: true, compaction: null, keepAwake: null, remoteControl: null, mods: null, nextPollMs: 0 };
  const dom = new JSDOM('<!doctype html><main id="acct"></main>', { url: 'file:///account.html?screen=thismac', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.buddyAccount = new Proxy({
    state: async () => ({ ok: true, brand: { name: 'Plexiform', copy: {}, defaultHost: 'app.plexiform.dev', machine: 'Mac', localBoard: 'My board (this Mac)' }, signedInHubs: [], accounts: [], hubs: [], workCapture: null }),
    onChanged() {}, burstStatus: async () => stale, keepAwakeGet: async () => ({ on: false, label: '' }), macView: async () => null,
  }, { get: (t, k) => t[k] ?? (async () => ({ ok: true })) });
  dom.window.eval(read('buddy-window/account.js'));
  await new Promise((r) => setTimeout(r, 30));
  const d = dom.window.document;
  const sec = [...d.querySelectorAll('.acct-section')].find((x) => x.querySelector('h2') && x.querySelector('h2').textContent === 'Claude Burst');
  assert.ok(sec, 'the Burst card');
  assert.ok(sec.classList.contains('dimmed'), 'dimmed class on the card root');
  assert.equal(sec.querySelector('.acct-name').textContent, 'Burst is not responding', 'per-state headline (verifier fix 8)');
  assert.match(read('buddy-window/shell.css'), /\.acct-section\.dimmed \{ opacity: \.6; \}/);
  dom.window.close();
});

test('keepAwakeView: a saved mode whose daemon is missing or stopped is "Saved, not applied yet" and names the Terminal password step', () => {
  const View = require('../src/burst-view.js');
  const v = View.keepAwakeView({ keep_awake: { mode: 'ac', daemon: 'missing', live: { sleep_disabled: false, daemon_installed: false } } });
  assert.equal(v.pending, true);
  assert.equal(v.label, 'Saved, not applied yet');
  assert.match(v.text, /password/);
  assert.equal(View.keepAwakeView({ keep_awake: { mode: 'ac', daemon: 'ok', live: { sleep_disabled: true } } }).pending, false);
  assert.equal(View.keepAwakeView({ keep_awake: { mode: 'off', daemon: 'off', live: {} } }).pending, false);
});
