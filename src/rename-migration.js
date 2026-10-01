// Carries an install made under the old name (Claude Buddy,
// com.callumbaker.claude-buddy) across to Plexiform on its first launch.
//
// Electron names the userData folder after the packaged package.json's
// productName, else its npm name. The old build had no top-level productName,
// so its folder was <appData>/claude-buddy (~/Library/Application Support on
// macOS, %APPDATA% on Windows, ~/.config on Linux); Plexiform's is
// <appData>/Plexiform. copyUserData runs before anything opens userData (the
// single-instance lock, the updater, the team window) and copies, never moves,
// the old folder: the old app keeps working if the person goes back to it.
//
// The rest waits for app ready and runs once (the pending list in
// rename-migration.json, inside the new folder): ask a running old copy to
// quit, point the agents' hooks and the MCP entry at this app, move Open at
// Login across, and offer to put the old app in the Bin. Everything that
// touches the machine is passed in, so tests run against a temp HOME with
// stubbed processes, dialogs and Bin.
const fs = require('fs');
const path = require('path');

const OLD = Object.freeze({
  productName: 'Claude Buddy',
  userDataName: 'claude-buddy',
  appId: 'com.callumbaker.claude-buddy',
  macBundleName: 'Claude Buddy.app',
  // the main process only; its helpers are "Claude Buddy Helper (…)"
  macExecutable: /\/Claude Buddy\.app\/Contents\/MacOS\/Claude Buddy$/,
  // the old .deb installed into /opt/<productName>
  linuxExecutable: /^\/opt\/Claude Buddy\/plexiform(?: |$)/,
});

const STATE_FILE = 'rename-migration.json';
const STEPS = ['quit-old', 'hooks', 'login', 'remove-old-app'];

// Not copied, by top-level name:
//   Singleton*        the old instance's lock; a live one would make this app quit
//   updates           the old app's staged and half-downloaded updates
//   buddy-accounts,   sealed with safeStorage under the old Keychain item,
//   buddy-devices     which this app never reads: the person signs in again
//   caches            Chromium rebuilds them
const SKIP = new Set([
  'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'updates', 'buddy-accounts', 'buddy-devices',
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'GrShaderCache', 'Crashpad',
]);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * → { copied, from, to, entries?, skipped?, reason? }. Copies into a temp
 * folder beside the new one and renames it into place, so a crash halfway
 * leaves no new folder and the next launch copies again.
 */
function copyUserData({ appData, userData, oldName = OLD.userDataName, fsImpl = fs, log = console.log, pid = process.pid, now = () => new Date() }) {
  const from = path.join(appData, oldName);
  const to = userData;
  if (fsImpl.existsSync(to)) return { copied: false, from, to, reason: 'the new folder already exists' };
  let stat = null;
  try { stat = fsImpl.lstatSync(from); } catch { /* no old install */ }
  if (!stat || !stat.isDirectory()) return { copied: false, from, to, reason: 'no old folder' };

  const prefix = `${path.basename(to)}.migrating-`;
  try {
    for (const n of fsImpl.readdirSync(path.dirname(to))) {
      if (n.startsWith(prefix) && !alive(Number(n.slice(prefix.length)))) fsImpl.rmSync(path.join(path.dirname(to), n), { recursive: true, force: true });
    }
  } catch { /* nothing to tidy */ }

  const tmp = `${to}.migrating-${pid}`;
  const entries = new Set();
  const skipped = new Set();
  fsImpl.rmSync(tmp, { recursive: true, force: true });
  try {
    fsImpl.cpSync(from, tmp, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      filter: (src) => {
        const rel = path.relative(from, src);
        if (!rel) return true;
        const top = rel.split(path.sep)[0];
        if (SKIP.has(top)) { skipped.add(top); return false; }
        entries.add(top);
        return true;
      },
    });
    const state = { from, copiedAt: now().toISOString(), entries: [...entries].sort(), skipped: [...skipped].sort(), pending: STEPS.slice() };
    fsImpl.writeFileSync(path.join(tmp, STATE_FILE), JSON.stringify(state, null, 2), { mode: 0o600 });
    fsImpl.renameSync(tmp, to);
  } catch (err) {
    fsImpl.rmSync(tmp, { recursive: true, force: true });
    // Another launch got there first: its copy stands.
    if (fsImpl.existsSync(to)) return { copied: false, from, to, reason: 'the new folder already exists' };
    log(`[rename] could not copy ${from} to ${to}: ${err.message}`);
    return { copied: false, from, to, reason: err.message };
  }
  log(`[rename] copied ${from} to ${to} (${[...entries].sort().join(', ') || 'empty'}; left out: ${[...skipped].sort().join(', ') || 'nothing'}); the old folder is untouched`);
  return { copied: true, from, to, entries: [...entries].sort(), skipped: [...skipped].sort() };
}

