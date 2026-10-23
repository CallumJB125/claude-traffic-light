'use strict';
// Ghostty Dock (https://github.com/andrewbakercloudscale/ghossty-dock) is a
// third-party app with no license, so nothing of it is copied here. Plexiform
// only calls the user's own installed CLI the way its public README shows:
// `ghostty-dock focus <session>`, `ghostty-dock list` and `ghostty-dock open <dir> --command <cmd>`.
//
// The ops are a frozen allow-list, and run() fixes each op's argument shape:
// focus takes one session id, open takes a folder plus the quoted path of a
// Plexiform one-use continue.command file, list takes nothing, notify one
// short title. list's output is parsed down to session ids and status words
// (parseList) and nothing else is kept. Nothing here can type into a terminal, press keys in it, read
// its screen or run an arbitrary command. Only main-process handlers reached
// from a person's click use this module (test/ghostty-dock-boundary.test.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { okPath } = require('./focus/ids.js');

const OPS = Object.freeze(['focus', 'list', 'notify', 'open']);
const BUNDLE_ID = 'consulting.cloudscale.ghosttydock';
const APP = 'Ghostty Dock';
const CACHE_MS = 60000;
const EXEC_TIMEOUT_MS = 10000;
// Ghostty Dock's opener drives the app with AppleScript, so the first open can
// sit behind macOS's Automation prompt while the user reads it.
const OPEN_TIMEOUT_MS = 30000;
const TITLE_MAX = 120;
// list answers inside a click, so it gets the jump's own cap (src/focus/index.js EXEC_TIMEOUT_MS), not 10 s.
const LIST_TIMEOUT_MS = 2500;
const LIST_CACHE_MS = 2000;
const LIST_MAX_BYTES = 256 * 1024;
const LIST_MAX_LINES = 500;
// The status words Dock's list prints first on each row; 'waiting' is its "needs you".
const LIST_STATUSES = Object.freeze(['waiting', 'running', 'finished', 'idle', 'shell']);
// The CLI finds jq and uuidgen on PATH: a fixed one, never the app's inherited
// PATH, which a planted value could point at another jq.
const FIXED_PATH = Object.freeze(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin']);
const RUNNING_SCRIPT = `return application id "${BUNDLE_ID}" is running`;

// Dock's own matcher falls back to names, folders and prefixes, so only an
// exact full session id is ever passed.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validSessionId = (v) => typeof v === 'string' && UUID.test(v);
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

// Preferences: 'auto' (use it when it is installed and trusted) or 'off'.
const normalizeMode = (v) => (v === 'off' ? 'off' : 'auto');
const modeOf = (config) => normalizeMode(config && config.integrations && config.integrations.ghosttyDock);

// Fixed locations under the home folder, never PATH, and never the
// GHOSTTY_DOCK_STATE override: the app's environment is not the user's shell,
// and a planted variable must not redirect requests.
function locations(home) {
  return {
    cli: path.join(home, '.local', 'bin', 'ghostty-dock'),
    opener: path.join(home, '.local', 'bin', 'ghostty-dock-open'),
    apiDir: path.join(home, '.local', 'state', 'ghostty-dock', 'api'),
    apps: [path.join(home, 'Applications', `${APP}.app`), `/Applications/${APP}.app`],
  };
}

// A regular file (or one symlink, resolved once) in a folder only we can
// write, ours, executable, and not group- or world-writable. This guards
// against other users only: a process running as this user could replace it,
// and could equally replace our hooks.
function cliProblem(file, f, uid, what = 'CLI') {
  let st;
  let real = file;
  try {
    st = f.lstatSync(file);
    if (st.isSymbolicLink()) { real = f.realpathSync(file); st = f.statSync(real); }
  } catch { return `${what} not installed`; }
  if (!st.isFile()) return `${what} is not a file`;
  if (st.uid !== uid) return `${what} is owned by another user`;
  if (st.mode & 0o022) return `${what} can be changed by other users`;
  if (!(st.mode & 0o100)) return `${what} is not executable`;
  let dir;
  try { dir = f.statSync(path.dirname(real)); } catch { return `${what} folder unreadable`; }
  if (dir.uid !== uid || (dir.mode & 0o022)) return `${what} is in a folder other users can change`;
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

function onPath(name, dirs, f) {
  return dirs.some((d) => { try { f.accessSync(path.join(d, name), fs.constants.X_OK); return true; } catch { return false; } });
}

// { installed, trusted, canOpen, cli, apiDir, env, reason }. `cli` is set only
// when trusted; `installed` (the app bundle exists) is enough for the
// AppleScript fallback. `env` is exactly what the CLI runs with.
function detect({ home = os.homedir(), fs: f = fs, uid = typeof process.getuid === 'function' ? process.getuid() : -1, platform = process.platform, pathDirs = FIXED_PATH } = {}) {
  if (platform !== 'darwin') return { installed: false, trusted: false, canOpen: false, cli: null, apiDir: null, env: null, reason: 'macOS only' };
  const where = locations(home);
  const installed = where.apps.some((a) => { try { return f.statSync(a).isDirectory(); } catch { return false; } });
  const problem = cliProblem(where.cli, f, uid) || apiDirProblem(where.apiDir, f, uid)
    || (onPath('jq', pathDirs, f) ? null : 'CLI needs jq') || (onPath('uuidgen', pathDirs, f) ? null : 'CLI needs uuidgen');
  const canOpen = !problem && installed && !cliProblem(where.opener, f, uid, 'Opener');
  return {
    installed, trusted: !problem, canOpen, cli: problem ? null : where.cli, apiDir: where.apiDir,
    env: { HOME: home, PATH: pathDirs.join(':'), TMPDIR: os.tmpdir() },
    reason: problem || (installed ? 'ready' : 'CLI found, app not in Applications'),
  };
}

let memo = null;
function current({ now = Date.now(), ...opts } = {}) {
  if (!memo || now - memo.at >= CACHE_MS) memo = { at: now, value: detect(opts) };
  return memo.value;
}
function invalidate() { memo = null; listMemo = null; }

function execCli(file, args, { timeout = EXEC_TIMEOUT_MS, env, killSignal = 'SIGTERM' } = {}) {
  return new Promise((resolve) => {
    try {
      const child = execFile(file, args, { timeout, killSignal, ...(env ? { env } : {}) }, (err, stdout, stderr) => { // privacy-flow: ghostty-dock-local
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
      child.on('error', (e) => resolve({ ok: false, stdout: '', stderr: e.message }));
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: e.message });
    }
  });
}

// open's command must be exactly the quoted path of a Plexiform one-use file:
// <tmp>/plexiform-terminal-*/continue.command.
function oneUseFile(cmd, tmpRoot) {
  const m = /^'(.*)'$/s.exec(cmd);
  if (!m) return false;
  const file = m[1].replace(/'\\''/g, "'");
  if (quote(file) !== cmd || !okPath(file) || path.basename(file) !== 'continue.command') return false;
  const dir = path.dirname(file);
  return /^plexiform-terminal-[A-Za-z0-9]+$/.test(path.basename(dir)) && path.dirname(dir) === path.resolve(tmpRoot);
}

function shaped(op, args, tmpRoot) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) return null;
  if (op === 'focus') return args.length === 1 && validSessionId(args[0]) ? [args[0]] : null;
  if (op === 'list') return args.length === 0 ? [] : null;
  if (op === 'notify') {
    if (args.length !== 1) return null;
    const title = args[0].replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, TITLE_MAX);
    return title && !title.startsWith('-') ? [title] : null;
  }
  if (op === 'open') return args.length === 3 && okPath(args[0]) && args[1] === '--command' && oneUseFile(args[2], tmpRoot) ? [args[0], args[1], args[2]] : null;
  return null;
}

