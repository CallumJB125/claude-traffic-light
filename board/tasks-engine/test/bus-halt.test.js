// The kill switch on the real engine (AGENT-BUS.md §5, AC4): halt stops running
// bus tasks, no queued offer is claimed after it (the slots halt frees stay
// empty), and a restart while halted reopens claims without starting anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openBusLog } from '../bus/local-log.js';
import { waitFor, writePolicy } from './helpers.js';
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
    await b.ready();
    await pause(400);
    assert.equal(b.engine.agentBus.log.claimOf(second.handoff_id).state, 'reopened', 'still not started while halted');
    assert.equal(b.taskOf(second.handoff_id), undefined);
    await b.bus('resume');
    const t = await waitFor(() => b.taskOf(second.handoff_id), { label: 'second starts on resume' });
    assert.equal(t.sourceMeta.fence, 2, 'the reopened claim starts under a new fence');
  } finally { await b.cleanup(); }
});

test('a restarted bus with no context pushed dispatches nothing; once main pushes it (repo ticked only in Preferences) it starts', async () => {
  const b = await startBus({ wait: true }, { policy: oneAtATime });
  try {
    const first = await b.handoff({ title: 'First' });
    const second = await b.handoff({ title: 'Second' });
    await waitFor(() => b.taskOf(first.handoff_id)?.state === 'running', { label: 'first running' });
    await b.bus('halt');
    await waitFor(() => !ACTIVE.has(b.taskOf(first.handoff_id)?.state), { label: 'first stopped' });
    // Restart un-halted, with the repo opted in only through Preferences, which main has not pushed yet.
    await b.h.restart({ beforeStart: () => {
      writePolicy(b.h.dataDir, { bus: { max_parallel: 1 } });
      const log = openBusLog(path.join(b.h.dataDir, 'bus.db'));
      try { log.setState('halted', false); } finally { log.close(); }
    } });
    await pause(500);
    assert.equal(b.engine.agentBus.log.claimOf(second.handoff_id), null, 'no claim on defaults');
    assert.equal(b.engine.agentBus.log.result(second.handoff_id), null, 'and no POLICY_DENIED failure');
    await b.h.client.bus('busSetContext', { repos: [b.h.repo.checkout], folders: [] }, null);
    await waitFor(() => b.taskOf(second.handoff_id), { label: 'second starts after context' });
  } finally { await b.cleanup(); }
});

test('a halt that lands during createTask stops that run, suppresses its own result, and resume starts it under a new fence', async () => {
  const b = await startBus({ wait: true });
  try {
    const engine = b.engine;
    const create = engine.createTask;
    let release;
    const gate = new Promise((r) => { release = r; });
    engine.createTask = async (a) => { await gate; return create.call(engine, a); };
    const offer = await b.handoff({ title: 'Racing the halt' });
    await waitFor(() => engine.agentBus.log.claimOf(offer.handoff_id)?.state === 'granted', { label: 'claim granted' });
    await b.bus('halt');
    release();
    const t1 = await waitFor(() => b.taskOf(offer.handoff_id), { label: 'run created' });
    await waitFor(() => !ACTIVE.has(engine.tasks.get(t1.id)?.state), { label: 'run stopped' });
    await pause(300);
    const c = engine.agentBus.log.claimOf(offer.handoff_id);
    assert.deepEqual([c.state, c.task_id, c.fence], ['reopened', null, 1]);
    assert.equal(engine.agentBus.log.result(offer.handoff_id), null, "the halted run's own end posts no result");
    engine.createTask = create;
    await b.bus('resume');
    const t2 = await waitFor(() => [...engine.tasks.values()].find((t) => t.sourceMeta?.handoffId === offer.handoff_id && t.sourceMeta.fence === 2), { label: 'fence 2 run' });
    assert.notEqual(t2.id, t1.id);
  } finally { await b.cleanup(); }
});