function readState(userData, fsImpl = fs) {
  try { return JSON.parse(fsImpl.readFileSync(path.join(userData, STATE_FILE), 'utf8')); } catch { return null; }
}

function pending(userData, fsImpl = fs) {
  const s = readState(userData, fsImpl);
  return Array.isArray(s?.pending) ? s.pending.filter((p) => STEPS.includes(p)) : [];
}

function markDone(userData, step, fsImpl = fs) {
  const s = readState(userData, fsImpl);
  if (!s || !Array.isArray(s.pending)) return;
  s.pending = s.pending.filter((p) => p !== step);
  fsImpl.writeFileSync(path.join(userData, STATE_FILE), JSON.stringify(s, null, 2), { mode: 0o600 });
}

// `ps` output → [{ pid, command }]
function parsePs(text) {
  return String(text || '').split('\n').map((l) => /^\s*(\d+)\s+(.+)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), command: m[2].trim() }));
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Asks a running old copy to quit, so two widgets don't rewrite the same
 * hooks. SIGTERM, not an Apple Event: Electron quits cleanly on it, and it
 * needs no Automation permission prompt. Then waits (up to waitMs, blocking:
 * this runs once, before any window) for it to go, because on its way out it
 * frees the signal port and deletes the port file this app is about to write.
 * → the pids asked.
 * listProcesses: () → [{ pid, command }] (the full executable path on macOS,
 * the command line on Linux).
 */
function quitOldInstance({ platform, listProcesses, kill = process.kill, isAlive = alive, sleep = sleepSync, waitMs = 5000, self = process.pid, log = console.log }) {
  const re = platform === 'darwin' ? OLD.macExecutable : platform === 'linux' ? OLD.linuxExecutable : null;
  if (!re) return [];
  let procs = [];
  try { procs = listProcesses(); } catch (err) { log(`[rename] could not list processes: ${err.message}`); return []; }
  const asked = [];
  for (const p of procs) {
    if (p.pid === self || !re.test(p.command)) continue;
    try { kill(p.pid, 'SIGTERM'); asked.push(p.pid); log(`[rename] asked the old app (pid ${p.pid}) to quit`); } catch (err) { log(`[rename] could not ask pid ${p.pid} to quit: ${err.message}`); }
  }
  for (let waited = 0; asked.some(isAlive) && waited < waitMs; waited += 100) sleep(100);
  const still = asked.filter(isAlive);
  if (still.length) log(`[rename] the old app (pid ${still.join(', ')}) is still running`);
  return asked;
}

/**
 * Points every agent config that holds Buddy's entries at this app, through
 * each adapter's own install (it strips Buddy's entries, whatever app path
 * they name, and adds the current ones; foreign entries and other keys stay),
 * and the MCP entry if it is Buddy's and names another path. Claude Code's
 * settings get their one-time .buddy-backup first. → [{ id, file, changed, error? }]
 */
