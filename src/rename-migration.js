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
  const after = swappedText(text, next, removed, added) ?? Runtime.jsonTextLike(text, next);
  return { after: after === text ? null : after, removed, added, leftAlone, data, next };
}

// A re-point that only swaps commands is made on the text itself, so every
// other byte of the file stays as the person (or their agent) wrote it; null
// when the result wouldn't be exactly `next` (entries dropped or appended, a
// deny rule added, an escape spelt differently), for jsonTextLike instead.
function swappedText(text, next, removed, added) {
  const pool = added.slice();
  let out = String(text);
  for (const r of removed) {
    const i = pool.findIndex((a) => a.where === r.where);
    const from = JSON.stringify(r.command);
    if (i < 0 || !out.includes(from)) return null;
    const to = JSON.stringify(pool.splice(i, 1)[0].command);
    out = out.replace(from, () => to);
  }
  try { return JSON.stringify(Runtime.parseJsonConfig(out, '')) === JSON.stringify(next) ? out : null; } catch { return null; }
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
  lines[at] = line + (lines[at].endsWith('\r') ? '\r' : '');
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

// ── the dry run (--rename-dry-run) ──────────────────────────────────────────
// Everything below only reads. It uses the same decisions as the real run
// (assessTarget, copyDecision, planHooks/rewriteConfigText, findOldProcesses,
// backupName, findOldReferences), so the plan can't drift from what happens.

// A run from one of these paths is ephemeral: the hooks would point at a
// temporary copy (AppTranslocation) or a disk image that goes when ejected.
const EPHEMERAL_PATH = /\/AppTranslocation\/|^\/Volumes\//;

// The running processes, as main.js lists them to find the old app:
// macOS's comm is the full executable path; Linux's is cut to 15 characters,
// so its args; Windows has tasklist.
function listProcesses(platform = process.platform) {
  const { execFileSync } = require('child_process');
  if (platform === 'win32') return parseTasklist(execFileSync('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${OLD.winExecutable}`], { encoding: 'utf8', windowsHide: true }));
  if (platform === 'darwin') return parsePs(execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }));
  return parsePs(execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }));
}

// The copy as cpSync would make it, walked with the same filter → { copy: [{ name, bytes }], skip: [{ name, bytes, why }] }.
function planCopy(from, fsImpl = fs) {
  const copy = new Map();
  const skip = [];
  const sizeOf = (p) => {
    let st;
    try { st = fsImpl.lstatSync(p); } catch { return 0; }
    if (!st.isDirectory()) return st.isFile() ? st.size : 0;
    let n = 0;
    try { for (const e of fsImpl.readdirSync(p)) n += sizeOf(path.join(p, e)); } catch { /* unreadable */ }
    return n;
  };
  const walk = (dir) => {
    let names = [];
    try { names = fsImpl.readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      const d = copyDecision(from, p, fsImpl);
      if (!d.take) { skip.push({ name: SKIP.has(d.top) ? d.top : d.rel, bytes: sizeOf(p), why: d.why }); continue; }
      let st;
      try { st = fsImpl.lstatSync(p); } catch { continue; }
      if (!copy.has(d.top)) copy.set(d.top, 0);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) copy.set(d.top, copy.get(d.top) + st.size);
    }
  };
  walk(from);
  return { copy: [...copy].map(([name, bytes]) => ({ name, bytes })), skip };
}

/**
 * What the first launch after the rename would do here, writing nothing.
 * Takes what main.js would pass (the runtime, the MCP entry); exists and
 * listProcesses default to the real machine.
 */
