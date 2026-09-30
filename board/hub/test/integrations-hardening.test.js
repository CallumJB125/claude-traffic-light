// Integrations hardening (security reviews of webhook ingress, registry,
// journal and vault): pre-verify webhook limits that unsigned traffic can't
// turn against a verified delivery (M-1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { defineConnector } from '../integrations/connector.js';
import { startHub } from './helpers.js';

// Access mode trusts CF-Connecting-IP from the loopback peer, so a test can
// speak from any client address.
async function accessHub(config = {}) {
  const h = await startHub({
    config: { auth: 'access', accessTeam: 'acme', accessAud: 'aud-1', ...config },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }) }),
  });
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

const connect = (h, id, over) => {
  h.app.integrations.register(probe(id, over));
  return h.app.integrations.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: id, external_id: 'w1' });
};

// A post whose body never finishes (status stays null until the hub answers).
function slow(h, conn, ip) {
  const u = new URL(`${h.base}/integrations/${conn.id}/webhook`);
  const out = { status: null };
  out.answered = new Promise((resolve) => {
    out.req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-length': String(500_000), 'cf-connecting-ip': ip } }, (res) => {
      res.resume();
      out.status = res.statusCode;
      resolve(res.statusCode);
    });
  });
  out.req.on('error', () => {});
  out.req.write('{"partial":');
  return out;
}

const deliver = (h, conn, ip, { ok = true, id = randomUUID() } = {}) => fetch(`${h.base}/integrations/${conn.id}/webhook`, {
  method: 'POST', headers: { 'cf-connecting-ip': ip, ...(ok ? { 'x-ok': '1', 'x-id': id } : {}) }, body: JSON.stringify({ n: randomUUID() }),
});
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

// ── M-1 ───────────────────────────────────────────────────────────────────

test('M-1: failures from an address never get its verified delivery refused before the signature is checked', async () => {
  const h = await accessHub();
  try {
    const conn = connect(h, 'm1a');
    h.hub.limiter.limits.webhook_fail_ip = { capacity: 2, per_ms: 60_000 };
    for (const want of [401, 401, 429]) assert.equal((await deliver(h, conn, '198.51.100.7', { ok: false })).status, want);
    const held = slow(h, conn, '198.51.100.7');
    await tick();
    assert.equal((await deliver(h, conn, '198.51.100.7')).status, 200, 'the same address, over its failure budget, a read in flight: still verified and run');
    held.req.destroy();
  } finally { await h.close(); }
});

test('M-1: an unsigned flood from one address holds at most its pair cap; a verified delivery from another address runs', async () => {
  const h = await accessHub({ webhookReads: { perPair: 2, perIp: 3, perConn: 4 } });
  try {
    const conn = connect(h, 'm1b');
    const flood = Array.from({ length: 6 }, () => slow(h, conn, '203.0.113.9'));
    await tick(300);
    assert.deepEqual(flood.map((f) => f.status).sort(), [503, 503, 503, 503, null, null], 'two reads in flight, the rest refused unread');
    const refused = await Promise.race([flood.find((f) => f.status === 503).answered, tick(10)]);
    assert.equal(refused, 503);
    assert.equal((await deliver(h, conn, '192.0.2.44')).status, 200);
    for (const f of flood) f.req.destroy();
  } finally { await h.close(); }
});

