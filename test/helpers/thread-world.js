'use strict';
// The R2a thread harness (shared by thread-authority and r2b-authority): the
// real index.js thread lifecycle + attach() + threadContext() in a vm, the
// real src/thread-main.js, and fakes only at the Electron and Tasks-service
// boundaries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createThreadMain } = require('../../src/thread-main');

const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'buddy-window/index.js'), 'utf8');
const between = (text, a, b) => { const i = text.indexOf(a); const j = text.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, `${a} … ${b}`); return text.slice(i, j); };
const DIR = path.join(root, 'buddy-window');
const A = 'a'.repeat(64), B = 'b'.repeat(64), DEVICE = 'd'.repeat(64), SESSION = 'c'.repeat(64);

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

// R4-2: main's hook side (main.js threadHook), faked at the request-file boundary. One request per session;
// prepare() refuses another session's, and write() is the one place an answer leaves (logged as an effect).
function fakeHook(effects, { requests = [{ id: 'req-1', sessionId: 's-1', hash: 'dh-1', danger: null, kind: 'permission' }], answering = true, flagged = () => false } = {}) {
  const hook = {
    requests, answering, writes: [],
    checkMore: (m) => !!m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).every((k) => ['answers', 'content', 'message', 'anyway'].includes(k)) && (!('anyway' in m) || m.anyway === true),
    inputs: (t) => ({ answering: hook.answering, items: hook.requests.filter((r) => r.sessionId === t.sessionId).map((r) => ({ input: { id: r.id, session: r.sessionId, kind: r.kind, source: 'hook', answerable: true, options: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] }, hash: r.hash, danger: r.danger })) }),
    prepare(t, inputId, optionId) {
      if (!hook.answering) return { ok: false, code: 'OFF' };
      const r = hook.requests.find((x) => x.id === inputId);
      if (!r) return { ok: false, code: 'GONE' };
      if (r.sessionId !== t.sessionId) return { ok: false, code: 'NOT_FOUND' };
      if (!['allow', 'deny'].includes(optionId)) return { ok: false, code: 'VALIDATION' };
      return { ok: true, hash: r.hash, danger: r.danger, flagged: flagged(r, optionId) === true, write: () => { hook.writes.push([inputId, optionId]); effects.push(['answer', inputId, optionId]); return { ok: true }; } };
    },
  };
  return hook;
}

// The real index.js thread lifecycle + attach() + threadContext(), in a vm.
function world({ targets = { [A]: { kind: 'task', taskId: 'task-a' }, [B]: { kind: 'task', taskId: 'task-b' }, [SESSION]: { kind: 'session', source: 'claude', sessionId: 's-1', origin: 'iTerm' } }, tasks = fakeTasks(), now, hook: hookOpts } = {}) {
  const win = fakeWindow();
  const effects = [];
  const hook = fakeHook(effects, hookOpts);
  const retired = [];
  let thread = null;
  const ctx = {
    URL, path, DIR, pathToFileURL, chatFirst: true, win, content: null, selected: 'board',
    setupLocalGeneration: 0, setupSourcesGeneration: 0, tasksGeneration: 0, homeGeneration: 0, localViews: new Map(),
    tasksModalTicket: null, homeModalTicket: null, setupModalTicket: null, // the other pages' dialogs (R4-1b threadConfirm)
    store: { ws: 'ws-1', active() { return { id: this.ws }; } },
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
    + 'globalThis.peek = () => ({ threadView, threadId, threadDocument, resumeThreadId, content, selected, threadModalTicket });';
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
    hook,
    ...(now ? { now } : {}),
  });
  thread.register(ipc);
  const call = (name, e, ...a) => ipc.handlers[name](e, ...a);
  const doc = () => { const v = ctx.peek().threadView; return v ? { sender: v.webContents, senderFrame: v.webContents.mainFrame } : null; };
  return { ctx, win, tasks, effects, retired, thread, ipc, call, doc, hook, peek: () => ctx.peek() };
}


module.exports = { world, fakeHook, fakeContents, fakeWindow, fakeTasks, between, A, B, DEVICE, SESSION, root, src };
