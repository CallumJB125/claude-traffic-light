// Linux: bring the session's terminal window forward. wmctrl -a raises the
// first window whose title contains the text (X11, and XWayland windows),
// so the folder name is tried first, then common terminal names. Without
// wmctrl, or on pure Wayland, nothing is raised and the caller falls back.
const TITLES = ['Terminal', 'Konsole', 'Ghostty', 'kitty', 'Alacritty', 'WezTerm', 'Tilix', 'Terminator', 'xterm'];

const Ids = require('./focus/ids.js');

const NO_WMCTRL = "wmctrl isn't installed, so no terminal window can be raised. Install it (for example `sudo apt install wmctrl`).";
const NO_MATCH = "Couldn't find which terminal window this session is in, so nothing was raised.";

// The one tmux client showing the session's pane → its pid, else null.
async function tmuxClientPid(session, run) {
  const sock = Ids.tmuxSocket(session);
  const pane = Ids.tmuxPane(session);
  if (!sock || !pane) return null;
  const sess = await run('tmux', ['-S', sock, 'display-message', '-p', '-t', pane, '#{session_id}']);
  const sid = String(sess.stdout || '').trim();
  if (!sess.ok || !sid) return null;
  const list = await run('tmux', ['-S', sock, 'list-clients', '-F', '#{client_pid}\t#{session_id}']);
  const mine = String(list.stdout || '').split('\n').map((l) => l.split('\t')).filter(([pid, id]) => /^[1-9]\d{0,9}$/.test(pid) && id === sid);
  return list.ok && mine.length === 1 ? Number(mine[0][0]) : null;
}

// The pid and its parents, nearest first: the window belongs to the terminal
// emulator, which is some way above the tmux client.
async function ancestors(pid, run) {
  const out = [pid];
  while (out.length < 12) {
    const r = await run('ps', ['-o', 'ppid=', '-p', String(out[out.length - 1])]);
    const next = Number(String(r.stdout || '').trim());
    if (!r.ok || !Number.isInteger(next) || next <= 1 || out.includes(next)) break;
    out.push(next);
  }
  return out;
}

// `wmctrl -lp` lines: id, desktop, pid, host, title.
async function raiseByPid(pid, exec, run) {
  const list = await run('wmctrl', ['-lp']);
  if (!list.ok) return null;
  const windows = String(list.stdout || '').split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => /^0x[0-9a-f]+$/i.test(c[0] || '') && /^\d+$/.test(c[2] || ''));
  for (const pid2 of await ancestors(pid, run)) {
    const w = windows.find((c) => Number(c[2]) === pid2);
    if (w && await exec('wmctrl', ['-i', '-a', w[0]])) return { app: 'terminal', exact: true }; // privacy-flow: terminal-jump
  }
  return null;
}

// exec(file, args) → Promise<boolean> (exited 0, throws when the binary is
// missing); run(file, args) → Promise<{ ok, stdout }>. `session` is given
// when tmux has already selected its pane and only the window is left to find.
// → { app, exact } | { cant }
async function activate(folderHint, exec, session = null, run = null) {
  try {
    if (session && run) {
      const pid = await tmuxClientPid(session, run);
      const hit = pid && await raiseByPid(pid, exec, run);
      if (hit) return hit;
    }
    const tries = [folderHint, ...TITLES].filter(Boolean);
    for (const t of tries) {
      if (await exec('wmctrl', ['-a', t])) return { app: t, exact: t === folderHint }; // privacy-flow: terminal-jump
    }
  } catch { return { cant: NO_WMCTRL }; }
  return { cant: NO_MATCH };
}

module.exports = { activate, TITLES };
