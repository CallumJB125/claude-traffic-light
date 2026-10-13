// Integrations security re-review regressions: the actAs allowlist and
// untrusted integration comments (HIGH-1), the act() scope on the returned
// handle (HIGH-2), the mandatory OAuth browser binding (HIGH-3), who an
// integration may act as (M-1), webhook rate-limit order (M-2), handler
// timeouts (L-a) and the journal sequence across migration 008 (L-c).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Api } from '../api.js';
import { createBus } from '../bus.js';
import { createIntegrations } from '../integrations/registry.js';
import { defineConnector } from '../integrations/connector.js';
import fake, { sign } from '../integrations/fake/index.js';
import { migrate, loadMigrations } from '../../shared/migrate.js';
import { startHub } from './helpers.js';

async function setup() {
  const h = await startHub();
  h.hub.setVaultKey(randomBytes(32));
  return { h, reg: h.app.integrations };
}

async function connectFake(h, reg) {
  const v = await fake.connect.verifyToken({ token: 'fake_abcdef123456' });
  return reg.createConnection({ ...v, orgId: h.ids.org, memberId: h.ids.alice, provider: 'fake' });
}

const probe = (id, over = {}) => defineConnector({
  id, name: `Probe ${id}`, scopes: [], secrets: [], hosts: ['api.probe.example'],
  connect: { kind: 'token', verifyToken: async () => ({ external_id: 'w1' }) },
  verify: ({ headers }) => (headers['x-ok'] === '1' ? { ok: true, dedupe_key: headers['x-id'] } : { ok: false, reason: 'nope' }),
  handleWebhook: async () => {},
  actions: { 'card.create': { default: 'auto' }, 'card.approve': { default: 'ask' } },
  ...over,
});
const hookPost = (reg, conn, id) => reg.webhook(conn.id, { headers: { 'x-ok': '1', 'x-id': id }, rawBody: Buffer.from('{}') });

const manualTimers = () => {
  const q = [];
  return { setTimeout: (fn, ms) => { const t = { fn, ms }; q.push(t); return t; }, clearTimeout: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); }, q };
};

async function cardInReview(h, ctx) {
  const { card } = (await ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, { request_id: randomUUID(), title: 'Review me' }))).result;
  h.db.run("UPDATE cards SET repo_id = ?, run_state = 'in_review', column_name = 'in_review' WHERE id = ?", h.ids.repo, card.id);
  return card.id;
}

// ── HIGH-1 ────────────────────────────────────────────────────────────────

test('HIGH-1: actAs allows only cancel, stop and approve_done; never a paid run, a hand-over or an answer', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const ctx = reg.ctxFor(conn.id);
    const cardId = await cardInReview(h, ctx);
    const denied = {
      request_changes: { comment: 'please redo it' },
      hand_over: { target: { kind: 'queue' } },
      take_over: {}, take_over_myself: {},
      answer: { ask_id: 'a1', answer: 'yes' },
      dispatch: {}, retry: {}, take_over_with_claude: {},
    };
    for (const [action, body] of Object.entries(denied)) {
      await assert.rejects(ctx.act('card.create', { card_id: cardId }, (s) => s.actAs(h.ids.alice).action(cardId, action, { request_id: randomUUID(), ...body })),
        (e) => e.code === 'POLICY_DENIED', action);
    }
    const memberTarget = { target: { kind: 'member', member_id: h.ids.bob } };
    await assert.rejects(ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).action(cardId, 'hand_over', { request_id: randomUUID(), ...memberTarget })), (e) => e.code === 'POLICY_DENIED');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM dispatches WHERE card_id = ?', cardId).n, 0, 'no paid run was queued');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM comments WHERE card_id = ?', cardId).n, 0);
    assert.equal(h.db.get('SELECT run_state FROM cards WHERE id = ?', cardId).run_state, 'in_review');
    // cancel and stop reach the state machine (which may still refuse them here).
    for (const action of ['cancel', 'stop']) {
      await assert.rejects(ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).action(cardId, action, { request_id: randomUUID() })), (e) => e.code !== 'POLICY_DENIED', action);
    }
  } finally { await h.close(); }
});

