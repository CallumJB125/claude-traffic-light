// The Jira connector through the real registry and HTTP routes: token connect
// with the webhook secret, verify() over the raw bytes ("sha256=" X-Hub-Signature)
// and its signed timestamp window, issue created/updated → one deduped card,
// status transitions → one untrusted comment that never moves the card or
// starts a run, and the go-live gate.
//
// FIXTURES: fixtures/jira/*.json are HAND-MADE bodies modelled on Atlassian's
// webhook docs, re-timed and signed at test time with a random secret. None is
// a recorded delivery: a real one is the go-live gate (docs/JIRA-RUNBOOK.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { connectorsFor } from '../integrations/index.js';
import { createJiraConnector, issueLink } from '../integrations/jira/index.js';
import { startHub } from './helpers.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/jira/${name}.json`, import.meta.url), 'utf8'));
const newSecret = () => randomBytes(24).toString('base64url');
const sign = (secret, raw) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

async function setup() {
  const h = await startHub();
  h.hub.setVaultKey(randomBytes(32));
  h.app.integrations.register(createJiraConnector({ now: () => h.clock.wall() }));
  const alice = await h.login('alice');
  const secret = newSecret();
  const r = await h.api(alice, 'POST', '/api/integrations/jira/token', { token: secret });
  assert.equal(r.status, 200, r.text);
  return { h, alice, secret, conn: r.body.connection };
}

function body(h, name, edit = () => {}) {
  const b = fixture(name);
  b.timestamp = h.clock.wall();
  edit(b);
  return b;
}

