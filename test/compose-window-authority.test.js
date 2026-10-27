'use strict';
// Home's task box: the shipped buddy-window authority (homeContext, homeConfirm, its exclusion with the Tasks and
// Setups dialogs, Home's retire hooks, the guarded readiness sends) and main.js's confirmDialog routing, run from
// the shipped source in a vm like test/helpers/tasks-window-authority.js. No window or dialog is opened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'buddy-window/index.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const between = (text, a, b) => { const i = text.indexOf(a); const j = text.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, `${a} … ${b}`); return text.slice(i, j); };

function world() {
  const dir = '/synthetic/app/buddy-window';
  const url = (file, q) => { const u = new URL(pathToFileURL(path.join(dir, '..', file)).href); if (q) u.searchParams.set('embedded', '1'); return u.href; };
  const state = { focused: true, visible: true, minimized: false, workspace: 'w1' };
  const mk = (id, href) => { const wc = new EventEmitter(); Object.assign(wc, { id, url: href, loading: false, destroyed: false, sent: [], mainFrame: { url: href }, getURL: () => wc.url, isLoading: () => wc.loading, isDestroyed: () => wc.destroyed, send: (ch, m) => wc.sent.push([ch, m]) }); return { webContents: wc }; };
  const views = { home: mk(41, url('home.html')), tasks: mk(42, url('tasks.html', true)), setups: mk(43, url('setups.html')) };
  const win = new EventEmitter();
  Object.assign(win, { isDestroyed: () => false, isVisible: () => state.visible, isMinimized: () => state.minimized, isFocused: () => state.focused, contentView: { children: Object.values(views) } });
  const ctx = { URL, path, pathToFileURL, DIR: dir, win, selected: 'home', content: views.home, localViews: new Map(Object.entries(views)), store: { active: () => ({ id: state.workspace }) }, Map, state };
  const methods = between(src, '    tasksContext() {', '    setupSources,') + between(src, '    homeContext() {', '    // main → page readiness sends')
    + between(src, '    focusComposer()', '    // Main-only identities.') + between(src, '    setupsContext() {', '    onActiveChange(');
  const send = between(src, '  function sendWhenReady(', '  // ── selection');
  const focus = between(src, "    win.on('blur',()=>{if(!tasksModalTicket)", "    win.on('closed'");
  vm.runInNewContext(`let tasksDocument=0,tasksGeneration=0,tasksModalTicket=null,setupModalTicket=null,setupSourcesGeneration=0,setupLocalGeneration=0,homeDocument=0,homeGeneration=0,homeModalTicket=null;const pendingSends=new Map();
    ${send}
    globalThis.api={${methods}};${focus}
    globalThis.show=(id)=>{selected=id;content=localViews.get(id);homeGeneration++;tasksGeneration++;setupLocalGeneration++;};
    globalThis.bumpHomeDocument=()=>{homeDocument++;};
    globalThis.workspaceSwitch=()=>{tasksGeneration++;homeGeneration++;};`, ctx);
  return { ctx, api: ctx.api, state, views, win };
}

test('homeContext follows the selected, visible, loaded Home page and its document', () => {
  const w = world();
  const c = w.api.homeContext();
  assert.equal(c.contents, w.views.home.webContents);
  assert.equal(c.foreground, true);
  w.state.focused = false;
  assert.equal(w.api.homeContext().foreground, false);
  for (const mutate of [(v) => v.ctx.show('tasks'), (v) => { v.state.visible = false; }, (v) => { v.state.minimized = true; }, (v) => { v.views.home.webContents.loading = true; }, (v) => { v.views.home.webContents.url += '?x=1'; }]) {
    const v = world(); mutate(v);
    assert.equal(v.api.homeContext(), null, mutate.toString());
  }
  assert.deepEqual({ ...w.api.homeDocument() }, { wcId: 41, doc: 0 });
});

