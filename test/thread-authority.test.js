'use strict';
// Redesign R2a: the read-only thread's authority (plan-r2.md §2.8 and
// labfix-review S1/S2). src/thread-main.js is exercised with the real
// index.js thread lifecycle (run in a vm) and fakes only at the Electron and
// Tasks-service boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createThreadMain, CHANNELS, EFFECT_MS } = require('../src/thread-main');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'buddy-window/index.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const between = (text, a, b) => { const i = text.indexOf(a); const j = text.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, `${a} … ${b}`); return text.slice(i, j); };
const DIR = path.join(root, 'buddy-window');
const THREAD_URL = (() => { const u = new URL(pathToFileURL(path.join(root, 'thread.html')).href); u.searchParams.set('embedded', '1'); return u.href; })();
const A = 'a'.repeat(64), B = 'b'.repeat(64), DEVICE = 'd'.repeat(64), SESSION = 'c'.repeat(64);
const settle = () => new Promise((r) => setImmediate(r));

// ── fakes ────────────────────────────────────────────────────────────────
let nextId = 100;
function fakeContents() {
  const handlers = new Map();
  const wc = {
    id: nextId++, url: '', destroyed: false, loading: false, sent: [],
    mainFrame: { url: '' },
    on(ev, fn) { (handlers.get(ev) ?? handlers.set(ev, []).get(ev)).push(fn); return wc; },
    once(ev, fn) { return wc.on(ev, fn); },
    emit(ev, ...a) { for (const fn of handlers.get(ev) ?? []) fn(...a); },
    isDestroyed: () => wc.destroyed, isLoading: () => wc.loading, getURL: () => wc.url,
    send: (ch, m) => wc.sent.push([ch, m]),
    close() { if (wc.destroyed) return; wc.destroyed = true; wc.emit('destroyed'); },
    loadFile(file, { query } = {}) {
      const u = new URL(pathToFileURL(file).href); for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
      wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      wc.url = u.href; wc.mainFrame = { url: u.href };
      wc.emit('did-stop-loading');
      return Promise.resolve();
    },
    reload() { wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); wc.mainFrame = { url: wc.url }; wc.emit('did-stop-loading'); },
  };
  return wc;
}
function fakeWindow() {
  const w = {
    visible: true, minimized: false, focused: true, destroyed: false, handlers: new Map(),
    contentView: { children: [], addChildView(v) { this.children.push(v); }, removeChildView(v) { this.children = this.children.filter((x) => x !== v); } },
    isDestroyed: () => w.destroyed, isVisible: () => w.visible, isMinimized: () => w.minimized, isFocused: () => w.focused,
  };
  return w;
}
function fakeTasks() {
  const slots = new Map(), log = [];
  let seen = 0;
  return {
    log, slots, get seen() { return seen; },
    async openTask(id, wcId) { await this.closeTask(wcId); slots.set(wcId, id); log.push(['open', id, wcId]); return { ok: true, detail: { id, title: 'Fix the tests', messages: [] }, replay: [] }; },
    async closeTask(wcId) { if (slots.delete(wcId)) log.push(['close', wcId]); },
    // An incoming agent message: the real service marks it seen for every open slot (tasks-service.js:302).
    deliver() { seen += slots.size; },
  };
}

