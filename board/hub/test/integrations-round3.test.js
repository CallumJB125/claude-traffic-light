// Integrations security review, round 3: a ctx ends with its handler (M-A),
// a late success is never repeated and a stuck handler is capped (M-B),
// replay protection covers the signed body (M-C), the OAuth window and bind
// cookie contract (M-D, L-3), integration cards (L-1, L-2), migration 008
// orphans (L-4) and webhook ingress failure buckets (L-6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Api } from '../api.js';
import * as busModule from '../bus.js';
import { createIntegrations } from '../integrations/registry.js';
import { defineConnector } from '../integrations/connector.js';
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
