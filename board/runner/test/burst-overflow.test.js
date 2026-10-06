// Burst overflow in the runner: secondary spend counts toward the budget, and a
// plan limit with a ready secondary is an overflow (the run keeps going), while
// without one it still ends as failed{limit}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, readFakeLog } from './helpers.js';

async function withRunner(scenario, fn) {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario });
  try { await fn({ hub, sup }); } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
}

const LIMIT = {
  steps: [{ rate_limit: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600 } }, { result: 'error_during_execution', text: 'usage limit reached' }],
  on_input: { 'rate limited': [{ result: 'success', text: 'ok' }] },
};

test('setBurst keeps numbers only, bounded, and goes stale', async () => {
  await withRunner({ steps: [{ result: 'success' }] }, async ({ sup }) => {
    sup.setBurst({ active: true, route: 'SECONDARY', secondaryReady: true, sessions: { a: 1.5, b: -1, c: 'x', [`${'z'.repeat(81)}`]: 2 }, extra: 'ignored' });
    assert.deepEqual(sup.burstState().sessions, { a: 1.5 });
    assert.equal(sup.secondaryUsdFor('a'), 1.5);
    assert.equal(sup.secondaryUsdFor('missing'), 0);
    assert.equal(sup.viaSecondary(), true);
    sup.burst.at -= 4 * 60_000;
    assert.equal(sup.burstState(), null);
    assert.equal(sup.secondaryUsdFor('a'), 0);
    assert.equal(sup.viaSecondary(), false);
  });
});

test('secondary USD is added to the run cost and a budget crossed by overflow ends the run as budget', () => withRunner({ steps: [{ result: 'success', cost: 0.5 }] }, async ({ hub, sup }) => {
  sup.secondaryUsdFor = () => 0.9;
  const run = await claimRun(sup, hub, offerFor({ key: 'B-1' }));
  const f = await waitFor(() => hub.outs('run.failed')[0], { what: 'failed' });
  assert.equal(f.fail_kind, 'budget');
  assert.ok(run.costUsd >= 1.4 - 1e-9, `cost ${run.costUsd}`);
}));

test('without overflow spend the same turn does not trip the budget', () => withRunner({ steps: [{ result: 'success', cost: 0.5 }] }, async ({ hub, sup }) => {
  const run = await claimRun(sup, hub, offerFor({ key: 'B-2' }));
  await waitFor(() => run.numTurns === 1, { what: 'turn' });
  assert.equal(hub.outs('run.failed').length, 0);
  assert.equal(run.costUsd, 0.5);
}));

test('limit with a ready Burst secondary: the run keeps going, no run.failed', () => withRunner(LIMIT, async ({ hub, sup }) => {
  sup.setBurst({ active: true, route: 'SECONDARY', secondaryReady: true, sessions: {} });
  const run = await claimRun(sup, hub, offerFor({ key: 'L-1' }));
  await waitFor(() => readFakeLog(run.runDir).some((e) => e.ev === 'turn' && /rate limited/.test(e.text)), { what: 'continue sent', timeout: 8000 });
  assert.equal(hub.outs('run.failed').length, 0);
  assert.equal(run.hb().via_secondary, true);
}));

test('limit with Burst on but no ready secondary: failed{limit}', () => withRunner(LIMIT, async ({ hub, sup }) => {
  sup.setBurst({ active: true, route: 'PRIMARY', secondaryReady: false, sessions: {} });
  await claimRun(sup, hub, offerFor({ key: 'L-2' }));
  assert.equal((await waitFor(() => hub.outs('run.failed')[0], { what: 'failed' })).fail_kind, 'limit');
}));
