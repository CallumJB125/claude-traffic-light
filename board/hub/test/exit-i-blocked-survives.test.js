// Exit (i): a blocked card keeps "Needs you" through sleep, partition and a
// hub restart; answers given while it is dark are stored (D6) and delivered
// on recovery; one open ask per card.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TTL_MS, T_PARK_MS } from '../../shared/liveness.js';
import { cardFace } from '../../shared/cardface.js';
import { cardView } from '../views.js';
import { startHub, runHb, until } from './helpers.js';

const view = (h, id) => cardView(h.hub, h.card(id), h.ids.alice);

test('exit (i): blocked survives sleep and partition; answer while dark is delivered on recovery', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const dev = await h.enroll(alice);
    const r1 = await h.runner(dev);
    const run = await h.startRun(alice, r1);
    const ask = await r1.rpc(run, 'board_ask_human', { kind: 'decision', text: 'Keep the old endpoint?', options: ['yes', 'no'] });
    assert.equal(ask.ok, true);
    const second = await r1.rpc(run, 'board_ask_human', { kind: 'question', text: 'another?' });
    assert.equal(second.error.code, 'ONE_OPEN_ASK');
    assert.equal(h.card(run.card_id).run_state, 'blocked');
    assert.equal(h.hub.notifications.filter((n) => n.rule === 'blocked').length, 1, 'blocked notifies immediately');
    let v = view(h, run.card_id);
    assert.deepEqual([v.ask.kind, v.ask.count], ['decision', 1]);
    assert.equal(cardFace(v).label, 'Needs you');

    // Sleep.
    r1.send({ type: 'host.suspending', runs: [{ run_id: run.run_id, card_id: run.card_id, fence: run.fence }] });
    await until(() => h.card(run.card_id).run_state === 'suspended');
    r1.terminate();
    v = view(h, run.card_id);
    assert.equal(v.resume_to, 'blocked');
    assert.equal(v.blocked_kind, 'decision');
    assert.ok(v.ask, 'the ask is still shown while asleep');
    assert.match(cardFace(v).reason, /approval still waiting/);

    // Wake → back to blocked.
    const r2 = await h.runner(dev, { runs: [{ run_id: run.run_id, card_id: run.card_id, fence: run.fence, local_state: 'running' }] });
    await r2.hb([runHb(run)]);
    assert.equal(h.card(run.card_id).run_state, 'blocked');

    // Partition: silence → unresponsive (resume_to blocked); answer while dark (9d).
    r2.terminate();
    await h.run(TTL_MS + 2000);
    assert.equal(h.card(run.card_id).run_state, 'unresponsive');
    assert.equal(h.card(run.card_id).resume_to, 'blocked');
    const ans = await h.action(alice, run.card_id, 'answer', { ask_id: ask.result.ask_id, answer: 'no' });
    assert.equal(ans.status, 200);
    assert.equal(h.card(run.card_id).resume_to, 'quiet', 'D6: nothing left open');
    const again = await h.action(alice, run.card_id, 'answer', { ask_id: ask.result.ask_id, answer: 'yes' });
    assert.equal(again.body.error.code, 'ALREADY_ANSWERED');

    const r3 = await h.runner(dev, { runs: [{ run_id: run.run_id, card_id: run.card_id, fence: run.fence, local_state: 'paused_offline' }] });
    const delivered = await r3.next('answer', (m) => m.ask_id === ask.result.ask_id);
    assert.equal(delivered.answer, 'no');
    assert.equal(delivered.answered_by.name, 'Alice');
    await r3.hb([runHb(run)]);
    assert.equal(h.card(run.card_id).run_state, 'quiet');
  } finally {
    await h.destroy();
  }
});

test('exit (i): unanswered for T_park → parked (fence+1, park command, notify once); answer → requeued with the answer', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, r);
    const ask = await r.rpc(run, 'board_ask_human', { kind: 'question', text: 'Which bank?' });
    for (let t = 0; t < T_PARK_MS + 30_000; t += 15_000) {
      h.clock.advance(15_000);
      await r.hb([runHb(run)]);
      await h.tick();
    }
    const c = h.card(run.card_id);
    assert.deepEqual([c.run_state, c.fence, c.blocked_kind], ['parked', run.fence + 1, 'question']);
    const park = await r.next('cmd', (m) => m.cmd === 'park');
    assert.equal(park.fence, run.fence);
    assert.equal(h.hub.notifications.filter((n) => n.rule === 'parked').length, 1);
    assert.ok(view(h, run.card_id).ask, 'parked still shows the question');

    const ans = await h.action(alice, run.card_id, 'answer', { ask_id: ask.result.ask_id, answer: 'Capitec' });
    assert.equal(ans.status, 200);
    assert.equal(h.card(run.card_id).run_state, 'queued');
    const offer = await r.next('offer', (o) => o.card_id === run.card_id && o.fence === run.fence + 2);
    assert.equal(offer.seed.answer, 'Capitec');
  } finally {
    await h.destroy();
  }
});
