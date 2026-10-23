// O3: the engine marks the person's own wrapped tasks as real work (a file edit, or a minute working in total) and
// tells main (onWork) — title, state and folder only, with the AI that began the work so a provider switch stays
// one card. Quick questions, spin-offs and anything another AI started never appear.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine, makeRepo, waitFor, tmpDir, rm } from './helpers.js';
import { providerFixture } from './provider-switch-helpers.js';
import { IpcClient } from '../../mcp/ipc.js';

const local = process.platform === 'win32' ? test.skip : test;
const KEYS = ['taskId', 'ai', 'title', 'state', 'blockedKind', 'root', 'changedAt'].sort();
const idle = { steps: [{ tool: 'Read', input: { file_path: 'README.md' }, ms: 60000 }] };

local('an edit makes it real work at once: one row with title, state and folder only; [] when the engine closes', async () => {
  const dir = tmpDir(), repo = makeRepo(dir), seen = [];
  const h = await startEngine({ dir, scenario: { steps: [{ tool: 'Write', input: { file_path: 'notes.txt', content: 'x\n' } }, { tool: 'Read', input: { file_path: 'README.md' }, ms: 60000 }] },
    engineOpts: { onWork: rows => seen.push(rows) } });
  try {
    const { id } = await h.client.createTask({ title: 'Write the notes', text: 'SECRET TASK TEXT', cwd: repo.checkout, permissionLevel: 'auto-edits' });
    const rows = await waitFor(() => seen.findLast(r => r.length), { label: 'work row' });
    const task = h.eng.tasks.get(id);
    assert.deepEqual(Object.keys(rows[0]).sort(), KEYS);
    assert.equal(rows[0].taskId, id);
    assert.equal(rows[0].ai, 'claude');
    assert.equal(rows[0].title, 'Write the notes');
    assert.equal(rows[0].root, task.repo?.root ?? task.worktree);
    assert.ok(task.touched.includes('notes.txt'));
    assert.ok(task.workedAt != null && task.cardAi === 'claude');
    assert.ok(!JSON.stringify(seen).includes('SECRET TASK TEXT'));
  } finally { await h.close(); rm(dir); }
  assert.deepEqual(seen.at(-1), []);
});

local('no edits: nothing until a minute of work in total, then the row; a spin-off never has one', async () => {
  const dir = tmpDir(), repo = makeRepo(dir), seen = [];
  let skew = 0;
  const h = await startEngine({ dir, scenario: idle, engineOpts: { maxParallel: 4, now: () => Date.now() + skew, onWork: rows => seen.push(rows) } });
  let ipc;
  try {
    const { id } = await h.client.createTask({ text: 'Just look', cwd: repo.checkout, permissionLevel: 'plan' });
    const run = await waitFor(() => h.eng.engine.runs.get(id)?.backend?.turnActive && h.eng.engine.runs.get(id));
    ipc = new IpcClient({ socketPath: run.socketPath, token: run.token });
    const helper = await ipc.request('tool', { name: 'buddy_spin_off', args: { request_id: 'helper-0001', text: 'Look too.', ai: 'claude' } });
    await waitFor(() => h.eng.engine.runs.get(helper.task_id)?.backend?.turnActive);
    await waitFor(() => h.eng.tasks.get(id).state === 'running' && h.eng.tasks.get(helper.task_id).state === 'running', { label: 'both running' });
    // Under a minute in total (the real seconds of this wait included): no card.
    skew = 56_000;
    await new Promise(r => setTimeout(r, 1300));
    assert.ok(!seen.some(r => r.length), 'under a minute and no edits: no card');
    skew = 61_000;
    const rows = await waitFor(() => seen.findLast(r => r.length), { label: 'row after a minute' });
    assert.deepEqual(rows.map(r => r.taskId), [id], 'the spin-off is not listed');
  } finally { ipc?.close(); await h.close(); rm(dir); }
});

local('a provider switch keeps the AI that began the work, so it stays one card', async t => {
  const seen = [];
  const h = await providerFixture({ onWork: rows => seen.push(rows) });
  t.after(() => h.cleanup());
  const id = await h.parked();
  assert.equal(seen.findLast(r => r.length)[0].ai, 'claude');
  const r = (await h.client.act(id, 'switchAi', { phase: 'preview', ai: 'codex' })).providerChange;
  await h.client.act(id, 'switchAi', { phase: 'apply', reviewId: r.id, reviewHash: r.hash, confirm: true });
  await waitFor(() => h.task(id).state === 'in_review');
  assert.equal(h.task(id).ai.id, 'codex');
  const last = seen.findLast(x => x.length);
  assert.equal(last[0].taskId, id);
  assert.equal(last[0].ai, 'claude');
  assert.equal(last[0].state, 'in_review');
});
