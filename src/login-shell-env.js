// Reads named variables from the user's login shell, for a Plexiform launched
// from the Dock that never saw what ~/.zshrc or ~/.bashrc exports (gateway
// URLs, Codex env_key values). Main process only.
//
// Only names the caller allowlists leave this module, and nothing here logs:
// failures come back as fixed reason codes, never as shell output.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SENTINEL = '\0__PLX_ENV__\0';
const COMMAND = `printf "\\0__PLX_ENV__\\0"; /usr/bin/env -0`;
const TIMEOUT_MS = 4000;
const CACHE_MS = 5 * 60 * 1000;
const MAX_OUTPUT = 1024 * 1024;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Never returned even if a caller asks: these describe this Electron process.
const BLOCKED = /^(ELECTRON_|NODE_OPTIONS$|NODE_PATH$|NODE_EXTRA_CA_CERTS$|npm_|ORIGINAL_XDG_CURRENT_DESKTOP$)/;

const cache = new Map();

function failure(reason) { return { env: {}, ok: false, reason }; }

function defaultShells() {
  try { return fs.readFileSync('/etc/shells', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/')); }
  catch { return null; }
}

function resolveShell({ shell, env, platform, shells }) {
  const explicit = typeof shell === 'string' && shell !== '';
  let candidates;
  if (explicit) candidates = [shell];
  else {
    let fromUser = null;
    try { fromUser = os.userInfo().shell; } catch {}
    candidates = [fromUser, env.SHELL, platform === 'darwin' ? '/bin/zsh' : '/bin/bash'];
  }
  const allowed = shells === undefined ? defaultShells() : shells;
  for (const c of candidates) {
    if (typeof c !== 'string' || !path.isAbsolute(c)) continue;
    // A caller-supplied shell is trusted to be a path, not to be listed.
    if (!explicit && allowed && !allowed.includes(c)) continue;
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

// Runs `file` in its own process group so a hung rc file can be killed whole.
function defaultExec(file, args, { cwd, env, timeout }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { resolve({ code: null, stdout: '', timedOut: false }); return; }
    const chunks = [];
    let size = 0, timedOut = false, done = false;
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } };
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); finish(null); }, timeout);
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > MAX_OUTPUT) { killGroup(); finish(null); return; }
      chunks.push(d);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

function parse(stdout) {
  const at = stdout.indexOf(SENTINEL);
  if (at < 0) return null;
  const map = {};
  for (const entry of stdout.slice(at + SENTINEL.length).split('\0')) {
    const eq = entry.indexOf('=');
    if (eq < 1) continue;
    const name = entry.slice(0, eq);
    if (NAME.test(name)) map[name] = entry.slice(eq + 1);
  }
  return map;
}

// The shared spawn-and-parse helper (terminal plan 6b reuses it). `all` holds
// every variable the shell exported: callers must filter before it leaves the
// process, and must not log or cache it.
async function spawnLoginEnv({ shell, home, platform = process.platform, env = process.env, exec = defaultExec, timeoutMs = TIMEOUT_MS, shells } = {}) {
  if (platform === 'win32') return { ok: false, reason: 'unsupported', all: {} };
  const file = resolveShell({ shell, env, platform, shells });
  if (!file) return { ok: false, reason: 'bad_shell', all: {} };
  const dir = home || env.HOME || os.homedir();
  // Built from scratch so no ELECTRON_*/NODE_OPTIONS reaches the rc files.
  const clean = { HOME: dir, USER: env.USER || '', LOGNAME: env.LOGNAME || env.USER || '', SHELL: file, TERM: 'dumb', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  let res;
  try { res = await exec(file, ['-l', '-i', '-c', COMMAND], { cwd: dir, env: clean, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return { ok: false, reason: 'spawn_failed', all: {} }; }
  if (!res || res.timedOut) return { ok: false, reason: 'timeout', all: {} };
  if (res.code !== 0) return { ok: false, reason: 'exit_nonzero', all: {} };
  const all = parse(typeof res.stdout === 'string' ? res.stdout : '');
  return all ? { ok: true, reason: null, all } : { ok: false, reason: 'no_sentinel', all: {} };
}

// `names` entries match exactly; one ending in `*` matches a prefix
// (VERTEX_REGION_*). Anything on the blocklist is never returned.
function filter(all, names) {
  const exact = new Set(), prefixes = [];
  for (const n of Array.isArray(names) ? names : []) {
    if (typeof n !== 'string' || n === '') continue;
    if (n.endsWith('*')) prefixes.push(n.slice(0, -1)); else exact.add(n);
  }
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    if (BLOCKED.test(k)) continue;
    if (exact.has(k) || prefixes.some((p) => p !== '' && k.startsWith(p))) out[k] = v;
  }
  return out;
}

async function readLoginShellEnv({ names = [], shell, home, platform = process.platform, env = process.env, exec, now = Date.now, timeoutMs = TIMEOUT_MS, shells } = {}) {
  if (platform === 'win32') return failure('unsupported');
  const key = JSON.stringify([shell || null, home || null, [...names].sort()]);
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_MS) return { env: { ...hit.env }, ok: true, reason: null };
  const res = await spawnLoginEnv({ shell, home, platform, env, exec, timeoutMs, shells });
  if (!res.ok) return failure(res.reason);
  const picked = filter(res.all, names);
  cache.set(key, { at: now(), env: picked });
  return { env: { ...picked }, ok: true, reason: null };
}

// Call when the user's settings change.
function invalidate() { cache.clear(); }

module.exports = { readLoginShellEnv, spawnLoginEnv, filter, invalidate, CACHE_MS, TIMEOUT_MS };
