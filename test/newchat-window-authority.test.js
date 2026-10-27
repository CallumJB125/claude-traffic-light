'use strict';
// The new chat's buddy-window authority (chat-first preview, redesign R2b-2; plan-r2b-auth §3, outline Rev 1):
// newChatContext, newChatConfirm and its exclusion with the Tasks, Home and Setups dialogs both ways, the gate-off
// pin (the ticket is null through the whole confirm matrix), the blur rule, the lifecycle (retire on leave, the
// in-flight hold of review S1, settled, hide and resume), and main.js's confirmDialog branch. Shipped source in a vm,
// as test/compose-window-authority.test.js does; no window or dialog is opened.
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

function world({ chatFirst = true, busy = () => false, chats = true } = {}) {
  const dir = '/synthetic/app/buddy-window';
  const url = (file, q) => { const u = new URL(pathToFileURL(path.join(dir, '..', file)).href); if (q) u.searchParams.set('embedded', '1'); return u.href; };
  const state = { focused: true, visible: true, minimized: false, workspace: 'w1' };
  let nextId = 60;
  const mk = (id, href) => { const wc = new EventEmitter(); Object.assign(wc, { id, url: href, loading: false, destroyed: false, sent: [], mainFrame: { url: href }, getURL: () => wc.url, isLoading: () => wc.loading, isDestroyed: () => wc.destroyed, send: (ch, m) => wc.sent.push([ch, m]), focus() {} }); return { webContents: wc }; };
  const views = { home: mk(41, url('home.html')), tasks: mk(42, url('tasks.html', true)), setups: mk(43, url('setups.html')) };
  const children = Object.values(views);
  const win = new EventEmitter();
  Object.assign(win, { isDestroyed: () => false, isVisible: () => state.visible, isMinimized: () => state.minimized, isFocused: () => state.focused,
    contentView: { children, addChildView: (v) => { if (!children.includes(v)) children.push(v); }, removeChildView: (v) => { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); } } });
  const disposed = [], retired = [];
  class WebContentsView {
    constructor() { const v = mk(nextId++, ''); this.webContents = v.webContents; const wc = this.webContents; wc.loadFile = (file, { query } = {}) => { wc.url = url(path.basename(file), query?.embedded === '1'); wc.mainFrame.url = wc.url; return Promise.resolve(); }; }
    setBackgroundColor() {}
  }
  const ctx = { URL, path, pathToFileURL, DIR: dir, win, selected: 'home', content: views.home, localViews: new Map(Object.entries(views)), store: { active: () => ({ id: state.workspace }) }, Map, state,
    chatFirst, WebContentsView, nativeTheme: { shouldUseDarkColors: false }, lockLocal() {}, flow: { leftAccountPages() {} },
    dispose: (v) => { disposed.push(v.webContents.id); v.webContents.destroyed = true; }, newChatBusy: busy, onNewChatRetired: (id) => retired.push(id),
    retireThread() {}, pushState: () => { ctx.pushes = (ctx.pushes || 0) + 1; }, select: (id) => { ctx.selected = id; (ctx.selects = ctx.selects || []).push(id); }, chats, chatsOn: () => ctx.chats, layout() {}, lifecycle: { setCurrent() {} }, optimiser: { sync() {} }, threadView: null };
  const methods = between(src, '    tasksContext() {', '    setupSources,') + between(src, '    homeContext() {', '    // main → page readiness sends')
    + between(src, '    setupsContext() {', '    onActiveChange(') + between(src, '    newChatContext(){', '    newChatSettled,');
  const lifecycle = between(src, '  // ── new chat (chat-first preview, redesign R2b-2)', '  // ── workspaces');
  const attach = between(src, '  function attach(view) {', '  function pushState() {');
  const hooks = between(src, "      win.on('hide', () => retireNewChat({ resume: true }));", '    }\n');
  const focus = between(src, "    win.on('blur',()=>{if(!tasksModalTicket)", "    win.on('closed'");
  vm.runInNewContext(`let tasksDocument=0,tasksGeneration=0,tasksModalTicket=null,setupModalTicket=null,setupSourcesGeneration=0,setupLocalGeneration=0,homeDocument=0,homeGeneration=0,homeModalTicket=null;
    ${lifecycle}
    ${attach}
    globalThis.api={${methods} newChatSettled, openNewChat, chatsChanged, resumeNewChatView};${hooks}${focus}
    globalThis.show=(id)=>{selected=id;attach(localViews.get(id));homeGeneration++;tasksGeneration++;setupLocalGeneration++;if(newChatView&&selected!=='newchat')retireNewChat();};
    globalThis.ticket=()=>newChatModalTicket;
    globalThis.held=()=>newChatHeldView&&newChatHeldView.wcId;
    globalThis.workspaceSwitch=()=>{tasksGeneration++;homeGeneration++;};`, ctx);
  return { ctx, api: ctx.api, state, views, win, disposed, retired, nc: () => ctx.api.newChatWebContents() };
}

