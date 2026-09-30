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

  // Same shape as activate's answer: { app, exact } or null. `stale()` turns
  // true once a click for another target has superseded this one.
  async function run(session, folderHint, preferApp, stale) {
    if (isRemote(session)) return null;
    if (platform === 'darwin' && session && session.terminal && session.host === localHost) {
      const r = await focus(session, { onNeeds: (needs) => explainer.onNeeds(needs), isCancelled: stale });
      if (stale()) return null;
      if (r.ok) {
        const adapter = ADAPTERS.find((a) => a.id === String(r.adapter).split('+').pop());
        return { app: r.app || session.hostApp || (adapter && adapter.app) || 'terminal', exact: !!r.exact };
      }
      log(`${r.adapter || 'no adapter'}: ${r.reason || 'failed'}; activating the app instead`);
      if (r.denied) explainer.onDenied(r.needs);
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
