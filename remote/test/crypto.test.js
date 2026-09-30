// Canonical JSON + isomorphic WebCrypto primitives, run under Node's WebCrypto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, hashToolInput, CanonicalError, generateSigningKey, exportPublicRaw, importPublicRaw, fingerprint, signObject, verifyObject, createIdentity, identityFromJwk } from '../src/index.js';
import { b64url, fromB64url } from '../src/encoding.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('canonical JSON sorts keys at every depth and has no whitespace', () => {
  assert.equal(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
});

test('canonical JSON follows JCS number and string forms', () => {
  assert.equal(canonicalize({ n: 1e21, m: 0.1, z: -0, s: 'é\n" ' }), '{"m":0.1,"n":1e+21,"s":"é\\n\\" ","z":0}');
});

test('canonical JSON refuses values it cannot represent', () => {
  for (const bad of [{ a: undefined }, { a: NaN }, { a: Infinity }, [1, , 3], new Date(), { a: () => 1 }, { a: 1n }]) {
    assert.throws(() => canonicalize(bad), CanonicalError, String(bad));
  }
  let deep = {};
  for (let i = 0; i < 100; i++) deep = { d: deep };
  assert.throws(() => canonicalize(deep), CanonicalError);
});

test('tool input hash ignores key order but not content', async () => {
  const a = await hashToolInput({ command: 'ls', timeout: 5 });
  assert.equal(a, await hashToolInput({ timeout: 5, command: 'ls' }));
  assert.notEqual(a, await hashToolInput({ command: 'ls ', timeout: 5 }));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(await hashToolInput(undefined), await hashToolInput({}));
});

test('base64url round trip and rejection of junk', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(33));
  assert.deepEqual(fromB64url(b64url(bytes)), bytes);
  assert.throws(() => fromB64url('ab+/'));
  assert.throws(() => fromB64url('a'));
});

test('P-256 sign/verify of a canonical object; any change breaks it', async () => {
  const kp = await generateSigningKey();
  const pub = await importPublicRaw(await exportPublicRaw(kp.publicKey));
  const env = await signObject(kp.privateKey, { t: 'x', n: 1 });
  assert.deepEqual(await verifyObject(pub, env), { t: 'x', n: 1 });
  assert.equal(await verifyObject(pub, { ...env, payload: env.payload.replace('1', '2') }), null);
  const sig = fromB64url(env.sig); sig[5] ^= 1;
  assert.equal(await verifyObject(pub, { ...env, sig: b64url(sig) }), null);
  assert.equal(await verifyObject(pub, { ...env, sig: env.sig + 'AA' }), null, 'wrong-length signature');
  const other = await generateSigningKey();
  assert.equal(await verifyObject(await importPublicRaw(await exportPublicRaw(other.publicKey)), env), null);
});

test('a validly signed but non-canonical payload is rejected', async () => {
  const kp = await generateSigningKey();
  const { signBytes } = await import('../src/keys.js');
  const { utf8 } = await import('../src/encoding.js');
  for (const text of ['{"n":1,"t":"x"} ', '{"t":"x","n":1}', '{"n":1,"n":2,"t":"x"}']) {
    const env = { payload: text, sig: await signBytes(kp.privateKey, utf8(text)) };
    assert.equal(await verifyObject(kp.publicKey, env), null, text);
  }
});

test('public key import accepts only uncompressed P-256 points', async () => {
  const kp = await generateSigningKey();
  const raw = fromB64url(await exportPublicRaw(kp.publicKey));
  assert.equal(raw.length, 65);
  await assert.rejects(importPublicRaw(b64url(raw.slice(0, 33))));
  const offCurve = raw.slice(); offCurve[64] ^= 1;
  await assert.rejects(importPublicRaw(b64url(offCurve)));
});

test('phone key is non-extractable by default', async () => {
  const kp = await generateSigningKey();
  await assert.rejects(crypto.subtle.exportKey('jwk', kp.privateKey));
});

test('device/desktop ids are the key fingerprint; identity survives a JWK round trip', async () => {
  const id = await createIdentity();
  assert.equal(id.desktopId, await fingerprint(id.publicRaw));
  assert.equal(id.desktopId.length, 32);
  const again = await identityFromJwk(JSON.parse(JSON.stringify(id.jwk)));
  assert.equal(again.desktopId, id.desktopId);
  const env = await signObject(again.privateKey, { t: 'y' });
  assert.deepEqual(await verifyObject(id.publicKey, env), { t: 'y' });
});

test('isomorphic modules use no Node-only APIs', () => {
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(text, /from ['"]node:|require\(|\bBuffer\b|\bprocess\./, f);
  }
});
