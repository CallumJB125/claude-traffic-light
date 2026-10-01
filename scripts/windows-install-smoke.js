'use strict';
// Real NSIS/portable lifecycle acceptance on a GitHub-hosted Windows runner.
// Source tests inject process execution; they do not count as Windows acceptance.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const Brand = require('../brand');
const Smoke = require('./smoke-installed');
const Uninstall = require('../adapters/uninstall-all');
const Diagnostics = require('./windows-install-diagnostics');

function allowedRunner(platform = process.platform, env = process.env) {
  return platform === 'win32' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_OS === 'Windows' && env.RUNNER_ENVIRONMENT === 'github-hosted';
}

function nsisLaunch(exe, operation, installDir, cwd, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path;
  for (const file of [exe, installDir, cwd]) if (typeof file !== 'string' || file.length > 4096 || /[\0\r\n"]/.test(file) || !paths.isAbsolute(file)) throw new Error('Invalid trusted NSIS fixture path');
  const relative = paths.relative(installDir, cwd);
  if (!relative || (!relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative))) throw new Error('NSIS cwd must be outside the installation');
  const flags = { install: ['/S', '/currentuser'], update: ['/S', '--updated', '/currentuser'], uninstall: ['/S', '/currentuser'] };
  if (!Object.hasOwn(flags, operation)) throw new Error('Unsupported NSIS fixture operation');
  const args = [...flags[operation], `${operation === 'uninstall' ? '_?=' : '/D='}${installDir}`];
  // NSIS parses the unquoted remainder of the command line after /D= or _?=.
  return { args, options: { cwd, shell: false, windowsVerbatimArguments: platform === 'win32', ...(platform === 'win32' ? { argv0: `"${exe}"` } : {}) } };
}

function execute(exe, args, env, options) {
  const timeoutMs = 120000;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(exe, args, { ...options, env, shell: false, stdio: 'inherit', windowsHide: true }); // privacy-flow: release-smoke
    const result = (code, timedOut, signal = null) => ({ pid: child.pid ?? null, started, elapsedMs: Date.now() - started, code, signal, timedOut });
    const timer = setTimeout(() => {
      let terminationRequested = false;
      try { terminationRequested = child.kill(); } catch { /* Failure remains terminal; no cleanup claims. */ }
      reject(Object.assign(new Error(`${path.basename(exe)} exceeded ${timeoutMs} ms`), { processReceipt: { ...result(null, true), terminationRequested } }));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(Object.assign(error, { processReceipt: { ...result(null, false), failedToStart: true } })); });
    child.once('exit', (code, signal) => { clearTimeout(timer); const processReceipt = result(code, false, signal); code === 0 ? resolve(processReceipt) : reject(Object.assign(new Error(`${path.basename(exe)} exited ${code}`), { processReceipt })); });
  });
}

function verifiedUninstaller(source, root) {
  const stamp = st => `${st.dev}/${st.ino}/${st.size}/${st.mtimeMs}/${st.ctimeMs}`;
  const read = file => {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > 32 * 1024 * 1024) throw new Error('Uninstaller must be a bounded regular file');
    const bytes = fs.readFileSync(file);
    if (bytes.length !== before.size || stamp(before) !== stamp(fs.lstatSync(file))) throw new Error('Uninstaller changed during verification');
    return { hash: crypto.createHash('sha256').update(bytes).digest('hex'), stamp: stamp(before) };
  };
  const original = read(source), dir = path.join(root, 'uninstaller-copy');
  fs.mkdirSync(dir); // Exclusive; a collision is never adopted or cleaned up.
  const exe = path.join(dir, 'uninstaller.exe');
  fs.copyFileSync(source, exe, fs.constants.COPYFILE_EXCL);
  const copied = read(exe), current = read(source);
  if (copied.hash !== original.hash || current.hash !== original.hash || current.stamp !== original.stamp) throw new Error('Uninstaller copy identity mismatch');
  return { exe, hash: original.hash, verify: () => { const now = read(exe); if (now.hash !== copied.hash || now.stamp !== copied.stamp) throw new Error('Copied uninstaller changed before execution'); } };
}

