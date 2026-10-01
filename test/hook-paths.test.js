const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HookPaths = require('../src/hook-paths.js');

const base = { execPath: '/x/Plexiform', resourcesPath: '/x/resources', appDir: '/src', appPath: '/x/resources/app.asar', rootDir: '/home/u/.claude-traffic-light', version: '1.2.3' };

test('hook paths: macOS and Windows keep the app binary and its Resources, AppImage or not', () => {
  for (const platform of ['darwin', 'win32']) {
    const r = HookPaths.choose({ ...base, packaged: true, platform, env: { APPIMAGE: '/ignored' } });
    assert.deepEqual(r, { execPath: '/x/Plexiform', hooksDir: '/x/resources/hooks', mcpAppPath: '/x/resources/app.asar', stableDir: null, copyFrom: null });
  }
});

test('hook paths: a Linux .deb (no $APPIMAGE) uses the installed binary', () => {
  const r = HookPaths.choose({ ...base, packaged: true, platform: 'linux', env: {} });
  assert.equal(r.execPath, '/x/Plexiform');
  assert.equal(r.hooksDir, '/x/resources/hooks');
  assert.equal(r.copyFrom, null);
});

test('hook paths: an AppImage points at $APPIMAGE and a per-version copy in the data folder', () => {
  const r = HookPaths.choose({ ...base, packaged: true, platform: 'linux', env: { APPIMAGE: '/home/u/Apps/Plexiform.AppImage' } });
  assert.equal(r.execPath, '/home/u/Apps/Plexiform.AppImage');
  assert.equal(r.stableDir, '/home/u/.claude-traffic-light/hooks-1.2.3');
  assert.equal(r.hooksDir, '/home/u/.claude-traffic-light/hooks-1.2.3/hooks');
  assert.equal(r.mcpAppPath, r.stableDir, 'the MCP entry runs the stub, not a path into the mount');
  assert.equal(r.copyFrom, '/x/resources');
});

test('hook paths: a dev run is plain node against the checkout', () => {
  const r = HookPaths.choose({ ...base, packaged: false, platform: 'linux', env: { APPIMAGE: '/a' } });
  assert.equal(r.execPath, null);
  assert.equal(r.hooksDir, '/src/hooks');
});

test('hook paths: materialize copies hooks and adapters, writes the MCP stub; prune (after the lock) drops older versions only', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-hookpaths-'));
  const res = path.join(tmp, 'resources');
  const root = path.join(tmp, 'data');
  fs.mkdirSync(path.join(res, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(res, 'adapters'), { recursive: true });
  fs.writeFileSync(path.join(res, 'hooks', 'set-status.js'), 'v2');
  fs.writeFileSync(path.join(res, 'adapters', 'runtime.js'), 'rt');
  fs.mkdirSync(path.join(root, 'hooks-1.0.0', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  const r = HookPaths.resolve({ ...base, rootDir: root, resourcesPath: res, packaged: true, platform: 'linux', env: { APPIMAGE: '/a.AppImage' } });
  assert.equal(fs.readFileSync(path.join(r.hooksDir, 'set-status.js'), 'utf8'), 'v2');
  assert.equal(fs.readFileSync(path.join(r.stableDir, 'adapters', 'runtime.js'), 'utf8'), 'rt');
  assert.equal(fs.readFileSync(path.join(r.stableDir, 'mcp-server.js'), 'utf8'), HookPaths.MCP_STUB);
  assert.deepEqual(fs.readdirSync(root).sort(), ['config.json', 'hooks-1.0.0', 'hooks-1.2.3', 'sessions'], 'resolve runs before the lock: it deletes nothing');
  HookPaths.prune(r);
  assert.deepEqual(fs.readdirSync(root).sort(), ['config.json', 'hooks-1.2.3', 'sessions']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hook paths: a failed copy falls back to the mounted paths rather than pointing at nothing', () => {
  const logs = [];
  const r = HookPaths.resolve({ ...base, packaged: true, platform: 'linux', env: { APPIMAGE: '/a.AppImage' } }, { readFileSync() { throw new Error('ENOENT'); }, rmSync() {}, cpSync() { throw new Error('EACCES'); } }, (m) => logs.push(m));
  assert.equal(r.hooksDir, '/x/resources/hooks');
  assert.equal(r.execPath, '/x/Plexiform');
  assert.match(logs[0], /EACCES/);
});

// M6 (code review): a second launch must not delete the copy the running app's hooks use.
test('hook paths: a finished copy (.ok) is left alone; a new one is built aside and renamed into place', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-hookpaths-'));
  const res = path.join(tmp, 'resources');
  const root = path.join(tmp, 'data');
  for (const d of ['hooks', 'adapters']) fs.mkdirSync(path.join(res, d), { recursive: true });
  fs.writeFileSync(path.join(res, 'hooks', 'set-status.js'), 'v1');
  const opts = { ...base, rootDir: root, resourcesPath: res, packaged: true, platform: 'linux', env: { APPIMAGE: '/a.AppImage' } };
  const chosen = HookPaths.choose(opts);
  const calls = [];
  const spy = new Proxy(fs, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { calls.push([k, ...a.filter((x) => typeof x === 'string')]); return t[k](...a); } : t[k]) });
  assert.equal(HookPaths.materialize(chosen, spy, 4242), true);
  const writes = calls.filter(([k]) => ['cpSync', 'writeFileSync'].includes(k));
  assert.ok(writes.every(([k, a, b]) => (k === 'cpSync' ? b : a).startsWith(`${chosen.stableDir}.tmp-4242`)), 'every file is written to the temp copy');
  assert.deepEqual(calls.find(([k]) => k === 'renameSync').slice(1), [`${chosen.stableDir}.tmp-4242`, chosen.stableDir]);
  assert.equal(fs.readFileSync(path.join(chosen.stableDir, '.ok'), 'utf8'), 'hooks-1.2.3');
  // a second launch of the same version: nothing removed or rewritten
  fs.writeFileSync(path.join(res, 'hooks', 'set-status.js'), 'changed');
  calls.length = 0;
  assert.equal(HookPaths.materialize(chosen, spy, 4243), false);
  assert.deepEqual(calls.filter(([k]) => k !== 'readFileSync'), []);
  assert.equal(fs.readFileSync(path.join(chosen.hooksDir, 'set-status.js'), 'utf8'), 'v1');
  // a half-made copy (no .ok) is replaced
  fs.rmSync(path.join(chosen.stableDir, '.ok'));
  assert.equal(HookPaths.materialize(chosen, fs, 4244), true);
  assert.equal(fs.readFileSync(path.join(chosen.hooksDir, 'set-status.js'), 'utf8'), 'changed');
  fs.rmSync(tmp, { recursive: true, force: true });
});
