// The macOS self-swap against a temp "Applications" folder with fake .app
// bundles (shell-script executables): the helper script on its own, then the
// whole path from a signed zip on the fake feed to a swapped, relaunched app.
// Never touches the real /Applications or home folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const MacSwap = require('../src/updater/mac-swap.js');
const { createService } = require('../src/updater/service.js');
const { keyPair, startFeed, publish, tmpDir } = require('./updater-feed.js');

const mac = process.platform === 'darwin';
const ID = 'com.callumbaker.claude-buddy';
const quiet = { warn() {}, log() {} };

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

function runHelper(r, current, next, { timeout = 5 } = {}) {
  const old = standIn();
  const helper = spawn('/bin/sh', [MacSwap.HELPER, String(old.pid), current, next, path.join(r.updates, 'previous'), r.updates, '1.1.0', String(timeout), 'direct'], { env: r.env, stdio: 'ignore' });
  return exited(helper);
}

test('helper: waits for the app, swaps the bundles, launches the new one, keeps the old for revert', { skip: !mac && 'macOS only' }, async () => {
  const r = rig();
  const current = fakeApp(r.apps, { version: '1.1.0', kind: 'old' });
  const next = fakeApp(path.join(r.updates, 'staged'), { version: '1.2.0', kind: 'good' });
  assert.equal(await runHelper(r, current, next), 0);
  assert.equal(versionOf(current), '1.2.0');
  assert.equal(versionOf(path.join(r.updates, 'previous', 'Plexiform.app')), '1.1.0');
  assert.deepEqual(lines(r.log), ['1.2.0 --updated-from=1.1.0']);
  assert.match(fs.readFileSync(path.join(r.updates, 'swap.log'), 'utf8'), /swap ok/);
});

test('helper: a new bundle that never writes launched-ok is stopped and rolled back', { skip: !mac && 'macOS only' }, async () => {
  const r = rig();
  const current = fakeApp(r.apps, { version: '1.1.0', kind: 'old' });
  const next = fakeApp(path.join(r.updates, 'staged'), { version: '1.2.0', kind: 'hang' });
  assert.equal(await runHelper(r, current, next, { timeout: 2 }), 2);
  assert.equal(versionOf(current), '1.1.0', 'the old app is back');
  assert.equal(versionOf(path.join(r.updates, 'failed', 'Plexiform.app')), '1.2.0');
  // the relaunched old app runs in the background after the helper exits
  for (let i = 0; i < 50 && lines(r.log).length < 2; i++) await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(lines(r.log), ['1.2.0 --updated-from=1.1.0', '1.1.0 --update-failed']);
  const hung = Number(fs.readFileSync(path.join(r.updates, 'launched-pid'), 'utf8'));
  assert.equal(alive(hung), false, 'the hung new app was stopped');
  assert.match(fs.readFileSync(path.join(r.updates, 'swap.log'), 'utf8'), /rolled back to 1\.1\.0/);
});

test('preflight: a folder it cannot write to gives not-writable; a translocated app gives translocated', { skip: !mac && 'macOS only' }, () => {
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
  assert.equal(MacSwap.bundleOf('/Applications/X.app/Contents/MacOS/X'), '/Applications/X.app');
  assert.equal(MacSwap.bundleOf('/usr/local/bin/node'), null);
});

