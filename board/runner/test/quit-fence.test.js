// App quit (D37a) racing a fence: a takeover that lands inside the quit's
// handover window ends the run on the fence path; the window's end then does
// nothing (no second stop, no snapshot, no board_release at a stale fence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startFakeHub, makeRepo, tmpDir, rm, waitFor, startRunner, claimRun, offerFor } from './helpers.js';

test('a fence landing mid-quit: parkForQuit does not count it parked and the handover window never releases', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  hub.rpcReply = (f) => ({ ok: true, result: f.method === 'board_release' ? { state: 'queued' } : {} });
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-91' }));
    const quit = run.parkForQuit(600);
    hub.send({ type: 'fenced', run_id: run.run_id, card_id: run.card_id, held_fence: run.fence, current_fence: run.fence + 1 });
    await waitFor(() => run.fenced && run.ended, { what: 'fenced and ended', timeout: 15000 });
    assert.equal(await quit, undefined, 'the fence path ended the run; not parked');
    const snaps = hub.outs('snapshot').length;
    await new Promise((r) => setTimeout(r, 900));   // past the handover window
    assert.equal(run.handover.done, true);
    assert.equal(hub.of('rpc').filter((f) => f.method === 'board_release').length, 0, 'no release at a stale fence');
    assert.equal(hub.outs('snapshot').length, snaps, 'no second snapshot');
    assert.equal(run.endReason, 'fenced');
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('a run already in a hub park counts as parked-pending, not a quit candidate', async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }] } });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-92' }));
    assert.equal(run.hubHandoverPending, false);
    run.command({ cmd: 'park', wait_ms: 60_000 });
    await waitFor(() => run.handover, { what: 'park window open' });
    assert.equal(run.hubHandoverPending, true);
    assert.equal(await run.parkForQuit(500), false, 'quit does not start its own handover over the hub\'s');
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});
