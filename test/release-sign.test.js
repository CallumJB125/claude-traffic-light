// scripts/release-sign.js: what the promote workflow signs is exactly what
// the app verifies, and it signs nothing it hasn't checked.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Sign = require('../scripts/release-sign.js');
const V = require('../src/updater/verify.js');

const stable = crypto.generateKeyPairSync('ed25519');
const beta = crypto.generateKeyPairSync('ed25519');
const b64 = (k) => Buffer.from(k.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
const env = { PLEXIFORM_UPDATE_SIGNING_KEY: b64(stable), PLEXIFORM_UPDATE_SIGNING_KEY_BETA: b64(beta) };
const keys = V.loadKeyring({ stable: [stable.publicKey.export({ type: 'spki', format: 'pem' })], beta: [beta.publicKey.export({ type: 'spki', format: 'pem' })] });
const sha = (b) => crypto.createHash('sha512').update(b).digest('base64');
const quiet = { log() {} };
const run = (argv, e = env, log = quiet) => Sign.main(argv, e, log, keys);
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `release-sign-${tag}-`));
const readSigned = (dir, channel = 'stable') => V.openManifest(fs.readFileSync(path.join(dir, 'release.json')), fs.readFileSync(path.join(dir, 'release.json.sig'), 'utf8'), keys, { channel });

function dist(version = '1.2.0', { feed = 'latest' } = {}) {
  const dir = tmp('dist');
  const put = (name, body) => { fs.writeFileSync(path.join(dir, name), body); return body; };
  const zip = put(`Plexiform-${version}-mac-arm64.zip`, `zip-bytes ${version}`);
  put(`Plexiform-${version}-mac-arm64.dmg`, 'dmg-bytes');
  const exe = put(`Plexiform-${version}-win-x64.exe`, `exe-bytes ${version}`);
  put(`Plexiform-${version}-win-x64.exe.blockmap`, 'bm');
  put(`Plexiform-${version}-linux-x86_64.AppImage`, 'appimage');
  put(`Plexiform-${version}-linux-amd64.deb`, 'deb');
  put('SHA256SUMS.txt', 'x');
  put(`${feed}.yml`, `version: ${version}\nfiles:\n  - url: Plexiform-${version}-win-x64.exe\n    sha512: ${sha(exe)}\n    size: ${exe.length}\npath: Plexiform-${version}-win-x64.exe\nsha512: ${sha(exe)}\nreleaseDate: '2026-10-01T00:00:00.000Z'\n`);
  put(`${feed}-mac.yml`, `version: ${version}\nfiles:\n  - url: Plexiform-${version}-mac-arm64.zip\n    sha512: ${sha(zip)}\n    size: ${zip.length}\n`);
  return dir;
}