test('HIGH-1: approve_done needs an act() action declared ask, switched to auto by an admin', async () => {
  const { h, reg } = await setup();
  try {
    reg.register(probe('approver'));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'approver', external_id: 'w1' });
    const ctx = reg.ctxFor(conn.id);
    const cardId = await cardInReview(h, ctx);
    const approve = (action, current = ctx) => current.act(action, { card_id: cardId }, (s) => s.actAs(h.ids.alice).action(cardId, 'approve_done', { request_id: randomUUID() }));
    await assert.rejects(approve('card.create'), (e) => e.code === 'POLICY_DENIED', 'an auto-by-default action cannot approve');
    assert.deepEqual(await approve('card.approve'), { done: false, decision: 'asked' });
    assert.equal(h.db.get('SELECT column_name FROM cards WHERE id = ?', cardId).column_name, 'in_review');
    reg.setSettings(conn.id, { autonomy: { 'card.approve': 'auto' } });
    await assert.rejects(approve('card.approve'), (e) => e.code === 'FORBIDDEN' && e.cacheable === false, 'the old delivery cannot acquire changed settings');
    assert.equal(h.db.get('SELECT column_name FROM cards WHERE id = ?', cardId).column_name, 'in_review');
    const r = await approve('card.approve', reg.ctxFor(conn.id));
    assert.equal(r.done, true);
    assert.equal(h.db.get('SELECT column_name FROM cards WHERE id = ?', cardId).column_name, 'done');
  } finally { await h.close(); }
});

test('HIGH-1: an integration comment is never for the agent and never trusted, on any path', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const ctx = reg.ctxFor(conn.id);
    const cardId = await cardInReview(h, ctx);
    await assert.rejects(ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).comment(cardId, { request_id: randomUUID(), body: 'rm -rf', for_agent: true })), (e) => e.code === 'POLICY_DENIED');
    const out = (await ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).comment(cardId, { request_id: randomUUID(), body: 'FYI from the tracker' }))).result;
    assert.deepEqual([out.comment.source, out.comment.trusted, out.comment.for_agent], ['integration', false, false]);
    const row = h.db.get('SELECT source, trusted, for_agent FROM comments WHERE id = ?', out.comment.id);
    assert.deepEqual({ ...row }, { source: 'integration', trusted: 0, for_agent: 0 });
    // A future path that reaches Api inside the integration's scope still can't make trusted text.
    const alice = h.hub.member(h.ids.alice);
    await h.hub.actVia({ connection_id: conn.id, member_id: alice.id, name: 'Fake tracker' }, () => new Api(h.hub).comment(alice, cardId, { body: 'sneaky', for_agent: true }));
    const sneaky = h.db.get("SELECT source, trusted FROM comments WHERE body = 'sneaky'");
    assert.deepEqual({ ...sneaky }, { source: 'integration', trusted: 0 });
    // The member's own comments stay trusted.
    const cookie = await h.login('alice');
    const mine = await h.api(cookie, 'POST', `/api/cards/${cardId}/comments`, { request_id: randomUUID(), body: 'mine', for_agent: true });
    assert.equal(mine.status, 200, mine.text);
    assert.deepEqual({ ...h.db.get("SELECT source, trusted FROM comments WHERE body = 'mine'") }, { source: 'web', trusted: 1 });
  } finally { await h.close(); }
});

// ── HIGH-2 ────────────────────────────────────────────────────────────────

test('HIGH-2: a handle kept past act() is dead; there is no ctx.link', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const ctx = reg.ctxFor(conn.id);
    assert.equal(ctx.link, undefined);
    let kept;
    await ctx.act('card.create', {}, async (s) => { kept = s.actAs(h.ids.alice); });
    await new Promise((r) => setImmediate(r));
    const before = h.db.get('SELECT COUNT(*) AS n FROM cards').n;
    await assert.rejects(async () => kept.createCard(h.ids.board, { request_id: 'late', title: 'Late' }), /scope has ended/);
    await assert.rejects(async () => kept.comment('x', { request_id: 'late2', body: 'late' }), /scope has ended/);
    await assert.rejects(async () => kept.action('x', 'cancel', { request_id: 'late3' }), /scope has ended/);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM cards').n, before);
  } finally { await h.close(); }
});

