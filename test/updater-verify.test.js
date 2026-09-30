// src/updater/verify.js: the signature, manifest and file checks every update passes.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const V = require('../src/updater/verify.js');

const pair = () => crypto.generateKeyPairSync('ed25519');
const { privateKey, publicKey } = pair();
const keys = V.loadKeys([publicKey.export({ type: 'spki', format: 'pem' })]);
const sha = (s) => crypto.createHash('sha512').update(s).digest('base64');

function manifest(over = {}) {
  return {
    product: 'plexiform', channel: 'stable', version: '1.2.0', issuedAt: '2026-10-01T10:00:00.000Z', rollback: false, notes: 'Fixes.',
    files: [
      { name: 'Plexiform-1.2.0-mac-arm64.zip', sha512: sha('mac'), size: 3, platform: 'darwin', arch: 'arm64', kind: 'mac-zip' },
      { name: 'Plexiform-1.2.0-win-x64.exe', sha512: sha('win'), size: 3, platform: 'win32', arch: 'x64', kind: 'nsis' },
    ],
    ...over,
  };
}
const signed = (m, key = privateKey) => {
  const bytes = Buffer.from(JSON.stringify(m));
  return { bytes, sig: crypto.sign(null, bytes, key).toString('base64') };
};
const code = (fn, want) => assert.throws(fn, (e) => e instanceof V.UpdateError && e.code === want);

test('the shipped public key is an Ed25519 key', () => {
  const pem = fs.readFileSync(path.join(__dirname, '..', 'build', 'update-key.pub.pem'), 'utf8');
  assert.equal(V.loadKeys([pem]).length, 1);
  const pkg = require('../package.json');
  assert.ok(pkg.build.files.some((f) => f.startsWith('build/update-key')), 'the key ships in the package');
});

test('loadKeys refuses anything but Ed25519', () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => V.loadKeys([rsa]), /not ed25519/);
  assert.throws(() => V.loadKeys([]), /no update key/);
});

test('a correctly signed manifest opens', () => {
  const { bytes, sig } = signed(manifest());
  assert.equal(V.openManifest(bytes, sig, keys).version, '1.2.0');
});

test('an old key still verifies after a rotation (keys is a list)', () => {
  const old = pair();
  const both = V.loadKeys([publicKey, old.publicKey].map((k) => k.export({ type: 'spki', format: 'pem' })));
  const { bytes, sig } = signed(manifest(), old.privateKey);
  assert.equal(V.openManifest(bytes, sig, both).version, '1.2.0');
});

test('tampered manifest, wrong key, bad or missing signature: signature error', () => {
  const { bytes, sig } = signed(manifest());
  const tampered = Buffer.from(bytes.toString().replace('1.2.0', '1.9.0'));
  code(() => V.openManifest(tampered, sig, keys), 'signature');
  code(() => V.openManifest(bytes, signed(manifest(), pair().privateKey).sig, keys), 'signature');
  code(() => V.openManifest(bytes, '', keys), 'signature');
  code(() => V.openManifest(bytes, 'bm90IGEgc2ln', keys), 'signature');
  const flipped = Buffer.from(sig, 'base64');
  flipped[0] ^= 1;
  code(() => V.openManifest(bytes, flipped.toString('base64'), keys), 'signature');
});

test('a signed manifest with a bad shape or the wrong product is refused', () => {
  code(() => V.openManifest(signed(manifest({ product: 'other' })).bytes, signed(manifest({ product: 'other' })).sig, keys), 'verify');
  for (const over of [
    { version: 'one' }, { channel: 'nightly' }, { issuedAt: 'yesterday' }, { rollback: 'yes' }, { files: [] },
    { files: [{ ...manifest().files[0], name: '../../evil.zip' }] },
    { files: [{ ...manifest().files[0], name: 'a/b.zip' }] },
    { files: [{ ...manifest().files[0], sha512: 'short' }] },
    { files: [{ ...manifest().files[0], size: -1 }] },
    { files: [{ ...manifest().files[0], kind: 'msi' }] },
    { files: [manifest().files[0], manifest().files[0]] },
  ]) {
    const s = signed(manifest(over));
    code(() => V.openManifest(s.bytes, s.sig, keys), 'verify');
  }
  code(() => V.openManifest(Buffer.alloc(300 * 1024), 'x', keys), 'verify');
});

