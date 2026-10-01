// scripts/forget-local-build.js: a local macOS build's app copies are taken
// back out of LaunchServices and moved to the Bin; CI and other platforms
// are left alone. Temp dirs and a stub runner only, nothing real is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { forgetLocalBuild, LSREGISTER } = require('../scripts/forget-local-build.js');

function fakeBuild() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forget-build-'));
  const dist = path.join(root, 'dist');
  const app = path.join(dist, 'mac-arm64', 'Plexiform.app');
  fs.mkdirSync(path.join(app, 'Contents', 'Frameworks', 'Plexiform Helper.app', 'Contents'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'Frameworks', 'Plexiform Helper (Renderer).app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'Plexiform-1.0.0-mac-arm64.dmg'), 'dmg');
  const trash = path.join(root, 'Trash');
  fs.mkdirSync(trash);
  return { root, dist, app, trash };
}

test('a local macOS build: every bundle is unregistered, helpers first, then the app goes to the Bin', () => {
  const { dist, app, trash } = fakeBuild();
  const calls = [];
  const r = forgetLocalBuild({ dist, platform: 'darwin', env: {}, trash, now: () => 7, run: (f, a) => calls.push([f, ...a]), log: () => {} });
  assert.deepEqual(r.apps, [app]);
  assert.ok(calls.every((c) => c[0] === LSREGISTER && c[1] === '-u'));
  const unregistered = calls.map((c) => path.basename(c[2]));
  assert.deepEqual(unregistered.sort(), ['Plexiform Helper (Renderer).app', 'Plexiform Helper.app', 'Plexiform.app'].sort());
  assert.equal(unregistered.at(-1), 'Plexiform.app', 'the app itself last');
  assert.equal(fs.existsSync(app), false);
  assert.ok(fs.existsSync(path.join(trash, 'Plexiform-build-7.app', 'Contents')));
  assert.ok(fs.existsSync(path.join(dist, 'Plexiform-1.0.0-mac-arm64.dmg')), 'installers stay');
});

test('CI and Windows/Linux are left alone', () => {
  for (const [platform, env] of [['darwin', { CI: 'true' }], ['win32', {}], ['linux', {}]]) {
    const { dist, app, trash } = fakeBuild();
    const calls = [];
    const r = forgetLocalBuild({ dist, platform, env, trash, run: (...a) => calls.push(a), log: () => {} });
    assert.equal(r.skipped, true, platform);
    assert.equal(calls.length, 0);
    assert.ok(fs.existsSync(app));
  }
});

test('no dist folder is nothing to do; an unregister failure is logged and the move still happens', () => {
  assert.deepEqual(forgetLocalBuild({ dist: path.join(os.tmpdir(), 'no-such-dist-xyz'), platform: 'darwin', env: {}, run: () => {}, log: () => {} }).apps, []);
  const { dist, app, trash } = fakeBuild();
  const logs = [];
  forgetLocalBuild({ dist, platform: 'darwin', env: {}, trash, run: () => { throw new Error('nope'); }, log: (m) => logs.push(m) });
  assert.ok(logs.some((m) => /could not unregister/.test(m)));
  assert.equal(fs.existsSync(app), false);
});
