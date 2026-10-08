'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createOptimiser, BAR_H, PARTITION } = require('../buddy-window/optimiser.js');
const { createViewLifecycle } = require('../src/view-lifecycle.js');
const { PAGES, SECTIONS, sectionsFor, pageById, sectionOf } = require('../buddy-window/pages.js');

const ASIDE = fs.readFileSync(path.join(__dirname, 'fixtures', 'burst-aside.html'), 'utf8');
const URL_ = 'http://127.0.0.1:7788/';
const present = (over = {}) => ({ d: { kind: 'present', pid: 41, state: { version: '0.19.0', active: true, route: 'PRIMARY', rejected: [], primaryFailures: 0, until: '', mode: 'base-url', compaction: null }, ...over }, url: URL_ });
const down = () => ({ d: { kind: 'unreachable' }, url: null });
const untrusted = () => ({ d: { kind: 'untrusted', reason: 'Not Burst.' }, url: null });
const settle = () => new Promise((r) => setImmediate(r));

function fakeView(opts) {
  const wc = new EventEmitter();
  Object.assign(wc, {
    closed: false, loaded: [], reloads: 0, scripts: [], handlers: {},
    isDestroyed: () => wc.closed,
    close: () => { wc.closed = true; },
    loadURL: (u) => { wc.loaded.push(u); return Promise.resolve(); },
    reload: () => { wc.reloads++; },
    setWindowOpenHandler: (fn) => { wc.handlers.open = fn; },
    executeJavaScript: async (js) => { wc.scripts.push(js); return js.includes('outerHTML') ? ASIDE : 'click'; },
    session: { webRequest: { onBeforeRequest: (f, fn) => { wc.handlers.request = fn; wc.filter = f; } } },
  });
  return { opts, webContents: wc, bounds: null, setBounds(b) { this.bounds = b; } };
}

function rig({ snap = present(), selected = true, content = true } = {}) {
  const r = { snap, selected, content, views: [], hardened: [], external: [], states: [], navPings: 0, children: [], acts: [], refreshes: [], injected: [] };
  const win = { contentView: { children: r.children, addChildView: (v) => r.children.push(v), removeChildView: (v) => { const i = r.children.indexOf(v); if (i >= 0) r.children.splice(i, 1); } } };
  const burst = {
    snapshot: () => r.snap,
    refresh: async (f) => { r.refreshes.push(f); },
    act: async (k) => { r.acts.push(k); return { ok: true }; },
  };
  r.timers = new Map();
  let n = 0;
  r.o = createOptimiser({
    newView: (o) => { const v = fakeView(o); r.views.push(v); return v; },
    harden: (s) => r.hardened.push(s),
    dispose: (v) => { win.contentView.removeChildView(v); v.webContents.close(); },
    openExternal: (u) => r.external.push(u),
    burst: () => burst,
    win: () => win,
    isContent: () => r.content,
    isSelected: () => r.selected,
    bounds: () => ({ x: 216, width: 800, height: 600 }),
    sendState: () => r.states.push(r.o.payload()),
    navChanged: () => { r.navPings++; },
    platform: 'darwin',
    injector: { attach: (wc) => r.injected.push(wc) },
    setTimer: (fn) => { const id = ++n; r.timers.set(id, fn); return id; },
    clearTimer: (id) => r.timers.delete(id),
  });
  r.tick = async () => { for (const fn of [...r.timers.values()]) await fn(); await settle(); };
  return r;
}

test('nothing is loaded until the handshake says present: absent, untrusted and down show a native state and create no view', async () => {
  for (const [snap, reason] of [[{ d: { kind: 'not_installed' }, url: null }, 'not_installed'], [untrusted(), 'untrusted'], [down(), 'down']]) {
    const r = rig({ snap });
    await r.o.open();
    assert.equal(r.views.length, 0, reason);
    assert.equal(r.o.state().mode, 'empty');
    assert.equal(r.o.state().reason, reason);
    assert.equal(r.o.hasView(), false);
    assert.equal(r.children.length, 0);
  }
});

test('old Burst gets the update state and no view', async () => {
  const r = rig({ snap: present({ state: { version: '0.12.1' } }) });
  await r.o.open();
  assert.equal(r.views.length, 0);
  assert.equal(r.o.state().reason, 'old');
});