// `dock` is a fresh detect() result, taken just before the call. argv only,
// with the env detect() checked against.
async function run(op, args, { dock, exec = execCli, tmpRoot = os.tmpdir() } = {}) {
  if (!OPS.includes(op)) throw new Error(`Ghostty Dock op not allowed: ${String(op).slice(0, 20)}`);
  const argv = shaped(op, args, tmpRoot);
  if (!argv) throw new Error(`Ghostty Dock: bad arguments for ${op}`);
  if (!dock || !dock.trusted || !dock.cli) return { ok: false, reason: (dock && dock.reason) || 'Ghostty Dock not available' };
  if (op === 'open' && !dock.canOpen) return { ok: false, reason: 'Ghostty Dock cannot open tabs here' };
  const opts = { env: dock.env, killSignal: 'SIGTERM', timeout: op === 'open' ? OPEN_TIMEOUT_MS : op === 'list' ? LIST_TIMEOUT_MS : EXEC_TIMEOUT_MS };
  // A request the app isn't there to answer would sit in its folder and be
  // acted on whenever the app next starts, so focus (and list) only a running app.
  if (op === 'focus' || op === 'list') {
    const up = await exec('/usr/bin/osascript', ['-e', RUNNING_SCRIPT], opts);
    if (!up || !up.ok || String(up.stdout || '').trim() !== 'true') return { ok: false, reason: 'Ghostty Dock is not running' };
  }
  const r = await exec(dock.cli, [op, ...argv], opts); // privacy-flow: ghostty-dock-local
  if (!r || !r.ok) {
    invalidate();
    return { ok: false, reason: ((r && r.stderr) || 'ghostty-dock failed').trim().slice(0, 120) };
  }
  return op === 'list' ? { ok: true, out: String(r.stdout || '') } : { ok: true };
}

