// Identity: Cloudflare Access JWT verification (JWKS fetch + cache + kid
// refetch), member mapping by email, runner service-token binding, the dev
// login's loopback-only rule, device revocation and run tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createAccessVerifier, mintRunToken, parseRunToken, devCookieValue, parseDevCookie } from '../auth.js';
import { loadConfig } from '../config.js';
import { startHub } from './helpers.js';

const TEAM = 'acme';
const AUD = 'aud-123';

function keypair(kid) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

function jwt(k, claims, { alg = 'RS256' } = {}) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b({ alg, kid: k.kid, typ: 'JWT' });
  const body = b({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, ...claims });
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), k.privateKey).toString('base64url')}`;
}

function jwks(keys) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ keys: keys.map((k) => k.jwk) }) };
  };
  return { fetchImpl, calls, keys };
}

test('Access verifier: valid token, wrong aud, expired, bad signature, unknown kid refetch (throttled)', async () => {
  const k1 = keypair('k1');
  const k2 = keypair('k2');
  const src = jwks([k1]);
  let now = Date.now();
  const v = createAccessVerifier({ team: TEAM, aud: AUD, fetchImpl: src.fetchImpl, now: () => now });
  const claims = await v.verify(jwt(k1, { email: 'alice@dev.local' }));
  assert.equal(claims.email, 'alice@dev.local');
  assert.equal(src.calls[0], `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
  await assert.rejects(v.verify(jwt(k1, { aud: ['other'] })), /wrong audience/);
  await assert.rejects(v.verify(jwt(k1, { exp: Math.floor(now / 1000) - 5 })), /expired/);
  await assert.rejects(v.verify(jwt(k1, { iss: 'https://evil.cloudflareaccess.com' })), /wrong issuer/);
  const t = jwt(k1, { email: 'x' }).split('.');
  await assert.rejects(v.verify(`${t[0]}.${Buffer.from('{"email":"admin"}').toString('base64url')}.${t[2]}`), /bad signature/);
  await assert.rejects(v.verify(jwt(k1, {}, { alg: 'HS256' })), /unsupported alg/);
  await assert.rejects(v.verify(undefined), /missing/);

  // Key rotation: k2 unknown → refetch (after the 10 s throttle) → accepted.
  src.keys.push(k2);
  await assert.rejects(v.verify(jwt(k2, {})), /unknown signing key/);
  assert.equal(src.calls.length, 1, 'refetch throttled');
  now += 11_000;
  assert.ok(await v.verify(jwt(k2, { email: 'bob@dev.local' })));
  assert.equal(src.calls.length, 2);
  assert.ok(await v.verify(jwt(k1, {})), 'cached');
  assert.equal(src.calls.length, 2);
});

test('BOARD_AUTH=access: HTTP needs a valid assertion mapped to a member email; dev login is 404', async () => {
  const k = keypair('k1');
  const src = jwks([k]);
  const h = await startHub({ config: { auth: 'access', accessTeam: TEAM, accessAud: AUD }, fetchImpl: src.fetchImpl });
  try {
    const none = await h.api(null, 'GET', '/api/me');
    assert.equal(none.status, 401);
    assert.equal(none.body.error.code, 'UNAUTHENTICATED');
    const ok = await h.api(null, 'GET', '/api/me', null, { 'cf-access-jwt-assertion': jwt(k, { email: 'ALICE@dev.local' }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.member.github_login, 'alice');
    const stranger = await h.api(null, 'GET', '/api/me', null, { 'cf-access-jwt-assertion': jwt(k, { email: 'mallory@x.io' }) });
    assert.equal(stranger.status, 403);
    assert.match(stranger.body.error.message, /not a member/);
    const dev = await h.api(null, 'POST', '/api/dev/login', { github_login: 'alice' });
    assert.equal(dev.status, 404);

    // Runner: device token + service token whose common_name matches the device.
    const hdr = { 'cf-access-jwt-assertion': jwt(k, { email: 'alice@dev.local' }) };
    const mk = await h.api(null, 'POST', '/api/devices', { request_id: randomUUID(), name: 'Mac', cf_service_token_id: 'svc-1.access' }, hdr);
    assert.equal(mk.status, 200);
    const connect = (headers) => new Promise((resolve) => {
      const ws = new WebSocket(`${h.base.replace('http', 'ws')}/ws/runner`, { headers });
      ws.on('close', (code) => resolve(code));
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, device_id: mk.body.device_id, runner_version: 't', outbox_head_seq: 0, runs: [] })));
      ws.on('message', (d) => { if (JSON.parse(String(d)).type === 'welcome') { ws.close(1000); } });
    });
    const auth = { authorization: `Bearer ${mk.body.device_token}` };
    assert.equal(await connect(auth), 4401, 'no service token');
    assert.equal(await connect({ ...auth, 'cf-access-jwt-assertion': jwt(k, { common_name: 'svc-other' }) }), 4401, 'another device\'s service token');
    assert.equal(await connect({ ...auth, 'cf-access-jwt-assertion': jwt(k, { common_name: 'svc-1.access' }) }), 1000, 'accepted');
  } finally {
    await h.destroy();
  }
});

