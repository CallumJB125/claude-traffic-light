// The click → tab decision, free of Electron so it can be tested directly.
// `focus` is focusSession, `activate` is the old activate-the-app jump.
const { ADAPTERS } = require('./index.js');
const Ids = require('./ids.js');
const ADOPT_MS = 2500;
// QoL1: how long the "is this session still running?" check may take before the note stays neutral.
const LIVENESS_MS = 1500;
// Terminals with no tab API: the app the hook recorded is brought forward by its bundle id (never the
// recorded string in a script), and the note says the tab could not be picked. No window is guessed at.
const OPEN_ONLY = Object.freeze({ Warp: 'dev.warp.Warp-Stable', Alacritty: 'org.alacritty' });
// An adapter that ran and found no tab for the session: its window is gone, or never was this app's.
const NOT_FOUND = new Set(['no match', 'not-running', 'matches: 0', 'no adapter for this terminal']);
const NOTE_ENDED = "This session has ended, so there's no terminal window to show.";
const NOTE_NO_WINDOW = "This session is still running, but Plexiform couldn't find its terminal window. It may have been closed.";
const NOTE_MAYBE_CLOSED = "Couldn't find this session's terminal window. It may have been closed.";
const base = (p) => String(p || '').split('/').filter(Boolean).pop() || 'that folder';

// A session reported from another machine: its host is a name the user typed
// and its ids describe that machine's terminals, so nothing here may act on
// it — not the adapters, and not activating a local app either.
const isRemote = (s) => !!(s && (s.remote || s.device || String(s.sessionId || '').startsWith('remote:')));

function hitResult(r, used) {
  const adapter = ADAPTERS.find((a) => a.id === String(r.adapter).split('+').pop());
  return { app: r.app || used.hostApp || (adapter && adapter.app) || 'terminal', exact: !!r.exact, ...(r.byFolder ? { byFolder: true } : {}) };
}

