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
// Nothing the migration finds at the new folder is deleted: what is there is
// renamed to Plexiform.pre-migration-<time> and kept.
//
// The rest waits for app ready and runs once (the pending list in
// rename-migration.json, inside the new folder): point the old app's own
// entries in the agents' configs and the MCP entry at this app (each file
// copied to .pre-plexiform first), move Open at Login across, and offer to put
// the old app in the Bin. While the old app is still installed, a running copy
// of it is asked to quit on every launch. Everything that touches the machine
// is passed in, so tests run against a temp HOME with stubbed processes,
// dialogs and Bin, and planHooks lets the dry run show what would happen
// without writing anything.
const fs = require('fs');
const path = require('path');
const Runtime = require('../adapters/runtime.js');
const HookPaths = require('./hook-paths.js');

const OLD = Object.freeze({
  productName: 'Claude Buddy',
  userDataName: 'claude-buddy',
  appId: 'com.callumbaker.claude-buddy',
  macBundleName: 'Claude Buddy.app',
  // the main process only; its helpers are "Claude Buddy Helper (…)"
  macExecutable: /\/Claude Buddy\.app\/Contents\/MacOS\/Claude Buddy$/,
  // the old .deb installed into /opt/<productName>
  linuxExecutable: /^\/opt\/Claude Buddy\/plexiform(?: |$)/,
  // NSIS installs into Programs\<npm name>, which the rename keeps
  winExecutable: 'Claude Buddy.exe',
  // An installed old app's own path, as hook commands, the hook wrapper and
  // the MCP entry name it (JSON-escaped backslashes included).
  appPath: /\/Claude Buddy\.app\/|\/opt\/Claude Buddy\/|[\\/]Claude Buddy\.exe/i,
});

const STATE_FILE = 'rename-migration.json';
const STEPS = ['hooks', 'login', 'remove-old-app'];

// Not copied, by top-level name:
//   Singleton*        the old instance's lock; a live one would make this app quit
//   updates           the old app's staged and half-downloaded updates
//   buddy-accounts,   sealed with safeStorage under the old Keychain item,
//   buddy-devices     which this app never reads: the person signs in again
//   caches            Chromium rebuilds them
//   runner,           the team runner's outbox and worktrees, bound to the old
//   board-dev         paths and device credentials (left behind above); can be large
const SKIP = new Set([
  'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'updates', 'buddy-accounts', 'buddy-devices', 'runner', 'board-dev',
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'GrShaderCache', 'Crashpad',
]);

// A file, folder or link this user can read. Sockets, FIFOs and devices
// can't be copied (a FIFO would block the copy for good).
function copyable(src, fsImpl) {
  try {
    const st = fsImpl.lstatSync(src);
    if (st.isSymbolicLink()) return true;
    if (st.isDirectory()) { fsImpl.accessSync(src, fs.constants.R_OK | fs.constants.X_OK); return true; }
    if (st.isFile()) { fsImpl.accessSync(src, fs.constants.R_OK); return true; }
    return false;
  } catch { return false; }
}

