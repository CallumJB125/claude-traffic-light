// Everything a focus adapter reads from a session file is untrusted: any
// process running as the user can write that file. Each value is checked
// against a strict pattern before it goes anywhere near a command line, and
// adapters pass it as an argv entry, never spliced into a shell string or a
// script's source.

const rawEnv = (s) => (s && s.terminal && typeof s.terminal === 'object' && s.terminal.env && typeof s.terminal.env === 'object' ? s.terminal.env : {});
// A tmux pane inherits the tmux server's environment, so ITERM_SESSION_ID,
// KITTY_* and WEZTERM_PANE there describe whichever tab started the server,
// not this pane: inside tmux only tmux's own ids are believed.
const OUTER_IDS = ['ITERM_SESSION_ID', 'KITTY_WINDOW_ID', 'KITTY_LISTEN_ON', 'WEZTERM_PANE'];
function envOf(s) {
  const env = rawEnv(s);
  if (!inTmux(s)) return env;
  const out = { ...env };
  for (const k of OUTER_IDS) delete out[k];
  return out;
}
const inTmux = (s) => rawEnv(s).TMUX_PANE !== undefined;
const str = (v) => (typeof v === 'string' ? v : '');
// No `..` segment, so a socket path can't climb out of where it claims to be.
const safePath = (p) => /^\/[A-Za-z0-9._/-]{1,250}$/.test(p) && !p.split('/').includes('..');

// ITERM_SESSION_ID is `w0t1p0:<UUID>`; the UUID is the session's `id` (its guid).
function itermUuid(s) {
  const m = /^w\d{1,4}t\d{1,4}p\d{1,4}:([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})$/i.exec(str(envOf(s).ITERM_SESSION_ID));
  return m ? m[1] : null;
}

function tty(s) {
  const t = str(s && s.terminal && s.terminal.tty);
  return /^\/dev\/ttys\d{1,4}$/.test(t) ? t : null;
}

function kittyWindow(s) {
  const v = str(envOf(s).KITTY_WINDOW_ID);
  return /^[1-9]\d{0,8}$/.test(v) ? v : null;
}

// Only a unix socket or a loopback port: the id is sent wherever this points.
function kittyListen(s) {
  const v = str(envOf(s).KITTY_LISTEN_ON);
  if (v.startsWith('unix:') && safePath(v.slice(5))) return v;
  const m = /^tcp:(localhost|127\.0\.0\.1):([1-9]\d{0,4})$/.exec(v);
  return m && Number(m[2]) <= 65535 ? v : null;
}

function weztermPane(s) {
  const v = str(envOf(s).WEZTERM_PANE);
  return /^\d{1,9}$/.test(v) ? v : null;
}

function tmuxPane(s) {
  const v = str(envOf(s).TMUX_PANE);
  return /^%\d{1,9}$/.test(v) ? v : null;
}

// TMUX is `<socket>,<server pid>,<session index>`.
function tmuxSocket(s) {
  const sock = str(envOf(s).TMUX).split(',')[0];
  return safePath(sock) ? sock : null;
}

function tmuxServerPid(s) {
  const pid = str(envOf(s).TMUX).split(',')[1] || '';
  return /^[1-9]\d{0,9}$/.test(pid) ? Number(pid) : null;
}

// Absolute, no control characters, no `..`; leading `/` also means `open`
// can never read it as an option.
const okPath = (c) => c.startsWith('/') && c.length <= 1000 && !/[\0-\x1f\x7f]/.test(c) && !c.split('/').includes('..');
// The folder the session started in (the terminal's own), which the
// session's live cwd can drift away from.
function launchCwd(s) {
  const c = str(s && s.terminal && s.terminal.cwd);
  return okPath(c) ? c : null;
}

// Which terminal the session runs in: the hook's recorded host app wins
// (TERM_PROGRAM is inherited by anything launched from a shell, and tmux
// replaces it); TERM_PROGRAM only when no host was recorded.
function hostIs(s, app, termProgram) {
  if (s && s.hostApp) return s.hostApp === app;
  return !!termProgram && str(envOf(s).TERM_PROGRAM).toLowerCase() === termProgram.toLowerCase();
}

module.exports = { hostIs, envOf, inTmux, itermUuid, tty, kittyWindow, kittyListen, weztermPane, tmuxPane, tmuxSocket, tmuxServerPid, launchCwd, safePath };