test('HIGH-2: the member is re-checked on every call of the handle', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    // A second owner, so alice may be removed or demoted (members_keep_an_owner, D59).
    h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", h.ids.bob);
    const ctx = reg.ctxFor(conn.id);
    await assert.rejects(ctx.act('card.create', {}, async (s) => {
      const me = s.actAs(h.ids.alice);
      await me.createCard(h.ids.board, { request_id: 'one', title: 'First' });
      h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', h.hub.iso(), h.ids.alice);
      await me.createCard(h.ids.board, { request_id: 'two', title: 'Second' });
    }), (e) => e.code === 'ACTOR_UNAVAILABLE');
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'Second'").length, 0);
    h.db.run("UPDATE members SET removed_at = NULL, role = 'owner' WHERE id = ?", h.ids.alice);
    await assert.rejects(ctx.act('card.create', {}, async (s) => {
      const me = s.actAs(h.ids.alice);
      h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", h.ids.alice);
      await me.createCard(h.ids.board, { request_id: 'three', title: 'Third' });
    }), (e) => e.code === 'ACTOR_UNAVAILABLE');
  } finally { await h.close(); }
});

// ── M-1 ───────────────────────────────────────────────────────────────────

test('M-1: acts only as the connecting member or one linked by external identity, with at most member rights', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const ctx = reg.ctxFor(conn.id);
    await ctx.act('card.create', {}, async (s) => {
      assert.throws(() => s.actAs(h.ids.bob), (e) => e.code === 'FORBIDDEN');
      assert.equal(s.actAs(h.ids.alice).member.role, 'member', 'an owner is capped at member');
    });
    // D98: a link names its connection, and one in another workspace can't even be written.
    assert.throws(() => h.db.run("INSERT INTO external_identities (provider, workspace_id, subject, member_id, connection_id, verified_via, linked_at) VALUES ('fake', 'other-ws', 'U1', ?, ?, 'oauth_link', ?)", h.ids.bob, conn.id, h.hub.iso()), /cross-team reference/);
    await ctx.act('card.create', {}, async (s) => { assert.throws(() => s.actAs(h.ids.bob), (e) => e.code === 'FORBIDDEN', 'a link in another workspace does not count'); });
    h.db.run("INSERT INTO external_identities (provider, workspace_id, subject, member_id, connection_id, verified_via, linked_at) VALUES ('fake', ?, 'U2', ?, ?, 'oauth_link', ?)", conn.external_id, h.ids.bob, conn.id, h.hub.iso());
    // A linked member is acted as only for its own subject, never by an act() without one.
    await ctx.act('card.create', {}, async (s) => { assert.throws(() => s.actAs(h.ids.bob), (e) => e.code === 'FORBIDDEN'); });
    await ctx.act('card.create', { subject: 'U2' }, async (s) => { assert.equal(s.actAs(h.ids.bob).member.id, h.ids.bob); });
    // What the Api sees is the capped member.
    let seen;
    const spyApi = new Api(h.hub);
    const createCard = spyApi.createCard.bind(spyApi);
    spyApi.createCard = async (member, ...args) => { seen = member; return createCard(member, ...args); };
    const spy = createIntegrations({ hub: h.hub, api: spyApi, log: null });
    spy.register(fake);
    await spy.ctxFor(conn.id).act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, { request_id: randomUUID(), title: 't' }));
    assert.equal(seen.role, 'member');
    assert.equal(h.hub.member(h.ids.alice).role, 'owner', 'the member row is untouched');
  } finally { await h.close(); }
});

// ── HIGH-3 ────────────────────────────────────────────────────────────────