const migrated = (state) => !!state && state.status !== 'retry';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Chromium's SingletonLock is a symlink to "<host>-<pid>". → the pid, or null.
function lockPid(dir, fsImpl = fs) {
  try {
    const t = fsImpl.readlinkSync(path.join(dir, 'SingletonLock'));
    const pid = Number(t.slice(t.lastIndexOf('-') + 1));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

// What Electron itself may have put in the new folder before main.js copies:
// app.getPath('userData') creates it empty (seen on Electron 44), and a
// crash reporter adds Crashpad. A folder holding only these was never used.
const FRESH = new Set(['Crashpad', '.DS_Store']);

// Tries at the copy (the first launch and its retries) before it stops.
const MAX_TRIES = 3;

/**
 * What is at the new folder right now → { kind, … }:
 *   absent | fresh (only FRESH names) | retry (a launch that couldn't copy ran on it)
 *   | migrated (copied, or kept after the last try) | live (a running instance's lock)
 *   | used (anything else) | unreadable
 */
function assessTarget(to, { fsImpl = fs, isAlive = alive } = {}) {
  if (!fsImpl.existsSync(to)) return { kind: 'absent' };
  const state = readState(to, fsImpl);
  if (migrated(state)) return { kind: 'migrated', state };
  const pid = lockPid(to, fsImpl);
  if (pid && isAlive(pid)) return { kind: 'live', pid };
  if (state) return { kind: 'retry', state };
  let names;
  try { names = fsImpl.readdirSync(to); } catch (err) { return { kind: 'unreadable', error: err.message }; }
  const used = names.filter((n) => !FRESH.has(n));
  return used.length ? { kind: 'used', used } : { kind: 'fresh', names };
}

// Why a folder in this state is not copied over (null: it may be).
function whyNot(t, name) {
  if (t.kind === 'migrated') return t.state.status === 'kept' ? `stopped trying after ${t.state.attempts} tries (${t.state.reason}); the folder is kept as it is` : 'already migrated';
  if (t.kind === 'live') return `${name} is already running on it (pid ${t.pid})`;
  if (t.kind === 'unreadable') return `the new folder can't be read (${t.error})`;
  if (t.kind === 'used') return `the new folder is already in use (${t.used.slice(0, 5).join(', ')}${t.used.length > 5 ? ', …' : ''})`;
  return null;
}

const stampOf = (d) => d.toISOString().replace(/[:.]/g, '-');

// The cpSync filter's decision for one path under the old folder, shared
// with the dry run: → null (the root) | { top, rel, take, why? }.
function copyDecision(from, src, fsImpl = fs) {
  const rel = path.relative(from, src);
  if (!rel) return null;
  const top = rel.split(path.sep)[0];
  if (SKIP.has(top)) return { top, rel, take: false, why: 'left out by name' };
  if (!copyable(src, fsImpl)) return { top, rel, take: false, why: 'unreadable, or a socket or FIFO' };
  return { top, rel, take: true };
}

/**
 * → { copied, from, to, entries?, skipped?, reason?, retry?, gaveUp?, keptAside? }.
 * Copies into a temp folder beside the new one and renames it into place, so
 * a crash halfway leaves no new folder and the next launch copies again.
 * Nothing at the new folder is ever deleted: a fresh one (see FRESH) or one a
 * launch that couldn't copy ran on ("retry") is renamed to
 * <name>.pre-migration-<time> and kept (an empty one is removed). It is
 * checked again right before that rename, as the copy can take seconds: one
 * that another launch has since migrated, started running on (its
 * SingletonLock names a live pid) or filled is left alone.
 *
 * When the copy can't happen this launch (the old app won't quit, or the
 * copy itself fails), the new folder gets a "retry" marker instead: this
 * launch runs on it, and the next one tries again, up to MAX_TRIES in all;
 * after that the folder is kept as it is and marked so.
 * Unreadable files, sockets and FIFOs are left out one by one (skipped).
 * quitOld() → whether the old app is gone; asked only when a copy is about
 * to happen, as its open databases must not be copied mid-write.
 */
function copyUserData({ appData, userData, oldName = OLD.userDataName, fsImpl = fs, log = console.log, pid = process.pid, now = () => new Date(), quitOld = () => true, isAlive = alive }) {
  const from = path.join(appData, oldName);
  const to = userData;
  const name = path.basename(to);
  const assess = () => assessTarget(to, { fsImpl, isAlive });
  const skip = (reason) => { log(`[rename] not copying ${from} to ${to}: ${reason}`); return { copied: false, from, to, reason }; };
  const first = assess();
  const tries = first.kind === 'retry' ? Number(first.state.attempts) || 1 : 0;
  const retryLater = (reason) => {
    // Only onto a folder that is still free to mark: not one another launch has since migrated or is running on.
    const t = assess();
    const not = whyNot(t, name);
    if (not) return skip(not);
    const attempts = tries + 1;
    const gaveUp = attempts >= MAX_TRIES;
    const state = gaveUp ? { status: 'kept', reason, attempts, at: now().toISOString(), pending: [] } : { status: 'retry', reason, attempts, at: now().toISOString() };
    try {
      fsImpl.mkdirSync(to, { recursive: true });
      fsImpl.writeFileSync(path.join(to, STATE_FILE), JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch (err) { log(`[rename] could not mark ${to}: ${err.message}`); }
    if (gaveUp) {
      log(`[rename] could not copy ${from} to ${to} (${reason}); stopped trying after ${attempts} tries, and ${to} is kept as it is`);
      return { copied: false, from, to, reason, retry: false, gaveUp: true };
    }
    log(`[rename] could not copy ${from} to ${to} (${reason}); trying again next launch`);
    return { copied: false, from, to, reason, retry: true };
  };
  const not = whyNot(first, name);
  if (not) return skip(not);
  let stat = null;
  try { stat = fsImpl.lstatSync(from); } catch { /* no old install */ }
  if (!stat || !stat.isDirectory()) return skip('no old folder');
  if (!quitOld()) return retryLater('the old app is still running');

  const prefix = `${name}.migrating-`;
  try {
    for (const n of fsImpl.readdirSync(path.dirname(to))) {
      if (n.startsWith(prefix) && !isAlive(parseInt(n.slice(prefix.length), 10))) fsImpl.rmSync(path.join(path.dirname(to), n), { recursive: true, force: true });
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
        const d = copyDecision(from, src, fsImpl);
        if (!d) return true;
        if (!d.take) { skipped.add(SKIP.has(d.top) ? d.top : d.rel); return false; }
        entries.add(d.top);
        return true;
      },
    });
    const state = { from, copiedAt: now().toISOString(), entries: [...entries].sort(), skipped: [...skipped].sort(), pending: STEPS.slice() };
    fsImpl.writeFileSync(path.join(tmp, STATE_FILE), JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (err) {
    fsImpl.rmSync(tmp, { recursive: true, force: true });
    return retryLater(err.message);
  }

  // Look again: the copy took time, and another launch may have taken the folder meanwhile.
  const t = assess();
  if (t.kind !== 'absent' && t.kind !== 'fresh' && t.kind !== 'retry') {
    fsImpl.rmSync(tmp, { recursive: true, force: true });
    return skip(whyNot(t, name));
  }
  // rename() onto a folder fails on Windows even when it is empty, so the
  // existing one goes aside first, and comes back if the copy can't take its place.
  let aside = null;
  try {
    if (t.kind !== 'absent') {
      aside = `${to}.pre-migration-${stampOf(now())}`;
      if (fsImpl.existsSync(aside)) aside = `${aside}-${pid}`;
      fsImpl.renameSync(to, aside);
    }
    try { fsImpl.renameSync(tmp, to); } catch (err) {
      if (aside && fsImpl.existsSync(aside) && !fsImpl.existsSync(to)) fsImpl.renameSync(aside, to);
      aside = null;
      throw err;
    }
  } catch (err) {
    fsImpl.rmSync(tmp, { recursive: true, force: true });
    return retryLater(err.message);
  }
  let keptAside = null;
  if (aside) {
    // Only an empty folder goes (rmdir refuses anything else); one with files in it is kept.
    try { fsImpl.rmdirSync(aside); } catch { keptAside = aside; }
    if (keptAside) log(`[rename] kept the folder ${name} used before the copy as ${keptAside}`);
  }
  log(`[rename] copied ${from} to ${to} (${[...entries].sort().join(', ') || 'empty'}; left out: ${[...skipped].sort().join(', ') || 'nothing'}); the old folder is untouched`);
  return { copied: true, from, to, entries: [...entries].sort(), skipped: [...skipped].sort(), ...(keptAside ? { keptAside } : {}) };
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

// `tasklist /FO CSV /NH` output → [{ pid, command: image name }]
function parseTasklist(text) {
  return String(text || '').split(/\r?\n/).map((l) => /^"([^"]*)","(\d+)"/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[2]), command: m[1] }));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whether a listed process is the old app's main process. macOS: only an
// install in /Applications or ~/Applications, never a dev build elsewhere.
// Linux: the .deb's binary, not Chromium's helpers (same binary, --type=).
// Windows: the image name only (tasklist shows no paths).
function oldProcessTest(platform, home) {
  if (platform === 'darwin') {
    const re = new RegExp(`^(?:/Applications|${escapeRe(path.posix.join(home || '/nonexistent', 'Applications'))})/Claude Buddy\\.app/Contents/MacOS/Claude Buddy$`);
    return (p) => re.test(p.command);
  }
  if (platform === 'linux') return (p) => OLD.linuxExecutable.test(p.command) && !p.command.includes(' --type=');
  if (platform === 'win32') return (p) => path.win32.basename(p.command).toLowerCase() === OLD.winExecutable.toLowerCase();
  return () => false;
}

/**
 * The old app's running main processes → { procs: [{ pid, command }], via }.
 * via 'list' normally; when the list can't be had, 'lock': the old folder's
 * SingletonLock naming a live pid counts as running (its pid is reported, and
 * never signalled, as nothing says what it is).
 */
function findOldProcesses({ platform, home, listProcesses, self = process.pid, oldUserData = null, isAlive = alive, fsImpl = fs, log = console.log }) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) return { procs: [], via: 'list' };
  const isOld = oldProcessTest(platform, home);
  try {
    return { procs: listProcesses().filter((p) => p.pid !== self && isOld(p)), via: 'list' };
  } catch (err) {
    log(`[rename] could not list processes: ${err.message}`);
    const pid = oldUserData ? lockPid(oldUserData, fsImpl) : null;
    if (pid && isAlive(pid)) {
      log(`[rename] the old app's SingletonLock names pid ${pid}, which is running: taking it as the old app`);
      return { procs: [{ pid, command: path.join(oldUserData, 'SingletonLock') }], via: 'lock' };
    }
    return { procs: [], via: 'lock' };
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Asks a running old copy to quit, so two widgets don't rewrite the same
 * hooks. SIGTERM, not an Apple Event: Electron quits cleanly on it, and it
 * needs no Automation permission prompt (Windows: main.js passes a kill that
 * runs taskkill without /F). Then waits (up to waitMs, blocking: this runs
 * before any window) for it to go, because on its way out it frees the
 * signal port and deletes the port file this app is about to write.
 * → { asked, running }: the pids asked, and the old app's pids still running
 * after the wait (one that couldn't be asked counts).
 * listProcesses: () → [{ pid, command }] (the full executable path on macOS,
 * the command line on Linux, the image name on Windows).
 */
function quitOldInstance({ platform, home, listProcesses, kill = process.kill, isAlive = alive, sleep = sleepSync, waitMs = 5000, self = process.pid, oldUserData = null, fsImpl = fs, log = console.log }) {
  const { procs, via } = findOldProcesses({ platform, home, listProcesses, self, oldUserData, isAlive, fsImpl, log });
  const pids = procs.map((p) => p.pid);
  const asked = [];
  if (via === 'list') {
    for (const pid of pids) {
      try { kill(pid, 'SIGTERM'); asked.push(pid); log(`[rename] asked the old app (pid ${pid}) to quit`); } catch (err) { log(`[rename] could not ask pid ${pid} to quit: ${err.message}`); }
    }
    for (let waited = 0; asked.some(isAlive) && waited < waitMs; waited += 100) sleep(100);
  }
  const still = pids.filter(isAlive);
  if (still.length) log(`[rename] the old app (pid ${still.join(', ')}) is still running`);
  return { asked, running: still };
}

// Whether a hook command (or one part of the MCP entry) runs the old
// installed app: its path; the hook wrapper while the wrapper still execs the
// old app; or, for a Linux AppImage, a hooks copy of another version in the
// data folder (the old $APPIMAGE's, which the running app prunes).
function oldTest(runtime, wrapperText) {
  const P = Runtime.pathFor(runtime);
  const wrapper = Runtime.wrapperPath(runtime);
  const wrapperOld = typeof wrapperText === 'string' && OLD.appPath.test(wrapperText);
  const stableRoot = P.join(runtime.dataDir, HookPaths.STABLE_PREFIX);
  const own = runtime.hooksDir + P.sep;
  return (c) => {
    const s = String(c || '');
    return OLD.appPath.test(s) || (wrapperOld && s.includes(wrapper)) || (s.includes(stableRoot) && !s.includes(own));
  };
}

// Every hook command in a JSON config's hooks block, with the event it is under.
function hookEntries(hooks) {
  const { commandsIn } = require('../adapters/uninstall-all.js');
  return Object.entries(hooks && typeof hooks === 'object' ? hooks : {}).flatMap(([where, v]) => commandsIn(v).map((command) => ({ where, command })));
}

function leftAloneReason(adapter, command, current) {
  if (adapter.isOurs(command)) {
    return current.has(command) ? 'already runs this app' : 'runs a Plexiform script name from somewhere other than the old app (a dev checkout, or a script of your own)';
  }
  return OLD.appPath.test(command) ? 'not Plexiform\'s own entry, but it names the old app: it stops working if the old app goes' : 'not Plexiform\'s';
}

/**
 * One agent config's text → what the rename makes of it, writing nothing:
 * { after (the new text, or null for no change), removed, added, leftAlone }
 * (each [{ where, command, reason? }]). Only Plexiform's own entries that run
 * the old app go; the current set is added once in their place. Everything
 * else stays, including a script of the person's own that shares a name with
 * Plexiform's and a dev checkout's entries. Throws on an unparsable file.
 * The real run and the dry run both use this, so the plan is what happens.
 */
function rewriteConfigText(adapter, text, { runtime, askFromWidget = false, home, isOld }) {
  if (adapter.id === 'codex') return rewriteCodexText(adapter, text, runtime, isOld);
  const data = Runtime.parseJsonConfig(text, adapter.configPath(home));
  const opts = { askFromWidget, home };
  const current = new Set(hookEntries(adapter.apply({}, runtime, opts).hooks).map((e) => e.command));
  const strip = (c) => adapter.isOurs(c) && (isOld(c) || current.has(c));
  const entries = hookEntries(data.hooks);
  const removed = entries.filter((e) => adapter.isOurs(e.command) && isOld(e.command));
  const leftAlone = entries.filter((e) => !strip(e.command)).map((e) => ({ ...e, reason: leftAloneReason(adapter, e.command, current) }));
  if (!removed.length) return { after: null, removed: [], added: [], leftAlone };
  const next = adapter.apply(data, runtime, { ...opts, strip });
  const had = new Set(entries.map((e) => `${e.where}\n${e.command}`));
  const added = hookEntries(next.hooks).filter((e) => current.has(e.command) && !had.has(`${e.where}\n${e.command}`));
  const after = JSON.stringify(next, null, 2);
  return { after: after === text ? null : after, removed, added, leftAlone, data, next };
}

// Codex runs exactly one notify command: replaced only when it is ours and runs the old app.
function rewriteCodexText(adapter, text, runtime, isOld) {
  const none = { after: null, removed: [], added: [], leftAlone: [] };
  const lines = String(text).split('\n');
  const at = adapter.topNotify(lines);
  if (at < 0) return none;
  const entry = { where: 'notify', command: lines[at].trim() };
  if (!adapter.isOurs(lines[at])) return { ...none, leftAlone: [{ ...entry, reason: 'not Plexiform\'s (Codex runs one notify command)' }] };
  const line = adapter.notifyLine(runtime);
  if (!isOld(lines[at])) return { ...none, leftAlone: [{ ...entry, reason: entry.command === line ? 'already runs this app' : 'Plexiform\'s notify, but not the old app\'s (a dev checkout?)' }] };
  lines[at] = line;
  return { after: lines.join('\n'), removed: [entry], added: [{ where: 'notify', command: line }], leftAlone: [] };
}

/**
 * What the hook re-point would do, writing nothing → { wrapper, configs, mcp, isOld }:
 *   wrapper: { file, before, after } when bin/buddy-hook would be rewritten
 *   configs: [{ id, label, file, before, after, removed, added, leftAlone, error? }] for each config present
 *   mcp: { file, before, after } | { file, leftAlone } | { file, error } | null
 */
function planHooks({ home, runtime, askFromWidget = false, mcpEntry, adapters = require('../adapters/index.js'), mcp = require('../mcp-install.js'), fsImpl = fs }) {
  const wrapperFile = Runtime.wrapperPath(runtime);
  let wrapperText = null;
  try { wrapperText = fsImpl.readFileSync(wrapperFile, 'utf8'); } catch { /* no wrapper */ }
  const isOld = oldTest(runtime, wrapperText);
  const ctx = { runtime, askFromWidget, home, isOld };
  const configs = [];
  for (const adapter of adapters.list()) {
    const file = adapter.configPath(home);
    const base = { id: adapter.id, label: adapter.label, file };
    let text;
    try { text = fsImpl.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') configs.push({ ...base, error: err.message }); continue; }
    try { configs.push({ ...base, before: text, ...rewriteConfigText(adapter, text, ctx) }); } catch (err) { configs.push({ ...base, before: text, error: err.message }); }
  }
  const wrapperOld = typeof wrapperText === 'string' && OLD.appPath.test(wrapperText);
  const needsWrapper = !runtime.node && (wrapperOld || configs.some((c) => c.removed?.length && (c.id === 'codex' ? Runtime.argvNeedsWrapper(runtime) : Runtime.shellNeedsWrapper(runtime))));
  const wrapper = needsWrapper && wrapperText !== Runtime.wrapperText(runtime) ? { file: wrapperFile, before: wrapperText, after: Runtime.wrapperText(runtime) } : null;
  let mcpPlan = null;
  if (mcpEntry) {
    const file = mcp.configPath(home);
    const st = mcp.status({ home, entry: mcpEntry });
    const parts = (e) => [e?.command, ...(Array.isArray(e?.args) ? e.args : [])];
    if (st.error) mcpPlan = { file, error: st.error };
    else if (!st.entry) mcpPlan = { file, leftAlone: `no "${mcp.NAME}" entry` };
    else if (!st.installed) mcpPlan = { file, leftAlone: `a "${mcp.NAME}" server that isn't Plexiform's` };
    else if (st.current) mcpPlan = { file, leftAlone: 'already runs this app' };
    else if (!parts(st.entry).some(isOld)) mcpPlan = { file, leftAlone: 'runs another copy, not the old app' };
    else mcpPlan = { file, before: st.entry, after: mcpEntry };
  }
  return { wrapper, configs, mcp: mcpPlan, isOld };
}

// `<file>.pre-plexiform`, made fresh right before the rename changes the
// file; one already there (an earlier try) is kept and a dated copy made.
function backupName(file, now = () => new Date(), fsImpl = fs) {
  const base = `${file}.pre-plexiform`;
  return fsImpl.existsSync(base) ? `${base}-${stampOf(now())}` : base;
}

function backupFresh(file, now = () => new Date(), fsImpl = fs) {
  const base = `${file}.pre-plexiform`;
  for (const b of [base, `${base}-${stampOf(now())}`]) {
    try {
      fsImpl.copyFileSync(file, b, fs.constants.COPYFILE_EXCL);
      try { fsImpl.chmodSync(b, fsImpl.statSync(file).mode & 0o777); } catch { /* best effort */ }
      return b;
    } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  throw new Error(`${base} and a dated copy of it already exist`);
}

// Rewrites one config from a fresh read, backed up first; if another program
// writes it in between, reads it again (three tries). → the backup's path.
function applyConfig(adapter, file, ctx, { fsImpl = fs, now = () => new Date() } = {}) {
  let backup = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const readAt = Runtime.mtimeOf(file, fsImpl);
    const r = rewriteConfigText(adapter, fsImpl.readFileSync(file, 'utf8'), ctx);
    if (r.after == null) return backup;
    if (!backup) backup = backupFresh(file, now, fsImpl);
    if (Runtime.writeTextAtomic(file, r.after, fsImpl, readAt)) {
      if (adapter.noteAddedDenyRules) adapter.noteAddedDenyRules({ home: ctx.home, runtime: ctx.runtime, file, before: r.data, after: r.next, fs: fsImpl });
      return backup;
    }
  }
  throw new Error(`${file} kept changing under us`);
}

/**
 * Points the old installed app's entries in every agent config at this app
 * (see rewriteConfigText), the hook wrapper too while it execs the old app,
 * and the MCP entry if it is Plexiform's and runs the old app. Each file is
 * copied to .pre-plexiform right before it changes. → [{ id, file, changed,
 * backup?, error? }]: any error means the step is not done (main.js keeps
 * it pending, so the old app isn't offered for the Bin).
 */
function rewriteHooks({ home, runtime, askFromWidget = false, mcpEntry, adapters = require('../adapters/index.js'), mcp = require('../mcp-install.js'), fsImpl = fs, log = console.log, now = () => new Date() }) {
  const plan = planHooks({ home, runtime, askFromWidget, mcpEntry, adapters, mcp, fsImpl });
  const results = [];
  if (plan.wrapper) {
    try { Runtime.ensureWrapper(runtime, fsImpl); results.push({ id: 'wrapper', file: plan.wrapper.file, changed: true }); } catch (err) { results.push({ id: 'wrapper', file: plan.wrapper.file, changed: false, error: err.message }); }
  }
  const ctx = { runtime, askFromWidget, home, isOld: plan.isOld };
  for (const c of plan.configs) {
    if (c.error) { results.push({ id: c.id, file: c.file, changed: false, error: c.error }); continue; }
    for (const e of c.leftAlone) if (!/^not Plexiform's$/.test(e.reason)) log(`[rename] ${c.id}: left alone ${e.command} (${e.reason})`);
    if (c.after == null) continue;
    try {
      const backup = applyConfig(adapters.list().find((a) => a.id === c.id), c.file, ctx, { fsImpl, now });
      results.push({ id: c.id, file: c.file, changed: true, ...(backup ? { backup } : {}) });
    } catch (err) { results.push({ id: c.id, file: c.file, changed: false, error: err.message }); }
  }
  if (plan.mcp?.error) results.push({ id: 'mcp', file: plan.mcp.file, changed: false, error: plan.mcp.error });
  else if (plan.mcp?.after) {
    try {
      const backup = backupFresh(plan.mcp.file, now, fsImpl);
      mcp.install({ home, entry: mcpEntry });
      results.push({ id: 'mcp', file: plan.mcp.file, changed: true, backup });
    } catch (err) { results.push({ id: 'mcp', file: plan.mcp.file, changed: false, error: err.message }); }
  }
  for (const r of results) log(`[rename] ${r.id}: ${r.error ? `not changed, trying again next launch (${r.error})` : `now points at this app${r.backup ? `; it was copied to ${r.backup}` : ''}`} ${r.file}`);
  return results;
}

/**
 * Open at Login follows the app across. On macOS there is no way to read or
 * remove another app's login item, so it is turned on for this one where the
 * old app set it up on its first run (the marker in ~/.claude-traffic-light).
 * On Windows the old Run entry, named after the old AppUserModelID, says
 * whether it was on, and goes. On Linux the autostart file has the same name
 * and only its Exec changes. → whether Open at Login is now on for this app
 * (main.js says so: the person may have turned it off in the old one).
 */
function moveLoginItem({ platform, app, loginItem, autoLaunchConfigured, execPath = process.execPath, log = console.log }) {
  if (platform === 'linux') {
    if (!loginItem.get()) return false;
    loginItem.set(true);
    return true;
  }
  if (platform !== 'win32') {
    if (autoLaunchConfigured) loginItem.set(true);
    return !!autoLaunchConfigured;
  }
  const oldExe = path.win32.join(path.win32.dirname(execPath), OLD.winExecutable);
  let wasOn = false;
  try { wasOn = (app.getLoginItemSettings({ path: oldExe }).launchItems || []).some((i) => i.name === OLD.appId && i.enabled !== false); } catch (err) { log(`[rename] could not read the old login item: ${err.message}`); }
  if (wasOn) loginItem.set(true);
  try { app.setLoginItemSettings({ openAtLogin: false, name: OLD.appId }); } catch (err) { log(`[rename] could not remove the old login item: ${err.message}`); }
  return wasOn;
}

/**
 * The approval counter's secret (src/nudge-secret.js) is sealed with
 * safeStorage under the old app's Keychain item, so it never opens here and
 * the counter would stay off for good. It is set aside as .pre-rename, and a
 * new one is made. → whether it was.
 */
function setAsideSealedSecret({ file, fsImpl = fs, log = console.log }) {
  let d = null;
  try { d = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return false; }
  if (!d || !d.sealed) return false;
  try { fsImpl.renameSync(file, `${file}.pre-rename`); } catch (err) { log(`[rename] could not set aside ${file}: ${err.message}`); return false; }
  log(`[rename] set aside ${file} (sealed under the old app's key) as ${path.basename(file)}.pre-rename`);
  return true;
}

// Whether the old app is still on disk, so its Open at Login may start it again.
function oldAppInstalled({ platform, home, exists = fs.existsSync }) {
  if (platform === 'darwin') return oldAppPaths(home).some((p) => exists(p));
  if (platform === 'linux') return exists('/opt/Claude Buddy');
  return false;
}

// Files that still run the old app, so binning it would break them: hook
// commands (and other `command`s) in the agent configs, Codex's config,
// mcpServers in ~/.claude.json (not its project paths, which may name
// anything), and the hook wrapper. readText lets the dry run look at what the
// files would hold. → [file]
function findOldReferences({ home, runtime = null, adapters = require('../adapters/index.js'), mcp = require('../mcp-install.js'), fsImpl = fs, readText = (f) => fsImpl.readFileSync(f, 'utf8') }) {
  const { commandsIn } = require('../adapters/uninstall-all.js');
  const names = (x) => OLD.appPath.test(String(x || ''));
  const out = [];
  for (const a of adapters.list()) {
    const f = a.configPath(home);
    try {
      const text = readText(f);
      if (a.id === 'codex' ? names(text) : commandsIn(Runtime.parseJsonConfig(text, f)).some(names)) out.push(f);
    } catch { /* missing or unparsable */ }
  }
  const mf = mcp.configPath(home);
  try {
    const servers = Runtime.parseJsonConfig(readText(mf), mf).mcpServers || {};
    if (Object.values(servers).some((e) => e && [e.command, ...(Array.isArray(e.args) ? e.args : [])].some(names))) out.push(mf);
  } catch { /* missing or unparsable */ }
  if (runtime) {
    const w = Runtime.wrapperPath(runtime);
    try { if (names(readText(w))) out.push(w); } catch { /* no wrapper */ }
  }
  return [...new Set(out)];
}

const oldAppPaths = (home) => ['/Applications', path.join(home, 'Applications')].map((d) => path.join(d, OLD.macBundleName));

/**
 * macOS: offers to put the old app in the Bin; never removes it unasked.
 * showDialog(options) → { response } (dialog.showMessageBox); trashItem(path)
 * → Promise (shell.trashItem). → [{ path, removed, error? }]
 */
async function offerRemoveOldApp({ platform, home, name, stillUsedBy = [], exists = fs.existsSync, showDialog, trashItem, log = console.log }) {
  if (platform !== 'darwin') return [];
  const out = [];
  const breaks = stillUsedBy.length ? `\n\nThese still name the old app and would stop working if it goes: ${stillUsedBy.join(', ')}.` : '';
  if (stillUsedBy.length) log(`[rename] still naming the old app: ${stillUsedBy.join(', ')}`);
  for (const p of oldAppPaths(home).filter((x) => exists(x))) {
    const { response } = await showDialog({
      type: 'question',
      buttons: ['Remove', 'Keep'],
      defaultId: 1,
      cancelId: 1,
      message: `Remove the old ${OLD.productName} app?`,
      detail: `${OLD.productName} is now ${name}, and your settings have come across. Remove moves ${p} to the Bin. If you keep it, quit it and turn off its Open at Login, or the two will both try to run.${breaks}`,
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
 * Runs the steps still pending, each until it succeeds. A step function
 * returns false, or throws, to stay pending (e.g. hooks while running from a
 * translocated copy). remove-old-app waits while hooks is pending: binning the
 * old app would break the hooks still pointing into it.
 * steps: { hooks: fn, login: fn, 'remove-old-app': async fn }
 */
async function runFollowUp({ userData, steps, fsImpl = fs, log = console.log }) {
  for (const step of pending(userData, fsImpl)) {
    const fn = steps[step];
    if (!fn) continue;
    if (step === 'remove-old-app' && pending(userData, fsImpl).includes('hooks')) { log('[rename] not offering to remove the old app while the hooks still point at it'); continue; }
    let keep = false;
    // Synchronous steps finish before this returns its promise, so main's own
    // hook check right after sees what they wrote.
    try {
      const r = fn();
      keep = (r && typeof r.then === 'function' ? await r : r) === false;
    } catch (err) { keep = true; log(`[rename] ${step} failed, trying again next launch: ${err.message}`); }
    if (!keep) markDone(userData, step, fsImpl);
  }
}

module.exports = { OLD, STATE_FILE, STEPS, SKIP, FRESH, MAX_TRIES, assessTarget, copyDecision, copyUserData, readState, pending, markDone, parsePs, parseTasklist, findOldProcesses, quitOldInstance, rewriteConfigText, planHooks, backupName, rewriteHooks, moveLoginItem, setAsideSealedSecret, oldAppInstalled, findOldReferences, oldAppPaths, offerRemoveOldApp, runFollowUp };
