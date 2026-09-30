// tmux: point the client at the pane (switch-client, select-window,
// select-pane on the pane's %id, against the session's own server socket),
// then focus the outer terminal tab that client is drawn in, found by the
// client's tty.
const Ids = require('./ids.js');

const BINS = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/opt/local/bin/tmux', '/usr/bin/tmux'];

// The client already on the pane's session, else the most recently active.
function pickClient(listOut, sessionId) {
  const clients = String(listOut || '').split('\n').map((line) => {
    const [tty, sid, activity] = line.split('\t');
    return { tty, sid, activity: Number(activity) || 0 };
  }).filter((c) => /^\/dev\/(ttys|pts\/)\d{1,4}$/.test(c.tty || ''));
  const byRecent = (a, b) => b.activity - a.activity;
  return clients.filter((c) => c.sid === sessionId).sort(byRecent)[0] || clients.sort(byRecent)[0] || null;
}

module.exports = {
  id: 'tmux',
  app: null,
  needs: null,
  BINS,
  pickClient,
  canHandle: (s, ctx) => !!(Ids.tmuxPane(s) && Ids.tmuxSocket(s) && ctx.which(BINS)),
  async focus(s, ctx) {
    const { exec, which } = ctx;
    const pane = Ids.tmuxPane(s);
    const tmux = (...args) => exec(which(BINS), ['-S', Ids.tmuxSocket(s), ...args]);
    const sess = await tmux('display-message', '-p', '-t', pane, '#{session_id}');
    const sessionId = (sess.stdout || '').trim();
    if (!sess.ok || !/^\$\d{1,9}$/.test(sessionId)) return { ok: false, reason: 'tmux pane not found' };
    const list = await tmux('list-clients', '-F', '#{client_tty}\t#{session_id}\t#{client_activity}');
    const client = list.ok ? pickClient(list.stdout, sessionId) : null;
    if (client && client.sid !== sessionId) await tmux('switch-client', '-c', client.tty, '-t', pane);
    await tmux('select-window', '-t', pane);
    const sel = await tmux('select-pane', '-t', pane);
    if (!sel.ok) return { ok: false, reason: 'tmux select-pane failed' };
    if (!client) return { ok: false, reason: 'tmux pane selected; no attached client' };
    // The outer tab is found by tty alone: the tmux server's environment
    // (ITERM_SESSION_ID and friends) belongs to whichever tab started it.
    const outer = await ctx.focusOuter({ hostApp: s.hostApp, cwd: s.cwd, terminal: { tty: client.tty, env: {} } });
    return outer.ok ? { ...outer, adapter: `tmux+${outer.adapter}` } : { ok: false, reason: `tmux pane selected; ${outer.reason || 'outer terminal not found'}`, denied: outer.denied, needs: outer.needs };
  },
};
