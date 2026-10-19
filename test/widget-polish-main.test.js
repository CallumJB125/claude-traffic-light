'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/widget-polish-main.js');
const Quiet = require('../src/quiet.js');
const WidgetStrip = require('../src/widget-strip.js');
const { applyConfigSideEffects } = require('../src/config-effects.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const WA = { x: 0, y: 25, width: 1440, height: 875 };
const NOW = Date.parse('2026-10-19T12:00:00Z');

function rig({ config = {}, strip = WidgetStrip.NONE, taken = [], visible = true, sessions = [] } = {}) {
  const handlers = {};
  const calls = [];
  const shortcuts = new Map();
  let cfg = { ...config };
  let bounds = { x: 40, y: 400, width: 107, height: 137 };
  let shown = visible;
  const win = {
    isDestroyed: () => false, isVisible: () => shown, getBounds: () => ({ ...bounds }),
    setPosition: (x, y) => { calls.push(['pos', x, y]); bounds = { ...bounds, x, y }; },
    setBounds: (b) => { calls.push(['bounds', b]); bounds = { ...b }; },
    setMinimumSize: (w, h) => calls.push(['min', w, h]), setAspectRatio: (a) => calls.push(['aspect', a]),
    hide: () => { shown = false; calls.push(['hide']); }, show: () => { shown = true; calls.push(['show']); }, moveTop: () => calls.push(['top']),
  };
  const globalShortcut = {
    register: (acc, fn) => { calls.push(['register', acc]); if (taken.includes(acc)) return false; shortcuts.set(acc, fn); return true; },
    unregister: (acc) => { calls.push(['unregister', acc]); shortcuts.delete(acc); },
  };
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const api = P.install({
    ipcMain, globalShortcut, config: () => cfg, commitConfig: (p) => { const prev = cfg; cfg = { ...cfg, ...p }; calls.push(['commit', p]); api.configChanged(prev, cfg); return cfg; },
    widgetWindow: () => win, quiet: Quiet, widgetAllowed: (e) => e.from === 'widget', pageAllowed: (e) => e.from === 'page',
    sessions: () => sessions, strip: () => strip, saveBounds: () => calls.push(['save']), stopGlide: () => calls.push(['stopGlide']),
    screen: { getDisplayMatching: () => ({ workArea: WA }) }, sizing: { aspect: 64 / 82, minWidth: 80 }, now: () => NOW,
  });
  const ask = (ch, from = 'widget') => handlers[ch]({ from });
  return { api, ask, calls, shortcuts, handlers, cfg: () => cfg, win, bounds: () => bounds };
}

test('channels answer only their own sender', async () => {
  const r = rig();
  assert.deepEqual(Object.keys(r.handlers).sort(), ['widget-polish:snap', 'widget-polish:state', 'widget:recent-projects']);
  assert.equal(await r.ask('widget-polish:state', 'page'), null);
  assert.equal(await r.ask('widget-polish:snap', 'page'), null);
  assert.equal(await r.ask('widget:recent-projects', 'widget'), null);
});

test('state: defaults are today\'s widget; nothing registers or resizes until asked, and normal leaves the window alone', async () => {
  const r = rig();
  assert.equal(r.calls.length, 0, 'install itself touches nothing');
  const s = await r.ask('widget-polish:state');
  assert.deepEqual(s, { snap: 'corners', size: 'normal', colours: {}, quiet: false, quietUntil: null, shortcut: null, shortcutTaken: null });
  assert.equal(r.calls.filter((c) => c[0] === 'register' || c[0] === 'bounds').length, 0);
});

test('global shortcut: registered once the widget asks, toggles visibility, swapped and dropped on config change', async () => {
  const r = rig({ config: { widgetShortcut: 'CmdOrCtrl+Shift+Space' } });
  await r.ask('widget-polish:state');
  await r.ask('widget-polish:state');
  assert.deepEqual(r.calls.filter((c) => c[0] === 'register'), [['register', 'CmdOrCtrl+Shift+Space']]);
  assert.equal(r.api.shortcut, 'CmdOrCtrl+Shift+Space');
  const fire = r.shortcuts.get('CmdOrCtrl+Shift+Space');
  assert.equal(fire(), 'hidden');
  assert.equal(fire(), 'shown');
  assert.ok(r.calls.some((c) => c[0] === 'top'), 'summoned to the front');
  r.api.configChanged(r.cfg(), { ...r.cfg(), widgetShortcut: 'Alt+F12' });
  assert.deepEqual(r.calls.filter((c) => c[0] === 'register' || c[0] === 'unregister').slice(1), [['unregister', 'CmdOrCtrl+Shift+Space'], ['register', 'Alt+F12']]);
  r.api.configChanged({ widgetShortcut: 'Alt+F12' }, { widgetShortcut: '' });
  assert.deepEqual(r.calls.at(-1), ['unregister', 'Alt+F12']);
  assert.equal(r.shortcuts.size, 0);
});

test('global shortcut: never registered when empty or invalid; a taken one is reported, not retried every poll', async () => {
  for (const bad of ['', 'P', 'Hyper+Q', 42]) {
    const r = rig({ config: { widgetShortcut: bad } });
    await r.ask('widget-polish:state');
    assert.equal(r.calls.filter((c) => c[0] === 'register').length, 0, String(bad));
  }
  const r = rig({ config: { widgetShortcut: 'Alt+Space' }, taken: ['Alt+Space'] });
  const s = await r.ask('widget-polish:state');
  await r.ask('widget-polish:state');
  assert.equal(s.shortcutTaken, 'Alt+Space');
  assert.equal(s.shortcut, null);
  assert.equal(r.calls.filter((c) => c[0] === 'register').length, 1);
});

test('size: dot and compact resize about the centre and save; back to normal restores the shape', async () => {
  const r = rig({ config: { widgetSize: 'dot' } });
  await r.ask('widget-polish:state');
  assert.deepEqual(r.bounds(), { x: Math.round(40 + (107 - 52) / 2), y: Math.round(400 + (137 - 52) / 2), width: 52, height: 52 });
  assert.ok(r.calls.some((c) => c[0] === 'aspect' && c[1] === 1) && r.calls.some((c) => c[0] === 'save'));
  r.api.configChanged({ widgetSize: 'dot' }, { widgetSize: 'compact' });
  assert.equal(r.bounds().width, P.COMPACT_W);
  r.api.configChanged({ widgetSize: 'compact' }, { widgetSize: 'normal' });
  assert.equal(r.bounds().width, 107);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'aspect').at(-1), ['aspect', 64 / 82]);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'min').at(-1), ['min', 80, Math.round(80 / (64 / 82))]);
  const held = rig({ config: { widgetSize: 'dot' }, strip: { kind: 'bubble', px: 80, w: 0, dx: 0, dy: 0 } });
  await held.ask('widget-polish:state');
  assert.equal(held.calls.filter((c) => c[0] === 'bounds').length, 0, 'waits while something hangs under Claude');
});