test('finding 2: homeConfirm answers only for the same foreground document; Cancel and every change mid-dialog give null', async () => {
  const w = world();
  let calls = 0;
  const yes = await w.api.homeConfirm(async (owner) => { calls++; assert.equal(owner, w.win); w.win.emit('blur'); return { response: 1 }; });
  assert.equal(yes.response, 1, 'the dialog’s own blur does not void it');
  assert.equal(calls, 1);
  const no = await w.api.homeConfirm(async () => ({ response: 0 }));
  assert.equal(no.response, 0, 'Cancel comes back as Cancel (confirmDialog turns it into false)');
  for (const change of ['reload', 'page', 'workspace', 'hide', 'minimize', 'blurAfter']) {
    const v = world();
    const r = await v.api.homeConfirm(async () => {
      if (change === 'reload') v.ctx.bumpHomeDocument();
      if (change === 'page') v.ctx.show('tasks');
      if (change === 'workspace') { v.state.workspace = 'w2'; v.ctx.workspaceSwitch(); }
      if (change === 'hide') { v.state.visible = false; v.win.emit('hide'); }
      if (change === 'minimize') { v.state.minimized = true; v.win.emit('minimize'); }
      if (change === 'blurAfter') v.state.focused = false;
      return { response: 1 };
    });
    assert.equal(r, null, change);
  }
  const bg = world(); bg.state.focused = false;
  assert.equal(await bg.api.homeConfirm(async () => ({ response: 1 })), null, 'a background Home cannot open one');
});

test('finding 2: one native dialog at a time across Home, Tasks and Setups, both ways', async () => {
  const w = world();
  let release;
  const pending = w.api.homeConfirm(() => new Promise((r) => { release = r; }));
  w.ctx.show('tasks');
  assert.equal(await w.api.tasksConfirm(async () => ({ response: 1 })), null, 'Tasks refuses while Home’s is open');
  w.ctx.show('setups');
  assert.equal(await w.api.setupsConfirm(async () => ({ response: 1 })), null, 'Setups refuses while Home’s is open');
  release({ response: 1 });
  assert.equal(await pending, null, 'and Home’s own answer is void: the page changed');
  const t = world(); t.ctx.show('tasks');
  const tp = t.api.tasksConfirm(() => new Promise((r) => { release = r; }));
  t.ctx.show('home');
  assert.equal(await t.api.homeConfirm(async () => ({ response: 1 })), null, 'Home refuses while Tasks’ is open');
  release({ response: 0 }); await tp;
  const s = world(); s.ctx.show('setups');
  const sp = s.api.setupsConfirm(() => new Promise((r) => { release = r; }));
  s.ctx.show('home');
  assert.equal(await s.api.homeConfirm(async () => ({ response: 1 })), null, 'Home refuses while Setups’ is open');
  release({}); await sp;
});

