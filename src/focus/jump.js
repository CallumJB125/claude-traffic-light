// The click → tab decision, free of Electron so it can be tested directly.
// `focus` is focusSession, `activate` is the old activate-the-app jump.
const { ADAPTERS } = require('./index.js');

// A session reported from another machine: its host is a name the user typed
// and its ids describe that machine's terminals, so nothing here may act on
// it — not the adapters, and not activating a local app either.
const isRemote = (s) => !!(s && (s.remote || s.device || String(s.sessionId || '').startsWith('remote:')));

function createJumper({ localHost, platform, focus, activate, explainer, log = () => {} }) {
  let inflight = null;

  // Same shape as activate's answer: { app, exact } or null.
  async function run(session, folderHint, preferApp) {
    if (isRemote(session)) return null;
    if (platform === 'darwin' && session && session.terminal && session.host === localHost) {
      const r = await focus(session, { onNeeds: (needs) => explainer.onNeeds(needs) });
      if (r.ok) {
        const adapter = ADAPTERS.find((a) => a.id === String(r.adapter).split('+').pop());
        return { app: r.app || session.hostApp || (adapter && adapter.app) || 'terminal', exact: !!r.exact };
      }
      log(`${r.adapter || 'no adapter'}: ${r.reason || 'failed'}; activating the app instead`);
      if (r.denied) explainer.onDenied(r.needs);
    }
    return activate(folderHint, preferApp);
  }

  // One jump at a time: a double click, or a click while a slow jump is
  // still running, shares the jump in flight instead of racing it.
  return function jump(session, folderHint = '', preferApp = null) {
    if (inflight) return inflight;
    inflight = run(session, folderHint, preferApp).catch((e) => { log(`failed: ${e.message}`); return null; }).finally(() => { inflight = null; });
    return inflight;
  };
}

module.exports = { createJumper, isRemote };
