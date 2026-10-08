// The Linear connector through the real registry and HTTP routes: token
// connect with the webhook signing secret, verify() over the raw bytes and its
// signed timestamp window, issue create/update → one deduped card, status
// changes → one untrusted comment that never moves the card or starts a run,
// and the go-live gate.
//
// FIXTURES: fixtures/linear/*.json are HAND-MADE bodies modelled on Linear's
// webhook docs, re-timed and signed at test time with a random secret. None is
// a recorded delivery: a real one is the go-live gate (docs/LINEAR-RUNBOOK.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { connectorsFor } from '../integrations/index.js';
import { createLinearConnector, issueLink } from '../integrations/linear/index.js';
import { startHub } from './helpers.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/linear/${name}.json`, import.meta.url), 'utf8'));
const newSecret = () => `lin_wh_${randomBytes(24).toString('base64url')}`;
const sign = (secret, raw) => createHmac('sha256', secret).update(raw).digest('hex');

async function setup() {
  const h = await startHub();
  h.hub.setVaultKey(randomBytes(32));
  h.app.integrations.register(createLinearConnector({ now: () => h.clock.wall() }));
  const alice = await h.login('alice');
  const secret = newSecret();
  const r = await h.api(alice, 'POST', '/api/integrations/linear/token', { token: secret });
  assert.equal(r.status, 200, r.text);
  return { h, alice, secret, conn: r.body.connection };
}

function body(h, name, edit = () => {}) {
  const b = fixture(name);
  b.webhookTimestamp = h.clock.wall();
  edit(b);
  return b;
}

