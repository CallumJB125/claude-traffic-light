// Integrations security review, round 3: a ctx ends with its handler (M-A),
// a late success is never repeated and a stuck handler is capped (M-B),
// replay protection covers the signed body (M-C), the OAuth window and bind
// cookie contract (M-D, L-3), integration cards (L-1, L-2), migration 008
// orphans (L-4) and webhook ingress failure buckets (L-6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { generateKeyPairSync, sign as rsaSign, randomBytes, randomUUID } from 'node:crypto';
import { Api } from '../api.js';
import * as busModule from '../bus.js';
import { createIntegrations } from '../integrations/registry.js';
import { defineConnector } from '../integrations/connector.js';
import fake, { sign } from '../integrations/fake/index.js';
import * as ratelimit from '../ratelimit.js';
import { startHub } from './helpers.js';

const { createBus } = busModule;

async function hubWith(opts = {}) {
  const h = await startHub(opts);
  h.hub.setVaultKey(randomBytes(32));
  return h;
}

const probe = (id, over = {}) => defineConnector({
  id, name: `Probe ${id}`, scopes: [], secrets: [], hosts: ['api.probe.example'],
  connect: { kind: 'token', verifyToken: async () => ({ external_id: 'w1' }) },
  verify: ({ headers }) => (headers['x-ok'] === '1' ? { ok: true, dedupe_key: headers['x-id'] } : { ok: false, reason: 'nope' }),
  handleWebhook: async () => {},
  actions: { 'card.create': { default: 'auto' } },
  ...over,
});
const hookPost = (reg, conn, id, body = '{}') => reg.webhook(conn.id, { headers: { 'x-ok': '1', 'x-id': id }, rawBody: Buffer.from(body) });

const manualTimers = () => {
  const q = [];
  return { setTimeout: (fn, ms) => { const t = { fn, ms }; q.push(t); return t; }, clearTimeout: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); }, q };
};

// ── M-A ───────────────────────────────────────────────────────────────────

test('M-A: a ctx stashed by a webhook handler is dead once the handler returned 200', async () => {
  const h = await hubWith();
  try {
    let fetched = 0;
    const reg = createIntegrations({ hub: h.hub, api: new Api(h.hub), log: null, fetchImpl: async () => { fetched += 1; return new Response('{}'); } });
    let kept;
    reg.register(probe('stash', {
      handleWebhook: async ({ ctx }) => { kept = ctx; },
      systemEvents: ['pr_merged'],
      actions: { 'card.create': { default: 'auto' }, 'system.pr_merged': { default: 'auto' } },
    }));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'stash', external_id: 'w1' });
    assert.equal((await hookPost(reg, conn, 'd1')).status, 200);
    assert.equal(kept.signal.aborted, true, 'the signal aborts when the handler finishes');
    const before = h.db.get('SELECT COUNT(*) AS n FROM integration_audit').n;
    await assert.rejects(kept.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, { request_id: 'late', title: 'Late' })), /this handler has ended/);
    await assert.rejects(kept.fetch('https://api.probe.example/x'), /this handler has ended/);
    await assert.rejects(kept.system.event('pr_merged', { kind: 'pr', external_id: '1' }), /this handler has ended/);
    assert.equal(fetched, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM integration_audit').n, before, 'no audit row for a refused act()');
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'Late'").length, 0);
  } finally { await h.close(); }
});

test('M-A: a ctx stashed by a bus handler is dead once onEvent returned', async () => {
  const h = await hubWith();
  try {
    const bus = createBus({ db: h.db, timers: manualTimers() });
    h.hub.on('journal', () => bus.poke());
    const reg = createIntegrations({ hub: h.hub, api: new Api(h.hub), bus, log: null });
    let kept;
    reg.register(probe('stashbus', { consumes: ['card.transition'], onEvent: async (_row, ctx) => { kept = ctx; } }));
    reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'stashbus', external_id: 'w1' });
    await bus.settle();
    h.hub.journal({ board_id: h.ids.board, kind: 'card.transition', payload: {} });
    await bus.settle();
    assert.ok(kept, 'onEvent ran');
    assert.equal(kept.signal.aborted, true);
    await assert.rejects(kept.act('card.create', {}, async () => 1), /this handler has ended/);
  } finally { await h.close(); }
});

