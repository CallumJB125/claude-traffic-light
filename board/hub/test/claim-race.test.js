// Two runners claim / double-click: exactly one wins the CAS, the loser gets
// CLAIM_LOST (and offer.withdrawn) and spawns nothing; claim retries with the
// same request_id are idempotent; dispatch is idempotent by request_id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startHub } from './helpers.js';

test('two runners claim the same offer at once → exactly one wins', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r1 = await h.runner(await h.enroll(alice, 'Mac-1'));
    const r2 = await h.runner(await h.enroll(alice, 'Mac-2'));
    const card = await h.createCard(alice);
    await h.action(alice, card.id, 'dispatch');
    const [o1, o2] = await Promise.all([r1.next('offer', (o) => o.card_id === card.id), r2.next('offer', (o) => o.card_id === card.id)]);
    assert.equal(o1.request_id, o2.request_id);

    const [a, b] = await Promise.all([r1.claim(o1), r2.claim(o2)]);
    assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
    const loser = a.ok ? b : a;
    const winner = a.ok ? r1 : r2;
    const loserRunner = a.ok ? r2 : r1;
    assert.equal(loser.error.code, 'CLAIM_LOST');
    await loserRunner.next('offer.withdrawn', (m) => m.card_id === card.id);
    assert.equal(h.db.get('SELECT count(*) AS n FROM runs WHERE card_id = ?', card.id).n, 1);
    assert.equal(h.card(card.id).fence, 1);

    // The winner retries the same claim (lost result): idempotent.
    const again = await winner.claim(a.ok ? o1 : o2);
    assert.equal(again.ok, true);
    assert.equal(again.run_id, (a.ok ? a : b).run_id);
    // A stale expected fence never wins.
    const stale = await loserRunner.claim(o1, { expected_fence: 0 });
    assert.equal(stale.ok, false);
  } finally {
    await h.destroy();
  }
});

test('dispatch is idempotent by request_id; a dispatch for a teammate needs their confirm and only their runner may claim', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    const ra = await h.runner(await h.enroll(alice));
    const rb = await h.runner(await h.enroll(bob), { auto_accept_from: [] });
    const card = await h.createCard(alice);
    const rid = randomUUID();
    const d1 = await h.api(alice, 'POST', `/api/cards/${card.id}/actions/dispatch`, { request_id: rid, target_member_id: h.ids.bob });
    const d2 = await h.api(alice, 'POST', `/api/cards/${card.id}/actions/dispatch`, { request_id: rid, target_member_id: h.ids.bob });
    assert.equal(d1.status, 200);
    assert.equal(d2.status, 200);
    assert.equal(d2.body.card.id, d1.body.card.id);
    assert.equal(h.db.get('SELECT count(*) AS n FROM dispatches WHERE card_id = ?', card.id).n, 1);
    assert.equal(d1.body.card.target.awaiting_confirm, true);
    assert.equal(d1.body.card.target.name, 'Bob');

    // Dispatch retries validate the exact choice against the durable row,
    // rather than returning an old generic HTTP cache response.
    h.hub.requestCache.clear();
    const d3 = await h.api(alice, 'POST', `/api/cards/${card.id}/actions/dispatch`, { request_id: rid, target_member_id: h.ids.bob });
    assert.equal(d3.status, 200);
    const changed = await h.api(alice, 'POST', `/api/cards/${card.id}/actions/dispatch`, { request_id: rid });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, 'CONFLICT');
    assert.equal(h.db.get('SELECT count(*) AS n FROM dispatches WHERE card_id = ?', card.id).n, 1);

    const offer = await rb.next('offer', (o) => o.card_id === card.id);
    assert.equal(offer.needs_confirm, true);
    assert.equal(ra.all('offer', (o) => o.card_id === card.id).length, 0, "only the target member's runners get the offer");
    const steal = await ra.claim(offer);
    assert.equal(steal.ok, false);
    assert.equal(steal.error.code, 'POLICY_DENIED');

    // Bob declines locally → todo.
    rb.send({ type: 'decline', card_id: card.id, request_id: offer.request_id, reason: 'busy' });
    await rb.hb([]);
    assert.equal(h.card(card.id).run_state, null);
    assert.equal(h.db.get('SELECT state FROM dispatches WHERE request_id = ?', rid).state, 'declined');
  } finally {
    await h.destroy();
  }
});

test('cancel withdraws the offer; queued with no runner online nudges the dispatcher once after 10 min', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice));
    const card = await h.createCard(alice);
    await h.action(alice, card.id, 'dispatch');
    await r.next('offer', (o) => o.card_id === card.id);
    const c = await h.action(alice, card.id, 'cancel');
    assert.equal(c.status, 200);
    await r.next('offer.withdrawn', (m) => m.card_id === card.id && m.reason === 'cancelled');
    r.terminate();

    const card2 = await h.createCard(alice);
    await h.action(alice, card2.id, 'dispatch');
    await h.run(10 * 60_000 + 1000, 30_000);
    assert.equal(h.hub.notifications.filter((n) => n.rule === 'queued_no_runner' && n.card_id === card2.id).length, 1);
    await h.run(60_000, 30_000);
    assert.equal(h.hub.notifications.filter((n) => n.rule === 'queued_no_runner').length, 1, 'once');
    const v = (await h.api(alice, 'GET', `/api/cards/${card2.id}`)).body.card;
    assert.equal(v.queue.runner_online, false);
  } finally {
    await h.destroy();
  }
});