test('M-1: in-flight reads are capped per address across connections and per connection; an address that verified recently skips the connection cap', async () => {
  const h = await accessHub({ webhookReads: { perPair: 1, perIp: 2, perConn: 3 } });
  try {
    const a = connect(h, 'm1c');
    const b = connect(h, 'm1d');
    const c = connect(h, 'm1e');
    // Per address, over every connection.
    const one = [slow(h, a, '203.0.113.1'), slow(h, b, '203.0.113.1'), slow(h, c, '203.0.113.1')];
    await tick(300);
    assert.deepEqual(one.map((x) => x.status), [null, null, 503]);
    for (const x of one) x.req.destroy();
    await tick();
    // The provider's address delivered before; then fresh addresses fill connection a.
    assert.equal((await deliver(h, a, '192.0.2.10')).status, 200);
    const fresh = ['203.0.113.2', '203.0.113.3', '203.0.113.4'].map((ip) => slow(h, a, ip));
    await tick(300);
    assert.deepEqual(fresh.map((x) => x.status), [null, null, null]);
    assert.equal((await deliver(h, a, '203.0.113.5')).status, 503, 'a new address waits for the connection cap');
    assert.equal((await deliver(h, a, '192.0.2.10')).status, 200, 'the vetted address does not');
    h.clock.advance(16 * 60_000);
    assert.equal((await deliver(h, a, '192.0.2.10')).status, 503, 'vetting lapses');
    for (const x of fresh) x.req.destroy();
  } finally { await h.close(); }
});

test('M-1: a body that does not arrive by the deadline is cut with 408 and frees its slot', async () => {
  const h = await accessHub({ webhookReads: { perPair: 1, deadlineMs: 200 } });
  try {
    const conn = connect(h, 'm1f');
    const held = slow(h, conn, '203.0.113.20');
    const status = await Promise.race([held.answered, tick(3000).then(() => 'still reading')]);
    assert.equal(status, 408);
    const closed = new Promise((r) => held.req.socket.once('close', () => r('closed')));
    held.req.write(' "more"');
    assert.equal(await Promise.race([closed, tick(3000).then(() => 'still open')]), 'closed', 'the hub does not keep draining a slow sender');
    assert.equal((await deliver(h, conn, '203.0.113.20')).status, 200, 'the slot was released');
    held.req.destroy();
  } finally { await h.close(); }
});

// ── M-2 ───────────────────────────────────────────────────────────────────

test('M-2: a retry while the first attempt still runs is 503 + Retry-After; once that attempt fails, the next retry runs', async () => {
  const h = await accessHub();
  try {
    let calls = 0;
    let fail;
    const conn = connect(h, 'm2a', {
      handleWebhook: async () => {
        calls += 1;
        if (calls === 1) await new Promise((_, reject) => { fail = reject; });
      },
    });
    const send = () => fetch(`${h.base}/integrations/${conn.id}/webhook`, { method: 'POST', headers: { 'cf-connecting-ip': '192.0.2.50', 'x-ok': '1', 'x-id': 'same-delivery' }, body: '{"n":1}' });
    const first = send();
    await tick();
    const retry = await send();
    assert.equal(retry.status, 503, 'never 200: the provider must send it again');
    const after = Number(retry.headers.get('retry-after'));
    assert.ok(after >= 1 && after <= 60);
    assert.deepEqual(await retry.json(), { ok: false, in_progress: true, retry_after_s: after });
    fail(new Error('upstream broke'));
    assert.equal((await first).status, 500);
    assert.equal((await send()).status, 200, 'the released delivery runs on the next retry');
    assert.equal(calls, 2);
  } finally { await h.close(); }
});