function planRename({ home, appData, newName, platform, runtime, mcpEntry, askFromWidget = false, rootDir, packaged = true, execPath = process.execPath, listProcesses: list = () => listProcesses(platform), exists = fs.existsSync /* the old .app in /Applications */, fsImpl = fs, isAlive = alive, now = () => new Date(), adapters = require('../adapters/index.js'), mcp = require('../mcp-install.js') }) {
  const from = path.join(appData, OLD.userDataName);
  const to = path.join(appData, newName);
  let fromIsDir = false;
  try { fromIsDir = fsImpl.lstatSync(from).isDirectory(); } catch { /* none */ }
  const target = assessTarget(to, { fsImpl, isAlive });
  const not = whyNot(target, newName);
  const wouldCopy = !not && fromIsDir;
  const userData = {
    from, to, fromIsDir, target, wouldCopy,
    why: not || (fromIsDir ? null : 'no old folder'),
    aside: wouldCopy && target.kind !== 'absent' ? `${to}.pre-migration-${stampOf(now())}` : null,
    ...(fromIsDir ? planCopy(from, fsImpl) : { copy: [], skip: [] }),
  };
  const steps = wouldCopy ? STEPS.slice() : target.kind === 'migrated' && Array.isArray(target.state.pending) ? target.state.pending.filter((p) => STEPS.includes(p)) : [];
  const oldUserData = from;
  const procs = findOldProcesses({ platform, home, listProcesses: list, oldUserData, isAlive, fsImpl, log: () => {} });
  const hooks = planHooks({ home, runtime, askFromWidget, mcpEntry, adapters, mcp, fsImpl });
  const backups = [...hooks.configs.filter((c) => c.after != null).map((c) => c.file), ...(hooks.mcp?.after ? [hooks.mcp.file] : [])].map((f) => backupName(f, now, fsImpl));
  // What the files would hold once the hooks step has run.
  const after = new Map(hooks.configs.filter((c) => c.after != null).map((c) => [c.file, c.after]));
  if (hooks.wrapper) after.set(hooks.wrapper.file, hooks.wrapper.after);
  if (hooks.mcp?.after) {
    const data = Runtime.parseJsonConfig(fsImpl.readFileSync(hooks.mcp.file, 'utf8'), hooks.mcp.file);
    after.set(hooks.mcp.file, JSON.stringify({ ...data, mcpServers: { ...data.mcpServers, [mcp.NAME]: hooks.mcp.after } }));
  }
  const runsHooks = steps.includes('hooks');
  const readText = (f) => (runsHooks && after.has(f) ? after.get(f) : fsImpl.readFileSync(f, 'utf8'));
  const stillNaming = findOldReferences({ home, runtime, adapters, mcp, fsImpl, readText });
  // main.js's own start-up install for Claude Code runs when its hooks aren't current afterwards, and strips every entry of ours.
  const claude = adapters.list().find((a) => a.id === 'claude');
  let startup = null;
  try {
    const file = claude.configPath(home);
    const text = (() => { try { return readText(file); } catch (err) { if (err.code === 'ENOENT') return ''; throw err; } })();
    const settings = Runtime.parseJsonConfig(text, file);
    const current = claude.check(settings, runtime, { askFromWidget, home });
    const current2 = new Set(hookEntries(claude.apply({}, runtime, { askFromWidget, home }).hooks).map((e) => e.command));
    startup = { file, runs: !current, removes: current ? [] : hookEntries(settings.hooks).filter((e) => claude.isOurs(e.command) && !current2.has(e.command)) };
  } catch (err) { startup = { error: err.message }; }
  const secretFile = path.join(rootDir, 'approval-secret.json');
  let sealed = false;
  try { sealed = !!JSON.parse(fsImpl.readFileSync(secretFile, 'utf8')).sealed; } catch { /* none */ }
  const oldApps = platform === 'darwin' ? oldAppPaths(home).filter((p) => exists(p)) : [];
  return {
    home, platform, packaged, execPath, ephemeral: EPHEMERAL_PATH.test(execPath), runtime, steps, userData,
    oldProcess: procs, hooks, backups, stillNaming, startup,
    login: { platform, autoLaunchConfigured: fsImpl.existsSync(path.join(rootDir, '.auto-launch-configured')) },
    secret: { file: secretFile, sealed, setAside: sealed && wouldCopy },
    oldApps,
  };
}

