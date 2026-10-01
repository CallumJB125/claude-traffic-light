// The macOS self-swap against a temp "Applications" folder with fake .app
// bundles (shell-script executables): the helper script on its own, then the
// whole path from a signed zip on the fake feed to a swapped, relaunched app.
// Never touches the real /Applications or home folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn, execFileSync } = require('child_process');
const MacSwap = require('../src/updater/mac-swap.js');
const { createService } = require('../src/updater/service.js');
const { keyPair, startFeed, publish, tmpDir } = require('./updater-feed.js');

const mac = process.platform === 'darwin';
const ID = 'com.callumbaker.claude-buddy';
const quiet = { warn() {}, log() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// kind: 'old' logs its launches; 'good' writes its pid and launched-ok; 'hang' writes its pid and never gets there.
function fakeApp(dir, { version, id = ID, kind, name = 'Plexiform.app' }) {
  const app = path.join(dir, name);
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key>
  <string>${id}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
</dict></plist>
`);
  const body = {
    old: `echo "${version} $1" >> "$FAKE_LOG"`,
    good: `echo $$ > "$FAKE_UPDATES/launched-pid"; echo "${version} $1" >> "$FAKE_LOG"; touch "$FAKE_UPDATES/launched-ok"`,
    hang: `echo $$ > "$FAKE_UPDATES/launched-pid"; echo "${version} $1" >> "$FAKE_LOG"; exec sleep 30`,
  }[kind];
  const exe = path.join(app, 'Contents', 'MacOS', 'Plexiform');
  fs.writeFileSync(exe, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(exe, 0o755);
  return app;
}

function rig() {
  const root = tmpDir('mac');
  const apps = path.join(root, 'Applications');
  const userData = path.join(root, 'userData');
  const updates = path.join(userData, 'updates');
  fs.mkdirSync(apps, { recursive: true });
  fs.mkdirSync(updates, { recursive: true });
  return { root, apps, userData, updates, log: path.join(root, 'launches.log'), env: { ...process.env, FAKE_LOG: path.join(root, 'launches.log'), FAKE_UPDATES: updates } };
}

// A process standing in for the running app: the helper waits for it to exit.
const standIn = () => spawn('/bin/sleep', ['0.3']);
const exited = (child) => new Promise((r) => child.on('exit', (code) => r(code)));
const versionOf = (app) => MacSwap.readBundleInfo(app).version;
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n') : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(cond, ms = 5000) {
  for (let t = 0; t < ms && !cond(); t += 50) await wait(50);
  return cond();
}

function runHelper(r, current, next, { timeout = 5, oldVersion = '1.1.0', env = r.env } = {}) {
  const old = standIn();
  const helper = spawn('/bin/sh', [MacSwap.HELPER, String(old.pid), current, next, path.join(r.updates, 'previous'), r.updates, oldVersion, String(timeout), 'direct'], { env, stdio: 'ignore' });
  return exited(helper);
}

function zipOf(r, opts, name = 'z.zip') {
  const build = fs.mkdtempSync(path.join(r.root, 'build-'));
  fakeApp(build, opts);
  const zip = path.join(r.root, name);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(build, 'Plexiform.app'), zip]);
  return zip;
}

test('helper: waits for the app, swaps the bundles, launches the new one, then clears the old bundle, the zip and the pending note', { skip: !mac && 'macOS only' }, async () => {
  const r = rig();
  const current = fakeApp(r.apps, { version: '1.1.0', kind: 'old' });
  const next = fakeApp(path.join(r.updates, 'staged'), { version: '1.2.0', kind: 'good' });
  fs.mkdirSync(path.join(r.updates, 'downloads'));
  fs.writeFileSync(path.join(r.updates, 'downloads', 'Plexiform-1.2.0-mac-arm64.zip'), 'z');
  fs.writeFileSync(path.join(r.updates, MacSwap.PENDING), '{}');
  assert.equal(await runHelper(r, current, next), 0);
  assert.equal(versionOf(current), '1.2.0');
  assert.deepEqual(lines(r.log), ['1.2.0 --updated-from=1.1.0']);
  assert.match(fs.readFileSync(path.join(r.updates, 'swap.log'), 'utf8'), /swap ok/);
  for (const gone of ['previous/Plexiform.app', 'downloads', MacSwap.PENDING]) assert.ok(!fs.existsSync(path.join(r.updates, gone)), gone);
});

test('helper: a new bundle that never writes launched-ok is stopped and rolled back', { skip: !mac && 'macOS only' }, async () => {
  const r = rig();
  const current = fakeApp(r.apps, { version: '1.1.0', kind: 'old' });
  const next = fakeApp(path.join(r.updates, 'staged'), { version: '1.2.0', kind: 'hang' });
  fs.writeFileSync(path.join(r.updates, MacSwap.PENDING), '{}');
  assert.equal(await runHelper(r, current, next, { timeout: 5 }), 2);
  assert.equal(versionOf(current), '1.1.0', 'the old app is back');
  assert.equal(versionOf(path.join(r.updates, 'failed', 'Plexiform.app')), '1.2.0');
  // the relaunched old app runs in the background after the helper exits
  assert.ok(await until(() => lines(r.log).length >= 2));
  assert.deepEqual(lines(r.log), ['1.2.0 --updated-from=1.1.0', '1.1.0 --update-failed']);
  assert.ok(await until(() => fs.existsSync(path.join(r.updates, 'launched-pid'))));
  const hung = Number(fs.readFileSync(path.join(r.updates, 'launched-pid'), 'utf8'));
  assert.ok(await until(() => !alive(hung)), 'the hung new app was stopped');
  assert.match(fs.readFileSync(path.join(r.updates, 'swap.log'), 'utf8'), /rolled back to 1\.1\.0/);
  assert.ok(fs.existsSync(path.join(r.updates, MacSwap.PENDING)), 'left for the old app to read --update-failed against');
});

// PoC 5 (security review): quotes, $(), backticks and globs in the paths or the version.
test('PoC 5: the helper runs nothing from its arguments, and refuses a pid or timeout that is not a number', { skip: !mac && 'macOS only' }, async () => {
  const r = rig();
  const evil = `A p"q'$(touch ${r.root}/PWNED1)\`touch ${r.root}/PWNED2\`;touch ${r.root}/PWNED3 *`;
  const appsDir = path.join(r.root, evil, 'Applications');
  const updates = path.join(r.root, `${evil}ud`, 'updates');
  fs.mkdirSync(appsDir, { recursive: true });
  fs.mkdirSync(updates, { recursive: true });
  const current = fakeApp(appsDir, { version: '1.1.0', kind: 'old' });
  const next = fakeApp(path.join(updates, 'staged'), { version: '1.2.0', kind: 'good' });
  const old = standIn();
  const env = { ...r.env, FAKE_UPDATES: updates };
  const helper = spawn('/bin/sh', [MacSwap.HELPER, String(old.pid), current, next, path.join(updates, 'previous'), updates, `1.1.0$(touch ${r.root}/PWNED4)`, '5', 'direct'], { env, stdio: 'ignore' });
  assert.equal(await exited(helper), 0);
  assert.equal(versionOf(current), '1.2.0');
  assert.deepEqual(fs.readdirSync(r.root).filter((n) => /PWNED/.test(n)), []);
  for (const [pid, timeout] of [['1;touch x', '5'], ['123', '5;id']]) {
    const h = spawn('/bin/sh', [MacSwap.HELPER, pid, current, next, path.join(updates, 'previous'), updates, '1.1.0', timeout, 'direct'], { env, stdio: 'ignore' });
    assert.equal(await exited(h), 64);
  }
});