// The real index.js thread lifecycle + attach() + threadContext(), in a vm.
function world({ targets = { [A]: { kind: 'task', taskId: 'task-a' }, [B]: { kind: 'task', taskId: 'task-b' }, [SESSION]: { kind: 'session', source: 'claude', sessionId: 's-1', origin: 'iTerm' } } } = {}) {
  const win = fakeWindow();
  const tasks = fakeTasks();
  const effects = [];
  const retired = [];
  let thread = null;
  const ctx = {
    URL, path, DIR, pathToFileURL, chatFirst: true, win, content: null, selected: 'board',
    setupLocalGeneration: 0, tasksGeneration: 0, homeGeneration: 0, localViews: new Map(),
    layout: () => {}, lifecycle: { setCurrent: () => {} }, optimiser: { sync: () => {} },
    flow: { leftAccountPages: () => {} },
    nativeTheme: { shouldUseDarkColors: false }, lockLocal: () => {},
    WebContentsView: function WebContentsView() { this.webContents = fakeContents(); this.setBackgroundColor = () => {}; },
    dispose: (v, w) => { try { w?.contentView.removeChildView(v); } catch { /* */ } v.webContents.close(); },
    threadTarget: (id) => targets[id] ?? null,
    onThreadRetired: (wcId) => { retired.push(wcId); thread.retire(wcId); },
    pushStateCalls: 0,
    select(id) { ctx.selected = id; ctx.pushState(); ctx.attach(ctx.boardView); },
    boardView: { webContents: fakeContents() },
  };
  const code = between(src, '  function attach(view) {', '  function pushState() {')
    + "function pushState() { pushStateCalls++;\n" + between(src, '    // The selection left the thread before its next view is attached', '    if(activeMarker!==') + "}\n"
    + between(src, '  // ── thread (chat-first preview, redesign R2a)', '  // ── workspaces')
    + 'const api = {\n' + between(src, '    threadContext(){', '    openThread,\n') + '};\n'
    + 'globalThis.api = api; globalThis.openThread = openThread; globalThis.retireThread = retireThread; globalThis.resumeThread = resumeThread; globalThis.attach = attach; globalThis.pushState = pushState;'
    + 'globalThis.peek = () => ({ threadView, threadId, threadDocument, resumeThreadId, content, selected });';
  vm.runInNewContext(code, ctx);
  const ipc = { handlers: {}, handle(name, fn) { this.handlers[name] = fn; } };
  thread = createThreadMain({
    buddy: () => ctx.api, chatPreview: true,
    target: (id) => targets[id] ?? null,
    tasks: () => tasks,
    activity: async (s) => ({ title: 'Claude Code · billing', view: { events: [{ at: 1, kind: 'tool', label: `Edited ${s.sessionId}` }] } }),
    openInTasks: async (taskId) => { effects.push(['tasks', taskId]); return true; },
    goToTerminal: async (s) => { effects.push(['terminal', s.sessionId]); return { ok: true }; },
    copy: (t) => effects.push(['copy', t]),
  });
  thread.register(ipc);
  const call = (name, e, ...a) => ipc.handlers[name](e, ...a);
  const doc = () => { const v = ctx.peek().threadView; return v ? { sender: v.webContents, senderFrame: v.webContents.mainFrame } : null; };
  return { ctx, win, tasks, effects, retired, thread, ipc, call, doc, peek: () => ctx.peek() };
}

// ── gate and registration ────────────────────────────────────────────────