test('trusted: one dedicated view in its own partition, no preload, sandboxed, loaded from the exact origin only after the handshake', async () => {
  const r = rig();
  await r.o.open();
  assert.equal(r.views.length, 1);
  const p = r.views[0].opts.webPreferences;
  assert.deepEqual(p, { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, safeDialogs: true });
  assert.equal(PARTITION, 'persist:burst-dashboard');
  assert.ok(!('preload' in p));
  assert.deepEqual(r.views[0].webContents.loaded, [URL_]);
  assert.equal(r.hardened.length, 1);
  assert.equal(r.injected[0], r.views[0].webContents);
  assert.equal(r.o.state().mode, 'ready');
  assert.equal(r.o.payload().canBrowser, true);
});

test('the view overlays the page below the top bar, only while the optimiser is the content', async () => {
  const r = rig();
  await r.o.open();
  assert.deepEqual(r.children, [r.views[0]]);
  assert.deepEqual(r.views[0].bounds, { x: 216, y: BAR_H, width: 800, height: 600 - BAR_H });
  r.content = false; r.o.sync();
  assert.deepEqual(r.children, []);
  r.content = true; r.o.sync();
  assert.deepEqual(r.children, [r.views[0]]);
});

test('navigation lock: will-navigate, will-redirect and frame navigations obey the allow-list', async () => {
  const r = rig();
  await r.o.open();
  const wc = r.views[0].webContents;
  for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    const go = (url) => { let prevented = false; wc.emit(ev, { preventDefault: () => { prevented = true; } }, url); return prevented; };
    assert.equal(go(`${URL_}api/state`), false, ev);
    assert.equal(go('https://evil.test/'), true, ev);
    assert.equal(go('http://127.0.0.1:9999/'), true, ev);
    assert.equal(go('file:///etc/hosts'), true, ev);
  }
  assert.deepEqual(r.external, []);
  const link = (url) => { let prevented = false; wc.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url); return prevented; };
  assert.equal(link('https://github.com/andrewbakercloudscale/claude-burst'), true);
  assert.deepEqual(r.external, ['https://github.com/andrewbakercloudscale/claude-burst']);
  assert.equal(link('http://github.com/x'), true);
  assert.equal(r.external.length, 1, 'plain http is never handed out');
});

test('window.open is always denied; allow-listed https goes to the browser, nothing else does', async () => {
  const r = rig();
  await r.o.open();
  const open = r.views[0].webContents.handlers.open;
  assert.deepEqual(open({ url: `${URL_}x` }), { action: 'deny' });
  assert.deepEqual(open({ url: 'https://docs.anthropic.com/en/docs/claude-code' }), { action: 'deny' });
  assert.deepEqual(open({ url: 'https://evil.test/' }), { action: 'deny' });
  assert.deepEqual(r.external, ['https://docs.anthropic.com/en/docs/claude-code']);
});

test('requests outside Burst\'s origin are cancelled', async () => {
  const r = rig();
  await r.o.open();
  const wc = r.views[0].webContents;
  assert.deepEqual(wc.filter.urls.every((u) => /^(https?|wss?):/.test(u)), true);
  const ask = (url) => { let out; wc.handlers.request({ url }, (x) => { out = x; }); return out.cancel; };
  assert.equal(ask(`${URL_}api/state`), false);
  assert.equal(ask('https://fonts.example/x.css'), true);
  assert.equal(ask('http://127.0.0.1:1/'), true);
});

test('sub-nav is read from the page at load, shown natively, and a section click runs one whitelisted script', async () => {
  const r = rig();
  await r.o.open();
  const wc = r.views[0].webContents;
  wc.emit('dom-ready');
  await settle();
  const labels = r.o.nav().map((n) => n.label);
  assert.ok(labels.includes('Burst: Overview') && labels.includes('Spend') && labels.includes('Routing'), labels.join());
  assert.ok(r.o.nav().length <= 10);
  assert.ok(r.navPings >= 1);
  assert.equal(r.o.section('sec-models'), true);
  assert.equal(r.o.active(), 'sec-models');
  assert.match(wc.scripts.at(-1), /\("sec-models"\)$/);
  const before = wc.scripts.length;
  assert.equal(r.o.section('sec-not-in-the-menu'), false);
  assert.equal(r.o.section('x");alert(1)//'), false);
  assert.equal(wc.scripts.length, before);
});

