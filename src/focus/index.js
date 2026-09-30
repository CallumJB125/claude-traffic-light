// Jump to the exact terminal tab a session runs in. Each adapter knows one
// terminal; the first that can handle the session and succeeds wins. Any
// miss, error or timeout returns { ok: false } and the caller falls back to
// activating the app, which is what the jump did before this existed.
//
// Nothing here ever types into a terminal or fakes input: only
// each terminal's own select/focus API.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const Ids = require('./ids.js');

// tmux first: inside tmux the outer terminal's ids describe the tab the tmux
// server was started from, not this pane.
const ADAPTERS = [
  require('./tmux.js'),
  require('./iterm.js'),
  require('./terminal-app.js'),
  require('./ghostty.js'),
  require('./kitty.js'),
  require('./wezterm.js'),
  require('./vscode.js'),
];

const EXEC_TIMEOUT_MS = 2500;
// A whole jump, however many commands it takes; a click that hangs longer
// than this is worse than landing on the app.
const JUMP_DEADLINE_MS = 4000;
// The first run against an app can sit behind macOS's Automation prompt;
// killing it early would fall back while the user is still reading.
const PROMPT_TIMEOUT_MS = 30000;

function exec(file, args, { timeout = EXEC_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    try {
      const child = execFile(file, args, { timeout, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
      child.on('error', (e) => resolve({ ok: false, stdout: '', stderr: e.message }));
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: e.message });
    }
  });
}

function which(paths) {
  for (const p of paths) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// The socket named in a session file is only talked to if it is really this
// user's tmux: a socket we own, in a directory we own that nobody else can
// write to, with the server pid from TMUX alive and ours (kill 0 is refused
// for another user's process).
function tmuxServerOk(sock, pid) {
  if (!sock || !pid || typeof process.getuid !== 'function') return false;
  const uid = process.getuid();
  try {
    const st = fs.lstatSync(sock);
    if (!st.isSocket() || st.uid !== uid) return false;
    const dir = fs.statSync(path.dirname(sock));
    if (dir.uid !== uid || (dir.mode & 0o022)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function makeContext(over = {}) {
  return { exec, which, isDir, tmuxServerOk, now: Date.now, platform: process.platform, onNeeds: async () => {}, ...over };
}

// `clock` is shared with the nested lookup of a tmux client's outer tab, so
// the deadline covers the whole jump.
async function focusSession(session, over = {}, adapters = ADAPTERS, clock = null) {
  const ctx = makeContext(over);
  if (!session || typeof session !== 'object') return { ok: false, reason: 'no session' };
  const deadline = clock || { at: ctx.now() + JUMP_DEADLINE_MS };
  const cancelled = () => !!(ctx.isCancelled && ctx.isCancelled());
  const bounded = (cap) => (file, args) => {
    if (cancelled()) return Promise.resolve({ ok: false, stdout: '', stderr: 'superseded by a newer jump' });
    const left = deadline.at - ctx.now();
    if (left <= 0) return Promise.resolve({ ok: false, stdout: '', stderr: 'jump deadline passed' });
    return ctx.exec(file, args, { timeout: Math.min(cap, left) });
  };
  ctx.focusOuter = (outer) => focusSession(outer, { ...over, outer: true }, adapters.filter((a) => a.id !== 'tmux'), deadline);
  // Inside tmux it is the pane or nothing: every other id the session holds
  // belongs to some other tab, and landing there would be reported as exact.
  const tried = Ids.inTmux(session) && !ctx.outer ? adapters.filter((a) => a.id === 'tmux') : adapters;
  let last = { ok: false, reason: Ids.inTmux(session) ? 'tmux pane not reachable' : 'no adapter for this terminal' };
  for (const a of tried) {
    if (ctx.now() >= deadline.at) return { ...last, ok: false, reason: 'jump deadline passed' };
    if (cancelled()) return { ...last, ok: false, reason: 'superseded by a newer jump' };
    let can = false;
    try { can = a.canHandle(session, ctx); } catch { can = false; }
    if (!can) continue;
    try {
      const hint = a.needs ? await ctx.onNeeds(a.needs) : null;
      if (hint && hint.patient) deadline.at = Math.max(deadline.at, ctx.now() + PROMPT_TIMEOUT_MS);
      const run = { ...ctx, exec: bounded(hint && hint.patient ? PROMPT_TIMEOUT_MS : EXEC_TIMEOUT_MS) };
      const r = await a.focus(session, run);
      if (r && r.ok) return { adapter: a.id, ...r };
      last = { adapter: a.id, ...(r || {}), ok: false, needs: (r && r.needs) || a.needs };
    } catch (e) {
      last = { adapter: a.id, ok: false, reason: e.message };
    }
  }
  return last;
}

module.exports = { ADAPTERS, focusSession, makeContext, exec, which, isDir, tmuxServerOk, EXEC_TIMEOUT_MS, JUMP_DEADLINE_MS, PROMPT_TIMEOUT_MS };
