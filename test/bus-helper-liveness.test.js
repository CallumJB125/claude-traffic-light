'use strict';
// D1: bus_hello used to hold the caller for the whole relay deadline when the Tasks helper was stuck (behind a macOS
// keychain dialog, say) before answering tasks_helper_unavailable. A short liveness probe now refuses at once, with
// which state the helper is in and when to retry. D2: those failed calls were traced as result "ok"; every bus verb's
// error and timeout path is now traced as an error.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { testTempDir } = require('./helpers/tmp');
const { createTasksService } = require('../src/tasks-service.js');
const BusTrace = require('../src/bus-trace.js');
const { world } = require('./helpers/bind-world.js');

const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

async function serve(agentBus, extra = {}) {
  const rootDir = testTempDir('ctl-live-');
  const S = require('../src/signal-server.js')({ rootDir, sessionsDir: rootDir, requestsDir: rootDir, aggregateState: () => ({ sessions: [] }), broadcastStatus: () => {}, port: 0, app: { on: () => {} }, agentBus, ...extra });
  const server = S.startSignalServer();
  await new Promise((resolve) => server.once('listening', resolve));
  await until(() => fs.existsSync(path.join(rootDir, 'token')));
  const token = fs.readFileSync(path.join(rootDir, 'token'), 'utf8');
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/bus`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-buddy-token': token }, body: JSON.stringify(body) }).then((r) => r.json());
  return { post, close: () => { server.close(); fs.rmSync(rootDir, { recursive: true, force: true }); } };
}

test('D1: a helper that never finishes starting is refused within the probe, not the relay deadline', async () => {
  const never = new Promise(() => {});
  const svc = createTasksService({ boardHome: testTempDir('live-svc-'), homeDir: '/Users/nobody', ensureSupervisor: () => never, busStartMs: 300 });
  const s = await serve((op, args, caller) => svc.bus(op, args, caller));
  try {
    for (const op of ['hello', 'status', 'handoff']) {
      const t0 = Date.now();
      const r = await s.post({ op, args: op === 'handoff' ? { request_id: 'req-00000001', title: 'x', to: { provider: 'any' } } : { provider: 'claude' } });
      const ms = Date.now() - t0;
      assert.ok(ms < 2000, `${op} took ${ms} ms`);
      assert.equal(r.available, false);
      assert.equal(r.reason, 'tasks_helper_unavailable');
      assert.equal(r.helper, 'starting');
      assert.equal(r.retry_after_s, 5, 'a helper still starting is seconds away');
      assert.match(r.message, /still starting.*about 5 seconds/);
      assert.match(r.message, op === 'handoff' ? /Nothing was handed off/ : /Nothing was changed/);
      assert.ok(!('outcome' in r), 'nothing was sent, so the outcome is known');
    }
  } finally { s.close(); svc.stop(); }
});

test('D1: a connected helper whose heartbeat stopped (stuck behind a prompt) is refused as stuck before anything is sent', async () => {
  const { startMockServer } = await import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'mock-server.js')).href);
  const dir = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'pt-live-'));
  const srv = await startMockServer({ dir, speed: 40, hbMs: 30 });
  let stale = 60_000;
  const svc = createTasksService({ boardHome: dir, homeDir: path.resolve('/Users/demo'), busStartMs: 3000, get busHbStaleMs() { return stale; } });
  svc.start();
  try {
    await until(() => svc.snapshot().conn.status === 'connected');
    // A live heartbeat: the op goes through.
    await new Promise((r) => setTimeout(r, 120));
    const ok = await svc.bus('status', {}).then((x) => x, (e) => e);
    assert.notEqual(ok?.code, 'SUPERVISOR_UNREACHABLE');
    stale = 0;
    const t0 = Date.now();
    const e = await svc.bus('hello', { provider: 'claude' }).then(() => null, (x) => x);
    assert.ok(Date.now() - t0 < 500);
    assert.equal(e?.code, 'SUPERVISOR_UNREACHABLE');
    assert.equal(e?.helper, 'stuck');
  } finally { svc.stop(); await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cold start: a helper that is merely starting is waited for, so the first bus_hello is answered, not refused', async () => {
  const { startMockServer } = await import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'mock-server.js')).href);
  const dir = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'pt-cold-'));
  let srv = null;
  // The helper comes up 5 s after the first call (past the old 4 s probe): ensure() resolves once it listens, as tasks-process does.
  const ready = new Promise((resolve) => setTimeout(async () => { srv = await startMockServer({ dir, speed: 40, hbMs: 30 }); resolve(); }, 5000));
  const svc = createTasksService({ boardHome: dir, homeDir: path.resolve('/Users/demo'), ensureSupervisor: () => ready });
  const s = await serve((op, args, caller) => svc.bus(op, args, caller));
  try {
    const t0 = Date.now();
    const r = await s.post({ op: 'status', args: {} });
    const ms = Date.now() - t0;
    assert.ok(ms >= 4500 && ms < 9500, `answered after the helper came up (${ms} ms)`);
    assert.notEqual(r.reason, 'tasks_helper_unavailable', JSON.stringify(r));
  } finally { s.close(); svc.stop(); await ready; await srv?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cold start: the default start wait is about 8 s; a helper that could not start is refused at once', async () => {
  const never = new Promise(() => {});
  const svc = createTasksService({ boardHome: testTempDir('live-svc-'), homeDir: '/Users/nobody', ensureSupervisor: () => never });
  const t0 = Date.now();
  const e = await svc.bus('hello', { provider: 'claude' }).then(() => null, (x) => x);
  const ms = Date.now() - t0;
  assert.equal(e?.helper, 'starting');
  assert.ok(ms >= 7500 && ms < 9500, `waited ${ms} ms`);
  svc.stop();
  const down = createTasksService({ boardHome: testTempDir('live-svc-'), homeDir: '/Users/nobody', ensureSupervisor: () => Promise.reject(new Error('spawn failed')) });
  const t1 = Date.now();
  const d = await down.bus('hello', { provider: 'claude' }).then(() => null, (x) => x);
  assert.equal(d?.helper, 'down');
  assert.ok(Date.now() - t1 < 500, 'down is refused fast');
  down.stop();
});

test('cold start: refusals say when to retry: starting soon, stuck or down later', async () => {
  for (const [helper, after] of [['starting', 5], ['stuck', 30], ['down', 30]]) {
    const s = await serve(async () => { throw Object.assign(new Error('unavailable'), { code: 'SUPERVISOR_UNREACHABLE', helper }); });
    try {
      const r = await s.post({ op: 'hello', args: { provider: 'claude' } });
      assert.deepEqual([r.helper, r.retry_after_s], [helper, after]);
      assert.match(r.message, new RegExp(`about ${after} seconds`));
    } finally { s.close(); }
  }
});

test('D1: a read-only op that hangs in main is answered by the shorter quick deadline, with the stuck hint', async () => {
  const s = await serve(() => new Promise(() => {}), { busQuickDeadlineMs: 200, busDeadlineMs: 5000 });
  try {
    const t0 = Date.now();
    const r = await s.post({ op: 'hello', args: { provider: 'claude' } });
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(r.helper, 'stuck');
    assert.match(r.message, /keychain/);
  } finally { s.close(); }
});

test('D2: trace results: unavailable and timeouts are errors, refusals refused, never ok', () => {
  const R = BusTrace.resultOf;
  assert.deepEqual(R({ available: false, reason: 'tasks_helper_unavailable' }), { result: 'error', reason: 'TASKS_HELPER_UNAVAILABLE' });
  assert.deepEqual(R({ available: false, reason: 'tasks_helper_unavailable', outcome: 'unknown' }), { result: 'deferred', reason: 'TASKS_HELPER_UNAVAILABLE' });
  assert.deepEqual(R(null, Object.assign(new Error('x'), { code: 'SUPERVISOR_UNREACHABLE' })), { result: 'error', reason: 'SUPERVISOR_UNREACHABLE' });
  assert.deepEqual(R(null, Object.assign(new Error('x'), { code: 'VALIDATION' })), { result: 'refused', reason: 'VALIDATION' });
  assert.deepEqual(R(null, new Error('no code')), { result: 'error', reason: 'ERROR' });
  assert.deepEqual(R({ reason: 'UNAVAILABLE', message: 'x' }), { result: 'error', reason: 'UNAVAILABLE' });
  assert.deepEqual(R({ reason: 'RATE' }), { result: 'refused', reason: 'RATE' });
  assert.deepEqual(R({ agent_id: 'a' }), { result: 'ok', reason: null });
});

test('D2: main traces a forwarded hello or hand-off the helper never answered as an error', async (t) => {
  const w = world(t);
  const lines = [];
  const aw = w.make({ mcpCaps: () => ({ claude: true, codex: true }), halted: () => false, trace: { append: (e) => { lines.push(e); return e; } } });
  t.after(() => aw.stop());
  await aw.build();
  await aw.refresh();
  const down = async () => { throw Object.assign(new Error('unavailable'), { code: 'SUPERVISOR_UNREACHABLE', helper: 'stuck' }); };
  for (const op of ['hello', 'handoff', 'status', 'read', 'wait']) {
    const args = op === 'handoff' ? { request_id: 'req-00000001', title: 'x', to: { provider: 'any' } } : {};
    await assert.rejects(aw.relay(op, args, { provider: 'claude', cwd: w.repoA }, w.call(101), { forward: down }));
    const line = lines.at(-1);
    assert.equal(line.op, op);
    assert.equal(line.result, 'error', `${op}: ${JSON.stringify(line)}`);
    assert.equal(line.reason, 'SUPERVISOR_UNREACHABLE');
  }
  // A helper that answered (ok or refused) writes its own line: main adds none.
  const n = lines.length;
  await aw.relay('status', {}, { provider: 'claude', cwd: w.repoA }, w.call(101), { forward: async () => ({ halted: false }) });
  await aw.relay('hello', {}, { provider: 'claude', cwd: w.repoA }, w.call(101), { forward: async () => ({ reason: 'RATE' }) });
  assert.equal(lines.length, n);
});
// The helper's half of D2 (an answer after main stopped waiting is a TIMEOUT): board/tasks-engine/test/bus-trace-timeout.test.js.

test('D2: a hand-off main stopped waiting for (TIMEOUT) is traced deferred, matching the caller\'s unknown outcome; unreachable stays an error', async (t) => {
  const w = world(t);
  const lines = [];
  const aw = w.make({ mcpCaps: () => ({ claude: true, codex: true }), halted: () => false, trace: { append: (e) => { lines.push(e); return e; } } });
  t.after(() => aw.stop());
  await aw.build();
  await aw.refresh();
  const args = { request_id: 'req-00000002', title: 'x', to: { provider: 'any' } };
  const timedOut = async () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); };
  await assert.rejects(aw.relay('handoff', args, { provider: 'claude', cwd: w.repoA }, w.call(101), { forward: timedOut }));
  assert.deepEqual([lines.at(-1).op, lines.at(-1).result, lines.at(-1).reason], ['handoff', 'deferred', 'TIMEOUT']);
  await assert.rejects(aw.relay('hello', {}, { provider: 'claude', cwd: w.repoA }, w.call(101), { forward: timedOut }));
  assert.deepEqual([lines.at(-1).op, lines.at(-1).result], ['hello', 'error'], 'a read-only op that timed out failed');
});