const rawOf = (b) => Buffer.isBuffer(b) ? b : Buffer.from(typeof b === 'string' ? b : JSON.stringify(b));
const headersFor = (raw, { secret, sig, drop = [] } = {}) => {
  const out = { 'content-type': 'application/json', 'x-hub-signature': sig ?? sign(secret, raw), 'x-atlassian-webhook-identifier': randomUUID() };
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

const cards = (h) => h.db.all("SELECT * FROM cards WHERE labels LIKE '%via:jira%' ORDER BY rowid");
const comments = (h) => h.db.all("SELECT * FROM comments WHERE source = 'integration' ORDER BY rowid");
const count = (h, table) => h.db.get(`SELECT COUNT(*) AS n FROM ${table}`).n;

test('fixture: a created issue becomes one Todo card with a fixed template, linked and deduplicated', async () => {
  const { h, secret, conn } = await setup();
  try {
    const created = body(h, 'issue-created');
    const r = await post(h, conn, created, { secret });
    assert.equal(r.status, 200, r.text);
    const [card] = cards(h);
    assert.equal(card.title, 'PROJ-42: Invoice PDF shows the wrong currency');
    assert.equal(card.column_name, 'todo');
    assert.deepEqual(JSON.parse(card.labels), ['via:jira']);
    assert.equal(card.body, 'Jira issue: PROJ-42\nProject: PROJ\nType: Bug\nStatus: To Do\nPriority: High\nJira: https://acme.atlassian.net/browse/PROJ-42\n\nSuggested: review this issue, choose an AI and start work from the card.');
    assert.doesNotMatch(card.body, /jane@example\.com|Jane Doe|acme\.example/, 'description and user are never copied');
    const link = h.db.get('SELECT * FROM external_links WHERE connection_id = ?', conn.id);
    assert.deepEqual([link.card_id, link.kind, link.external_id, link.url], [card.id, 'issue', '10001', 'https://acme.atlassian.net/browse/PROJ-42']);
    assert.equal(h.db.get("SELECT decision FROM integration_audit WHERE connection_id = ? AND action = 'jira.card'", conn.id).decision, 'auto');
    assert.deepEqual((await post(h, conn, created, { secret })).body, { ok: true, duplicate: true });
    h.db.run('DELETE FROM inbound_dedupe');
    assert.equal((await post(h, conn, created, { secret })).status, 200);
    assert.equal((await post(h, conn, body(h, 'issue-created', (b) => { b.issue.fields.summary = 'Renamed'; }), { secret })).status, 200);
    assert.equal(cards(h).length, 1);
    assert.equal(count(h, 'external_links'), 1);
    assert.equal(count(h, 'runs'), 0);
  } finally { await h.close(); }
});

test('fixture: a status transition adds one untrusted comment; the card stays in Todo and no AI starts', async () => {
  const { h, secret, conn } = await setup();
  try {
    await post(h, conn, body(h, 'issue-created'), { secret });
    const [card] = cards(h);
    assert.equal((await post(h, conn, body(h, 'issue-updated-status'), { secret })).status, 200);
    const [c] = comments(h);
    assert.equal(c.card_id, card.id);
    assert.equal(c.body, 'Jira status changed to In Progress.\nThis update came from Jira; it does not move the card or start an AI.\nJira: https://acme.atlassian.net/browse/PROJ-42');
    assert.deepEqual([c.trusted, c.for_agent], [0, 0]);
    // A retry with a new timestamp is new bytes; the changelog id keeps it one comment.
    h.clock.advance(60_000);
    assert.equal((await post(h, conn, body(h, 'issue-updated-status'), { secret })).status, 200);
    assert.equal(comments(h).length, 1);
    await post(h, conn, body(h, 'issue-updated-status', (b) => {
      b.changelog.id = '10101';
      b.changelog.items[0].toString = 'Done';
      b.issue.fields.status = { id: '4', name: 'Done', statusCategory: { key: 'done' } };
    }), { secret });
    assert.equal(comments(h).length, 2);
    assert.match(comments(h)[1].body, /^Jira status changed to Done\./);
    assert.equal(h.card(card.id).column_name, 'todo');
    assert.equal(count(h, 'runs'), 0);
    // An edit with no status item in its changelog comments nothing.
    await post(h, conn, body(h, 'issue-updated-status', (b) => { b.changelog = { id: '10102', items: [{ field: 'summary', toString: 'new' }] }; }), { secret });
    assert.equal(comments(h).length, 2);
    assert.equal(cards(h).length, 1);
  } finally { await h.close(); }
});

test('an update for an issue with no card makes its card (once); one already done makes none', async () => {
  const { h, secret, conn } = await setup();
  try {
    await post(h, conn, body(h, 'issue-updated-status'), { secret });
    assert.equal(cards(h).length, 1);
    assert.equal(comments(h).length, 0, 'the card is new: no status comment');
    await post(h, conn, body(h, 'issue-updated-status', (b) => {
      b.issue.id = '10002'; b.issue.key = 'PROJ-43'; b.issue.self = 'https://acme.atlassian.net/rest/api/2/issue/10002';
      b.issue.fields.status = { name: 'Done', statusCategory: { key: 'done' } };
    }), { secret });
    assert.equal(cards(h).length, 1);
  } finally { await h.close(); }
});

test('other events and malformed issues are acknowledged and do nothing', async () => {
  const { h, secret, conn } = await setup();
  try {
    const edits = [
      (b) => { b.webhookEvent = 'jira:issue_deleted'; }, (b) => { b.webhookEvent = 'comment_created'; }, (b) => { b.webhookEvent = 'JIRA:ISSUE_CREATED'; },
      (b) => { b.issue.id = 10001; }, (b) => { b.issue.id = '10a'; }, (b) => { b.issue.key = 'proj-42'; }, (b) => { b.issue = null; },
    ];
    for (const edit of edits) assert.equal((await direct(h, conn, body(h, 'issue-created', edit), { secret })).status, 200, String(edit));
    assert.equal(cards(h).length, 0);
    assert.equal(count(h, 'integration_audit'), 0);
  } finally { await h.close(); }
});

test('verify: forged, missing and re-serialised signatures, duplicate keys and a stale or future signed timestamp are 401 with nothing written', async () => {
  const { h, secret, conn } = await setup();
  try {
    const b = body(h, 'issue-created');
    const raw = rawOf(b);
    const good = sign(secret, raw);
    const flip = (s, i) => s.slice(0, i) + (s[i] === '0' ? '1' : '0') + s.slice(i + 1);
    const cases = [
      [raw, { sig: '' }], [raw, { drop: ['x-hub-signature'] }], [raw, { sig: good.slice(7) }], [raw, { sig: good.toUpperCase() }],
      [raw, { sig: flip(good, 10) }], [raw, { sig: `sha1=${good.slice(7)}` }], [raw, { secret: newSecret() }],
      [Buffer.from(JSON.stringify(b, null, 2)), { sig: good }],
      [Buffer.from(JSON.stringify(b).replace('"key":"PROJ-42"', '"key":"PROJ-42","key":"PROJ-1"')), { secret }],
      [body(h, 'issue-created', (x) => { x.timestamp = h.clock.wall() - 25 * 3_600_000; }), { secret }],
      [body(h, 'issue-created', (x) => { x.timestamp = h.clock.wall() + 10 * 60_000; }), { secret }],
      [body(h, 'issue-created', (x) => { delete x.timestamp; }), { secret }],
    ];
    for (const [payload, o] of cases) assert.equal((await direct(h, conn, payload, { secret, ...o })).status, 401, JSON.stringify(o));
    assert.equal(count(h, 'inbound_dedupe'), 0);
    assert.equal(cards(h).length, 0);
    assert.equal((await post(h, conn, raw, { secret, sig: flip(good, 12) })).status, 401);
  } finally { await h.close(); }
});

test('hostile text is scrubbed and only a checked atlassian.net URL is linked', async () => {
  const { h, secret, conn } = await setup();
  try {
    await post(h, conn, body(h, 'issue-created', (b) => {
      b.issue.fields.summary = '<img src=x> ping @channel https://evil.example';
      b.issue.self = 'https://acme.atlassian.net.evil.example/rest/api/2/issue/10001';
    }), { secret });
    const [card] = cards(h);
    assert.equal(card.title, 'PROJ-42: img src=x ping [redacted] [redacted]');
    assert.doesNotMatch(card.body, /evil|Jira: /);
    for (const [self, id] of [['http://acme.atlassian.net/rest/api/2/issue/10001', '10001'], ['https://acme.atlassian.net/rest/api/2/issue/10002', '10001'],
      ['https://acme.atlassian.net/rest/api/2/issue/10001?x', '10001'], ['https://jira.acme.example/rest/api/2/issue/10001', '10001']]) {
      assert.equal(issueLink(self, id, 'PROJ-42'), null, self);
    }
    assert.equal(issueLink('https://acme.atlassian.net/rest/api/3/issue/10001', '10001', 'PROJ-42'), 'https://acme.atlassian.net/browse/PROJ-42');
  } finally { await h.close(); }
});

test('connect: a secret of the wrong shape is refused; go-live gate: Jira is in no hub\'s default connectors', async () => {
  const { h, alice } = await setup();
  try {
    for (const token of ['short', 'has space in it 1234567890', 'x'.repeat(257)]) {
      assert.notEqual((await h.api(alice, 'POST', '/api/integrations/jira/token', { token })).status, 200, token);
    }
  } finally { await h.close(); }
  for (const auth of ['dev', 'access', 'accounts', 'local']) assert.ok(!connectorsFor({ auth }).some((c) => c.id === 'jira'), auth);
  const g = await startHub();
  try {
    const alice2 = await g.login('alice');
    assert.ok(!(await g.api(alice2, 'GET', '/api/integrations')).body.available.some((c) => c.id === 'jira'));
    assert.equal((await g.api(alice2, 'POST', '/api/integrations/jira/token', { token: newSecret() })).status, 404);
  } finally { await g.close(); }
});
