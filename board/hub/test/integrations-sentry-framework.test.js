// Framework additions for Sentry slice S-A (CONTRACT D42 addendum "the Sentry
// connector"): the opt-in daily card rule (dailyCardCap →
// integration_card_day_conn), the admin-only webhook URL of a token connector
// (showsWebhookUrl, gap G1) and ctx.lastCreatedCard() (the suppression notice's card).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as rsaSign, randomBytes, randomUUID } from 'node:crypto';
import { defineConnector } from '../integrations/connector.js';
import { DEFAULT_LIMITS } from '../ratelimit.js';
import fake from '../integrations/fake/index.js';
import github from '../integrations/github/index.js';
import { startHub } from './helpers.js';

const probe = (id, over = {}) => defineConnector({
  id, name: `Probe ${id}`, scopes: [], secrets: [], hosts: [],
  connect: { kind: 'token', verifyToken: async ({ token }) => ({ external_id: `w-${token}`, display_name: 'Probe' }) },
  verify: () => ({ ok: true, dedupe_key: randomUUID() }),
  handleWebhook: async () => {},
  actions: { 'card.create': { default: 'auto' } },
  ...over,
});

async function hub(config = {}) {
  const h = await startHub({ config });
  h.hub.setVaultKey(randomBytes(32));
  return h;
}

const connect = (h, conn, external_id = 'w1') => {
  if (!h.app.integrations.connectors().some((c) => c.id === conn.id)) h.app.integrations.register(conn);
  return h.app.integrations.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: conn.id, external_id });
};

// createCard n times inside act(); → the error codes (null for a card).
async function cards(h, c, n, prefix = 'r') {
  const ctx = h.app.integrations.ctxFor(c.id);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    try {
      await ctx.act('card.create', {}, (s) => s.actAs(c.created_by ?? h.ids.alice).createCard(h.ids.board, { request_id: `${prefix}-${i}`, title: `t${i}` }));
      out.push(null);
    } catch (e) { out.push(e.code); }
  }
  return out;
}

// ── dailyCardCap ──────────────────────────────────────────────────────────

test('dailyCardCap: defineConnector takes an integer 1–10000 only; the rule exists with a day window', () => {
  for (const bad of [0, -1, 10_001, 1.5, '100', true, null, NaN, Infinity]) assert.throws(() => probe('dc-bad', { dailyCardCap: bad }), /dailyCardCap/, String(bad));
  for (const ok of [1, 100, 10_000]) assert.equal(probe('dc-ok', { dailyCardCap: ok }).dailyCardCap, ok);
  assert.deepEqual(DEFAULT_LIMITS.integration_card_day_conn, { capacity: 100, per_ms: 86_400_000 });
});

test('dailyCardCap: a connector that declares it is held to its cap per connection per day; replays spend nothing', async () => {
  const h = await hub();
  try {
    const c = connect(h, probe('dc1', { dailyCardCap: 2 }));
    assert.deepEqual(await cards(h, c, 3), [null, null, 'RATE_LIMITED']);
    // The same request again (durable integration_requests hit) is still the card, no token.
    assert.deepEqual(await cards(h, c, 2), [null, null]);
    // Another connection has its own bucket.
    const c2 = connect(h, probe('dc1', { dailyCardCap: 2 }), 'w2');
    assert.deepEqual(await cards(h, c2, 2, 'x'), [null, null]);
    // It refills over the day: half a day is one more card at a cap of 2.
    h.clock.advance(12 * 3_600_000);
    assert.deepEqual(await cards(h, c, 2, 'later'), [null, 'RATE_LIMITED']);
  } finally { await h.close(); }
});

test('dailyCardCap: rateLimits.integration_card_day_conn wins over the declared cap; the hourly rule is taken first and its refusal spends no daily token', async () => {
  const h = await hub({ rateLimits: { integration_card_day_conn: { capacity: 3, per_ms: 86_400_000 }, integration_card_conn: { capacity: 2, per_ms: 3_600_000 } } });
  try {
    const c = connect(h, probe('dc2', { dailyCardCap: 1000 }));
    assert.deepEqual(await cards(h, c, 3), [null, null, 'RATE_LIMITED'], 'the hourly rule refuses the third');
    h.clock.advance(3_600_000);
    // Daily: 3 - 2 spent = 1 left (the hourly refusal took none).
    assert.deepEqual(await cards(h, c, 2, 'b'), [null, 'RATE_LIMITED']);
  } finally { await h.close(); }
});

test('dailyCardCap: GitHub, the fake connector and any connector without it never spend the daily rule', async () => {
  assert.equal(github.dailyCardCap, undefined);
  assert.equal(fake.dailyCardCap, undefined);
  const h = await hub({ rateLimits: { integration_card_day_conn: { capacity: 1, per_ms: 86_400_000 }, integration_card_conn: { capacity: 50, per_ms: 3_600_000 } } });
  try {
    const c = connect(h, probe('nocap'));
    assert.deepEqual(await cards(h, c, 5), [null, null, null, null, null]);
    assert.equal(h.hub.limiter.buckets.has(`integration_card_day_conn|${c.id}`), false);
    const f = h.app.integrations.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'fake', external_id: 'fw' });
    const ctx = h.app.integrations.ctxFor(f.id);
    for (let i = 0; i < 3; i += 1) await ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, { request_id: `f-${i}`, title: 't' }));
    assert.equal(h.hub.limiter.buckets.has(`integration_card_day_conn|${f.id}`), false);
  } finally { await h.close(); }
});

// ── ctx.lastCreatedCard ───────────────────────────────────────────────────

