'use strict';
// QoL3a: the next-waiting key (src/next-shortcut.js), its order against the other keys, what a press says
// (src/needing-queue.js keyNote) and its row on the widget page. Off by default and never suggested (Callum).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const NS = require('../src/next-shortcut.js');
const CS = require('../src/compose-shortcut.js');
const NQ = require('../src/needing-queue.js');
const WidgetPage = require('../src/widget-page.js');
const { applyConfigSideEffects } = require('../src/config-effects.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function shortcuts(taken = []) {
  const held = new Map();
  let calls = 0;
  return {
    held, get calls() { return calls; },
    register(a, fn) { calls++; const k = CS.canonicalAccelerator(a, 'darwin'); if (taken.includes(k) || [...held.keys()].some((x) => CS.canonicalAccelerator(x, 'darwin') === k)) return false; held.set(a, fn); return true; },
    unregister(a) { held.delete(a); },
  };
}
const install = (gs, cfg, extra = {}) => NS.install({ globalShortcut: gs, config: () => cfg, onPress: () => {}, platform: 'darwin', ...extra });

test('off by default on every OS: no key is registered, and none is suggested', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const gs = shortcuts();
    const s = NS.install({ globalShortcut: gs, config: () => ({}), onPress: () => {}, platform });
    assert.equal(s.apply().state, 'off', platform);
    assert.equal(gs.calls, 0, `${platform}: register is never called`);
    assert.equal(s.view().line, '');
    assert.equal('suggested' in s.view(), false, 'nothing to turn on with one click');
  }
  assert.equal(WidgetPage.configView({}).nextShortcut, '');
});

test('a typed key registers; pressing it calls onPress; clearing it gives the key back', () => {
  const gs = shortcuts(); let pressed = 0; let t = 0;
  const s = NS.install({ globalShortcut: gs, config: () => ({ nextShortcut: 'Command+Shift+J' }), onPress: () => { pressed++; }, platform: 'darwin', now: () => t });
  assert.equal(s.apply().state, 'on');
  assert.equal(s.held, 'Command+Shift+J');
  gs.held.get('Command+Shift+J')();
  assert.equal(pressed, 1);
  assert.equal(s.apply({ nextShortcut: '' }).state, 'off');
  assert.equal(gs.held.size, 0);
  assert.equal(s.held, null);
});

test('it yields to the widget, task box and voice keys, compared in canonical form', () => {
  const cases = [
    [{ nextShortcut: 'CmdOrCtrl+Shift+J', widgetShortcut: 'Shift+Command+J' }, 'widget'],
    [{ nextShortcut: 'Cmd+Shift+J', composeShortcut: 'CommandOrControl+Shift+J' }, 'compose'],
  ];
  for (const [cfg, owner] of cases) {
    const gs = shortcuts();
    const s = install(gs, cfg);
    assert.equal(s.apply().state, owner);
    assert.equal(gs.held.size, 0, `${owner} keeps its key`);
    assert.match(s.view().line, /so this one is off\. Pick another key\./);
  }
  const voice = NS.reserved({ voice: { hotkey: 'F13' } }, 'darwin');
  assert.ok(voice.some((r) => r.owner === 'voice'), 'the voice key is reserved too');
  // A different key is fine.
  const gs = shortcuts();
  assert.equal(install(gs, { nextShortcut: 'Command+Shift+N', widgetShortcut: 'Command+Shift+J', composeShortcut: 'Command+Shift+Space' }).apply().state, 'on');
});

test('taken by another app: said plainly, and a failed or throwing register leaves nothing held', () => {
  const gs = shortcuts(['Command+Shift+J']);
  const s = install(gs, { nextShortcut: 'Command+Shift+J' });
  assert.equal(s.apply().state, 'taken');
  assert.match(s.view().line, /Another app already uses this key/);
  const boom = { register() { throw new Error('no'); }, unregister() {} };
  assert.equal(NS.install({ globalShortcut: boom, config: () => ({ nextShortcut: 'Command+Shift+J' }), onPress: () => {}, platform: 'darwin' }).apply().state, 'taken');
});

