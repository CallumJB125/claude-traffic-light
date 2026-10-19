'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const W = require('../src/widget-page.js');
const WidgetStrip = require('../src/widget-strip.js');
const { pageById, sectionOf } = require('../buddy-window/pages.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 20));
const WA = { x: 0, y: 25, width: 1440, height: 875 };

test('only the widget keys Preferences already has are accepted; the two worker kinds stay together', () => {
  assert.equal(W.cleanPatch(null), null);
  assert.equal(W.cleanPatch({ rules: [], hooks: true, showWidget: 'yes' }), null);
  assert.deepEqual(W.cleanPatch({ showWidget: false, showTasks: true, agentChipSize: 'large', evil: 1 }), { showWidget: false, showTasks: true, agentChipSize: 'large' });
  assert.equal(W.cleanPatch({ agentChipSize: 'huge' }), null);
  assert.deepEqual(W.cleanPatch({ agentKinds: { ralph: false, nope: true } }, { agentKinds: { subagent: true, teammate: false, ralph: true, ultrawork: true } }), { agentKinds: { subagent: true, teammate: false, ralph: false, ultrawork: false } });
});

test('corners sit inside the work area by the margin; the nearest corner follows the centre', () => {
  const base = { x: 600, y: 300, width: 100, height: 128 };
  assert.deepEqual(W.cornerPoint(base, WA, 'top-left'), { x: 24, y: 49 });
  assert.deepEqual(W.cornerPoint(base, WA, 'bottom-right'), { x: 1440 - 100 - 24, y: 25 + 875 - 128 - 24 });
  assert.equal(W.nearestCorner({ x: 1300, y: 60, width: 100, height: 128 }, WA), 'top-right');
  assert.equal(W.nearestCorner({ x: 10, y: 700, width: 100, height: 128 }, WA), 'bottom-left');
});

function rig({ visible = true, strip = WidgetStrip.NONE, busy = false, config = {} } = {}) {
  const h = {};
  const calls = [];
  let bounds = { x: 1300, y: 80, width: 100, height: 128 };
  let cfg = { showWidget: true, ...config };
  const win = {
    isDestroyed: () => false, isVisible: () => visible, getBounds: () => ({ ...bounds }),
    setPosition: (x, y) => { calls.push(['pos', x, y]); bounds = { ...bounds, x, y }; },
    webContents: { capturePage: async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AAAA' }) },
  };
  const api = W.register({
    utilityHandle: (c, allowed, f) => { h[c] = (e, ...a) => (allowed(e) ? f(e, ...a) : null); },
    allowed: (e) => e.from === 'widget',
    loadConfig: () => cfg, commitConfig: (p) => { calls.push(['commit', p]); cfg = { ...cfg, ...p }; return cfg; },
    widget: () => win, strip: () => strip, ensureWidget: () => calls.push(['ensure']),
    resizeBy: (f) => { calls.push(['resize', f]); const w = Math.round(bounds.width * f); bounds = { ...bounds, width: w, height: Math.round(w / (64 / 82)) }; },
    busy: () => busy, stopGlide: () => calls.push(['stopGlide']), saveBounds: () => calls.push(['save']),
    screen: { getDisplayMatching: () => ({ workArea: WA }) }, limits: { minWidth: 80, maxWidth: 320 },
    openPage: (id) => calls.push(['open', id]), platform: 'darwin',
  });
  const ask = (c, ...a) => h[c]({ from: 'widget' }, ...a);
  return { h, ask, calls, api, cfg: () => cfg };
}

test('every channel answers only the Widget page', async () => {
  const r = rig();
  for (const c of ['widget-page:state', 'widget-page:preview', 'widget-page:set', 'widget-page:size', 'widget-page:move', 'widget-page:open']) assert.equal(await r.h[c]({ from: 'settings' }, {}), null, c);
});

test('state reads config and the widget\'s own rect; preview is a capture only while it is visible', async () => {
  const r = rig({ config: { showTasks: false, agentKinds: { ultrawork: false, ralph: false } } });
  const s = await r.ask('widget-page:state');
  assert.equal(s.visible, true);
  assert.equal(s.width, 100);
  assert.equal(s.corner, 'top-right');
  assert.equal(s.config.showTasks, false);
  assert.equal(s.config.agentKinds.ralph, false);
  assert.match(await r.ask('widget-page:preview'), /^data:image\/png;base64,/);
  assert.equal(await rig({ visible: false }).ask('widget-page:preview'), null);
});

test('show, hide and extras go through the same config commit as Preferences; showing makes sure the window exists', async () => {
  const r = rig({ config: { showWidget: false } });
  const out = await r.ask('widget-page:set', { showWidget: true, rules: ['x'] });
  assert.equal(out.ok, true);
  assert.deepEqual(r.calls.slice(0, 2), [['commit', { showWidget: true }], ['ensure']]);
  assert.equal((await r.ask('widget-page:set', { rules: [] })).ok, false);
});

test('size is clamped to the widget\'s limits and resizes about its centre', async () => {
  const r = rig();
  let out = await r.ask('widget-page:size', 200);
  assert.equal(out.ok, true);
  assert.deepEqual(r.calls.at(-1), ['resize', 2]);
  assert.equal(out.state.width, 200);
  out = await r.ask('widget-page:size', 9999);
  assert.deepEqual(r.calls.at(-1), ['resize', 320 / 200]);
  assert.equal((await r.ask('widget-page:size', 'big')).ok, false);
});

test('move snaps to a corner of the widget\'s display and saves; refused while something hangs under Claude or it roams', async () => {
  const r = rig();
  const out = await r.ask('widget-page:move', 'bottom-left');
  assert.equal(out.ok, true);
  assert.deepEqual(r.calls.filter((c) => c[0] === 'pos'), [['pos', 24, 25 + 875 - 128 - 24]]);
  assert.ok(r.calls.some((c) => c[0] === 'save') && r.calls.some((c) => c[0] === 'stopGlide'));
  assert.equal(out.state.corner, 'bottom-left');
  assert.equal((await r.ask('widget-page:move', 'middle')).ok, false);
  const held = rig({ strip: { kind: 'bubble', px: 80, w: 0, dx: 0, dy: 0 } });
  assert.equal((await held.ask('widget-page:move', 'top-left')).ok, false);
  assert.equal((await held.ask('widget-page:size', 200)).ok, false);
  assert.equal(held.calls.filter((c) => c[0] === 'pos' || c[0] === 'resize').length, 0);
  assert.equal((await rig({ busy: true }).ask('widget-page:move', 'top-left')).ok, false);
});

test('open only reaches Widget rules and Preferences', async () => {
  const r = rig();
  await r.ask('widget-page:open', 'lights');
  await r.ask('widget-page:open', 'settings');
  await r.ask('widget-page:open', 'account');
  assert.deepEqual(r.calls.filter((c) => c[0] === 'open'), [['open', 'lights'], ['open', 'settings']]);
});

test('registry: Widget lives in the Settings section with Widget rules, packaged with a locked-down page', () => {
  const p = pageById('widget');
  assert.equal(p.kind, 'local');
  assert.equal(sectionOf('widget'), 'settings');
  assert.equal(sectionOf('lights'), 'settings');
  const html = read('widget-page.html');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  const files = JSON.parse(read('package.json')).build.files;
  for (const f of ['widget-page.html', 'widget-page.js', 'widget-page-preload.js']) assert.ok(files.includes(f), f);
  const channels = [...read('widget-page-preload.js').matchAll(/ipcRenderer\.\w+\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(channels.length === 7 && channels.every((c) => c.startsWith('widget-page:') || c === 'widget:recent-projects'), channels.join());
  assert.match(read('main.js'), /require\('\.\/src\/widget-page\.js'\)\.register\(\{ utilityHandle, allowed: \(e\) => fromUtilityPage\(e, 'widget'\)/);
});

test('page: draws main\'s state, sends only fixed requests, and shows the preview image', async (t) => {
  const dom = new JSDOM(read('widget-page.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///synthetic/widget-page.html' });
  t.after(() => dom.window.close());
  const sent = [];
  let state = { config: W.configView({ showWidget: true, showAgents: false }), visible: true, width: 120, corner: 'top-right', limits: { minWidth: 80, maxWidth: 320 }, held: false, platform: 'darwin' };
  dom.window.widgetPageApi = {
    state: async () => state, preview: async () => 'data:image/png;base64,AAAA',
    set: async (p) => { sent.push(['set', JSON.parse(JSON.stringify(p))]); return { ok: true, state }; },
    size: async (w) => { sent.push(['size', w]); return { ok: true, state }; },
    move: async (c) => { sent.push(['move', c]); return { ok: false, error: 'The widget is busy right now; try again in a moment.', state }; },
    open: async (id) => { sent.push(['open', id]); },
  };
  dom.window.eval(read('widget-page.js'));
  await settle();
  const d = dom.window.document;
  assert.equal(d.getElementById('chip-text').textContent, 'On screen');
  assert.equal(d.getElementById('toggle').textContent, 'Hide widget');
  assert.equal(d.querySelector('[data-corner="top-right"]').getAttribute('aria-pressed'), 'true');
  assert.equal(d.getElementById('size').value, '120');
  assert.equal(d.querySelector('input[data-kind="subagent"]').disabled, true, 'agent kinds wait for agent chips');
  assert.equal(d.querySelector('#stage img').getAttribute('src'), 'data:image/png;base64,AAAA');
  d.getElementById('toggle').click();
  d.querySelector('input[data-key="showTasks"]').click();
  d.querySelector('[data-corner="bottom-left"]').click();
  d.getElementById('lights').click();
  await settle();
  assert.deepEqual(sent.slice(0, 4), [['set', { showWidget: false }], ['set', { showTasks: false }], ['move', 'bottom-left'], ['open', 'lights']]);
  assert.match(d.getElementById('where-note').textContent, /busy/);
  state = { ...state, visible: false, config: { ...state.config, showWidget: false } };
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  await settle();
  assert.equal(d.querySelector('#stage img'), null);
  assert.match(d.getElementById('off').textContent, /hidden/);
  assert.equal(d.getElementById('toggle').textContent, 'Show widget');
});

test('polish keys: snap, size, shortcut and colours are checked; defaults keep today\'s widget', () => {
  assert.deepEqual(W.cleanPatch({ widgetSnap: 'edges', widgetSize: 'dot', widgetShortcut: 'cmdorctrl+shift+space' }), { widgetSnap: 'edges', widgetSize: 'dot', widgetShortcut: 'CmdOrCtrl+Shift+Space' });
  assert.equal(W.cleanPatch({ widgetSnap: 'middle', widgetSize: 'huge', widgetShortcut: 'P' }), null);
  assert.deepEqual(W.cleanPatch({ widgetShortcut: '' }), { widgetShortcut: '' });
  assert.equal(W.cleanPatch({ widgetShortcut: 'Shift+Shift+A' }), null);
  assert.equal(W.cleanPatch({ widgetShortcut: 'Hyper+A' }), null);
  assert.deepEqual(W.cleanPatch({ projectColours: { web: '#AABBCC', api: null, 'a/b': '#000000', bad: 'red' } }, { projectColours: { api: '#111111', keep: '#222222' } }), { projectColours: { keep: '#222222', web: '#aabbcc' } });
  assert.equal(W.cleanPatch({ projectColours: { nope: 'blue' } }), null);
  const v = W.configView({});
  assert.equal(v.widgetSnap, 'corners');
  assert.equal(v.widgetSize, 'normal');
  assert.equal(v.widgetShortcut, '');
  assert.deepEqual(v.projectColours, {});
  assert.deepEqual(W.configView({ projectColours: { api: '#ABCDEF', x: 3 } }).projectColours, { api: '#abcdef' });
});

test('snapPoint: within the threshold of an edge it slides onto it; near two it lands in the corner; far away it stays', () => {
  const at = (x, y) => ({ x, y, width: 100, height: 128 });
  assert.deepEqual(W.snapPoint(at(40, 400), WA), { x: 24, y: 400, edge: 'left' });
  assert.deepEqual(W.snapPoint(at(1300, 400), WA), { x: 1316, y: 400, edge: 'right' });
  assert.deepEqual(W.snapPoint(at(700, 60), WA), { x: 700, y: 49, edge: 'top' });
  assert.deepEqual(W.snapPoint(at(700, 740), WA), { x: 700, y: 748, edge: 'bottom' });
  assert.deepEqual(W.snapPoint(at(30, 760), WA), { ...W.cornerPoint(at(30, 760), WA, 'bottom-left'), edge: 'bottom-left' });
  assert.deepEqual(W.snapPoint(at(600, 400), WA), { x: 600, y: 400, edge: null });
  assert.deepEqual(W.snapPoint(at(600, 300), WA, { threshold: 1000 }).edge, 'top-left');
  assert.deepEqual(W.snapPoint(at(-30, 400), WA), { x: 24, y: 400, edge: 'left' }, 'a widget dragged past the edge comes back onto it');
});

test('projectAccent: the colour of the cwd\'s last folder, only when it is a valid hex', () => {
  const map = { api: '#AA0000', web: 'red' };
  assert.equal(W.projectAccent('/Users/me/work/api', map), '#aa0000');
  assert.equal(W.projectAccent('/Users/me/work/api/', map), '#aa0000');
  assert.equal(W.projectAccent('/Users/me/work/web', map), null);
  assert.equal(W.projectAccent('/Users/me/work/toString', map), null);
  assert.equal(W.projectAccent(null, map), null);
  assert.equal(W.projectAccent('/x/api', null), null);
});

test('page: polish controls send checked requests and draw a swatch per recent project', async (t) => {
  const dom = new JSDOM(read('widget-page.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///synthetic/widget-page.html' });
  t.after(() => dom.window.close());
  const sent = [];
  const state = { config: W.configView({ widgetSnap: 'edges', widgetSize: 'dot', widgetShortcut: 'Alt+Space' }), visible: true, width: 120, corner: 'top-right', limits: { minWidth: 80, maxWidth: 320 }, held: false, platform: 'darwin' };
  dom.window.widgetPageApi = {
    state: async () => state, preview: async () => null,
    set: async (p) => { sent.push(JSON.parse(JSON.stringify(p))); return p.widgetShortcut === 'nope' ? { ok: false, error: 'Nothing to change.', state } : { ok: true, state }; },
    size: async () => ({ ok: true, state }), move: async () => ({ ok: true, state }), open: async () => {},
    recentProjects: async () => [{ name: 'api', colour: '#aa0000' }, { name: 'web', colour: null }],
  };
  dom.window.eval(read('widget-page.js'));
  await settle();
  const d = dom.window.document;
  assert.equal(d.getElementById('snap').value, 'edges');
  assert.equal(d.getElementById('wsize').value, 'dot');
  assert.equal(d.getElementById('shortcut').value, 'Alt+Space');
  const picks = d.querySelectorAll('#colours input[type="color"]');
  assert.equal(picks.length, 2);
  assert.equal(picks[0].value, '#aa0000');
  assert.equal(d.getElementById('colours-empty').hidden, true);
  d.getElementById('wsize').value = 'compact';
  d.getElementById('wsize').dispatchEvent(new dom.window.Event('change'));
  d.getElementById('shortcut').value = 'nope';
  d.getElementById('shortcut-save').click();
  picks[1].value = '#00ff00';
  picks[1].dispatchEvent(new dom.window.Event('change'));
  d.querySelector('#colours button.link').click();
  await settle();
  assert.deepEqual(sent, [{ widgetSize: 'compact' }, { widgetShortcut: 'nope' }, { projectColours: { web: '#00ff00' } }, { projectColours: { api: null } }]);
  assert.match(d.getElementById('where-note').textContent, /not one the system accepts/);
});