test('preflight: not-writable, translocated, and a data folder on another disk', { skip: !mac && 'macOS only' }, () => {
  const r = rig();
  const current = fakeApp(r.apps, { version: '1.1.0', kind: 'old' });
  const exe = path.join(current, 'Contents', 'MacOS', 'Plexiform');
  fs.chmodSync(r.apps, 0o555);
  try {
    const e = MacSwap.create({ fetch, userData: r.userData, execPath: exe }).preflight();
    assert.equal(e.code, 'not-writable');
    assert.match(e.detail, /\.dmg/);
  } finally {
    fs.chmodSync(r.apps, 0o755);
  }
  assert.equal(MacSwap.create({ fetch, userData: r.userData, execPath: exe }).preflight(), null);
  const trans = '/private/var/folders/ab/xyz/T/AppTranslocation/1234-ABCD/d/Plexiform.app/Contents/MacOS/Plexiform';
  assert.equal(MacSwap.create({ fetch, userData: r.userData, execPath: trans }).preflight().code, 'translocated');
  const other = MacSwap.create({ fetch, userData: r.userData, execPath: exe, devOf: (p) => (p === r.userData ? 2 : 1) }).preflight();
  assert.equal(other.code, 'not-writable');
  assert.match(other.detail, /different disk/);
  assert.equal(MacSwap.bundleOf('/Applications/X.app/Contents/MacOS/X'), '/Applications/X.app');
  assert.equal(MacSwap.bundleOf('/usr/local/bin/node'), null);
});

