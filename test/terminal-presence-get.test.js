'use strict';
// Get Plexiform Terminal: manifest checks, SHA-256, archive shape, install with
// put-back, and Open only by an exact installed path. No network: fetch is faked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const G = require('../src/terminal-presence-get');

const URL = 'https://github.com/CallumJB125/claude-traffic-light/releases/download/terminal-v0.2.0/Plexiform-Terminal-0.2.0-arm64.zip';
const tmp = (p = 'tpg-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fetchOf = (bytes, status = 200) => async () => ({ ok: status === 200, status, url: URL, body: (async function* () { yield bytes; })() });

// A zip holding `names` top-level entries; Plexiform Terminal.app gets an Info.plist with `id`.
function zipOf(names, id = 'dev.plexiform.terminal') {
  const src = tmp('tpg-src-'), zip = path.join(tmp('tpg-zip-'), 'a.zip');
  for (const n of names) {
    fs.mkdirSync(path.join(src, n, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(src, n, 'Contents', 'Info.plist'), JSON.stringify({ CFBundleIdentifier: id, CFBundleShortVersionString: '0.2.0' }));
  }
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', src, zip]);
  return fs.readFileSync(zip);
}
const readPlist = async (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('readManifest accepts only this repository\'s terminal-v* zip with a SHA-256', () => {
  const dir = tmp(), f = path.join(dir, 'm.json');
  const read = (m) => { fs.writeFileSync(f, JSON.stringify(m)); return G.readManifest(f); };
  assert.deepEqual(read({ version: '0.2.0', url: URL, sha256: 'a'.repeat(64) }), { version: '0.2.0', url: URL, sha256: 'a'.repeat(64) });
  for (const url of [null, 'http://github.com/CallumJB125/claude-traffic-light/releases/download/terminal-v1/a.zip', 'https://github.com/other/repo/releases/download/terminal-v1/a.zip',
    'https://github.com/CallumJB125/claude-traffic-light/releases/download/v1.0.0/a.zip', 'https://evil.example/CallumJB125/claude-traffic-light/releases/download/terminal-v1/a.zip']) assert.equal(read({ url, sha256: 'a'.repeat(64) }), null, String(url));
  assert.equal(read({ url: URL, sha256: 'A'.repeat(64) }), null);
  assert.equal(read({ url: URL }), null);
  assert.equal(G.readManifest(path.join(dir, 'missing.json')), null);
  assert.equal(G.readManifest(), null, 'the committed manifest is empty until a release is published');
});

test('get: no release published says so and installs nothing', async () => {
  const g = G.create({ platform: 'darwin', manifest: () => null });
  assert.equal(g.available(), false);
  assert.equal((await g.get()).code, 'NO_RELEASE');
  assert.equal((await G.create({ platform: 'linux', manifest: () => ({}) }).get()).code, 'UNSUPPORTED_PLATFORM');
});

test('get: a checksum mismatch or a wrong archive installs nothing', { skip: process.platform !== 'darwin' }, async () => {
  const apps = tmp();
  const bytes = zipOf(['Plexiform Terminal.app']);
  const mk = (b, m = sha(b)) => G.create({ platform: 'darwin', home: apps, manifest: () => ({ url: URL, sha256: m }), fetchImpl: fetchOf(b), readPlist, appDirs: [apps], tempDir: tmp() });
  assert.equal((await mk(bytes, 'b'.repeat(64)).get()).code, 'CHECKSUM');
  assert.equal((await mk(zipOf(['Other.app'])).get()).code, 'BAD_ARCHIVE');
  assert.equal((await mk(zipOf(['Plexiform Terminal.app', 'Extra.app'])).get()).code, 'BAD_ARCHIVE');
  assert.equal((await mk(zipOf(['Plexiform Terminal.app'], 'com.example.evil')).get()).code, 'BAD_ARCHIVE');
  assert.equal((await G.create({ platform: 'darwin', manifest: () => ({ url: URL, sha256: sha(bytes) }), fetchImpl: fetchOf(bytes, 404), appDirs: [apps], tempDir: tmp() }).get()).code, 'DOWNLOAD');
  assert.deepEqual(fs.readdirSync(apps), []);
});

test('get: installs into the first writable folder, replacing an old copy, and Open takes only that exact path', { skip: process.platform !== 'darwin' }, async () => {
  const locked = path.join(tmp(), 'locked'), apps = tmp(), work = tmp();
  fs.mkdirSync(locked, { mode: 0o500 });
  fs.mkdirSync(path.join(apps, 'Plexiform Terminal.app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(apps, 'Plexiform Terminal.app', 'Contents', 'old'), 'x');
  const bytes = zipOf(['Plexiform Terminal.app']);
  const opened = [];
  const real = (f, a) => new Promise((res, rej) => require('node:child_process').execFile(f, a, (e, out) => e ? rej(e) : res(out)));
  const exec = async (f, a) => (f === '/usr/bin/open' ? (opened.push(a), '') : real(f, a));
  const g = G.create({ platform: 'darwin', home: apps, manifest: () => ({ version: '0.2.0', url: URL, sha256: sha(bytes) }), fetchImpl: fetchOf(bytes), readPlist, exec, appDirs: [locked, apps], tempDir: work });
  const [a, b] = [g.get(), g.get()];
  assert.equal(a, b, 'a second click joins the first');
  const r = await a;
  assert.deepEqual(r, { ok: true, path: path.join(apps, 'Plexiform Terminal.app'), version: '0.2.0' });
  assert.ok(!fs.existsSync(path.join(r.path, 'Contents', 'old')), 'the old copy was replaced');
  assert.deepEqual(fs.readdirSync(apps), ['Plexiform Terminal.app'], 'nothing left aside');
  assert.deepEqual(fs.readdirSync(work), [], 'the temporary download is gone');
  assert.deepEqual(await g.open(r.path), { ok: true });
  assert.deepEqual(opened, [[r.path]]);
  for (const p of ['/Applications/Evil.app', `${apps}/../Plexiform Terminal.app`, 'Plexiform Terminal', null]) assert.deepEqual(await g.open(p), { ok: false, code: 'NOT_INSTALLED' }, String(p));
  fs.chmodSync(locked, 0o700);
});
