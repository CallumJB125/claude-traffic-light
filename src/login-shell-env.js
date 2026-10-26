// Reads named variables from the user's login shell, for a Plexiform launched
// from the Dock that never saw what ~/.zshrc or ~/.bashrc exports (gateway
// URLs, Codex env_key values). Main process only.
//
// Only names the caller allowlists leave readLoginShellEnv, and nothing here
// logs: failures come back as fixed reason codes, never as shell output.
//
// Shells: zsh and bash (`-l -i -c`) are the supported ones. fish accepts the
// flags and likely works (printf is called as a command), unverified, and tcsh/csh reject `-l` with other
// flags; both then fail safe as `no_sentinel` / `exit_nonzero` with no values.
//
// Trust boundary: an explicit `shell` skips the /etc/shells check, so it must
// come only from Plexiform's own settings, never from a provider config, an
// env var or anything a session can write.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const START = '\0__PLX_ENV__\0';
const END = '\0__PLX_END__\0';
// `env printf` skips an rc-defined function or alias, and /usr/bin/env exists
// even where printf isn't in /usr/bin (NixOS).
const COMMAND = "/usr/bin/env printf '\\0__PLX_ENV__\\0'; /usr/bin/env -0; /usr/bin/env printf '\\0__PLX_END__\\0'";
const TIMEOUT_MS = 4000;
const CACHE_MS = 5 * 60 * 1000;
const FAIL_CACHE_MS = 60 * 1000;
const EXIT_GRACE_MS = 250;
const MAX_OUTPUT = 1024 * 1024;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CACHED_FAILURES = new Set(['timeout', 'exit_nonzero', 'no_sentinel']);
// Never returned even if a caller asks: these describe this Electron process.
const BLOCKED = /^(ELECTRON_|NODE_OPTIONS$|NODE_PATH$|NODE_EXTRA_CA_CERTS$|npm_|ORIGINAL_XDG_CURRENT_DESKTOP$)/;

const cache = new Map();
const pending = new Map();
let generation = 0;

function failure(reason) { return { env: {}, ok: false, reason }; }
const copy = (r) => ({ env: { ...r.env }, ok: r.ok, reason: r.reason });

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
    if (!explicit && allowed && !allowed.includes(c)) continue;
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

// Runs `file` in its own process group so a hung rc file can be killed whole.
// Resolves when the shell has exited and END was seen (or a short grace passed),
// not on stream close: an rc-started background job can hold stdout open.
function defaultExec(file, args, { cwd, env, timeout }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); } // privacy-flow: login-shell-env
    catch { resolve({ code: null, stdout: '', error: 'spawn_failed' }); return; }
    let chunks = [], size = 0, done = false, exited = false, exitCode = null, tail = '', graceTimer = null;
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } };
    const finish = (result, kill = true) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      const stdout = result.error || result.timedOut ? '' : Buffer.concat(chunks).toString('utf8');
      chunks = [];
      if (kill) killGroup();
      child.stdout.removeAllListeners();
      child.stdout.destroy();
      child.removeAllListeners();
      child.on('error', () => {});
      resolve({ code: null, ...result, stdout });
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeout);
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > MAX_OUTPUT) { finish({ error: 'too_large' }); return; }
      chunks.push(d);
      tail = (tail + d.toString('latin1')).slice(-32);
      if (exited && tail.includes(END)) finish({ code: exitCode });
    });
    child.on('error', () => finish({ error: 'spawn_failed' }, false));
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      if (tail.includes(END)) finish({ code });
      else graceTimer = setTimeout(() => finish({ code }), EXIT_GRACE_MS);
    });
    child.on('close', (code) => finish({ code }, false));
  });
}

function parse(stdout) {
  const from = stdout.indexOf(START);
  if (from < 0) return null;
  const to = stdout.indexOf(END, from + START.length);
  if (to < 0) return null;
  const map = Object.create(null);
  // env -0 terminates every entry, so the last split piece is always empty.
  for (const entry of stdout.slice(from + START.length, to).split('\0').slice(0, -1)) {
    const eq = entry.indexOf('=');
    if (eq < 1) continue;
    const name = entry.slice(0, eq);
    if (NAME.test(name)) map[name] = entry.slice(eq + 1);
  }
  return map;
}

