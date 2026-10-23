'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const os = require('node:os');
const { createTasksSupervisor, tasksEnv } = require('../src/tasks-process.js');
class Child extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.pid = 987654; this.messages = []; this.killed = 0; }
  postMessage(m) { this.messages.push(m); if (m?.type === 'tasks.shutdown') queueMicrotask(() => this.emit('exit', 0)); }
  kill() { this.killed++; queueMicrotask(() => this.emit('exit', 0)); }
}
const epoch = '00000000-0000-4000-8000-000000000001';
const dataDir = path.join(os.tmpdir(), 'tasks-helper-fixture');
const entry = path.join(dataDir, 'entry.js');
const socket = path.join(dataDir, 'tasks.sock');
test('Tasks helper env passes only runtime paths, never parent credentials or Electron switches', () => {
  assert.deepEqual(tasksEnv('/data', { HOME: '/home', PATH: '/bin', CODEX_HOME: '/auth', BOARD_DEVICE_TOKEN: 'secret', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require evil', ELECTRON_RUN_AS_NODE: '1' }), { HOME: '/home', PATH: '/bin', CODEX_HOME: '/auth', PLEXIFORM_TASKS_DATA_DIR: '/data' });
});
test('Tasks helper starts once, accepts only its exact socket readiness, and stops over parentPort', async () => {
  let calls = 0; const c = new Child();
  const s = createTasksSupervisor({ fork: () => { calls++; return c; }, entry, dataDir, readyTimeoutMs: 500 });
  const p = s.ensure(); assert.equal(s.ensure(), p);
  c.emit('message', { type: 'tasks.listening', socket: path.join(os.tmpdir(), 'tasks-other-fixture', 'tasks.sock'), epoch }); assert.equal(s.status().state, 'starting');
  c.emit('message', { type: 'tasks.listening', socket, epoch }); const info = await p; assert.deepEqual(info, { socketPath: socket, epoch }); assert.equal(calls, 1);
  await s.stop({ final: true }); assert.deepEqual(c.messages, [{ type: 'tasks.shutdown' }], 'no key is sent any more (PR B)'); await assert.rejects(s.ensure());
});
test('Tasks helper readiness timeout closes the child before permitting another start', async () => {
  let calls = 0; const children = [];
  const s = createTasksSupervisor({ fork: () => { const c = new Child(); calls++; children.push(c); return c; }, entry, dataDir, readyTimeoutMs: 20 });
  const held = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(s.ensure()); await new Promise((r) => setImmediate(r)); assert.equal(children[0].killed, 1);
    const p = s.ensure(); children[1].emit('message', { type: 'tasks.listening', socket, epoch }); await p; assert.equal(calls, 2); await s.stop({ final: true });
  } finally { clearTimeout(held); }
});
test('Tasks helper bounds crash restarts and never launches after quit', async () => {
  const children = []; const s = createTasksSupervisor({ fork: () => { const c = new Child(); children.push(c); return c; }, entry, dataDir });
  for (let n = 0; n < 5; n++) { const p = s.ensure(); const c = children.at(-1); c.emit('message', { type: 'tasks.listening', socket, epoch }); await p; c.emit('exit', 1); }
  await assert.rejects(s.ensure(), /keeps stopping/); assert.equal(children.length, 5); await s.stop({ final: true }); await assert.rejects(s.ensure());
});
// PR B: main's note ops over parentPort (board/tasks-engine/parent-bus.js answers them).
async function readyHelper(opts = {}) {
  const children = [];
  const s = createTasksSupervisor({ fork: () => { const c = new Child(); children.push(c); return c; }, entry, dataDir, ...opts });
  const p = s.ensure(); children.at(-1).emit('message', { type: 'tasks.listening', socket, epoch }); await p;
  const bus = (c) => c.messages.filter((m) => m.type === 'tasks.bus');
  const answer = (c, m, body) => c.emit('message', { type: 'tasks.busResult', id: m.id, ...body });
  return { s, children, bus, answer };
}
test('busMain: one request per call with a unique id, answered only by the child it went to; a refusal carries only its code', async () => {
  const { s, children, bus, answer } = await readyHelper();
  const c = children[0];
  const a = s.busMain('notes', { me: { key: 'claude|X' } });
  const b = s.busMain('notes_pending', {});
  const [ma, mb] = bus(c);
  assert.deepEqual({ ...ma, id: undefined }, { type: 'tasks.bus', id: undefined, op: 'notes', args: { me: { key: 'claude|X' } } });
  assert.notEqual(ma.id, mb.id);
  // Another child, and an id nobody asked, are ignored.
  const other = new Child(); other.on('message', () => {});
  c.emit('message', { type: 'tasks.busResult', id: 'b999', ok: true, result: 'stray' });
  answer(c, mb, { ok: false, code: 'POLICY_DENIED', message: 'SQLITE text' });
  answer(c, ma, { ok: true, result: { notes: [] } });
  assert.deepEqual(await a, { notes: [] });
  const e = await b.catch((x) => x);
  assert.equal(e.code, 'POLICY_DENIED'); assert.ok(!String(e.message).includes('SQLITE'));
  answer(c, ma, { ok: true, result: 'again' });
  await s.stop({ final: true });
});
test('O1b: the helper\'s wrapped runs reach main, and none once it exits; a run\'s bus_peers is answered by main, only for the current helper', async () => {
  const children = []; const runs = []; const asked = [];
  const s = createTasksSupervisor({ fork: () => { const c = new Child(); children.push(c); return c; }, entry, dataDir,
    onRuns: (r) => runs.push(r), peersForTask: async (id) => { asked.push(id); return { you: 'claude-app-1a2b', peers: [] }; } });
  const p = s.ensure(); const c = children[0];
  c.emit('message', { type: 'tasks.listening', socket, epoch }); await p;
  const row = { taskId: 'tsk_a1', ai: 'claude', pid: 4242, lstart: 'x' };
  c.emit('message', { type: 'tasks.runs', runs: [row] });
  c.emit('message', { type: 'tasks.runs', runs: 'not a list' });
  assert.deepEqual(runs, [[row], []]);
  c.emit('message', { type: 'awareness.peers', id: 7, taskId: 'tsk_a1' });
  c.emit('message', { type: 'awareness.peers', id: 'x', taskId: 'tsk_a1' });
  c.emit('message', { type: 'awareness.peers', id: 8, taskId: 42 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['tsk_a1']);
  assert.deepEqual(c.messages.at(-1), { type: 'awareness.peers.reply', id: 7, result: { you: 'claude-app-1a2b', peers: [] } });
  c.emit('exit', 1);
  assert.deepEqual(runs.at(-1), [], 'a helper that stops has no runs');
  // A stale child's messages are ignored.
  c.emit('message', { type: 'tasks.runs', runs: [row] });
  assert.deepEqual(runs.at(-1), []);
  await s.stop({ final: true });
});
test('O3: the helper\'s real-work rows reach main, and none once it exits; a stale child is ignored', async () => {
  const children = []; const work = [];
  const s = createTasksSupervisor({ fork: () => { const c = new Child(); children.push(c); return c; }, entry, dataDir, onWork: (r) => work.push(r) });
  const p = s.ensure(); const c = children[0];
  c.emit('message', { type: 'tasks.listening', socket, epoch }); await p;
  const row = { taskId: 'tsk_a1', ai: 'claude', title: 'Fix', state: 'running', root: '/r', changedAt: 1 };
  c.emit('message', { type: 'tasks.work', rows: [row] });
  c.emit('message', { type: 'tasks.work', rows: { not: 'a list' } });
  assert.deepEqual(work, [[row], []]);
  c.emit('message', { type: 'tasks.work', rows: [row] });
  c.emit('exit', 1);
  assert.deepEqual(work, [[row], [], [row], []], 'the exit itself clears the rows');
  c.emit('message', { type: 'tasks.work', rows: [row] });
  assert.equal(work.length, 4, 'a stale child is ignored');
  await s.stop({ final: true });
});
test('busMain: a timeout drops the pending call and a late answer; at 64 in flight the next is refused at once; exit, replacement and stop reject what is pending', async () => {
  const { s, children, bus, answer } = await readyHelper();
  const c = children[0];
  const slow = s.busMain('notes', {}, { timeoutMs: 20 });
  const keep = setTimeout(() => {}, 1000); // the helper's timers are unref'd
  assert.equal((await slow.catch((x) => x)).code, 'TIMEOUT');
  clearTimeout(keep);
  answer(c, bus(c)[0], { ok: true, result: 'late' });
  const held = Array.from({ length: 64 }, () => s.busMain('notes_pending', {}).catch((x) => x));
  assert.equal((await s.busMain('notes_pending', {}).catch((x) => x)).code, 'UNAVAILABLE', 'bounded, never queued');
  c.emit('exit', 1);
  for (const r of await Promise.all(held)) assert.equal(r.code, 'UNAVAILABLE');
  assert.equal((await s.busMain('notes', {}).catch((x) => x)).code, 'UNAVAILABLE', 'no ready helper');
  // A replacement helper: an answer from the old child for a new request is ignored.
  const p = s.ensure(); const c2 = children.at(-1); c2.emit('message', { type: 'tasks.listening', socket, epoch }); await p;
  const fresh = s.busMain('notes', {});
  const m = bus(c2)[0];
  c.emit('message', { type: 'tasks.busResult', id: m.id, ok: true, result: 'from the old child' });
  const pending = s.busMain('notes_pending', {});
  answer(c2, m, { ok: true, result: 'from the new child' });
  assert.equal(await fresh, 'from the new child');
  await s.stop({ final: true });
  assert.equal((await pending.catch((x) => x)).code, 'UNAVAILABLE', 'stop rejects what is pending');
});
