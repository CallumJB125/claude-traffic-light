'use strict';
// Redesign R7-2: the Usage tab strip (buddy-window/index.js, usage-tabs.html), chat-first preview only. Shipped source
// in a vm, as test/newchat-window-authority.test.js does: the strip's own view (sandboxed, locked, not a local page),
// shown only over the five tabs, layout() moving the content and Burst's embedded view below it (and identical with
// the preview off), its one effect (a closed id table, from the strip's own document, while it shows), its push
// ({selected} only), retirement, and that no other guard accepts it (review S3).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const Pages = require('../buddy-window/pages.js');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'buddy-window/index.js'), 'utf8');
const optSrc = fs.readFileSync(path.join(root, 'buddy-window/optimiser.js'), 'utf8');
const between = (text, a, b) => { const i = text.indexOf(a); const j = text.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, `${a} … ${b}`); return text.slice(i, j); };
// vm objects are another realm: compare as JSON.
const same = (a, b, m) => assert.deepEqual(a === undefined ? a : JSON.parse(JSON.stringify(a)), b, m);
const TABS = ['usage:today', 'usage', 'stats', 'optimiser', 'clients'];

function world({ chatFirst = true, selected = 'usage' } = {}) {
  const dir = '/synthetic/app/buddy-window';
  let nextId = 80;
  const made = [], locked = [], disposed = [], sends = [], selects = [], ipc = new Map();
  const mkWc = (href = '') => { const wc = new EventEmitter(); Object.assign(wc, { id: nextId++, url: href, destroyed: false, mainFrame: { url: href }, getURL: () => wc.url, isDestroyed: () => wc.destroyed, send: (ch, m) => sends.push([wc.id, ch, m]) }); return wc; };
  class WebContentsView {
    constructor(opts) {
      this.opts = opts; this.bounds = null; made.push(this);
      const wc = mkWc(); this.webContents = wc;
      wc.loadFile = (file) => { wc.url = pathToFileURL(file).href; wc.mainFrame = { url: wc.url }; return Promise.resolve(); };
    }
    setBounds(b) { this.bounds = b; }
    setBackgroundColor() {}
  }
  const page = (id) => { const v = new WebContentsView({}); v.webContents.url = `file:///${id}.html`; return v; };
  const localViews = new Map(TABS.map((id) => [id, page(id)]));
  localViews.set('board', page('board'));
  const children = [];
  const win = { isDestroyed: () => false, getContentBounds: () => ({ width: 1216, height: 800 }), contentView: { children, addChildView: (v) => { if (!children.includes(v)) children.push(v); }, removeChildView: (v) => { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); } } };
  made.length = 0; // only views the strip code makes count below
  const burst = { bounds: null, setBounds(b) { this.bounds = b; } };
  const ctx = {
    chatFirst, win, selected, content: localViews.get(selected), localViews, sidebar: null, path, pathToFileURL, DIR: dir, WebContentsView, nativeTheme: { shouldUseDarkColors: false },
    SIDEBAR_W: 216, USAGE_TABS_H: 40, USAGE_TAB_IDS: Pages.USAGE_TAB_IDS,
    lockLocal: (v) => locked.push(v), dispose: (v) => { disposed.push(v); v.webContents.destroyed = true; },
    select: (id) => { selects.push(id); ctx.selected = id; ctx.content = localViews.get(id) ?? null; },
    ipcMain: { on: (ch, fn) => ipc.set(ch, fn), handle: (ch, fn) => ipc.set(ch, fn) },
    burst, BAR_H: 44,
  };
  const layout = between(src, '  function layout() {', '  function attach(view) {');
  const effect = between(src, "  // R7-2: the Usage tab strip's one effect", '  // A sidebar row opens its thread');
  const bounds = /    bounds: \(\) => \{[^\n]+\n/.exec(src)[0].replace('    bounds: ', 'const bounds = ').replace(/,\n$/, ';\n');
  const optLayout = between(optSrc, '  function layout() {', '  // The handshake result');
  vm.runInNewContext(`
    const optimiser = { layout() { optLayout(); } };
    ${layout}
    ${effect}
    ${bounds}
    const optLayout = (() => { const view = burst, win = () => ({ contentView: { children: [burst] } }); return ${optLayout.replace('function layout()', 'function ()').trim()}; })();
    globalThis.api = { layout, fromUsageTabs, sendUsageTabs, usageTabsShown, dropUsageTabs, strip: () => usageTabsView, bounds };`, ctx);
  return { ctx, api: ctx.api, made, locked, disposed, sends, selects, ipc, children, burst, localViews };
}
const stripEv = (w) => { const wc = w.api.strip().webContents; return { sender: wc, senderFrame: wc.mainFrame }; };

test('gate off: no strip, no channel, and layout() puts the content at the top as before', () => {
  for (const sel of TABS) {
    const w = world({ chatFirst: false, selected: sel });
    w.api.layout();
    assert.equal(w.api.strip(), null);
    assert.equal(w.made.length, 0);
    same(w.ctx.content.bounds, { x: 216, y: 0, width: 1000, height: 800 });
    assert.equal(w.ipc.has('usage-tabs:select'), false);
    same(w.api.bounds(), { x: 216, y: 0, width: 1000, height: 800 });
  }
});

test('gate on: over each of the five tabs the strip shows, sandboxed and locked, and the content moves below it', () => {
  for (const sel of TABS) {
    const w = world({ selected: sel });
    w.api.layout();
    const v = w.api.strip();
    assert.ok(v, sel);
    same(v.opts.webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join('/synthetic/app', 'usage-tabs-preload.js') });
    assert.ok(w.locked.includes(v));
    assert.ok(![...w.localViews.values()].includes(v), 'not a local page');
    same(v.bounds, { x: 216, y: 0, width: 1000, height: 40 });
    same(w.ctx.content.bounds, { x: 216, y: 40, width: 1000, height: 760 });
    assert.ok(w.children.includes(v));
  }
});