// Dock's list output is another app's text (session names are whatever the
// user or an agent typed), so it is untrusted: a row counts only when its first
// token is a known status word and its last token a full session UUID. All
// else (names, branches, ports, cost, anything malformed) is dropped unread
// and never logged. A UUID seen twice is ambiguous and dropped too.
// Returns Map<lowercase uuid, status>.
function parseList(out) {
  const seen = new Map();
  const dup = new Set();
  const text = typeof out === 'string' ? out.slice(0, LIST_MAX_BYTES) : '';
  for (const line of text.split('\n').slice(0, LIST_MAX_LINES)) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2 || !LIST_STATUSES.includes(tokens[0])) continue;
    const id = tokens[tokens.length - 1];
    if (!validSessionId(id)) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) dup.add(key); else seen.set(key, tokens[0]);
  }
  for (const k of dup) seen.delete(k);
  return seen;
}

// Dock's view of its sessions, cached briefly so a burst of clicks asks once.
// null when it can't be asked (off, untrusted, not running, failed).
let listMemo = null;
async function listStatus({ dock, exec = execCli, now = Date.now() } = {}) {
  if (!dock || !dock.trusted || !dock.cli) return null;
  if (listMemo && now - listMemo.at < LIST_CACHE_MS && listMemo.cli === dock.cli) return listMemo.value;
  const r = await run('list', [], { dock, exec });
  const value = r.ok ? parseList(r.out) : null;
  listMemo = { at: now, cli: dock.cli, value };
  return value;
}
function invalidateList() { listMemo = null; }

// The Preferences → Health and `plexiform doctor` row. Read-only.
function healthRow(dock, mode) {
  const link = 'Third-party app with no license (github.com/andrewbakercloudscale/ghossty-dock); Plexiform only asks it to list its sessions, focus a tab or open one.';
  if (mode === 'off') return { status: 'info', detail: `Turned off in Preferences. ${link}` };
  if (!dock || (!dock.installed && !dock.trusted)) return { status: 'info', detail: `Not installed. ${link}` };
  if (!dock.trusted) return { status: 'warn', detail: `Installed, but not used: ${dock.reason}. ${link}`, next: 'Open Ghostty Dock once; its API folder must be a private folder you own, and jq must be installed.' };
  return { status: 'ok', detail: `Installed. Clicking a Ghostty Dock session goes to its exact tab. Its hook and Plexiform's both run on each Claude tool call. ${link}` };
}

module.exports = { OPS, BUNDLE_ID, APP, CACHE_MS, OPEN_TIMEOUT_MS, LIST_TIMEOUT_MS, LIST_CACHE_MS, LIST_STATUSES, FIXED_PATH, RUNNING_SCRIPT, validSessionId, normalizeMode, modeOf, locations, detect, current, invalidate, run, execCli, parseList, listStatus, invalidateList, healthRow };