const rawOf = (b) => Buffer.isBuffer(b) ? b : Buffer.from(typeof b === 'string' ? b : JSON.stringify(b));
const headersFor = (raw, { secret, sig, drop = [] } = {}) => {
  const out = { 'content-type': 'application/json', 'linear-signature': sig ?? sign(secret, raw), 'linear-delivery': randomUUID(), 'linear-event': 'Issue' };
  for (const k of drop) delete out[k];
  return out;
};
async function post(h, conn, b, opts) {
  const raw = rawOf(b);
  const res = await fetch(`${h.base}/integrations/${conn.id}/webhook`, { method: 'POST', headers: headersFor(raw, opts), body: raw });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const direct = (h, conn, b, opts) => {
  const raw = rawOf(b);
  return h.app.integrations.webhook(conn.id, { headers: headersFor(raw, opts), rawBody: raw });
};

const cards = (h) => h.db.all("SELECT * FROM cards WHERE labels LIKE '%via:linear%' ORDER BY rowid");
const comments = (h) => h.db.all("SELECT * FROM comments WHERE source = 'integration' ORDER BY rowid");
const count = (h, table) => h.db.get(`SELECT COUNT(*) AS n FROM ${table}`).n;

test('fixture: a created issue becomes one Todo card with a fixed template, linked and deduplicated', async () => {
  const { h, secret, conn } = await setup();
  try {
    const created = body(h, 'issue-create');
    const r = await post(h, conn, created, { secret });
    assert.equal(r.status, 200, r.text);
    const [card] = cards(h);
    assert.equal(card.title, 'ENG-123: Checkout button does nothing on Safari');
    assert.equal(card.column_name, 'todo');
    assert.deepEqual(JSON.parse(card.labels), ['via:linear']);
    assert.equal(card.body, 'Linear issue: ENG-123\nTeam: ENG\nStatus: Todo\nPriority: High\nLinear: https://linear.app/acme/issue/ENG-123\n\nSuggested: review this issue, choose an AI and start work from the card.');
    assert.doesNotMatch(card.body, /jane@example\.com|Jane Doe|Steps/, 'description, assignee and labels are never copied');
    const link = h.db.get('SELECT * FROM external_links WHERE connection_id = ?', conn.id);
    assert.deepEqual([link.card_id, link.kind, link.external_id, link.url], [card.id, 'issue', '2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9', 'https://linear.app/acme/issue/ENG-123']);
    assert.equal(h.db.get("SELECT decision FROM integration_audit WHERE connection_id = ? AND action = 'linear.card'", conn.id).decision, 'auto');
    assert.deepEqual((await post(h, conn, created, { secret })).body, { ok: true, duplicate: true });
    h.db.run('DELETE FROM inbound_dedupe');
    assert.equal((await post(h, conn, created, { secret })).status, 200);
    assert.equal((await post(h, conn, body(h, 'issue-create', (b) => { b.data.title = 'Renamed'; }), { secret })).status, 200);
    assert.equal(cards(h).length, 1);
    assert.equal(count(h, 'external_links'), 1);
    assert.equal(count(h, 'runs'), 0);
  } finally { await h.close(); }
});

test('fixture: a state change adds one untrusted comment; the card stays in Todo and no AI starts', async () => {
  const { h, secret, conn } = await setup();
  try {
    await post(h, conn, body(h, 'issue-create'), { secret });
    const [card] = cards(h);
    assert.equal((await post(h, conn, body(h, 'issue-update-state'), { secret })).status, 200);
    let [c] = comments(h);
    assert.equal(c.card_id, card.id);
    assert.equal(c.body, 'Linear status changed to In Progress.\nThis update came from Linear; it does not move the card or start an AI.\nLinear: https://linear.app/acme/issue/ENG-123');
    assert.deepEqual([c.trusted, c.for_agent], [0, 0]);
    // Linear's retry carries a new webhookTimestamp (new bytes): the durable request id still makes it one comment.
    h.clock.advance(60_000);
    assert.equal((await post(h, conn, body(h, 'issue-update-state'), { secret })).status, 200);
    assert.equal(comments(h).length, 1);
    // Completed: one more comment, still nothing moved or dispatched.
    await post(h, conn, body(h, 'issue-update-state', (b) => {
      b.updatedFrom.stateId = b.data.stateId;
      b.data.stateId = b.data.state.id = '0a0a0a0a-5d1c-4b33-8a8c-333333333333';
      b.data.state.name = 'Done'; b.data.state.type = 'completed'; b.data.updatedAt = '2026-10-01T11:00:00.000Z';
    }), { secret });
    assert.equal(comments(h).length, 2);
    assert.match(comments(h)[1].body, /^Linear status changed to Done\./);
    assert.equal(h.card(card.id).column_name, 'todo');
    assert.equal(count(h, 'runs'), 0);
    assert.equal(cards(h).length, 1);
    // An update that is not a state change (a title edit) comments nothing.
    await post(h, conn, body(h, 'issue-update-state', (b) => { b.updatedFrom = { title: 'old', updatedAt: b.data.updatedAt }; b.data.updatedAt = '2026-10-01T12:00:00.000Z'; }), { secret });
    assert.equal(comments(h).length, 2);
    [c] = comments(h);
    assert.equal(c.source, 'integration');
  } finally { await h.close(); }
});

test('an update for an issue with no card makes its card (once); a completed or canceled one makes none', async () => {
  const { h, secret, conn } = await setup();
  try {
    await post(h, conn, body(h, 'issue-update-state'), { secret });
    assert.equal(cards(h).length, 1);
    assert.equal(comments(h).length, 0, 'the card is new: no status comment');
    for (const type of ['completed', 'canceled']) {
      await post(h, conn, body(h, 'issue-update-state', (b) => { b.data.id = randomUUID(); b.data.identifier = 'ENG-9'; b.data.state.type = type; }), { secret });
    }
    assert.equal(cards(h).length, 1);
  } finally { await h.close(); }
});

test('other types, actions and malformed issues are acknowledged and do nothing', async () => {
  const { h, secret, conn } = await setup();
  try {
    const edits = [
      (b) => { b.type = 'Comment'; }, (b) => { b.type = 'issue'; }, (b) => { b.action = 'remove'; }, (b) => { b.action = 'CREATE'; },
      (b) => { b.data.id = 'not-a-uuid'; }, (b) => { b.data.identifier = 'eng-123'; }, (b) => { b.data.identifier = 123; }, (b) => { b.data = null; },
    ];
    for (const edit of edits) assert.equal((await direct(h, conn, body(h, 'issue-create', edit), { secret })).status, 200, String(edit));
    assert.equal(cards(h).length, 0);
    assert.equal(count(h, 'integration_audit'), 0);
  } finally { await h.close(); }
});

test('verify: forged, missing and re-serialised signatures, duplicate keys and a stale or future signed timestamp are 401 with nothing written', async () => {
  const { h, secret, conn } = await setup();
  try {
    const b = body(h, 'issue-create');
    const raw = rawOf(b);
    const good = sign(secret, raw);
    const flip = (s, i) => s.slice(0, i) + (s[i] === '0' ? '1' : '0') + s.slice(i + 1);
    const cases = [
      [raw, { sig: '' }], [raw, { drop: ['linear-signature'] }], [raw, { sig: good.slice(0, 63) }], [raw, { sig: good.toUpperCase() }],
      [raw, { sig: flip(good, 0) }], [raw, { sig: `sha256=${good}` }], [raw, { secret: newSecret() }],
      [Buffer.from(JSON.stringify(b, null, 2)), { sig: good }],
      [Buffer.from(JSON.stringify(b).replace('"type":"Issue"', '"type":"Issue","type":"Comment"')), { secret }],
      [body(h, 'issue-create', (x) => { x.webhookTimestamp = h.clock.wall() - 25 * 3_600_000; }), { secret }],
      [body(h, 'issue-create', (x) => { x.webhookTimestamp = h.clock.wall() + 10 * 60_000; }), { secret }],
      [body(h, 'issue-create', (x) => { delete x.webhookTimestamp; }), { secret }],
      [body(h, 'issue-create', (x) => { x.webhookTimestamp = String(h.clock.wall()); }), { secret }],
    ];
    for (const [payload, o] of cases) assert.equal((await direct(h, conn, payload, { secret, ...o })).status, 401, JSON.stringify(o));
    assert.equal(count(h, 'inbound_dedupe'), 0);
    assert.equal(cards(h).length, 0);
    assert.equal((await post(h, conn, raw, { secret, sig: flip(good, 7) })).status, 401);
  } finally { await h.close(); }
});

test('hostile text is scrubbed and only a checked linear.app URL is linked', async () => {
  const { h, secret, conn } = await setup();
  try {
    await post(h, conn, body(h, 'issue-create', (b) => {
      b.data.title = '<script>alert(1)</script> mail ceo@example.com via https://evil.example/x [click](javascript:x)';
      b.url = 'https://linear.app.evil.example/acme/issue/ENG-123';
      b.data.state.name = '@here **Done**';
    }), { secret });
    const [card] = cards(h);
    assert.equal(card.title, 'ENG-123: script alert 1 /script mail [redacted] via [redacted] click [redacted]');
    assert.doesNotMatch(card.body, /evil|Linear: /);
    assert.match(card.body, /Status: \[redacted\] Done/);
    for (const u of ['http://linear.app/acme/issue/ENG-123', 'https://linear.app/acme/issue/ENG-124', 'https://linear.app/acme/issue/ENG-123?x=1', 'https://user@linear.app/acme/issue/ENG-123', 'https://linear.app:444/acme/issue/ENG-123']) {
      assert.equal(issueLink(u, 'ENG-123'), null, u);
    }
    assert.equal(issueLink('https://linear.app/acme/issue/ENG-123/some-slug', 'ENG-123'), 'https://linear.app/acme/issue/ENG-123');
  } finally { await h.close(); }
});

test('connect: a secret of the wrong shape is refused; go-live gate: Linear is in no hub\'s default connectors', async () => {
  const { h, alice } = await setup();
  try {
    for (const token of ['short', 'has space in it 1234567890', 'x'.repeat(257)]) {
      assert.notEqual((await h.api(alice, 'POST', '/api/integrations/linear/token', { token })).status, 200, token);
    }
  } finally { await h.close(); }
  for (const auth of ['dev', 'access', 'accounts', 'local']) assert.ok(!connectorsFor({ auth }).some((c) => c.id === 'linear'), auth);
  const g = await startHub();
  try {
    const alice2 = await g.login('alice');
    assert.ok(!(await g.api(alice2, 'GET', '/api/integrations')).body.available.some((c) => c.id === 'linear'));
    assert.equal((await g.api(alice2, 'POST', '/api/integrations/linear/token', { token: newSecret() })).status, 404);
  } finally { await g.close(); }
});
