// scripts/release-sign.js: what CI signs is exactly what the app verifies.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Sign = require('../scripts/release-sign.js');
const V = require('../src/updater/verify.js');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const env = { PLEXIFORM_UPDATE_SIGNING_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') };
const keys = V.loadKeys([publicKey.export({ type: 'spki', format: 'pem' })]);
const sha = (b) => crypto.createHash('sha512').update(b).digest('base64');
const quiet = { log() {} };

function dist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-sign-'));
  const put = (name, body) => { fs.writeFileSync(path.join(dir, name), body); return body; };
  const zip = put('Plexiform-1.2.0-mac-arm64.zip', 'zip-bytes');
  put('Plexiform-1.2.0-mac-arm64.dmg', 'dmg-bytes');
  const exe = put('Plexiform-1.2.0-win-x64.exe', 'exe-bytes');
  put('Plexiform-1.2.0-win-x64.exe.blockmap', 'bm');
  put('Plexiform-1.2.0-linux-x86_64.AppImage', 'appimage');
  put('Plexiform-1.2.0-linux-amd64.deb', 'deb');
  put('SHA256SUMS.txt', 'x');
  put('latest.yml', `version: 1.2.0\nfiles:\n  - url: Plexiform-1.2.0-win-x64.exe\n    sha512: ${sha(exe)}\n    size: ${exe.length}\npath: Plexiform-1.2.0-win-x64.exe\nsha512: ${sha(exe)}\nreleaseDate: '2026-10-01T00:00:00.000Z'\n`);
  put('latest-mac.yml', `version: 1.2.0\nfiles:\n  - url: Plexiform-1.2.0-mac-arm64.zip\n    sha512: ${sha(zip)}\n    size: ${zip.length}\n`);
  return dir;
}

test('build: lists every installer, hashes it, and the signature verifies in the app', () => {
  const dir = dist();
  const notes = path.join(dir, 'notes.md');
  fs.writeFileSync(notes, 'What changed.');
  assert.equal(Sign.main(['build', dir, '--channel', 'stable', '--notes-file', notes], env, quiet), 0);
  const bytes = fs.readFileSync(path.join(dir, 'release.json'));
  const m = V.openManifest(bytes, fs.readFileSync(path.join(dir, 'release.json.sig'), 'utf8'), keys);
  assert.equal(m.version, '1.2.0');
  assert.equal(m.channel, 'stable');
  assert.equal(m.rollback, false);
  assert.equal(m.notes, 'What changed.');
  assert.deepEqual(m.files.map((f) => `${f.platform}/${f.arch}/${f.kind}`).sort(), ['darwin/arm64/dmg', 'darwin/arm64/mac-zip', 'linux/x64/appimage', 'linux/x64/deb', 'win32/x64/nsis']);
  const exe = m.files.find((f) => f.kind === 'nsis');
  assert.equal(exe.sha512, sha('exe-bytes'));
  assert.equal(exe.size, 9);
  assert.deepEqual(V.decide(m, { channel: 'stable', currentVersion: '1.1.0' }), { update: true, rollback: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('build fails without the key, unless --optional (beta), which writes nothing', () => {
  const dir = dist();
  assert.throws(() => Sign.main(['build', dir, '--channel', 'stable'], {}, quiet), /PLEXIFORM_UPDATE_SIGNING_KEY is not set/);
  const logs = [];
  assert.equal(Sign.main(['build', dir, '--channel', 'beta', '--optional'], {}, { log: (s) => logs.push(s) }), 0);
  assert.match(logs[0], /::warning::/);
  assert.ok(!fs.existsSync(path.join(dir, 'release.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('build refuses a feed file that disagrees with the installers, or mixed versions', () => {
  const dir = dist();
  fs.writeFileSync(path.join(dir, 'Plexiform-1.2.0-win-x64.exe'), 'rebuilt');
  assert.throws(() => Sign.buildManifest({ dir, channel: 'stable' }), /latest\.yml: .* checksum differs/);
  fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 1.2.0\n');
  fs.writeFileSync(path.join(dir, 'Plexiform-1.3.0-win-x64.exe'), 'x');
  assert.throws(() => Sign.buildManifest({ dir, channel: 'stable' }), /is version 1\.3\.0, not 1\.2\.0/);
  assert.throws(() => Sign.buildManifest({ dir, channel: 'nightly' }), /--channel/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resign --rollback: rollback:true and a fresh issuedAt, accepted as a downgrade past the old one', () => {
  const dir = dist();
  Sign.main(['build', dir, '--channel', 'stable'], env, quiet);
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'release-resign-'));
  assert.throws(() => Sign.main(['resign', path.join(dir, 'release.json')], env, quiet), /--rollback/);
  assert.throws(() => Sign.main(['resign', path.join(dir, 'release.json'), '--rollback'], {}, quiet), /must be signed/);
  Sign.main(['resign', path.join(dir, 'release.json'), '--rollback', '--out', out], env, quiet);
  const m = V.openManifest(fs.readFileSync(path.join(out, 'release.json')), fs.readFileSync(path.join(out, 'release.json.sig'), 'utf8'), keys);
  assert.equal(m.rollback, true);
  assert.ok(Date.parse(m.issuedAt) >= Date.parse(before.issuedAt));
  assert.deepEqual(m.files, before.files);
  // an app on 1.3.0 that last saw a manifest issued a moment ago takes it
  assert.deepEqual(V.decide(m, { channel: 'stable', currentVersion: '1.3.0', lastIssuedAt: before.issuedAt }), { update: true, rollback: true });
  for (const d of [dir, out]) fs.rmSync(d, { recursive: true, force: true });
});

test('parseFeed reads the files list of a latest*.yml', () => {
  assert.deepEqual(Sign.parseFeed("files:\n  - url: 'a b.zip'\n    sha512: abc\n    size: 12\n  - url: c.exe\n    sha512: def\npath: x\n"), [{ url: 'a b.zip', sha512: 'abc', size: 12 }, { url: 'c.exe', sha512: 'def' }]);
});
