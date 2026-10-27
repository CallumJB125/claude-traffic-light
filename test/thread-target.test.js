'use strict';
// Redesign R2a: a thread's target is resolved without a build (labfix-review S3).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOverviewService } = require('../src/overview-service');

const time = Date.parse('2026-10-27T10:00:00Z');
const at = (n) => new Date(time - n).toISOString();

function fixture({ tasks = [{ id: 'task-1', title: 'Fix the tests', ai: { id: 'claude' }, state: 'running', label: 'Working', green: true, actions: [] }], sessions = null } = {}) {
  const state = { reads: 0, tasks, connected: true };
  state.sessions = sessions ?? [
    { sessionId: 'local-1', source: 'claude', cwd: '/Users/me/work/billing', updatedAt: at(5000), signal: 'tool-use', hostApp: 'iTerm2' },
    { sessionId: 'remote-1', source: 'claude', cwd: '/Users/other/api', updatedAt: at(5000), signal: 'tool-use', remote: true, deviceName: 'Studio' },
    { sessionId: 'device-1', source: 'codex', cwd: '/Users/other/web', updatedAt: at(5000), signal: 'tool-use', device: 'dev-1' },
  ];
  const svc = createOverviewService({
    now: () => time,
    sessions: () => state.sessions,
    work: async () => { state.reads++; return { sources: [], capture: [] }; },
    managed: () => ({ conn: { status: state.connected ? 'connected' : 'offline' }, tasks: state.tasks }),
  });
  return { svc, state };
}
const rowsOf = async (svc) => (await svc.passiveRows(() => true)).rows;

test('a managed task and a local session resolve; paired-device sessions never do', async () => {
  const { svc } = fixture();
  const rows = await rowsOf(svc);
  const task = rows.find((r) => r.label === 'Managed task');
  const local = rows.find((r) => r.device.local && r.label === 'Session');
  const remote = rows.filter((r) => !r.device.local);
  assert.equal(remote.length, 2);
  assert.deepEqual({ ...svc.threadTarget(task.id), row: undefined }, { kind: 'task', taskId: 'task-1', row: undefined });
  const s = svc.threadTarget(local.id);
  assert.equal(s.kind, 'session');
  assert.equal(s.sessionId, 'local-1');
  assert.equal(s.origin, 'iTerm');
  for (const r of remote) assert.equal(svc.threadTarget(r.id), null, 'nothing that cannot be attributed to this Mac');
});

test('N thread reads cost no board-source pass (no build per read)', async () => {
  const { svc, state } = fixture();
  const rows = await rowsOf(svc);
  const before = state.reads;
  for (let i = 0; i < 50; i++) for (const r of rows) svc.threadTarget(r.id);
  assert.equal(state.reads - before, 0);
});

test('every read re-checks the in-memory state: a gone task or session no longer resolves', async () => {
  const { svc, state } = fixture();
  const rows = await rowsOf(svc);
  const task = rows.find((r) => r.label === 'Managed task'), local = rows.find((r) => r.device.local && r.label === 'Session');
  state.tasks = [];
  assert.equal(svc.threadTarget(task.id), null);
  state.sessions = state.sessions.filter((x) => x.sessionId !== 'local-1');
  assert.equal(svc.threadTarget(local.id), null);
});

test('a session that becomes remote, or the Tasks connection dropping, resolves to nothing', async () => {
  const { svc, state } = fixture();
  const rows = await rowsOf(svc);
  const task = rows.find((r) => r.label === 'Managed task'), local = rows.find((r) => r.device.local && r.label === 'Session');
  state.sessions = state.sessions.map((x) => (x.sessionId === 'local-1' ? { ...x, remote: true } : x));
  assert.equal(svc.threadTarget(local.id), null);
  state.connected = false;
  assert.equal(svc.threadTarget(task.id), null);
});

test('a managed task resolves before any build has listed it (a link); its id is the HMAC row id only', async () => {
  const { svc } = fixture();
  const rows = await (async () => { const other = fixture(); return rowsOf(other.svc); })();
  const foreign = rows.find((r) => r.label === 'Managed task');
  assert.equal(svc.threadTarget(foreign.id), null, "another service's id (another secret) never resolves");
  const own = (await rowsOf(svc)).find((r) => r.label === 'Managed task');
  const fresh = fixture();
  assert.equal(fresh.svc.threadTarget(own.id), null);
  // The latest build doesn't list the task (it arrived after it): resolved from the snapshot.
  const s2 = fixture();
  const id = (await rowsOf(s2.svc)).find((r) => r.label === 'Managed task').id;
  const task = s2.state.tasks;
  s2.state.tasks = [];
  await rowsOf(s2.svc); // the latest build has no such row now
  s2.state.tasks = task;
  const reads = s2.state.reads;
  assert.equal(s2.svc.threadTarget(id).taskId, 'task-1');
  assert.equal(s2.state.reads, reads, 'still no build');
});

test('malformed ids are refused before any lookup', () => {
  const { svc } = fixture();
  for (const bad of [null, 1, '', 'x'.repeat(64), 'A'.repeat(64), `${'a'.repeat(63)}`, `${'a'.repeat(64)}0`, { id: 'a' }]) assert.equal(svc.threadTarget(bad), null);
});

test('a hub task (on a board, not this Mac\'s queue) has no thread target', async () => {
  const { svc } = fixture({ tasks: [{ id: 'hub-1', title: 'On a board', ai: { id: 'claude' }, state: 'running', label: 'Working', green: true, actions: [], hub: { id: 'h' } }] });
  const rows = await rowsOf(svc);
  assert.equal(rows.filter((r) => r.label === 'Managed task').length, 0);
});
