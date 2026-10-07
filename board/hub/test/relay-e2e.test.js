// LOCAL / DISPOSABLE PROOF ONLY — not production account acceptance.
// W2-A: the end-to-end envelope through a real in-process accounts hub on a
// loopback port. A phone (phone-core.js with a relay-scoped sign-in and a
// pairing record) drives a "Mac" host (src/remote-interaction.js with e2e on,
// FAKE codex app-server). Every byte the hub relays (HTTP bodies both ways,
// WebSocket frames both ways, the hub's own log) is recorded and searched for
// the fixture plaintext. Plus the scoped phone credential (403 off the relay).
// No real provider, Cloudflare or deployed hub; keys are made here (the
// pairing that exchanges them is proven in remote/test/envelope.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { startAccounts } from './accounts-helpers.js';
import { createLogger } from '../log.js';
import { createApi, createE2E } from '../../web/js/phone-core.js';
import { generateAgreementKey, exportAgreementPublic } from '../../web/js/phone-e2e.js';

const require = createRequire(import.meta.url);
const { createRemoteInteractionHost } = require('../../../src/remote-interaction.js');
const { createCodexAppServer } = require('../../../src/codex-app-server.js');
const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'fixtures', 'fake-codex-app-server.js');

const CANARY = 'canary-5d2e plaintext fixture: my AWS key is AKIA-NOT-REAL';
const T = { timeout: 30_000 };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 15)); } };

async function phoneSignIn(h, email) {
  const s = await h.start(email, { device_name: 'Alice iPhone', platform: 'phone-web' });
  const v = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: s.body.flow_id, code: h.codeFor(email), device_name: 'Alice iPhone', platform: 'phone-web', scope: 'relay' } });
  assert.equal(v.status, 200, v.text);
  return { token: v.body.device_token, device: v.body.device_id };
}

async function rig({ required = true, paired = true } = {}) {
  const lines = [];
  const h = await startAccounts({ log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) });
  const wire = []; // every relayed byte, as text
  // The Mac's socket, recorded both ways.
  class SpyWS extends WebSocket {
    constructor(url, opts) { super(url, opts); this.on('message', (d) => wire.push(`hub→mac ${String(d)}`)); }
    send(d, ...rest) { wire.push(`mac→hub ${String(d)}`); return super.send(d, ...rest); }
  }
  let host = null;
  try {
    const mac = await h.signIn('alice@dev.local', { device_name: 'Alice Mac' });
    assert.equal(mac.status, 200, mac.text);
    const phone = await phoneSignIn(h, 'alice@dev.local');
    // The two static ECDH keys a pairing would have exchanged (W2-B wires the UI).
    const deskKeys = await generateAgreementKey({ extractable: true });
    const phoneKeys = await generateAgreementKey(); // non-extractable, as phone-vault makes it
    const did = 'desk-alice-mac', dev = 'phone-alice-1';
    const peers = new Map([[dev, await exportAgreementPublic(phoneKeys.publicKey)]]);
    host = createRemoteInteractionHost({
      userId: mac.body.user.id, adapters: { codex: createCodexAppServer({ bin: FAKE }) }, boardCurrent: (b) => b === null, retry: { baseMs: 50, maxMs: 100 },
      e2e: { did, privateKey: deskKeys.privateKey, peer: (d) => peers.get(d) ?? null, required },
    });
    const st = await host.enable({ baseUrl: h.base, token: mac.body.device_token, WebSocket: SpyWS, fetch });
    assert.equal(st.state, 'connected', JSON.stringify(st));
    const store = {
      agreementKey: async () => phoneKeys,
      pairings: async () => (paired ? { [mac.body.device_id]: { did, dev, desktopAgree: await exportAgreementPublic(deskKeys.publicKey) } } : {}),
    };
    // What the phone's browser sends and gets back, recorded.
    const phoneFetch = async (url, init) => {
      assert.equal(init.credentials, 'omit');
      if (init.body) wire.push(`phone→hub ${init.body}`);
      const headers = { ...init.headers };
      if (init.method !== 'GET') headers.origin = h.base;
      const res = await fetch(url, { ...init, headers });
      const text = await res.text();
      wire.push(`hub→phone ${text}`);
      return new Response(text, { status: res.status, headers: res.headers });
    };
    const api = createApi({ fetch: phoneFetch, uuid: () => crypto.randomUUID(), origin: h.base, e2e: createE2E({ store }) });
    api.setToken(phone.token);
    return { h, lines, wire, host, mac, phone, api, peers, dev, close: async () => { host.close(); await h.close(); } };
  } catch (e) { host?.close(); await h.close(); throw e; }
}