test('M-A: a call started without await inside run() settles before act() returns, never after the scope closed', async () => {
  const h = await hubWith();
  try {
    const reg = h.app.integrations;
    reg.register(probe('noawait'));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'noawait', external_id: 'w1' });
    const ctx = reg.ctxFor(conn.id);
    const count = () => h.db.all("SELECT id FROM cards WHERE title = 'Stray'").length;
    let stray;
    const out = await ctx.act('card.create', {}, async (s) => {
      stray = s.actAs(h.ids.alice).createCard(h.ids.board, { request_id: randomUUID(), title: 'Stray' });
      return 'returned early';
    });
    assert.equal(out.done, true);
    assert.equal(count(), 1, 'the stray call finished inside the scope');
    await new Promise((r) => setImmediate(r));
    assert.equal(count(), 1, 'and nothing lands after it');
    assert.equal((await stray).card.title, 'Stray');
    // A stray call that fails marks the act() failed.
    await assert.rejects(ctx.act('card.create', {}, async (s) => {
      s.actAs(h.ids.alice).createCard('no-such-board', { request_id: randomUUID(), title: 'Nope' }).catch(() => {});
    }));
    assert.equal(h.db.get("SELECT decision FROM integration_audit ORDER BY rowid DESC LIMIT 1").decision, 'failed');
  } finally { await h.close(); }
});

// ── M-B ───────────────────────────────────────────────────────────────────

async function slowBus(h, onEvent) {
  const timers = manualTimers();
  const bus = createBus({ db: h.db, timers });
  h.hub.on('journal', () => bus.poke());
  const reg = createIntegrations({ hub: h.hub, api: new Api(h.hub), bus, log: null, handlerTimeoutMs: 20 });
  reg.register(probe('slowbus', { consumes: ['card.transition'], onEvent }));
  const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'slowbus', external_id: 'w1' });
  await bus.settle();
  const name = `integration:slowbus:${conn.id}`;
  const retry = async () => { timers.q.shift().fn(); await bus.settle(); };
  const cursor = () => h.db.get('SELECT seq FROM bus_cursors WHERE consumer = ?', name).seq;
  return { bus, timers, retry, cursor, name };
}

test('M-B: a row whose timed-out handler later succeeds is not run again', async () => {
  const h = await hubWith();
  try {
    let calls = 0;
    let finish;
    const effects = [];
    const b = await slowBus(h, async (row) => {
      calls += 1;
      if (row.payload.n === 1 && calls === 1) await new Promise((r, j) => { finish = { r, j }; });
      effects.push(row.payload.n);
    });
    h.hub.journal({ board_id: h.ids.board, kind: 'card.transition', payload: { n: 1 } });
    const seq = h.db.get('SELECT MAX(seq) AS s FROM journal').s;
    await new Promise((r) => setTimeout(r, 60));
    await b.bus.settle();
    await b.retry();
    assert.equal(calls, 1, 'busy while the timed-out call runs');
    finish.r();
    await new Promise((r) => setImmediate(r));
    await b.retry();
    assert.equal(calls, 1, 'the late success counts: the row is not run a second time');
    assert.deepEqual(effects, [1]);
    assert.ok(b.cursor() >= seq);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM bus_dead_letters').n, 0);
    // The next row runs normally (the remembered seq was cleared on use).
    h.hub.journal({ board_id: h.ids.board, kind: 'card.transition', payload: { n: 2 } });
    await b.bus.settle();
    assert.deepEqual(effects, [1, 2]);
  } finally { await h.close(); }
});

