// Everything a focus adapter reads from a session file is untrusted: any
// process running as the user can write that file. Each value is checked
// against a strict pattern before it goes anywhere near a command line, and
// adapters pass it as an argv entry, never spliced into a shell string or a
// script's source.

const envOf = (s) => (s && s.terminal && typeof s.terminal === 'object' && s.terminal.env && typeof s.terminal.env === 'object' ? s.terminal.env : {});
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
  return /^tcp:(localhost|127\.0\.0\.1):[1-9]\d{0,4}$/.test(v) ? v : null;
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

// Absolute, no control characters, no `..`; leading `/` also means `open`
// can never read it as an option.
function cwd(s) {
  const c = str(s && s.cwd);
  return c.startsWith('/') && c.length <= 1000 && !/[\0-\x1f\x7f]/.test(c) && !c.split('/').includes('..') ? c : null;
}

// Which terminal the session runs in: the hook's recorded host app wins
// (TERM_PROGRAM is inherited by anything launched from a shell, and tmux
// replaces it); TERM_PROGRAM only when no host was recorded.
function hostIs(s, app, termProgram) {
  if (s && s.hostApp) return s.hostApp === app;
  return !!termProgram && str(envOf(s).TERM_PROGRAM).toLowerCase() === termProgram.toLowerCase();
}

module.exports = { hostIs, envOf, itermUuid, tty, kittyWindow, kittyListen, weztermPane, tmuxPane, tmuxSocket, cwd, safePath };