test('trust is re-checked on every (re)load: a reload of an untrusted Burst drops the view for the native state', async () => {
  const r = rig();
  await r.o.open();
  const wc = r.views[0].webContents;
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  await settle();
  assert.equal(r.views.length, 1, 'the first navigation is our own load');
  r.snap = untrusted();
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  await settle();
  assert.equal(r.o.state().reason, 'untrusted');
  assert.equal(wc.closed, true);
  assert.equal(r.o.hasView(), false);
  assert.deepEqual(r.children, []);
  assert.deepEqual(r.o.nav(), []);
});

test('Refresh re-checks and reloads the same trusted Burst instead of building another view', async () => {
  const r = rig();
  await r.o.open();
  const before = r.refreshes.length;
  await r.o.refresh({ reload: true });
  assert.equal(r.refreshes.length, before + 1);
  assert.equal(r.views.length, 1);
  assert.equal(r.views[0].webContents.reloads, 1);
});

test('a different Burst process (new pid) gets a fresh view, the old one is closed', async () => {
  const r = rig();
  await r.o.open();
  r.snap = present({ pid: 99 });
  await r.o.refresh();
  assert.equal(r.views.length, 2);
  assert.equal(r.views[0].webContents.closed, true);
  assert.deepEqual(r.children, [r.views[1]]);
});

test('Burst stops while shown: the watcher swaps to "Burst isn\'t answering" with Repair; it comes back when Burst does', async () => {
  const r = rig();
  await r.o.open();
  assert.equal(r.timers.size, 1);
  r.snap = down();
  await r.tick();
  assert.equal(r.o.state().headline, "Burst isn't answering");
  assert.equal(r.o.state().actions[0].kind, 'repair');
  assert.equal(r.views[0].webContents.closed, true);
  assert.equal(r.states.at(-1).mode, 'empty');
  r.snap = present();
  await r.tick();
  assert.equal(r.o.state().mode, 'ready');
  assert.equal(r.views.length, 2);
});

test('an unchanged Burst is not re-applied on each poll, and polling stops once the page is no longer selected', async () => {
  const r = rig();
  await r.o.open();
  const sent = r.states.length;
  await r.tick();
  assert.equal(r.states.length, sent);
  r.selected = false;
  await r.tick();
  assert.equal(r.timers.size, 0);
});

test('a dashboard that fails to load twice is replaced by the native state', async () => {
  const r = rig();
  await r.o.open();
  const wc = r.views[0].webContents;
  wc.emit('did-fail-load', {}, -102, 'refused', URL_, true);
  await settle();
  assert.equal(r.o.state().mode, 'ready', 'one failure re-checks and reloads');
  wc.emit('did-fail-load', {}, -102, 'refused', URL_, true);
  await settle();
  assert.equal(r.o.state().mode, 'empty');
  assert.equal(r.o.hasView(), false);
  wc.emit('did-fail-load', {}, -3, 'aborted', URL_, true);
});

test('a crashed renderer is rebuilt after a fresh trust check', async () => {
  const r = rig();
  await r.o.open();
  r.views[0].webContents.emit('render-process-gone');
  await settle();
  assert.equal(r.views.length, 2);
  assert.equal(r.views[0].webContents.closed, true);
});

test('page actions are an allow-list; consent stays with the existing Burst flow', async () => {
  const r = rig({ snap: down() });
  await r.o.open();
  assert.deepEqual(await r.o.act('rm -rf'), { ok: false, error: 'Unknown action.' });
  assert.deepEqual(await r.o.act('open-dashboard'), { ok: false, error: 'Unknown action.' });
  assert.deepEqual(await r.o.act('repair'), { ok: true });
  assert.deepEqual(r.acts, ['repair']);
  await r.o.openBrowser();
  assert.deepEqual(r.acts, ['repair', 'open-browser']);
});

test('view lifecycle: the dashboard goes with its page, immediately when pushed out or after 60 s hidden, and is rebuilt on return', async () => {
  const r = rig();
  const pending = new Map();
  let n = 0;
  const lc = createViewLifecycle({
    destroy: (id) => { if (id === 'optimiser') r.o.drop(); },
    setTimer: (fn) => { pending.set(++n, fn); return n; },
    clearTimer: (t) => pending.delete(t),
  });
  lc.setCurrent('optimiser');
  await r.o.open();
  assert.equal(r.o.hasView(), true);
  lc.setCurrent('usage');
  assert.equal(r.o.hasView(), true, 'kept for the grace period');
  for (const fn of [...pending.values()]) fn();
  assert.equal(r.o.hasView(), false);
  assert.equal(r.views[0].webContents.closed, true);
  lc.setCurrent('optimiser');
  await r.o.open();
  assert.equal(r.views.length, 2);
  lc.setCurrent('stats');
  lc.setCurrent('settings');
  assert.equal(r.o.hasView(), false, 'a third page pushes it out at once');
});