test('end to end: signed zip on the feed → verified → unpacked → swapped → relaunched; then revert fetches the old signed release', { skip: !mac && 'macOS only' }, async () => {
  const feed = await startFeed();
  const { privateKey, keys } = keyPair();
  const r = rig();
  const savedEnv = { FAKE_LOG: process.env.FAKE_LOG, FAKE_UPDATES: process.env.FAKE_UPDATES };
  process.env.FAKE_LOG = r.env.FAKE_LOG;
  process.env.FAKE_UPDATES = r.env.FAKE_UPDATES;
  try {
    const current = fakeApp(r.apps, { version: '1.1.0', kind: 'good' });
    const z120 = zipOf(r, { version: '1.2.0', kind: 'good' }, 'Plexiform-1.2.0-mac-arm64.zip');
    const z110 = zipOf(r, { version: '1.1.0', kind: 'good' }, 'Plexiform-1.1.0-mac-arm64.zip');
    publish(feed, { privateKey, version: '1.2.0', files: [{ name: 'Plexiform-1.2.0-mac-arm64.zip', body: fs.readFileSync(z120), platform: 'darwin', arch: 'arm64', kind: 'mac-zip' }] });
    publish(feed, { prefix: '/1.1.0/', privateKey, version: '1.1.0', issuedAt: '2026-09-01T00:00:00.000Z', files: [{ name: 'Plexiform-1.1.0-mac-arm64.zip', body: fs.readFileSync(z110), platform: 'darwin', arch: 'arm64', kind: 'mac-zip' }] });

    const exe = path.join(current, 'Contents', 'MacOS', 'Plexiform');
    let quits = 0;
    const make = () => {
      const old = standIn();
      const backend = MacSwap.create({ fetch, userData: r.userData, execPath: exe, pid: old.pid, quit: () => { quits++; }, launch: 'direct', timeoutSec: 5 });
      return createService({ fetch, keyring: keys, feedBase: feed.base, currentVersion: versionOf(current), userData: r.userData, backend, platform: 'darwin', arch: 'arm64', retryDelayMs: 0, log: quiet });
    };
    const swaps = () => lines(path.join(r.updates, 'swap.log')).filter((l) => /swap ok|rolled back|abandoned/.test(l)).length;

    const svc = make();
    assert.deepEqual(await svc.check(), { ok: true });
    assert.equal(svc.getState().status, 'available');
    assert.deepEqual(await svc.download(), { ok: true });
    assert.equal(svc.getState().status, 'ready');
    assert.equal(svc.getState().installKind, 'swap');
    assert.ok(!fs.existsSync(path.join(r.updates, 'staged')), 'nothing waits unpacked: install unpacks again from the checked zip');
    assert.equal(fs.statSync(r.updates).mode & 0o777, 0o700);
    assert.deepEqual(await svc.install({ when: 'now' }), { ok: true });
    assert.equal(quits, 1);
    const pending = JSON.parse(fs.readFileSync(path.join(r.updates, MacSwap.PENDING), 'utf8'));
    assert.deepEqual([pending.from, pending.to], ['1.1.0', '1.2.0']);
    assert.ok(await until(() => swaps() >= 1, 10000));
    assert.equal(versionOf(current), '1.2.0');
    assert.deepEqual(lines(r.log), ['1.2.0 --updated-from=1.1.0']);
    assert.ok(!fs.existsSync(path.join(r.updates, 'downloads')), 'L12: the zip is gone after a good swap');

    // the relaunched 1.2.0 can go back to 1.1.0: its own signed release, downloaded and checked again
    const after = make();
    assert.deepEqual([after.getState().canRevert, after.getState().previousVersion], [true, '1.1.0']);
    assert.deepEqual(await after.revert(), { ok: true });
    assert.equal(after.getState().status, 'ready');
    assert.equal(after.getState().available.version, '1.1.0');
    assert.ok(feed.requests.some((q) => q.path === '/1.1.0/Plexiform-1.1.0-mac-arm64.zip'));
    assert.deepEqual(await after.install({ when: 'now' }), { ok: true });
    assert.ok(await until(() => swaps() >= 2, 10000));
    assert.equal(versionOf(current), '1.1.0');
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await feed.close();
  }
});

