// tmux: only a session with exactly one client attached is jumped to. The
// outer terminal tab that client is drawn in is found by its tty and focused
// first; the pane is selected only once that tab is found, because select-window
// changes what every client on the session shows. A session with no client
// (detached), several clients, or a client whose tab can't be found is left
// alone: tmux would otherwise pick the most recently used client, which is
// whichever tmux the user is in now.
const os = require('os');
const path = require('path');
const Ids = require('./ids.js');

const BINS = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/opt/local/bin/tmux', '/usr/bin/tmux', `${os.homedir()}/.nix-profile/bin/tmux`, '/run/current-system/sw/bin/tmux'];

// Only clients already showing the pane's session: a client on another
// session belongs to a different tab the user may be working in.
function sessionClients(listOut, sessionId) {
  return String(listOut || '').split('\n').map((line) => {
    const [tty, sid, activity] = line.split('\t');
    return { tty, sid, activity: Number(activity) || 0 };
  }).filter((c) => /^\/dev\/(ttys|pts\/)\d{1,4}$/.test(c.tty || '') && c.sid === sessionId);
}

// Copyable as is: the name is only quoted-safe characters, and the socket is
// named only when it isn't tmux's default.
function attachCommand(name, sock) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(name || '')) return undefined;
  return `tmux${path.basename(sock) === 'default' ? '' : ` -S ${sock}`} attach -t ${name}`;
}

module.exports = {
  id: 'tmux',
  app: null,
  needs: null,
  BINS,
  sessionClients,
  canHandle: (s, ctx) => !!(Ids.tmuxPane(s) && Ids.tmuxSocket(s) && ctx.which(BINS) && ctx.tmuxServerOk(Ids.tmuxSocket(s), Ids.tmuxServerPid(s))),
  async focus(s, ctx) {
    const { exec, which } = ctx;
    const log = ctx.log || (() => {});
    const pane = Ids.tmuxPane(s);
    const tmux = (...args) => exec(which(BINS), ['-S', Ids.tmuxSocket(s), ...args]);
    const sess = await tmux('display-message', '-p', '-t', pane, '#{session_id}\t#{session_name}');
    const [sessionId, name] = (sess.stdout || '').trim().split('\t');
    if (!sess.ok || !/^\$\d{1,9}$/.test(sessionId)) return { ok: false, reason: 'tmux pane not found' };
    const list = await tmux('list-clients', '-F', '#{client_tty}\t#{session_id}\t#{client_activity}');
    const clients = list.ok ? sessionClients(list.stdout, sessionId) : [];
    if (clients.length === 0) {
      log(`tmux ${pane}: left alone, no client is attached to its session`);
      return { ok: false, detached: true, command: attachCommand(name, Ids.tmuxSocket(s)), reason: 'tmux session has no attached client' };
    }
    if (clients.length > 1) {
      log(`tmux ${pane}: left alone, ${clients.length} clients show its session`);
      return { ok: false, reason: 'tmux session shown in several terminals; left alone' };
    }
    const client = clients[0];
    // The outer tab is found by tty alone: the tmux server's environment
    // (ITERM_SESSION_ID and friends) belongs to whichever tab started it.
    const outer = await ctx.focusOuter({ hostApp: s.hostApp, cwd: s.cwd, terminal: { tty: client.tty, env: {} } });
    if (!outer.ok) {
      log(`tmux ${pane}: left alone, tab of client ${client.tty} not found (${outer.reason || 'unknown'})`);
      return { ok: false, reason: `tmux client ${client.tty} left alone; ${outer.reason || 'outer terminal not found'}`, denied: outer.denied, needs: outer.needs };
    }
    await tmux('select-window', '-t', pane);
    const sel = await tmux('select-pane', '-t', pane);
    if (!sel.ok) return { ok: false, reason: 'tmux select-pane failed' };
    log(`tmux ${pane}: selected for client ${client.tty}`);
    return { ...outer, adapter: `tmux+${outer.adapter}` };
  },
};
