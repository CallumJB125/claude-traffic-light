// The click → tab decision, free of Electron so it can be tested directly.
// `focus` is focusSession, `activate` is the old activate-the-app jump.
const { ADAPTERS } = require('./index.js');

// A session reported from another machine: its host is a name the user typed
// and its ids describe that machine's terminals, so nothing here may act on
// it — not the adapters, and not activating a local app either.
const isRemote = (s) => !!(s && (s.remote || s.device || String(s.sessionId || '').startsWith('remote:')));

function createJumper({ localHost, platform, focus, activate, explainer, log = () => {} }) {
  let current = null; // { key, gen, promise } of the jump in flight
  let gen = 0;

  // When the target can't be pinned down, the click must not change what the
  // user is looking at: no app is activated, a note says why instead.
  const NOTE_DETACHED = 'This session is running in tmux with no terminal window open.';
  const NOTE_UNKNOWN = "Can't tell which terminal window this session is in, so nothing was switched.";
  function cantJump(r) {
    if (r && r.detached) {
      return { app: null, exact: false, cant: `${NOTE_DETACHED} Run \`${r.command || 'tmux attach'}\` in a terminal.`, ...(r.command ? { command: r.command } : {}) };
    }
    return { app: null, exact: false, cant: NOTE_UNKNOWN };
  }

  // Same shape as activate's answer: { app, exact } or null, or
  // { app: null, cant, command? } when nothing was switched. `stale()` turns
  // true once a click for another target has superseded this one.
  async function run(session, folderHint, preferApp, stale) {
    if (isRemote(session)) return null;
    // A pane dialog's session has no host: it is a pane on this Mac.
    const here = !!session && (!session.host || session.host === localHost);
    if (platform === 'darwin' && here) {
      if (!session.terminal) { log('no terminal recorded; nothing switched'); return stale() ? null : cantJump(null); }
      const r = await focus(session, { onNeeds: (needs) => explainer.onNeeds(needs), isCancelled: stale, log });
      if (stale()) return null;
      if (r.ok) {
        const adapter = ADAPTERS.find((a) => a.id === String(r.adapter).split('+').pop());
        return { app: r.app || session.hostApp || (adapter && adapter.app) || 'terminal', exact: !!r.exact };
      }
      log(`${r.adapter || 'no adapter'}: ${r.reason || 'failed'}; nothing switched`);
      if (r.denied) explainer.onDenied(r.needs);
      return cantJump(r);
    }
    return stale() ? null : activate(folderHint, preferApp);
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

module.exports = { createJumper, isRemote };
