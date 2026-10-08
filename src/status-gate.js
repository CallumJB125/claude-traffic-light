// Decides whether a status broadcast is worth running. A burst of hook writes
// (or the 4 s poll) usually recomputes the exact same status; re-running the
// broadcast for it costs a full fan-out to every window for nothing. A
// broadcast is still forced through every `forceMs`, because roaming, away
// recaps and notifications depend on time passing, not only on state changing.
function fingerprint(state) {
  return JSON.stringify(state, (k, v) => (k === 'cameoPhoto' && v && typeof v === 'object' ? v.rev : v));
}

function createStatusGate({ forceMs = 3500, now = Date.now } = {}) {
  let lastKey = null;
  let lastAt = 0;
  return {
    changed(state) {
      const key = fingerprint(state);
      return key !== lastKey || now() - lastAt >= forceMs;
    },
    mark(state) {
      lastKey = fingerprint(state);
      lastAt = now();
    },
    reset() { lastKey = null; lastAt = 0; },
  };
}

module.exports = { createStatusGate, fingerprint };