const fakeOauth = defineConnector({
  id: 'fake-oauth', name: 'Fake OAuth', scopes: ['read'], secrets: ['access_token'], hosts: ['fake-oauth.example'],
  connect: {
    kind: 'oauth',
    authorizeUrl: ({ state }) => `https://fake-oauth.example/authorize?state=${encodeURIComponent(state)}`,
    async exchange({ query }) {
      if (query.get('code') !== 'good-code') throw new Error('bad code');
      return { external_id: 'ws-victim', display_name: 'Victim workspace', scopes: ['read'], secrets: { access_token: 'tok_victim' } };
    },
  },
});

test('HIGH-3: the callback needs the start cookie; a consenting browser without it connects nothing; /complete is gone', async () => {
  const { h, reg } = await setup();
  try {
    let exchanged = 0;
    const real = fakeOauth.connect.exchange;
    const { name, scopes, secrets, hosts } = fakeOauth;
    reg.register(defineConnector({ id: 'counted', name, scopes, secrets, hosts, connect: { ...fakeOauth.connect, exchange: (a) => { exchanged += 1; return real(a); } } }));
    const alice = await h.login('alice');
    const start = await h.api(alice, 'POST', '/api/integrations/counted/start', { request_id: randomUUID() });
    assert.equal(start.status, 200, start.text);
    assert.deepEqual(Object.keys(start.body).sort(), ['bind', 'url']);
    assert.match(start.body.bind, /^[A-Za-z0-9_-]{16,64}$/);
    const cookie = start.headers.get('set-cookie');
    assert.match(cookie, /^board_int_counted=[A-Za-z0-9_-]+; HttpOnly; SameSite=Lax; Path=\/integrations\/; Max-Age=600$/);
    assert.equal(cookie.split(';')[0].split('=')[1], start.body.bind);
    const state = new URL(start.body.url).searchParams.get('state');
    const cb = (headers = {}) => fetch(`${h.base}/integrations/counted/callback?${new URLSearchParams({ state, code: 'good-code' })}`, { headers });
    // The victim consents in their own browser: no cookie → refused before the exchange.
    const victim = await cb();
    assert.equal(victim.status, 400);
    const page = await victim.text();
    assert.match(page, /Open this link in the window Plexiform opened\. Start again\./);
    assert.ok(!page.includes('pending'));
    assert.equal(exchanged, 0, 'no provider code was redeemed');
    assert.equal(reg.list(h.ids.org).length, 0);
    assert.equal((await cb({ cookie: 'board_int_counted=not-the-bind' })).status, 400);
    assert.equal((await h.api(alice, 'POST', '/api/integrations/counted/complete', { request_id: randomUUID(), complete_token: 'x'.repeat(32) })).status, 404);
    assert.equal(reg.oauthComplete, undefined);
    // The starting browser (or the desktop window given the bind) connects.
    const ok = await cb({ cookie: `board_int_counted=${start.body.bind}` });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /data-connect="ok"/);
    assert.equal(reg.list(h.ids.org).length, 1);
  } finally { await h.close(); }
});

// ── M-2 ───────────────────────────────────────────────────────────────────