test('dev auth refuses a non-loopback bind; access auth needs team + aud; secret ≥ 32 bytes', () => {
  assert.throws(() => loadConfig({ BOARD_AUTH: 'dev', BOARD_BIND: '0.0.0.0' }), /loopback/);
  assert.throws(() => loadConfig({ BOARD_AUTH: 'dev', BOARD_BIND: '192.168.1.5' }), /loopback/);
  assert.equal(loadConfig({ BOARD_AUTH: 'dev', BOARD_BIND: '::1' }).auth, 'dev');
  assert.throws(() => loadConfig({}), /BOARD_ACCESS_TEAM/);
  assert.throws(() => loadConfig({ BOARD_AUTH: 'access', BOARD_ACCESS_TEAM: 't', BOARD_ACCESS_AUD: 'a', BOARD_DEV_SEED: '1' }), /DEV_SEED/);
  assert.throws(() => loadConfig({ BOARD_AUTH: 'dev', BOARD_SECRET: 'short' }), /32 bytes/);
  const c = loadConfig({ BOARD_AUTH: 'access', BOARD_ACCESS_TEAM: 't', BOARD_ACCESS_AUD: 'a' });
  assert.equal(c.bind, '127.0.0.1');
  assert.equal(c.port, 8787);
});

test('dev cookie and run tokens are HMAC-signed', () => {
  const secret = 's'.repeat(40);
  const v = devCookieValue(secret, 'm1');
  assert.equal(parseDevCookie(secret, v), 'm1');
  assert.equal(parseDevCookie(secret, v.replace('m1', 'm2')), null);
  assert.equal(parseDevCookie('t'.repeat(40), v), null);
  const tok = mintRunToken(secret, { card_id: 'c', run_id: 'r', fence: 3, hub_epoch: 'e' });
  assert.deepEqual(parseRunToken(secret, tok), { card_id: 'c', run_id: 'r', fence: 3, hub_epoch: 'e' });
  assert.equal(parseRunToken('x'.repeat(40), tok), null);
  assert.equal(parseRunToken(secret, `${tok}x`), null);
});

test('device tokens: unknown → 4401, revoked → 4403 (and a live connection is closed 4403); a second connection replaces the first (4409)', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    const dev = await h.enroll(alice);
    assert.match(dev.device_token, /^bdt_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(h.db.get('SELECT token_hash FROM devices WHERE id = ?', dev.device_id).token_hash, dev.device_token, 'only the hash is stored');
    const bad = await h.runner({ device_id: dev.device_id, device_token: 'bdt_nope' }, { hello: false });
    assert.equal(await bad.closed(), 4401);

    const r1 = await h.runner(dev);
    const r2 = await h.runner(dev);
    assert.equal(await r1.closed(), 4409);
    const list = await h.api(alice, 'GET', '/api/devices');
    assert.equal(list.body.devices[0].online, true);
    const notYours = await h.api(bob, 'DELETE', `/api/devices/${dev.device_id}`, { request_id: randomUUID() });
    assert.equal(notYours.status, 403);
    const del = await h.api(alice, 'DELETE', `/api/devices/${dev.device_id}`, { request_id: randomUUID() });
    assert.equal(del.status, 200);
    assert.equal(await r2.closed(), 4403);
    const again = await h.runner(dev, { hello: false });
    assert.equal(await again.closed(), 4403);
  } finally {
    await h.destroy();
  }
});

test('protocol mismatch closes 4426 on both channels', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const r = await h.runner(await h.enroll(alice), { hello: false });
    r.send({ type: 'hello', protocol: 2, device_id: r.dev.device_id, runner_version: 't', outbox_head_seq: 0, runs: [] });
    const e = await r.next('error');
    assert.equal(e.code, 'PROTOCOL_UNSUPPORTED');
    assert.equal(await r.closed(), 4426);

    const b = await h.browser(alice);
    b.send({ type: 'hello', protocol: 9 });
    assert.equal(await b.closed(), 4426);
  } finally {
    await h.destroy();
  }
});
