// The per-run wall clock (spec.wallClockMs; Codex has no native spend cap): a
// fake Codex run is stopped once the engine clock passes it, and the field is
// validated by the engine and by the schema the mock shares.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './helpers.js';
import { startBus, rid } from './bus-helpers.js';
import { startMock } from '../../tasks-api/test/helpers.js';

test('a bus Codex run is stopped at wallClockMs and its handoff fails with the reason', async () => {
  let skew = 0;
  const b = await startBus({ wait: true }, { engineOpts: { now: () => Date.now() + skew } });
  try {
    const offer = await b.handoff({ request_id: rid('wall') });
    const task = await waitFor(() => b.taskOf(offer.handoff_id)?.state === 'running' && b.taskOf(offer.handoff_id), { label: 'running' });
    assert.equal(task.spec.wallClockMs, 20 * 60_000, 'the owner default: 20 minutes, on');
    assert.equal(task.cost.budgetUsd, null, 'Codex gets no budget it cannot enforce');
    const pid = b.engine.runs.get(task.id).backend.pid;
    skew = 19 * 60_000;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(task.state, 'running', 'not before the limit');
    skew = 20 * 60_000 + 1000;
    await waitFor(() => task.state === 'failed', { timeoutMs: 10_000, label: 'stopped' });
    assert.equal(task.failKind, 'stopped');
    assert.match(task.failReason, /wall clock limit \(20 min\)/);
    assert.throws(() => process.kill(pid, 0), 'the Codex process is gone');
    const r = await b.bus('wait', { handoff_id: offer.handoff_id, timeout_s: 10 });
    assert.equal(r.state, 'failed');
    assert.match(r.result.text, /wall clock limit/);
  } finally { await b.cleanup(); }
});

test('wallClockMs is validated: the engine refuses under a minute, the shared schema (mock) refuses bad values', async () => {
  const b = await startBus({ text: 'x' });
  let m;
  try {
    await assert.rejects(b.h.client.createTask({ text: 'x', cwd: b.h.repo.checkout, ai: 'codex', wallClockMs: 5 }), (e) => e.code === 'VALIDATION');
    await assert.rejects(b.engine.createTask({ requestId: rid('wc'), spec: { text: 'x', cwd: b.h.repo.checkout, ai: 'codex', wallClockMs: 5000 } }), (e) => e.code === 'VALIDATION');
    m = await startMock();
    await assert.rejects(m.client.createTask({ text: 'x', cwd: m.dir, wallClockMs: 'soon' }), (e) => e.code === 'VALIDATION');
    await assert.rejects(m.client.createTask({ text: 'x', cwd: m.dir, wallClockMs: 30_000 }), (e) => e.code === 'VALIDATION');
    assert.ok((await m.client.createTask({ text: 'x', cwd: m.dir, wallClockMs: 60_000 })).id);
  } finally { await m?.close(); await b.cleanup(); }
});
