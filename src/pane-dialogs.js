// Dialogs no hook can see or answer: the startup "trust this folder?" and
// "new MCP servers found" screens (hooks are held back until the folder is
// trusted), and a permission TUI whose hook never reached the widget. For a
// session that has sat waiting with no pending hook event, the widget reads
// its tmux pane (capture-pane, read-only) and matches the text here.
//
// Read-only by construction: the only tmux command run is `capture-pane -p`.
// Nothing is ever typed into a pane. Only panes recorded for a known session
// (its SessionStart env) or a Buddy launch record are read, only on a tmux
// server that is really this user's (focus tmuxServerOk), and each pane at
// most once per minIntervalMs.
//
// Dialog strings are Claude Code 2.1.286's own (see test/fixtures/panes).
//
// DISPLAY ONLY. Pane text is whatever the session printed: the agent, a tool's
// output or a file it cat'ed can draw a fake "Do you want to …?" with fake
// numbered options. What classify() returns may be shown (as not answerable,
// "Open it" only) but must never choose, build or drive tmux send-keys or any
// other input to a pane. test/pane-dialogs.test.js guards this.
const Ids = require('./focus/ids.js');
const { reveal } = require('./request-view.js');

// Dialogs wrap inside their box, so words may be split across lines.
const words = (s) => s.split(' ').map((w) => w.replace(/[.?]/g, '\\$&')).join('\\s+');
const PATTERNS = [
  { dialog: 'trust-folder', title: 'Trust this folder?', re: new RegExp(`${words('Is this a project you created or one you trust?')}|${words('Do you trust the files in this folder?')}`, 'i') },
  { dialog: 'mcp-servers', title: 'New MCP servers found', re: new RegExp(`${words('New MCP server found in this project')}|${words('new MCP servers found in this project')}`, 'i') },
  { dialog: 'plan', title: 'Plan ready: approve?', re: new RegExp(words('ready to execute. Would you like to proceed?'), 'i') },
  { dialog: 'permission', title: 'Permission needed', re: /Do\s+you\s+want\s+to\s[^?]{1,160}\?/ },
];

const BOX = /[│┃║|╭╮╰╯─━═┌┐└┘╔╗╚╝]/g;
const OPTION = /^\s*(?:[❯›>]\s*)?(\d{1,2})\.\s+(.+?)\s*$/;
const TAIL_LINES = 40;

// Captured pane text → { dialog, title, text, options[] } or null.
function classify(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n').map((l) => l.replace(BOX, ' ').replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail = lines.slice(-TAIL_LINES);
  const joined = tail.join('\n');
  for (const p of PATTERNS) {
    // The LAST match: a live dialog is drawn at the bottom of the pane, and
    // an earlier question in the scrollback (possibly printed by the agent)
    // must not lend it its text or options.
    const all = [...joined.matchAll(new RegExp(p.re.source, `${p.re.flags.replace('g', '')}g`))];
    const m = all[all.length - 1];
    if (!m) continue;
    // The text is a few lines above the question plus the question; the
    // options are the numbered lines below it (a plan's own numbered steps
    // above the question are text, not options).
    const at = joined.slice(0, m.index).split('\n').length - 1;
    const options = [];
    let first = -1;
    tail.forEach((l, i) => {
      const o = i > at ? OPTION.exec(l) : null;
      if (!o || options.length >= 9) return;
      if (first < 0) first = i;
      options.push({ id: `opt-${o[1]}`, label: reveal(o[2].trim()).slice(0, 200) });
    });
    // …and never reaches back into an earlier dialog (its question or options).
    let from = Math.max(0, at - 6);
    const prev = all[all.length - 2];
    if (prev) {
      let edge = joined.slice(0, prev.index).split('\n').length - 1;
      for (let i = edge + 1; i < at; i += 1) if (OPTION.test(tail[i])) edge = i;
      from = Math.max(from, edge + 1);
    }
    const text = tail.slice(from, first < 0 ? at + 1 : first).map((l) => l.trim()).filter(Boolean);
    if (!options.length) continue;
    return { dialog: p.dialog, title: p.title, text: reveal(text.join('\n')).slice(0, 2000), options };
  }
  return null;
}

