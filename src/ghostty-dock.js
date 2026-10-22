'use strict';
// Ghostty Dock (https://github.com/andrewbakercloudscale/ghossty-dock) is a
// third-party app with no license, so nothing of it is copied here. Plexiform
// only calls the user's own installed CLI the way its public README shows:
// `ghostty-dock focus <session>` and `ghostty-dock open <dir> --command <cmd>`.
//
// The ops are a frozen allow-list. There is no generic call: nothing here can
// type into a terminal, press keys in it or read its screen. Only main-process
// handlers reached from a person's click use this module (see
// test/ghostty-dock-boundary.test.js for who may not require it).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const OPS = Object.freeze(['focus', 'list', 'notify', 'open']);
const BUNDLE_ID = 'consulting.cloudscale.ghosttydock';
const APP = 'Ghostty Dock';
const CACHE_MS = 60000;
const EXEC_TIMEOUT_MS = 10000;

// Dock's own matcher falls back to names, folders and prefixes, so only an
// exact full session id is ever passed.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validSessionId = (v) => typeof v === 'string' && UUID.test(v);

// Preferences: 'auto' (use it when it is installed and trusted) or 'off'.
const normalizeMode = (v) => (v === 'off' ? 'off' : 'auto');
const modeOf = (config) => normalizeMode(config && config.integrations && config.integrations.ghosttyDock);

// Fixed locations under the home folder, never PATH, and never the
// GHOSTTY_DOCK_STATE override: the app's environment is not the user's shell,
// and a planted variable must not redirect requests.
function locations(home) {
  return {
    cli: path.join(home, '.local', 'bin', 'ghostty-dock'),
    apiDir: path.join(home, '.local', 'state', 'ghostty-dock', 'api'),
    apps: [path.join(home, 'Applications', `${APP}.app`), `/Applications/${APP}.app`],
  };
}

// A regular file (or one symlink, resolved once), ours, executable, and not
// group- or world-writable. This guards against other users only: a process
// running as this user could replace it, and could equally replace our hooks.
function cliProblem(file, f, uid) {
  let st;
  try {
    st = f.lstatSync(file);
    if (st.isSymbolicLink()) st = f.statSync(f.realpathSync(file));
  } catch { return 'CLI not installed'; }
  if (!st.isFile()) return 'CLI is not a file';
  if (st.uid !== uid) return 'CLI is owned by another user';
  if (st.mode & 0o022) return 'CLI can be changed by other users';
  if (!(st.mode & 0o100)) return 'CLI is not executable';
  return null;
}

// Same rule as a tmux socket's folder (src/focus/index.js tmuxServerOk), but
// stricter: a real directory, ours, private to us.
function apiDirProblem(dir, f, uid) {
  let st;
  try { st = f.lstatSync(dir); } catch { return 'API folder missing (open Ghostty Dock once)'; }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'API folder is not a plain folder';
  if (st.uid !== uid) return 'API folder is owned by another user';
  if (st.mode & 0o077) return 'API folder is not private';
  return null;
}

// { installed, trusted, cli, apiDir, reason }. `cli` is set only when trusted;
// `installed` (the app bundle exists) is enough for the AppleScript fallback.
function detect({ home = os.homedir(), fs: f = fs, uid = typeof process.getuid === 'function' ? process.getuid() : -1, platform = process.platform } = {}) {
  if (platform !== 'darwin') return { installed: false, trusted: false, cli: null, apiDir: null, reason: 'macOS only' };
  const where = locations(home);
  const installed = where.apps.some((a) => { try { return f.statSync(a).isDirectory(); } catch { return false; } });
  const problem = cliProblem(where.cli, f, uid) || apiDirProblem(where.apiDir, f, uid);
  return { installed, trusted: !problem, cli: problem ? null : where.cli, apiDir: where.apiDir, reason: problem || (installed ? 'ready' : 'CLI found, app not in Applications') };
}

let memo = null;
function current({ now = Date.now(), ...opts } = {}) {
  if (!memo || now - memo.at >= CACHE_MS) memo = { at: now, value: detect(opts) };
  return memo.value;
}
function invalidate() { memo = null; }

function execCli(file, args, { timeout = EXEC_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    try {
      const child = execFile(file, args, { timeout, killSignal: 'SIGKILL' }, (err, stdout, stderr) => { // privacy-flow: ghostty-dock-local
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
      child.on('error', (e) => resolve({ ok: false, stdout: '', stderr: e.message }));
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: e.message });
    }
  });
}

// `dock` is a fresh detect() result, taken just before the call. argv only.
async function run(op, args, { dock, exec = execCli } = {}) {
  if (!OPS.includes(op)) throw new Error(`Ghostty Dock op not allowed: ${String(op).slice(0, 20)}`);
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.length > 1000 || /[\0-\x1f\x7f]/.test(a))) throw new Error('Ghostty Dock: bad argument');
  if (!dock || !dock.trusted || !dock.cli) return { ok: false, reason: (dock && dock.reason) || 'Ghostty Dock not available' };
  const r = await exec(dock.cli, [op, ...args]); // privacy-flow: ghostty-dock-local
  if (!r || !r.ok) {
    invalidate();
    return { ok: false, reason: ((r && r.stderr) || 'ghostty-dock failed').trim().slice(0, 120) };
  }
  return { ok: true };
}

// The Preferences → Health and `plexiform doctor` row. Read-only.
function healthRow(dock, mode) {
  const link = 'Third-party app with no license (github.com/andrewbakercloudscale/ghossty-dock); Plexiform only asks it to focus a tab or open one.';
  if (mode === 'off') return { status: 'info', detail: `Turned off in Preferences. ${link}` };
  if (!dock || (!dock.installed && !dock.trusted)) return { status: 'info', detail: `Not installed. ${link}` };
  if (!dock.trusted) return { status: 'warn', detail: `Installed, but not used: ${dock.reason}. ${link}`, next: 'Open Ghostty Dock once; its API folder must be a private folder you own.' };
  return { status: 'ok', detail: `Installed. Clicking a Ghostty Dock session goes to its exact tab. Its hook and Plexiform's both run on each Claude tool call. ${link}` };
}

module.exports = { OPS, BUNDLE_ID, APP, CACHE_MS, validSessionId, normalizeMode, modeOf, locations, detect, current, invalidate, run, healthRow };
