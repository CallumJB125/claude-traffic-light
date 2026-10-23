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
  c.emit('message', { type: 'tasks.listening', socket, epoch }); const info = await p; assert.deepEqual({ ...info, mainKey: undefined }, { socketPath: socket, epoch, mainKey: undefined }); assert.equal(calls, 1);
  await s.stop({ final: true }); assert.deepEqual(c.messages, [{ type: 'tasks.mainKey', key: info.mainKey }, { type: 'tasks.shutdown' }]); await assert.rejects(s.ensure());
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
test('H1: each helper gets a fresh 32-byte main key over parentPort only, never in its env or argv, and ensure() hands it to main', async () => {
  const children = []; const forks = [];
  const s = createTasksSupervisor({ fork: (entryPath, argv, o) => { forks.push({ argv, env: o.env }); const c = new Child(); children.push(c); return c; }, entry, dataDir });
  const keys = [];
  for (let n = 0; n < 2; n++) {
    const p = s.ensure(); const c = children.at(-1);
    assert.deepEqual(c.messages, [], 'nothing is sent before the helper is listening');
    c.emit('message', { type: 'tasks.listening', socket, epoch });
    const info = await p;
    assert.match(info.mainKey, /^[0-9a-f]{64}$/);
    assert.deepEqual(c.messages, [{ type: 'tasks.mainKey', key: info.mainKey }]);
    keys.push(info.mainKey);
    c.emit('exit', 1);
  }
  assert.notEqual(keys[0], keys[1], 'the key rotates when the helper restarts');
  for (const f of forks) assert.ok(!JSON.stringify(f).includes(keys[0]) && !JSON.stringify(f).includes(keys[1]), 'never in env or argv');
  assert.ok(!JSON.stringify(s.status()).includes(keys[1]));
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
