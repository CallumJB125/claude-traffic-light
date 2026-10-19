// Person-to-person hand-off (team depth lane D, plan D1–D3): a member hands a
// card to a teammate; the teammate accepts or declines; the sender or an admin
// cancels. Inbox rows go to the other side in the same transaction; only `to`
// may answer; every answer is final (409 after).

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tenancy } from './tenancy/fixture.js';

const url = (card, id = null, verb = null) => `/api/cards/${card}/handoffs${id ? `/${id}/${verb}` : ''}`;
const inbox = (db, memberId, kind) => db.all("SELECT * FROM inbox WHERE member_id = ? AND kind = ? ORDER BY created_at", memberId, kind);
const request = (fx, from, to, note = 'yours now') => fx.as(from, 'POST', url(fx.A.card), { request_id: randomUUID(), to_member_id: to, note });

test('D1: a request creates state requested, adds the teammate to assignees, writes their handoff_request inbox row, shows on the card', async () => {
  const fx = await tenancy();
  try {
    const r = await request(fx, fx.users.amember, fx.A.s);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.handoff.state, 'requested');
    assert.equal(r.body.handoff.from_member_id, fx.A.member);
    assert.equal(r.body.handoff.to_member_id, fx.A.s);
    assert.equal(r.body.handoff.note, 'yours now');
    assert.equal(r.body.handoff.handover_id, null, 'no handover yet on a fresh card');
    assert.ok(r.body.card.assignee_ids.includes(fx.A.s));
    assert.equal(r.body.card.handoff.state, 'requested');
    assert.equal(r.body.card.handoff.to, fx.A.s);
    const rows = inbox(fx.db, fx.A.s, 'handoff_request');
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].ref_json), { board_id: fx.A.board, card_id: fx.A.card, handoff_id: r.body.handoff.id, by: fx.A.member });
    assert.equal(inbox(fx.db, fx.A.member, 'handoff_request').length, 0, 'the sender gets no request row');
    const detail = await fx.as(fx.users.s, 'GET', `/api/cards/${fx.A.card}`);
    assert.equal(detail.body.card.handoff.id, r.body.handoff.id);
    const kinds = fx.db.all("SELECT kind FROM journal WHERE card_id = ? ORDER BY seq", fx.A.card).map((x) => x.kind);
    assert.ok(kinds.includes('card.handoff_requested'));
    // One requested hand-off per card at a time.
    const again = await request(fx, fx.users.ua, fx.A.s);
    assert.equal(again.status, 409, again.text);
  } finally { await fx.h.close(); }
});

test('request validation: to yourself, a viewer, an unknown member, a viewer caller, another team\'s card', async () => {
  const fx = await tenancy();
  try {
    assert.equal((await request(fx, fx.users.amember, fx.A.member)).status, 400);
    assert.equal((await request(fx, fx.users.amember, fx.A.viewer)).status, 400);
    assert.equal((await request(fx, fx.users.amember, randomUUID())).status, 400);
    assert.equal((await request(fx, fx.users.aviewer, fx.A.s)).status, 403);
    assert.equal((await fx.as(fx.users.amember, 'POST', url(fx.B.card), { request_id: randomUUID(), to_member_id: fx.B.s })).status, 404);
    assert.equal(fx.db.all('SELECT 1 FROM handoffs').length, 0);
  } finally { await fx.h.close(); }
});

test('D2: accept by `to` moves to accepted and writes handoff_answer for `from`; anyone else 403; a second answer 409', async () => {
  const fx = await tenancy();
  try {
    const { body: { handoff } } = await request(fx, fx.users.amember, fx.A.s);
    const other = await fx.as(fx.users.aadmin, 'POST', url(fx.A.card, handoff.id, 'accept'), { request_id: randomUUID() });
    assert.equal(other.status, 403, other.text);
    const sender = await fx.as(fx.users.amember, 'POST', url(fx.A.card, handoff.id, 'decline'), { request_id: randomUUID() });
    assert.equal(sender.status, 403, sender.text);
    const ok = await fx.as(fx.users.s, 'POST', url(fx.A.card, handoff.id, 'accept'), { request_id: randomUUID() });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.handoff.state, 'accepted');
    assert.ok(ok.body.handoff.answered_at);
    assert.equal(ok.body.card.handoff.state, 'accepted');
    const rows = inbox(fx.db, fx.A.member, 'handoff_answer');
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].ref_json).state, 'accepted');
    assert.equal(inbox(fx.db, fx.A.s, 'handoff_answer').length, 0);
    const twice = await fx.as(fx.users.s, 'POST', url(fx.A.card, handoff.id, 'accept'), { request_id: randomUUID() });
    assert.equal(twice.status, 409, twice.text);
    const declineLater = await fx.as(fx.users.s, 'POST', url(fx.A.card, handoff.id, 'decline'), { request_id: randomUUID() });
    assert.equal(declineLater.status, 409, declineLater.text);
    // A new request is allowed once the previous one is answered.
    assert.equal((await request(fx, fx.users.ua, fx.A.member)).status, 200);
  } finally { await fx.h.close(); }
});