test('gate off: the new chat has no context, document or webContents, and never opens', () => {
  const w = world({ chatFirst: false });
  assert.equal(w.api.openNewChat(), false);
  assert.equal(w.api.newChatContext(), null);
  assert.equal(w.api.newChatDocument(), null);
  assert.equal(w.api.newChatWebContents(), null);
  assert.equal(w.api.newChatWcId(), null);
  assert.equal(w.api.newChatHeld(), false);
});

test('newChatContext follows the selected, visible, loaded new-chat document; any change gives null', () => {
  const w = world();
  assert.equal(w.api.openNewChat(), true);
  const c = w.api.newChatContext();
  assert.equal(c.contents, w.nc());
  assert.equal(c.foreground, true);
  assert.equal(w.api.newChatWcId(), w.nc().id);
  assert.deepEqual({ ...w.api.newChatDocument() }, { wcId: w.nc().id, doc: c.document });
  w.state.focused = false;
  assert.equal(w.api.newChatContext().foreground, false);
  for (const mutate of [(v) => v.ctx.show('tasks'), (v) => { v.state.visible = false; }, (v) => { v.state.minimized = true; }, (v) => { v.nc().loading = true; }, (v) => { v.nc().url += '&x=1'; }]) {
    const v = world(); v.api.openNewChat(); mutate(v);
    assert.equal(v.api.newChatContext(), null, mutate.toString());
  }
});

test('newChatConfirm answers only for the same foreground document; its own blur does not void it; every change does', async () => {
  const w = world(); w.api.openNewChat();
  const yes = await w.api.newChatConfirm(async (owner) => { assert.equal(owner, w.win); w.win.emit('blur'); return { response: 1 }; });
  assert.equal(yes.response, 1);
  assert.equal(w.ctx.ticket(), null, 'released');
  for (const change of ['reload', 'page', 'workspace', 'hide', 'blurAfter']) {
    const v = world(); v.api.openNewChat();
    const r = await v.api.newChatConfirm(async () => {
      if (change === 'reload') v.nc().emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      if (change === 'page') v.ctx.show('home');
      if (change === 'workspace') v.state.workspace = 'w2';
      if (change === 'hide') { v.state.visible = false; v.win.emit('hide'); }
      if (change === 'blurAfter') v.state.focused = false;
      return { response: 1 };
    });
    assert.equal(r, null, change);
  }
  const bg = world(); bg.api.openNewChat(); bg.state.focused = false;
  assert.equal(await bg.api.newChatConfirm(async () => ({ response: 1 })), null, 'a background new chat cannot open one');
});