test('M-B: a timed-out handler that later fails is retried', async () => {
  const h = await hubWith();
  try {
    let calls = 0;
    let finish;
    const b = await slowBus(h, async () => {
      calls += 1;
      if (calls === 1) await new Promise((r, j) => { finish = { r, j }; });
    });
    h.hub.journal({ board_id: h.ids.board, kind: 'card.transition', payload: { n: 1 } });
    await new Promise((r) => setTimeout(r, 60));
    await b.bus.settle();
    finish.j(new Error('late failure'));
    await new Promise((r) => setImmediate(r));
    await b.retry();
    assert.equal(calls, 2);
  } finally { await h.close(); }
});

test('M-B: a handler that never settles is dead-lettered after BUSY_DEAD_AFTER busy retries, and the connection carries on', async () => {
  const h = await hubWith();
  try {
    const seen = [];
    const b = await slowBus(h, async (row) => {
      seen.push(row.payload.n);
      if (row.payload.n === 1) await new Promise(() => {});
    });
    h.hub.journal({ board_id: h.ids.board, kind: 'card.transition', payload: { n: 1 } });
    await new Promise((r) => setTimeout(r, 60));
    await b.bus.settle();
    const cap = busModule.BUSY_DEAD_AFTER;
    assert.ok(Number.isInteger(cap) && cap > 0, 'the bus exports its busy cap');
    for (let i = 0; i < cap && b.timers.q.length; i += 1) await b.retry();
    const dl = h.db.get('SELECT * FROM bus_dead_letters WHERE consumer = ?', b.name);
    assert.ok(dl, 'dead-lettered');
    assert.match(dl.error, /handler_stuck/);
    h.hub.journal({ board_id: h.ids.board, kind: 'card.transition', payload: { n: 2 } });
    await b.bus.settle();
    assert.deepEqual(seen, [1, 2], 'the stuck call no longer blocks the next row');
  } finally { await h.close(); }
});

// ── M-C ───────────────────────────────────────────────────────────────────

