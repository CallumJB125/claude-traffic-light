'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const V = require('../src/plugins/index-verify.js');
const S = require('../src/gallery-schema.js');

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const pair = crypto.generateKeyPairSync('ed25519');
const keys = [{ keyId: V.keyId(pair.publicKey), key: pair.publicKey }];
const sign = (bytes, keyId = keys[0].keyId, priv = pair.privateKey) => JSON.stringify({ alg: 'ed25519', keyId, sig: crypto.sign(null, bytes, priv).toString('base64') });
const index = (over = {}) => ({ kind: 'plexiform.gallery', schemaVersion: 1, serial: 1, generatedAt: '2026-10-09T00:00:00.000Z', entries: [], ...over });
const bytesOf = (o) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
const options = { keys, now: () => NOW, maxBytes: S.LIMITS.indexBytes, validateIndex: S.validateIndex };
const verifier = (over = {}) => V.createSignedVerifier({ ...options, ...over });

test('createSignedVerifier accepts a signed gallery index and names the key', () => {
  const b = bytesOf(index());
  const r = verifier()(b, sign(b));
  assert.equal(r.status, 'verified');
  assert.equal(r.keyId, keys[0].keyId);
  assert.equal(r.index_hash, V.hash(b));
});

test('createSignedVerifier refuses tampering, unknown and dev keys, duplicates, floor, future and size', () => {
  const b = bytesOf(index()), sig = sign(b);
  const tampered = Buffer.from(b); tampered[10] ^= 1;
  assert.equal(verifier()(tampered, sig).reason, 'signature');
  const other = crypto.generateKeyPairSync('ed25519');
  assert.equal(verifier()(b, sign(b, V.keyId(other.publicKey), other.privateKey)).reason, 'unknown-key');
  assert.equal(verifier()(b, JSON.stringify({ ...JSON.parse(sig), keyId: '28c56176d52e3aad' })).reason, 'signature');
  assert.equal(verifier({ keys: [] })(b, sig).reason, 'unknown-key');
  const dup = Buffer.from(b.toString().replace('"schemaVersion": 1', '"schemaVersion": 1, "schema\\u0056ersion": 1'));
  assert.equal(verifier()(dup, sign(dup)).reason, 'index-json');
  for (const generatedAt of ['2026-09-01T00:00:00.000Z', '2026-10-12T00:00:00.000Z']) { const t = bytesOf(index({ generatedAt })); assert.equal(verifier()(t, sign(t)).reason, 'index-time'); }
  const extra = bytesOf(index({ extra: 1 }));
  assert.equal(verifier()(extra, sign(extra)).reason, 'index-schema');
  const big = Buffer.alloc(S.LIMITS.indexBytes + 1, 0x20);
  assert.equal(verifier()(big, sign(big)).reason, 'index-bounds');
});

test('parseUnsigned runs the same strict parse and checks without a signature', () => {
  const b = bytesOf(index());
  const r = V.parseUnsigned(b, options);
  assert.equal(r.status, 'unsigned');
  assert.deepEqual(r.index, index());
  const dup = Buffer.from(b.toString().replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1'));
  assert.equal(V.parseUnsigned(dup, options).reason, 'index-json');
  assert.equal(V.parseUnsigned(bytesOf(index({ generatedAt: '2026-10-12T00:00:00.000Z' })), options).reason, 'index-time');
  assert.equal(V.parseUnsigned(Buffer.alloc(S.LIMITS.indexBytes + 1, 0x20), options).reason, 'index-bounds');
});
