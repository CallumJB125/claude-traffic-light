// O1b: the engine tells main (onRuns) which of the person's own wrapped runs are live — pid and start as the
// engine recorded them, the task's own folder — and a wrapped run's bus_peers is answered by main (peersFor).
// Bus runs and spin-offs are never listed and their bus_peers is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine, makeRepo, waitFor, tmpDir, rm, writePolicy } from './helpers.js';
import { startBus, rid } from './bus-helpers.js';
import { IpcClient } from '../../mcp/ipc.js';
import { lstartOf } from '../../runner/procs.js';
import { TASK_TOOL_NAMES } from '../../mcp/task-tools.js';

const denied = code => error => error.code === code;
// Lowercased, every run of non-alphanumerics one dash: case and separators cannot hide the task text in a branch slug.
const flat = v => JSON.stringify(v).toLowerCase().replace(/[^a-z0-9]+/g, '-');
const idle = { steps: [{ tool: 'Read', input: { file_path: 'README.md' }, ms: 60000 }] };
const ipcOf = async (h, id) => {
  const run = await waitFor(() => h.eng.engine.runs.get(id)?.backend?.turnActive && h.eng.engine.runs.get(id), { label: 'run' });
  return new IpcClient({ socketPath: run.socketPath, token: run.token });
};
const KEYS = ['taskId', 'ai', 'sessionId', 'root', 'worktree', 'branch', 'state', 'stateSince', 'startedAt', 'pid', 'lstart'].sort();

test('a local run is published with the engine\'s own pid, UTC start and folder; bus_peers asks main, at most every 2 s; the row goes when the run ends', { skip: process.platform === 'win32' }, async () => {
  const dir = tmpDir(), repo = makeRepo(dir);
  const published = [];
  const asked = [];
  const view = { you: 'claude-repo-abcd', bound: false, notes: false, peers: [], unverified_sessions: 0, note: 'n' };
  const h = await startEngine({ dir, scenario: { steps: [{ tool: 'Read', input: { file_path: 'README.md' }, ms: 60000 }] },
    engineOpts: { maxParallel: 4, onRuns: rows => published.push(rows), peersFor: async id => { asked.push(id); return view; } } });
  let ipc;
  try {
    assert.ok(TASK_TOOL_NAMES.includes('bus_peers'));
    const { id } = await h.client.createTask({ text: 'SECRET TASK TEXT', cwd: repo.checkout, permissionLevel: 'plan' });
    const run = await waitFor(() => h.eng.engine.runs.get(id)?.backend?.turnActive && h.eng.engine.runs.get(id));
    // Claimed first, then running: wait for the running row before counting publishes.
    const rows = await waitFor(() => published.findLast(r => r.length && r[0].state === 'running'), { label: 'running row' });
    const task = h.eng.tasks.get(id);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.deepEqual(Object.keys(row).sort(), KEYS);
    assert.equal(row.taskId, id);
    assert.equal(row.ai, 'claude');
    assert.equal(row.pid, run.backend.pid);
    assert.equal(row.lstart, lstartOf(run.backend.pid), 'the runner\'s UTC record');
    assert.equal(row.root, task.repo?.root ?? task.worktree);
    assert.equal(row.worktree, task.worktree);
    assert.equal(row.branch, null, 'a task branch is named after its text and id');
    assert.match(task.branch, /secret-task-text/, 'the branch itself does carry the slug');
    // No row field carries the task-text slug. The id is in taskId and in the worktree path (<repo>-buddy-<id>), which
    // main uses only to attest the run and never shows (test/awareness-wrapped-runs.test.js checks roster.json and the
    // AI views); every other field is free of it too.
    assert.ok(!flat(published).includes('secret-task-text'));
    const shown = published.flat().map(({ taskId, sessionId, worktree, ...rest }) => ({ ...rest, ...(sessionId === taskId ? {} : { sessionId }) }));
    assert.ok(!flat(shown).includes(id.slice(4, 10).toLowerCase()));
    // Saves keep happening (heartbeats, activity); unchanged rows are not sent again.
    const sent = published.length;
    await new Promise(r => setTimeout(r, 800));
    assert.equal(published.length, sent);

    ipc = new IpcClient({ socketPath: run.socketPath, token: run.token });
    assert.deepEqual(await ipc.request('tool', { name: 'bus_peers', args: {} }), view);
    assert.deepEqual(await ipc.request('tool', { name: 'bus_peers', args: {} }), view);
    assert.deepEqual(asked, [id], 'a second ask within 2 s is answered from the last view');
    await assert.rejects(ipc.request('tool', { name: 'bus_peers', args: { handle: 'x' } }), denied('VALIDATION'));

    // A spin-off (source mcp) is not the person's own run: never listed, its bus_peers refused.
    const helper = await ipc.request('tool', { name: 'buddy_spin_off', args: { request_id: 'helper-0001', text: 'Inspect README for the parent.', ai: 'claude' } });
    const childRun = await waitFor(() => h.eng.engine.runs.get(helper.task_id)?.backend?.turnActive && h.eng.engine.runs.get(helper.task_id));
    assert.ok(!published.at(-1).some(r => r.taskId === helper.task_id));
    const childIpc = new IpcClient({ socketPath: childRun.socketPath, token: childRun.token });
    try { await assert.rejects(childIpc.request('tool', { name: 'bus_peers', args: {} }), denied('POLICY_DENIED')); } finally { childIpc.close(); }
    assert.deepEqual(asked, [id]);

    await h.client.act(id, 'stop', {}).catch(() => h.client.act(id, 'cancel', {}));
    await waitFor(() => !published.at(-1).some(r => r.taskId === id), { label: 'row dropped' });
  } finally { ipc?.close(); await h.close(); rm(dir); }
  assert.deepEqual(published.at(-1), [], 'closing the engine publishes no runs');
});