// `adopt(session)` may answer a copy of the session to focus instead: one
// Ghostty Dock lists under its exact id, though its hook recorded another
// app (src/terminal.js). It answers null to leave the session as it is.
// `liveness(session)` answers 'gone', 'alive' or 'unknown' (src/terminal.js); `openApp(bundleId)` true once opened.
function createJumper({ localHost, platform, focus, activate, explainer, adopt = null, liveness = null, openApp = null, log = () => {} }) {
  let current = null; // { key, gen, promise } of the jump in flight
  let gen = 0;

  // When the target can't be pinned down, the click must not change what the
  // user is looking at: no app is activated, a note says why instead.
  const NOTE_DETACHED = 'This session is running in tmux with no terminal window open.';
  const NOTE_UNKNOWN = "Can't tell which terminal window this session is in, so nothing was switched.";
  function cantJump(r, session) {
    if (r && r.sibling) return { app: null, exact: false, cant: "This session's windows are shown in another tmux session's tab." };
    if (r && r.selected) {
      const app = session && session.hostApp;
      return { app: null, exact: false, cant: `Switched the tmux window in its terminal. Bring ${app || 'it'} forward to see it.` };
    }
    if (r && r.detached) {
      return { app: null, exact: false, cant: `${NOTE_DETACHED} Run \`${r.command || 'tmux attach'}\` in a terminal.`, ...(r.command ? { command: r.command } : {}) };
    }
    return { app: null, exact: false, cant: NOTE_UNKNOWN };
  }

  async function aliveness(session) {
    if (!liveness) return 'unknown';
    let timer;
    try { return await Promise.race([liveness(session), new Promise((r) => { timer = setTimeout(() => r('unknown'), LIVENESS_MS); })]); } catch { return 'unknown'; } finally { clearTimeout(timer); }
  }

  // QoL1: every miss says plainly why. `r` is the last adapter's answer, or null when nothing was recorded.
  async function missed(r, session, stale) {
    if (r && (r.sibling || r.selected || r.detached)) return cantJump(r, session);
    if (r && r.ambiguous) {
      const app = String(r.adapter || '').startsWith('ghostty-dock') ? 'Ghostty Dock' : 'Ghostty';
      return { app: null, exact: false, cant: `There are ${r.ambiguous} ${app} tabs in ${base(Ids.launchCwd(session))}, so Plexiform didn't guess. Switch to it in ${app}.` };
    }
    const id = Object.hasOwn(OPEN_ONLY, session.hostApp) && !Ids.inTmux(session) ? OPEN_ONLY[session.hostApp] : null;
    if (id && openApp && (!r || r.reason === 'no adapter for this terminal')) {
      let opened = false;
      try { opened = await openApp(id); } catch { opened = false; }
      if (stale()) return null;
      if (opened) return { app: session.hostApp, exact: false, cant: `Opened ${session.hostApp}. Plexiform can't pick its tab.` };
    }
    if (r && !NOT_FOUND.has(r.reason)) return cantJump(r, session);
    const alive = await aliveness(session);
    if (stale()) return null;
    if (alive === 'gone') return { app: null, exact: false, cant: NOTE_ENDED };
    // Nothing recorded: where its window was was never known, so not "closed".
    if (!r) return cantJump(null, session);
    return { app: null, exact: false, cant: alive === 'alive' ? NOTE_NO_WINDOW : NOTE_MAYBE_CLOSED };
  }

  // Same shape as activate's answer: { app, exact } or null, or
  // { app: null, cant, command? } when nothing was switched. `stale()` turns
  // true once a click for another target has superseded this one.
  async function run(session, folderHint, preferApp, stale) {
    if (isRemote(session)) return null;
    // A pane dialog's session has no host: it is a pane on this Mac.
    const here = !!session && (!session.host || session.host === localHost);
    if (platform === 'darwin' && here) {
      let adopted = null;
      // Bounded, so a slow Dock costs a jump to another terminal at most this long.
      if (adopt) {
        let timer;
        try { adopted = await Promise.race([adopt(session), new Promise((r) => { timer = setTimeout(() => r(null), ADOPT_MS); })]); } catch (e) { log(`adopt failed: ${e.message}`); }
        clearTimeout(timer);
      }
      if (stale()) return null;
      const target = adopted || session;
      if (!target.terminal && !adopted) { log('no terminal recorded; nothing switched'); return stale() ? null : missed(null, session, stale); }
      if (adopted) log(`listed by ${adopted.hostApp}; trying it first`);
      const ctx = { onNeeds: (needs) => explainer.onNeeds(needs), isCancelled: stale, log };
      let used = target;
      let r = await focus(used, ctx);
      if (stale()) return null;
      if (adopted && !r.ok && session.terminal) {
        log(`${r.adapter || adopted.hostApp}: ${r.reason || 'failed'}; trying the recorded terminal`);
        used = session;
        r = await focus(used, ctx);
        if (stale()) return null;
      }
      if (r.ok) return hitResult(r, used);
      log(`${r.adapter || 'no adapter'}: ${r.reason || 'failed'}; nothing switched`);
      if (r.denied) explainer.onDenied(r.needs);
      return missed(r, session, stale);
    }
    if (platform === 'linux' && here) return runLinux(session, folderHint, preferApp, stale);
    return stale() ? null : activate(folderHint, preferApp);
  }

  // Linux: tmux's pane first (the adapters that answer for it), then the
  // terminal window by the tmux client's PID, then by window title. A session
  // inside tmux that tmux can't place is never guessed at by title.
  async function runLinux(session, folderHint, preferApp, stale) {
    let r = null;
    if (session && session.terminal) {
      const ctx = { onNeeds: (needs) => explainer.onNeeds(needs), isCancelled: stale, log };
      r = await focus(session, ctx);
      if (stale()) return null;
      if (r.ok) {
        // Kitty's and WezTerm's own focus calls don't raise the window on Linux.
        const raised = !/(^|\+)(kitty|wezterm)$/.test(String(r.adapter));
        const hit = hitResult(r, session);
        return raised ? hit : { ...hit, exact: false };
      }
      log(`${r.adapter || 'no adapter'}: ${r.reason || 'failed'}`);
      if (Ids.inTmux(session) && !r.selected) return cantJump(r, session);
    }
    // Only reached for a selected pane (the tmux adapter vetted its socket) or
    // a session with nothing recorded.
    const found = await activate(folderHint, preferApp, r && r.selected ? session : null, stale);
    if (stale()) return null;
    if (found && found.cant) return { app: null, exact: false, cant: found.cant };
    return found || cantJump(r, session);
  }

  // A repeat click on the same target shares the jump in flight. A click for
  // another target (the cycle hotkey pressed twice) starts its own jump and
  // supersedes the pending one: that one stops issuing commands and answers
  // null, so its caller never reports a tab the user was taken away from.
  return function jump(session, folderHint = '', preferApp = null) {
    const key = session && session.sessionId ? `session:${session.sessionId}` : `folder:${folderHint}`;
    if (current && current.key === key) return current.promise;
    const mine = ++gen;
    const stale = () => mine !== gen;
    const promise = run(session, folderHint, preferApp, stale)
      .catch((e) => { log(`failed: ${e.message}`); return null; })
      .then((r) => (stale() ? null : r))
      .finally(() => { if (current && current.gen === mine) current = null; });
    current = { key, gen: mine, promise };
    return promise;
  };
}

module.exports = { createJumper, isRemote, ADOPT_MS, LIVENESS_MS, OPEN_ONLY, NOTES: { NOTE_ENDED, NOTE_NO_WINDOW, NOTE_MAYBE_CLOSED } };
