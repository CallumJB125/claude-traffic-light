// The updater service end to end against a fake feed on 127.0.0.1: signed
// manifests, the refusals, resumable downloads, busy deferral, the .deb and
// electron-updater back-ends, revert, persistence and the IPC contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createService } = require('../src/updater/service.js');
const Deb = require('../src/updater/deb.js');
const EU = require('../src/updater/electron-updater.js');
const Updater = require('../src/updater/index.js');
const V = require('../src/updater/verify.js');
const { keyPair, startFeed, publish, sha, tmpDir } = require('./updater-feed.js');

const { privateKey, betaKey, keys } = keyPair();
const quiet = { warn() {}, log() {} };
const DEB = (v, body = `deb ${v} `.repeat(2000)) => ({ name: `Plexiform-${v}-linux-amd64.deb`, body, platform: 'linux', arch: 'x64', kind: 'deb' });
const EXE = (v, body = `exe ${v}`) => ({ name: `Plexiform-${v}-win-x64.exe`, body, platform: 'win32', arch: 'x64', kind: 'nsis' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const daysAgo = (n) => new Date(Date.now() - n * V.DAY_MS).toISOString();

let feed;
test.before(async () => { feed = await startFeed(); });
test.after(() => feed.close());
test.beforeEach(() => { feed.files.clear(); feed.requests.length = 0; feed.cut.clear(); feed.hang.clear(); });

// A child_process.spawn stand-in: records the call, then 'spawn' (or 'error' with code fail).
function spawnStub(spawned, { fail = null } = {}) {
  return (cmd, args) => {
    spawned.push([cmd, ...args]);
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => (fail ? child.emit('error', Object.assign(new Error(fail), { code: fail })) : child.emit('spawn')));
    return child;
  };
}

function seedStore(userData, patch) {
  const file = path.join(userData, 'updater.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  fs.writeFileSync(file, JSON.stringify({ ...cur, ...patch }));
}

function debRig({ currentVersion = '1.1.0', autoDownload = true, isBusy = () => null, spawnFail = null, userData = tmpDir('ud'), store = null, stallMs, ...over } = {}) {
  const downloads = tmpDir('dl');
  const spawned = [];
  const backend = Deb.create({ fetch, userData, downloadsDir: downloads, spawn: spawnStub(spawned, { fail: spawnFail }), stallMs });
  fs.mkdirSync(userData, { recursive: true });
  seedStore(userData, { autoDownload, ...store });
  const svc = createService({ fetch, keyring: keys, feedBase: feed.base, currentVersion, userData, backend, isBusy, platform: 'linux', arch: 'x64', retryDelayMs: 0, log: quiet, ...over });
  const seen = [];
  svc.subscribe((s) => seen.push(s.status));
  return { svc, backend, downloads, userData, spawned, seen };
}

test('a valid update: available, downloading, ready, and only the verified file lands in Downloads', async () => {
  const deb = DEB('1.2.0');
  publish(feed, { privateKey, version: '1.2.0', files: [deb, EXE('1.2.0')] });
  const { svc, downloads, seen } = debRig();
  assert.deepEqual(await svc.check(), { ok: true });
  const s = svc.getState();
  assert.equal(s.status, 'ready');
  assert.equal(s.available.version, '1.2.0');
  assert.equal(s.available.size, Buffer.byteLength(deb.body));
  assert.equal(s.installKind, 'deb-manual');
  assert.ok(s.lastCheckedAt);
  assert.deepEqual([...new Set(seen)], ['checking', 'available', 'downloading', 'ready']);
  assert.equal(fs.readFileSync(path.join(downloads, deb.name), 'utf8'), deb.body);
});

test('B2: a fresh install never downloads on its own: autoDownload is off until turned on', async () => {
  publish(feed, { privateKey, version: '1.2.0', files: [DEB('1.2.0')] });
  const { svc, downloads } = debRig({ autoDownload: false });
  assert.equal(svc.getState().autoDownload, false);
  assert.deepEqual(await svc.check(), { ok: true });
  assert.equal(svc.getState().status, 'available');
  assert.deepEqual(fs.readdirSync(downloads), []);
  assert.equal(feed.requests.filter((r) => r.path.endsWith('.deb')).length, 0);
});

test('up to date: idle, no offer', async () => {
  publish(feed, { privateKey, version: '1.1.0', files: [DEB('1.1.0')] });
  const { svc } = debRig();
  await svc.check();
  assert.equal(svc.getState().status, 'idle');
  assert.equal(svc.getState().available, null);
  assert.deepEqual(svc.healthStatus(), { state: 'current', version: '1.1.0' });
});

test('a tampered file is refused (verify) and never reaches Downloads', async () => {
  const deb = DEB('1.2.0');
  publish(feed, { privateKey, version: '1.2.0', files: [deb], servedBodies: { [deb.name]: deb.body.replace('deb', 'bad') } });
  const { svc, downloads } = debRig();
  assert.deepEqual(await svc.check(), { ok: false, error: 'verify' });
  assert.equal(svc.getState().error.code, 'verify');
  assert.deepEqual(fs.readdirSync(downloads), []);
});

test('a tampered manifest, a wrong-key signature, a missing signature: refused (signature)', async () => {
  publish(feed, { privateKey, version: '1.2.0', files: [DEB('1.2.0')] });
  feed.put('/release.json', feed.files.get('/release.json').toString().replace('"1.2.0"', '"1.2.1"'));
  let { svc } = debRig();
  assert.deepEqual(await svc.check({ user: true }), { ok: false, error: 'signature' });
  assert.equal(feed.requests.filter((r) => r.path === '/release.json').length, 2, 'retried once (a promote in flight)');

  publish(feed, { privateKey: keyPair().privateKey, version: '1.2.0', files: [DEB('1.2.0')] });
  ({ svc } = debRig());
  assert.deepEqual(await svc.check({ user: true }), { ok: false, error: 'signature' });
  assert.equal(svc.getState().available, null);

  // the beta key never signs for a stable install
  publish(feed, { privateKey: betaKey, version: '1.2.0', files: [DEB('1.2.0')] });
  ({ svc } = debRig());
  assert.deepEqual(await svc.check({ user: true }), { ok: false, error: 'signature' });

  feed.files.delete('/release.json.sig');
  ({ svc } = debRig());
  assert.deepEqual(await svc.check({ user: true }), { ok: false, error: 'server' });
});

test('the wrong channel or product is refused', async () => {
  publish(feed, { privateKey, version: '1.2.0', channel: 'beta', files: [DEB('1.2.0')] });
  let { svc } = debRig();
  assert.deepEqual(await svc.check(), { ok: false, error: 'verify' });
  assert.match(svc.getState().error.detail, /beta channel/);
  publish(feed, { privateKey, version: '1.2.0', product: 'other-app', files: [DEB('1.2.0')] });
  ({ svc } = debRig());
  assert.deepEqual(await svc.check(), { ok: false, error: 'verify' });
});

test('a downgrade is refused; a signed rollback for this version is accepted; an older issuedAt is a replay', async () => {
  const userData = tmpDir('ud');
  publish(feed, { privateKey, version: '1.0.0', files: [DEB('1.0.0')], issuedAt: daysAgo(3) });
  let { svc } = debRig({ userData });
  assert.deepEqual(await svc.check(), { ok: false, error: 'downgrade' });

  // a rollback from other versions only
  publish(feed, { privateKey, version: '1.0.0', rollback: true, rollbackFrom: ['1.0.5'], files: [DEB('1.0.0')], issuedAt: daysAgo(1) });
  ({ svc } = debRig({ userData, autoDownload: false }));
  assert.deepEqual(await svc.check(), { ok: false, error: 'downgrade' });

  const rbIssued = daysAgo(1);
  publish(feed, { privateKey, version: '1.0.0', rollback: true, rollbackFrom: ['1.1.0'], files: [DEB('1.0.0')], issuedAt: rbIssued });
  ({ svc } = debRig({ userData, autoDownload: false }));
  assert.deepEqual(await svc.check(), { ok: true });
  assert.equal(svc.getState().status, 'available');
  assert.equal(svc.getState().available.version, '1.0.0');

  // the pre-rollback release, validly signed but issued earlier, served again
  publish(feed, { privateKey, version: '1.2.0', files: [DEB('1.2.0')], issuedAt: daysAgo(2) });
  ({ svc } = debRig({ userData }));
  assert.deepEqual(await svc.check(), { ok: false, error: 'verify' });
  assert.match(svc.getState().error.detail, /replayed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'updater.json'), 'utf8')).lastIssuedAt.stable, rbIssued);
});

