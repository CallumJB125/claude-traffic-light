// Linux: bring the session's terminal window forward with wmctrl (X11, and
// XWayland windows). A tmux session is found by its client's terminal; any
// other session by window title, the folder name first, then common terminal
// names. When nothing can be raised, the answer is a { cant } in plain words.
const os = require('os');
const TITLES = ['Terminal', 'Konsole', 'Ghostty', 'kitty', 'Alacritty', 'WezTerm', 'Tilix', 'Terminator', 'xterm'];
const Ids = require('./focus/ids.js');

const NO_WMCTRL = "wmctrl isn't installed, so no terminal window can be raised. Install it (for example `sudo apt install wmctrl`).";
const NO_MATCH = "Couldn't find which terminal window this session is in, so nothing was raised.";
const WAYLAND = "On Wayland, Plexiform can't raise terminal windows yet, so nothing was raised.";
const NO_CLIENT = "Couldn't tell which terminal shows this tmux session, so nothing was raised.";
const NESTED = "This tmux session is reached through another tmux or over ssh, so Plexiform can't tell which window to raise.";
const NO_WINDOW = "This session's terminal has no window Plexiform can see, so nothing was raised.";
const SEVERAL = "This terminal has several windows open, so Plexiform can't tell which one to raise.";
const SLOW = 'Looking for the terminal window took too long, so nothing was raised.';
const LOOKUP_MS = 4000;
// Passed through on the way from the tmux client up to its terminal.
const TRANSIT = /^(-?(ba|z|da|k|fi|tc|c)?sh|su|sudo|login|script|env)$/;

// The one tmux client showing the session's pane → its pid, else null.
async function tmuxClientPid(session, tmux) {
  const sock = Ids.tmuxSocket(session);
  const pane = Ids.tmuxPane(session);
  if (!sock || !pane) return null;
  const sess = await tmux(['-S', sock, 'display-message', '-p', '-t', pane, '#{session_id}']);
  const sid = String(sess.stdout || '').trim();
  if (!sess.ok || !sid) return null;
  const list = await tmux(['-S', sock, 'list-clients', '-F', '#{client_pid}\t#{session_id}']);
  const mine = String(list.stdout || '').split('\n').map((l) => l.split('\t')).filter(([pid, id]) => /^[1-9]\d{0,9}$/.test(pid) && id === sid);
  return list.ok && mine.length === 1 ? Number(mine[0][0]) : null;
}

// One snapshot of the process table: pid → { ppid, comm }.
async function processTable(run) {
  const r = await run('ps', ['-e', '-o', 'pid=,ppid=,comm=']);
  const table = new Map();
  for (const line of String(r.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3].replace(/^.*\//, '') });
  }
  return r.ok ? table : null;
}

// From the tmux client up through shells and su/sudo/login to the first
// other process: the terminal. → { pid } | { cant }
function terminalOf(clientPid, table) {
  const seen = new Set([clientPid]);
  let at = table.get(clientPid);
  while (at && at.ppid > 1 && !seen.has(at.ppid)) {
    const pid = at.ppid;
    seen.add(pid);
    const up = table.get(pid);
    if (!up) return { cant: NO_WINDOW };
    if (TRANSIT.test(up.comm)) { at = up; continue; }
    if (/^(tmux|sshd)/.test(up.comm)) return { cant: NESTED };
    return { pid };
  }
  return { cant: NO_WINDOW };
}

// `wmctrl -lp` rows: id, desktop (-1 when sticky), pid, client machine (N/A
// when unset), then the title, which may hold runs of spaces and tabs.
function windowsOf(out, hostname) {
  const mine = new Set([hostname, hostname.split('.')[0]]);
  const rows = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(\S+)/i.exec(line);
    if (m && mine.has(m[4])) rows.push({ id: m[1], pid: Number(m[3]) });
  }
  return rows;
}

// exec(file, args) → Promise<boolean> (exited 0, throws when the binary is
// missing); run(file, args) → Promise<{ ok, stdout }>. `session` is given
// when tmux has already selected its pane and only the window is left to find:
// that is never guessed by title. → { app, exact } | { cant } | null (superseded)
// opts: isCancelled, tmuxBin (the vetted tmux), hostname, env, now.
async function activate(folderHint, exec, session = null, run = null, opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const deadline = now() + LOOKUP_MS;
  const cancelled = () => !!(opts.isCancelled && opts.isCancelled());
  const late = () => now() >= deadline;
  if (env.WAYLAND_DISPLAY && !env.DISPLAY) return { cant: WAYLAND };
  try {
    if (session && run) {
      if (!opts.tmuxBin) return { cant: NO_CLIENT };
      const step = (file, args) => (cancelled() || late() ? Promise.resolve({ ok: false, stdout: '' }) : run(file, args));
      const clientPid = await tmuxClientPid(session, (args) => step(opts.tmuxBin, args));
      const table = clientPid && await processTable(step);
      if (cancelled()) return null;
      if (!table) return { cant: late() ? SLOW : NO_CLIENT };
      const terminal = terminalOf(clientPid, table);
      if (terminal.cant) return terminal;
      const list = await step('wmctrl', ['-lp']);
      if (cancelled()) return null;
      if (list.missing) return { cant: NO_WMCTRL };
      if (!list.ok) return { cant: late() ? SLOW : NO_MATCH };
      const found = windowsOf(list.stdout, opts.hostname || os.hostname()).filter((w) => w.pid === terminal.pid);
      if (found.length === 0) return { cant: NO_WINDOW };
      if (found.length > 1) return { cant: SEVERAL };
      if (cancelled() || late()) return cancelled() ? null : { cant: SLOW };
      if (await exec('wmctrl', ['-i', '-a', found[0].id])) return { app: session.hostApp || 'terminal', exact: false }; // privacy-flow: terminal-jump
      return { cant: NO_MATCH };
    }
    const tries = [folderHint, ...TITLES].filter(Boolean);
    for (const t of tries) {
      if (cancelled()) return null;
      if (await exec('wmctrl', ['-a', t])) return { app: t, exact: t === folderHint }; // privacy-flow: terminal-jump
    }
  } catch { return { cant: NO_WMCTRL }; }
  return { cant: NO_MATCH };
}

module.exports = { activate, TITLES };