test('gate off: no thread:* channel is registered and no context exists (7)', () => {
  const ipc = { handlers: {}, handle(name, fn) { this.handlers[name] = fn; } };
  createThreadMain({ buddy: () => null, chatPreview: false, target: () => null, tasks: () => null, activity: async () => null, openInTasks: async () => false, goToTerminal: async () => null }).register(ipc);
  assert.deepEqual(Object.keys(ipc.handlers), []);
  assert.match(mainSrc, /\nif \(CHAT_PREVIEW\) \{\n  const SidebarRows = require\('\.\/src\/overview-sidebar-rows'\);\n  ThreadMain = require\('\.\/src\/thread-main'\)\.createThreadMain\(\{/);
  const tc = between(src, '    threadContext(){', '    openThread,\n');
  assert.match(tc, /^    threadContext\(\)\{\n      if\(chatFirst!==true\)return null;/);
  assert.match(src, /  if \(chatFirst === true\) ipcMain\.on\('buddy:open-thread',/);
  assert.match(src, /  if \(chatFirst === true\) ipcMain\.on\('thread:board',/);
  assert.match(src, /    if \(chatFirst === true\) \{\n      win\.on\('hide', \(\) => retireThread\(\{ resume: true \}\)\);/);
});

test('a thread opens for a resolved row only; a paired-device row never gets one (8)', () => {
  const w = world();
  assert.equal(w.ctx.openThread(DEVICE), false, 'no target → no thread');
  assert.equal(w.peek().threadView, null);
  for (const bad of [null, 'x', A.toUpperCase(), `${A}0`]) assert.equal(w.ctx.openThread(bad), false);
  assert.equal(w.ctx.openThread(A), true);
  assert.equal(w.peek().selected, 'thread');
  assert.equal(w.peek().threadView.webContents.url, THREAD_URL);
  assert.equal(w.peek().content, w.peek().threadView);
  const ready = w.peek().threadView.webContents.sent.find(([ch]) => ch === 'thread:ready');
  assert.equal(JSON.stringify(ready), JSON.stringify(['thread:ready', { id: A }]), 'readiness carries the bound row (vm realm: compared as JSON)');
});

test('every thread:* channel refuses any other webContents, a subframe and a mismatched id before any await (1, 2, 4, 5, 6)', async () => {
  const w = world();
  w.ctx.openThread(A);
  const own = w.doc();
  const other = fakeContents();
  const forged = [
    { sender: other, senderFrame: other.mainFrame },
    { sender: own.sender, senderFrame: { url: THREAD_URL } }, // a subframe (the srcdoc transcript frame included)
    {},
  ];
  for (const ch of CHANNELS) {
    for (const e of forged) assert.ok([null, false].includes(await w.call(ch, e, A)) || (await w.call(ch, e, A))?.ok === false, `${ch} from a forged sender`);
    // Asking about another row (B) from the A document: refused, nothing opened.
    const r = await w.call(ch, own, B);
    assert.ok(r === null || r === false || r?.ok === false, `${ch} for another row`);
    assert.ok([null, false].includes(await w.call(ch, own)) || (await w.call(ch, own))?.ok === false, `${ch} with no id`);
    assert.ok([null, false].includes(await w.call(ch, own, A, 'extra')) || (await w.call(ch, own, A, 'extra'))?.ok === false, `${ch} with extra args`);
  }
  assert.deepEqual(w.tasks.log, [], 'nothing opened for a refused call');
  assert.deepEqual(w.effects, []);
});

test('thread for A shows A only; reading B needs B\'s own document (1, 10)', async () => {
  const w = world();
  w.ctx.openThread(A);
  const a = w.doc();
  const r = await w.call('thread:open', a, A);
  assert.equal(r.kind, 'task');
  assert.deepEqual(w.tasks.log, [['open', 'task-a', a.sender.id]]);
  w.ctx.openThread(B);
  const b = w.doc();
  assert.notEqual(b.sender, a.sender, 'a new webContents per thread, never reused');
  assert.equal(a.sender.isDestroyed(), true);
  assert.equal(await w.call('thread:open', a, A), null, 'the old document is gone');
  assert.equal(await w.call('thread:open', b, A), null, 'B\'s document can\'t read A');
  assert.equal((await w.call('thread:open', b, B)).kind, 'task');
  assert.ok(!w.tasks.slots.has(a.sender.id), 'A\'s slot closed');
  assert.equal(w.tasks.slots.get(b.sender.id), 'task-b');
});

test('a reload, or the row ending, during an await: refused and the slot closed (3, 11)', async () => {
  const w = world();
  w.ctx.openThread(A);
  const a = w.doc();
  let release;
  w.tasks.openTask = async function (id, wcId) { this.slots.set(wcId, id); await new Promise((r) => { release = r; }); return { ok: true, detail: {}, replay: [] }; };
  const p = w.call('thread:open', a, A);
  await settle();
  a.sender.reload(); // a new document mid-read
  release();
  assert.equal(await p, null);
  assert.ok(!w.tasks.slots.has(a.sender.id), 'slot closed');
  assert.equal(w.thread.slot(), null);
  // The row ends while its thread is showing: GONE, and nothing is opened.
  const targets = { [A]: { kind: 'task', taskId: 'task-a' } };
  const w2 = world({ targets });
  w2.ctx.openThread(A);
  delete targets[A];
  assert.deepEqual(await w2.call('thread:open', w2.doc(), A), { gone: true });
  assert.deepEqual(await w2.call('thread:state', w2.doc(), A), { gone: true });
  assert.equal(await w2.call('thread:open-in-tasks', w2.doc(), A), false);
  assert.deepEqual(w2.tasks.log, []);
  assert.equal(world({ targets: {} }).ctx.openThread(A), false, 'and a row with no target never opens one');
});

// ── S2: no background subscription ──────────────────────────────────────

test('S2: leaving the thread for any page closes the slot; zero further markSeen', async () => {
  const w = world();
  w.ctx.openThread(A);
  await w.call('thread:open', w.doc(), A);
  w.tasks.deliver();
  assert.equal(w.tasks.seen, 1, 'shown → seen');
  const wcId = w.doc().sender.id;
  w.ctx.select('board');
  await settle();
  assert.equal(w.peek().threadView, null, 'the view is destroyed, not kept alive');
  assert.ok(!w.tasks.slots.has(wcId));
  assert.ok(w.retired.includes(wcId));
  w.tasks.deliver();
  w.tasks.deliver();
  assert.equal(w.tasks.seen, 1, 'nothing marked read in the background');
  assert.equal(w.thread.onEvent(wcId, 'task-a', { type: 'message' }), false, 'no events routed to a closed slot');
});

test('S2: a selection change before the next view attaches (a loading hub page) also ends it', async () => {
  const w = world();
  w.ctx.openThread(A);
  await w.call('thread:open', w.doc(), A);
  const wcId = w.doc().sender.id;
  w.ctx.selected = 'board';
  w.ctx.pushState();
  await settle();
  assert.equal(w.peek().threadView, null);
  assert.ok(!w.tasks.slots.has(wcId));
});

test('S2: a renderer crash destroys the view and closes the slot', async () => {
  const w = world();
  w.ctx.openThread(A);
  await w.call('thread:open', w.doc(), A);
  const wc = w.doc().sender;
  wc.emit('render-process-gone', {}, { reason: 'crashed' });
  await settle();
  assert.equal(w.peek().threadView, null);
  assert.equal(wc.isDestroyed(), true);
  assert.ok(!w.tasks.slots.has(wc.id));
});

test('S2: hiding the window ends the thread; showing it again opens a new document for the same row', async () => {
  const w = world();
  w.ctx.openThread(A);
  await w.call('thread:open', w.doc(), A);
  const first = w.doc().sender;
  w.ctx.retireThread({ resume: true }); // win 'hide' / 'minimize'
  await settle();
  assert.ok(!w.tasks.slots.has(first.id));
  assert.equal(w.peek().selected, 'thread');
  w.ctx.resumeThread(); // win 'show' / 'restore'
  assert.notEqual(w.doc().sender, first);
  assert.equal(w.peek().threadId, A);
  // A row that ended while hidden: Board.
  const w2 = world();
  w2.ctx.openThread(A);
  w2.ctx.retireThread({ resume: true });
  w2.ctx.threadTarget = () => null;
  w2.ctx.resumeThread();
  assert.equal(w2.peek().selected, 'board');
});

test('events reach only the current thread document for its own task', async () => {
  const w = world();
  w.ctx.openThread(A);
  const a = w.doc();
  await w.call('thread:open', a, A);
  assert.equal(w.thread.onEvent(a.sender.id, 'task-a', { type: 'transcript', text: 'hi' }), true);
  assert.deepEqual(a.sender.sent.at(-1), ['thread:event', { id: A, event: { type: 'transcript', text: 'hi' } }]);
  const n = a.sender.sent.length;
  assert.equal(w.thread.onEvent(a.sender.id, 'task-b', { type: 'transcript' }), true, 'consumed, not forwarded to the Tasks page');
  assert.equal(a.sender.sent.length, n, 'but never shown: another task');
  assert.equal(w.thread.onEvent(999, 'task-a', {}), false, 'another webContents is the Tasks page\'s');
  assert.match(mainSrc, /onEvent: \(wcId, id, event\) => \{ if \(Compose\.onEvent\(wcId, id, event\)\) return; if \(ThreadMain\?\.onEvent\(wcId, id, event\)\) return;/);
});

// ── S1: effects need foreground ─────────────────────────────────────────

test('S1: open-in-tasks reveals only the bound task, and only from a focused, shown thread (8)', async () => {
  const w = world();
  w.ctx.openThread(A);
  const a = w.doc();
  w.win.focused = false;
  assert.equal(await w.call('thread:open-in-tasks', a, A), false, 'unfocused');
  w.win.focused = true;
  w.ctx.selected = 'thread';
  assert.equal(await w.call('thread:open-in-tasks', a, A), true);
  assert.deepEqual(w.effects, [['tasks', 'task-a']]);
  // A session thread has no task to reveal.
  w.ctx.openThread(SESSION);
  assert.equal(await w.call('thread:open-in-tasks', w.doc(), SESSION), false);
  assert.deepEqual(w.effects, [['tasks', 'task-a']]);
});

test('S1: go-to-terminal opens only the bound local session, focused and shown', async () => {
  const w = world();
  w.ctx.openThread(SESSION);
  const s = w.doc();
  w.win.focused = false;
  assert.deepEqual(await w.call('thread:go-to-terminal', s, SESSION), { ok: false });
  w.win.focused = true;
  w.win.visible = false;
  assert.deepEqual(await w.call('thread:go-to-terminal', s, SESSION), { ok: false }, 'hidden');
  w.win.visible = true;
  assert.deepEqual(await w.call('thread:go-to-terminal', s, SESSION), { ok: true });
  assert.deepEqual(w.effects, [['terminal', 's-1']]);
  w.ctx.openThread(A);
  assert.deepEqual(await w.call('thread:go-to-terminal', w.doc(), A), { ok: false }, 'a task has no terminal session');
});

test('S1: each effect runs at most once per 500 ms per document', async () => {
  let t = 1000;
  const w = world();
  w.thread.stop();
  const ipc = { handlers: {}, handle(n, f) { this.handlers[n] = f; } };
  const effects = [];
  createThreadMain({ buddy: () => w.ctx.api, chatPreview: true, now: () => t, target: (id) => ({ [A]: { kind: 'task', taskId: 'task-a' } })[id] ?? null, tasks: () => w.tasks, activity: async () => null, openInTasks: async (id) => { effects.push(id); return true; }, goToTerminal: async () => ({ ok: true }), copy: (x) => effects.push(x) }).register(ipc);
  w.ctx.openThread(A);
  const a = w.doc();
  assert.equal(await ipc.handlers['thread:open-in-tasks'](a, A), true);
  assert.equal(await ipc.handlers['thread:open-in-tasks'](a, A), false, 'second within 500 ms');
  t += EFFECT_MS - 1;
  assert.equal(await ipc.handlers['thread:open-in-tasks'](a, A), false);
  t += 1;
  assert.equal(await ipc.handlers['thread:open-in-tasks'](a, A), true);
  assert.equal(await ipc.handlers['thread:copy-link'](a, A), true, 'a separate effect has its own limit');
  assert.equal(await ipc.handlers['thread:copy-link'](a, A), false);
  assert.deepEqual(effects, ['task-a', 'task-a', `plexiform://thread/${A}`]);
});

test('copy link writes this row\'s link only, from a focused thread', async () => {
  const w = world();
  w.ctx.openThread(A);
  w.win.focused = false;
  assert.equal(await w.call('thread:copy-link', w.doc(), A), false);
  w.win.focused = true;
  assert.equal(await w.call('thread:copy-link', w.doc(), A), true);
  assert.deepEqual(w.effects, [['copy', `plexiform://thread/${A}`]]);
});

test('session thread: activity for the bound session only; no Tasks slot', async () => {
  const w = world();
  w.ctx.openThread(SESSION);
  const r = await w.call('thread:open', w.doc(), SESSION);
  assert.equal(r.kind, 'session');
  assert.equal(r.origin, 'iTerm');
  assert.equal(r.activity.view.events[0].label, 'Edited s-1');
  assert.deepEqual(w.tasks.log, []);
});

// ── G1/G2 unchanged (9) ─────────────────────────────────────────────────

test('tasks:* authority is unchanged: the thread webContents is never a Tasks page (9)', () => {
  assert.match(mainSrc, /const tasksPages = \(\) => \[buddyWin\?\.pageWebContents\('tasks'\)\]\.filter\(\(w\) => w && !w\.isDestroyed\(\)\);\n/);
  assert.match(mainSrc, /const tasksSenderOk = \(e\) => !!e\.sender && tasksPages\(\)\.includes\(e\.sender\) && e\.senderFrame === e\.sender\.mainFrame;\n/);
  const tm = fs.readFileSync(path.join(root, 'src/tasks-main.js'), 'utf8');
  assert.doesNotMatch(tm, /thread/i, 'tasks-main knows nothing of the thread');
  // The thread view is never in localViews, so pageWebContents('tasks') can't return it.
  const block = between(src, '  // ── thread (chat-first preview, redesign R2a)', '  // ── workspaces');
  assert.doesNotMatch(block, /localViews/);
  const preload = fs.readFileSync(path.join(root, 'thread-preload.js'), 'utf8');
  const channels = [...preload.matchAll(/ipcRenderer\.(?:invoke|send|on)\('([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(channels, [...CHANNELS, 'thread:board', 'thread:event', 'thread:ready'].sort(), 'the bridge is exactly the read-only thread set: no tasks:*, nothing that acts');
});


test('a terminal session\'s thread never reaches the Tasks service, even when it closes', async () => {
  const w = world();
  let reached = 0;
  const real = w.tasks;
  w.thread.stop();
  const ipc = { handlers: {}, handle(n, f) { this.handlers[n] = f; } };
  const t = createThreadMain({ buddy: () => w.ctx.api, chatPreview: true, target: (id) => ({ [SESSION]: { kind: 'session', source: 'claude', sessionId: 's-1', origin: 'iTerm' } })[id] ?? null, tasks: () => { reached++; return real; }, activity: async () => ({ view: { events: [] } }), openInTasks: async () => false, goToTerminal: async () => ({ ok: true }) });
  t.register(ipc);
  w.ctx.openThread(SESSION);
  const d = w.doc();
  await ipc.handlers['thread:open'](d, SESSION);
  await ipc.handlers['thread:close'](d, SESSION);
  t.retire(d.sender.id);
  await settle();
  assert.equal(reached, 0);
});
