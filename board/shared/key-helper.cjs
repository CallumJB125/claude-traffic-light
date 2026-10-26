'use strict';

// Runs a command the user's own Claude settings name (apiKeyHelper, awsAuthRefresh,
// awsCredentialExport) on Plexiform's side, never inside a run. A run's cwd is an
// agent-editable worktree, so a helper like `./key.sh` or `npx get-key` must not
// resolve there (review C1). Here the cwd is $HOME, PATH keeps only absolute
// entries, and the command gets 10 seconds. Its stderr is never read, logged or
// stored (R2-6): a failure is only "<label> failed (exit N)", and a timeout is
// the sign-in reason, because an interactive (SSO) helper waits for a person.
const childProcess = require('node:child_process');
const path = require('node:path');

const TIMEOUT_MS = 10_000;
const MAX_OUT = 64 * 1024;
const PASS = ['HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'TZ', 'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'];
const WINDOWS_PASS = ['SystemRoot', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'];

function absolutePath(value, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const kept = String(value || '').split(platform === 'win32' ? ';' : ':').filter((d) => d && p.isAbsolute(d));
  return kept.length ? kept.join(platform === 'win32' ? ';' : ':') : (platform === 'win32' ? '' : '/usr/bin:/bin');
}

function helperEnv(env, platform, extraEnv) {
  const out = {};
  for (const k of PASS.concat(platform === 'win32' ? WINDOWS_PASS : [])) if (env[k]) out[k] = env[k];
  out.PATH = absolutePath(env.PATH, platform);
  return { ...out, ...extraEnv };
}

const signIn = (label) => `your ${label} needs you to sign in; run it once in a terminal`;

/**
 * → { ok:true, output } | { ok:false, timedOut:boolean, code:number|null, reason }.
 * `reason` is safe to show: it never holds the command's output or stderr.
 */
function runUserCommand({ command, label = 'key helper', home, env = {}, extraEnv = {}, platform = process.platform, timeoutMs = TIMEOUT_MS, spawn = childProcess.spawn }) {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let tooBig = false;
    let child = null;
    let timer = null;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const kill = () => {
      if (!child) return;
      try { if (platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    if (typeof command !== 'string' || !command.trim() || !home) return finish({ ok: false, timedOut: false, code: null, reason: `${label} failed (exit none)` });
    try {
      child = spawn(command, { shell: true, cwd: home, env: helperEnv(env, platform, extraEnv), stdio: ['ignore', 'pipe', 'ignore'], detached: platform !== 'win32', windowsHide: true }); // privacy-flow: user-key-helper
    } catch { return finish({ ok: false, timedOut: false, code: null, reason: `${label} failed (exit none)` }); }
    timer = setTimeout(() => { kill(); finish({ ok: false, timedOut: true, code: null, reason: signIn(label) }); }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (out.length + d.length > MAX_OUT) { tooBig = true; kill(); return; }
      out += d;
    });
    child.on('error', () => finish({ ok: false, timedOut: false, code: null, reason: `${label} failed (exit none)` }));
    child.on('close', (code) => {
      if (tooBig || code !== 0) finish({ ok: false, timedOut: false, code, reason: `${label} failed (exit ${code ?? 'none'})` });
      else finish({ ok: true, output: out.trim() });
    });
  });
}

const runKeyHelper = (o) => runUserCommand({ ...o, label: 'key helper' });

module.exports = { runUserCommand, runKeyHelper, absolutePath, TIMEOUT_MS };
