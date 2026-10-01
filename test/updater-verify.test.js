// src/updater/verify.js: the signature, manifest and file checks every update passes.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const V = require('../src/updater/verify.js');

const pair = () => crypto.generateKeyPairSync('ed25519');
const pem = (k) => k.export({ type: 'spki', format: 'pem' });
const { privateKey, publicKey } = pair();
const beta = pair();
const keys = V.loadKeyring({ stable: [pem(publicKey)], beta: [pem(beta.publicKey)] });
const open = (bytes, sig, ring = keys, channel = 'stable') => V.openManifest(bytes, sig, ring, { channel });
const sha = (s) => crypto.createHash('sha512').update(s).digest('base64');
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
// The retired stable key (public half): no shipped key may be it.
const RETIRED = 'MCowBQYDK2VwAyEAKuB6DMnFnDu8lTImeycj7TsG0/tqE0ePLkR7Wc572b8=';

function manifest(over = {}) {
  return {
    product: 'plexiform', channel: 'stable', version: '1.2.0', issuedAt: '2026-10-01T10:00:00.000Z', expiresAt: '2026-10-31T10:00:00.000Z', rollback: false, notes: 'Fixes.',
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

test('the shipped keys: one Ed25519 key per channel, stable and beta different, never the retired one', () => {
  const Updater = require('../src/updater/index.js');
  const ring = Updater.loadShippedKeys();
  assert.equal(ring.stable.length, 1);
  assert.equal(ring.beta.length, 1);
  const raw = (k) => k.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.notEqual(raw(ring.stable[0]), raw(ring.beta[0]));
  for (const k of [...ring.stable, ...ring.beta]) assert.notEqual(raw(k), RETIRED);
  for (const name of fs.readdirSync(path.join(__dirname, '..', 'build'))) assert.ok(!(/retired|old/i.test(name) && name.endsWith('.pem')), name);
  const pkg = require('../package.json');
  for (const f of Object.values(Updater.KEY_FILES)) assert.ok(pkg.build.files.includes(`build/${f}`), `${f} ships in the package`);
  assert.ok(pkg.build.files.includes('build/release-floor.json'), 'the release floor ships');
});

test('loadShippedKeys trusts only the two exact file names, and a missing one fails closed', () => {
  const Updater = require('../src/updater/index.js');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'keys-'));
  fs.writeFileSync(path.join(dir, 'update-key.pub.pem'), pem(publicKey));
  fs.writeFileSync(path.join(dir, 'update-key-OLD-retired.pub.pem'), pem(beta.publicKey));
  const ring = Updater.loadShippedKeys(dir);
  assert.equal(ring.stable.length, 1);
  assert.deepEqual(ring.beta, [], 'no beta key file: beta opens nothing');
  const s = signed(manifest({ channel: 'beta' }), beta.privateKey);
  code(() => open(s.bytes, s.sig, ring, 'beta'), 'signature');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadKeys refuses anything but Ed25519', () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => V.loadKeys([rsa]), /not ed25519/);
  assert.throws(() => V.loadKeys([]), /no update key/);
});

test('each channel opens only with its own key, and only a manifest for that channel', () => {
  const stableSigned = signed(manifest());
  const betaSigned = signed(manifest({ channel: 'beta', version: '1.2.0-beta.1', files: manifest().files.map((f) => ({ ...f, name: f.name.replace('1.2.0', '1.2.0-beta.1') })) }), beta.privateKey);
  assert.equal(open(stableSigned.bytes, stableSigned.sig).channel, 'stable');
  assert.equal(open(betaSigned.bytes, betaSigned.sig, keys, 'beta').channel, 'beta');
  // the beta key can't sign for stable installs, nor the stable key for beta ones
  code(() => open(betaSigned.bytes, betaSigned.sig, keys, 'stable'), 'signature');
  code(() => open(stableSigned.bytes, stableSigned.sig, keys, 'beta'), 'signature');
  // a stable manifest signed with the beta key, offered to a beta install: channel mismatch
  const crossed = signed(manifest(), beta.privateKey);
  code(() => open(crossed.bytes, crossed.sig, keys, 'beta'), 'verify');
  assert.throws(() => V.openManifest(stableSigned.bytes, stableSigned.sig, keys), /channel must be/);
});