test('one native dialog at a time: the new chat against Tasks, Home and Setups, both ways', async () => {
  for (const other of ['tasks', 'home', 'setups']) {
    const confirmOf = { tasks: 'tasksConfirm', home: 'homeConfirm', setups: 'setupsConfirm' }[other];
    // new chat first, then the other page asks
    const a = world(); a.api.openNewChat();
    let release, asked = 0;
    const pending = a.api.newChatConfirm(() => new Promise((r) => { release = r; }));
    a.ctx.show(other);
    assert.equal(await a.api[confirmOf](async () => { asked++; return { response: 1 }; }), null, `${other} refuses while the new chat's is open`);
    assert.equal(asked, 0);
    release({ response: 0 }); await pending;
    assert.deepEqual(await a.api[confirmOf](async () => ({ response: 1 })), { response: 1 }, `${other} asks again once it closed`);
    // the other first, then the new chat asks
    const b = world(); b.ctx.show(other);
    const p2 = b.api[confirmOf](() => new Promise((r) => { release = r; }));
    b.api.openNewChat();
    assert.equal(await b.api.newChatConfirm(async () => { asked++; return { response: 1 }; }), null, `the new chat refuses while ${other}'s is open`);
    assert.equal(asked, 0);
    release({ response: 0 }); await p2;
  }
});

test('gate off: the whole confirm matrix runs with newChatModalTicket null at every step, and its outcomes are today\'s', async () => {
  const w = world({ chatFirst: false });
  const steps = [];
  const check = (label) => { assert.equal(w.ctx.ticket(), null, label); assert.equal(w.api.newChatHeld(), false, label); steps.push(label); };
  const confirms = { tasks: 'tasksConfirm', home: 'homeConfirm', setups: 'setupsConfirm' };
  for (const page of Object.keys(confirms)) {
    w.ctx.show(page); check(`${page} shown`);
    assert.deepEqual(await w.api[confirms[page]](async () => { check(`${page} open`); return { response: 1 }; }), { response: 1 }, `${page} accepted`);
    assert.deepEqual(await w.api[confirms[page]](async () => ({ response: 0 })), { response: 0 }, `${page} cancelled`);
    check(`${page} closed`);
    for (const other of Object.keys(confirms).filter((x) => x !== page)) {
      let release;
      w.ctx.show(page);
      const pending = w.api[confirms[page]](() => new Promise((r) => { release = r; }));
      check(`${page} open, ${other} asks`);
      w.ctx.show(other);
      assert.equal(await w.api[confirms[other]](async () => ({ response: 1 })), null, `${other} refuses while ${page}'s is open`);
      release({ response: 1 });
      assert.equal(await pending, null, `${page}'s answer is void: the page changed`);
      check(`${page} and ${other} done`);
    }
  }
  assert.ok(steps.length >= 18);
  assert.equal(await w.api.newChatConfirm(async () => ({ response: 1 })), null, 'no new-chat dialog exists gate off');
});

test('review S1: leaving the new chat disposes it; a create in flight only holds it until that create returns', () => {
  let busy = false;
  const w = world({ busy: () => busy });
  w.api.openNewChat();
  const first = w.nc().id;
  w.ctx.show('home');
  assert.deepEqual(w.disposed, [first], 'gone at once: nothing kept it');
  assert.deepEqual(w.retired, [first], 'main is told, so its slot (none) goes too');
  w.api.openNewChat();
  const second = w.nc().id;
  busy = true;
  w.ctx.show('tasks');
  assert.equal(w.api.newChatWebContents(), null, 'off screen: no context, so the create in flight cannot navigate');
  assert.equal(w.ctx.held(), second, 'held while the create is in flight');
  assert.ok(!w.disposed.includes(second));
  w.api.newChatSettled(second);
  assert.ok(!w.disposed.includes(second), 'still in flight: not yet');
  busy = false;
  w.api.newChatSettled(999);
  assert.ok(!w.disposed.includes(second), 'another document settling does not release it');
  w.api.newChatSettled(second);
  assert.ok(w.disposed.includes(second), 'disposed when its create returned');
  assert.equal(w.ctx.held(), null);
});

test('hide and minimise retire the new chat; show and restore bring back a new document; blur bumps its generation', () => {
  const w = world();
  w.api.openNewChat();
  const g = w.api.newChatContext().generation, first = w.nc().id;
  w.win.emit('blur');
  w.state.focused = true;
  assert.ok(w.api.newChatContext().generation > g, 'a blur outside its dialog voids what was checked');
  w.state.visible = false; w.win.emit('hide');
  assert.equal(w.api.newChatWebContents(), null);
  assert.ok(w.disposed.includes(first));
  w.state.visible = true; w.win.emit('show');
  assert.notEqual(w.nc().id, first, 'a new document');
  w.state.minimized = true; w.win.emit('minimize');
  assert.equal(w.api.newChatWebContents(), null);
  w.state.minimized = false; w.win.emit('restore');
  assert.ok(w.nc());
});