test('settle retries a key that was taken only because another line still held it', () => {
  const taken = ['Command+Shift+J'];
  const gs = shortcuts(taken);
  const s = install(gs, { nextShortcut: 'Command+Shift+J' });
  assert.equal(s.apply().state, 'taken');
  assert.equal(s.apply().state, 'taken', 'the same inputs are not retried on every apply');
  taken.length = 0;
  assert.equal(s.settle().state, 'on');
});

test('a dev run registers nothing', () => {
  const gs = shortcuts();
  assert.equal(install(gs, { nextShortcut: 'Command+Shift+J' }, { enabled: false }).apply().state, 'dev');
  assert.equal(gs.calls, 0);
});

test('a held key presses once per half second', () => {
  let pressed = 0; let t = 1000;
  const s = NS.install({ globalShortcut: shortcuts(), config: () => ({}), onPress: () => { pressed++; }, platform: 'darwin', now: () => t });
  assert.equal(s.press(), true);
  t += 100; assert.equal(s.press(), false);
  t += NS.PRESS_GAP_MS; assert.equal(s.press(), true);
  assert.equal(pressed, 2);
});

test('config-effects: next lets go first and settles last whenever any of the four keys changes', () => {
  for (const key of ['nextShortcut', 'composeShortcut', 'widgetShortcut', 'voice']) {
    const order = [];
    const d = {
      nextShortcut: () => order.push('next'), nextShortcutSettle: () => order.push('next-settle'),
      composeShortcut: () => order.push('compose'), composeShortcutSettle: () => order.push('compose-settle'),
      applyVoiceHotkey: () => order.push('voice'), widgetPolish: () => order.push('widget'), broadcastStatus: () => {},
      installHooks() {}, applyWidgetVisibility() {}, syncTailnetListener() {}, createTray() {},
    };
    applyConfigSideEffects({}, { [key]: 'x' }, d);
    assert.equal(order[0], 'next', `${key}: next applies first`);
    assert.equal(order.at(-1), 'next-settle', `${key}: next settles last`);
  }
  const quiet = [];
  applyConfigSideEffects({}, { sounds: true }, { nextShortcut: () => quiet.push('next'), nextShortcutSettle: () => quiet.push('s'), broadcastStatus() {} });
  assert.deepEqual(quiet, [], 'other settings leave the key alone');
});

