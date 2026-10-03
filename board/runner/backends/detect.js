// AI CLI detection (runner-adapters-contract.md §2): resolve a binary once,
// probe it with its own --version / status command (3 s, never a shell, never
// a prompt), never read credential file contents. Pure local.
import { jobHelperPath } from '../windows-job.js';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const PROBE_TIMEOUT_MS = 3000;

// Install dirs CLIs commonly use that a GUI app's PATH may lack.
const KNOWN_DIRS = (home) => [
  home && path.join(home, '.local', 'bin'), home && path.join(home, '.npm-global', 'bin'), home && path.join(home, '.bun', 'bin'),
  '/opt/homebrew/bin', '/usr/local/bin',
].filter(Boolean);

// A probe sees only what it needs to find its own config.
export function probeEnv(env) {
  const out = {};
  for (const k of ['HOME', 'PATH', 'LANG', 'TMPDIR', 'CODEX_HOME', ...(process.platform === 'win32' ? ['SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'] : [])]) if (env[k]) out[k] = env[k];
  for (const [k, v] of Object.entries(env)) if (/^LC_[A-Z_]+$/.test(k) && v) out[k] = v;
  return out;
}

const ADMIN_GID = 80;   // macOS admin group: its members can already sudo, so its write bit adds no attacker

/**
 * A binary we may run: a regular executable owned by us or root with no
 * group/other write bit, and every ancestor directory up to / owned by us or
 * root and not writable by others (except root-owned sticky dirs like /tmp,
 * where nobody else can replace our entries) nor by a group other than
 * root/wheel or (macOS) admin.
 */
export function safeBinary(real, uid = process.getuid?.() ?? 0, platform = process.platform) {
  if (platform === 'win32') {
    try {
      execFileSync(jobHelperPath(), ['trusted', real], { timeout: 3000, windowsHide: true, stdio: 'ignore' }); // privacy-flow: ai-detect
      return true;
    } catch { return false; }
  }
  let st;
  try { st = fs.statSync(real); } catch { return false; }
  if (!st.isFile() || (st.mode & 0o111) === 0 || (st.mode & 0o022) !== 0 || (st.uid !== uid && st.uid !== 0)) return false;
  let d = path.dirname(real);
  for (;;) {
    let ds;
    try { ds = fs.statSync(d); } catch { return false; }
    if (ds.uid !== uid && ds.uid !== 0) return false;
    if ((ds.mode & 0o002) !== 0 && !((ds.mode & 0o1000) !== 0 && ds.uid === 0)) return false;
    if ((ds.mode & 0o020) !== 0 && ds.gid !== 0 && !(platform === 'darwin' && ds.gid === ADMIN_GID)) return false;
    const up = path.dirname(d);
    if (up === d) return true;
    d = up;
  }
}

/** Absolute real path of `name` on PATH (then known dirs) that passes safeBinary, or {reason}. */
export function resolveBin(name, env, knownDirs = KNOWN_DIRS(env.HOME), platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path;
  const dirs = [...String(env.PATH ?? '').split(paths.delimiter), ...knownDirs].filter((d) => d && paths.isAbsolute(d));
  let unsafe = false;
  for (const dir of dirs) {
    const cand = paths.join(dir, platform === 'win32' ? `${name}.exe` : name);
    let real;
    try { real = fs.realpathSync(cand); } catch { continue; }
    let st;
    try { st = fs.statSync(real); } catch { continue; }
    if (!st.isFile() || (platform !== 'win32' && (st.mode & 0o111) === 0)) continue;
    if (!safeBinary(real, undefined, platform)) { unsafe = true; continue; }
    return { bin: real };
  }
  return { reason: unsafe ? 'unsafe_bin' : 'not_found' };
}

/** Runs bin with args; resolves {code, stdout} or null on spawn error/timeout. */
export function probe(bin, args, env, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(bin, args, { env: probeEnv(env), windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }, (err, stdout) => { // privacy-flow: ai-detect
        if (err && (err.killed || typeof err.code !== 'number')) return resolve(null);
        resolve({ code: err ? err.code : 0, stdout: String(stdout ?? '') });
      });
    } catch { resolve(null); return; }
    child.stdin?.end();
  });
}

export function versionOf(stdout) {
  return /\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/.exec(stdout ?? '')?.[1] ?? null;
}

const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/**
 * Shared detect(): {id, installed, version, signedIn, bin, reason?}.
 * knownDirs replaces the extra install dirs searched after PATH ([] = PATH only).
 */
export async function detectCli(id, { env = process.env, timeoutMs = PROBE_TIMEOUT_MS, which, knownDirs, authFiles = () => [], statusArgs = null, platform = process.platform } = {}) {
  const r = which ? which(id, env) : resolveBin(id, env, knownDirs, platform);
  if (!r.bin) return { id, installed: false, version: null, signedIn: 'unknown', bin: null, reason: r.reason ?? 'not_found' };
  const v = await probe(r.bin, ['--version'], env, timeoutMs);
  if (!v || v.code !== 0) return { id, installed: true, version: null, signedIn: 'unknown', bin: r.bin, reason: 'probe_failed' };
  let signedIn = 'unknown';
  if (authFiles(env).some(exists)) signedIn = true;
  else if (statusArgs) {
    const s = await probe(r.bin, statusArgs, env, timeoutMs);
    if (s?.code === 0) signedIn = true;
  }
  return { id, installed: true, version: versionOf(v.stdout), signedIn, bin: r.bin };
}
