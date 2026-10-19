// G5: per-card / per-board cost rollups (unavailable is never $0) and the
// per-board daily soft cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, runMsg } from './helpers.js';

const cost = (runner, run, usd) => runner.out({ ...runMsg(run), kind: 'facts', items: [{ kind: 'cost', cost_usd: usd }] });
const snap = (h, cookie) => h.api(cookie, 'GET', `/api/boards/${h.ids.board}`);

test('card and board totals sum reported cost and mark runs without telemetry unavailable', async (t) => {
  const h = await startHub(); t.after(() => h.destroy());
  const alice = await h.login('alice');
  const runner = await h.runner(await h.enroll(alice));
  const run = await h.startRun(alice, runner, { title: 'Claude card' });
  await cost(runner, run, 1.25);
  const after = await snap(h, alice);
  assert.deepEqual(after.body.cards.find((c) => c.id === run.card_id).cost, { total_usd: 1.25, reported_runs: 1, unavailable_runs: 0, status: 'reported' });
  // A second run on another card, on a no-telemetry AI, makes the board total partial.
  const other = await h.startRun(alice, runner, { title: 'Codex-ish card' });
  h.db.run("UPDATE runs SET ai = 'codex', backend = 'codex_cli', cost_cents = 999 WHERE id = ?", other.run_id);
  const mixed = await snap(h, alice);
  const c2 = mixed.body.cards.find((c) => c.id === other.card_id).cost;
  assert.equal(c2.total_usd, null); assert.equal(c2.status, 'unavailable');
  assert.equal(mixed.body.cost.total_usd, 1.25);
  assert.equal(mixed.body.cost.status, 'partial');
  assert.equal(mixed.body.cost.unavailable_runs, 1);
  assert.equal(mixed.body.cost.daily, null, 'no cap configured');
});

test('daily soft cap: admin sets it, crossing it notifies once, new starts are refused, running work continues', async (t) => {
  const h = await startHub(); t.after(() => h.destroy());
  const alice = await h.login('alice'), bob = await h.login('bob');
  const runner = await h.runner(await h.enroll(alice));
  const patch = (c, body) => h.api(c, 'PATCH', `/api/boards/${h.ids.board}`, body);
  assert.equal((await patch(alice, { daily_cap_usd: 0.1 })).status, 400);
  assert.equal((await patch(alice, { daily_cap_usd: 'lots' })).status, 400);
  assert.equal((await patch(alice, { daily_cap_usd: 3 })).status, 200);
  assert.equal(h.hub.boardSettings(h.ids.board).daily_cap_usd, 3);
  const run = await h.startRun(alice, runner, { title: 'Spender' });
  assert.ok(h.hub.dailyRemainingCents(h.ids.board) > 250);
  await cost(runner, run, 2);
  assert.equal((await snap(h, alice)).body.cost.daily.exceeded, false);
  const notes = () => h.hub.notifications.filter((n) => n.rule === 'daily_cap');
  assert.equal(notes().length, 0);
  await cost(runner, run, 3.5);
  await cost(runner, run, 3.6);
  const daily = (await snap(h, alice)).body.cost.daily;
  assert.deepEqual(daily, { cap_usd: 3, spent_usd: 3.6, exceeded: true });
  assert.equal(notes().length, 1, 'once per day');
  assert.equal(h.hub.card(run.card_id).run_state, 'running', 'soft: the live run is not killed');
  const next = await h.createCard(alice, { title: 'Next' });
  const d = await h.action(alice, next.id, 'dispatch');
  assert.equal(d.status, 422); assert.equal(d.body.error.code, 'BUDGET_EXCEEDED');
  assert.equal(h.hub.pendingDispatch(next.id), null);
  assert.equal((await patch(alice, { daily_cap_usd: null })).status, 200);
  assert.equal((await snap(h, alice)).body.cost.daily, null);
  assert.equal((await h.action(alice, next.id, 'dispatch')).status, 200);
  // A member cannot change it.
  assert.equal((await patch(bob, { daily_cap_usd: 5 })).status, 403);
});