test('end to end: signed zip on the feed → verified → unpacked → swapped → relaunched; then revert', { skip: !mac && 'macOS only' }, async () => {
  const feed = await startFeed();
  const { privateKey, keys } = keyPair();
  const r = rig();
  Object.assign(process.env, { FAKE_LOG: r.env.FAKE_LOG, FAKE_UPDATES: r.env.FAKE_UPDATES });
  try {
    const current = fakeApp(r.apps, { version: '1.1.0', kind: 'good' });
    const build = path.join(r.root, 'build');
    fakeApp(build, { version: '1.2.0', kind: 'good' });
    const zip = path.join(r.root, 'Plexiform-1.2.0-mac-arm64.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(build, 'Plexiform.app'), zip]);
    publish(feed, { privateKey, version: '1.2.0', files: [{ name: 'Plexiform-1.2.0-mac-arm64.zip', body: fs.readFileSync(zip), platform: 'darwin', arch: 'arm64', kind: 'mac-zip' }] });

    const exe = path.join(current, 'Contents', 'MacOS', 'Plexiform');
    let quits = 0;
    const make = () => {
      const old = standIn();
      const backend = MacSwap.create({ fetch, userData: r.userData, execPath: exe, pid: old.pid, quit: () => { quits++; }, launch: 'direct', timeoutSec: 5 });
      return createService({ fetch, keys, feedBase: feed.base, currentVersion: versionOf(current), userData: r.userData, backend, platform: 'darwin', arch: 'arm64', retryDelayMs: 0, log: quiet });
    };
    const swapDone = async (n) => {
      for (let i = 0; i < 100 && (lines(path.join(r.updates, 'swap.log')).filter((l) => /swap ok|rolled back|abandoned/.test(l)).length < n); i++) await new Promise((res) => setTimeout(res, 100));
    };

    const svc = make();
    assert.deepEqual(await svc.check(), { ok: true });
    assert.equal(svc.getState().status, 'ready');
    assert.equal(svc.getState().installKind, 'swap');
    assert.deepEqual(await svc.install({ when: 'now' }), { ok: true });
    assert.equal(quits, 1);
    await swapDone(1);
    assert.equal(versionOf(current), '1.2.0');
    assert.deepEqual(lines(r.log), ['1.2.0 --updated-from=1.1.0']);

    // the relaunched 1.2.0 can go back to the kept 1.1.0
    const after = make();
    assert.deepEqual([after.getState().canRevert, after.getState().previousVersion], [true, '1.1.0']);
    assert.deepEqual(await after.revert(), { ok: true });
    assert.equal(after.getState().status, 'ready');
    assert.equal(after.getState().available.version, '1.1.0');
    assert.deepEqual(await after.install({ when: 'now' }), { ok: true });
    await swapDone(2);
    assert.equal(versionOf(current), '1.1.0');
    assert.equal(versionOf(path.join(r.updates, 'previous', 'Plexiform.app')), '1.2.0');
  } finally {
    await feed.close();
  }
});

test('an unpacked app with another bundle id or version is refused (verify)', { skip: !mac && 'macOS only' }, async () => {
  const feed = await startFeed();
  const { privateKey, keys } = keyPair();
  try {
    for (const [over, want] of [[{ id: 'com.evil.app' }, /com\.evil\.app/], [{ version: '9.9.9' }, /version 9\.9\.9/]]) {
      const r = rig();
      const current = fakeApp(r.apps, { version: '1.1.0', kind: 'old' });
      const build = path.join(r.root, 'build');
      fakeApp(build, { version: '1.2.0', kind: 'good', ...over });
      const zip = path.join(r.root, 'z.zip');
      execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(build, 'Plexiform.app'), zip]);
      publish(feed, { privateKey, version: '1.2.0', files: [{ name: 'Plexiform-1.2.0-mac-arm64.zip', body: fs.readFileSync(zip), platform: 'darwin', arch: 'arm64', kind: 'mac-zip' }] });
      const backend = MacSwap.create({ fetch, userData: r.userData, execPath: path.join(current, 'Contents', 'MacOS', 'Plexiform') });
      const svc = createService({ fetch, keys, feedBase: feed.base, currentVersion: '1.1.0', userData: r.userData, backend, platform: 'darwin', arch: 'arm64', retryDelayMs: 0, log: quiet });
      assert.deepEqual(await svc.check(), { ok: false, error: 'verify' });
      assert.match(svc.getState().error.detail, want);
    }
  } finally {
    await feed.close();
  }
});

test('markLaunched: only after an update, the pid at once and launched-ok later', () => {
  const ud = tmpDir('ml');
  const timers = [];
  assert.equal(MacSwap.markLaunched({ userData: ud, argv: ['x'], setTimer: (fn) => timers.push(fn) }), false);
  assert.equal(MacSwap.markLaunched({ userData: ud, argv: ['x', '--updated-from=1.1.0'], pid: 4242, setTimer: (fn) => timers.push(fn) }), true);
  assert.equal(fs.readFileSync(path.join(ud, 'updates', 'launched-pid'), 'utf8'), '4242');
  assert.ok(!fs.existsSync(path.join(ud, 'updates', 'launched-ok')));
  timers[0]();
  assert.ok(fs.existsSync(path.join(ud, 'updates', 'launched-ok')));
});
