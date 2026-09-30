// Jump to the exact terminal tab a session runs in. Each adapter knows one
// terminal; the first that can handle the session and succeeds wins. Any
// miss, error or timeout returns { ok: false } and the caller falls back to
// activating the app, which is what the jump did before this existed.
//
// Nothing here ever types into a terminal or fakes input: only
// each terminal's own select/focus API.
const fs = require('fs');
const { execFile } = require('child_process');

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
// The first run against an app can sit behind macOS's Automation prompt;
// killing it at 2.5 s would fall back while the user is still reading.
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

function makeContext(over = {}) {
  return { exec, which, isDir, platform: process.platform, onNeeds: async () => {}, ...over };
}

async function focusSession(session, over = {}, adapters = ADAPTERS) {
  const ctx = makeContext(over);
  if (!session || typeof session !== 'object') return { ok: false, reason: 'no session' };
  ctx.focusOuter = (outer) => focusSession(outer, over, adapters.filter((a) => a.id !== 'tmux'));
  let last = { ok: false, reason: 'no adapter for this terminal' };
  for (const a of adapters) {
    let can = false;
    try { can = a.canHandle(session, ctx); } catch { can = false; }
    if (!can) continue;
    try {
      const hint = a.needs ? await ctx.onNeeds(a.needs) : null;
      const run = hint && hint.patient ? { ...ctx, exec: (f, args) => ctx.exec(f, args, { timeout: PROMPT_TIMEOUT_MS }) } : ctx;
      const r = await a.focus(session, run);
      if (r && r.ok) return { adapter: a.id, ...r };
      last = { adapter: a.id, ...(r || {}), ok: false, needs: (r && r.needs) || a.needs };
    } catch (e) {
      last = { adapter: a.id, ok: false, reason: e.message };
    }
  }
  return last;
}

module.exports = { ADAPTERS, focusSession, makeContext, exec, which, isDir, EXEC_TIMEOUT_MS, PROMPT_TIMEOUT_MS };
