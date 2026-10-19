// Agent mode's confirm step. A spoken "Plexiform, build …" becomes an offer the
// widget shows with Start and Cancel; only a Start click naming the current
// offer's id hands its text on, once. The text is main's copy, never the
// renderer's, and an offer expires.
const crypto = require('crypto');

const TTL_MS = 2 * 60 * 1000;

function create({ now = Date.now, newId = () => crypto.randomBytes(8).toString('hex'), ttlMs = TTL_MS } = {}) {
  let current = null;
  return {
    offer(task) {
      const text = String(task || '').trim().slice(0, 300);
      if (!text) return null;
      current = { id: newId(), text, at: now() };
      return { id: current.id, text };
    },
    // → the task text on a valid Start; null for cancel, stale ids and expiry.
    take(id, action) {
      const o = current;
      if (!o || typeof id !== 'string' || id !== o.id) return null;
      current = null;
      if (action !== 'start' || now() - o.at > ttlMs) return null;
      return o.text;
    },
    clear() { current = null; },
    get pending() { return current && now() - current.at <= ttlMs ? { id: current.id, text: current.text } : null; },
  };
}

module.exports = { create, TTL_MS };