// PoC 1 (security review): an old signed rollback was accepted on a fresh
// install, and by an install whose floor was that rollback.
test('PoC 1: the build time is the floor, so an old signed rollback is refused even on a fresh install', async () => {
  const rbIssued = '2026-03-01T00:00:00.000Z';
  publish(feed, { privateKey, version: '1.0.0', rollback: true, rollbackFrom: ['2.0.0'], issuedAt: rbIssued, files: [DEB('1.0.0')] });
  for (const store of [null, { lastIssuedAt: { stable: rbIssued } }]) {
    const { svc } = debRig({ currentVersion: '2.0.0', store, builtAt: '2026-09-01T00:00:00.000Z', autoDownload: false });
    assert.deepEqual(await svc.check(), { ok: false, error: 'verify' });
    assert.match(svc.getState().error.detail, /before this version was built/);
  }
  // a rollback that doesn't name 2.0.0 is refused regardless of when it was signed
  publish(feed, { privateKey, version: '1.0.0', rollback: true, rollbackFrom: ['1.5.0'], files: [DEB('1.0.0')] });
  const { svc } = debRig({ currentVersion: '2.0.0', builtAt: '2026-09-01T00:00:00.000Z', autoDownload: false });
  assert.deepEqual(await svc.check(), { ok: false, error: 'downgrade' });
});