test('build: lists every installer, hashes it, signs with a fresh issuedAt and a 30-day expiry, and the app opens it', () => {
  const dir = dist();
  const notes = path.join(dir, 'notes.md');
  fs.writeFileSync(notes, 'What changed.');
  const before = Date.now();
  assert.equal(run(['build', dir, '--channel', 'stable', '--version', '1.2.0', '--notes-file', notes]), 0);
  const m = readSigned(dir);
  assert.equal(m.version, '1.2.0');
  assert.equal(m.rollback, false);
  assert.equal(m.rollbackFrom, undefined);
  assert.equal(m.notes, 'What changed.');
  assert.ok(Date.parse(m.issuedAt) >= before - 1000);
  assert.equal(Date.parse(m.expiresAt) - Date.parse(m.issuedAt), Sign.EXPIRES_DAYS * V.DAY_MS);
  assert.deepEqual(m.files.map((f) => `${f.platform}/${f.arch}/${f.kind}`).sort(), ['darwin/arm64/dmg', 'darwin/arm64/mac-zip', 'linux/x64/appimage', 'linux/x64/deb', 'win32/x64/nsis']);
  const exe = m.files.find((f) => f.kind === 'nsis');
  assert.equal(exe.sha512, sha('exe-bytes 1.2.0'));
  assert.deepEqual(V.decide(m, { channel: 'stable', currentVersion: '1.1.0' }), { update: true, rollback: false, expired: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('build fails without the key, or with a key that is not the one this repo ships for the channel', () => {
  const dir = dist();
  assert.throws(() => run(['build', dir, '--channel', 'stable', '--version', '1.2.0'], {}), /PLEXIFORM_UPDATE_SIGNING_KEY is not set/);
  assert.throws(() => run(['build', dir, '--channel', 'stable', '--version', '1.2.0'], { PLEXIFORM_UPDATE_SIGNING_KEY: env.PLEXIFORM_UPDATE_SIGNING_KEY_BETA }), /does not match build\/update-key\.pub\.pem/);
  const other = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => run(['build', dir, '--channel', 'stable', '--version', '1.2.0'], { PLEXIFORM_UPDATE_SIGNING_KEY: b64(other) }), /does not match/);
  assert.ok(!fs.existsSync(path.join(dir, 'release.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('beta: beta*.yml feed files, signed with the beta key only, opened only on the beta channel', () => {
  const dir = dist('1.2.0-beta.4', { feed: 'beta' });
  assert.throws(() => run(['build', dir, '--channel', 'beta', '--version', '1.2.0-beta.4'], { PLEXIFORM_UPDATE_SIGNING_KEY: env.PLEXIFORM_UPDATE_SIGNING_KEY }), /PLEXIFORM_UPDATE_SIGNING_KEY_BETA is not set/);
  assert.throws(() => run(['build', dir, '--channel', 'beta', '--version', '1.2.0-beta.4'], { PLEXIFORM_UPDATE_SIGNING_KEY_BETA: env.PLEXIFORM_UPDATE_SIGNING_KEY }), /does not match build\/update-key-beta\.pub\.pem/);
  run(['build', dir, '--channel', 'beta', '--version', '1.2.0-beta.4']);
  assert.equal(readSigned(dir, 'beta').channel, 'beta');
  assert.throws(() => readSigned(dir, 'stable'), (e) => e.code === 'signature');
  // the feed check reads beta*.yml too
  fs.writeFileSync(path.join(dir, 'Plexiform-1.2.0-beta.4-win-x64.exe'), 'rebuilt');
  assert.throws(() => Sign.buildManifest({ dir, channel: 'beta', version: '1.2.0-beta.4' }), /beta\.yml: .* checksum differs/);
  for (const n of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml', 'beta.yml', 'beta-mac.yml', 'beta-linux.yml', 'alpha.yml']) assert.ok(Sign.FEED.test(n), n);
  assert.ok(!Sign.FEED.test('builder-debug.yml'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('check and version: the stage job\'s early checks, which need no key', () => {
  const dir = dist();
  const logs = [];
  assert.equal(Sign.main(['check', dir, '--channel', 'stable', '--version', '1.2.0'], {}, { log: (s) => logs.push(s) }, keys), 0);
  assert.match(logs[0], /5 installers/);
  assert.ok(!fs.existsSync(path.join(dir, 'release.json')));
  logs.length = 0;
  Sign.main(['version', dir], {}, { log: (s) => logs.push(s) }, keys);
  assert.deepEqual(logs, ['1.2.0']);
  fs.writeFileSync(path.join(dir, 'Plexiform-1.3.0-win-x64.exe'), 'x');
  assert.throws(() => Sign.main(['version', dir], {}, quiet, keys), /not one version/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('build refuses a feed file that disagrees with the installers, or another version', () => {
  const dir = dist();
  fs.writeFileSync(path.join(dir, 'Plexiform-1.2.0-win-x64.exe'), 'rebuilt');
  assert.throws(() => Sign.buildManifest({ dir, channel: 'stable', version: '1.2.0' }), /latest\.yml: .* checksum differs/);
  fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 1.2.0\n');
  fs.writeFileSync(path.join(dir, 'Plexiform-1.3.0-win-x64.exe'), 'x');
  assert.throws(() => Sign.buildManifest({ dir, channel: 'stable', version: '1.2.0' }), /is version 1\.3\.0, not 1\.2\.0/);
  assert.throws(() => Sign.buildManifest({ dir, channel: 'nightly', version: '1.2.0' }), /--channel/);
  assert.throws(() => Sign.buildManifest({ dir, channel: 'stable', version: '$(id)' }), /--version/);
  fs.rmSync(dir, { recursive: true, force: true });
});

function live(version, over = {}) {
  const d = dist(version);
  run(['build', d, '--channel', 'stable', '--version', version, ...(over.args || [])]);
  return d;
}

// H5 (code review): an older version promoted after a newer one was signed
// with an old issuedAt and refused by every app, or rolled them back silently.
test('H5: promoting an older version than the live one needs rollback; a rollback is signed fresh and names what it rolls back from', () => {
  const liveDir = live('1.3.0');
  const liveM = readSigned(liveDir);
  const dir = dist('1.2.0');
  assert.throws(() => run(['build', dir, '--channel', 'stable', '--version', '1.2.0', '--live', liveDir]), /older than the live 1\.3\.0: tick rollback/);
  run(['build', dir, '--channel', 'stable', '--version', '1.2.0', '--live', liveDir, '--rollback', '--rollback-from', '1.2.5']);
  const m = readSigned(dir);
  assert.equal(m.rollback, true);
  assert.deepEqual(m.rollbackFrom, ['1.2.5', '1.3.0']);
  assert.ok(Date.parse(m.issuedAt) >= Date.parse(liveM.issuedAt));
  // apps on 1.3.0 that accepted the live manifest take it
  assert.equal(V.decide(m, { channel: 'stable', currentVersion: '1.3.0', lastIssuedAt: liveM.issuedAt }).rollback, true);
  // a rollback can't be to a newer version, and needs something to roll back from
  assert.throws(() => run(['build', dist('1.4.0'), '--channel', 'stable', '--version', '1.4.0', '--live', liveDir, '--rollback']), /must be older than the live/);
  assert.throws(() => run(['build', dist('1.2.0'), '--channel', 'stable', '--version', '1.2.0', '--live', tmp('empty'), '--rollback']), /needs the versions it rolls back from/);
  // a rollback of a rollback keeps the versions the first one rolled back from
  const second = dist('1.1.0');
  run(['build', second, '--channel', 'stable', '--version', '1.1.0', '--live', dir, '--rollback']);
  assert.deepEqual(readSigned(second).rollbackFrom, ['1.2.0', '1.2.5', '1.3.0']);
  // re-promoting the live version (or a newer one) is an ordinary, fresh signature
  const again = dist('1.3.0');
  run(['build', again, '--channel', 'stable', '--version', '1.3.0', '--live', liveDir]);
  assert.equal(readSigned(again).rollback, false);
});

test('a live manifest that does not verify with this repo\'s key stops the promote', () => {
  const liveDir = live('1.3.0');
  fs.writeFileSync(path.join(liveDir, 'release.json'), fs.readFileSync(path.join(liveDir, 'release.json'), 'utf8').replace('1.3.0', '1.0.0'));
  assert.throws(() => run(['build', dist('1.2.0'), '--channel', 'stable', '--version', '1.2.0', '--live', liveDir]), /not signed/);
});

// PoC 2 / H1 (both security reviews): resign signed whatever release.json R2 served.
test('PoC 2: resign refuses a manifest that does not verify, another version or channel, or files that differ', () => {
  const d = tmp('poc2');
  const evil = { product: 'plexiform', channel: 'stable', version: '1.0.0', issuedAt: '2026-03-01T00:00:00.000Z', expiresAt: '2026-03-31T00:00:00.000Z', rollback: false, notes: '', files: [{ name: 'Plexiform-1.0.0-win-x64.exe', sha512: sha('MALWARE'), size: 7, platform: 'win32', arch: 'x64', kind: 'nsis' }] };
  fs.writeFileSync(path.join(d, 'release.json'), JSON.stringify(evil));
  fs.writeFileSync(path.join(d, 'release.json.sig'), 'AAAA\n');
  assert.throws(() => run(['resign', path.join(d, 'release.json'), '--channel', 'stable', '--version', '1.0.0', '--rollback', '--rollback-from', '1.1.0']), /not signed/);
  assert.equal(fs.readFileSync(path.join(d, 'release.json.sig'), 'utf8'), 'AAAA\n', 'nothing written');

  const good = live('1.2.0');
  const file = path.join(good, 'release.json');
  const base = ['--rollback', '--rollback-from', '1.3.0'];
  assert.throws(() => run(['resign', file, '--channel', 'stable', '--version', '1.2.1', ...base]), /is for 1\.2\.0, not 1\.2\.1/);
  assert.throws(() => run(['resign', file, '--channel', 'beta', '--version', '1.2.0', ...base]), /not signed with Plexiform's beta key|PLEXIFORM_UPDATE_SIGNING_KEY_BETA/);
  const assets = dist('1.2.0');
  fs.writeFileSync(path.join(assets, 'Plexiform-1.2.0-win-x64.exe'), 'other bytes');
  assert.throws(() => run(['resign', file, '--channel', 'stable', '--version', '1.2.0', '--check-dir', assets, ...base]), /is not the file the release names/);

  const before = readSigned(good);
  const out = tmp('out');
  run(['resign', file, '--channel', 'stable', '--version', '1.2.0', '--check-dir', good, '--out', out, ...base]);
  const after = readSigned(out);
  assert.deepEqual(after.files, before.files);
  assert.equal(after.version, '1.2.0');
  assert.equal(after.rollback, true);
  assert.deepEqual(after.rollbackFrom, ['1.3.0']);
  assert.ok(Date.parse(after.expiresAt) > Date.parse(after.issuedAt));
  const { issuedAt: _a, expiresAt: _b, rollback: _c, rollbackFrom: _d, ...rest } = after;
  const { issuedAt: _e, expiresAt: _f, rollback: _g, ...restBefore } = before;
  assert.deepEqual(rest, restBefore, 'nothing else changed');
});

test('verify-files: what R2 staged must be the files the signed release names', () => {
  const signedDir = live('1.2.0');
  const staged = dist('1.2.0');
  assert.equal(run(['verify-files', path.join(signedDir, 'release.json'), staged, '--channel', 'stable']), 0);
  fs.writeFileSync(path.join(staged, 'Plexiform-1.2.0-linux-amd64.deb'), 'swapped');
  assert.throws(() => run(['verify-files', path.join(signedDir, 'release.json'), staged, '--channel', 'stable']), /deb in .* is not the file/);
  fs.rmSync(path.join(staged, 'Plexiform-1.2.0-linux-amd64.deb'));
  assert.throws(() => run(['verify-files', path.join(signedDir, 'release.json'), staged, '--channel', 'stable']), /is missing/);
});

test('parseFeed reads the files list of a latest*.yml', () => {
  assert.deepEqual(Sign.parseFeed("files:\n  - url: 'a b.zip'\n    sha512: abc\n    size: 12\n  - url: c.exe\n    sha512: def\npath: x\n"), [{ url: 'a b.zip', sha512: 'abc', size: 12 }, { url: 'c.exe', sha512: 'def' }]);
});

test('the real keys: keyFromEnv checks against the public keys in build/', () => {
  const stray = crypto.generateKeyPairSync('ed25519');
  assert.equal(Sign.keyFromEnv('stable', {}), null);
  assert.throws(() => Sign.keyFromEnv('stable', { PLEXIFORM_UPDATE_SIGNING_KEY: b64(stray) }), /does not match build\/update-key\.pub\.pem/);
  assert.throws(() => Sign.keyFromEnv('beta', { PLEXIFORM_UPDATE_SIGNING_KEY_BETA: b64(stray) }), /does not match build\/update-key-beta\.pub\.pem/);
});