test('snap: only in edges mode, onto the nearest edge of the widget\'s display, then saved', async () => {
  assert.deepEqual(await rig().ask('widget-polish:snap'), { ok: false });
  assert.deepEqual(await rig({ config: { widgetSnap: 'off' } }).ask('widget-polish:snap'), { ok: false });
  const r = rig({ config: { widgetSnap: 'edges' } });
  const out = await r.ask('widget-polish:snap');
  assert.deepEqual(out, { ok: true, edge: 'left' });
  assert.deepEqual(r.calls.filter((c) => c[0] === 'pos'), [['pos', 24, 400]]);
  assert.ok(r.calls.some((c) => c[0] === 'save') && r.calls.some((c) => c[0] === 'stopGlide'));
  const held = rig({ config: { widgetSnap: 'edges' }, strip: { kind: 'away', px: 64, w: 0, dx: 0, dy: 0 } });
  assert.deepEqual(await held.ask('widget-polish:snap'), { ok: false });
});

test('recent projects: live sessions first, then coloured ones, de-duplicated and capped', async () => {
  const sessions = [{ cwd: '/Users/me/work/api' }, { cwd: '/Users/me/other/api' }, { cwd: '/Users/me/web/' }, { cwd: null }];
  const r = rig({ sessions, config: { projectColours: { old: '#123456', api: '#AA0000', 'a/b': '#000000' } } });
  assert.deepEqual(await r.ask('widget:recent-projects', 'page'), [{ name: 'api', colour: '#aa0000' }, { name: 'web', colour: null }, { name: 'old', colour: '#123456' }]);
  const many = rig({ sessions: Array.from({ length: 30 }, (_, i) => ({ cwd: `/p/proj${i}` })) });
  assert.equal((await many.ask('widget:recent-projects', 'page')).length, P.RECENT_MAX);
});

test('quiet for 30 minutes: the menu item sets quietUntil, the moon shows, and End quiet clears it', async () => {
  const r = rig();
  let items = r.api.menuItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'Quiet for 30 minutes');
  items[0].click();
  assert.deepEqual(r.calls.find((c) => c[0] === 'commit'), ['commit', { quietUntil: NOW + 30 * 60000 }]);
  const s = await r.ask('widget-polish:state');
  assert.equal(s.quiet, true);
  assert.equal(s.quietUntil, NOW + 30 * 60000);
  items = r.api.menuItems();
  assert.equal(items[0].label, 'End quiet');
  assert.equal(items[0].sublabel, '30 min left');
  items[0].click();
  assert.equal(r.cfg().quietUntil, 0);
  assert.equal((await r.ask('widget-polish:state')).quiet, false);
  assert.equal((await rig({ config: { quietHours: { enabled: true, start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] } } }).ask('widget-polish:state')).quiet, true, 'quiet hours show the moon too');
});

test('config effects reach the polish module only for its own keys', () => {
  const seen = [];
  const d = new Proxy({ widgetPolish: (p, n) => seen.push([p.widgetShortcut, n.widgetShortcut]) }, { get: (t, k) => t[k] || (() => {}) });
  applyConfigSideEffects({ widgetShortcut: '' }, { widgetShortcut: 'Alt+F1' }, d);
  applyConfigSideEffects({ sounds: true }, { sounds: false }, d);
  assert.deepEqual(seen, [['', 'Alt+F1']]);
});

test('wiring: one install line, one effect hook and one menu spread in main; one preload line each', () => {
  const main = read('main.js');
  assert.equal((main.match(/WidgetPolish/g) || []).length, 3);
  assert.match(main, /require\('\.\/src\/widget-polish-main\.js'\)\.install\(\{ ipcMain, globalShortcut,/);
  assert.match(read('preload.js'), /polish: \{ state: \(\) => ipcRenderer\.invoke\('widget-polish:state'\), snap: \(\) => ipcRenderer\.invoke\('widget-polish:snap'\) \}/);
  assert.match(read('widget-page-preload.js'), /recentProjects: \(\) => ipcRenderer\.invoke\('widget:recent-projects'\)/);
  const contract = read('board/CONTRACT.md');
  for (const ch of ['widget-polish:state', 'widget-polish:snap', 'widget:recent-projects']) assert.ok(contract.includes(`| \`${ch}\` |`), ch);
});