test('LOCAL PROOF: the hub relays ciphertext only — no fixture plaintext in any relayed byte or in its log', T, async () => {
  const r = await rig();
  try {
    const macId = r.mac.body.device_id;
    const hosts = await r.api.hosts();
    assert.equal(hosts.status, 200, JSON.stringify(hosts.body));
    assert.deepEqual(hosts.body.hosts.map((x) => x.id), [macId]);
    const launched = await r.api.call(macId, 'launch', { provider: 'codex' });
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    const s = launched.body.result.state;
    const sent = await r.api.call(macId, 'send', { session: s.session, generation: s.generation, text: CANARY });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.result.status, 'acknowledged');
    let after = 0;
    const done = await until(async () => {
      const w = await r.api.call(macId, 'watch', { session: s.session, after });
      assert.equal(w.status, 200, JSON.stringify(w.body));
      after = w.body.result.version;
      return w.body.result.state.deliveries.find((d) => d.id === sent.body.result.delivery.id && d.state === 'completed');
    });
    assert.equal(done.response, `echo:${CANARY}`, 'the phone read the reply in plaintext');

    const needles = ['canary-5d2e', 'AKIA-NOT-REAL', 'echo:', s.session, '"provider":"codex"', 'deliveries'];
    assert.ok(r.wire.filter((l) => l.startsWith('hub→mac ')).length >= 4);
    for (const line of [...r.wire, ...r.lines]) {
      for (const n of needles) assert.ok(!line.includes(n), `"${n}" visible to the hub: ${line.slice(0, 160)}`);
    }
    // The frames the hub sends the Mac carry `enc`, never `args`.
    const frames = r.wire.filter((l) => l.startsWith('hub→mac ')).map((l) => JSON.parse(l.slice(8))).filter((f) => f.type === 'relay.request');
    assert.ok(frames.length >= 4);
    for (const f of frames) { assert.equal(f.args, undefined); assert.equal(typeof f.enc.ct, 'string'); }
    assert.deepEqual([...new Set(frames.map((f) => f.op))].sort(), ['hello', 'launch', 'send', 'watch']);
  } finally { await r.close(); }
});

test('LOCAL PROOF: the Mac refuses a plain call when end-to-end is required, and a hub-replayed or rewritten frame', T, async () => {
  const r = await rig({ paired: false });
  try {
    const macId = r.mac.body.device_id;
    const plain = await r.api.call(macId, 'list');
    assert.equal(plain.status, 200);
    assert.equal(plain.body.result.ok, false);
    assert.equal(plain.body.result.e2e, 'required');
    assert.match(plain.body.result.error, /Pair this device/);
  } finally { await r.close(); }

  const q = await rig();
  try {
    const macId = q.mac.body.device_id;
    assert.equal((await q.api.call(macId, 'list')).status, 200);
    const frame = q.wire.filter((l) => l.startsWith('hub→mac ')).map((l) => JSON.parse(l.slice(8))).filter((f) => f.op === 'list').at(-1);
    // A hub replaying the frame under a fresh relay id: the request id is burnt.
    assert.equal((await q.host.handle({ ...frame, id: crypto.randomUUID() })).e2e, 'replayed');
    // ...or under a fresh request id, or as another op: its (session, seq) is spent.
    // (On an unspent envelope the AAD binding refuses these: remote/test/envelope.test.js.)
    assert.equal((await q.host.handle({ ...frame, id: crypto.randomUUID(), rid: crypto.randomUUID() })).e2e, 'replayed');
    assert.equal((await q.host.handle({ ...frame, id: crypto.randomUUID(), rid: crypto.randomUUID(), op: 'close' })).e2e, 'replayed');
    // A plain frame forged by the hub (it knows the user and device ids).
    assert.equal((await q.host.handle({ type: 'relay.request', id: crypto.randomUUID(), rid: crypto.randomUUID(), user: q.mac.body.user.id, from: q.phone.device, op: 'list', args: {} })).e2e, 'required');
    // Revoked on the Mac: refused at once.
    q.peers.delete(q.dev);
    const gone = await q.api.call(macId, 'list');
    assert.equal(gone.status, 502);
    assert.equal(gone.body.error.reason, 'unknown-device');
  } finally { await q.close(); }
});

test('the hub checks the envelope shape only: enc with args, plain hello and malformed envelopes are refused', T, async () => {
  const r = await rig();
  try {
    const macId = r.mac.body.device_id;
    const path = `/api/interaction/v1/hosts/${macId}/call`;
    const enc = { v: 1, dev: 'p1', sid: 'A'.repeat(22), seq: 1, salt: 'A'.repeat(43), iv: 'A'.repeat(16), ct: 'A'.repeat(40) };
    const post = (body) => r.h.call('POST', path, { token: r.phone.token, body: { request_id: crypto.randomUUID(), ...body } });
    assert.equal((await post({ op: 'list', enc, args: {} })).status, 400);
    assert.equal((await post({ op: 'hello', args: {} })).status, 400);
    assert.equal((await post({ op: 'list', enc: { ...enc, iv: 'A' } })).status, 400);
    assert.equal((await post({ op: 'list', enc: { ...enc, extra: 1 } })).status, 400);
    assert.equal((await post({ op: 'list', enc: { ...enc, sid: '', seq: 1 } })).status, 400);
    // A well-formed envelope the Mac cannot open is relayed and refused there.
    const forged = await post({ op: 'list', enc });
    assert.equal(forged.status, 200);
    assert.equal(forged.body.result.e2e, 'unknown-device');
  } finally { await r.close(); }
});