function startEnv(file, dir, env) {
  let user = env.USER, login = env.LOGNAME;
  if (!user || !login) {
    let name = '';
    try { name = os.userInfo().username; } catch {}
    user = user || name;
    login = login || user;
  }
  const clean = { HOME: dir, USER: user || '', LOGNAME: login || '', SHELL: file, TERM: 'dumb', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const [k, v] of Object.entries(env)) if ((k === 'LANG' || k === 'TMPDIR' || k.startsWith('LC_')) && typeof v === 'string') clean[k] = v;
  return clean;
}

// MAIN PROCESS ONLY. Returns every variable the shell exported, secrets
// included, so never pass `all` to a utility process or renderer, log it, or
// cache it. Callers filter it (filter / withoutBlocked) before it goes anywhere.
// This is the spawn-and-parse helper terminal plan 6b shares.
async function spawnLoginEnvUnfiltered({ shell, home, platform = process.platform, env = process.env, exec = defaultExec, timeoutMs = TIMEOUT_MS, shells } = {}) {
  if (platform === 'win32') return { ok: false, reason: 'unsupported', all: {} };
  const file = resolveShell({ shell, env, platform, shells });
  if (!file) return { ok: false, reason: 'bad_shell', all: {} };
  const dir = home || env.HOME || os.homedir();
  let res;
  try { res = await exec(file, ['-l', '-i', '-c', COMMAND], { cwd: dir, env: startEnv(file, dir, env), timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return { ok: false, reason: 'spawn_failed', all: {} }; }
  if (!res) return { ok: false, reason: 'spawn_failed', all: {} };
  if (res.timedOut) return { ok: false, reason: 'timeout', all: {} };
  if (res.error) return { ok: false, reason: res.error, all: {} };
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
  const out = Object.create(null);
  for (const [k, v] of Object.entries(all)) {
    if (BLOCKED.test(k)) continue;
    if (exact.has(k) || prefixes.some((p) => p !== '' && k.startsWith(p))) out[k] = v;
  }
  return { ...out };
}

// Deny-list form for 6b: everything except the Electron/Node variables.
function withoutBlocked(all) {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(all)) if (!BLOCKED.test(k)) out[k] = v;
  return { ...out };
}

async function load(args, key, now) {
  const gen = generation;
  const res = await spawnLoginEnvUnfiltered(args);
  const result = res.ok ? { env: filter(res.all, args.names), ok: true, reason: null } : failure(res.reason);
  if (gen === generation && (res.ok || CACHED_FAILURES.has(res.reason))) cache.set(key, { at: now(), result });
  return result;
}

async function readLoginShellEnv({ names, shell, home, platform = process.platform, env = process.env, exec, now = Date.now, timeoutMs = TIMEOUT_MS, shells } = {}) {
  if (platform === 'win32') return failure('unsupported');
  if (!Array.isArray(names)) return failure('bad_names');
  if (names.length === 0) return { env: {}, ok: true, reason: null };
  const key = JSON.stringify([shell || null, home || null, names.filter((n) => typeof n === 'string').sort()]);
  const hit = cache.get(key);
  if (hit && now() - hit.at < (hit.result.ok ? CACHE_MS : FAIL_CACHE_MS)) return copy(hit.result);
  let inflight = pending.get(key);
  if (!inflight) {
    inflight = load({ names, shell, home, platform, env, exec, timeoutMs, shells }, key, now).finally(() => { if (pending.get(key) === inflight) pending.delete(key); });
    pending.set(key, inflight);
  }
  return copy(await inflight);
}

// Call when the user's settings change.
function invalidate() { generation++; cache.clear(); pending.clear(); }

module.exports = { readLoginShellEnv, spawnLoginEnvUnfiltered, filter, withoutBlocked, invalidate, CACHE_MS, FAIL_CACHE_MS, TIMEOUT_MS };
