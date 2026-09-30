// What the app needs to find the exact tab a session runs in, captured once at
// SessionStart. Only the keys below are ever read from the environment: the
// hook's env also carries API keys and tokens, and none of that may reach a
// session file.
const ENV_KEYS = [
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  'ITERM_SESSION_ID',
  'KITTY_WINDOW_ID', 'KITTY_LISTEN_ON',
  'WEZTERM_PANE',
  'TMUX', 'TMUX_PANE',
  'VSCODE_PID', 'VSCODE_IPC_HOOK_CLI',
];
const MAX_VALUE = 300;

// `ps -o tty=` prints `ttys003` (macOS) or `pts/3` (Linux); `??` or `?` when
// the process has no terminal.
function ttyOf(raw) {
  const t = String(raw || '').trim();
  return /^(ttys\d{1,4}|pts\/\d{1,4})$/.test(t) ? `/dev/${t}` : null;
}

// `run(file, args)` returns stdout or throws; injected so tests never shell out.
function captureTerminal({ env = {}, pid, run, platform = process.platform }) {
  const out = { env: {}, tty: null, shellPid: null };
  for (const k of ENV_KEYS) {
    const v = env[k];
    if (typeof v === 'string' && v && v.length <= MAX_VALUE && !/[\0\r\n]/.test(v)) out.env[k] = v;
  }
  if ((platform === 'darwin' || platform === 'linux') && Number.isInteger(pid) && pid > 1) {
    try {
      const m = /^\s*(\S+)\s+(\d+)\s*$/.exec(String(run('/bin/ps', ['-o', 'tty=,ppid=', '-p', String(pid)])));
      if (m) {
        out.tty = ttyOf(m[1]);
        const ppid = Number(m[2]);
        if (ppid > 1) out.shellPid = ppid;
      }
    } catch { /* no tty is fine: the app falls back to activating the app */ }
  }
  return out;
}

module.exports = { ENV_KEYS, captureTerminal, ttyOf };