test('scoped phone sign-in: 403 everywhere but the relay and sign-out; no sockets; cannot host', T, async () => {
  const r = await rig();
  try {
    const t = r.phone.token;
    const row = r.h.hub.db.get('SELECT scope, platform FROM user_devices WHERE id = ?', r.phone.device);
    assert.deepEqual({ ...row }, { scope: 'relay', platform: 'phone-web' });
    assert.equal(r.h.hub.db.get('SELECT scope FROM user_devices WHERE id = ?', r.mac.body.device_id).scope, 'full');
    for (const [method, path, body] of [
      ['GET', '/api/account'], ['GET', '/api/account/devices'], ['DELETE', `/api/account/devices/${r.mac.body.device_id}`, {}],
      ['PUT', '/api/interaction/v1/role', { role: 'host' }], ['POST', '/api/interaction/v1/shares', { session: crypto.randomUUID(), team: 'x', scope: 'watch' }],
      ['POST', '/api/teams', { name: 'Phone team' }], ['GET', '/api/work-capture/routes'], ['DELETE', '/api/account', {}],
    ]) {
      const res = await r.h.call(method, path, { token: t, ...(body ? { body } : {}) });
      assert.equal(res.status, 403, `${method} ${path}: ${res.text}`);
    }
    assert.equal((await r.h.call('GET', '/api/interaction/v1/hosts', { token: t })).status, 200);
    assert.equal((await r.h.call('GET', '/api/interaction/v1/shared', { token: t })).status, 200);
    // The Mac's full sign-in still works everywhere.
    assert.equal((await r.h.call('GET', '/api/account', { token: r.mac.body.device_token })).status, 200);
    // No board socket, no host socket.
    assert.equal(await r.h.upgradeStatus({ authorization: `Bearer ${t}` }), 401);
    const hostWs = await new Promise((resolve) => {
      const ws = new WebSocket(`${r.h.base.replace('http', 'ws')}/ws/interaction-host`, { headers: { authorization: `Bearer ${t}` } });
      ws.once('unexpected-response', (req, res) => { req.destroy(); resolve(res.statusCode); });
      ws.once('open', () => { ws.terminate(); resolve(101); });
      ws.on('error', () => {});
    });
    assert.equal(hostWs, 401);
    // Asking for 'full' from the phone platform still gets 'relay'.
    const s = await r.h.start('alice@dev.local', { platform: 'phone-web' });
    const v = await r.h.call('POST', '/api/auth/email/verify', { body: { flow_id: s.body.flow_id, code: r.h.codeFor('alice@dev.local'), platform: 'phone-web', scope: 'full' } });
    assert.equal(r.h.hub.db.get('SELECT scope FROM user_devices WHERE id = ?', v.body.device_id).scope, 'relay');
    // Sign-out works and ends the token.
    assert.equal((await r.h.call('POST', '/api/auth/signout', { token: t, body: {} })).status, 200);
    assert.equal((await r.h.call('GET', '/api/interaction/v1/hosts', { token: t })).status, 401);
  } finally { await r.close(); }
});

test('migration 056 adds the scope column and narrows existing phone sign-ins in place', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { migrate, loadMigrations } = await import('../../shared/migrate.js');
  const all = loadMigrations();
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, { migrations: all.filter((m) => m.version < 56) });
    const NOW = '2026-10-07T10:00:00.000Z';
    db.exec(`INSERT INTO users (id, display_name, created_at) VALUES ('u', 'U', '${NOW}');
      INSERT INTO user_devices (id, user_id, name, client, platform, token_hash, created_at, last_seen_at) VALUES
        ('mac', 'u', 'Mac', 'buddy_desktop', 'darwin-arm64', 'h1', '${NOW}', '${NOW}'),
        ('ph', 'u', 'iPhone', 'buddy_desktop', 'phone-web', 'h2', '${NOW}', '${NOW}');`);
    assert.deepEqual(migrate(db, { migrations: all.filter((m) => m.version <= 56) }), [56]);
    assert.deepEqual(db.prepare('SELECT id, scope FROM user_devices ORDER BY id').all().map((r) => [r.id, r.scope]), [['mac', 'full'], ['ph', 'relay']]);
    assert.throws(() => db.exec("UPDATE user_devices SET scope = 'admin' WHERE id = 'mac'"), /CHECK/);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
});