test('without main (no peersFor), bus_peers is refused', { skip: process.platform === 'win32' }, async () => {
  const dir = tmpDir(), repo = makeRepo(dir);
  const h = await startEngine({ dir, scenario: { steps: [{ tool: 'Read', input: { file_path: 'README.md' }, ms: 60000 }] } });
  let ipc;
  try {
    const { id } = await h.client.createTask({ text: 'x', cwd: repo.checkout, permissionLevel: 'plan' });
    const run = await waitFor(() => h.eng.engine.runs.get(id)?.backend?.turnActive && h.eng.engine.runs.get(id));
    ipc = new IpcClient({ socketPath: run.socketPath, token: run.token });
    await assert.rejects(ipc.request('tool', { name: 'bus_peers', args: {} }), denied('POLICY_DENIED'));
  } finally { ipc?.close(); await h.close(); rm(dir); }
});

test('bus and phone tasks are never listed and their bus_peers is refused', { skip: process.platform === 'win32' }, async () => {
  const published = [], asked = [];
  const b = await startBus({ delayMs: 8000, text: 'Done' }, { engineOpts: { onRuns: rows => published.push(rows), peersFor: async id => { asked.push(id); return { peers: [] }; } } });
  try {
    const offer = await b.handoff({ request_id: rid('o1b') });
    const task = await waitFor(() => b.taskOf(offer.handoff_id), { label: 'bus task' });
    assert.equal(task.source, 'bus');
    await waitFor(() => task.state === 'running' && task.run?.pid, { label: 'bus run' });
    const ipc = await b.ipc(task.id);
    await assert.rejects(ipc.request('tool', { name: 'bus_peers', args: {} }), denied('POLICY_DENIED'));
    assert.ok(!published.flat().some(r => r.taskId === task.id), 'a bus run is never listed');
  } finally { await b.cleanup(); }

  const dir = tmpDir(), repo = makeRepo(dir);
  const h = await startEngine({ dir, scenario: idle, engineOpts: { onRuns: rows => published.push(rows), peersFor: async id => { asked.push(id); return { peers: [] }; } } });
  writePolicy(h.dataDir, { repos: { [repo.checkout]: { remote_tasks: true } } });
  let ipc;
  try {
    const { id } = await h.client.createTask({ text: 'from the phone', cwd: repo.checkout, source: 'phone', planFirst: false, sourceMeta: { userId: 'me', displayName: 'Me' } });
    const d = await h.client.getTask(id);
    await h.client.act(id, 'approve', { approvalId: d.openApprovals[0].approvalId });
    ipc = await ipcOf(h, id);
    assert.equal(h.eng.tasks.get(id).source, 'phone');
    await assert.rejects(ipc.request('tool', { name: 'bus_peers', args: {} }), denied('POLICY_DENIED'));
    assert.ok(!published.flat().some(r => r.taskId === id), 'a phone run is never listed');
  } finally { ipc?.close(); await h.close(); rm(dir); }
  assert.deepEqual(asked, [], 'main is never asked for them');
});

test('a parked task that still carries a stale run record is not listed', { skip: process.platform === 'win32' }, async () => {
  const dir = tmpDir(), repo = makeRepo(dir), published = [];
  const h = await startEngine({ dir, scenario: idle, engineOpts: { maxParallel: 4, onRuns: rows => published.push(rows) } });
  try {
    const { id } = await h.client.createTask({ text: 'first', cwd: repo.checkout, permissionLevel: 'plan' });
    await waitFor(() => published.findLast(r => r.some(x => x.taskId === id && x.state === 'running')), { label: 'running row' });
    await h.client.act(id, 'pause');
    await waitFor(() => h.eng.tasks.get(id).state === 'parked', { label: 'parked' });
    // A stale record of a live process, as a crash between saves could leave it.
    h.eng.tasks.get(id).run = { pid: process.pid, lstart: lstartOf(process.pid), pgid: null };
    const second = await h.client.createTask({ text: 'second', cwd: repo.checkout, permissionLevel: 'plan' });
    const rows = await waitFor(() => published.findLast(r => r.some(x => x.taskId === second.id && x.state === 'running')), { label: 'second running' });
    assert.deepEqual(rows.map(r => r.taskId), [second.id]);
  } finally { await h.close(); rm(dir); }
});

test('bus_peers: one question to main per run at a time; no answer is reused for 2 s too', { skip: process.platform === 'win32' }, async () => {
  const dir = tmpDir(), repo = makeRepo(dir);
  let asks = 0;
  const h = await startEngine({ dir, scenario: idle, engineOpts: { peersFor: async () => { asks += 1; await new Promise(r => setTimeout(r, 300)); return null; } } });
  let ipc;
  try {
    const { id } = await h.client.createTask({ text: 'x', cwd: repo.checkout, permissionLevel: 'plan' });
    ipc = await ipcOf(h, id);
    const all = await Promise.allSettled([1, 2, 3].map(() => ipc.request('tool', { name: 'bus_peers', args: {} })));
    assert.ok(all.every(r => r.status === 'rejected' && r.reason.code === 'UNAVAILABLE'));
    assert.equal(asks, 1, 'concurrent calls share one question');
    await assert.rejects(ipc.request('tool', { name: 'bus_peers', args: {} }), denied('UNAVAILABLE'));
    assert.equal(asks, 1, 'a missing answer is reused for 2 s');
  } finally { ipc?.close(); await h.close(); rm(dir); }
});