test('the Burst embedded view sits below the strip too (review nit)', () => {
  const w = world({ selected: 'optimiser' });
  w.api.layout();
  same(w.burst.bounds, { x: 216, y: 40 + 44, width: 1000, height: 760 - 44 });
  const off = world({ chatFirst: false, selected: 'optimiser' });
  off.api.layout();
  same(off.burst.bounds, { x: 216, y: 44, width: 1000, height: 800 - 44 }, 'as before with the preview off');
});

test('the strip hides over any other page, and is rebuilt after its renderer goes; closing drops it', () => {
  const w = world({ selected: 'usage' });
  w.api.layout();
  const v = w.api.strip();
  w.ctx.selected = 'board'; w.ctx.content = w.localViews.get('board');
  w.api.layout();
  assert.ok(!w.children.includes(v));
  same(w.ctx.content.bounds, { x: 216, y: 0, width: 1000, height: 800 });
  w.ctx.selected = 'stats'; w.ctx.content = w.localViews.get('stats');
  w.api.layout();
  assert.equal(w.api.strip(), v, 'kept while the window lives');
  v.webContents.emit('render-process-gone');
  assert.equal(w.api.strip(), null);
  assert.ok(w.disposed.includes(v));
  w.api.layout();
  assert.notEqual(w.api.strip(), v, 'a new one');
  const n = w.api.strip();
  w.api.dropUsageTabs();
  assert.equal(w.api.strip(), null);
  assert.ok(w.disposed.includes(n));
});

test('usage-tabs:select: one of the five, from the strip\'s own document, while it shows; anything else does nothing', () => {
  const w = world({ selected: 'usage' });
  w.api.layout();
  const on = w.ipc.get('usage-tabs:select');
  const e = stripEv(w);
  for (const bad of [[], ['home'], ['settings:general'], ['usage:today', 'x'], [{ id: 'stats' }], ['thread'], ['newchat']]) on(e, ...bad);
  same(w.selects, []);
  on(e, 'usage');
  same(w.selects, [], 'already showing');
  on({ sender: e.sender, senderFrame: { url: 'about:srcdoc' } }, 'stats');
  on({ sender: w.localViews.get('usage').webContents, senderFrame: w.localViews.get('usage').webContents.mainFrame }, 'stats');
  same(w.selects, [], 'a subframe, or the Usage page itself');
  on(e, 'stats');
  same(w.selects, ['stats']);
  // Not showing (another page selected): ignored, even from the strip.
  w.ctx.selected = 'board'; w.ctx.content = w.localViews.get('board');
  on(e, 'clients');
  same(w.selects, ['stats']);
  // A strip document that navigated elsewhere is not the strip.
  w.ctx.selected = 'usage'; w.ctx.content = w.localViews.get('usage');
  e.sender.url = 'file:///elsewhere.html';
  on(e, 'clients');
  same(w.selects, ['stats']);
});

test('the push is {selected} only, and null for a page that is not a tab', () => {
  const w = world({ selected: 'clients' });
  w.api.layout();
  w.api.sendUsageTabs();
  const id = w.api.strip().webContents.id;
  same(w.sends.filter((s) => s[0] === id).map((s) => [s[1], s[2]]), [['usage-tabs:state', { selected: 'clients' }]]);
  w.ctx.selected = 'board';
  w.api.sendUsageTabs();
  same(w.sends.at(-1)[2], { selected: null });
});

test('the strip\'s bridge is exactly select and onState, and no other guard names it', () => {
  const pre = fs.readFileSync(path.join(root, 'usage-tabs-preload.js'), 'utf8');
  same([...pre.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]), ['select', 'onState']);
  same([...pre.matchAll(/ipcRenderer\.(\w+)\('([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`), ['send usage-tabs:select', 'on usage-tabs:state']);
  assert.match(fs.readFileSync(path.join(root, 'usage-tabs.html'), 'utf8'), /default-src 'none'; script-src 'self'/);
  // Only fromUsageTabs and the strip's own lifecycle refer to it.
  const uses = [...src.matchAll(/usageTabsView/g)].length;
  const own = between(src, '  // ── Usage tab strip', '  function attach(view) {');
  assert.equal([...own.matchAll(/usageTabsView/g)].length, uses, 'every use of the strip view is in its own block');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.doesNotMatch(main, /usage-tabs|usageTabs/, 'main.js has no guard that knows the strip');
  // The sidebar's Usage row opens Today and is current on all five tabs.
  const chat = fs.readFileSync(path.join(root, 'buddy-window/sidebar-chat.js'), 'utf8');
  assert.match(chat, /\{ id: 'usage:today', label: 'Usage', [^\n]*tabs: \['usage:today', 'usage', 'stats', 'optimiser', 'clients'\] \}/);
  same([...Pages.USAGE_TAB_IDS], TABS);
});

test('the strip page: five tabs in order, arrow keys move between them', () => {
  const html = fs.readFileSync(path.join(root, 'usage-tabs.html'), 'utf8');
  same([...html.matchAll(/data-id="([^"]+)">([^<]+)</g)].map((m) => [m[1], m[2]]), Pages.USAGE_TABS.map((t) => [t.id, t.label]));
  const js = fs.readFileSync(path.join(root, 'usage-tabs.js'), 'utf8');
  assert.match(js, /ArrowRight: i \+ 1, ArrowLeft: i - 1, Home: 0, End: tabs\.length - 1/);
});