test('L2: a changed previous/ folder is never what Revert installs', { skip: !mac && 'macOS only' }, async () => {
  const feed = await startFeed();
  const { privateKey, keys } = keyPair();
  try {
    const r = rig();
    const current = fakeApp(r.apps, { version: '1.2.0', kind: 'old' });
    fakeApp(path.join(r.updates, 'previous'), { version: '1.1.0', id: 'com.evil.app', kind: 'old' });
    fs.writeFileSync(path.join(r.userData, 'updater.json'), JSON.stringify({ lastRunVersion: '1.1.0' }));
    const backend = MacSwap.create({ fetch, userData: r.userData, execPath: path.join(current, 'Contents', 'MacOS', 'Plexiform') });
    const svc = createService({ fetch, keyring: keys, feedBase: feed.base, currentVersion: '1.2.0', userData: r.userData, backend, platform: 'darwin', arch: 'arm64', retryDelayMs: 0, log: quiet });
    // nothing signed for 1.1.0 on the feed: there is nothing to revert to
    assert.deepEqual(await svc.revert(), { ok: false, error: 'server' });
    const z = zipOf(r, { version: '1.1.0', kind: 'old' }, 'Plexiform-1.1.0-mac-arm64.zip');
    publish(feed, { prefix: '/1.1.0/', privateKey, version: '1.1.0', files: [{ name: 'Plexiform-1.1.0-mac-arm64.zip', body: fs.readFileSync(z), platform: 'darwin', arch: 'arm64', kind: 'mac-zip' }] });
    assert.deepEqual(await svc.revert(), { ok: true });
    assert.equal(svc.getState().available.version, '1.1.0');
  } finally {
    await feed.close();
  }
});

async function refusedZip(t, mutate, want, makeZip = null) {
  const feed = await startFeed();
  const { privateKey, keys } = keyPair();
  try {
    const r = rig();
    const current = fakeApp(r.apps, { version: '1.1.0', kind: 'old' });
    const build = path.join(r.root, 'build');
    const app = fakeApp(build, { version: '1.2.0', kind: 'good' });
    mutate({ r, build, app });
    const zip = path.join(r.root, 'z.zip');
    if (makeZip) makeZip({ r, app, zip });
    else execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
    publish(feed, { privateKey, version: '1.2.0', files: [{ name: 'Plexiform-1.2.0-mac-arm64.zip', body: fs.readFileSync(zip), platform: 'darwin', arch: 'arm64', kind: 'mac-zip' }] });
    const backend = MacSwap.create({ fetch, userData: r.userData, execPath: path.join(current, 'Contents', 'MacOS', 'Plexiform') });
    const svc = createService({ fetch, keyring: keys, feedBase: feed.base, currentVersion: '1.1.0', userData: r.userData, backend, platform: 'darwin', arch: 'arm64', retryDelayMs: 0, log: quiet });
    await svc.check();
    assert.deepEqual(await svc.download(), { ok: false, error: 'verify' });
    assert.match(svc.getState().error.detail, want);
  } finally {
    await feed.close();
  }
}

