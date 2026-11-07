// Decision 7: a full-token tasks.sock client could create a source 'bus' task with any originBoard (aiming its card
// at a team board) or fallbackOf (hiding another run's card). Now only the bus starts bus runs, and their originBoard
// and fallbackOf must be the hand-off's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './helpers.js';
import { startBus, rid } from './bus-helpers.js';

const KEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const spec = (b, meta = {}) => ({ text: 'Fix it', cwd: b.h.repo.checkout, ai: 'codex', source: 'bus',
  sourceMeta: { handoffId: 'hof_0123456789abcdef', fence: 1, originTier: 'local_attested', scope: 'local', ...meta } });

test('tasks.sock can never create a bus run, whatever its sourceMeta', async () => {
  const b = await startBus({ wait: true });
  try {
    for (const meta of [{}, { originBoard: KEY }, { fallbackOf: 'hof_00000000000000aa' }]) {
      await assert.rejects(b.h.client.createTask(spec(b, meta), { requestId: rid('sock') }), (e) => e.code === 'POLICY_DENIED', JSON.stringify(meta));
    }
    assert.equal(b.engine.tasks.size, 0);
  } finally { await b.cleanup(); }
});

test('in process, originBoard must be the board main put on the hand-off; fallbackOf a failed run of the same chain', async () => {
  const b = await startBus({ wait: true });
  try {
    // No such hand-off: neither field is believed.
    await assert.rejects(b.engine.createTask({ requestId: rid('nohof'), spec: spec(b, { originBoard: KEY }) }), (e) => e.code === 'VALIDATION');
    await assert.rejects(b.engine.createTask({ requestId: rid('nohof'), spec: spec(b, { fallbackOf: 'hof_00000000000000aa' }) }), (e) => e.code === 'VALIDATION');
    // A real hand-off from a bound session whose cards go to a team board: its run carries that board.
    const origin = { key: 'claude|sess-origin-7', handle: 'claude-site-0a1b', board: KEY };
    const offer = await b.handoff({ request_id: rid('board') }, { ...b.caller, origin });
    const run = await waitFor(() => b.taskOf(offer.handoff_id), { label: 'run' });
    assert.equal(run.sourceMeta.originBoard, KEY);
    const meta = { handoffId: offer.handoff_id, fence: 2 };
    await assert.rejects(b.engine.createTask({ requestId: rid('forge'), spec: spec(b, { ...meta, originBoard: OTHER }) }), (e) => e.code === 'VALIDATION', 'another team key');
    await assert.rejects(b.engine.createTask({ requestId: rid('forge'), spec: spec(b, { ...meta, originBoard: 'not-a-key' }) }), (e) => e.code === 'VALIDATION');
    // This hand-off is no fallback, and the run it would replace has not failed.
    await assert.rejects(b.engine.createTask({ requestId: rid('forge'), spec: spec(b, { ...meta, fallbackOf: offer.handoff_id }) }), (e) => e.code === 'VALIDATION');
  } finally { await b.cleanup(); }
});

test('in process, a fallback run of the same chain whose first run failed is created and keeps fallbackOf', async () => {
  const b = await startBus({ wait: true });
  try {
    const log = b.engine.agentBus.log;
    const first = await b.handoff({ request_id: rid('fb1') });
    const second = await b.handoff({ request_id: rid('fb2'), title: 'Second try' });
    // What the dispatcher's own fallback writes: the first run's failed result, and an offer that names it.
    const strip = ({ id, offset, ...ev }) => ev;
    const fbId = `hof_${'c'.repeat(16)}`;
    log.append({ ...strip(log.handoff(second.handoff_id)), handoff_id: fbId, request_id: rid('fb3'), data: { ...log.handoff(second.handoff_id).data, fallback_of: first.handoff_id } });
    const meta = { handoffId: fbId, fence: 1, fallbackOf: first.handoff_id };
    await assert.rejects(b.engine.createTask({ requestId: rid('early'), spec: spec(b, meta) }), (e) => e.code === 'VALIDATION', 'the first run has not failed yet');
    log.append({ ...strip(log.handoff(first.handoff_id)), topic: 'result', kind: 'result.failed', data: { fence: 1, summary: 'quota' } });
    const { id } = await b.engine.createTask({ requestId: rid('ok'), spec: spec(b, meta) });
    assert.equal(b.engine.tasks.get(id).sourceMeta.fallbackOf, first.handoff_id);
    // A run of another chain may not claim it.
    await assert.rejects(b.engine.createTask({ requestId: rid('other'), spec: spec(b, { handoffId: second.handoff_id, fence: 2, fallbackOf: first.handoff_id }) }), (e) => e.code === 'VALIDATION');
  } finally { await b.cleanup(); }
});
