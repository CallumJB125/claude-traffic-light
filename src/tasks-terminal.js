'use strict';
// The supervisor, never the page, supplies this descriptor. A private, one-use
// command file avoids AppleScript command interpolation and repeat launches.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { takeoverCommand, resolveBin } = require('./tasks-guard');
const GhosttyDock = require('./ghostty-dock');
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const openTerminal = file => new Promise((resolve, reject) => {
  execFile('/usr/bin/open', ['-a', 'Terminal', file], { timeout: 10000 }, error => error ? reject(error) : resolve()); // privacy-flow: tasks-terminal
});
// Ghostty Dock's `open <dir> --command <cmd>` runs <cmd> in a shell, so it gets
// only the quoted path of the same one-use 0700 file, never the command itself.
const ghosttyDockLauncher = ({ detect = GhosttyDock.detect, run = GhosttyDock.run } = {}) => async (file, cwd) => {
  const r = await run('open', [cwd, '--command', quote(file)], { dock: detect() });
  if (!r.ok) throw new Error(r.reason || 'Ghostty Dock did not open the tab');
};
// The launcher for each app terminalApp() can name (plan-agent-terminal PR 0s).
// Terminal is launchTaskTerminal's own default, the same function; T3 adds
// 'plexiform'. Ghostty Dock is built per launch, as main built it before.
const launchers = Object.freeze({ Terminal: () => openTerminal, 'Ghostty Dock': () => ghosttyDockLauncher() });
function launcherFor(app) {
  if (!Object.hasOwn(launchers, app)) throw Object.assign(new Error(`No launcher for ${String(app).slice(0, 40)}.`), { code: 'CAPABILITY_MISSING' });
  return launchers[app]();
}

// "Has this person used take-over before" for T3's upgrade migration
// (§R3.10 m3): the last time, stamped each time the launch was requested, which is exactly when
// tasks:open-terminal returns OK. Machine state, not a setting, so it lives
// beside config.json and Backups (an allow-list) never copies or restores it.
// A failed write never changes the launch result.
const STATE_FILE = 'terminal-state.json';
function stampTakeover(result, dataDir, now = Date.now) {
  if (result?.status !== 'requested') return result;
  try {
    const file = path.join(dataDir, STATE_FILE), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ takeoverUsedAt: now() }) + '\n', { mode: 0o600 });
    try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  } catch { /* the stamp is a hint for a later migration, never a reason to fail */ }
  return result;
}
function takeoverUsedAt(dataDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dataDir, STATE_FILE), 'utf8')).takeoverUsedAt;
    return Number.isSafeInteger(v) && v >= 0 ? v : null;
  } catch { return null; }
}

async function launchTaskTerminal(descriptor, { current = () => true, platform = process.platform, launch = openTerminal, resolve = resolveBin, tempDir = os.tmpdir() } = {}) {
  if (platform !== 'darwin') throw Object.assign(new Error('Automatic terminal launch is available on macOS.'), { code: 'CAPABILITY_MISSING' });
  const argv = descriptor?.argv;
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || typeof descriptor.cwd !== 'string' || !path.isAbsolute(descriptor.cwd) || descriptor.cwd.includes('\0')) throw Object.assign(new Error('Invalid terminal descriptor.'), { code: 'VALIDATION' });
  const binary = resolve(argv[0]);
  if (!path.isAbsolute(binary) || !fs.statSync(descriptor.cwd).isDirectory()) throw Object.assign(new Error('The task terminal is unavailable.'), { code: 'CAPABILITY_MISSING' });
  fs.accessSync(binary, fs.constants.X_OK);
  const dir = fs.mkdtempSync(path.join(tempDir, 'plexiform-terminal-'));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'continue.command'), claim = path.join(dir, 'started');
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* private temporary residue can be removed later */ } };
  const command = takeoverCommand({ ...descriptor, argv: [binary, ...argv.slice(1)] }, { resolve: value => value });
  const body = ['#!/bin/zsh',
    // mkdir is atomic even if Terminal opens the same file twice.
    `/bin/mkdir ${quote(claim)} 2>/dev/null || exit 0`,
    `/bin/rm -f ${quote(file)}`,
    `trap ${quote(`/bin/rm -rf ${quote(dir)}`)} EXIT`,
    command, 'result=$?',
    'print "Plexiform terminal session ended. Return to Tasks to hand it back."',
    'exit $result', ''].join('\n');
  fs.writeFileSync(file, body, { mode: 0o700, flag: 'wx' });
  if (current() !== true) { cleanup(); throw Object.assign(new Error('The task view changed.'), { code: 'CONFLICT' }); }
  try {
    await launch(file, descriptor.cwd); // This confirms only the OS launch request, never a model reply.
    return { status: 'requested', cancelPending: cleanup };
  } catch {
    cleanup(); // Retire the file even after a timeout; never repeat an uncertain launch.
    return { status: 'unconfirmed', cancelPending: cleanup };
  }
}

module.exports = { launchTaskTerminal, ghosttyDockLauncher, launcherFor, stampTakeover, takeoverUsedAt, STATE_FILE };