test('M-2: ackEarly answers 200 before the handler runs, keeps the lease while it runs, and audits a failure (default off)', async () => {
  const h = await accessHub();
  try {
    let gate;
    let calls = 0;
    const conn = connect(h, 'm2b', {
      ackEarly: true,
      handleWebhook: async () => {
        calls += 1;
        await new Promise((resolve, reject) => { gate = { resolve, reject }; });
      },
    });
    const send = (id) => fetch(`${h.base}/integrations/${conn.id}/webhook`, { method: 'POST', headers: { 'cf-connecting-ip': '192.0.2.60', 'x-ok': '1', 'x-id': id }, body: JSON.stringify({ id }) });
    const first = await Promise.race([send('slack-evt-1'), tick(2000).then(() => null)]);
    assert.ok(first, 'answered while the handler is still running');
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, accepted: true });
    await tick(50);
    assert.equal(calls, 1);
    assert.equal((await send('slack-evt-1')).status, 503, 'the same lease: a retry is in progress');
    gate.reject(new Error('upstream said no'));
    await h.hub.idle();
    const audit = h.db.all("SELECT action, decision, error, external_ref, detail FROM integration_audit WHERE connection_id = ? AND action = 'webhook'", conn.id).map((r) => ({ ...r }));
    assert.deepEqual(audit, [{ action: 'webhook', decision: 'failed', error: 'handler_failed', external_ref: null, detail: '{}' }]);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM inbound_dedupe WHERE provider = ?', 'm2b').n, 0, 'released: a manual redelivery runs it');
    assert.equal(h.app.integrations.get(conn.id).health.last_error, 'handler_failed');
    // Success settles the lease as done.
    const ok = send('slack-evt-2');
    assert.equal((await ok).status, 200);
    await tick(50);
    gate.resolve();
    await h.hub.idle();
    assert.deepEqual([...new Set(h.db.all('SELECT state FROM inbound_dedupe WHERE provider = ?', 'm2b').map((r) => r.state))], ['done']);
    assert.equal((await send('slack-evt-2')).status, 200);
    assert.equal(calls, 2, 'a finished delivery is a duplicate');
    assert.throws(() => probe('m2c', { ackEarly: 'yes' }), /ackEarly is a boolean/);
    assert.throws(() => probe('m2d', { ackEarly: true, handleWebhook: undefined, verify: undefined }), /ackEarly/);
  } finally { await h.close(); }
});

// ── M-3 ───────────────────────────────────────────────────────────────────

// A tracker whose handler creates a card per issue with a stable request_id
// and (like a careless connector) no ctx.linked() check first.
const tracker = (id, hooks = {}) => ({
  handleWebhook: async ({ payload, ctx }) => {
    await ctx.act('card.create', { external_ref: payload.issue }, async (s) => {
      const { card } = await s.actAs(ctx.connection.created_by).createCard(ctx.boardIds()[0], { request_id: `issue-${payload.issue}`, title: `Issue ${payload.issue}` });
      await hooks.afterCreate?.(card);
      s.link(card.id, 'issue', payload.issue);
    });
  },
});
const hookIn = (h, conn, delivery, payload) => h.app.integrations.webhook(conn.id, { headers: { 'x-ok': '1', 'x-id': delivery }, rawBody: Buffer.from(JSON.stringify(payload)) });
const cardsTitled = (h, title) => h.db.all('SELECT id FROM cards WHERE title = ?', title).map((r) => r.id);
// What a hub restart forgets (D8) and what the 30-day sweep deletes.
const forget = (h) => { h.hub.requestCache.clear(); h.db.run('DELETE FROM inbound_dedupe'); };

test('M-3: a redelivery after the dedupe row is gone and the D8 cache forgotten returns the same card', async () => {
  const h = await accessHub();
  try {
    const conn = connect(h, 'm3a', tracker('m3a'));
    assert.equal((await hookIn(h, conn, 'd-1', { issue: 'ISS-1' })).status, 200);
    forget(h);
    assert.equal((await hookIn(h, conn, 'd-2', { issue: 'ISS-1' })).status, 200);
    assert.equal(cardsTitled(h, 'Issue ISS-1').length, 1);
    assert.deepEqual({ ...h.db.get('SELECT connection_id, request_id, card_id FROM integration_requests') }, { connection_id: conn.id, request_id: 'issue-ISS-1', card_id: cardsTitled(h, 'Issue ISS-1')[0] });
    // Another connection's same request_id is its own card.
    const other = connect(h, 'm3b', tracker('m3b'));
    await hookIn(h, other, 'd-1', { issue: 'ISS-1' });
    assert.equal(cardsTitled(h, 'Issue ISS-1').length, 2);
  } finally { await h.close(); }
});

test('M-3: a crash between creating the card and linking it: the retry after a restart links the same card', async () => {
  const h = await accessHub();
  try {
    let crash = true;
    const conn = connect(h, 'm3c', tracker('m3c', { afterCreate: () => { if (crash) { crash = false; throw new Error('process died here'); } } }));
    assert.equal((await hookIn(h, conn, 'd-1', { issue: 'ISS-2' })).status, 500);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM external_links').n, 0, 'nothing linked');
    forget(h);
    assert.equal((await hookIn(h, conn, 'd-1', { issue: 'ISS-2' })).status, 200);
    const ids = cardsTitled(h, 'Issue ISS-2');
    assert.equal(ids.length, 1);
    assert.equal(h.db.get('SELECT card_id FROM external_links WHERE connection_id = ?', conn.id).card_id, ids[0]);
  } finally { await h.close(); }
});