test('finding 3: Home’s retire hooks bump its document and tell main which webContents retired', () => {
  const block = between(src, "      if(page.id==='home'){", "      if(page.id==='tasks'){");
  const listeners = new Map(); const retired = [];
  const ctx = { page: { id: 'home' }, v: { webContents: { id: 41, on: (n, fn) => listeners.set(n, fn), once: (n, fn) => listeners.set(n, fn) } }, homeDocument: 0, onHomeRetired: (id) => retired.push(id) };
  vm.runInNewContext(block, ctx);
  const nav = listeners.get('did-start-navigation');
  nav({ isMainFrame: false, isSameDocument: false }); nav({ isMainFrame: true, isSameDocument: true });
  assert.equal(ctx.homeDocument, 0, 'a subframe or same-document navigation keeps the document');
  nav({ isMainFrame: true, isSameDocument: false });
  listeners.get('render-process-gone')(); listeners.get('destroyed')();
  assert.equal(ctx.homeDocument, 3);
  assert.deepEqual(retired, [41, 41, 41]);
  assert.match(src, /isProtected: \(id\) => KEEP_ALIVE\.has\(id\) \|\| \(id === 'home' && /, 'Home is protected only through homeBusy');
  assert.ok(!/KEEP_ALIVE = new Set\(\[[^\]]*'home'/.test(src), 'Home is not always kept alive');
});

test('finding 11 and R3: readiness sends go once, to the selected page’s loaded document, never during a Tasks dialog', async () => {
  const w = world(); const home = w.views.home.webContents, tasks = w.views.tasks.webContents;
  assert.equal(w.api.focusComposer(), true);
  assert.deepEqual(home.sent, [['compose:focus', null]]);
  // Loading: sent after did-finish-load, once, even when asked twice.
  home.loading = true; home.sent = [];
  w.api.focusComposer(); w.api.focusComposer();
  home.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  home.emit('did-finish-load');
  assert.deepEqual(home.sent, [], 'did-finish-load while isLoading() is still true waits for did-stop-loading');
  home.loading = false; home.emit('did-stop-loading');
  assert.deepEqual(home.sent, [['compose:focus', null]]);
  home.emit('did-finish-load'); home.emit('did-stop-loading');
  assert.deepEqual(home.sent, [['compose:focus', null]], 'once');
  // Loading, then the person moves to another page before it finishes: dropped.
  home.loading = true; home.sent = [];
  w.api.focusComposer(); w.ctx.show('tasks'); home.loading = false; home.emit('did-finish-load');
  assert.deepEqual(home.sent, []);
  // A second navigation while waiting cancels it.
  w.ctx.show('home'); home.loading = true;
  w.api.focusComposer();
  home.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  home.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  home.loading = false; home.emit('did-finish-load');
  assert.deepEqual(home.sent, []);
  // Not selected: nothing.
  w.ctx.show('tasks');
  assert.equal(w.api.focusComposer(), false);
  // tasks:compose and tasks:reveal: the Tasks page only, and not while its native dialog is open.
  assert.equal(w.api.tasksCompose(), true);
  assert.equal(w.api.tasksReveal('t-1'), true);
  assert.deepEqual(tasks.sent, [['tasks:compose', null], ['tasks:reveal', 't-1']]);
  assert.equal(w.api.tasksReveal({}), false);
  let release; const pending = w.api.tasksConfirm(() => new Promise((r) => { release = r; }));
  assert.equal(w.api.tasksCompose(), false, 'skipped while tasksModalTicket is set');
  release({ response: 0 }); await pending;
  w.state.visible = false;
  assert.equal(w.api.tasksCompose(), false);
});

test('finding 2: confirmDialog sends Home’s create to homeConfirm and refuses Home’s anything else', async () => {
  const start = mainSrc.indexOf('    confirmDialog: async (info, wcId) => {', mainSrc.indexOf('function getTasks()'));
  const finish = mainSrc.indexOf('    seen: {', start);
  const shown = []; const homeAsks = []; const tasksAsks = [];
  const homeWc = { id: 41 }, tasksWc = { id: 42 }, otherWc = { id: 43 }; // 43: a live page that is neither Tasks nor Home
  const ctx = {
    tasksPages: () => [tasksWc], BrowserWindow: { fromWebContents: () => null },
    buddyWin: { pageWebContents: (id) => (id === 'home' ? homeWc : id === 'overview' ? otherWc : null), homeConfirm: async (show) => { homeAsks.push(1); return show('home-window'); }, tasksConfirm: async (show) => { tasksAsks.push(1); return show('tasks-window'); } },
    dialog: { showMessageBox: async (owner, o) => { shown.push([owner, o.buttons]); return { response: ctx.answer }; } }, answer: 1,
  };
  vm.runInNewContext(`globalThis.confirm=({${mainSrc.slice(start, finish)}}).confirmDialog;`, ctx);
  assert.equal(await ctx.confirm({ action: 'create', label: 'Start anyway', title: 't', detail: 'd' }, 41), true);
  assert.deepEqual(shown.at(-1)[0], 'home-window', 'parented to the window Home’s ticket holds');
  ctx.answer = 0;
  assert.equal(await ctx.confirm({ action: 'create', label: 'Start anyway', title: 't', detail: 'd' }, 41), false, 'Cancel');
  const n = shown.length;
  for (const action of ['discard', 'takeover', 'openPr', 'merge', 'switchAi', 'approve']) assert.equal(await ctx.confirm({ action, label: 'x', title: 't' }, 41), false, action);
  assert.equal(shown.length, n, 'no dialog for any other Home action');
  assert.equal(homeAsks.length, 2);
  ctx.answer = 1;
  assert.equal(await ctx.confirm({ action: 'create', label: 'Start anyway', title: 't' }, 42), true, 'Tasks keeps its own ticket');
  assert.equal(tasksAsks.length, 1);
  // Only a Tasks page (and Home's create) may raise a dialog: an unknown, absent, destroyed or other-document sender is
  // refused with no dialog and no ticket, never an unparented one. 43 is a live webContents that is neither Tasks nor Home.
  const before = { shown: shown.length, home: homeAsks.length, tasks: tasksAsks.length };
  for (const wcId of [999, 43, 0, undefined, null]) {
    for (const info of [{ action: 'create' }, { action: 'discard' }, { action: 'merge' }, { action: 'openTerminal' }, { action: 'approve', payload: { scope: 'task' } }]) {
      assert.equal(await ctx.confirm({ ...info, label: 'x', title: 't' }, wcId), false, `${info.action} from wcId ${wcId}`);
    }
  }
  assert.equal(shown.length, before.shown, 'no dialog for an unknown sender');
  assert.equal(homeAsks.length, before.home); assert.equal(tasksAsks.length, before.tasks);
});