test('versions compare by semver precedence', () => {
  const order = ['0.9.9', '1.0.0-alpha', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.10.0', '2.0.0'];
  for (let i = 0; i < order.length - 1; i++) {
    assert.equal(V.compareVersions(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(V.compareVersions(order[i + 1], order[i]), 1);
  }
  assert.equal(V.compareVersions('1.2.3', '1.2.3'), 0);
  assert.throws(() => V.compareVersions('x', '1.0.0'));
});

test('decide: newer is an update, same is none, wrong channel refused', () => {
  const m = manifest();
  assert.deepEqual(V.decide(m, { channel: 'stable', currentVersion: '1.1.0' }), { update: true, rollback: false });
  assert.deepEqual(V.decide(m, { channel: 'stable', currentVersion: '1.2.0' }), { update: false });
  code(() => V.decide(m, { channel: 'beta', currentVersion: '1.1.0' }), 'verify');
});

test('decide: a downgrade needs a signed rollback or an explicit revert to exactly that version', () => {
  code(() => V.decide(manifest(), { channel: 'stable', currentVersion: '1.3.0' }), 'downgrade');
  assert.deepEqual(V.decide(manifest({ rollback: true }), { channel: 'stable', currentVersion: '1.3.0' }), { update: true, rollback: true });
  assert.deepEqual(V.decide(manifest(), { channel: 'stable', currentVersion: '1.3.0', revertTo: '1.2.0' }), { update: true, rollback: true });
  code(() => V.decide(manifest(), { channel: 'stable', currentVersion: '1.3.0', revertTo: '1.1.0' }), 'verify');
});

test('decide: a manifest issued before the last accepted one is a replay, rollback or not', () => {
  const last = '2026-10-02T00:00:00.000Z';
  code(() => V.decide(manifest(), { channel: 'stable', currentVersion: '1.1.0', lastIssuedAt: last }), 'verify');
  code(() => V.decide(manifest({ rollback: true }), { channel: 'stable', currentVersion: '1.3.0', lastIssuedAt: last }), 'verify');
  // the same manifest again is fine (every check re-reads it)
  assert.equal(V.decide(manifest(), { channel: 'stable', currentVersion: '1.1.0', lastIssuedAt: manifest().issuedAt }).update, true);
});

test('pickFile finds this machine\'s installer', () => {
  const m = manifest();
  assert.equal(V.pickFile(m, { platform: 'darwin', arch: 'arm64', kind: 'mac-zip' }).name, 'Plexiform-1.2.0-mac-arm64.zip');
  assert.equal(V.pickFile(m, { platform: 'darwin', arch: 'x64', kind: 'mac-zip' }), null);
  assert.equal(V.pickFile(m, { platform: 'linux', arch: 'x64', kind: 'deb' }), null);
});

test('checkFile: size and sha512 must both match', () => {
  const f = manifest().files[0];
  V.checkFile(f, { size: 3, sha512: sha('mac') });
  code(() => V.checkFile(f, { size: 4, sha512: sha('mac') }), 'verify');
  code(() => V.checkFile(f, { size: 3, sha512: sha('max') }), 'verify');
});

test('checkUpdateInfo: electron-updater\'s files must be the signed ones', () => {
  const m = manifest();
  const good = { version: '1.2.0', files: [{ url: 'Plexiform-1.2.0-win-x64.exe', sha512: sha('win'), size: 3 }], sha512: sha('win') };
  assert.equal(V.checkUpdateInfo(good, m), true);
  code(() => V.checkUpdateInfo({ ...good, files: [{ ...good.files[0], sha512: sha('evil') }] }, m), 'verify');
  code(() => V.checkUpdateInfo({ ...good, files: [{ ...good.files[0], size: 4 }] }, m), 'verify');
  code(() => V.checkUpdateInfo({ ...good, version: '1.2.1' }, m), 'verify');
  code(() => V.checkUpdateInfo({ ...good, files: [{ url: 'Other.exe', sha512: sha('win') }] }, m), 'verify');
  code(() => V.checkUpdateInfo({ ...good, files: [] }, m), 'verify');
  code(() => V.checkUpdateInfo({ ...good, sha512: sha('evil') }, m), 'verify');
  assert.equal(V.checkUpdateInfo({ ...good, files: [{ ...good.files[0], url: 'https://x/Plexiform-1.2.0-win-x64.exe' }] }, m), true);
});
