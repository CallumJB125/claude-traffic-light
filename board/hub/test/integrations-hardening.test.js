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