test('M-3: concurrent duplicates of one request create one card', async () => {
  const h = await accessHub();
  try {
    const conn = connect(h, 'm3d');
    const ctx = h.app.integrations.ctxFor(conn.id);
    const create = () => ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, { request_id: 'same-request', title: 'Once' }));
    const results = await Promise.all([create(), create(), create()]);
    assert.equal(cardsTitled(h, 'Once').length, 1);
    assert.equal(new Set(results.map((r) => r.result.card.id)).size, 1);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM journal WHERE kind = 'card.create'").n, 1);
  } finally { await h.close(); }
});

// ── M-3b ──────────────────────────────────────────────────────────────────

test('M-3b: an integration’s card.create journal row, as a member reads it, carries keyed hashes of its external ids and only the via: label', async () => {
  const h = await accessHub();
  try {
    const conn = connect(h, 'm3e');
    const ctx = h.app.integrations.ctxFor(conn.id);
    // Built at runtime: identifiers a connector would take from its provider.
    const ext = ['CUST', 'ACME', String(4471)].join('-');
    const branch = `release/${ext.toLowerCase()}`;
    const rid = `issue-${ext}`;
    const label = `customer:${ext}`;
    const { card } = (await ctx.act('card.create', { external_ref: ext }, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, {
      request_id: rid, title: 'From outside', base_ref: branch, labels: [label],
    }))).result;
    const rows = h.app.api.journalPage(h.db.get('SELECT * FROM members WHERE id = ?', h.ids.bob), h.ids.board, { after_seq: 0, limit: 1000 }).rows;
    const row = rows.find((r) => r.kind === 'card.create' && r.card_id === card.id);
    const text = JSON.stringify(row);
    for (const raw of [ext, branch, rid, label, ext.toLowerCase()]) assert.ok(!text.includes(raw), `the journal never holds ${raw}`);
    const p = row.payload;
    for (const f of ['external_ref', 'base_ref', 'request_id', 'title', 'body', 'acceptance']) assert.equal(f in p, false, `${f} is not journaled`);
    assert.deepEqual(JSON.parse(p.labels), ['via:m3e']);
    assert.match(p.external_ref_hmac, /^[0-9a-f]{32}$/);
    assert.equal(p.external_ref_hmac, h.hub.refHash(ext), 'correlatable on this hub');
    assert.equal(p.base_ref_hmac, h.hub.refHash(branch));
    assert.equal(p.request_id_hmac, h.hub.refHash(rid));
    assert.notEqual(p.external_ref_hmac, p.request_id_hmac);
    // The card itself keeps what it needs; the hub's private tables are unchanged.
    assert.equal(h.hub.card(card.id).base_ref, branch);
    // Erasing the key makes the journal's hashes unlinkable to the ids.
    h.db.run("DELETE FROM hub_meta WHERE k = 'journal_ref_key'");
    assert.notEqual(h.hub.refHash(ext), p.external_ref_hmac);
    assert.equal(h.hub.refHash(null), null);
    // A person's own card is journaled as before.
    const mine = await h.app.api.createCard(h.db.get('SELECT * FROM members WHERE id = ?', h.ids.alice), h.ids.board, { request_id: 'mine-1', title: 'Mine', base_ref: 'main', labels: ['x'] });
    const own = h.db.get("SELECT payload FROM journal WHERE kind = 'card.create' AND card_id = ?", mine.card.id);
    assert.deepEqual((({ base_ref, request_id, labels, title }) => ({ base_ref, request_id, labels, title }))(JSON.parse(own.payload)), { base_ref: 'main', request_id: 'mine-1', labels: '["x"]', title: 'Mine' });
  } finally { await h.close(); }
});