test('ctx.lastCreatedCard: the card of this connection\'s newest integration_requests row, with archived; never a person\'s or another connection\'s card', async () => {
  const h = await hub();
  try {
    const c = connect(h, probe('lc1'));
    const ctx = h.app.integrations.ctxFor(c.id);
    assert.equal(ctx.lastCreatedCard(), null);
    await cards(h, c, 2);
    const ids = h.db.all('SELECT card_id FROM integration_requests WHERE connection_id = ? ORDER BY rowid', c.id).map((r) => r.card_id);
    assert.deepEqual(ctx.lastCreatedCard(), { id: ids[1], board_id: h.ids.board, archived: false });
    // A person's newer card and another connection's newer card change nothing.
    const alice = await h.login('alice');
    await h.createCard(alice);
    const other = connect(h, probe('lc1'), 'w2');
    await cards(h, other, 1, 'o');
    assert.equal(ctx.lastCreatedCard().id, ids[1]);
    const r = await h.api(alice, 'POST', `/api/cards/${ids[1]}/archive`, { request_id: randomUUID() });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(ctx.lastCreatedCard(), { id: ids[1], board_id: h.ids.board, archived: true }, 'the newest one, archived: not an older one');
  } finally { await h.close(); }
});

// ── showsWebhookUrl (G1) ──────────────────────────────────────────────────

test('showsWebhookUrl: a boolean, only for a token connector that takes webhooks', () => {
  assert.throws(() => probe('sw1', { showsWebhookUrl: 'yes' }), /showsWebhookUrl/);
  assert.throws(() => probe('sw2', { showsWebhookUrl: true, handleWebhook: undefined, verify: undefined }), /showsWebhookUrl/);
  assert.throws(() => probe('sw3', {
    showsWebhookUrl: true,
    connect: { kind: 'oauth', authorizeUrl: () => 'https://x.example/', exchange: async () => ({}) },
  }), /showsWebhookUrl/);
  assert.equal(probe('sw4', { showsWebhookUrl: true }).showsWebhookUrl, true);
  assert.equal(probe('sw5', { showsWebhookUrl: false }).showsWebhookUrl, false);
});

test('showsWebhookUrl: owners/admins get webhook_url in the list and the token answer; members never; available[] says shows_webhook_url', async () => {
  const h = await hub();
  try {
    h.app.integrations.register(probe('swa', { showsWebhookUrl: true }));
    h.app.integrations.register(probe('swb'));
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    const made = await h.api(alice, 'POST', '/api/integrations/swa/token', { token: 'one' });
    assert.equal(made.status, 200, made.text);
    const id = made.body.connection.id;
    assert.equal(made.body.connection.webhook_url, `${h.base}/integrations/${id}/webhook`);
    const other = await h.api(alice, 'POST', '/api/integrations/swb/token', { token: 'two' });
    assert.equal(Object.hasOwn(other.body.connection, 'webhook_url'), false, 'not for a connector without showsWebhookUrl');
    const list = await h.api(alice, 'GET', '/api/integrations');
    assert.equal(list.body.connections.find((c) => c.id === id).webhook_url, `${h.base}/integrations/${id}/webhook`);
    assert.equal(Object.hasOwn(list.body.connections.find((c) => c.provider === 'swb'), 'webhook_url'), false);
    assert.equal(list.body.available.find((c) => c.id === 'swa').shows_webhook_url, true);
    assert.equal(list.body.available.find((c) => c.id === 'swb').shows_webhook_url, false);
    const mine = await h.api(bob, 'GET', '/api/integrations');
    assert.equal(mine.status, 200);
    for (const c of mine.body.connections) assert.equal(Object.hasOwn(c, 'webhook_url'), false, 'a member never gets it');
    assert.ok(!mine.text.includes('/webhook'));
    // A member can't use the token route at all.
    assert.equal((await h.api(bob, 'POST', '/api/integrations/swa/token', { token: 'three' })).status, 403);
  } finally { await h.close(); }
});

// An Access hub (no dev Host fallback), with or without BOARD_PUBLIC_URL.
async function accessHub(publicUrl) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (email) => {
    const head = b({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = b({ iss: 'https://acme.cloudflareaccess.com', aud: ['aud-1'], exp: Math.floor(Date.now() / 1000) + 600, email });
    return `${head}.${body}.${rsaSign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  };
  const h = await startHub({ config: { auth: 'access', accessTeam: 'acme', accessAud: 'aud-1', publicUrl }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ keys: [jwk] }) }) });
  h.hub.setVaultKey(randomBytes(32));
  return { h, as: (email) => ({ 'cf-access-jwt-assertion': jwt(email) }) };
}

test('showsWebhookUrl: null when the hub has no public base (the list never fails over it); BOARD_PUBLIC_URL is the base when set', async () => {
  for (const [publicUrl, want] of [[null, () => null], ['https://hub.example/', (id) => `https://hub.example/integrations/${id}/webhook`]]) {
    const { h, as } = await accessHub(publicUrl);
    try {
      h.app.integrations.register(probe('swn', { showsWebhookUrl: true }));
      const made = await h.api(null, 'POST', '/api/integrations/swn/token', { token: 'one', request_id: randomUUID() }, as('alice@dev.local'));
      assert.equal(made.status, 200, made.text);
      const id = made.body.connection.id;
      assert.equal(made.body.connection.webhook_url, want(id));
      const list = await h.api(null, 'GET', '/api/integrations', null, as('alice@dev.local'));
      assert.equal(list.status, 200);
      assert.equal(list.body.connections.find((c) => c.id === id).webhook_url, want(id));
      const member = await h.api(null, 'GET', '/api/integrations', null, as('bob@dev.local'));
      assert.equal(Object.hasOwn(member.body.connections.find((c) => c.id === id), 'webhook_url'), false);
    } finally { await h.close(); }
  }
});