test('a correctly signed manifest opens', () => {
  const { bytes, sig } = signed(manifest());
  assert.equal(open(bytes, sig).version, '1.2.0');
});

test('a channel can hold more than one key (a rotation)', () => {
  const old = pair();
  const both = V.loadKeyring({ stable: [pem(publicKey), pem(old.publicKey)] });
  const { bytes, sig } = signed(manifest(), old.privateKey);
  assert.equal(open(bytes, sig, both).version, '1.2.0');
});

test('tampered manifest, wrong key, bad or missing signature: signature error', () => {
  const { bytes, sig } = signed(manifest());
  const tampered = Buffer.from(bytes.toString().replace('1.2.0', '1.9.0'));
  code(() => open(tampered, sig), 'signature');
  code(() => open(bytes, signed(manifest(), pair().privateKey).sig), 'signature');
  code(() => open(bytes, ''), 'signature');
  code(() => open(bytes, 'bm90IGEgc2ln'), 'signature');
  const flipped = Buffer.from(sig, 'base64');
  flipped[0] ^= 1;
  code(() => open(bytes, flipped.toString('base64')), 'signature');
});

test('a signed manifest with a bad shape or the wrong product is refused', () => {
  code(() => open(signed(manifest({ product: 'other' })).bytes, signed(manifest({ product: 'other' })).sig), 'verify');
  for (const over of [
    { version: 'one' }, { channel: 'nightly' }, { issuedAt: 'yesterday' }, { rollback: 'yes' }, { files: [] },
    { expiresAt: undefined }, { expiresAt: 'soon' }, { expiresAt: '2026-10-01T09:00:00.000Z' },
    { rollback: true }, { rollback: true, rollbackFrom: [] }, { rollback: true, rollbackFrom: ['1.1.0'] }, { rollback: true, rollbackFrom: ['x'] },
    { rollbackFrom: ['1.3.0'] },
    { files: [{ ...manifest().files[0], name: '../../evil.zip' }] },
    { files: [{ ...manifest().files[0], name: 'a/b.zip' }] },
    { files: [{ ...manifest().files[0], sha512: 'short' }] },
    { files: [{ ...manifest().files[0], size: -1 }] },
    { files: [{ ...manifest().files[0], kind: 'msi' }] },
    { files: [manifest().files[0], manifest().files[0]] },
  ]) {
    const s = signed(manifest(over));
    code(() => open(s.bytes, s.sig), 'verify');
  }
  code(() => open(Buffer.alloc(300 * 1024), 'x'), 'verify');
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

const at = (o) => ({ channel: 'stable', now: NOW, ...o });
const RB = { rollback: true, rollbackFrom: ['1.3.0'] };

test('decide: newer is an update, same is none, wrong channel refused', () => {
  const m = manifest();
  assert.deepEqual(V.decide(m, at({ currentVersion: '1.1.0' })), { update: true, rollback: false, expired: false });
  assert.deepEqual(V.decide(m, at({ currentVersion: '1.2.0' })), { update: false, expired: false });
  code(() => V.decide(m, at({ channel: 'beta', currentVersion: '1.1.0' })), 'verify');
});

test('decide: a downgrade needs a signed rollback that names this version, or an explicit revert to exactly that version', () => {
  code(() => V.decide(manifest(), at({ currentVersion: '1.3.0' })), 'downgrade');
  assert.deepEqual(V.decide(manifest(RB), at({ currentVersion: '1.3.0' })), { update: true, rollback: true, expired: false });
  // a rollback from 1.3.0 is not for 1.4.0
  code(() => V.decide(manifest(RB), at({ currentVersion: '1.4.0' })), 'downgrade');
  // older installs take it as an ordinary update
  assert.deepEqual(V.decide(manifest(RB), at({ currentVersion: '1.1.0' })), { update: true, rollback: false, expired: false });
  assert.deepEqual(V.decide(manifest(), at({ currentVersion: '1.3.0', revertTo: '1.2.0' })), { update: true, rollback: true, expired: false });
  code(() => V.decide(manifest(), at({ currentVersion: '1.3.0', revertTo: '1.1.0' })), 'verify');
});

test('decide: a manifest issued before the last accepted one is a replay, rollback or not', () => {
  const last = '2026-10-02T00:00:00.000Z';
  code(() => V.decide(manifest(), at({ currentVersion: '1.1.0', lastIssuedAt: last })), 'verify');
  code(() => V.decide(manifest(RB), at({ currentVersion: '1.3.0', lastIssuedAt: last })), 'verify');
  // the same manifest again is fine (every check re-reads it)
  assert.equal(V.decide(manifest(), at({ currentVersion: '1.1.0', lastIssuedAt: manifest().issuedAt })).update, true);
  assert.equal(V.decide(manifest(RB), at({ currentVersion: '1.3.0', lastIssuedAt: manifest().issuedAt })).update, true);
});

test('decide: the build time is a floor on every channel, and a rollback must be newer than the build it downgrades', () => {
  const builtAt = '2026-10-01T11:00:00.000Z';
  // a fresh install (no lastIssuedAt) still refuses anything signed before it was built
  code(() => V.decide(manifest(), at({ currentVersion: '1.1.0', builtAt })), 'verify');
  code(() => V.decide(manifest({ channel: 'beta' }), at({ channel: 'beta', currentVersion: '1.1.0', builtAt })), 'verify');
  // the later of the two floors wins
  assert.equal(V.decide(manifest(), at({ currentVersion: '1.1.0', builtAt: '2026-09-01T00:00:00.000Z', lastIssuedAt: '2026-10-01T10:00:00.000Z' })).update, true);
  code(() => V.decide(manifest(), at({ currentVersion: '1.1.0', builtAt: '2026-09-01T00:00:00.000Z', lastIssuedAt: '2026-10-01T10:00:01.000Z' })), 'verify');
  // <= for a rollback: signed at the very moment 1.3.0 was built is too early
  code(() => V.decide(manifest(RB), at({ currentVersion: '1.3.0', builtAt: manifest().issuedAt })), 'verify');
  assert.equal(V.decide(manifest(RB), at({ currentVersion: '1.3.0', builtAt: '2026-10-01T09:59:59.000Z' })).rollback, true);
});

test('decide: issuedAt more than a day ahead is refused; an expired rollback is refused; an expired release is flagged', () => {
  code(() => V.decide(manifest({ issuedAt: '2026-10-02T12:00:01.000Z', expiresAt: '2026-11-01T00:00:00.000Z' }), at({ currentVersion: '1.1.0' })), 'verify');
  assert.equal(V.decide(manifest({ issuedAt: '2026-10-02T11:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z' }), at({ currentVersion: '1.1.0' })).update, true);
  const later = Date.parse('2026-11-01T00:00:00.000Z');
  code(() => V.decide(manifest(RB), at({ currentVersion: '1.3.0', now: later })), 'expired');
  assert.deepEqual(V.decide(manifest(), at({ currentVersion: '1.2.0', now: later })), { update: false, expired: true });
  assert.deepEqual(V.decide(manifest(), at({ currentVersion: '1.1.0', now: later })), { update: true, rollback: false, expired: true });
  // a revert the person asked for is to an old release: no expiry
  assert.equal(V.decide(manifest(), at({ currentVersion: '1.3.0', revertTo: '1.2.0', now: later })).update, true);
});

// PoC 3 (security review): packages (the NSIS web installer) and another host were accepted.
test('checkUpdateInfo: web-installer packages and files on another server are refused', () => {
  const m = manifest();
  const base = 'https://download.plexiform.dev/';
  const good = { version: '1.2.0', files: [{ url: 'Plexiform-1.2.0-win-x64.exe', sha512: sha('win'), size: 3 }], path: 'Plexiform-1.2.0-win-x64.exe', sha512: sha('win') };
  assert.equal(V.checkUpdateInfo(good, m, { base }), true);
  assert.equal(V.checkUpdateInfo({ ...good, files: [{ ...good.files[0], url: `${base}Plexiform-1.2.0-win-x64.exe` }] }, m, { base }), true);
  code(() => V.checkUpdateInfo({ ...good, packages: { x64: { path: 'https://evil.example/p.7z', sha512: sha('p'), size: 5 } } }, m, { base }), 'verify');
  code(() => V.checkUpdateInfo({ ...good, files: [{ ...good.files[0], url: 'https://evil.example/any/Plexiform-1.2.0-win-x64.exe?x' }] }, m, { base }), 'verify');
  code(() => V.checkUpdateInfo({ ...good, path: 'https://evil.example/other.exe' }, m, { base }), 'verify');
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
