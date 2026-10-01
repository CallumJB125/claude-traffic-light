// tmux: only a session whose windows exactly one client shows (counting its
// whole session group) is jumped to, because select-window changes what every
// client on those windows shows. That client's
// outer tab is focused by tty when it can be found; the window and pane are
// selected either way. A session with no client (detached) or several is left
// alone: tmux would otherwise pick the most recently used client, which is
// whichever tmux the user is in now. Never switch-client, never another
// session's client.
const os = require('os');
const path = require('path');
const Ids = require('./ids.js');

const BINS = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/opt/local/bin/tmux', '/usr/bin/tmux', `${os.homedir()}/.nix-profile/bin/tmux`, '/run/current-system/sw/bin/tmux'];

// Clients that show the target's windows: its own session's, plus its whole
// session group's when it is grouped (grouped sessions share their windows, so
// a sibling's client sees every window change made here).
function viewers(listOut, sessionId, group) {
  return String(listOut || '').split('\n').map((line) => {
    const [tty, sid, activity, grp] = line.split('\t');
    return { tty, sid, activity: Number(activity) || 0, group: grp || '' };
  }).filter((c) => /^\/dev\/(ttys|pts\/)\d{1,4}$/.test(c.tty || '') && (c.sid === sessionId || (!!group && c.group === group)));
}

// Copyable as is: the name is only quoted-safe characters, and `-S` is left
// off only for the socket tmux itself would pick (a path merely named
// `default` somewhere else needs it).
function defaultSockets(env, uid) {
  const out = [`/private/tmp/tmux-${uid}/default`, `/tmp/tmux-${uid}/default`];
  if (env.TMUX_TMPDIR) out.push(`${String(env.TMUX_TMPDIR).replace(/\/+$/, '')}/tmux-${uid}/default`);
  return out;
}
function attachCommand(name, sock, env = process.env, uid = process.getuid()) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(name || '')) return undefined;
  return `tmux${defaultSockets(env, uid).includes(sock) ? '' : ` -S ${sock}`} attach -t ${name}`;
}

module.exports = {
  id: 'tmux',
  app: null,
  needs: null,
  BINS,
  viewers,
  attachCommand,
  canHandle: (s, ctx) => !!(Ids.tmuxPane(s) && Ids.tmuxSocket(s) && ctx.which(BINS) && ctx.tmuxServerOk(Ids.tmuxSocket(s), Ids.tmuxServerPid(s))),
  async focus(s, ctx) {
    const { exec, which } = ctx;
    const log = ctx.log || (() => {});
    const pane = Ids.tmuxPane(s);
    const tmux = (...args) => exec(which(BINS), ['-S', Ids.tmuxSocket(s), ...args]);
    const sess = await tmux('display-message', '-p', '-t', pane, '#{session_id}\t#{window_id}\t#{session_group}\t#{session_grouped}\t#{session_name}');
    const [sessionId, windowId, group, grouped, name] = (sess.stdout || '').trim().split('\t');
    if (!sess.ok || !/^\$\d{1,9}$/.test(sessionId) || !/^@\d{1,9}$/.test(windowId || '')) return { ok: false, reason: 'tmux pane not found' };
    const list = await tmux('list-clients', '-F', '#{client_tty}\t#{session_id}\t#{client_activity}\t#{session_group}');
    const clients = list.ok ? viewers(list.stdout, sessionId, grouped === '1' ? group : '') : [];
    if (clients.length === 0) {
      log(`tmux ${pane}: left alone, no client shows its session`);
      return { ok: false, detached: true, command: attachCommand(name, Ids.tmuxSocket(s), ctx.env, ctx.uid), reason: 'tmux session has no attached client' };
    }
    if (clients.length > 1) {
      log(`tmux ${pane}: left alone, ${clients.length} clients show its windows`);
      return { ok: false, reason: 'tmux windows shown in several terminals; left alone' };
    }
    if (clients[0].sid !== sessionId) {
      log(`tmux ${pane}: left alone, its windows are shown by a sibling session's client`);
      return { ok: false, sibling: true, reason: 'tmux windows shown in a grouped sibling session' };
    }
    const client = clients[0];
    // The outer tab is found by tty alone: the tmux server's environment
    // (ITERM_SESSION_ID and friends) belongs to whichever tab started it.
    const outer = await ctx.focusOuter({ hostApp: s.hostApp, cwd: s.cwd, terminal: { tty: client.tty, env: {} } });
    // The one client already shows this session, so selecting its window and
    // pane changes nobody else's view, whether or not its tab can be found.
    // Qualified by session and window id: a bare %N resolves against whichever
    // session tmux considers current, which in a group may be a sibling.
    await tmux('select-window', '-t', `${sessionId}:${windowId}`);
    const sel = await tmux('select-pane', '-t', `${sessionId}:${windowId}.${pane}`);
    if (!sel.ok) return { ok: false, reason: 'tmux select-pane failed' };
    if (outer.ok) {
      log(`tmux ${pane}: selected for client ${client.tty}`);
      return { ...outer, adapter: `tmux+${outer.adapter}` };
    }
    log(`tmux ${pane}: selected for client ${client.tty}; its tab not found (${outer.reason || 'unknown'}), no app activated`);
    return { ok: false, selected: true, reason: `tmux pane selected; ${outer.reason || 'outer terminal not found'}`, denied: outer.denied, needs: outer.needs };
  },
};