// Line diff → unified-diff text (3 lines of context).
function unifiedDiff(a, b, { from = 'before', to = 'after', context = 3 } = {}) {
  const A = String(a ?? '').split('\n');
  const B = String(b ?? '').split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre += 1;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf += 1;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const n = a2.length;
  const m = b2.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = A.slice(0, pre).map((l) => [' ', l]);
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && a2[i] === b2[j]) { ops.push([' ', a2[i]]); i += 1; j += 1; } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { ops.push(['-', a2[i]]); i += 1; } else { ops.push(['+', b2[j]]); j += 1; }
  }
  for (const l of A.slice(A.length - suf)) ops.push([' ', l]);
  const changed = ops.map((o, k) => (o[0] === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (!changed.length) return '';
  const aBefore = [];
  const bBefore = [];
  let ac = 0;
  let bc = 0;
  for (const [t] of ops) { aBefore.push(ac); bBefore.push(bc); if (t !== '+') ac += 1; if (t !== '-') bc += 1; }
  const out = [`--- ${from}`, `+++ ${to}`];
  for (let g = 0; g < changed.length;) {
    let last = g;
    while (last + 1 < changed.length && changed[last + 1] - changed[last] <= 2 * context) last += 1;
    const start = Math.max(0, changed[g] - context);
    const end = Math.min(ops.length - 1, changed[last] + context);
    const slice = ops.slice(start, end + 1);
    const aCount = slice.filter(([t]) => t !== '+').length;
    const bCount = slice.filter(([t]) => t !== '-').length;
    out.push(`@@ -${aBefore[start] + (aCount ? 1 : 0)},${aCount} +${bBefore[start] + (bCount ? 1 : 0)},${bCount} @@`);
    for (const [t, l] of slice) out.push(`${t}${l}`);
    g = last + 1;
  }
  return out.join('\n');
}

const sizeText = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

// The plan, as text for a person to read.
function formatPlan(plan) {
  const tilde = (p) => (plan.home && String(p).startsWith(`${plan.home}/`) ? `~${String(p).slice(plan.home.length)}` : String(p));
  const L = [];
  const indent = (text, pad) => String(text).split('\n').map((l) => `${pad}${l}`).join('\n');
  const u = plan.userData;
  L.push(`${OLD.productName} → Plexiform: what the first launch would do (dry run: nothing was written)`);
  L.push('');
  if (!plan.packaged) L.push('WARNING: this is not the installed app. The installed app plans with its own paths; run the dry run from it.', '');
  if (plan.ephemeral) L.push(`NOTE: running from ${plan.execPath}, a temporary copy or a disk image: the hooks step stays pending and Remove is never offered from here.`, '');

  L.push('1. App data');
  L.push(`   old folder: ${tilde(u.from)}${u.fromIsDir ? `  (${sizeText([...u.copy, ...u.skip].reduce((n, e) => n + e.bytes, 0))})` : '  (not there)'}`);
  const t = u.target;
  const state = t.kind === 'absent' ? 'absent' : t.kind === 'fresh' ? `fresh (holds only: ${t.names.join(', ') || 'nothing'})` : t.kind === 'retry' ? `a launch that couldn't copy ran on it (try ${t.state.attempts || 1} of ${MAX_TRIES}: ${t.state.reason})` : t.kind === 'migrated' ? (t.state.status === 'kept' ? 'kept as it is after the last try' : `already migrated (${t.state.copiedAt || ''})`) : t.kind === 'live' ? `in use: Plexiform is running on it (pid ${t.pid})` : t.kind === 'used' ? `in use (${t.used.slice(0, 8).join(', ')}${t.used.length > 8 ? ', …' : ''})` : `unreadable (${t.error})`;
  L.push(`   new folder: ${tilde(u.to)}  state: ${state}`);
  if (u.wouldCopy) {
    L.push(`   → copies the old folder (the old folder is never changed)${u.aside ? `; what is at the new folder now is renamed to ${tilde(u.aside)} and kept (removed only if empty)` : ''}`);
  } else L.push(`   → no copy: ${u.why}`);
  if (u.fromIsDir) {
    L.push(`   copied (${u.copy.length}, ${sizeText(u.copy.reduce((n, e) => n + e.bytes, 0))}):`);
    for (const e of u.copy) L.push(`     ${e.name.padEnd(36)} ${sizeText(e.bytes)}`);
    L.push(`   left out (${u.skip.length}, ${sizeText(u.skip.reduce((n, e) => n + e.bytes, 0))}):`);
    for (const e of u.skip) L.push(`     ${e.name.padEnd(36)} ${sizeText(e.bytes).padEnd(10)} ${e.why}`);
  }
  L.push(`   steps that would run after it: ${plan.steps.length ? plan.steps.join(', ') : 'none (they run only on a migrated folder)'}`);
  L.push('');

  L.push('2. The old app, if running');
  const procs = plan.oldProcess.procs;
  if (!procs.length) L.push(`   none found${plan.oldProcess.via === 'lock' ? ' (the process list failed; no live SingletonLock in the old folder)' : ''}`);
  else if (plan.oldProcess.via === 'lock') L.push(`   the process list failed; the old folder's SingletonLock names live pid ${procs[0].pid}: taken as running, never signalled, so no copy this launch`);
  else {
    for (const p of procs) L.push(`   would get ${plan.platform === 'win32' ? 'a close request (taskkill, no /F)' : 'SIGTERM'}: pid ${p.pid} ${p.command}`);
    L.push('   then waits up to 5 s; if it is still running, nothing is copied this launch and the next launch tries again');
  }
  L.push('');

  L.push(`3. Agent configs (the hooks step${plan.steps.includes('hooks') ? '' : ': would NOT run this launch; shown for when it does'})`);
  if (!plan.hooks.configs.length) L.push('   none present');
  for (const c of plan.hooks.configs) {
    L.push(`   ${tilde(c.file)} (${c.label})`);
    if (c.error) { L.push(`     can't be read: ${c.error}; left alone, and the hooks step stays pending (Remove is not offered)`); continue; }
    if (c.removed.length) {
      L.push(`     re-pointed: ${c.removed.length} of Plexiform's entries run the old app${c.after == null ? ' (the file text stays the same: the wrapper change below re-points them)' : ''}`);
      for (const e of c.removed) L.push(`       - ${e.where}: ${e.command}`);
      for (const e of c.added) L.push(`       + ${e.where}: ${e.command}`);
    } else L.push('     no change');
    if (c.leftAlone.length) {
      L.push('     left alone:');
      for (const e of c.leftAlone) L.push(`       ${e.where}: ${e.command}\n         (${e.reason})`);
    }
    if (c.after != null) {
      L.push(`     backup first: ${tilde(plan.backups.find((x) => x.startsWith(`${c.file}.pre-plexiform`)))}`);
      if (/\n$/.test(c.before) && !/\n$/.test(c.after)) L.push('     (the rewritten file has no final newline)');
      L.push('     diff:');
      L.push(indent(unifiedDiff(c.before, c.after, { from: tilde(c.file), to: `${tilde(c.file)} (after)` }), '       '));
    }
  }
  L.push('');

  L.push(`4. Hook wrapper (${tilde(Runtime.wrapperPath(plan.runtime))})`);
  if (!plan.hooks.wrapper) L.push('   no change');
  else {
    L.push(plan.hooks.wrapper.before == null ? '   would be created:' : '   would be rewritten:');
    L.push(indent(unifiedDiff(plan.hooks.wrapper.before ?? '', plan.hooks.wrapper.after, { from: 'bin/buddy-hook', to: 'bin/buddy-hook (after)' }), '     '));
  }
  L.push('');

  const m = plan.hooks.mcp;
  L.push('5. MCP entry (mcpServers in ~/.claude.json; nothing else in that file changes)');
  if (!m) L.push('   not checked');
  else if (m.error) L.push(`   can't be read: ${m.error}; left alone, and the hooks step stays pending`);
  else if (m.leftAlone) L.push(`   left alone: ${m.leftAlone}`);
  else L.push(indent(unifiedDiff(JSON.stringify(m.before, null, 2), JSON.stringify(m.after, null, 2), { from: 'mcpServers["claude-buddy"]', to: 'mcpServers["claude-buddy"] (after)' }), '   '));
  L.push('');

  L.push('6. Backups that would be made (copies, never overwritten)');
  if (!plan.backups.length) L.push('   none (no config changes)');
  for (const b of plan.backups) L.push(`   ${tilde(b)}`);
  L.push('');

  L.push('7. Open at Login');
  const lg = plan.login;
  if (!plan.steps.includes('login')) L.push('   no change (the login step would not run)');
  else if (lg.platform === 'darwin') L.push(lg.autoLaunchConfigured ? `   turned ON for Plexiform (the old app had set up its own), and a notice says so. The old app's own login item can't be read or removed: turn it off by hand if you keep the old app.` : '   no change (the old app never set it up)');
  else if (lg.platform === 'win32') L.push(`   on for Plexiform if the old Run entry ${OLD.appId} is on; that old entry is removed`);
  else L.push('   the autostart file keeps its name; its Exec is rewritten if Open at Login is on');
  L.push('');

  L.push('8. Approval-counter secret');
  if (plan.secret.setAside) L.push(`   ${tilde(plan.secret.file)} is sealed under the old app's Keychain item: renamed to ${path.basename(plan.secret.file)}.pre-rename, and a new one is made (the counter starts again)`);
  else if (plan.secret.sealed) L.push(`   ${tilde(plan.secret.file)} is sealed, but no copy happens this launch, so it is left as it is`);
  else L.push('   nothing to set aside');
  L.push('');

  L.push('9. Files that would still name the old app (binning it would break them)');
  if (!plan.stillNaming.length) L.push('   none');
  for (const f of plan.stillNaming) L.push(`   ${tilde(f)}`);
  L.push('');

  L.push("10. Plexiform's start-up hook install for Claude Code (runs on every launch when its hooks aren't current)");
  const st = plan.startup;
  if (plan.ephemeral) L.push('   would not run from a temporary copy or a disk image');
  else if (st.error) L.push(`   can't tell: ${st.error}`);
  else if (!st.runs) L.push('   would not run: the hooks are current afterwards');
  else if (!st.removes.length) L.push(`   WOULD run on ${tilde(st.file)}: it adds Plexiform's hooks and removes nothing else`);
  else {
    L.push(`   WOULD run on ${tilde(st.file)}, and it removes every entry that runs a script called set-status.js or delegate.js:`);
    for (const e of st.removes) L.push(`     - ${e.where}: ${e.command}`);
  }
  L.push('');

  L.push('11. Offer to move the old app to the Bin (macOS; asks first, defaults to Keep)');
  if (plan.platform !== 'darwin') L.push('   never offered on this platform');
  else if (!plan.oldApps.length) L.push('   not offered: the old app is not in /Applications or ~/Applications');
  else if (plan.ephemeral) L.push('   not offered from a temporary copy or a disk image');
  else if (!plan.steps.includes('remove-old-app')) L.push('   not offered this launch (the step would not run)');
  else if (plan.hooks.configs.some((c) => c.error) || plan.hooks.mcp?.error) L.push('   not offered: a config can\'t be rewritten, so the hooks step stays pending');
  else for (const p of plan.oldApps) L.push(`   would ask about ${p}${plan.stillNaming.length ? ', naming the files in 9' : ''}`);
  return `${L.join('\n')}\n`;
}

module.exports = { OLD, STATE_FILE, STEPS, SKIP, FRESH, MAX_TRIES, EPHEMERAL_PATH, listProcesses, planCopy, planRename, unifiedDiff, formatPlan, assessTarget, copyDecision, copyUserData, readState, pending, markDone, parsePs, parseTasklist, findOldProcesses, quitOldInstance, rewriteConfigText, planHooks, backupName, rewriteHooks, moveLoginItem, setAsideSealedSecret, oldAppInstalled, findOldReferences, oldAppPaths, offerRemoveOldApp, runFollowUp };