function remainingFiles(installDir) {
  let dir;
  try { dir = fs.lstatSync(installDir); } catch (error) { if (error.code === 'ENOENT') return { present: false, entries: [], truncated: false }; throw error; }
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Installation directory type changed');
  const names = fs.readdirSync(installDir).sort(), entries = names.slice(0, 32).map(name => {
    const st = fs.lstatSync(path.join(installDir, name));
    return { name: name.slice(0, 128), type: st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other', size: st.size };
  });
  return { present: true, entries, truncated: names.length > 32 || names.some(name => name.length > 128) };
}

function existsChecked(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function findAssets(dir, version) {
  const installer = path.join(dir, `${Brand.name}-${version}-win-x64.exe`);
  const portable = path.join(dir, `${Brand.name}-${version}-win-x64-portable.exe`);
  for (const file of [installer, portable]) if (!fs.statSync(file).isFile()) throw new Error(`Missing Windows asset ${file}`);
  return { installer, portable };
}

async function runLifecycle({ installer, portable, root, actualAppData, env = process.env, run = execute, diagnostics = Diagnostics.collect, smoke = Smoke.runPackagedSmoke, runHook = require('../src/smoke').runHook, receipt }) {
  const installDir = path.join(root, 'installed app with spaces');
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
  const runNsis = (file, operation) => { const spec = nsisLaunch(file, operation, installDir, root); return run(file, spec.args, childEnv, spec.options); };
  await runNsis(installer, 'install');
  if (!fs.existsSync(exe)) throw new Error('NSIS did not install the executable');
  mark('installed');
  await smoke({ ...fixture, exe, report: path.join(root, 'installed.json'), extraEnv: childEnv });
  retain(); mark('installed-launch-hooks-window-quit');
  // Same-version --updated proves the real upgrade removal path. A version
  // transition through the signed updater remains a separate acceptance gate.
  await runNsis(installer, 'update');
  retain(); mark('update-mode-data-retained');
  await smoke({ ...fixture, exe, report: path.join(root, 'updated.json'), extraEnv: childEnv });
  retain(); mark('updated-launch-hooks-window-quit');
  const uninstaller = path.join(installDir, `Uninstall ${Brand.name}.exe`);
  if (!fs.existsSync(uninstaller)) throw new Error('NSIS did not provide its uninstaller');
  const canonicalInstallDir = fs.realpathSync.native(installDir);
  const copied = verifiedUninstaller(uninstaller, root);
  let processReceipt = null;
  const record = async phase => {
    let observation;
    try { observation = await diagnostics(installDir, { canonicalInstallDir, env: childEnv }); }
    catch { observation = { ok: false, error: 'diagnostic collector failed' }; }
    let files;
    try { files = remainingFiles(installDir); } catch { files = { error: 'remaining-file inspection failed' }; }
    const report = { phase, canonicalInstallDir, copiedSha256: copied.hash, processReceipt, diagnostics: observation, files };
    const text = JSON.stringify(report, null, 2);
    fs.writeFileSync(path.join(root, `uninstall-${phase}.json`), Buffer.byteLength(text) <= 65536 ? text : JSON.stringify({ phase, error: 'diagnostic report exceeded bound', truncated: true }));
    if (!observation?.ok || files.error || files.truncated || Buffer.byteLength(text) > 65536) throw new Error('Uninstaller diagnostics are incomplete');
  };
  try {
    await record('before');
    copied.verify();
    processReceipt = await runNsis(copied.exe, 'uninstall');
    await record('after');
    if (fs.existsSync(exe) || existsChecked(exe)) throw new Error('Uninstaller left the app executable behind');
  } catch (error) {
    processReceipt = error.processReceipt ?? processReceipt;
    try { await record('failed'); } catch { /* Preserve the original failure and bounded diagnostics. */ }
    throw error;
  }
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
  if (!allowedRunner()) throw new Error('Windows installer acceptance requires a GitHub-hosted Windows runner');
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
module.exports = { allowedRunner, findAssets, runLifecycle, nsisLaunch, verifiedUninstaller };
