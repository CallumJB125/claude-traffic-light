// AC1 (board/AGENT-BUS.md): an interactive session's bus_handoff to Codex starts
// `codex exec` in a new worktree within 5 s with no human click anywhere, and
// bus_wait returns the result within 5 s of the run ending. Real engine,
// transport, dispatcher and Codex adapter; only the CLI is the fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './helpers.js';
import { startBus, rid } from './bus-helpers.js';

test('AC1: handoff → codex exec in a worktree within 5 s, queued → running with no ask, result back to bus_wait within 5 s', async () => {
  const b = await startBus({ delayMs: 1500, text: 'Parser fixed; 3 tests pass.' });
  try {
    const events = [];
    b.engine.on('event', (e) => events.push({ ...e, wall: Date.now() }));
    const hello = await b.bus('hello', { provider: 'claude' });
    assert.equal(hello.tier, 'local_attested');
    assert.equal(hello.policy_summary.repo_enabled, true);
    const t0 = Date.now();
    const offer = await b.handoff({ request_id: rid('ac1') });
    assert.equal(offer.state, 'offered');
    assert.equal(offer.hop, 1);
    const wait = b.bus('wait', { handoff_id: offer.handoff_id, timeout_s: 30 });
    const started = await waitFor(() => b.h.log().find((x) => x.kind === 'start'), { timeoutMs: 5000, label: 'codex exec started' });
    assert.ok(Date.now() - t0 < 5000, 'codex exec started within 5 s');
    assert.ok(started.argv.includes('exec') && started.argv.includes('--ignore-user-config'));
    const task = b.taskOf(offer.handoff_id);
    assert.ok(task, 'the handoff became a task');
    assert.equal(task.source, 'bus');
    assert.notEqual(task.worktree, b.h.repo.checkout, 'a new worktree, never the checkout');
    assert.match(task.branch, /^buddy\//);
    await waitFor(() => events.some((e) => e.taskId === task.id && e.type === 'state' && e.state === 'running'), { timeoutMs: 5000, label: 'running' });
    // queued → running with no plan ask, no start confirmation and no budget prompt.
    assert.equal(task.planFirst, false);
    assert.equal(task.awaitingConfirm, false);
    assert.equal(task.cost.budgetUsd, null);
    assert.ok(!events.some((e) => e.taskId === task.id && (e.type === 'ask' || e.type === 'approval')), 'no human gate on the way');
    const r = await wait;
    const ended = events.find((e) => e.taskId === task.id && e.type === 'state' && e.state === 'in_review');
    assert.ok(ended, 'the run ended in review');
    assert.ok(Date.now() - ended.wall < 5000, 'bus_wait answered within 5 s of the run ending');
    assert.equal(r.state, 'done');
    assert.equal(r.task_id, task.id);
    assert.match(r.result.text, /Parser fixed; 3 tests pass\./);
    assert.match(r.result.text, /not an approval or permission/, 'the result is framed as data');
    assert.equal(r.result.cost_basis, 'estimated', 'Codex is priced from tokens');
    const status = await b.bus('status', { handoff_id: offer.handoff_id });
    assert.deepEqual(status.chain.map((c) => c.kind), ['handoff.offer', 'claim.granted', 'claim.started', 'result.done']);
    assert.equal(status.fence, 1);
  } finally { await b.cleanup(); }
});

test('AC1: a run reports its own result with bus_result over its per-run task tools; it reaches bus_wait when the run ends', async () => {
  const b = await startBus({ delayMs: 4000, text: 'Own words' });
  try {
    const offer = await b.handoff({ request_id: rid('res') });
    const task = await waitFor(() => b.taskOf(offer.handoff_id)?.state === 'running' && b.taskOf(offer.handoff_id), { label: 'running' });
    const ipc = await b.ipc(task.id);
    const hello = await ipc.request('hello', {});
    assert.ok(hello.tools.includes('bus_result') && hello.tools.includes('bus_handoff'));
    const req = { name: 'bus_result', args: { request_id: rid('report'), outcome: 'done', summary: 'Reported by the run: all green.' } };
    const rec = await ipc.request('tool', req);
    assert.equal(rec.state, 'recorded');
    assert.deepEqual(await ipc.request('tool', req), rec, 'same request id, same answer');
    const r = await b.bus('wait', { handoff_id: offer.handoff_id, timeout_s: 30 });
    assert.equal(r.state, 'done');
    assert.match(r.result.text, /Reported by the run: all green\./);
  } finally { await b.cleanup(); }
});