test('an unpacked app with another bundle id or version is refused (verify)', { skip: !mac && 'macOS only' }, async (t) => {
  await refusedZip(t, ({ app }) => fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8').replace(ID, 'com.evil.app')), /com\.evil\.app/);
  await refusedZip(t, ({ app }) => fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8').replaceAll('1.2.0', '9.9.9')), /version 9\.9\.9/);
});

test('#10: a symlink leading out of the bundle is refused; links inside it are fine', { skip: !mac && 'macOS only' }, async (t) => {
  await refusedZip(t, ({ app }) => fs.symlinkSync('/etc', path.join(app, 'Contents', 'Resources')), /links outside itself/);
  await refusedZip(t, ({ app }) => fs.symlinkSync('../../../../x', path.join(app, 'Contents', 'evil')), /links outside itself/);
  // the .app itself a symlink (zip -y stores the link, ditto restores it)
  await refusedZip(t, () => {}, /is a link, not an app/, ({ r, app, zip }) => {
    const pkg = path.join(r.root, 'pkg');
    fs.mkdirSync(pkg);
    fs.symlinkSync(app, path.join(pkg, 'Plexiform.app'));
    execFileSync('/usr/bin/zip', ['-q', '-y', '-r', zip, 'Plexiform.app'], { cwd: pkg });
  });
  const root = tmpDir('links');
  const app = fakeApp(root, { version: '1.0.0', kind: 'old' });
  fs.mkdirSync(path.join(app, 'Contents', 'Frameworks', 'F.framework', 'Versions', 'A'), { recursive: true });
  fs.symlinkSync('A', path.join(app, 'Contents', 'Frameworks', 'F.framework', 'Versions', 'Current'));
  assert.equal(MacSwap.escapingLink(app), null);
});

test('M12: if the helper can\'t start, the app does not quit and nothing is left pending', { skip: !mac && 'macOS only' }, async () => {
  const feed = await startFeed();
  const { privateKey, keys } = keyPair();
  try {
    const r = rig();
    const current = fakeApp(r.apps, { version: '1.1.0', kind: 'old' });
    const z = zipOf(r, { version: '1.2.0', kind: 'good' }, 'Plexiform-1.2.0-mac-arm64.zip');
    publish(feed, { privateKey, version: '1.2.0', files: [{ name: 'Plexiform-1.2.0-mac-arm64.zip', body: fs.readFileSync(z), platform: 'darwin', arch: 'arm64', kind: 'mac-zip' }] });
    let quits = 0;
    const failingSpawn = () => {
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn /bin/sh EACCES'), { code: 'EACCES' })));
      return child;
    };
    const backend = MacSwap.create({ fetch, userData: r.userData, execPath: path.join(current, 'Contents', 'MacOS', 'Plexiform'), spawn: failingSpawn, quit: () => { quits++; } });
    const svc = createService({ fetch, keyring: keys, feedBase: feed.base, currentVersion: '1.1.0', userData: r.userData, backend, platform: 'darwin', arch: 'arm64', retryDelayMs: 0, log: quiet });
    await svc.check();
    await svc.download();
    assert.deepEqual(await svc.install({ when: 'now' }), { ok: false, error: 'unknown' });
    assert.equal(quits, 0);
    assert.equal(svc.getState().status, 'ready');
    assert.ok(!fs.existsSync(path.join(r.updates, MacSwap.PENDING)));
    assert.equal(versionOf(current), '1.1.0');
    // #9: a zip changed after download is not unpacked at install time
    fs.appendFileSync(path.join(r.updates, 'downloads', 'Plexiform-1.2.0-mac-arm64.zip'), 'x');
    assert.deepEqual(await svc.install({ when: 'now' }), { ok: false, error: 'verify' });
  } finally {
    await feed.close();
  }
});

test('L3: --updated-from and --update-failed count only when the helper left a matching, recent note', () => {
  const ud = tmpDir('launch');
  const updates = path.join(ud, 'updates');
  fs.mkdirSync(updates, { recursive: true });
  const note = (o) => fs.writeFileSync(path.join(updates, MacSwap.PENDING), JSON.stringify(o));
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  assert.deepEqual(MacSwap.readLaunch({ userData: ud, argv: ['x', '--updated-from=1.0.4'], now }), { updatedFrom: null, updateFailed: false }, 'no note: a hand-typed flag means nothing');
  assert.deepEqual(MacSwap.readLaunch({ userData: ud, argv: ['x', '--update-failed'], now }), { updatedFrom: null, updateFailed: false });
  note({ from: '1.0.4', to: '1.1.0', at: now - 60000 });
  assert.deepEqual(MacSwap.readLaunch({ userData: ud, argv: ['x', '--updated-from=1.0.3'], now }), { updatedFrom: null, updateFailed: false }, 'another version');
  assert.deepEqual(MacSwap.readLaunch({ userData: ud, argv: ['x', '--updated-from=1.0.4'], now }), { updatedFrom: '1.0.4', updateFailed: false });
  assert.ok(fs.existsSync(path.join(updates, MacSwap.PENDING)), 'kept: the helper may still roll back');
  assert.deepEqual(MacSwap.readLaunch({ userData: ud, argv: ['x', '--update-failed'], now }), { updatedFrom: null, updateFailed: true });
  assert.ok(!fs.existsSync(path.join(updates, MacSwap.PENDING)), 'a failure is final: the note is used up');
  note({ from: '1.0.4', to: '1.1.0', at: now - 3600000 });
  assert.deepEqual(MacSwap.readLaunch({ userData: ud, argv: ['x', '--updated-from=1.0.4'], now }), { updatedFrom: null, updateFailed: false }, 'stale');
  assert.ok(!fs.existsSync(path.join(updates, MacSwap.PENDING)));
});

test('markLaunched: only after a real swap, the pid at once and launched-ok later', () => {
  const ud = tmpDir('ml');
  const timers = [];
  assert.equal(MacSwap.markLaunched({ userData: ud, updatedFrom: null, setTimer: (fn) => timers.push(fn) }), false);
  assert.ok(!fs.existsSync(path.join(ud, 'updates', 'launched-pid')));
  assert.equal(MacSwap.markLaunched({ userData: ud, updatedFrom: '1.1.0', pid: 4242, setTimer: (fn) => timers.push(fn) }), true);
  assert.equal(fs.readFileSync(path.join(ud, 'updates', 'launched-pid'), 'utf8'), '4242');
  assert.ok(!fs.existsSync(path.join(ud, 'updates', 'launched-ok')));
  timers[0]();
  assert.ok(fs.existsSync(path.join(ud, 'updates', 'launched-ok')));
});