test('keyNote: a press is never silent unless a tab came forward', () => {
  assert.equal(NQ.keyNote({ queue: 0 }), 'Nothing is waiting on you.');
  assert.equal(NQ.keyNote({ queue: 0, away: { deviceName: 'Studio' } }), 'A session on Studio is waiting on you.');
  assert.equal(NQ.keyNote({ queue: 1, activated: { app: 'Ghostty', exact: true }, folder: 'api' }), null);
  assert.equal(NQ.keyNote({ queue: 1, activated: { app: 'Ghostty', byFolder: true }, folder: 'api' }), null);
  assert.equal(NQ.keyNote({ queue: 2, activated: { app: null, cant: "Can't tell which terminal window this session is in, so nothing was switched." }, folder: 'api', badge: ' (1/2)' }),
    "api (1/2): Can't tell which terminal window this session is in, so nothing was switched.");
  assert.match(NQ.keyNote({ queue: 1, activated: { app: 'Terminal' }, folder: 'api' }), /^Opened Terminal — couldn't pick the tab/);
  assert.equal(NQ.keyNote({ queue: 1, activated: null, folder: 'api' }), "api: couldn't bring its terminal forward. Its folder path is copied.");
});

test('S2: a device name in a note is cleaned: no control or direction characters, at most 60', () => {
  assert.equal(NQ.deviceLabel('Stu\u0007dio‮'), 'Studio');
  assert.equal([...NQ.deviceLabel('x'.repeat(200))].length, 60);
  assert.equal(NQ.deviceLabel(''), 'another device');
  assert.equal(NQ.deviceLabel(null), 'another device');
  assert.equal(NQ.keyNote({ queue: 0, away: { deviceName: '\u0000' } }), 'A session on another device is waiting on you.');
});

test('cleanPatch keeps, clears and rejects the key like the other two', () => {
  assert.deepEqual(WidgetPage.cleanPatch({ nextShortcut: 'Command+Shift+J' }), { nextShortcut: 'Command+Shift+J' });
  assert.deepEqual(WidgetPage.cleanPatch({ nextShortcut: '' }), { nextShortcut: '' });
  assert.equal(WidgetPage.cleanPatch({ nextShortcut: 'nope' }), null, 'nothing to change');
  assert.equal(WidgetPage.cleanPatch({ nextShortcut: 42 }), null);
  assert.equal(WidgetPage.configView({ nextShortcut: 'Command+Shift+J' }).nextShortcut, 'Command+Shift+J');
});

test('main: the press notes through the jump path, the gesture keeps its line, and the key is applied at start and on change', () => {
  const main = read('main.js');
  assert.match(main, /async function nextWaitingFromKey\(\) \{\n  const r = await jumpToNeeding\(\);\n  if \(r\.note\) showJumpNote\(\{ title: 'Plexiform', body: r\.note \}\);/);
  assert.match(main, /const r = await jumpToNeeding\(\);\n      return \{ feedback: r\.text \};/);
  assert.match(main, /require\('\.\/src\/next-shortcut\.js'\)\.install\(\{ globalShortcut, config: loadConfig, onPress: [^\n]*enabled: !IS_DEV_RUN/);
  assert.ok(main.indexOf("require('./src/next-shortcut.js')") < main.indexOf('function commitConfig('), 'declared before anything can commit config');
  assert.ok(main.indexOf('NextShortcut.apply(); // QoL3a') < main.indexOf('ComposeShortcut.apply(); // after the voice key'));
  assert.match(main, /nextShortcut: \(n\) => \{ NextShortcut\.apply\(n\); \},\n    nextShortcutSettle: \(n\) => \{ NextShortcut\.settle\(n\); \},/);
  assert.match(main, /nextShortcut: \(\) => NextShortcut\.view\(\) \}\);/);
});

const settle = () => new Promise((r) => setTimeout(r, 20));
test('widget page: the row shows the saved key and main\'s line, and Save sends only {nextShortcut}', async (t) => {
  const dom = new JSDOM(read('widget-page.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///synthetic/widget-page.html' });
  t.after(() => dom.window.close());
  const sent = [];
  const state = { config: WidgetPage.configView({ nextShortcut: 'Command+Shift+J' }), visible: true, width: 120, corner: 'top-right', limits: { minWidth: 80, maxWidth: 320 }, held: false, platform: 'darwin',
    next: { accelerator: 'Command+Shift+J', state: 'widget', line: "Your widget's show and hide key uses this, so this one is off. Pick another key." } };
  dom.window.widgetPageApi = {
    state: async () => state, preview: async () => null,
    set: async (p) => { sent.push(JSON.parse(JSON.stringify(p))); return p.nextShortcut === 'nope' ? { ok: false, error: 'Nothing to change.', state } : { ok: true, state }; },
    size: async () => ({ ok: true, state }), move: async () => ({ ok: true, state }), open: async () => {}, recentProjects: async () => [],
  };
  dom.window.eval(read('widget-page.js'));
  await settle();
  const d = dom.window.document;
  assert.equal(d.getElementById('next-shortcut').value, 'Command+Shift+J');
  assert.equal(d.getElementById('next-shortcut').placeholder, 'Off');
  assert.match(d.getElementById('next-shortcut-hint').textContent, /^Off until you set a key\./);
  assert.match(d.getElementById('next-shortcut-note').textContent, /widget's show and hide key uses this/);
  d.getElementById('next-shortcut').value = '  Alt+Shift+N  ';
  d.getElementById('next-shortcut-save').click();
  await settle();
  d.getElementById('next-shortcut').value = 'nope';
  d.getElementById('next-shortcut-save').click();
  await settle();
  assert.deepEqual(sent, [{ nextShortcut: 'Alt+Shift+N' }, { nextShortcut: 'nope' }]);
  assert.match(d.getElementById('next-shortcut-note').textContent, /not one the system accepts/);
});