test('a release past its expiresAt: an update still offered, "up to date" becomes an expired error', async () => {
  publish(feed, { privateKey, version: '1.1.0', files: [DEB('1.1.0')], issuedAt: daysAgo(40), expiresAt: daysAgo(10) });
  let { svc } = debRig({ autoDownload: false });
  assert.deepEqual(await svc.check(), { ok: true });
  assert.equal(svc.getState().status, 'error');
  assert.equal(svc.getState().error.code, 'expired');
  assert.match(svc.getState().error.detail, /Couldn't confirm Plexiform is up to date since/);
  assert.equal(svc.healthStatus().state, 'error');
  publish(feed, { privateKey, version: '1.2.0', files: [DEB('1.2.0')], issuedAt: daysAgo(40), expiresAt: daysAgo(10) });
  ({ svc } = debRig({ autoDownload: false }));
  await svc.check();
  assert.equal(svc.getState().status, 'available');
});

test('a manifest issued more than a day in the future is refused', async () => {
  publish(feed, { privateKey, version: '1.2.0', files: [DEB('1.2.0')], issuedAt: new Date(Date.now() + 2 * V.DAY_MS).toISOString() });
  const { svc } = debRig();
  assert.deepEqual(await svc.check(), { ok: false, error: 'verify' });
  assert.match(svc.getState().error.detail, /in the future/);
});

test('an interrupted download resumes with Range where it stopped', async () => {
  const deb = DEB('1.2.0');
  publish(feed, { privateKey, version: '1.2.0', files: [deb] });
  feed.cut.set(`/${deb.name}`, 5000);
  const { svc, downloads } = debRig();
  assert.deepEqual(await svc.check(), { ok: false, error: 'offline' });
  assert.equal(svc.getState().available.version, '1.2.0', 'the offer survives a failed download');
  assert.deepEqual(await svc.download(), { ok: true });
  const gets = feed.requests.filter((r) => r.path === `/${deb.name}`);
  assert.equal(gets.length, 2);
  assert.equal(gets[1].range, 'bytes=5000-');
  assert.ok(gets[1].ifRange, 'If-Range carries the ETag');
  assert.equal(fs.readFileSync(path.join(downloads, deb.name), 'utf8'), deb.body);
});

test('H1: a manifest that never finishes times out (offline) and the check can run again', async () => {
  publish(feed, { privateKey, version: '1.2.0', files: [DEB('1.2.0')] });
  feed.hang.set('/release.json', 0);
  const { svc } = debRig({ autoDownload: false, fetchTimeoutMs: 150 });
  const r = await svc.check({ user: true });
  assert.deepEqual(r, { ok: false, error: 'offline' });
  assert.match(svc.getState().error.detail, /did not answer within/);
  feed.hang.clear();
  assert.deepEqual(await svc.check({ user: true }), { ok: true });
  assert.equal(svc.getState().status, 'available');
});

test('H1: a download that stalls is dropped (offline), and the next try resumes it', async () => {
  const deb = DEB('1.2.0');
  publish(feed, { privateKey, version: '1.2.0', files: [deb] });
  feed.hang.set(`/${deb.name}`, 5000);
  const { svc, downloads } = debRig({ stallMs: 150 });
  assert.deepEqual(await svc.check(), { ok: false, error: 'offline' });
  assert.match(svc.getState().error.detail, /stalled/);
  feed.hang.clear();
  assert.deepEqual(await svc.download(), { ok: true });
  assert.equal(fs.readFileSync(path.join(downloads, deb.name), 'utf8'), deb.body);
});

test('H3: a scheduled check that cannot reach the server keeps the offer; a check the person asked for shows the error', async () => {
  publish(feed, { privateKey, version: '1.2.0', files: [DEB('1.2.0')] });
  const { svc } = debRig({ autoDownload: false });
  await svc.check();
  assert.equal(svc.getState().status, 'available');
  feed.files.clear();
  assert.deepEqual(await svc.check(), { ok: false, error: 'server', kept: true });
  const s = svc.getState();
  assert.equal(s.status, 'available');
  assert.equal(s.available.version, '1.2.0');
  assert.equal(s.error, null);
  assert.deepEqual(await svc.check({ user: true }), { ok: false, error: 'server' });
  assert.equal(svc.getState().status, 'error');
});

test('a corrupt partial is discarded and the file fetched again from zero', async () => {
  const deb = DEB('1.2.0');
  publish(feed, { privateKey, version: '1.2.0', files: [deb] });
  const { svc, downloads, userData } = debRig({ autoDownload: false });
  await svc.check();
  const partial = path.join(userData, 'updates', 'partial', `${deb.name}.part`);
  fs.mkdirSync(path.dirname(partial), { recursive: true });
  fs.writeFileSync(partial, 'x'.repeat(4000));
  fs.writeFileSync(`${partial}.json`, JSON.stringify({ url: `${feed.base}/${deb.name}`, sha512: sha(deb.body), etag: null }));
  assert.deepEqual(await svc.download(), { ok: true });
  const gets = feed.requests.filter((r) => r.path === `/${deb.name}`);
  assert.deepEqual(gets.map((g) => g.range), ['bytes=4000-', null]);
  assert.equal(fs.readFileSync(path.join(downloads, deb.name), 'utf8'), deb.body);
  assert.ok(!fs.existsSync(partial));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(userData, 'updates')).mode & 0o777, 0o700, 'updates/ is 0700');
});

function euRigBusy({ busy, ...over }) {
  const exe = EXE('1.2.0');
  publish(feed, { privateKey, version: '1.2.0', files: [exe] });
  const au = fakeUpdater({ info: { version: '1.2.0', files: [{ url: exe.name, sha512: sha(exe.body), size: exe.body.length }] } });
  const svc = euRig(au, { isBusy: () => busy.value, ...over });
  return { svc, au };
}

// A clock and timers the test moves by hand (no real waiting, so no flakes under load).
function fakeTime() {
  const clock = { t: Date.parse('2026-10-01T12:00:00.000Z'), timers: [] };
  clock.now = () => clock.t;
  clock.setTimer = (fn, ms) => { const h = { fn, at: clock.t + ms }; clock.timers.push(h); return h; };
  clock.clearTimer = (h) => { const i = clock.timers.indexOf(h); if (i >= 0) clock.timers.splice(i, 1); };
  clock.advance = async (ms) => {
    const end = clock.t + ms;
    for (;;) {
      const due = clock.timers.filter((h) => h.at <= end).sort((x, y) => x.at - y.at)[0];
      if (!due) break;
      clock.timers.splice(clock.timers.indexOf(due), 1);
      clock.t = due.at;
      due.fn();
      await new Promise((r) => setImmediate(r));
    }
    clock.t = end;
  };
  return clock;
}

