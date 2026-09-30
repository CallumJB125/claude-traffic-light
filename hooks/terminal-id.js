// What the app needs to find the exact tab a session runs in, captured once at
// SessionStart. Only the keys below are ever read from the environment: the
// hook's env also carries API keys and tokens, and none of that may reach a
// session file. Nothing is kept that no focus adapter uses.
const ENV_KEYS = [
  'TERM_PROGRAM',
  'ITERM_SESSION_ID',
  'KITTY_WINDOW_ID', 'KITTY_LISTEN_ON',
  'WEZTERM_PANE',
  'TMUX', 'TMUX_PANE',
];
const MAX_VALUE = 300;
const clean = (v) => typeof v === 'string' && v && v.length <= MAX_VALUE && !/[\0\r\n]/.test(v);

// `ps -o tty=` prints `ttys003` (macOS) or `pts/3` (Linux); `??` or `?` when
// the process has no terminal.
function ttyOf(raw) {
  const t = String(raw || '').trim();
  return /^(ttys\d{1,4}|pts\/\d{1,4})$/.test(t) ? `/dev/${t}` : null;
}

// `run(file, args)` returns stdout or throws; injected so tests never shell out.
// `cwd` is the folder the session started in: the terminal's own folder, which
// the session's later cwd can drift away from.
function captureTerminal({ env = {}, pid, cwd, run, platform = process.platform }) {
  const out = { env: {}, tty: null, cwd: typeof cwd === 'string' && cwd.startsWith('/') && cwd.length <= 1000 ? cwd : null };
  for (const k of ENV_KEYS) if (clean(env[k])) out.env[k] = env[k];
  if ((platform === 'darwin' || platform === 'linux') && Number.isInteger(pid) && pid > 1) {
    try {
      out.tty = ttyOf(run('/bin/ps', ['-o', 'tty=', '-p', String(pid)]));
    } catch { /* no tty is fine: the app falls back to activating the app */ }
  }
  return out;
}

module.exports = { ENV_KEYS, captureTerminal, ttyOf };
