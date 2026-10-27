'use strict';
// Redesign R2b-1: who may reply in a chat (plan-r2b-auth.md §2.1, §3, §4).
// A generated senders × channels matrix over the real index.js thread
// lifecycle (test/helpers/thread-world.js), the real src/thread-main.js, the
// real src/tasks-main.js and the real src/compose-main.js, against a fake
// Tasks service that records every act, create, preflight and openTerminal.
// The allowed cells are a short, explicit list; every other cell is refused
// with zero calls. The channel list is read from the registrations, so a new
// thread:* or tasks:* channel without a column fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { world, fakeContents, fakeTasks, between, A, B, SESSION, root } = require('./helpers/thread-world');
const { CHANNELS, REPLY_TEXT } = require('../src/thread-main');
const TasksMain = require('../src/tasks-main');
const ComposeMain = require('../src/compose-main');

const engineSrc = fs.readFileSync(path.join(root, 'board/tasks-engine/engine.js'), 'utf8');
const ENGINE_ACTIONS = JSON.parse(engineSrc.match(/const ENGINE_ACTIONS = new Set\((\[[^\]]+\])\)/)[1].replace(/'/g, '"'));
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const settle = () => new Promise((r) => setImmediate(r));
const TASK = { [A]: 'task-a', [B]: 'task-b' };
// src/tasks-main.js as on main before R2b (4af4dbd5 / 70328b0f): R2b doesn't take on R6a.
const TASKS_MAIN_SHA256 = 'd6d717645881e0fc1ca331c0cb456bf62acdf1740b83bf717c455dadb5d3603b';

// ── the rig ──────────────────────────────────────────────────────────────
// One window: the thread (world), and the other documents a sender can be.
function rig({ act } = {}) {
  const clock = { t: 1_000_000 };
  const calls = [];
  const tasks = fakeTasks();
  Object.assign(tasks, {
    start() {},
    async act(req, wcId, current) {
      if (act) return act(req, wcId, current, calls);
      const ok = current() === true;
      calls.push(['act', req, wcId, ok]);
      return ok ? { ok: true, task: null } : { ok: false, code: 'ILLEGAL_TRANSITION', text: '' };
    },
    async create(draft, extra) { calls.push(['create', draft, extra?.wcId]); return { ok: false, code: 'VALIDATION' }; },
    async preflight(req) { calls.push(['preflight', req]); return { ok: false }; },
    async openTerminal(id, wcId) { calls.push(['openTerminal', id, wcId]); return { ok: false }; },
  });
  const w = world({ tasks, now: () => clock.t });
  const page = () => { const wc = fakeContents(); wc.url = 'file:///page.html'; wc.mainFrame = { url: wc.url }; return wc; };
  const docs = { tasks: page(), home: page(), sidebar: page(), overview: page() };
  // The Tasks and Home documents are live and foreground for their own channels throughout,
  // so a refusal below is the sender check, never a missing context.
  const ctxOf = (wc) => ({ window: w.win, contents: wc, generation: 1, document: 1, account: 0, workspace: 'ws-1', foreground: true });
  TasksMain.register({ ipcMain: w.ipc, buddy: () => ({ tasksContext: () => ctxOf(docs.tasks) }), service: () => tasks });
  ComposeMain.register({
    ipcMain: w.ipc, service: () => tasks, config: () => ({}), sessions: () => [], isDir: async () => true,
    buddy: () => ({ homeContext: () => ctxOf(docs.home), pageWebContents: (id) => (id === 'home' ? docs.home : null), homeDocument: () => ({ wcId: docs.home.id, doc: 1 }) }),
  });
  const ev = (wc) => ({ sender: wc, senderFrame: wc.mainFrame });
  return { w, tasks, calls, clock, docs, ev };
}

// ── senders (rows) ───────────────────────────────────────────────────────
// bound: the row the document was opened for (null for a non-thread document);
// live: its thread document is current; focused: and in the foreground.
const SENDERS = [
  { name: 'thread:A focused', bound: A, live: true, focused: true, make: (r) => { r.w.ctx.openThread(A); return r.w.doc(); } },
  { name: 'thread:A unfocused', bound: A, live: true, focused: false, make: (r) => { r.w.ctx.openThread(A); r.w.win.focused = false; return r.w.doc(); } },
  { name: 'thread:A hidden', bound: A, make: (r) => { r.w.ctx.openThread(A); r.w.win.visible = false; return r.w.doc(); } },
  { name: 'thread:A minimised', bound: A, make: (r) => { r.w.ctx.openThread(A); r.w.win.minimized = true; return r.w.doc(); } },
  { name: 'thread:A after reload', bound: A, make: (r) => { r.w.ctx.openThread(A); const old = r.w.doc(); old.sender.reload(); return old; } },
  { name: 'thread:A transcript frame', bound: A, make: (r) => { r.w.ctx.openThread(A); const d = r.w.doc(); return { sender: d.sender, senderFrame: { url: 'about:srcdoc' } }; } },
  { name: 'thread:B after A opened', bound: B, make: (r) => { r.w.ctx.openThread(B); const old = r.w.doc(); r.w.ctx.openThread(A); return old; } },
  { name: 'thread:B focused', bound: B, live: true, focused: true, make: (r) => { r.w.ctx.openThread(B); return r.w.doc(); } },
  { name: 'a terminal session\'s thread', bound: SESSION, live: true, focused: true, session: true, make: (r) => { r.w.ctx.openThread(SESSION); return r.w.doc(); } },
  { name: 'the sidebar', make: (r) => { r.w.ctx.openThread(A); return r.ev(r.docs.sidebar); } },
  { name: 'the Tasks page', tasksPage: true, make: (r) => { r.w.ctx.openThread(A); return r.ev(r.docs.tasks); } },
  { name: 'Home', home: true, make: (r) => { r.w.ctx.openThread(A); return r.ev(r.docs.home); } },
  { name: 'the Overview page', make: (r) => { r.w.ctx.openThread(A); return r.ev(r.docs.overview); } },
];

// ── channels × payloads (columns) ────────────────────────────────────────
// own: the payload names the sender's own bound row (A for a non-thread sender).
const own = (s) => s.bound ?? A;
const COLUMNS = [
  { ch: 'thread:message', name: 'send to its own chat', args: (s) => [{ id: own(s), body: 'hello' }], valid: true },
  { ch: 'thread:message', name: 'send to chat A', args: () => [{ id: A, body: 'hello' }], valid: true },
  { ch: 'thread:message', name: 'send to chat B', args: () => [{ id: B, body: 'hello' }], valid: true },
  { ch: 'thread:message', name: 'send to a malformed id', args: () => [{ id: 'x', body: 'hello' }] },
  { ch: 'thread:message', name: 'send with an extra key', args: (s) => [{ id: own(s), body: 'hello', extra: 1 }] },
  { ch: 'thread:message', name: 'send naming an action', args: (s) => [{ id: own(s), body: 'hello', action: 'approve' }] },
  { ch: 'thread:message', name: 'send with confirmed', args: (s) => [{ id: own(s), body: 'hello', confirmed: true }] },
  { ch: 'thread:message', name: 'send an over-length body', args: (s) => [{ id: own(s), body: 'x'.repeat(8193) }] },
  { ch: 'thread:message', name: 'send an empty body', args: (s) => [{ id: own(s), body: '   ' }] },
  { ch: 'thread:message', name: 'send two arguments', args: (s) => [{ id: own(s), body: 'hello' }, 'more'] },
  { ch: 'thread:message', name: 'send a bare string', args: (s) => [own(s)] },
  ...ENGINE_ACTIONS.flatMap((action) => [A, B].map((row) => ({ ch: 'tasks:act', name: `${action} for task ${row === A ? 'A' : 'B'}`, args: () => [{ id: TASK[row], action, payload: {} }] }))),
  ...[A, B].map((row) => ({ ch: 'tasks:open-terminal', name: `open task ${row === A ? 'A' : 'B'} in a terminal`, args: () => [TASK[row]] })),
  { ch: 'tasks:create', name: 'create a task', args: () => [{ text: 'x', folder: 'f' }] },
  { ch: 'tasks:preflight', name: 'preflight a folder', args: () => [{ folder: 'f' }] },
  { ch: 'compose:run', name: 'run from Home\'s box', args: () => [{ text: 'x', folder: 'f', ai: 'claude' }] },
  { ch: 'compose:stop', name: 'stop from Home\'s box', args: () => [{ id: 'task-a', confirmed: true }] },
  // Every other thread:* channel (R2a's reads and navigation effects), for its own row and for A.
  ...CHANNELS.filter((c) => c !== 'thread:message').flatMap((ch) => [
    { ch, name: `${ch} for its own row`, args: (s) => [own(s)] },
    { ch, name: `${ch} for row A`, args: () => [A] },
  ]),
];

// The allowed cells, explicitly. Anything not here must make zero service calls and zero effects.
function allowed(s, col, args) {
  if (col.ch === 'thread:message') return !!s.live && !!s.focused && !s.session && col.valid === true && args[0].id === s.bound;
  if (col.ch.startsWith('tasks:')) return !!s.tasksPage;
  if (col.ch.startsWith('compose:')) return !!s.home;
  // R2a reads and effects: the current thread document for its own row (effects also need focus; they never act).
  if (col.ch.startsWith('thread:')) return !!s.live && args[0] === s.bound;
  return false;
}

for (const s of SENDERS) {
  for (const col of COLUMNS) {
    const args = col.args(s);
    const ok = allowed(s, col, args);
    test(`${col.name} from ${s.name} is ${ok ? 'allowed' : 'refused'}`, async () => {
      const r = rig();
      const e = s.make(r);
      await settle();
      const before = r.calls.length, effects = r.w.effects.length;
      const out = await r.w.ipc.handlers[col.ch](e, ...args);
      await settle();
      const made = r.calls.slice(before), did = r.w.effects.slice(effects);
      if (!ok) {
        assert.deepEqual(made, [], 'no act, create, preflight or openTerminal');
        assert.deepEqual(did, [], 'no navigation effect');
        if (col.ch === 'thread:message') assert.ok(out === null || out.ok === false, JSON.stringify(out));
        return;
      }
      if (col.ch === 'thread:message') {
        assert.deepEqual(out, { ok: true });
        assert.equal(made.length, 1);
        const [kind, req, wcId, current] = made[0];
        assert.equal(kind, 'act');
        // Main resolved the task and fixed the action; the page named only the row and the text.
        assert.deepEqual(req, { id: TASK[s.bound], action: 'message', payload: { body: 'hello' } });
        assert.equal(wcId, e.sender.id);
        assert.equal(current, true);
      } else if (col.ch.startsWith('thread:')) {
        assert.deepEqual(made.filter(([k]) => k !== 'preflight'), [], 'R2a channels never act');
      } else if (col.ch === 'tasks:act') {
        assert.equal(made.length, 1, 'the Tasks page still reaches act (unchanged)');
        assert.equal(made[0][2], r.docs.tasks.id);
      }
    });
  }
}

test('completeness: every registered thread:* and tasks:* channel has a column, and the rows cover every sender kind', () => {
  const r = rig();
  const registered = Object.keys(r.w.ipc.handlers).filter((n) => /^(thread|tasks|newchat):/.test(n)).sort();
  const columns = [...new Set(COLUMNS.map((c) => c.ch))].filter((n) => /^(thread|tasks|newchat):/.test(n)).sort();
  assert.deepEqual(registered, columns);
  assert.ok(registered.includes('thread:message'));
  assert.deepEqual([...ENGINE_ACTIONS].sort(), ['answer', 'approve', 'deny', 'discard', 'handback', 'merge', 'message', 'openPr', 'pause', 'resume', 'retry', 'stop', 'switchAi', 'takeover'].sort());
  // The allowed thread:message cells are exactly the two focused task threads sending to their own chat.
  const cells = SENDERS.flatMap((s) => COLUMNS.filter((c) => c.ch === 'thread:message').filter((c) => allowed(s, c, c.args(s))).map((c) => `${s.name} · ${c.name}`));
  assert.deepEqual(cells, ['thread:A focused · send to its own chat', 'thread:A focused · send to chat A', 'thread:B focused · send to its own chat', 'thread:B focused · send to chat B']);
});

// ── refusal codes ────────────────────────────────────────────────────────

test('refusal codes: unfocused, malformed, a session thread and a mismatched id each say why, before any await', async () => {
  const r = rig();
  r.w.ctx.openThread(A);
  const d = r.w.doc();
  r.w.win.focused = false;
  assert.deepEqual(await r.w.ipc.handlers['thread:message'](d, { id: A, body: 'hi' }), { ok: false, code: 'ILLEGAL_TRANSITION', text: REPLY_TEXT.FOCUS });
  r.w.win.focused = true;
  assert.equal((await r.w.ipc.handlers['thread:message'](d, { id: B, body: 'hi' })).code, 'VALIDATION');
  assert.equal((await r.w.ipc.handlers['thread:message'](d, Object.assign(Object.create({ extra: 1 }), { id: A, body: 'hi' }))).code, 'VALIDATION', 'a non-plain object');
  assert.equal((await r.w.ipc.handlers['thread:message'](d, { id: A, body: 'é'.repeat(4097) })).code, 'VALIDATION', 'the bound is bytes, not characters');
  const s = rig();
  s.w.ctx.openThread(SESSION);
  assert.equal((await s.w.ipc.handlers['thread:message'](s.w.doc(), { id: SESSION, body: 'hi' })).code, 'NOT_FOUND');
  assert.deepEqual([...r.calls, ...s.calls], []);
});

test('the reply is trimmed by the guard, not the thread: the body reaches act as sent', async () => {
  const r = rig();
  r.w.ctx.openThread(A);
  assert.deepEqual(await r.w.ipc.handlers['thread:message'](r.w.doc(), { id: A, body: '  hi  ' }), { ok: true });
  assert.deepEqual(r.calls[0][1].payload, { body: '  hi  ' });
});

// ── stale and in-flight cases (plan-r2b-auth §4) ─────────────────────────

function held() {
  let release;
  const gate = new Promise((res) => { release = res; });
  return { gate, release };
}

test('reload during act: current() is false at the point of no return, so nothing is sent and the reply is CONFLICT', async () => {
  const h = held();
  let sent = 0;
  const r = rig({ act: async (req, wcId, current) => { await h.gate; if (current() !== true) return { ok: false, code: 'ILLEGAL_TRANSITION', text: '' }; sent++; return { ok: true }; } });
  r.w.ctx.openThread(A);
  const d = r.w.doc();
  const p = r.w.ipc.handlers['thread:message'](d, { id: A, body: 'hi' });
  d.sender.reload();
  h.release();
  assert.deepEqual(await p, { ok: false, code: 'CONFLICT', text: REPLY_TEXT.CONFLICT });
  assert.equal(sent, 0);
});

test('reload after client.act: CONFLICT, the message was sent exactly once, and nothing reaches the new document', async () => {
  const h = held();
  let sent = 0;
  const r = rig({ act: async (req, wcId, current) => { if (current() !== true) return { ok: false }; sent++; await h.gate; return { ok: true }; } });
  r.w.ctx.openThread(A);
  const d = r.w.doc();
  const p = r.w.ipc.handlers['thread:message'](d, { id: A, body: 'hi' });
  await settle();
  const wc = d.sender, before = wc.sent.length;
  wc.reload();
  h.release();
  assert.equal((await p).code, 'CONFLICT');
  assert.equal(sent, 1);
  // The reloaded page gets index.js's own readiness push and nothing else: the reply is the invoke result only.
  assert.deepEqual(wc.sent.slice(before).map(([ch]) => ch).filter((ch) => ch !== 'thread:ready'), []);
});

test('the bound task stops resolving during the await: current() is false and nothing is sent', async () => {
  const targets = { [A]: { kind: 'task', taskId: 'task-a' } };
  const h = held();
  let sent = 0;
  const tasks = fakeTasks();
  tasks.act = async (req, wcId, current) => { await h.gate; if (current() !== true) return { ok: false, code: 'ILLEGAL_TRANSITION' }; sent++; return { ok: true }; };
  const w = world({ targets, tasks });
  w.ctx.openThread(A);
  const p = w.ipc.handlers['thread:message'](w.doc(), { id: A, body: 'hi' });
  delete targets[A];
  h.release();
  assert.equal((await p).code, 'CONFLICT');
  assert.equal(sent, 0);
});

test('the row resolving to another task during the await is CONFLICT too (the taskId is main\'s, fixed before the await)', async () => {
  const targets = { [A]: { kind: 'task', taskId: 'task-a' } };
  const h = held();
  const seen = [];
  const tasks = fakeTasks();
  tasks.act = async (req, wcId, current) => { await h.gate; seen.push([req.id, current()]); return { ok: false }; };
  const w = world({ targets, tasks });
  w.ctx.openThread(A);
  const p = w.ipc.handlers['thread:message'](w.doc(), { id: A, body: 'hi' });
  targets[A] = { kind: 'task', taskId: 'task-z' };
  h.release();
  assert.equal((await p).code, 'CONFLICT');
  assert.deepEqual(seen, [['task-a', false]]);
});

test('an account or workspace switch, or the window losing focus, during the await is CONFLICT', async () => {
  for (const flip of [(w) => { w.ctx.setupSourcesGeneration++; }, (w) => { w.ctx.store.ws = 'ws-2'; }, (w) => { w.win.focused = false; }]) {
    const h = held();
    let sent = 0;
    const tasks = fakeTasks();
    tasks.act = async (req, wcId, current) => { await h.gate; if (current() !== true) return { ok: false }; sent++; return { ok: true }; };
    const w = world({ tasks });
    w.ctx.openThread(A);
    const p = w.ipc.handlers['thread:message'](w.doc(), { id: A, body: 'hi' });
    flip(w);
    h.release();
    assert.equal((await p).code, 'CONFLICT');
    assert.equal(sent, 0);
  }
});

test('two replies in one tick: one act, the second is BUSY; and S1\'s 500 ms limit applies after it', async () => {
  const h = held();
  const r = rig({ act: async (req, wcId, current, calls) => { calls.push(['act', req]); await h.gate; return { ok: true }; } });
  r.w.ctx.openThread(A);
  const d = r.w.doc();
  const first = r.w.ipc.handlers['thread:message'](d, { id: A, body: 'one' });
  const second = await r.w.ipc.handlers['thread:message'](d, { id: A, body: 'two' });
  assert.deepEqual(second, { ok: false, code: 'BUSY', text: REPLY_TEXT.BUSY });
  h.release();
  assert.deepEqual(await first, { ok: true });
  r.clock.t += 100;
  assert.equal((await r.w.ipc.handlers['thread:message'](d, { id: A, body: 'three' })).code, 'BUSY', 'within 500 ms');
  r.clock.t += 500;
  assert.deepEqual(await r.w.ipc.handlers['thread:message'](d, { id: A, body: 'four' }), { ok: true });
  assert.deepEqual(r.calls.map(([, req]) => req.payload.body), ['one', 'four']);
});

test('a refusal from validateAct comes back as its code; the thread never retries with another action', async () => {
  const r = rig({ act: async (req, wcId, current, calls) => { calls.push(['act', req]); return { ok: false, code: 'ILLEGAL_TRANSITION', text: 'The task is not in a state where that can be done any more. It has been refreshed.' }; } });
  r.w.ctx.openThread(A);
  const out = await r.w.ipc.handlers['thread:message'](r.w.doc(), { id: A, body: 'hi' });
  assert.equal(out.code, 'ILLEGAL_TRANSITION');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0][1].action, 'message');
});

