'use strict';
// Real NSIS/portable lifecycle acceptance on a disposable GitHub Windows runner.
// Source tests inject process execution; they do not count as Windows acceptance.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const Brand = require('../brand');
const Smoke = require('./smoke-installed');
const Uninstall = require('../adapters/uninstall-all');

function allowedRunner(platform = process.platform, env = process.env) {
  return platform === 'win32' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_OS === 'Windows';
}

function execute(exe, args, env, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, shell: false, stdio: 'inherit', windowsHide: true }); // privacy-flow: release-smoke
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(exe)} exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${path.basename(exe)} exited ${code}`)); });
  });
}

function findAssets(dir, version) {
  const installer = path.join(dir, `${Brand.name}-${version}-win-x64.exe`);
  const portable = path.join(dir, `${Brand.name}-${version}-win-x64-portable.exe`);
  for (const file of [installer, portable]) if (!fs.statSync(file).isFile()) throw new Error(`Missing Windows asset ${file}`);
  return { installer, portable };
}

async function runLifecycle({ installer, portable, root, actualAppData, env = process.env, run = execute, smoke = Smoke.runPackagedSmoke, runHook = require('../src/smoke').runHook, receipt }) {
  const installDir = path.join(root, 'installed');
  const fixture = Smoke.fixture(path.join(root, 'fixture'));
  const settings = path.join(fixture.home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const foreign = { synthetic_foreign_setting: { retained: 'installer smoke sentinel' } };
  fs.writeFileSync(settings, JSON.stringify(foreign));
  // Test the exact AppData directory NSIS would remove as well as the profile
  // explicitly used by the app. Refuse an existing profile before seeding it.
  const appData = path.join(actualAppData, Brand.name);
  if (fs.existsSync(appData)) throw new Error('Refusing to use an existing Plexiform AppData profile');
  const sentinels = new Map();
  for (const dir of [appData, fixture.data, fixture.userData]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['preserved-board.db', 'preserved-settings.json', 'preserved-journal.bin']) {
      const file = path.join(dir, name), bytes = Buffer.from(`Synthetic retained bytes: ${name}\r\n`);
      fs.writeFileSync(file, bytes); sentinels.set(file, bytes);
    }
  }
  const retain = () => {
    for (const [file, bytes] of sentinels) if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) throw new Error(`Data changed: ${file}`);
    if (JSON.stringify(JSON.parse(fs.readFileSync(settings)).synthetic_foreign_setting) !== JSON.stringify(foreign.synthetic_foreign_setting)) throw new Error('Foreign agent configuration changed');
  };
  const childEnv = { ...env, HOME: fixture.home, USERPROFILE: fixture.home, CLAUDE_TRAFFIC_LIGHT_HOME: fixture.data };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const exe = path.join(installDir, `${Brand.name}.exe`);
  const stages = [];
  const save = () => fs.writeFileSync(receipt, JSON.stringify({ platform: process.platform, version: require('../package.json').version, stages }, null, 2));
  const mark = name => { stages.push(name); save(); };
  // /D must be the final argument; NSIS treats the rest of the line as its path.
  await run(installer, ['/S', '/currentuser', `/D=${installDir}`], childEnv);
  if (!fs.existsSync(exe)) throw new Error('NSIS did not install the executable');
  mark('installed');
  await smoke({ ...fixture, exe, report: path.join(root, 'installed.json'), extraEnv: childEnv });
  retain(); mark('installed-launch-hooks-window-quit');
  // Same-version --updated proves the real upgrade removal path. A version
  // transition through the signed updater remains a separate acceptance gate.
  await run(installer, ['/S', '--updated', '/currentuser', `/D=${installDir}`], childEnv);
  retain(); mark('update-mode-data-retained');
  await smoke({ ...fixture, exe, report: path.join(root, 'updated.json'), extraEnv: childEnv });
  retain(); mark('updated-launch-hooks-window-quit');
  const uninstaller = path.join(installDir, `Uninstall ${Brand.name}.exe`);
  if (!fs.existsSync(uninstaller)) throw new Error('NSIS did not provide its uninstaller');
  await run(uninstaller, ['/S', `/currentuser`, `_?=${installDir}`], childEnv);
  if (fs.existsSync(exe)) throw new Error('Uninstaller left the app executable behind');
  retain();
  const leftovers = require('../adapters').list().filter(adapter => fs.existsSync(adapter.configPath(fixture.home)) && Uninstall.holdsOurs(adapter, adapter.configPath(fixture.home)));
  if (leftovers.length) throw new Error(`Uninstaller left registered hooks: ${leftovers.map(a => a.id).join(', ')}`);
  mark('uninstalled-hooks-removed-data-retained');
  await smoke({ ...fixture, exe: portable, report: path.join(root, 'portable.json'), extraEnv: childEnv });
  retain(); mark('portable-launch-hooks-window-quit');
  const command = require('../src/smoke').firstHookCommand(settings, 'SessionStart');
  if (!command) throw new Error('Portable copy did not register a hook');
  const sessionId = `portable-after-exit-${process.pid}`;
  const hook = await runHook(command, { session_id: sessionId, hook_event_name: 'SessionStart', cwd: root, transcript_path: path.join(root, `${sessionId}.jsonl`), source: 'startup' }, { env: childEnv });
  if (hook.code !== 0 || !fs.readdirSync(path.join(fixture.data, 'sessions')).some(name => name.includes(sessionId))) throw new Error('Portable hook did not survive app exit');
  retain(); mark('portable-hook-after-exit');
  return { stages, root };
}

async function main() {
  if (!allowedRunner()) throw new Error('Windows installer acceptance requires a disposable GitHub Actions Windows runner');
  if (!process.env.APPDATA) throw new Error('APPDATA is absent');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'plexiform-windows-install-'));
  const evidence = path.join(__dirname, '..', 'work', 'windows-release');
  fs.mkdirSync(evidence, { recursive: true });
  const receipt = path.join(evidence, 'lifecycle.json');
  const collect = () => {
    // Keep bounded reports/Chromium logs, never the installed application or
    // whole Chromium profile (which would make evidence upload another build).
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      if (item.isFile() && /\.(json|log)$/.test(item.name)) fs.copyFileSync(path.join(root, item.name), path.join(evidence, item.name));
    }
  };
  try {
    const result = await runLifecycle({ ...findAssets(path.join(__dirname, '..', 'dist'), require('../package.json').version), root, actualAppData: process.env.APPDATA, receipt });
    collect();
    console.log(`Windows installer acceptance: ${result.stages.join(' → ')}`);
  } catch (error) {
    collect();
    throw error;
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { allowedRunner, findAssets, runLifecycle };
