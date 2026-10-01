'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Lifecycle = require('../scripts/windows-install-smoke');
const Adapters = require('../adapters');
const Brand = require('../brand');

function rig(t, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-lifecycle-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = path.join(root, 'installer.exe'), portable = path.join(root, 'portable.exe'), calls = [];
  const run = async (file, args, env) => {
    calls.push({ file, args, env });
    const installDir = path.join(root, 'installed');
    if (file === installer) {
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(path.join(installDir, `${Brand.name}.exe`), 'Synthetic app');
      fs.writeFileSync(path.join(installDir, `Uninstall ${Brand.name}.exe`), 'Synthetic uninstaller');
    } else {
      require('../adapters/uninstall-all').run({ home: env.USERPROFILE });
      fs.rmSync(installDir, { recursive: true });
    }
    mutate({ file, args, env, root });
  };
  const smoke = async f => {
    Adapters.get('claude').install({ home: f.home, runtime: Adapters.Runtime.make({ execPath: f.exe, dataDir: f.data, hooksDir: path.join(root, 'hooks') }) });
    return { ok: true };
  };
  const runHook = async (_command, payload, { env }) => {
    fs.writeFileSync(path.join(env.CLAUDE_TRAFFIC_LIGHT_HOME, 'sessions', `${payload.session_id}.json`), JSON.stringify(payload));
    return { code: 0 };
  };
  return { root, installer, portable, calls, run, smoke, runHook, actualAppData: path.join(root, 'appdata'), receipt: path.join(root, 'receipt.json') };
}

test('real installer acceptance refuses every environment except disposable GitHub Windows', () => {
  assert.equal(Lifecycle.allowedRunner('win32', { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows' }), true);
  for (const [platform, env] of [['darwin', { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows' }], ['win32', {}], ['win32', { GITHUB_ACTIONS: 'false', RUNNER_OS: 'Windows' }], ['win32', { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux' }]]) assert.equal(Lifecycle.allowedRunner(platform, env), false);
});

test('source harness retains foreign configuration and binary data across install, upgrade mode and uninstall', async t => {
  const f = rig(t), result = await Lifecycle.runLifecycle(f);
  assert.deepEqual(result.stages, ['installed', 'installed-launch-hooks-window-quit', 'update-mode-data-retained', 'updated-launch-hooks-window-quit', 'uninstalled-hooks-removed-data-retained', 'portable-launch-hooks-window-quit', 'portable-hook-after-exit']);
  assert.equal(f.calls.length, 3);
  for (const call of f.calls.slice(0, 2)) assert.equal(call.args.at(-1), `/D=${path.join(f.root, 'installed')}`);
  assert.ok(f.calls[1].args.includes('--updated'));
  assert.ok(f.calls[2].args.includes('/S'));
  assert.equal(f.calls.every(call => call.env.USERPROFILE.startsWith(f.root) && call.env.CLAUDE_TRAFFIC_LIGHT_HOME.startsWith(f.root)), true);
});

test('lifecycle evidence fails when a real operation loses a retained database', async t => {
  const f = rig(t, ({ args, env }) => { if (args.includes('--updated')) fs.unlinkSync(path.join(env.CLAUDE_TRAFFIC_LIGHT_HOME, 'preserved-board.db')); });
  await assert.rejects(Lifecycle.runLifecycle(f), /Data changed:/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt)).stages, ['installed', 'installed-launch-hooks-window-quit']);
});

test('lifecycle evidence fails if a hook only works while the portable app is open', async t => {
  const f = rig(t); f.runHook = async () => ({ code: 1 });
  await assert.rejects(Lifecycle.runLifecycle(f), /Portable hook did not survive app exit/);
});

test('installer smoke refuses an existing AppData profile without altering its bytes', async t => {
  const f = rig(t), dir = path.join(f.actualAppData, Brand.name), file = path.join(dir, 'existing.bin');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, 'Existing profile');
  await assert.rejects(Lifecycle.runLifecycle(f), /existing Plexiform AppData profile/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Existing profile');
  assert.equal(f.calls.length, 0);
});
