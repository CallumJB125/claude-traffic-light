// Exit (c): lid close → suspended, never green; wake → grey (quiet) until
// fresh, non-delayed activity; suspended ≥ 8 h → orphaned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T_SUSPEND_MS, TTL_MS } from '../../shared/liveness.js';
import { cardView } from '../views.js';
import { startHub, runHb, runMsg, until } from './helpers.js';

const view = (h, id) => cardView(h.hub, h.card(id), h.ids.alice);

test('exit (c): host.suspending → suspended (not green, no unresponsive); wake → quiet until activity → running', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const dev = await h.enroll(alice);
    const r1 = await h.runner(dev);
    const run = await h.startRun(alice, r1);
    assert.equal(view(h, run.card_id).live.green, true);

    r1.send({ type: 'host.suspending', runs: [{ run_id: run.run_id, card_id: run.card_id, fence: run.fence }] });
    await until(() => h.card(run.card_id).run_state === 'suspended');
    assert.equal(h.card(run.card_id).run_state, 'suspended');
    assert.equal(view(h, run.card_id).live.green, false);
    r1.terminate();

    // Asleep for 2 hours: stays suspended (no hb_timeout from suspended), never green.
    for (let t = 0; t < 2 * 3600_000; t += 60_000) {
      await h.tick(60_000);
      assert.equal(view(h, run.card_id).live?.green ?? false, false);
    }
    assert.equal(h.card(run.card_id).run_state, 'suspended');
    assert.equal(h.card(run.card_id).resume_to, 'quiet');
    assert.equal(h.hub.notifications.filter((n) => n.card_id === run.card_id).length, 0, 'suspended is never pushed');

    // Wake: first HB recovers to quiet (grey), with the pre-sleep activity age.
    const r2 = await h.runner(dev, { runs: [{ run_id: run.run_id, card_id: run.card_id, fence: run.fence, local_state: 'running' }] });
    await r2.hb([runHb(run, { last_activity_age_ms: 2 * 3600_000, wake_age_ms: 1000 })]);
    assert.equal(h.card(run.card_id).run_state, 'quiet');
    let v = view(h, run.card_id);
    assert.equal(v.live.green, false);
    assert.equal(v.live.post_wake_activity, false);

    // Replayed (delayed) activity never makes it green.
    await r2.out({ kind: 'activity', ...runMsg(run), source: 'assistant' }, { delayed: true });
    assert.equal(h.card(run.card_id).run_state, 'quiet');

    h.clock.advance(2000);
    await r2.out({ kind: 'activity', ...runMsg(run), source: 'tool_start' });
    await r2.hb([runHb(run)]);
    v = view(h, run.card_id);
    assert.equal(h.card(run.card_id).run_state, 'running');
    assert.equal(v.live.post_wake_activity, true);
    assert.equal(v.live.green, true);
  } finally {
    await h.destroy();
  }
});

test('exit (c): suspended longer than T_suspend → orphaned; claimed cards are not suspended', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    runner.send({ type: 'host.suspending', runs: [{ run_id: run.run_id, card_id: run.card_id, fence: run.fence }] });
    await until(() => h.card(run.card_id).run_state === 'suspended');
    runner.terminate();
    await h.run(T_SUSPEND_MS - 60_000, 60_000);
    assert.equal(h.card(run.card_id).run_state, 'suspended');
    await h.run(120_000, 60_000);
    assert.equal(h.card(run.card_id).run_state, 'orphaned');

    const r2 = await h.runner(await h.enroll(alice, 'Second'));
    const card = await h.createCard(alice);
    await h.action(alice, card.id, 'dispatch');
    const offer = await r2.next('offer', (o) => o.card_id === card.id);
    const cl = await r2.claim(offer);
    const claimed = { card_id: card.id, run_id: cl.run_id, fence: cl.fence };
    r2.send({ type: 'host.suspending', runs: [claimed] });
    await r2.hb([runHb(claimed)]);
    assert.equal(h.card(card.id).run_state, 'claimed', 'lid-close during claimed is intentionally not suspended');
    r2.terminate();
    await h.run(TTL_MS + 1000);
    assert.equal(h.card(card.id).run_state, 'unresponsive');
    await h.run(120_000);
    assert.equal(h.card(card.id).run_state, 'queued', 'claim timeout requeues (#5b)');
    assert.equal(h.card(card.id).fence, cl.fence + 1);
  } finally {
    await h.destroy();
  }
});