function rewriteHooks({ home, runtime, askFromWidget = false, mcpEntry, adapters = require('../adapters/index.js'), holdsOurs = require('../adapters/uninstall-all.js').holdsOurs, mcp = require('../mcp-install.js'), fsImpl = fs, log = console.log }) {
  const Runtime = adapters.Runtime;
  const results = [];
  for (const adapter of adapters.list()) {
    const file = adapter.configPath(home);
    try {
      if (!fsImpl.existsSync(file) || !holdsOurs(adapter, file)) continue;
      if (adapter.id === 'claude') Runtime.backupOnce(file);
      const r = adapter.install({ home, runtime, ...(adapter.id === 'claude' ? { askFromWidget } : {}) });
      results.push({ id: adapter.id, file, changed: !!r.ok, ...(r.ok ? {} : { error: r.error }) });
    } catch (err) {
      results.push({ id: adapter.id, file, changed: false, error: err.message });
    }
  }
  if (mcpEntry) {
    const file = mcp.configPath(home);
    try {
      const st = mcp.status({ home, entry: mcpEntry });
      if (st.error) throw new Error(st.error);
      if (st.installed && !st.current) { mcp.install({ home, entry: mcpEntry }); results.push({ id: 'mcp', file, changed: true }); }
    } catch (err) {
      results.push({ id: 'mcp', file, changed: false, error: err.message });
    }
  }
  for (const r of results) log(`[rename] ${r.id}: ${r.error ? `left alone (${r.error})` : 'now points at this app'} ${r.file}`);
  return results;
}

/**
 * Open at Login follows the app across. The old app set it up on its first
 * run (the marker in ~/.claude-traffic-light); macOS gives no way to read or
 * remove another app's login item, so it is turned on for this one. On
 * Windows the old Run entry, named after the old AppUserModelID, goes. On
 * Linux the autostart file has the same name and only its Exec changes.
 */
function moveLoginItem({ platform, app, loginItem, autoLaunchConfigured, log = console.log }) {
  if (platform === 'linux') {
    if (loginItem.get()) loginItem.set(true);
    return;
  }
  if (autoLaunchConfigured) loginItem.set(true);
  if (platform === 'win32') {
    try { app.setLoginItemSettings({ openAtLogin: false, name: OLD.appId }); } catch (err) { log(`[rename] could not remove the old login item: ${err.message}`); }
  }
}

const oldAppPaths = (home) => ['/Applications', path.join(home, 'Applications')].map((d) => path.join(d, OLD.macBundleName));

/**
 * macOS: offers to put the old app in the Bin; never removes it unasked.
 * showDialog(options) → { response } (dialog.showMessageBox); trashItem(path)
 * → Promise (shell.trashItem). → [{ path, removed, error? }]
 */
async function offerRemoveOldApp({ platform, home, name, exists = fs.existsSync, showDialog, trashItem, log = console.log }) {
  if (platform !== 'darwin') return [];
  const out = [];
  for (const p of oldAppPaths(home).filter((x) => exists(x))) {
    const { response } = await showDialog({
      type: 'question',
      buttons: ['Remove', 'Keep'],
      defaultId: 1,
      cancelId: 1,
      message: `Remove the old ${OLD.productName} app?`,
      detail: `${OLD.productName} is now ${name}, and your settings have come across. Remove moves ${p} to the Bin. If you keep it, quit it and turn off its Open at Login, or the two will both try to run.`,
    });
    if (response !== 0) { out.push({ path: p, removed: false }); log(`[rename] kept ${p}`); continue; }
    try {
      await trashItem(p);
      out.push({ path: p, removed: true });
      log(`[rename] moved ${p} to the Bin`);
    } catch (err) {
      out.push({ path: p, removed: false, error: err.message });
      log(`[rename] could not move ${p} to the Bin: ${err.message}`);
    }
  }
  return out;
}

/**
 * Runs the steps still pending, each at most once. A step function returns
 * false to stay pending (e.g. hooks while running from a translocated copy).
 * steps: { 'quit-old': fn, hooks: fn, login: fn, 'remove-old-app': async fn }
 */
async function runFollowUp({ userData, steps, fsImpl = fs, log = console.log }) {
  for (const step of pending(userData, fsImpl)) {
    const fn = steps[step];
    if (!fn) continue;
    let keep = false;
    // Synchronous steps finish before this returns its promise, so main's own
    // hook check right after sees what they wrote.
    try {
      const r = fn();
      keep = (r && typeof r.then === 'function' ? await r : r) === false;
    } catch (err) { log(`[rename] ${step} failed: ${err.message}`); }
    if (!keep) markDone(userData, step, fsImpl);
  }
}

module.exports = { OLD, STATE_FILE, STEPS, SKIP, copyUserData, readState, pending, markDone, parsePs, quitOldInstance, rewriteHooks, moveLoginItem, oldAppPaths, offerRemoveOldApp, runFollowUp };