test('main.js: the new chat\'s wcId gets a dialog only for create, through newChatConfirm; the Home and Tasks branches are unchanged', async () => {
  const start = mainSrc.indexOf('    confirmDialog: async (info, wcId) => {', mainSrc.indexOf('function getTasks()'));
  const finish = mainSrc.indexOf('    seen: {', start);
  const shown = [];
  const mkCtx = (buddyWin) => ({ tasksPages: () => [], buddyWin, dialog: { showMessageBox: async () => ({ response: 1 }) } });
  const confirmOf = (buddyWin) => { const c = mkCtx(buddyWin); vm.runInNewContext('globalThis.confirm=({' + mainSrc.slice(start, finish) + '}).confirmDialog;', c); return c.confirm; };
  const buddyWin = { pageWebContents: () => ({ id: 41 }), newChatWcId: () => 77, newChatConfirm: async (show) => { shown.push('newchat'); return show({}); }, homeConfirm: async () => { shown.push('home'); return { response: 1 }; } };
  const confirm = confirmOf(buddyWin);
  assert.equal(await confirm({ action: 'create', label: 'Start anyway', title: 't' }, 77), true);
  assert.equal(await confirm({ action: 'discard', label: 'Discard', title: 't' }, 77), false, 'anything else is refused, no dialog');
  assert.equal(await confirm({ action: 'create', label: 'x', title: 't' }, 41), true, 'Home unchanged');
  assert.deepEqual(shown, ['newchat', 'home']);
  // Gate off (newChatWcId() null) or an older buddy window: no branch, an unknown sender is refused.
  for (const b of [{ ...buddyWin, newChatWcId: () => null }, { pageWebContents: () => null }]) assert.equal(await confirmOf(b)({ action: 'create', label: 'x', title: 't' }, 77), false);
  assert.match(mainSrc, /newChatBusy: \(\) => NewChat\?\.busy\(\) === true,/);
  assert.match(mainSrc, /onNewChatRetired: \(wcId\) => NewChat\?\.retire\(wcId\),/);
  assert.match(mainSrc, /NewChat\?\.onChange\(snap\);/);
  const reg = mainSrc.indexOf("NewChat = require('./src/newchat-main.js')");
  const gate = mainSrc.lastIndexOf('if (CHAT_PREVIEW) {', reg);
  assert.ok(gate > 0 && !mainSrc.slice(gate, reg).includes('\n}\n'), 'the new chat is registered only inside the CHAT_PREVIEW block');
});

test('the other confirms consult newChatHeld through this, and the shipped object has it', () => {
  for (const name of ['async tasksConfirm(show)', 'async homeConfirm(show)', 'async setupsConfirm(show)']) assert.match(between(src, `    ${name} {`, '}finally{'), /this\.newChatHeld\?\.\(\)/, name);
  assert.match(src, /    newChatHeld\(\)\{ return newChatModalTicket!==null; \},/);
  // Links and the sidebar only navigate.
  assert.match(src, /if \(target\.kind === 'newchat' && openNewChat\(\)\) return;/);
  assert.match(src, /if \(chatFirst === true\) ipcMain\.on\('buddy:open-newchat', \(e\) => \{ if \(fromSidebar\(e\)\) openNewChat\(\); \}\);/);
});

