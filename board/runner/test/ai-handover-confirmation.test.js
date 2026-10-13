import test from 'node:test';
import assert from 'node:assert/strict';
import { Run } from '../run.js';

function fixture(stopped, alive) {
  const sup = { clock: { mono: () => 0, wall: () => Date.parse('2026-10-03') },
    log: { info() {}, warn() {} }, runEnded() {}, opts: {} };
  const run = new Run(sup, { run_id: 'run-fixture', card_id: 'card-fixture', fence: 1, key: 'MOVE-1' });
  const frames = [];
  let snapshots = 0;
  run.backend = { alive: () => alive, turnActive: true, stop: async () => stopped };
  run.emit = frame => frames.push(frame);
  run.flushFacts = () => {};
  run.snapshotNow = async () => { snapshots++; return { status: 'pushed' }; };
  return { run, frames, snapshots: () => snapshots };
}

async function finish(run) {
  // The production supervisor owns the event loop. Keep this isolated unit
  // fixture alive through its unref'ed deadline and await all guarded work.
  const keepAlive = setInterval(() => {}, 1000);
  try { return await run.command({ cmd: 'handover_begin', wait_ms: 1 }); }
  finally { clearInterval(keepAlive); }
}

for (const [name, stopped, alive] of [
  ['stop returns false although the child reports dead', false, false],
  ['stop returns true but the child remains alive', true, true],
]) {
  test(`actual Run refuses completion when ${name}`, async () => {
    const f = fixture(stopped, alive);
    assert.equal(await finish(f.run), false);
    assert.equal(f.run.ended, false);
    assert.equal(f.snapshots(), 0);
    assert.equal(f.frames.some(frame => frame.kind === 'handover.complete'), false);
  });
}

test('deadline stop and pushed checkpoint never claim the agent wrote a handover', async () => {
  const f = fixture(true, false);
  await finish(f.run);
  const complete = f.frames.find(frame => frame.kind === 'handover.complete');
  assert.ok(complete);
  assert.equal(complete.stop_confirmed, true);
  assert.equal(complete.checkpoint_confirmed, true);
  assert.equal(complete.handover_written, false);
  assert.equal(f.snapshots(), 1);
  assert.equal(f.run.ended, true);
});