test('install now while busy is deferred with busyReason; "when idle" installs after the idle window', async () => {
  const busy = { value: 'A session in app is working.' };
  const clock = fakeTime();
  const { svc, au } = euRigBusy({ busy, idleMs: 30000, idlePollMs: 5000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await svc.check();
  await svc.download();
  assert.equal(svc.getState().status, 'ready');
  assert.deepEqual(await svc.install({ when: 'now' }), { ok: false, error: 'busy', deferred: true });
  assert.equal(svc.getState().busyReason, busy.value);
  assert.equal(au.installs.length, 0, 'nothing installed');
  assert.deepEqual(await svc.install({ when: 'idle' }), { ok: true, deferred: true });
  await clock.advance(60000);
  assert.equal(au.installs.length, 0, 'still busy');
  busy.value = null;
  await clock.advance(20000);
  assert.equal(au.installs.length, 0, 'idle, but not for long enough');
  assert.equal(svc.getState().busyReason, null);
  await clock.advance(15000);
  assert.equal(au.installs.length, 1, 'installed once idle for the window');
});

test('"Restart anyway": force skips the busy check', async () => {
  const busy = { value: 'x' };
  const { svc, au } = euRigBusy({ busy });
  await svc.check();
  await svc.download();
  assert.deepEqual(await svc.install({ when: 'now', force: true }), { ok: true });
  assert.equal(au.installs.length, 1);
  assert.deepEqual(await svc.install({ when: 'later' }), { ok: false, error: 'bad-when' });
});

test('M3: a deferred install\'s busyReason clears once the sessions settle, and when the update stops waiting', async () => {
  const busy = { value: 'A session in app is working.' };
  const clock = fakeTime();
  const { svc } = euRigBusy({ busy, idlePollMs: 5000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await svc.check();
  await svc.download();
  await svc.install({ when: 'now' });
  assert.equal(svc.getState().busyReason, busy.value);
  await clock.advance(5000);
  assert.equal(svc.getState().busyReason, busy.value, 'still busy');
  busy.value = null;
  await clock.advance(5000);
  assert.equal(svc.getState().busyReason, null);
  assert.equal(clock.timers.length, 0, 'the watch stops');
  busy.value = 'again';
  await svc.install({ when: 'now' });
  assert.equal(svc.getState().busyReason, 'again');
  await svc.install({ when: 'now', force: true });
  assert.equal(svc.getState().status, 'installing');
  assert.equal(svc.getState().busyReason, null, 'only an update waiting to install has a reason to wait');
  svc.stop();
});

test('H2: an install that never quits the app returns to ready with install-stalled', async () => {
  const clock = fakeTime();
  const { svc, au } = euRigBusy({ busy: { value: null }, installStallMs: 150000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await svc.check();
  await svc.download();
  assert.deepEqual(await svc.install({ when: 'now' }), { ok: true });
  assert.equal(svc.getState().status, 'installing');
  assert.deepEqual(au.installs[0], [true, true], 'M4: silent, and runs the new version after');
  await clock.advance(149000);
  assert.equal(svc.getState().status, 'installing');
  await clock.advance(2000);
  const s = svc.getState();
  assert.equal(s.status, 'ready');
  assert.equal(s.error.code, 'install-stalled');
  // and it can be tried again
  assert.deepEqual(await svc.install({ when: 'now' }), { ok: true });
  assert.equal(au.installs.length, 2);
  svc.stop();
});

test('the .deb path: install re-checks the file, opens it with xdg-open, the app keeps running, and nothing waits on busy', async () => {
  const deb = DEB('1.2.0');
  publish(feed, { privateKey, version: '1.2.0', files: [deb] });
  const { svc, spawned, downloads } = debRig({ isBusy: () => 'A session in app is working.' });
  await svc.check();
  assert.deepEqual(await svc.install({ when: 'now' }), { ok: true });
  assert.deepEqual(spawned, [['xdg-open', path.join(downloads, deb.name)]]);
  assert.equal(svc.getState().status, 'ready');
  assert.equal(svc.getState().busyReason, null);
  assert.deepEqual(await svc.install({ when: 'idle' }), { ok: true }, 'no idle wait: opening the installer restarts nothing');
  assert.equal(spawned.length, 2);
  assert.equal(svc.getState().canRevert, false, 'a .deb reverts through apt, not here');
});

test('M11: xdg-open failing leaves the update ready with an error that names the file', async () => {
  const deb = DEB('1.2.0');
  publish(feed, { privateKey, version: '1.2.0', files: [deb] });
  const { svc, downloads } = debRig({ spawnFail: 'ENOENT' });
  await svc.check();
  assert.deepEqual(await svc.install({ when: 'now' }), { ok: false, error: 'unknown' });
  const s = svc.getState();
  assert.equal(s.status, 'ready');
  assert.ok(s.error.detail.includes(path.join(downloads, deb.name)), s.error.detail);
});

test('L5: a .deb changed in Downloads after it was verified is not opened', async () => {
  const deb = DEB('1.2.0');
  publish(feed, { privateKey, version: '1.2.0', files: [deb] });
  const { svc, spawned, downloads } = debRig();
  await svc.check();
  fs.writeFileSync(path.join(downloads, deb.name), deb.body.replace('deb', 'bad'));
  assert.deepEqual(await svc.install({ when: 'now' }), { ok: false, error: 'verify' });
  assert.equal(spawned.length, 0);
});

class FakeToken {
  constructor() { this.cancelled = false; this.onCancel = null; }
  cancel() { this.cancelled = true; this.onCancel?.(); }
}

function fakeUpdater({ info, downloadUpdate = null }) {
  const au = new EventEmitter();
  Object.assign(au, {
    feeds: [], feedOpts: [], downloads: 0, installs: [],
    setFeedURL(o) { this.feeds.push(o.url); this.feedOpts.push(o); },
    async checkForUpdates() {
      const i = typeof info === 'function' ? info(this) : info;
      this.emit('update-available', i);
      return { isUpdateAvailable: true, updateInfo: i };
    },
    async downloadUpdate(token) {
      this.downloads++;
      if (downloadUpdate) return downloadUpdate(this, token);
      this.emit('download-progress', { transferred: 5, total: 10, percent: 50 });
      return ['/tmp/x.exe'];
    },
    quitAndInstall(...a) { this.installs.push(a); },
  });
  return au;
}
const euRig = (au, { stallMs, ...over } = {}) => createService({
  fetch, keyring: keys, feedBase: feed.base, currentVersion: '1.1.0', userData: tmpDir('ud'),
  backend: EU.create({ updater: au, CancellationToken: FakeToken, platform: 'win32', log: quiet, stallMs }),
  platform: 'win32', arch: 'x64', retryDelayMs: 0, log: quiet, ...over,
});

test('electron-updater: a feed whose sha512 differs from the signed release is refused before downloadUpdate', async () => {
  publish(feed, { privateKey, version: '1.2.0', files: [EXE('1.2.0')] });
  const au = fakeUpdater({ info: { version: '1.2.0', files: [{ url: 'Plexiform-1.2.0-win-x64.exe', sha512: sha('evil'), size: 9 }] } });
  const svc = euRig(au);
  assert.deepEqual(await svc.check(), { ok: false, error: 'verify' });
  assert.equal(au.downloads, 0, 'downloadUpdate never called');
  assert.equal(au.autoDownload, false);
  assert.equal(au.autoInstallOnAppQuit, false, 'B2: nothing installs on quit');
  assert.equal(au.disableWebInstaller, true);
  assert.equal(au.allowDowngrade, false);
  assert.deepEqual(await svc.download(), { ok: false, error: 'nothing-to-download' });
  assert.equal(au.downloads, 0);
});

// N2 (security re-review): a release without Windows (WINDOWS_RELEASE unset) is no update on Windows.
test('electron-updater: a release with no Windows entry is "no update", and electron-updater is never asked', async () => {
  publish(feed, { privateKey, version: '1.2.0', files: [DEB('1.2.0')] });
  const au = fakeUpdater({ info: () => assert.fail('the feed is never read') });
  const svc = euRig(au);
  assert.deepEqual(await svc.check({ user: true }), { ok: true });
  const s = svc.getState();
  assert.equal(s.status, 'idle');
  assert.equal(s.error, null);
  assert.equal(s.available, null);
  assert.deepEqual(au.feeds, []);
  assert.equal(feed.requests.filter((r) => r.path.endsWith('.yml') || r.path.endsWith('.exe')).length, 0);
  svc.stop();
});

test('L1: a release missing this Linux build is an error, never "up to date"', async () => {
  publish(feed, { privateKey, version: '1.2.0', files: [EXE('1.2.0')] });
  const { svc } = debRig();
  await svc.check({ user: true });
  const s = svc.getState();
  assert.equal(s.status, 'error');
  assert.equal(s.error.code, 'server');
  svc.stop();
});

test('electron-updater: a matching feed downloads only when asked, then quitAndInstall only on install', async () => {
  const exe = EXE('1.2.0');
  publish(feed, { privateKey, version: '1.2.0', files: [exe] });
  const au = fakeUpdater({ info: { version: '1.2.0', files: [{ url: exe.name, sha512: sha(exe.body), size: exe.body.length }] } });
  const svc = euRig(au);
  assert.deepEqual(await svc.check(), { ok: true });
  assert.equal(svc.getState().status, 'available');
  assert.equal(au.downloads, 0);
  assert.deepEqual(await svc.download(), { ok: true });
  assert.equal(svc.getState().status, 'ready');
  assert.equal(svc.getState().installKind, 'restart');
  assert.equal(au.feeds[0], `${feed.base}/`);
  assert.equal(au.feedOpts[0].channel, undefined, 'a release version reads latest.yml');
  assert.equal(au.downloads, 1);
  assert.equal(au.installs.length, 0);
  await svc.install({ when: 'now' });
  assert.equal(au.installs.length, 1);
  svc.stop();
});

test('electron-updater: a -beta release reads beta*.yml (electron-builder names the feed after the prerelease tag)', async () => {
  const exe = EXE('1.2.0-beta.3');
  publish(feed, { prefix: '/beta/', privateKey: betaKey, version: '1.2.0-beta.3', channel: 'beta', files: [exe] });
  const au = fakeUpdater({ info: { version: '1.2.0-beta.3', files: [{ url: exe.name, sha512: sha(exe.body) }] } });
  const svc = euRig(au, { currentVersion: '1.2.0-beta.1' });
  assert.equal(svc.getState().channel, 'beta');
  assert.deepEqual(await svc.check(), { ok: true });
  assert.deepEqual(au.feedOpts[0], { provider: 'generic', url: `${feed.base}/beta/`, channel: 'beta' });
  assert.equal(au.allowDowngrade, false, 'setting the channel does not leave downgrades on');
  assert.equal(EU.feedChannel('1.2.0'), null);
  assert.equal(EU.feedChannel('1.2.0-alpha.1'), 'alpha');
});

test('electron-updater: a signed rollback allows the downgrade for that check only', async () => {
  const exe = EXE('1.0.0');
  publish(feed, { privateKey, version: '1.0.0', rollback: true, rollbackFrom: ['1.1.0'], files: [exe] });
  let during = null;
  const au = fakeUpdater({ info: (u) => { during = u.allowDowngrade; return { version: '1.0.0', files: [{ url: exe.name, sha512: sha(exe.body) }] }; } });
  const svc = euRig(au);
  assert.deepEqual(await svc.check(), { ok: true });
  assert.equal(during, true);
});

test('electron-updater: a download with no progress for stallMs is cancelled (offline)', async () => {
  const exe = EXE('1.2.0');
  publish(feed, { privateKey, version: '1.2.0', files: [exe] });
  const au = fakeUpdater({
    info: { version: '1.2.0', files: [{ url: exe.name, sha512: sha(exe.body) }] },
    downloadUpdate: (_u, token) => new Promise((_, reject) => { token.onCancel = () => reject(new Error('cancelled')); }),
  });
  const svc = euRig(au, { stallMs: 50 });
  await svc.check();
  assert.deepEqual(await svc.download(), { ok: false, error: 'offline' });
  assert.match(svc.getState().error.detail, /stalled/);
});

test('revert (Windows/AppImage): fetches <version>/release.json, verifies it, installs through the same path', async () => {
  const userData = tmpDir('ud');
  fs.writeFileSync(path.join(userData, 'updater.json'), JSON.stringify({ lastRunVersion: '1.0.0', lastIssuedAt: { stable: '2026-10-05T00:00:00.000Z' } }));
  const exe = EXE('1.0.0');
  publish(feed, { prefix: '/1.0.0/', privateKey, version: '1.0.0', files: [exe], issuedAt: '2026-09-01T00:00:00.000Z' });
  const au = fakeUpdater({ info: { version: '1.0.0', files: [{ url: exe.name, sha512: sha(exe.body) }] } });
  const svc = euRig(au, { userData });
  const s = svc.getState();
  assert.equal(s.canRevert, true);
  assert.equal(s.previousVersion, '1.0.0');
  assert.deepEqual(await svc.revert(), { ok: true });
  assert.equal(au.feeds.at(-1), `${feed.base}/1.0.0/`);
  assert.equal(au.allowDowngrade, true);
  assert.equal(svc.getState().status, 'ready');
  assert.equal(svc.getState().available.version, '1.0.0');
  // the revert's old issuedAt doesn't lower the replay floor
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'updater.json'), 'utf8')).lastIssuedAt.stable, '2026-10-05T00:00:00.000Z');

  // a tampered versioned manifest is still refused
  feed.put('/1.0.0/release.json', feed.files.get('/1.0.0/release.json').toString().replace('Plexiform 1.0.0', 'Plexiform 6.6.6'));
  assert.deepEqual(await euRig(fakeUpdater({ info: {} }), { userData }).revert(), { ok: false, error: 'signature' });
});

test('M2: revert waits its turn: refused while a check is in flight, and a check during a revert joins it', async () => {
  const userData = tmpDir('ud');
  seedStore(userData, { lastRunVersion: '1.0.0' });
  const exe = EXE('1.0.0');
  publish(feed, { privateKey, version: '1.2.0', files: [EXE('1.2.0')] });
  publish(feed, { prefix: '/1.0.0/', privateKey, version: '1.0.0', files: [exe] });
  feed.hang.set('/release.json', 0);
  feed.hang.set('/1.0.0/release.json', 0);
  const svc = euRig(fakeUpdater({ info: { version: '1.0.0', files: [{ url: exe.name, sha512: sha(exe.body) }] } }), { userData, fetchTimeoutMs: 150 });
  const checking = svc.check();
  assert.deepEqual(await svc.revert(), { ok: false, error: 'busy' });
  await checking;
  const reverting = svc.revert();
  assert.equal(svc.check(), reverting, 'a check during a revert is the revert');
  assert.deepEqual(await svc.revert(), { ok: false, error: 'busy' });
  await reverting;
});

test('channel and autoDownload persist; switching channel re-checks the beta feed', async () => {
  const userData = tmpDir('ud');
  publish(feed, { prefix: '/beta/', privateKey: betaKey, version: '1.2.0-beta.3', channel: 'beta', files: [DEB('1.2.0-beta.3')] });
  const { svc } = debRig({ userData });
  assert.equal(svc.getState().channel, 'stable');
  assert.deepEqual(await svc.setAutoDownload(false), { ok: true });
  assert.deepEqual(await svc.setChannel('beta'), { ok: true });
  assert.equal(svc.getState().status, 'available');
  assert.equal(svc.getState().available.version, '1.2.0-beta.3');
  assert.deepEqual(await svc.setChannel('nightly'), { ok: false, error: 'bad-channel' });
  const again = debRig({ userData, autoDownload: false }).svc.getState();
  assert.equal(again.channel, 'beta');
  assert.equal(again.autoDownload, false);
});

test('M1: switching channel during a check ends with the new channel\'s answer', async () => {
  publish(feed, { privateKey, version: '1.2.0', files: [DEB('1.2.0')] });
  publish(feed, { prefix: '/beta/', privateKey: betaKey, version: '1.3.0-beta.1', channel: 'beta', files: [DEB('1.3.0-beta.1')] });
  feed.hang.set('/release.json', 0);
  const { svc } = debRig({ autoDownload: false, fetchTimeoutMs: 150 });
  const first = svc.check({ user: true });
  await wait(20);
  const switched = svc.setChannel('beta');
  assert.equal(switched, first, 'the in-flight check carries on, then checks the new channel');
  assert.deepEqual(await switched, { ok: true });
  const s = svc.getState();
  assert.equal(s.channel, 'beta');
  assert.equal(s.status, 'available');
  assert.equal(s.available.version, '1.3.0-beta.1');
});

test('a beta build starts on the beta channel; L13: a stable build goes back to stable unless the person chose beta', () => {
  assert.equal(debRig({ currentVersion: '1.2.0-beta.4' }).svc.getState().channel, 'beta');
  assert.equal(debRig({ currentVersion: '1.2.0', store: { channel: 'beta' } }).svc.getState().channel, 'stable');
  assert.equal(debRig({ currentVersion: '1.2.0', store: { channel: 'beta', channelChosen: true } }).svc.getState().channel, 'beta');
});

test('setRequired: the hub asks for a newer version, and a check starts', async () => {
  publish(feed, { privateKey, version: '1.2.0', files: [DEB('1.2.0')] });
  const { svc } = debRig({ autoDownload: false });
  await svc.setRequired('1.2.0', 'Acme team');
  assert.deepEqual(svc.getState().requiredByHub, { minVersion: '1.2.0', hubName: 'Acme team' });
  assert.equal(svc.getState().status, 'available');
  svc.setRequired('1.0.0', 'Acme team');
  assert.equal(svc.getState().requiredByHub, null);
});

test('a failed swap and the version it came from show up in the state (only as handed in by readLaunch)', () => {
  const failed = debRig({ updateFailed: true }).svc.getState();
  assert.equal(failed.status, 'error');
  assert.equal(failed.error.code, 'unknown');
  assert.equal(debRig({ updatedFrom: '1.0.4' }).svc.getState().previousVersion, '1.0.4');
  assert.equal(debRig({ updatedFrom: '../../x' }).svc.getState().previousVersion, null);
});

// Electron IPC event stand-ins: e.sender is the webContents, e.senderFrame the frame that sent it.
function ipcEvent(url, { subframe = false } = {}) {
  const mainFrame = { url };
  const sender = { mainFrame, isDestroyed: () => false, sent: [], send(ch, s) { this.sent.push([ch, s.status]); } };
  return { sender, senderFrame: subframe ? { url } : mainFrame };
}
// The app's own folder as main.js loads it (app.asar when packaged).
const APP = require('url').pathToFileURL(Updater.APP_ROOT).href;

function ipcRig() {
  publish(feed, { privateKey, version: '1.2.0', files: [DEB('1.2.0')] });
  const { svc } = debRig({ autoDownload: false });
  const handlers = {};
  Updater.register({ handle: (ch, fn) => { handlers[ch] = fn; } }, svc);
  return { svc, handlers };
}

test('IPC: get-state subscribes the asking window; every change is pushed; commands answer {ok}', async () => {
  const { handlers } = ipcRig();
  assert.deepEqual(Object.keys(handlers).sort(), ['updater:check', 'updater:download', 'updater:get-state', 'updater:install', 'updater:revert', 'updater:set-auto-download', 'updater:set-channel']);
  const win = ipcEvent(`${APP}/updates.html`);
  const other = ipcEvent(`${APP}/updates.html`);
  assert.equal((await handlers['updater:get-state'](win)).status, 'idle');
  assert.deepEqual(await handlers['updater:check'](other), { ok: true });
  assert.deepEqual(win.sender.sent.map((x) => x[1]), ['checking', 'available']);
  assert.equal(other.sender.sent.length, 0, 'never asked for the state');
  assert.ok(win.sender.sent.every((x) => x[0] === 'updater:state'));
  assert.deepEqual(await handlers['updater:install'](win, { when: 'now' }), { ok: false, error: 'not-ready' });
  assert.deepEqual(await handlers['updater:set-channel'](win, 'nope'), { ok: false, error: 'bad-channel' });
});

test('IPC: the widget may read the state and install, never force a restart or change anything else', async () => {
  const { handlers } = ipcRig();
  const widget = ipcEvent(`${APP}/index.html`);
  const forbidden = { ok: false, error: 'forbidden' };
  assert.equal((await handlers['updater:get-state'](widget)).status, 'idle');
  assert.deepEqual(await handlers['updater:install'](widget, { when: 'now' }), { ok: false, error: 'not-ready' });
  assert.deepEqual(await handlers['updater:install'](widget, { when: 'idle' }), { ok: false, error: 'not-ready' });
  assert.deepEqual(await handlers['updater:install'](widget, { when: 'now', force: true }), forbidden);
  assert.deepEqual(await handlers['updater:install'](widget, { when: 'later' }), forbidden);
  for (const ch of ['updater:check', 'updater:download', 'updater:revert']) assert.deepEqual(await handlers[ch](widget), forbidden, ch);
  assert.deepEqual(await handlers['updater:set-channel'](widget, 'beta'), forbidden);
  assert.deepEqual(await handlers['updater:set-auto-download'](widget, true), forbidden);
});

// PoC 4 (security review): any webContents could switch channel and force an install.
test('PoC 4: other pages, subframes and web pages are forbidden everything, get-state included', async () => {
  const { svc, handlers } = ipcRig();
  const forbidden = { ok: false, error: 'forbidden' };
  const senders = [
    ipcEvent('https://attacker.example/'),
    ipcEvent(`${APP}/settings.html`),
    ipcEvent(`${APP}/lights.html`),
    ipcEvent(`${APP}/updates.html`, { subframe: true }),
    ipcEvent('https://attacker.example/updates.html'),
    ipcEvent(`${APP}/updates.html.evil`),
    { sender: null, senderFrame: null },
  ];
  for (const e of senders) {
    assert.deepEqual(await handlers['updater:get-state'](e), forbidden);
    assert.deepEqual(await handlers['updater:set-channel'](e, 'beta'), forbidden);
    assert.deepEqual(await handlers['updater:install'](e, { when: 'now', force: true }), forbidden);
    assert.deepEqual(await handlers['updater:check'](e), forbidden);
  }
  assert.equal(svc.getState().channel, 'stable');
  assert.equal(svc.getState().status, 'idle');
  // a fresh wrapper for the same main frame counts; a child frame with the same page does not
  const url = `${APP}/updates.html`;
  const wc = { mainFrame: { url, frameTreeNodeId: 7, parent: null } };
  assert.ok(Updater.policyFor({ sender: wc, senderFrame: { url, frameTreeNodeId: 7, parent: null } }));
  assert.equal(Updater.policyFor({ sender: wc, senderFrame: { url, frameTreeNodeId: 8, parent: wc.mainFrame } }), null);
  assert.equal(Updater.policyFor({ sender: wc, senderFrame: { url, frameTreeNodeId: 7, parent: wc.mainFrame } }), null);
  // a percent-encoded URL for the same file is the same page
  assert.ok(Updater.policyFor(ipcEvent(`${APP}/updates%2Ehtml`)));
});

// N3 (security re-review): the policy matched the file NAME, so any local updates.html had updater rights.
test('N3: a same-named page anywhere but the app folder is forbidden; the real app pages are allowed', async () => {
  const { handlers } = ipcRig();
  const forbidden = { ok: false, error: 'forbidden' };
  const elsewhere = [
    'file:///tmp/updates.html',
    'file:///Applications/Plexiform.app/Contents/Resources/app.asar/updates.html',
    `${APP}/sub/updates.html`,
    `${APP}/../updates.html`,
    'file:///C:/Users/x/Downloads/updates.html',
    'file://evil.example/share/updates.html',
    'file:///tmp/index.html',
  ];
  for (const url of elsewhere) {
    assert.equal(Updater.policyFor(ipcEvent(url)), null, url);
    assert.deepEqual(await handlers['updater:get-state'](ipcEvent(url)), forbidden, url);
    assert.deepEqual(await handlers['updater:install'](ipcEvent(url), { when: 'now' }), forbidden, url);
  }
  assert.equal((await handlers['updater:get-state'](ipcEvent(`${APP}/updates.html`))).status, 'idle');
  assert.equal((await handlers['updater:get-state'](ipcEvent(`${APP}/index.html?x=1#y`))).status, 'idle');
  assert.deepEqual(await handlers['updater:check'](ipcEvent(`${APP}/index.html`)), forbidden);
});

test('N3: the navigation guard keeps an app window on app pages and opens no windows', () => {
  for (const page of ['index.html', 'settings.html', 'lights.html', 'help.html', 'overlay.html', 'tray.html', 'updates.html']) assert.ok(Updater.isAppPage(`${APP}/${page}`), page);
  assert.ok(Updater.isAppPage(`${APP}/lights.html?now=1`), 'loadFile with a query');
  for (const url of ['file:///tmp/updates.html', 'https://plexiform.dev/updates.html', 'https://claude.ai', `${APP}/buddy-window/info.html`, `${APP}/PRIVACY.md`, 'about:blank', 'not a url', '']) assert.equal(Updater.isAppPage(url), false, url);

  const wcAt = (current) => {
    const wc = new EventEmitter();
    wc.getURL = () => current;
    wc.setWindowOpenHandler = (fn) => { wc.openHandler = fn; };
    Updater.guardNavigation(wc);
    return wc;
  };
  const blocked = (wc, url) => { let prevented = false; wc.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url); return prevented; };
  const app = wcAt(`${APP}/index.html`);
  assert.deepEqual(app.openHandler({ url: 'https://claude.ai' }), { action: 'deny' });
  assert.equal(blocked(app, 'file:///tmp/updates.html'), true);
  assert.equal(blocked(app, 'https://claude.ai'), true);
  assert.equal(blocked(app, `${APP}/updates.html`), false);
  assert.equal(blocked(wcAt(''), 'file:///tmp/updates.html'), true, 'nothing loaded yet');
  // another module's view on its own pages keeps its own guard (buddy-window)
  assert.equal(blocked(wcAt('https://hub.example/'), 'https://hub.example/next'), false);
});

test('PoC 4: an old beta rollback is refused on a switch to beta (beta key, floor, rollbackFrom)', async () => {
  const old = { version: '1.0.0-beta.3', channel: 'beta', rollback: true, rollbackFrom: ['1.0.0-beta.9'], issuedAt: '2025-01-01T00:00:00.000Z', files: [DEB('1.0.0-beta.3')] };
  // signed with the stable key: not a beta release at all
  publish(feed, { prefix: '/beta/', privateKey, ...old });
  let { svc } = debRig({ currentVersion: '2.0.0', builtAt: '2026-09-01T00:00:00.000Z', autoDownload: false });
  assert.deepEqual(await svc.setChannel('beta'), { ok: false, error: 'signature' });
  // signed with the beta key, but from before this build and not for 2.0.0
  publish(feed, { prefix: '/beta/', privateKey: betaKey, ...old });
  ({ svc } = debRig({ currentVersion: '2.0.0', builtAt: '2026-09-01T00:00:00.000Z', autoDownload: false }));
  assert.deepEqual(await svc.setChannel('beta'), { ok: false, error: 'verify' });
});

test('busyReason: working, waiting or asked is busy; finished or idle is not', () => {
  assert.equal(Updater.busyReason({ sessions: [], pending: [], inputs: [] }), null);
  assert.equal(Updater.busyReason({ sessions: [{ signal: 'stop', cwd: '/a/app' }, { signal: 'idle-nudge' }, { signal: 'session-start' }] }), null);
  assert.match(Updater.busyReason({ sessions: [{ signal: 'tool-use', cwd: '/a/app' }] }), /in app is working/);
  assert.match(Updater.busyReason({ sessions: [{ signal: 'permission-ask' }] }), /waiting for you/);
  assert.match(Updater.busyReason({ sessions: [], pending: [{ id: 1 }] }), /permission request/);
  assert.match(Updater.busyReason({ sessions: [], inputs: [{ id: 1 }] }), /waiting for your answer/);
});

test('loadBuiltAt reads build/release-floor.json, and nothing (dev) is no floor', () => {
  const dir = tmpDir('floor');
  assert.equal(Updater.loadBuiltAt(dir), null);
  fs.writeFileSync(path.join(dir, 'release-floor.json'), JSON.stringify({ builtAt: '2026-10-01T00:00:00.000Z' }));
  assert.equal(Updater.loadBuiltAt(dir), '2026-10-01T00:00:00.000Z');
  fs.writeFileSync(path.join(dir, 'release-floor.json'), JSON.stringify({ builtAt: 'soon' }));
  assert.equal(Updater.loadBuiltAt(dir), null);
});

test('the UI fixture covers every status and error and matches the state shape', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'updater-states.json'), 'utf8'));
  const keysOf = (o) => Object.keys(o).sort();
  const live = debRig({ autoDownload: false }).svc.getState();
  const variants = Object.values(fixture.states);
  for (const v of variants) assert.deepEqual(keysOf(v), keysOf(live), 'same fields as the service');
  for (const st of ['idle', 'checking', 'available', 'downloading', 'ready', 'installing', 'error']) assert.ok(variants.some((v) => v.status === st), st);
  for (const code of ['offline', 'signature', 'verify', 'downgrade', 'translocated', 'not-writable', 'disk-full', 'server', 'unknown', 'expired', 'install-stalled']) assert.ok(variants.some((v) => v.error?.code === code), code);
  for (const k of ['restart', 'swap', 'deb-manual']) assert.ok(variants.some((v) => v.installKind === k), k);
  assert.equal(live.autoDownload, false);
  assert.equal(fixture.states['idle-never-checked'].autoDownload, false, 'the default is off');
});