test('without Burst wiring (or off macOS) the page is still a native state, never blank', async () => {
  const r = rig();
  const o = createOptimiser({ ...{}, newView() { throw new Error('no view'); }, harden() {}, dispose() {}, openExternal() {}, burst: () => null, win: () => null, isContent: () => true, isSelected: () => true, bounds: () => ({ x: 0, width: 1, height: 100 }), sendState() {}, navChanged() {}, platform: 'linux' });
  await o.open();
  assert.equal(o.state().mode, 'empty');
  assert.equal(o.state().reason, 'unsupported');
  assert.equal(o.payload().canBrowser, false);
  o.stop();
  assert.equal(r.o.payload().mode, 'loading', 'before the first check there is a loading payload');
});

test('page registry: Usage optimiser is a local page of its own section, listed for every user', () => {
  const p = pageById('optimiser');
  assert.equal(p.title, 'Usage optimiser');
  assert.equal(p.kind, 'local');
  assert.ok(!p.macOnly && !p.burstOnly, 'the tool hub is for everyone; Burst-only parts say so inside the page');
  assert.ok(fs.existsSync(path.join(__dirname, '..', p.file)) && fs.existsSync(path.join(__dirname, '..', p.preload)));
  assert.deepEqual(SECTIONS.find((s) => s.id === 'usage').pages, ['usage', 'stats']);
  assert.equal(sectionOf('optimiser'), 'optimiser');
  assert.deepEqual(sectionsFor('darwin').find((s) => s.id === 'optimiser').pages, ['optimiser']);
  assert.deepEqual(sectionsFor('win32').find((s) => s.id === 'optimiser').pages, ['optimiser']);
  assert.deepEqual(sectionsFor('linux').find((s) => s.id === 'optimiser').pages, ['optimiser']);
  assert.deepEqual(PAGES.filter((x) => x.macOnly || x.burstOnly), []);
});

test('tab strip: the embedded view is hidden on Route and Requests and restored on Dashboard', async () => {
  const r = rig();
  await r.o.open();
  assert.equal(r.o.payload().tab, 'dashboard');
  assert.deepEqual(r.children, [r.views[0]]);
  assert.deepEqual(await r.o.act('tab:route'), { ok: true });
  assert.deepEqual(r.children, []);
  assert.equal(r.o.payload().tab, 'route');
  assert.equal(r.states.at(-1).tab, 'route');
  await r.o.act('tab:requests');
  assert.deepEqual(r.children, []);
  assert.equal(r.o.hasView(), true, 'the dashboard stays loaded behind the native tabs');
  await r.o.act('tab:dashboard');
  assert.deepEqual(r.children, [r.views[0]]);
  assert.equal(r.views.length, 1);
  assert.deepEqual(r.acts, [], 'tab changes never reach Burst');
});

test('tab strip: unknown tabs are refused; no tabs unless Burst is ready; a section click returns to Dashboard', async () => {
  const r = rig();
  await r.o.open();
  assert.deepEqual(await r.o.act('tab:evil'), { ok: false });
  assert.equal(r.o.payload().tab, 'dashboard');
  r.views[0].webContents.emit('dom-ready');
  await settle();
  await r.o.act('tab:route');
  assert.equal(r.o.section('sec-models'), true);
  assert.equal(r.o.payload().tab, 'dashboard');
  assert.deepEqual(r.children, [r.views[0]]);

  const off = rig({ snap: down() });
  await off.o.open();
  assert.deepEqual(await off.o.act('tab:route'), { ok: false });
  assert.equal(off.o.payload().tab, 'dashboard');
});

test('tab resets to Dashboard when Burst stops being present', async () => {
  const r = rig();
  await r.o.open();
  await r.o.act('tab:route');
  r.snap = down();
  await r.o.refresh();
  assert.equal(r.o.state().mode, 'empty');
  r.snap = present();
  await r.o.refresh();
  assert.equal(r.o.payload().tab, 'dashboard');
  assert.deepEqual(r.children, [r.views[r.views.length - 1]]);
});
