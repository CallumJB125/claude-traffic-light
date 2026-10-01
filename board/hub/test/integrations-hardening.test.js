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

test('F4: replaying a captured signed delivery vets nothing; a vetted sender vouches for its /24; a declared provider range skips the connection cap', async () => {
  const h = await accessHub({ webhookReads: { perPair: 1, perIp: 2, perConn: 2 } });
  try {
    const conn = connect(h, 'f4a', { ingressCidrs: ['192.30.252.0/22'] });
    const id = randomUUID();
    const body = JSON.stringify({ n: id });
    const post = (ip) => fetch(`${h.base}/integrations/${conn.id}/webhook`, { method: 'POST', headers: { 'cf-connecting-ip': ip, 'x-ok': '1', 'x-id': id }, body });
    assert.equal((await post('192.0.2.10')).status, 200, 'the provider delivers');
    const replay = await post('198.51.100.66');
    assert.deepEqual([replay.status, (await replay.json()).duplicate], [200, true], 'the attacker replays it');
    const fill = ['203.0.113.2', '203.0.113.3'].map((ip) => slow(h, conn, ip));
    await tick(300);
    assert.deepEqual(fill.map((x) => x.status), [null, null]);
    assert.equal((await deliver(h, conn, '198.51.100.66')).status, 503, 'a replay did not vet its sender');
    assert.equal((await deliver(h, conn, '192.0.2.77')).status, 200, 'the provider’s /24 is vetted');
    assert.equal((await deliver(h, conn, '192.30.253.7')).status, 200, 'a declared provider address, never seen before');
    assert.equal((await deliver(h, conn, '192.30.0.1')).status, 503, 'outside the range');
    for (const x of fill) x.req.destroy();
    assert.equal(h.app.integrations.trustedIngress(conn.id, '::ffff:192.30.255.255'), true);
    assert.equal(h.app.integrations.trustedIngress(conn.id, 'not-an-ip'), false);
  } finally { await h.close(); }
});

test('F4: ingressCidrs must be narrow CIDR ranges on a webhook connector', () => {
  for (const bad of [['0.0.0.0/0'], ['10.0.0.0/8'], ['::/0'], ['2001:db8::/16'], ['192.30.252.0'], ['192.30.252.0/33'], ['host.example/24'], [7], 'x']) {
    assert.throws(() => probe('f4b', { ingressCidrs: bad }), /ingressCidrs/, JSON.stringify(bad));
  }
  assert.throws(() => probe('f4b', { ingressCidrs: ['192.30.252.0/22'], handleWebhook: undefined, verify: undefined }), /ingressCidrs/);
  assert.deepEqual(probe('f4b', { ingressCidrs: ['192.30.252.0/22', '2a0a:a440::/32'] }).ingressCidrs, ['192.30.252.0/22', '2a0a:a440::/32']);
});

