// The kill switch on the real engine (AGENT-BUS.md §5, AC4): halt stops running
// bus tasks, no queued offer is claimed after it (the slots halt frees stay
// empty), and a restart while halted reopens claims without starting anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openBusLog } from '../bus/local-log.js';
import { waitFor } from './helpers.js';
import { startBus } from './bus-helpers.js';

const ACTIVE = new Set(['queued', 'claimed', 'running', 'quiet', 'blocked', 'handing_over', 'handed_over', 'suspended', 'unresponsive']);
const oneAtATime = (repo) => ({ bus: { max_parallel: 1 }, repos: { [repo]: { bus_auto: true } } });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('halt stops a running bus task and no queued offer is claimed after it; resume starts it', async () => {
  const b = await startBus({ wait: true }, { policy: oneAtATime });
  try {
    const first = await b.handoff({ title: 'First' });
    const second = await b.handoff({ title: 'Second' });
    await waitFor(() => b.taskOf(first.handoff_id)?.state === 'running', { label: 'first running' });
    assert.equal(b.engine.agentBus.log.claimOf(second.handoff_id), null, 'max_parallel 1: the second waits');
    const r = await b.bus('halt');
    assert.deepEqual([r.halted, r.stopped], [true, 1]);
    await waitFor(() => !ACTIVE.has(b.taskOf(first.handoff_id)?.state), { label: 'first stopped' });
    await pause(400); // several engine ticks and pump passes with a free slot
    assert.equal(b.engine.agentBus.log.claimOf(second.handoff_id), null, 'no claim after halt');
    assert.equal(b.taskOf(second.handoff_id), undefined);
    assert.equal((await b.handoff({ title: 'Third' })).reason, 'HALTED');
    await b.bus('resume');
    await waitFor(() => b.taskOf(second.handoff_id), { label: 'second starts on resume' });
  } finally { await b.cleanup(); }
});

test('a restart while halted reopens a granted claim and dispatches nothing until resume', async () => {
  const b = await startBus({ wait: true }, { policy: oneAtATime });
  try {
    const first = await b.handoff({ title: 'First' });
    const second = await b.handoff({ title: 'Second' });
    await waitFor(() => b.taskOf(first.handoff_id)?.state === 'running', { label: 'first running' });
    await b.bus('halt');
    await waitFor(() => !ACTIVE.has(b.taskOf(first.handoff_id)?.state), { label: 'first stopped' });
    // Plexiform quit between granting the second's claim and creating its task.
    await b.h.restart({ beforeStart: () => {
      const log = openBusLog(path.join(b.h.dataDir, 'bus.db'));
      try { assert.ok(log.claim(second.handoff_id, 'gone', 120_000)); } finally { log.close(); }
    } });
    await waitFor(() => b.engine.agentBus.log.claimOf(second.handoff_id)?.state === 'reopened', { label: 'reopened' });
    await pause(400);
    assert.equal(b.engine.agentBus.log.claimOf(second.handoff_id).state, 'reopened', 'still not started while halted');
    assert.equal(b.taskOf(second.handoff_id), undefined);
    await b.bus('resume');
    const t = await waitFor(() => b.taskOf(second.handoff_id), { label: 'second starts on resume' });
    assert.equal(t.sourceMeta.fence, 2, 'the reopened claim starts under a new fence');
  } finally { await b.cleanup(); }
});