// R4-1b (plan-r4 §3.1): a thread dialog open → Tasks, Home, Setups and the new chat each refuse theirs, and ask again once it closed.
test('the four confirms refuse while the thread\'s dialog is held, and ask again once it is not', async () => {
  for (const [page, confirmOf] of [['tasks', 'tasksConfirm'], ['home', 'homeConfirm'], ['setups', 'setupsConfirm'], ['newchat', 'newChatConfirm']]) {
    const w = world();
    if (page === 'newchat') w.api.openNewChat(); else w.ctx.show(page);
    let held = true, asked = 0;
    w.api.threadHeld = () => held;
    assert.equal(await w.api[confirmOf](async () => { asked++; return { response: 1 }; }), null, `${page} refuses during a thread dialog`);
    assert.equal(asked, 0);
    held = false;
    assert.deepEqual(await w.api[confirmOf](async () => ({ response: 1 })), { response: 1 }, `${page} asks again`);
  }
  for (const name of ['async tasksConfirm(show)', 'async homeConfirm(show)', 'async setupsConfirm(show)', 'async newChatConfirm(show)']) assert.match(between(src, `    ${name} {`, '}finally{'), /this\.threadHeld\?\.\(\)/, name);
  assert.match(src, /    threadHeld\(\)\{ return chatFirst===true&&threadModalTicket!==null; \},/, 'always false with the gate off');
});

// ── C4: "Show chats" off (config homeComposer) ─────────────────────────────
test('C4: with chats off the new chat never opens, and refusing retires and bumps nothing', () => {
  const w = world({ chats: false });
  const before = { ...w.api.newChatContext?.() };
  assert.equal(w.api.openNewChat(), false);
  assert.equal(w.api.newChatWebContents(), null);
  assert.equal(w.ctx.selected, 'home', 'the page on screen stays');
  assert.deepEqual(w.disposed, []);
  assert.deepEqual(w.retired, []);
  assert.deepEqual(before, {});
  w.ctx.chats = true;
  assert.equal(w.api.openNewChat(), true, 'read on every call: on again opens it');
});

test('C4 live flip: a showing new chat is retired (an in-flight Run fails same()) and Home shows; resume never brings it back', () => {
  const w = world();
  assert.equal(w.api.openNewChat(), true);
  const c = w.api.newChatContext(), id = w.nc().id;
  w.ctx.chats = false;
  w.api.chatsChanged();
  assert.equal(w.api.newChatWebContents(), null);
  assert.ok(w.retired.includes(id));
  assert.equal(w.ctx.selected, 'home');
  assert.equal(w.api.newChatContext(), null, 'the old context is gone, so same() fails');
  assert.notEqual(c.generation, undefined);
  // Hidden while showing (resume armed), then chats off: the resume is cleared and the window lands on Home.
  const h = world();
  h.api.openNewChat();
  h.win.emit('hide');
  h.ctx.chats = false;
  h.api.chatsChanged();
  assert.equal(h.ctx.selected, 'home');
  h.win.emit('show');
  assert.equal(h.api.newChatWebContents(), null, 'no resume');
  // A resume that finds chats off lands on Home, not Board.
  const r = world();
  r.api.openNewChat();
  r.win.emit('hide');
  r.ctx.chats = false;
  r.win.emit('show');
  assert.equal(r.ctx.selected, 'home');
  assert.equal(r.api.newChatWebContents(), null);
});

test('C4 live flip: chats on, or off with no new chat, only tells the sidebar', () => {
  const w = world();
  w.api.chatsChanged();
  assert.equal(w.ctx.pushes, 1);
  assert.deepEqual(w.ctx.selects ?? [], []);
  w.ctx.chats = false;
  w.api.chatsChanged();
  assert.equal(w.ctx.pushes, 2);
  assert.deepEqual(w.ctx.selects ?? [], [], 'Home showing: nothing else moves');
  const off = world({ chatFirst: false, chats: false });
  off.api.chatsChanged();
  assert.equal(off.ctx.pushes, undefined, 'gate off: a no-op');
});

test('C4 live flip: a held "Start anyway" dialog defers the flip until it is answered, then it applies', async () => {
  const w = world();
  w.api.openNewChat();
  let release;
  const pending = w.api.newChatConfirm(() => new Promise((r) => { release = r; }));
  w.ctx.chats = false;
  w.api.chatsChanged();
  assert.ok(w.api.newChatWebContents(), 'kept while the dialog is open');
  assert.equal(w.ctx.selected, 'newchat');
  release({ response: 1 });
  await pending;
  assert.equal(w.api.newChatWebContents(), null, 'then retired');
  assert.equal(w.ctx.selected, 'home');
});