test('M-2: unauthenticated spam never spends the connection bucket; only verified deliveries do', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const lim = h.hub.limiter.limits;
    lim.webhook_fail_ip = { capacity: 100, per_ms: 60_000 };
    lim.webhook_conn = { capacity: 3, per_ms: 60_000 };
    // Distinct bodies: an identical signed body is a duplicate (round 3, M-C).
    const hook = (sig, raw = JSON.stringify({ event: 'noop' })) => fetch(`${h.base}/integrations/${conn.id}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fake-signature': sig, 'x-fake-delivery': randomUUID() }, body: raw });
    for (let i = 0; i < 10; i += 1) assert.equal((await hook('sha256=00')).status, 401);
    const good = (n) => { const raw = JSON.stringify({ event: 'noop', n }); return hook(sign('whsec_abcdef123456', Buffer.from(raw)), raw); };
    for (let i = 0; i < 3; i += 1) assert.equal((await good(i)).status, 200, `delivery ${i}`);
    const over = await good(3);
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers.get('retry-after')) >= 1);
  } finally { await h.close(); }
});

test('M-2: a (connection, IP) pair has at most 4 body reads in flight (hardening M-1): the next post gets 503 before its body is read', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const u = new URL(`${h.base}/integrations/${conn.id}/webhook`);
    const held = Array.from({ length: 4 }, () => {
      const r = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-length': String(500_000) } });
      r.on('error', () => {});
      r.write('{"partial":');
      return r;
    });
    await new Promise((r) => setTimeout(r, 100));
    const res = await new Promise((resolve, reject) => {
      const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-length': String(500_000) } }, (r) => { r.resume(); resolve(r); });
      req.on('error', reject);
      req.write('{"partial":');
      setTimeout(() => reject(new Error('the hub waited for the body')), 2000).unref();
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['retry-after'], '1');
    for (const r of held) r.destroy();
  } finally { await h.close(); }
});

test('M-2: RateLimiter.peek never spends a token', async () => {
  const { h } = await setup();
  try {
    const l = h.hub.limiter;
    l.limits.webhook_fail_ip = { capacity: 1, per_ms: 60_000 };
    for (let i = 0; i < 5; i += 1) assert.equal(l.peek('webhook_fail_ip', 'ip').ok, true);
    assert.equal(l.take('webhook_fail_ip', 'ip').ok, true);
    const p = l.peek('webhook_fail_ip', 'ip');
    assert.equal(p.ok, false);
    assert.ok(p.retry_after_ms > 0);
  } finally { await h.close(); }
});

// ── L-a ───────────────────────────────────────────────────────────────────

test('L-a: a timed-out webhook handler keeps its lease, sees its signal abort, and settles the row when it ends', async () => {
  const h = await startHub();
  try {
    h.hub.setVaultKey(randomBytes(32));
    const reg = createIntegrations({ hub: h.hub, api: new Api(h.hub), log: null, handlerTimeoutMs: 30 });
    let calls = 0;
    let release;
    let signal;
    reg.register(probe('slow', {
      handleWebhook: async ({ ctx }) => { calls += 1; signal = ctx.signal; await new Promise((r) => { release = r; }); },
    }));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'slow', external_id: 'w1' });
    assert.equal((await hookPost(reg, conn, 'd1')).status, 500);
    assert.equal(signal.aborted, true);
    const row = () => h.db.get("SELECT state FROM inbound_dedupe WHERE provider = 'slow'");
    assert.equal(row().state, 'processing', 'the lease stays while the handler may still run');
    const retry = await hookPost(reg, conn, 'd1');
    assert.equal(retry.status, 503);
    assert.equal(retry.body.in_progress, true);
    assert.equal(calls, 1, 'no concurrent retry');
    release();
    await new Promise((r) => setImmediate(r));
    assert.equal(row().state, 'done');
  } finally { await h.close(); }
});

test('L-a: every actAs mutation needs a request_id (D8 dedupes a retried handler)', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const ctx = reg.ctxFor(conn.id);
    await assert.rejects(ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, { title: 'No id' })), (e) => e.code === 'VALIDATION');
    await assert.rejects(ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).comment('x', { body: 'No id' })), (e) => e.code === 'VALIDATION');
    await assert.rejects(ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).action('x', 'cancel', {})), (e) => e.code === 'VALIDATION');
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'No id'").length, 0);
  } finally { await h.close(); }
});

test('L-a: the bus never re-runs a row while its timed-out handler is still running', async () => {
  const h = await startHub();
  try {
    h.hub.setVaultKey(randomBytes(32));
    const timers = manualTimers();
    const bus = createBus({ db: h.db, timers });
    h.hub.on('journal', () => bus.poke());
    const reg = createIntegrations({ hub: h.hub, api: new Api(h.hub), bus, log: null, handlerTimeoutMs: 20 });
    let calls = 0;
    let release;
    const seen = [];
    reg.register(probe('slowbus', {
      consumes: ['card.transition'],
      onEvent: async (row) => {
        calls += 1;
        if (calls === 1) await new Promise((r) => { release = r; });
        seen.push(row.payload.n);
      },
    }));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'slowbus', external_id: 'w1' });
    await bus.settle();
    h.hub.journal({ board_id: h.ids.board, kind: 'card.transition', payload: { n: 1 } });
    await new Promise((r) => setTimeout(r, 60));
    await bus.settle();
    assert.equal(calls, 1);
    timers.q.shift().fn();
    await bus.settle();
    assert.equal(calls, 1, 'still running: not invoked again');
    const hh = bus.health().find((x) => x.consumer === `integration:slowbus:${conn.id}`);
    assert.match(hh.last_error.message, /handler_busy/);
    release();
    await new Promise((r) => setImmediate(r));
    timers.q.shift().fn();
    await bus.settle();
    assert.equal(calls, 1, 'it ended well: the row is not run again (round 3, M-B)');
    assert.deepEqual(seen, [1]);
  } finally { await h.close(); }
});

// ── L-c ───────────────────────────────────────────────────────────────────

test('L-c: migration 008 keeps the journal sequence even when it is above MAX(seq), and keeps comments', () => {
  const all = loadMigrations();
  for (const [rows, forced] of [[3, 5000], [0, 700], [0, null]]) {
    const db = new DatabaseSync(':memory:');
    migrate(db, { migrations: all.filter((m) => m.version <= 7) });
    const t = new Date().toISOString();
    for (let i = 0; i < rows; i += 1) db.prepare("INSERT INTO journal (at_hub, actor_kind, kind) VALUES (?, 'system', 'x')").run(t);
    if (forced != null) {
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'journal'").run();
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('journal', ?)").run(forced);
    }
    if (rows) {
      db.exec(`INSERT INTO orgs VALUES ('o', 'O', '${t}');
        INSERT INTO members (id, org_id, github_id, github_login, display_name, role, created_at) VALUES ('m', 'o', -1, 'a', 'A', 'owner', '${t}');
        INSERT INTO boards (id, org_id, name, key_prefix) VALUES ('b', 'o', 'B', 'B');
        INSERT INTO cards (id, board_id, key, title, created_by, created_at, updated_at, state_since) VALUES ('c', 'b', 'B-1', 'T', 'm', '${t}', '${t}', '${t}');
        INSERT INTO comments (id, card_id, author_member_id, source, trusted, body, created_at) VALUES ('k1', 'c', 'm', 'web', 1, 'first', '${t}');
        INSERT INTO comments (id, card_id, author_member_id, source, trusted, body, reply_to, created_at) VALUES ('k2', 'c', 'm', 'web', 1, 'reply', 'k1', '${t}');`);
    }
    migrate(db, { migrations: all });
    if (rows) {
      assert.deepEqual(db.prepare('SELECT rowid AS r, id, reply_to FROM comments ORDER BY rowid').all().map((x) => ({ ...x })), [{ r: 1, id: 'k1', reply_to: null }, { r: 2, id: 'k2', reply_to: 'k1' }]);
      db.prepare("INSERT INTO comments (id, card_id, author_member_id, source, trusted, body, created_at) VALUES ('k3', 'c', 'm', 'integration', 0, 'x', ?)").run(t);
      assert.throws(() => db.prepare("INSERT INTO comments (id, card_id, author_member_id, source, trusted, body, reply_to, created_at) VALUES ('k4', 'c', 'm', 'web', 1, 'x', 'nope', ?)").run(t), /FOREIGN KEY/);
    }
    const seq = Number(db.prepare("INSERT INTO journal (at_hub, actor_kind, kind) VALUES (?, 'integration', 'y') RETURNING seq").get(t).seq);
    assert.equal(seq, (forced ?? rows) + 1, `rows=${rows} forced=${forced}`);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE name = '_s'").get().n, 0);
    db.close();
  }
});