// ── native confirm (plan-r2b-auth §3) ────────────────────────────────────

test('message is never native or page-confirmed: NATIVE_ACTIONS, CONFIRM_ACTIONS and the engine\'s confirmFor', () => {
  const guardSrc = fs.readFileSync(path.join(root, 'src/tasks-guard.js'), 'utf8');
  const native = JSON.parse(guardSrc.match(/const NATIVE_ACTIONS = (\[[^\]]+\]);/)[1].replace(/'/g, '"'));
  assert.ok(!native.includes('message'), 'native');
  assert.ok(!require('../src/tasks-guard').NATIVE_ACTIONS.includes('message'), 'the exported copy too');
  assert.ok(!require('../src/tasks-view').CONFIRM_ACTIONS.includes('message'), 'page-confirmed');
  const face = fs.readFileSync(path.join(root, 'board/tasks-api/face.js'), 'utf8');
  const confirmFor = between(face, 'export function confirmFor(task) {', '\n}\n');
  assert.deepEqual([...confirmFor.matchAll(/c\.push\('([^']+)'\)/g)].map((m) => m[1]), ['takeover', 'discard']);
});

test('if message ever needed confirming (per task), the reply is CONFIRM_REQUIRED with no dialog and no send', async () => {
  const P = await import('../board/tasks-api/protocol.js');
  const { taskFace } = await import('../board/tasks-api/face.js');
  const guard = require('../src/tasks-guard').createGuard({ P, taskFace });
  const task = { id: 'task-a', actions: ['message'], confirm: ['message'] };
  const v = guard.validateAct({ id: 'task-a', action: 'message', payload: { body: 'hi' } }, task, {});
  assert.equal(v.code, 'CONFIRM_REQUIRED');
  assert.notEqual(v.native, true, 'a page-confirm, which the thread can never give (no confirmed key)');
  assert.equal(guard.validateAct({ id: 'task-a', action: 'message', payload: { body: 'hi' } }, { ...task, confirm: [] }, {}).ok, true);
  const r = rig({ act: async (req, wcId, current, calls) => { calls.push(['act', req]); const x = guard.validateAct(req, task, {}); return x.ok ? { ok: true } : { ok: false, code: x.code, text: '' }; } });
  r.w.ctx.openThread(A);
  assert.deepEqual(await r.w.ipc.handlers['thread:message'](r.w.doc(), { id: A, body: 'hi' }), { ok: false, code: 'CONFIRM_REQUIRED', text: REPLY_TEXT.CONFIRM_REQUIRED });
  assert.equal('confirmed' in r.calls[0][1], false);
});

test('confirmDialog: a thread document\'s wcId gets false and no dialog, for every action (its own test, after #101)', async () => {
  const start = mainSrc.indexOf('    confirmDialog: async (info, wcId) => {', mainSrc.indexOf('function getTasks()'));
  const finish = mainSrc.indexOf('    seen: {', start);
  const shown = [], asks = [];
  const tasksWc = { id: 42 }, homeWc = { id: 41 }, threadWc = { id: 77 };
  const ctx = {
    tasksPages: () => [tasksWc], BrowserWindow: { fromWebContents: () => null },
    buddyWin: { pageWebContents: (id) => (id === 'home' ? homeWc : id === 'thread' ? threadWc : null), homeConfirm: async () => { asks.push('home'); return null; }, tasksConfirm: async () => { asks.push('tasks'); return null; }, threadContext: () => ({ contents: threadWc }) },
    dialog: { showMessageBox: async (owner, o) => { shown.push(o); return { response: 1 }; } },
  };
  vm.runInNewContext(`globalThis.confirm=({${mainSrc.slice(start, finish)}}).confirmDialog;`, ctx);
  for (const action of ['message', 'create', 'discard', 'takeover', 'openPr', 'merge', 'switchAi', 'openTerminal', 'approve', 'stop']) {
    assert.equal(await ctx.confirm({ action, label: 'x', title: 't', payload: { scope: 'task' } }, threadWc.id), false, action);
  }
  assert.deepEqual(shown, []);
  assert.deepEqual(asks, []);
});

// ── unchanged authority (plan-r2b-auth §4) ───────────────────────────────

test('unchanged: tasks-main.js is byte-for-byte main\'s (pinned hash), and tasksPages/tasksSenderOk never include a thread', () => {
  const now = fs.readFileSync(path.join(root, 'src/tasks-main.js'), 'utf8');
  assert.equal(require('node:crypto').createHash('sha256').update(now).digest('hex'), TASKS_MAIN_SHA256, 'src/tasks-main.js unchanged (pinned hash)');
  assert.match(mainSrc, /const tasksPages = \(\) => \[buddyWin\?\.pageWebContents\('tasks'\)\]\.filter\(\(w\) => w && !w\.isDestroyed\(\)\);\n/);
  assert.match(mainSrc, /const tasksSenderOk = \(e\) => !!e\.sender && tasksPages\(\)\.includes\(e\.sender\) && e\.senderFrame === e\.sender\.mainFrame;\n/);
});
