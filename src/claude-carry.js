'use strict';
// Main-process wiring of board/shared/claude-carry.cjs for the no-tool Claude
// children (owned chat, one-shot helpers, voice): the user's own provider and
// auth, carried by allowlist. These children have no Bash tool, so a key may sit
// in their env (plan C14); a run that has a shell never gets one that way.
const fs = require('node:fs');
const path = require('node:path');
const { createClaudeCarry, burstOwnsPort, BURST_GATEWAY_PORT, PROC_RULES } = require('../board/shared/claude-carry.cjs');

// Seam for PR 1b (src/login-shell-env.js): main calls setLoginShellEnv(readFilteredLoginShellEnv) once it exists.
// Until then a Dock-launched app only sees its own env and the user's settings files.
let loginShellEnv = null;
function setLoginShellEnv(fn) { loginShellEnv = typeof fn === 'function' ? fn : null; shared = null; }

let shared = null;
function defaultCarry() {
  if (!shared) shared = createClaudeCarry({ env: process.env, loginShellEnv: (a) => (loginShellEnv ? loginShellEnv(a) : {}), burstOwnsPort });
  return shared;
}

// The carry for a given env: the app's own env gets the shared one. Any other env (a test's fixture) carries
// nothing unless the caller injects a carry, and tests run under the no-real-cli guard never read the
// developer's real Claude files.
function carryFor(env) {
  if (env && env !== process.env) return null;
  return globalThis.__plexiformNoRealCli ? null : defaultCarry();
}

const NONE = Object.freeze({ failure: null, env: {}, model: 'haiku', userModel: null });

/**
 * Prepares one no-tool child. → { failure: {kind, reason}|null, env (merge into the child env),
 * model (what a `haiku` default becomes on this provider), userModel }.
 * `carry` is injectable; null means carry nothing.
 */
async function prepareNoTool(carry) {
  if (!carry) return NONE;
  let c;
  try { c = await carry.prepare({ mode: 'notool' }); } catch { return NONE; }
  if (c.failure) return { failure: c.failure, env: {}, model: 'haiku', userModel: null, release: c.release };
  if (!c.carry) return NONE;
  return { failure: null, env: c.childEnv, model: c.oneShotModel, userModel: c.model, release: c.release };
}

/**
 * Prepares a writable owned chat: no shell, but file tools, so the key goes to a 0600 file in `keyDir` (a private dir
 * outside the project) behind apiKeyHelper, never into the child's env. → { failure, env, model, settings, disallowed, release }.
 * `settings` is the one --settings file's content ({apiKeyHelper?, env?}); null when nothing is carried.
 */
async function prepareChat(carry, keyDir, keyFile) {
  if (!carry) return { ...NONE, settings: null, disallowed: [], release() {} };
  let c;
  try { c = await carry.prepare({ mode: 'chat', keyFile }); } catch { return { ...NONE, settings: null, disallowed: [], release() {} }; }
  if (c.failure) return { failure: c.failure, env: {}, model: 'haiku', userModel: null, settings: null, disallowed: [], release: c.release };
  if (!c.carry) return { ...NONE, settings: null, disallowed: [], release: c.release };
  const settings = {
    permissions: { deny: [...PROC_RULES] },
    ...(c.apiKeyFile ? { apiKeyHelper: `/bin/cat '${String(c.apiKeyFile).replace(/'/g, `'\\''`)}'` } : {}),
    ...(Object.keys(c.settingsEnv).length ? { env: c.settingsEnv } : {}),
  };
  return { failure: null, env: c.cliEnv, model: c.oneShotModel, userModel: c.model, settings, disallowed: c.disallowed, release: c.release };
}

// Where a child that has file tools keeps its key file: <userData>/run, a private dir of the app's own, never /tmp.
// Each use makes chat-<pid>-* / voice-key-<pid>-* / codex-<pid>-* (the owned Codex chat's key file) below it; a start removes what a crash left, never a dir whose
// process is alive (a second instance, a dev run sharing the folder).
const KEY_DIR_KINDS = ['chat', 'voice-key', 'codex'];
const keyDirPrefix = (kind, pid = process.pid) => `${kind}-${pid}-`;
function ensureKeyRoot(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch { /* not ours to tighten */ }
  return root;
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
// When a process started (ms since epoch), or null when unknown. `etime` ([[dd-]hh:]mm:ss) is the one elapsed-time
// keyword both macOS (BSD) ps and Linux procps have; `etimes` is Linux only.
const ETIME = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/;
function pidStartedAt(pid) {
  try {
    const out = require('node:child_process').execFileSync('/bin/ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }); // privacy-flow: key-dir-sweep
    const m = ETIME.exec(String(out));
    if (!m) return null;
    const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map((x) => Number(x || 0));
    return Date.now() - (((d * 24 + h) * 60 + mi) * 60 + s) * 1000;
  } catch { return null; }
}
// A dir whose pid is alive is kept, unless the dir is older than that process: the pid was reused after a crash.
function sweepKeyDirs(root, { alive = pidAlive, startedAt = pidStartedAt } = {}) {
  let names;
  try { names = fs.readdirSync(root); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const m = /^(chat|voice-key|codex)-(?:(\d+)-)?/.exec(name);
    if (!m) continue;
    if (m[2] && alive(Number(m[2]))) {
      let older = false;
      try {
        const started = startedAt(Number(m[2]));
        older = started != null && fs.statSync(path.join(root, name)).mtimeMs < started - 2000;
      } catch { older = false; }
      if (!older) continue;
    }
    try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); n++; } catch { /* gone */ }
  }
  return n;
}
// keyRoot may be a path or a getter (main resolves it after the dev profile is set).
const resolveKeyRoot = (keyRoot) => (typeof keyRoot === 'function' ? keyRoot() : keyRoot) || null;

module.exports = { pidStartedAt, ensureKeyRoot, sweepKeyDirs, keyDirPrefix, resolveKeyRoot, KEY_DIR_KINDS, prepareChat, NONE, prepareNoTool, defaultCarry, carryFor, setLoginShellEnv, burstOwnsPort, BURST_GATEWAY_PORT };
