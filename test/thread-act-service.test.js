'use strict';
// Redesign R4-1b, C3 tests 4–6 end to end (plan-r4 §5 R4-1b): the real tasks-service against the real mock
// supervisor, the real src/thread-main.js and index.js thread lifecycle and threadConfirm (thread-world's vm), and
// main.js's own confirmDialog run as shipped in a vm. Only the native dialog itself is a stub that records what it
// was asked. A StartTask approve from the chat reaches the supervisor only after that dialog returns Yes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createTasksService } = require('../src/tasks-service.js');
const { world, A, root } = require('./helpers/thread-world');

const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const mockUrl = pathToFileURL(path.join(root, 'board', 'tasks-api', 'mock-server.js')).href;
const clientUrl = pathToFileURL(path.join(root, 'board', 'tasks-api', 'client.js')).href;
const tmp = () => fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'pta-'));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let srv, dir, svc, w = null, answer = false, card = 0;
const shows = [];
test.before(async () => {
  const { startMockServer } = await import(mockUrl);
  dir = tmp();
  srv = await startMockServer({ dir, speed: 40, hbMs: 200 });
  // main.js's confirmDialog, as shipped, over a buddy window whose thread methods are the real index.js ones.
  const buddyWin = { pageWebContents: () => null, newChatWcId: () => null, threadWcId: () => w?.ctx.api.threadWcId() ?? null, threadConfirm: (show) => w.ctx.api.threadConfirm(show) };
  const c = { tasksPages: () => [], buddyWin, dialog: { showMessageBox: async (owner, o) => { shows.push({ owner, message: o.message, detail: o.detail }); return { response: answer ? 1 : 0 }; } } };
  const start = mainSrc.indexOf('    confirmDialog: async (info, wcId) => {', mainSrc.indexOf('function getTasks()'));
  vm.runInNewContext('globalThis.confirm=({' + mainSrc.slice(start, mainSrc.indexOf('    seen: {', start)) + '}).confirmDialog;', c);
  svc = createTasksService({ boardHome: dir, homeDir: path.resolve('/Users/demo'), copy: () => {}, isDir: () => true, confirmDialog: c.confirm, onEvent: (wcId, id, e) => w?.thread.onEvent(wcId, id, e) });
  svc.start();
  await until(() => svc.snapshot().conn.status === 'connected');
});
test.after(async () => { svc?.stop(); await srv?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// A board-sourced task waits on a StartTask approval; the chat for it is open and has read it.
async function chat() {
  const c = await (await import(clientUrl)).connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
  const { id } = await c.createTask({ text: 'From a teammate', cwd: '/Users/demo/Development/acme-web', ai: 'claude', source: 'board', sourceMeta: { userId: 'stranger', displayName: 'Mallory', boardId: 'b', cardId: `c${++card}` } });
  c.close();
  await until(() => svc.snapshot().tasks.find((x) => x.id === id && x.actions.includes('approve')));
  w = world({ targets: { [A]: { kind: 'task', taskId: id } }, tasks: svc });
  w.ctx.openThread(A);
  const d = w.doc();
  const opened = await w.ipc.handlers['thread:open'](d, A);
  const a = opened.detail.openApprovals[0];
  assert.equal(a.tool, 'StartTask');
  await pause(650); // the 600 ms arm, on the real clock
  shows.length = 0;
  return { id, d, a, act: (req) => w.ipc.handlers['thread:act'](d, { id: A, ...req }), state: () => svc.snapshot().tasks.find((x) => x.id === id)?.state };
}

test('C3 4–6: Accept and start from the chat shows the Tasks dialog, parented to the thread window; Cancel sends nothing; Yes starts it', async () => {
  const c = await chat();
  answer = false;
  assert.deepEqual(await c.act({ action: 'approve', approvalId: c.a.approvalId, scope: 'once' }), { ok: false, code: 'CONFIRM_REQUIRED', cancelled: true, text: '' });
  assert.equal(shows.length, 1);
  assert.equal(shows[0].owner, w.win, 'parented to the window holding the thread');
  assert.equal(shows[0].message, 'Accept and start?', 'the Tasks page\'s wording');
  assert.match(shows[0].detail, /came from board/);
  assert.equal(c.state(), 'queued', 'nothing reached the supervisor');
  await pause(650);
  answer = true;
  assert.deepEqual(await c.act({ action: 'approve', approvalId: c.a.approvalId, scope: 'once' }), { ok: true });
  assert.equal(shows.length, 2);
  await until(() => c.state() !== 'queued');
  await svc.closeTask(c.d.sender.id);
});

test('C3 4: an unfocused chat, or one whose document changed during the dialog, never reaches the supervisor', async () => {
  const c = await chat();
  answer = true;
  w.win.focused = false;
  assert.equal((await c.act({ action: 'approve', approvalId: c.a.approvalId, scope: 'once' })).code, 'ILLEGAL_TRANSITION', 'refused before any dialog');
  assert.equal(shows.length, 0);
  w.win.focused = true;
  await pause(650);
  // Focus lost while the dialog is open: the ticket voids the Yes.
  const real = w.ctx.api.threadConfirm;
  w.ctx.api.threadConfirm = (show) => real.call(w.ctx.api, async (owner) => { const r = await show(owner); w.win.focused = false; return r; });
  assert.deepEqual(await c.act({ action: 'approve', approvalId: c.a.approvalId, scope: 'once' }), { ok: false, code: 'CONFIRM_REQUIRED', cancelled: true, text: '' });
  assert.equal(shows.length, 1);
  assert.equal(c.state(), 'queued');
  w.ctx.api.threadConfirm = real;
  await svc.closeTask(c.d.sender.id);
});

test('C3: StartTask Deny from the chat has no dialog, the same as Tasks; scope task on it is refused before any dialog', async () => {
  const c = await chat();
  assert.equal((await c.act({ action: 'approve', approvalId: c.a.approvalId, scope: 'task' })).code, 'VALIDATION');
  await pause(650);
  assert.deepEqual(await c.act({ action: 'deny', approvalId: c.a.approvalId }), { ok: true });
  assert.equal(shows.length, 0);
  await until(() => c.state() !== 'queued');
  await svc.closeTask(c.d.sender.id);
});
