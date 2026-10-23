// O1b: the engine tells main (onRuns) which of the person's own wrapped runs are live — pid and start as the
// engine recorded them, the task's own folder — and a wrapped run's bus_peers is answered by main (peersFor).
// Bus runs and spin-offs are never listed and their bus_peers is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine, makeRepo, waitFor, tmpDir, rm } from './helpers.js';
import { IpcClient } from '../../mcp/ipc.js';
import { lstartOf } from '../../runner/procs.js';
import { TASK_TOOL_NAMES } from '../../mcp/task-tools.js';

const denied = code => error => error.code === code;
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
    const rows = await waitFor(() => published.findLast(r => r.length));
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
    assert.ok(!JSON.stringify(published).includes('SECRET TASK TEXT'));
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
