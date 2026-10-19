// A card the hub still holds in progress while nothing works on it is served
// as stalled (derived in the view, never stored), with a machine reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TTL_MS, T_QUIET_MS, T_CLAIM_MS, T_STOP_CONFIRM_MS, HB_MS } from '../../shared/liveness.js';
import { cardView } from '../views.js';
import { startHub, runHb } from './helpers.js';

const view = (h, id) => cardView(h.hub, h.card(id), h.ids.alice);

test('a healthy running card is not stalled', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    assert.equal(view(h, run.card_id).stalled, null);
  } finally { await h.destroy(); }
});

test('runner gone: stalled runner_offline past TTL while the stored state is untouched', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    runner.terminate();
    h.clock.advance(TTL_MS - 1000);
    assert.equal(view(h, run.card_id).stalled, null, 'not before the TTL');
    h.clock.advance(5000);
    const v = view(h, run.card_id);
    assert.equal(v.stalled.reason, 'runner_offline');
    assert.ok(v.stalled.since_age_ms >= TTL_MS);
    assert.equal(v.live.green, false);
    assert.equal(h.card(run.card_id).run_state, 'running', 'derived: the stored state is not rewritten');
    await h.tick();
    assert.equal(view(h, run.card_id).stalled.reason, 'runner_offline', 'still stalled once the reaper marks it unresponsive');
    await h.run(300_000);
    assert.equal(h.card(run.card_id).run_state, 'orphaned');
    assert.equal(view(h, run.card_id).stalled.reason, 'runner_offline');
  } finally { await h.destroy(); }
});

test('process confirmed gone: heartbeats arrive but the CLI is dead and silent', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    h.clock.advance(HB_MS);
    await runner.hb([runHb(run, { child_alive: false, last_activity_age_ms: 5000 })]);
    assert.equal(view(h, run.card_id).stalled, null, 'recent activity: not yet confirmed gone');
    h.clock.advance(TTL_MS);
    await runner.hb([runHb(run, { child_alive: false, last_activity_age_ms: TTL_MS + 5000 })]);
    assert.equal(view(h, run.card_id).stalled.reason, 'process_gone');
  } finally { await h.destroy(); }
});

test('no activity beyond the activity window while the process lives', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    let age = 0;
    for (let t = 0; t <= T_QUIET_MS + HB_MS; t += HB_MS) {
      h.clock.advance(HB_MS);
      age += HB_MS;
      await runner.hb([runHb(run, { last_activity_age_ms: age })]);
    }
    const v = view(h, run.card_id);
    assert.equal(v.stalled.reason, 'no_activity');
    assert.equal(v.live.green, false);
    // A fresh activity report clears it.
    await runner.hb([runHb(run, { last_activity_age_ms: 0 })]);
    assert.equal(view(h, run.card_id).stalled, null);
  } finally { await h.destroy(); }
});

test('a claim that never starts is stalled after the claim budget', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const card = await h.createCard(alice);
    await h.action(alice, card.id, 'dispatch');
    const offer = await runner.next('offer', (o) => o.card_id === card.id);
    const res = await runner.claim(offer);
    const run = { card_id: card.id, run_id: res.run_id, fence: res.fence, repo_id: h.ids.repo };
    assert.equal(view(h, card.id).stalled, null);
    for (let t = 0; t < T_CLAIM_MS + HB_MS; t += HB_MS) {
      h.clock.advance(HB_MS);
      await runner.hb([runHb(run, { child_alive: false, last_activity_age_ms: null, local_state: 'preparing' })]);
    }
    assert.equal(h.card(card.id).run_state, 'claimed');
    assert.equal(view(h, card.id).stalled.reason, 'claim_not_started');
  } finally { await h.destroy(); }
});

test('a stopped run whose CLI is still reported alive is stop_unconfirmed', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const runner = await h.runner(await h.enroll(alice));
    const run = await h.startRun(alice, runner);
    const stop = await h.action(alice, run.card_id, 'stop');
    assert.equal(stop.status, 200);
    assert.equal(h.card(run.card_id).run_state, 'failed');
    await runner.hb([runHb(run)]);
    assert.equal(view(h, run.card_id).stalled, null, 'inside the grace window');
    for (let t = 0; t < T_STOP_CONFIRM_MS + HB_MS; t += HB_MS) {
      h.clock.advance(HB_MS);
      await runner.hb([runHb(run)]);
    }
    assert.equal(view(h, run.card_id).stalled.reason, 'stop_unconfirmed');
    await runner.hb([runHb(run, { child_alive: false })]);
    assert.equal(view(h, run.card_id).stalled, null, 'cleared once the runner reports the process gone');
  } finally { await h.destroy(); }
});
