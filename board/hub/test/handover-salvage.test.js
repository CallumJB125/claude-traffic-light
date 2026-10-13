// POST /api/cards/:id/handover/salvage: the opt-in local session handover. It
// appends one system-written salvage line and nothing else, with the same
// authority as a comment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tenancy, MARK } from './tenancy/fixture.js';

const salvageRows = (db, cardId) => db.all("SELECT * FROM events WHERE card_id = ? AND kind = 'salvage' ORDER BY id", cardId);
const url = (id) => `/api/cards/${id}/handover/salvage`;
const doc = async (fx, user, id) => (await fx.as(user, 'GET', `/api/cards/${id}/handover`)).body;

test('a member appends a salvage section: system-written, labelled, shown in the handover doc', async () => {
  const fx = await tenancy();
  try {
    const r = await fx.as(fx.users.amember, 'POST', url(fx.A.card), { text: 'Last prompt: fix the login bug', date: '2026-10-07' });
    assert.equal(r.status, 200, r.text);
    const [row] = salvageRows(fx.db, fx.A.card);
    const p = JSON.parse(row.payload);
    assert.equal(p.written_by, 'system');
    assert.match(p.text, /^Local session handover \(written by Plexiform from hook events, not by the AI\), 2026-10-07:\nLast prompt: fix the login bug/);
    assert.match((await doc(fx, fx.users.amember, fx.A.card)).markdown, /fix the login bug/);
    assert.equal(fx.db.all('SELECT 1 FROM handovers WHERE card_id = ?', fx.A.card).length, 0, 'no human or agent layer is written');
  } finally { await fx.h.close(); }
});

test('secrets are removed on the hub too, and the text is size capped', async () => {
  const fx = await tenancy();
  try {
    const r = await fx.as(fx.users.amember, 'POST', url(fx.A.card), { text: 'ran: export API_KEY=sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.equal(r.status, 200, r.text);
    const text = JSON.parse(salvageRows(fx.db, fx.A.card)[0].payload).text;
    assert.doesNotMatch(text, /sk-ant/);
    assert.match(text, /\[redacted\]/);
    const big = await fx.as(fx.users.amember, 'POST', url(fx.A.card), { text: 'x'.repeat(8001) });
    assert.equal(big.status, 400, big.text);
    const empty = await fx.as(fx.users.amember, 'POST', url(fx.A.card), { text: '' });
    assert.equal(empty.status, 400, empty.text);
  } finally { await fx.h.close(); }
});

test('a viewer is refused and nothing is written', async () => {
  const fx = await tenancy();
  try {
    const r = await fx.as(fx.users.aviewer, 'POST', url(fx.A.card), { text: 'viewer note' });
    assert.equal(r.status, 403, r.text);
    assert.equal(salvageRows(fx.db, fx.A.card).length, 0);
  } finally { await fx.h.close(); }
});

test('cross-team: another team\'s card answers 404 and its rows are untouched', async () => {
  const fx = await tenancy();
  try {
    const before = JSON.stringify(fx.db.all('SELECT * FROM events WHERE card_id = ? ORDER BY id', fx.B.card));
    for (const u of [fx.users.ua, fx.users.amember, fx.users.n]) {
      const r = await fx.as(u, 'POST', url(fx.B.card), { text: `pwned ${MARK}` });
      assert.equal(r.status, 404, r.text);
    }
    assert.equal(JSON.stringify(fx.db.all('SELECT * FROM events WHERE card_id = ? ORDER BY id', fx.B.card)), before);
  } finally { await fx.h.close(); }
});

test('rate limited per member', async () => {
  const fx = await tenancy({ config: { rateLimits: { handover_salvage_member: { capacity: 2, per_ms: 3_600_000 } } } });
  try {
    for (let i = 0; i < 2; i += 1) assert.equal((await fx.as(fx.users.amember, 'POST', url(fx.A.card), { text: `note ${i}` })).status, 200);
    const r = await fx.as(fx.users.amember, 'POST', url(fx.A.card), { text: 'one too many' });
    assert.equal(r.status, 429, r.text);
    assert.equal(salvageRows(fx.db, fx.A.card).length, 2);
  } finally { await fx.h.close(); }
});
