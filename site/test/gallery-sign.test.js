const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const V = require('../../src/plugins/index-verify.js');
const S = require('../../src/gallery-schema.js');

const SIGNER = path.join(__dirname, '..', 'tools', 'sign-gallery.mjs');
const ROOT = path.join(__dirname, '..', '..');

test('sign-gallery: a throwaway key signs the committed index and createSignedVerifier accepts it; tampering is caught', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-sign-'));
  try {
    const pair = crypto.generateKeyPairSync('ed25519');
    const keyFile = path.join(dir, 'key.pem');
    fs.writeFileSync(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const indexFile = path.join(dir, 'index.json');
    fs.copyFileSync(path.join(ROOT, 'gallery', 'index.json'), indexFile);
    const r = spawnSync(process.execPath, [SIGNER, indexFile, keyFile], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const bytes = fs.readFileSync(indexFile), sig = fs.readFileSync(`${indexFile}.sig`);
    const keys = V.keysFromPems([pair.publicKey.export({ type: 'spki', format: 'pem' })]);
    const verify = V.createSignedVerifier({ keys, maxBytes: S.LIMITS.indexBytes, validateIndex: S.validateIndex });
    const ok = verify(bytes, sig);
    assert.equal(ok.status, 'verified');
    assert.equal(ok.keyId, keys[0].keyId);
    for (const e of ok.index.entries) assert.deepEqual(S.validateEntry(e), [], e.id);
    const tampered = Buffer.from(bytes); tampered[tampered.length - 3] ^= 1;
    assert.equal(verify(tampered, sig).status, 'unverified');
    fs.writeFileSync(path.join(dir, 'junk.json'), '{"not":"an index"}');
    assert.notEqual(spawnSync(process.execPath, [SIGNER, path.join(dir, 'junk.json'), keyFile]).status, 0);
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(path.join(dir, 'rsa.pem'), rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    assert.notEqual(spawnSync(process.execPath, [SIGNER, indexFile, path.join(dir, 'rsa.pem')]).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the committed gallery seed is valid, read-only, CSS-free, and its index is up to date', () => {
  const { check } = require('../gallery-build.js');
  const r = check(ROOT);
  assert.equal(r.stale, false, 'run node site/gallery-build.js --write');
  const kinds = r.index.entries.map((e) => e.kind);
  assert.ok(kinds.includes('recipe') && kinds.includes('character') && kinds.includes('pack'));
  for (const e of r.index.entries) {
    if (e.kind === 'recipe') assert.equal(e.payload.edits, false, e.id);
    if (e.kind === 'character') assert.ok(!Object.hasOwn(e.payload, 'css'), e.id);
  }
  assert.equal(r.index.generatedAt, `${r.index.entries.map((e) => e.updated).sort().at(-1)}T00:00:00.000Z`);
});
