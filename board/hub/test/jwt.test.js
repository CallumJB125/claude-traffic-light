// hub/jwt.js: the RS256/JWKS verifier shared by Google sign-in (identity/oauth.js)
// and D98 identity links. Keys are made at runtime; no key material in the repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign as cryptoSign, createHmac } from 'node:crypto';
import { createJwks, verifyRs256, JwtInvalid } from '../jwt.js';

const b64 = (x) => Buffer.from(x).toString('base64url');
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = `k-${randomBytes(4).toString('hex')}`;
const JWK = { ...key.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256' };
const AUD = `client-${randomBytes(4).toString('hex')}`;
const ISS = 'https://idp.example';
const NOW = 1_800_000_000;

function jwt(claims = {}, { alg = 'RS256', kid = KID, privateKey = key.privateKey, hmacKey = null, sig = null } = {}) {
  const head = b64(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = b64(JSON.stringify({ iss: ISS, aud: AUD, sub: 'U123', nonce: 'n-1', iat: NOW, exp: NOW + 600, ...claims }));
  const input = `${head}.${body}`;
  if (sig !== null) return `${input}.${sig}`;
  if (hmacKey) return `${input}.${b64(createHmac('sha256', hmacKey).update(input).digest())}`;
  return `${input}.${b64(cryptoSign('RSA-SHA256', Buffer.from(input), privateKey))}`;
}

function rig({ kidRefetchMs = 60_000, retryMs = 60_000, ttlMs = 3_600_000, keys = [JWK] } = {}) {
  let t = 0;
  const r = { loads: 0, fail: false, keys, advance: (ms) => { t += ms; } };
  r.jwks = createJwks({
    load: async () => { r.loads += 1; if (r.fail) throw new Error('down'); return { keys: r.keys }; },
    now: () => t, ttlMs, kidRefetchMs, retryMs,
  });
  r.verify = (token, over = {}) => verifyRs256(token, { keyFor: r.jwks.keyFor, issuers: [ISS], audience: AUD, nonce: 'n-1', nowS: NOW, ...over });
  return r;
}

test('verifyRs256: a good token passes; every other alg, a bad signature, an unknown kid and each claim check are JwtInvalid', async () => {
  const r = rig();
  assert.equal((await r.verify(jwt())).sub, 'U123');
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cases = [
    ['alg none', jwt({}, { alg: 'none', sig: '' })],
    ['alg none with a signature', jwt({}, { alg: 'none' })],
    ['HS256 under a shared secret', jwt({}, { alg: 'HS256', hmacKey: 'client-secret' })],
    ['RS512', jwt({}, { alg: 'RS512' })],
    ['bad signature', jwt({}, { privateKey: other.privateKey })],
    ['unknown kid', jwt({}, { kid: 'nope' })],
    ['wrong iss', jwt({ iss: 'https://evil.example' })],
    ['wrong aud', jwt({ aud: 'someone-else' })],
    ['several aud, no azp', jwt({ aud: [AUD, 'other'] })],
    ['several aud, other azp', jwt({ aud: [AUD, 'other'], azp: 'other' })],
    ['expired past the skew', jwt({ exp: NOW - 61 })],
    ['iat in the future past the skew', jwt({ iat: NOW + 61 })],
    ['no exp', jwt({ exp: undefined })],
    ['nonce mismatch', jwt({ nonce: 'n-2' })],
    ['no nonce', jwt({ nonce: undefined })],
    ['sub missing', jwt({ sub: undefined })],
    ['sub not a string', jwt({ sub: 42 })],
    ['two parts', jwt().split('.').slice(0, 2).join('.')],
    ['garbage', 'a.b.c'],
  ];
  for (const [name, token] of cases) await assert.rejects(r.verify(token), JwtInvalid, name);
  // Several audiences with azp = us; within the 60 s skew.
  assert.equal((await r.verify(jwt({ aud: ['other', AUD], azp: AUD }))).sub, 'U123');
  assert.equal((await r.verify(jwt({ exp: NOW - 30, iat: NOW + 30 }))).sub, 'U123');
  await assert.rejects(r.verify(jwt(), { nonce: '' }), JwtInvalid, 'a verifier without a nonce refuses');
  await assert.rejects(r.verify(jwt(), { nonce: null }), JwtInvalid);
});

test('JWKS: an unknown kid refetches at most once per kidRefetchMs; a flood of random kids costs one fetch a minute (injected clock, counting load)', async () => {
  const r = rig();
  await r.verify(jwt());
  assert.equal(r.loads, 1);
  for (let i = 0; i < 200; i += 1) await assert.rejects(r.verify(jwt({}, { kid: randomBytes(6).toString('hex') })), JwtInvalid);
  assert.equal(r.loads, 2, 'the first unknown kid refetched once; the other 199 did not');
  r.advance(59_000);
  await assert.rejects(r.verify(jwt({}, { kid: 'x1' })), JwtInvalid);
  assert.equal(r.loads, 2);
  r.advance(1_000);
  await assert.rejects(r.verify(jwt({}, { kid: 'x2' })), JwtInvalid);
  assert.equal(r.loads, 3);
  // A rotated key appears: picked up on the next allowed refetch.
  const k2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
  r.keys = [JWK, { ...k2.publicKey.export({ format: 'jwk' }), kid: 'k2' }];
  r.advance(60_000);
  assert.equal((await r.verify(jwt({}, { kid: 'k2', privateKey: k2.privateKey }))).sub, 'U123');
  assert.equal(r.loads, 4);
});

test('JWKS: concurrent first calls share one fetch; a failed fetch is retried no sooner than retryMs, and a cached kid still verifies while the JWKS is down', async () => {
  const r = rig();
  await Promise.all(Array.from({ length: 20 }, () => r.verify(jwt())));
  assert.equal(r.loads, 1, 'one fetch for twenty concurrent tokens');
  const down = rig();
  down.fail = true;
  for (let i = 0; i < 10; i += 1) await assert.rejects(down.verify(jwt()));
  assert.equal(down.loads, 1, 'a failing JWKS is not hammered');
  down.fail = false;
  down.advance(60_000);
  assert.equal((await down.verify(jwt())).sub, 'U123');
  assert.equal(down.loads, 2);
  // Stale after the TTL and down: the cached kid still verifies.
  down.advance(3_600_000);
  down.fail = true;
  assert.equal((await down.verify(jwt())).sub, 'U123');
});

test('JWKS: Google\'s settings (retryMs 0) refetch a stale or failed set on the next call, as before', async () => {
  const r = rig({ kidRefetchMs: 10_000, retryMs: 0 });
  r.fail = true;
  await assert.rejects(r.verify(jwt()), /down/);
  r.fail = false;
  assert.equal((await r.verify(jwt())).sub, 'U123');
  assert.equal(r.loads, 2);
  await assert.rejects(r.verify(jwt({}, { kid: 'nope' })), JwtInvalid);
  await assert.rejects(r.verify(jwt({}, { kid: 'nope2' })), JwtInvalid);
  assert.equal(r.loads, 2, 'an unknown kid right after a fetch does not refetch within 10 s');
  r.advance(10_000);
  await assert.rejects(r.verify(jwt({}, { kid: 'nope3' })), JwtInvalid);
  assert.equal(r.loads, 3);
});