test('M-C: a captured signed body replayed under new delivery ids is a duplicate: the handler runs once and webhook_conn is not spent', async () => {
  const h = await hubWith();
  try {
    const reg = h.app.integrations;
    let runs = 0;
    reg.register(defineConnector({ ...fake, id: 'fakecount', handleWebhook: (a) => { runs += 1; return fake.handleWebhook(a); } }));
    const v = await fake.connect.verifyToken({ token: 'fake_abcdef123456' });
    const conn = reg.createConnection({ ...v, orgId: h.ids.org, memberId: h.ids.alice, provider: 'fakecount' });
    h.hub.limiter.limits.webhook_conn = { capacity: 2, per_ms: 60_000 };
    const hook = (raw, delivery = randomUUID()) => fetch(`${h.base}/integrations/${conn.id}/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-fake-signature': sign('whsec_abcdef123456', Buffer.from(raw)), 'x-fake-delivery': delivery }, body: raw,
    });
    const raw = JSON.stringify({ event: 'issue.opened', issue: { id: 'I-1', title: 'Captured' } });
    const first = await hook(raw, 'delivery-0001');
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true });
    for (const d of ['delivery-0001', randomUUID(), randomUUID(), randomUUID()]) {
      const r = await hook(raw, d);
      assert.equal(r.status, 200, d);
      assert.deepEqual(await r.json(), { ok: true, duplicate: true });
    }
    assert.equal(runs, 1, 'the handler ran once');
    assert.equal(h.hub.limiter.peek('webhook_conn', conn.id).ok, true, 'replays spent nothing');
    const other = await hook(JSON.stringify({ event: 'issue.opened', issue: { id: 'I-2', title: 'New' } }));
    assert.equal(other.status, 200);
    assert.equal(runs, 2);
    assert.equal(h.hub.limiter.peek('webhook_conn', conn.id).ok, false, 'a new delivery spends');
    assert.equal((await hook(raw, randomUUID())).status, 200, 'a finished replay is answered even with the bucket empty');
  } finally { await h.close(); }
});

test('M-C: the connector dedupe key still dedupes a changed body; a failed delivery releases both keys', async () => {
  const h = await hubWith();
  try {
    const reg = h.app.integrations;
    let runs = 0;
    let fail = true;
    reg.register(probe('twokeys', { handleWebhook: async () => { runs += 1; if (fail) throw new Error('boom'); } }));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'twokeys', external_id: 'w1' });
    assert.equal((await hookPost(reg, conn, 'd1', '{"a":1}')).status, 500);
    fail = false;
    assert.equal((await hookPost(reg, conn, 'd1', '{"a":1}')).status, 200, 'the retry runs');
    assert.deepEqual((await hookPost(reg, conn, 'd1', '{"a":2}')).body, { ok: true, duplicate: true }, 'same delivery id, other body');
    assert.deepEqual((await hookPost(reg, conn, 'd2', '{"a":1}')).body, { ok: true, duplicate: true }, 'same body, other delivery id');
    assert.equal(runs, 2);
  } finally { await h.close(); }
});

// ── L-6 ───────────────────────────────────────────────────────────────────

test('L-6: an oversized body (413) spends the failure bucket', async () => {
  const h = await hubWith();
  try {
    const reg = h.app.integrations;
    reg.register(probe('big'));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'big', external_id: 'w1' });
    h.hub.limiter.limits.webhook_fail_ip = { capacity: 1, per_ms: 60_000 };
    const u = new URL(`${h.base}/integrations/${conn.id}/webhook`);
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-length': String(2 * 1024 * 1024) } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => {});
      req.write(Buffer.alloc(2 * 1024 * 1024, 0x20));
      setTimeout(() => reject(new Error('no answer')), 3000).unref();
    });
    assert.equal(status, 413);
    const next = await fetch(u, { method: 'POST', headers: { 'x-ok': '1', 'x-id': 'd1' }, body: '{}' });
    assert.equal(next.status, 429);
  } finally { await h.close(); }
});

test('L-6: the webhook failure bucket keys an IPv6 client on its /64', () => {
  const key = ratelimit.failBucketKey;
  assert.equal(typeof key, 'function');
  assert.equal(key('2001:db8:1:2:aaaa::1'), key('2001:db8:1:2:ffff:ffff:ffff:ffff'));
  assert.equal(key('2001:0db8:0001:0002::9'), key('2001:db8:1:2::1'));
  assert.notEqual(key('2001:db8:1:2::1'), key('2001:db8:1:3::1'));
  assert.equal(key('::1'), key('::2'));
  assert.equal(key('203.0.113.7'), '203.0.113.7');
  assert.notEqual(key('203.0.113.7'), key('203.0.113.8'));
  assert.equal(key('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(key('not-an-ip'), 'not-an-ip');
});

// ── M-D / L-3 ─────────────────────────────────────────────────────────────

const oauthProbe = defineConnector({
  id: 'oprobe', name: 'OAuth probe', scopes: ['read'], secrets: ['access_token'], hosts: ['oprobe.example'],
  connect: {
    kind: 'oauth',
    authorizeUrl: ({ state }) => `https://oprobe.example/authorize?state=${encodeURIComponent(state)}`,
    exchange: async () => ({ external_id: 'ws-1', display_name: 'Probe workspace', scopes: ['read'], secrets: { access_token: 't' } }),
  },
});

async function httpsHub() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (email) => {
    const head = b({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = b({ iss: 'https://acme.cloudflareaccess.com', aud: ['aud-1'], exp: Math.floor(Date.now() / 1000) + 600, email });
    return `${head}.${body}.${rsaSign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  };
  const h = await hubWith({ config: { auth: 'access', accessTeam: 'acme', accessAud: 'aud-1', publicUrl: 'https://hub.example' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ keys: [jwk] }) }) });
  return { h, as: (email) => ({ 'cf-access-jwt-assertion': jwt(email) }) };
}

test('L-3: on an https hub the bind cookie is __Host-board_int_<provider>, Path=/, Secure; the callback reads only that name', async () => {
  const { h, as } = await httpsHub();
  try {
    const reg = h.app.integrations;
    reg.register(oauthProbe);
    const start = await h.api(null, 'POST', '/api/integrations/oprobe/start', { request_id: randomUUID() }, as('alice@dev.local'));
    assert.equal(start.status, 200, start.text);
    const cookie = start.headers.get('set-cookie');
    assert.match(cookie, /^__Host-board_int_oprobe=[A-Za-z0-9_-]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600; Secure$/);
    assert.equal(cookie.split(';')[0].split('=')[1], start.body.bind);
    const state = new URL(start.body.url).searchParams.get('state');
    const cb = (c) => fetch(`${h.base}/integrations/oprobe/callback?${new URLSearchParams({ state, code: 'x' })}`, { headers: { cookie: c } });
    const plain = await cb(`board_int_oprobe=${start.body.bind}`);
    assert.equal(plain.status, 400, 'the plain name (settable from http or a sibling host) is not honoured on https');
    const ok = await cb(`__Host-board_int_oprobe=${start.body.bind}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('set-cookie'), '__Host-board_int_oprobe=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure');
    assert.equal(reg.list(h.ids.org).length, 1);
  } finally { await h.close(); }
});