test('F4: the pre-signature read deadline is 3 s by default; BOARD_WEBHOOK_READ_MS overrides it', async () => {
  const { loadConfig } = await import('../config.js');
  assert.equal(loadConfig({ BOARD_AUTH: 'dev', BOARD_WEBHOOK_READ_MS: '5000' }).webhookReads.deadlineMs, 5000);
  assert.equal(loadConfig({ BOARD_AUTH: 'dev' }).webhookReads, undefined);
  const h = await accessHub();
  try {
    const conn = connect(h, 'f4c');
    const started = Date.now();
    const held = slow(h, conn, '203.0.113.40');
    assert.equal(await Promise.race([held.answered, tick(5000).then(() => 'still reading')]), 408);
    const took = Date.now() - started;
    assert.ok(took >= 2500 && took < 4500, `cut after ${took} ms`);
    held.req.destroy();
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
    // D42 addendum C2: marked done, so a captured copy can't re-run it (a replay answers duplicate).
    assert.deepEqual([...new Set(h.db.all('SELECT state FROM inbound_dedupe WHERE provider = ?', 'm2b').map((r) => r.state))], ['done']);
    assert.deepEqual(await (await send('slack-evt-1')).json(), { ok: true, duplicate: true });
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

test('L2: a request_id over 200 chars is refused, never cut; the same request on another board is CONFLICT', async () => {
  const h = await accessHub();
  try {
    const conn = connect(h, 'l2a');
    const ctx = h.app.integrations.ctxFor(conn.id);
    const create = (boardId, request_id, title = 'L2') => ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(boardId, { request_id, title }));
    const head = 'r'.repeat(200);
    await assert.rejects(create(h.ids.board, `${head}A`), (e) => e.code === 'VALIDATION');
    await assert.rejects(create(h.ids.board, `${head}B`), (e) => e.code === 'VALIDATION');
    assert.equal(cardsTitled(h, 'L2').length, 0);
    const a = (await create(h.ids.board, head)).result.card;
    assert.equal((await create(h.ids.board, head)).result.card.id, a.id, 'the same request on its board replays');
    const other = randomUUID();
    h.db.run("INSERT INTO boards (id, org_id, name, key_prefix) VALUES (?, ?, 'Two', 'TWO')", other, h.ids.org);
    await assert.rejects(create(other, head), (e) => e.code === 'CONFLICT', 'from the D8 cache');
    h.hub.requestCache.clear();
    await assert.rejects(create(other, head), (e) => e.code === 'CONFLICT', 'from integration_requests');
    assert.equal(cardsTitled(h, 'L2').length, 1);
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

test('F1: a person editing a card an integration created journals its text fields as keyed hashes, never the text', async () => {
  const h = await accessHub();
  try {
    const conn = connect(h, 'f1a');
    const ctx = h.app.integrations.ctxFor(conn.id);
    // Built at runtime: text a provider would carry (a customer's name and address).
    const who = ['Jane', 'Q', 'Customer'].join(' ');
    const addr = `${12 + 30} Elm Street`;
    const { card } = (await ctx.act('card.create', {}, (s) => s.actAs(h.ids.alice).createCard(h.ids.board, {
      request_id: 'f1-1', title: `Refund for ${who}`, body: `Ship to ${addr}`, labels: [`cust:${who}`],
    }))).result;
    const alice = h.db.get('SELECT * FROM members WHERE id = ?', h.ids.alice);
    const before = h.hub.card(card.id);
    const after = { title: `Refund for ${who} (urgent)`, body: `Ship to ${addr}, flat 2`, acceptance: `Call ${who}`, base_ref: `fix/${who.toLowerCase().replace(/ /g, '-')}`, labels: [`cust:${who}`, 'vip'] };
    await h.app.api.patchCard(alice, card.id, { version: before.version, request_id: 'p-1', column: 'in_progress', ...after });
    const bob = h.db.get('SELECT * FROM members WHERE id = ?', h.ids.bob);
    assert.equal(bob.role, 'member');
    const row = h.app.api.journalPage(bob, h.ids.board, { after_seq: 0, limit: 1000 }).rows.find((r) => r.kind === 'card.update' && r.card_id === card.id);
    const text = JSON.stringify(row);
    for (const raw of [who, addr, 'Elm', 'Jane', 'urgent', 'vip', 'jane-q']) assert.ok(!text.includes(raw), `the journal never holds ${raw}`);
    const f = row.payload.fields;
    for (const k of ['title', 'body', 'acceptance', 'base_ref', 'labels']) assert.equal(k in f, false, `${k} is not journaled in the clear`);
    assert.deepEqual(f.title_hmac, [h.hub.refHash(before.title), h.hub.refHash(after.title)]);
    assert.deepEqual(f.labels_hmac, [h.hub.refHash(before.labels), h.hub.refHash(JSON.stringify(after.labels))]);
    assert.deepEqual(f.acceptance_hmac, [null, h.hub.refHash(after.acceptance)]);
    assert.deepEqual(f.column_name, ['todo', 'in_progress'], 'other fields stay plain');
    assert.equal(h.hub.card(card.id).title, after.title, 'the card itself is edited');
    // A person's own card is journaled as before.
    const mine = (await h.app.api.createCard(alice, h.ids.board, { request_id: 'f1-mine', title: 'Mine' })).card;
    await h.app.api.patchCard(alice, mine.id, { version: h.hub.card(mine.id).version, title: 'Mine 2' });
    const own = JSON.parse(h.db.get("SELECT payload FROM journal WHERE kind = 'card.update' AND card_id = ?", mine.id).payload);
    assert.deepEqual(own.fields.title, ['Mine', 'Mine 2']);
  } finally { await h.close(); }
});

test('F2: the audit log is admin-only, keeps id-shaped strings only, a short clean external_ref, and 90 days', async () => {
  const h = await startHub();
  try {
    h.hub.setVaultKey(randomBytes(32));
    const conn = connect(h, 'f2a');
    const reg = h.app.integrations;
    const ctx = reg.ctxFor(conn.id);
    const snippet = ['please', 'refund', 'my', 'order'].join(' ');
    const rlo = String.fromCodePoint(0x202e);
    await ctx.act('card.create', {
      external_ref: `PR-7${rlo}\u0000\u2028${'9'.repeat(200)}`,
      detail: { pr: 7, branch: 'board/BDL-1-r1', sha: 'abc123', repo: 'acme/web', said: snippet, html: '<b>x</b>', nl: 'a\nb' },
      undo: { card_id: 'c1', note: snippet },
    }, async () => {});
    const bob = await h.login('bob');
    assert.equal((await h.api(bob, 'GET', `/api/integrations/${conn.id}/audit`)).status, 403, 'a member');
    const res = await h.api(await h.login('alice'), 'GET', `/api/integrations/${conn.id}/audit`);
    assert.equal(res.status, 200);
    const [a] = res.body.entries;
    assert.deepEqual(a.detail, { pr: 7, branch: 'board/BDL-1-r1', sha: 'abc123', repo: 'acme/web' }, 'free text is dropped');
    assert.deepEqual(a.undo, { card_id: 'c1' });
    assert.equal(a.external_ref, `PR-7${'9'.repeat(76)}`);
    // Retention: the sweeper drops rows older than 90 days, keeps newer ones.
    const old = (days) => new Date(h.hub.wallMs() - days * 24 * 3600_000).toISOString();
    const [d91, d90, d89] = [old(91), old(90), old(89)];
    h.db.run('UPDATE integration_audit SET at = ?', d91);
    await ctx.act('card.create', {}, async () => {});
    h.db.run('UPDATE integration_audit SET at = ? WHERE at > ?', d89, d90);
    reg.sweepDedupe();
    assert.deepEqual(h.db.all('SELECT at FROM integration_audit').map((r) => r.at), [d89]);
  } finally { await h.close(); }
});

// ── Low-a: migration 008's guard ────────────────────────────────────────

test('Low-a: 008 aborts, changing nothing, for a trigger written ON JOURNAL / ON Comments, or a known name with another definition', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { migrate, loadMigrations, currentVersion } = await import('../../shared/migrate.js');
  const upTo = (v) => loadMigrations().filter((m) => m.version <= v);
  const master = (db) => db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all().map((r) => ({ ...r }));
  for (const extra of [
    "CREATE TRIGGER shout_upd BEFORE UPDATE ON JOURNAL BEGIN SELECT RAISE(ABORT, 'no'); END;",
    "CREATE TRIGGER mixed_ins BEFORE INSERT ON Comments BEGIN SELECT RAISE(ABORT, 'no') WHERE 0; END;",
    "DROP TRIGGER journal_no_delete; CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT, 'audited delete'); END;",
    'DROP INDEX journal_card_seq; CREATE INDEX journal_card_seq ON journal (card_id, seq, kind);',
    'CREATE INDEX JOURNAL_BOARD_SEQ_2 ON JOURNAL (kind);',
  ]) {
    const db = new DatabaseSync(':memory:');
    migrate(db, { migrations: upTo(7) });
    db.exec(extra);
    const before = master(db);
    assert.throws(() => migrate(db, { migrations: upTo(8) }), /would drop triggers or indexes/, extra);
    assert.equal(currentVersion(db), 7);
    assert.deepEqual(master(db), before);
    db.close();
  }
  // The plain 007 schema still migrates.
  const ok = new DatabaseSync(':memory:');
  migrate(ok, { migrations: upTo(7) });
  assert.deepEqual(migrate(ok, { migrations: upTo(8) }), [8]);
  ok.close();
});

// ── Low-c: vault health writes ────────────────────────────────────────────

test('Low-c: a vault that cannot open a connection’s secrets records vault_error once a minute, not on every delivery', async () => {
  const h = await startHub();
  try {
    h.hub.setVaultKey(randomBytes(32));
    const reg = h.app.integrations;
    reg.register(probe('m4a', { secrets: ['webhook_secret'] }));
    const conn = reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'm4a', external_id: 'w1', secrets: { webhook_secret: randomBytes(16).toString('hex') } });
    // A restart with another key and no BOARD_ENC_KEY_PREVIOUS.
    h.hub.vaultKey = null;
    h.hub.setVaultKey(randomBytes(32));
    let writes = 0;
    const run = h.db.run.bind(h.db);
    h.db.run = (sql, ...args) => { if (/UPDATE connections SET health/.test(sql)) writes += 1; return run(sql, ...args); };
    const post = () => reg.webhook(conn.id, { headers: { 'x-ok': '1', 'x-id': randomUUID() }, rawBody: Buffer.from('{}') });
    for (let i = 0; i < 5; i += 1) assert.equal((await post()).status, 500);
    assert.equal(writes, 1);
    assert.equal(reg.get(conn.id).health.last_error, 'vault_error');
    h.clock.advance(61_000);
    assert.equal((await post()).status, 500);
    assert.equal(writes, 2);
  } finally { await h.close(); }
});

// ── Low-d: re-seal under the current key at startup ───────────────────────

test('Low-d: with BOARD_ENC_KEY_PREVIOUS every vault row is re-sealed at once, in one transaction, idempotently, logging counts only', async () => {
  const h = await startHub();
  try {
    const { keyIdOf } = await import('../vault.js');
    const oldKey = randomBytes(32);
    h.hub.setVaultKey(oldKey);
    const reg = h.app.integrations;
    reg.register(probe('m5a', { secrets: ['api_token', 'webhook_secret'] }));
    const conns = ['w1', 'w2'].map((w) => reg.createConnection({
      orgId: h.ids.org, memberId: h.ids.alice, provider: 'm5a', external_id: w,
      secrets: { api_token: randomBytes(12).toString('hex'), webhook_secret: randomBytes(12).toString('hex') },
    }));
    const plain = (c) => { const ctx = reg.ctxFor(c.id); return { api_token: ctx.secret('api_token'), webhook_secret: ctx.secret('webhook_secret') }; };
    const before = conns.map(plain);
    // A row sealed under some third key: nothing opens it.
    const stray = randomUUID();
    h.db.run("INSERT INTO connections (id, org_id, provider, external_id, status, settings, created_at) VALUES (?, ?, 'm5a', 'w3', 'revoked', '{}', ?)", stray, h.ids.org, h.hub.iso());
    h.db.run("INSERT INTO connection_secrets (connection_id, kind, key_id, nonce, ciphertext, created_at) VALUES (?, 'api_token', 'feedfeedfeed', ?, ?, ?)", stray, randomBytes(12), randomBytes(40), h.hub.iso());
    const keyIds = () => [...new Set(h.db.all('SELECT key_id FROM connection_secrets WHERE connection_id != ?', stray).map((r) => r.key_id))];
    assert.deepEqual(keyIds(), [keyIdOf(oldKey)]);

    // A restart whose re-seal fails halfway changes nothing (and still starts).
    const logs = [];
    h.hub.log = { info: (msg, f) => logs.push(['info', msg, f]), warn() {}, error: (msg, f) => logs.push(['error', msg, f]) };
    const run = h.db.run.bind(h.db);
    let updates = 0;
    h.db.run = (sql, ...args) => { if (/UPDATE connection_secrets/.test(sql) && ++updates === 2) throw new Error('disk full'); return run(sql, ...args); };
    h.hub.vaultKey = null;
    h.hub.setVaultKey(randomBytes(32), oldKey);
    h.db.run = run;
    assert.deepEqual(keyIds(), [keyIdOf(oldKey)], 'rolled back');
    assert.equal(logs.at(-1)[0], 'error');

    // The real restart: every row the previous key opens is re-sealed before any delivery.
    const newKey = randomBytes(32);
    logs.length = 0;
    h.hub.vaultKey = null;
    h.hub.setVaultKey(newKey, oldKey);
    assert.deepEqual(keyIds(), [keyIdOf(newKey)]);
    assert.equal(h.db.get('SELECT key_id FROM connection_secrets WHERE connection_id = ?', stray).key_id, 'feedfeedfeed', 'left as it was');
    assert.deepEqual(logs, [['info', 'vault re-sealed under the current key', { resealed: 4, unopened: 1 }]]);
    const text = JSON.stringify(logs);
    for (const c of conns) assert.ok(!text.includes(c.id), 'no ids in the log');
    // The previous key can go: a restart without it opens everything.
    h.hub.vaultKey = null;
    h.hub.setVaultKey(newKey);
    assert.deepEqual(conns.map(plain), before);
    assert.deepEqual(h.hub.resealVault(), { resealed: 0, unopened: 1 }, 'idempotent');
  } finally { await h.close(); }
});

// ── Low-e: what createConnection seals ────────────────────────────────────

test('Low-e: every secret must be a declared kind holding a non-empty string ≤ 16 KiB; nothing is written otherwise and the value is never echoed', async () => {
  const h = await startHub();
  try {
    h.hub.setVaultKey(randomBytes(32));
    const reg = h.app.integrations;
    reg.register(probe('m6a', { secrets: ['app_private_key'] }));
    const count = () => ['connections', 'connection_secrets', 'journal'].map((t) => h.db.get(`SELECT COUNT(*) AS n FROM ${t}`).n);
    const before = count();
    const marker = `marker-${randomUUID()}`;
    const make = (secrets, external_id = randomUUID()) => () => reg.createConnection({ orgId: h.ids.org, memberId: h.ids.alice, provider: 'm6a', external_id, secrets });
    for (const bad of [{ pem: marker }, [marker], 4242, null, '', marker.padEnd(16 * 1024 + 1, 'x'), true]) {
      assert.throws(make({ app_private_key: bad }), (e) => e.code === 'VALIDATION' && !e.message.includes(marker) && !e.message.includes('4242'), JSON.stringify(bad)?.slice(0, 40));
    }
    assert.throws(make({ webhook_secret: marker }), (e) => e.code === 'VALIDATION' && !e.message.includes(marker));
    assert.deepEqual(count(), before, 'no connection, secret or journal row');
    // A PEM-sized key is fine and comes back intact.
    const pem = ['-----BEGIN', 'PRIVATE KEY-----\n'].join(' ') + randomBytes(1200).toString('base64').replace(/.{64}/g, '$&\n') + ['\n-----END', 'PRIVATE KEY-----'].join(' ');
    const conn = make({ app_private_key: pem })();
    assert.equal(reg.ctxFor(conn.id).secret('app_private_key'), pem);
    const max = 'k'.repeat(16 * 1024);
    assert.equal(reg.ctxFor(make({ app_private_key: max })().id).secret('app_private_key'), max);
    // Through the token route the admin sees the short validation message only.
    reg.register(probe('m6b', { secrets: ['api_token'], connect: { kind: 'token', verifyToken: async () => ({ external_id: 'w9', secrets: { api_token: { leaked: marker } } }) } }));
    const alice = await h.login('alice');
    const r = await h.api(alice, 'POST', '/api/integrations/m6b/token', { request_id: randomUUID(), token: 'pasted-token-value' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION');
    assert.ok(!JSON.stringify(r.body).includes(marker));
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM connections WHERE provider = 'm6b'").n, 0);
  } finally { await h.close(); }
});