// Where to look: sessions waiting with no pending request for quietMs, and
// Buddy launches nobody has claimed after quietMs (a CLI stuck before its
// first hook). Each target is {key, pane, socket, serverPid, session?, launch?}.
const LOOK_SIGNALS = new Set(['permission-ask', 'session-start']);
function targetsOf({ sessions = [], pendingSessionIds = new Set(), launches = [], now = Date.now(), quietMs = 20000 }) {
  const out = [];
  for (const s of sessions) {
    if (!LOOK_SIGNALS.has(s.signal) || pendingSessionIds.has(s.sessionId)) continue;
    const since = Date.parse(s.signalSince || s.updatedAt || '');
    if (!since || now - since < quietMs) continue;
    const pane = Ids.tmuxPane(s);
    const socket = Ids.tmuxSocket(s);
    if (!pane || !socket) continue;
    out.push({ key: `${socket}|${pane}`, pane, socket, serverPid: Ids.tmuxServerPid(s), session: s });
  }
  for (const l of launches) {
    const t = l && l.tmux;
    if (!t || !/^%\d{1,9}$/.test(String(t.pane)) || typeof t.socket !== 'string' || !Ids.safePath(t.socket)) continue;
    if (now - Date.parse(l.createdAt || '') < quietMs) continue;
    out.push({ key: `${t.socket}|${t.pane}`, pane: t.pane, socket: t.socket, serverPid: Number(t.serverPid) || null, launch: l });
  }
  const seen = new Set();
  return out.filter((t) => !seen.has(t.key) && seen.add(t.key));
}

// exec(file, args) → Promise<{ok, stdout}> (src/focus exec); serverOk(sock,
// pid) → bool; tmuxBin: path to tmux or null.
function createDetector({ exec, serverOk, tmuxBin, minIntervalMs = 15000, maxPerScan = 4, quietMs = 20000 } = {}) {
  const cache = new Map(); // key → {at, found}
  async function capture(t) {
    if (!tmuxBin || !serverOk(t.socket, t.serverPid)) return null;
    const r = await exec(tmuxBin, ['-S', t.socket, 'capture-pane', '-p', '-J', '-t', t.pane]); // privacy-flow: tmux-capture
    return r && r.ok ? classify(r.stdout) : null;
  }
  // → PendingDialog[] {key, dialog, title, text, options, pane, sessionId|null, launchId|null, cwd, seenAt}
  async function scan(opts) {
    const now = opts.now || Date.now();
    const targets = targetsOf({ ...opts, now, quietMs });
    const live = new Set(targets.map((t) => t.key));
    for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
    let budget = maxPerScan;
    const out = [];
    for (const t of targets) {
      let c = cache.get(t.key);
      if ((!c || now - c.at >= minIntervalMs) && budget > 0) {
        budget -= 1;
        let found = null;
        try { found = await capture(t); } catch { found = null; }
        c = { at: now, found };
        cache.set(t.key, c);
      }
      if (c && c.found) {
        out.push({
          key: t.key, ...c.found, pane: t.pane,
          sessionId: t.session ? t.session.sessionId : null, host: t.session ? t.session.host || null : null,
          launchId: t.launch ? t.launch.launchId : null,
          cwd: (t.session && t.session.cwd) || (t.launch && t.launch.cwd) || null,
          // What the terminal jump needs to find the pane.
          jump: t.session || { cwd: t.launch.cwd, terminal: { env: { TMUX: `${t.socket},${t.serverPid || ''},0`, TMUX_PANE: t.pane } } },
          seenAt: new Date(c.at).toISOString(),
        });
      }
    }
    return out;
  }
  return { scan, cache };
}

module.exports = { PATTERNS, classify, targetsOf, createDetector };