test('L-3: an http (dev) hub keeps board_int_<provider> on Path=/integrations/ without Secure', async () => {
  const h = await hubWith();
  try {
    h.app.integrations.register(oauthProbe);
    const alice = await h.login('alice');
    const start = await h.api(alice, 'POST', '/api/integrations/oprobe/start', { request_id: randomUUID() });
    assert.match(start.headers.get('set-cookie'), /^board_int_oprobe=[A-Za-z0-9_-]+; HttpOnly; SameSite=Lax; Path=\/integrations\/; Max-Age=600$/);
    const state = new URL(start.body.url).searchParams.get('state');
    const cb = (c) => fetch(`${h.base}/integrations/oprobe/callback?${new URLSearchParams({ state, code: 'x' })}`, { headers: { cookie: c } });
    assert.equal((await cb(`__Host-board_int_oprobe=${start.body.bind}`)).status, 400);
    const ok = await cb(`board_int_oprobe=${start.body.bind}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('set-cookie'), 'board_int_oprobe=; HttpOnly; SameSite=Lax; Path=/integrations/; Max-Age=0');
  } finally { await h.close(); }
});

// ── L-1 / L-2 ─────────────────────────────────────────────────────────────

test('L-1/L-2: a card an integration creates has no budget and carries via:<provider> (a connector cannot claim another)', async () => {
  const h = await hubWith();
  try {
    const reg = h.app.integrations;
    reg.register(probe('tracker'));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'tracker', external_id: 'w1' });
    const ctx = reg.ctxFor(conn.id);
    const { card } = (await ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, {
      request_id: randomUUID(), title: 'From the tracker', budget_usd: 500, labels: ['bug', 'via:slack'],
    }))).result;
    const row = h.db.get('SELECT budget_cents, labels FROM cards WHERE id = ?', card.id);
    assert.equal(row.budget_cents, null, 'no budget from an integration');
    assert.deepEqual(JSON.parse(row.labels), ['bug', 'via:tracker']);
    assert.deepEqual(card.labels, ['bug', 'via:tracker']);
    const bare = (await ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, { request_id: randomUUID(), title: 'No labels' }))).result.card;
    assert.deepEqual(bare.labels, ['via:tracker']);
    // A person's own card is untouched.
    const alice = await h.login('alice');
    const mine = await h.api(alice, 'POST', `/api/boards/${h.ids.board}/cards`, { request_id: randomUUID(), title: 'Mine', budget_usd: 5 });
    assert.deepEqual(mine.body.card.labels, []);
    assert.equal(h.db.get('SELECT budget_cents FROM cards WHERE id = ?', mine.body.card.id).budget_cents, 500);
  } finally { await h.close(); }
});
