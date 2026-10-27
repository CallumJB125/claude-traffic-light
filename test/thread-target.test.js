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
  const t = svc.threadTarget(task.id);
  assert.deepEqual({ ...t, vm: undefined }, { kind: 'task', taskId: 'task-1', vm: undefined });
  // R2b-1: the target carries the row's SessionRowVM, whose ref names this chat.
  assert.equal(t.vm.id, task.id);
  assert.deepEqual({ ...t.vm.ref }, { provider: 'claude', sessionId: 'task-1', taskId: 'task-1', origin: 'chat', driver: 'chat', hostApp: null, tabId: null });
  const s = svc.threadTarget(local.id);
  assert.equal(s.kind, 'session');
  assert.equal(s.sessionId, 'local-1');
  assert.equal(s.origin, 'iTerm');
  assert.deepEqual({ ...s.vm.ref }, { provider: s.source, sessionId: 'local-1', taskId: null, origin: 'external', driver: 'external', hostApp: 'iTerm', tabId: null });
  assert.ok(!JSON.stringify(s.vm).includes('/'), 'the vm holds no path; the cwd stays beside it');
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

// Redesign R2b-1: R2a's temporary targets map is gone; rows and thread targets come from SessionRowVM.ref.
test('no targets map remains: the sidebar and threads read the row model (PR 0s)', () => {
  const fs = require('node:fs'), path = require('node:path');
  for (const f of ['src/overview-service.js', 'src/overview-sidebar-rows.js', 'src/overview-main.js', 'src/thread-main.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\btargets\b|lastTargets|\b(?:target|known|t)\??\.row\b/, `${f} has no targets map or target.row`);
  }
});

test('a reviewed chat with no diff stays in "Finished — check it" (bucket parity with today)', async () => {
  const { svc } = fixture({ tasks: [{ id: 'task-r', title: 'Review me', ai: { id: 'claude' }, state: 'in_review', label: 'Ready to review', green: false, actions: [], repo: { name: 'zeta' }, cost: { usd: 0, budgetUsd: null } }] });
  const out = await svc.passiveRows(() => true);
  const row = out.rows.find((r) => r.label === 'Managed task');
  const vm = out.vms.get(row.id);
  assert.equal(vm.bucket, 'check');
  assert.equal(vm.bucket, row.bucket);
  assert.equal(vm.chatState, 'review');
});

test('the thread header comes from the vm: fixed keys, chatState and openInTerminal, no ref or path', async () => {
  const { HEADER_KEYS, headerOf } = require('../src/overview-sidebar-rows');
  const { svc } = fixture({ tasks: [{ id: 'task-h', title: 'Fix the tests', ai: { id: 'codex' }, state: 'handed_over', label: 'In your terminal', green: false, actions: [], repo: { name: 'zeta' }, workInPlace: true, cost: { usd: 0, budgetUsd: null } }] });
  const rows = await rowsOf(svc);
  const task = rows.find((r) => r.label === 'Managed task'), local = rows.find((r) => r.device.local && r.label === 'Session');
  const h = headerOf(svc.threadTarget(task.id), task.id);
  assert.deepEqual(Object.keys(h), HEADER_KEYS);
  assert.equal(h.ai, 'Codex');
  assert.equal(h.chatState, 'in-terminal');
  assert.deepEqual(h.openInTerminal, { available: false, reason: 'in-place' });
  const s = headerOf(svc.threadTarget(local.id), local.id);
  assert.equal(s.origin, 'iTerm');
  assert.equal(s.chatState, null);
  assert.equal(headerOf(svc.threadTarget(task.id), local.id), null, 'a vm for another row is never used');
  assert.ok(!/task-h|local-1|\//.test(JSON.stringify([h, s])), 'no ref id or path in a header');
});