test('decline by `to` is final and tells the sender', async () => {
  const fx = await tenancy();
  try {
    const { body: { handoff } } = await request(fx, fx.users.amember, fx.A.s, '');
    const r = await fx.as(fx.users.s, 'POST', url(fx.A.card, handoff.id, 'decline'), { request_id: randomUUID() });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.handoff.state, 'declined');
    assert.equal(JSON.parse(inbox(fx.db, fx.A.member, 'handoff_answer')[0].ref_json).state, 'declined');
    assert.equal((await fx.as(fx.users.amember, 'POST', url(fx.A.card, handoff.id, 'cancel'), { request_id: randomUUID() })).status, 409);
  } finally { await fx.h.close(); }
});

test('D3: cancel after accept is 409; cancel while requested is 200 and drops only an unread request row', async () => {
  const fx = await tenancy();
  try {
    const first = (await request(fx, fx.users.amember, fx.A.s)).body.handoff;
    await fx.as(fx.users.s, 'POST', url(fx.A.card, first.id, 'accept'), { request_id: randomUUID() });
    assert.equal((await fx.as(fx.users.amember, 'POST', url(fx.A.card, first.id, 'cancel'), { request_id: randomUUID() })).status, 409);

    // Unread: the row goes with the cancellation.
    const second = (await request(fx, fx.users.amember, fx.A.s)).body.handoff;
    assert.equal(inbox(fx.db, fx.A.s, 'handoff_request').length, 2);
    const byStranger = await fx.as(fx.users.s, 'POST', url(fx.A.card, second.id, 'cancel'), { request_id: randomUUID() });
    assert.equal(byStranger.status, 403, 'the recipient cannot cancel');
    const c = await fx.as(fx.users.amember, 'POST', url(fx.A.card, second.id, 'cancel'), { request_id: randomUUID() });
    assert.equal(c.status, 200, c.text);
    assert.equal(c.body.handoff.state, 'cancelled');
    assert.equal(inbox(fx.db, fx.A.s, 'handoff_request').length, 1, 'only the unread second request row was dropped');
    assert.equal(inbox(fx.db, fx.A.member, 'handoff_answer').length, 1, 'a cancel writes no answer row');

    // Read: the row stays; an admin may cancel too.
    const third = (await request(fx, fx.users.amember, fx.A.s)).body.handoff;
    fx.db.run("UPDATE inbox SET read_at = ? WHERE member_id = ? AND json_extract(ref_json, '$.handoff_id') = ?", new Date().toISOString(), fx.A.s, third.id);
    const admin = await fx.as(fx.users.aadmin, 'POST', url(fx.A.card, third.id, 'cancel'), { request_id: randomUUID() });
    assert.equal(admin.status, 200, admin.text);
    assert.equal(inbox(fx.db, fx.A.s, 'handoff_request').length, 2);
    assert.equal(fx.db.all("SELECT kind FROM journal WHERE card_id = ? AND kind = 'card.handoff_cancelled'", fx.A.card).length, 2);
  } finally { await fx.h.close(); }
});

test('an unknown hand-off id, or one under another card, is 404 for every verb', async () => {
  const fx = await tenancy();
  try {
    const { body: { handoff } } = await request(fx, fx.users.amember, fx.A.s);
    for (const verb of ['accept', 'decline', 'cancel']) {
      assert.equal((await fx.as(fx.users.s, 'POST', url(fx.A.card, randomUUID(), verb), { request_id: randomUUID() })).status, 404);
      assert.equal((await fx.as(fx.users.ub, 'POST', url(fx.B.card, handoff.id, verb), { request_id: randomUUID() })).status, 404);
    }
  } finally { await fx.h.close(); }
});
