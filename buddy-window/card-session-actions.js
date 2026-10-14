'use strict';
// The hub supplies only a card id. Main resolves the exact local session and
// rechecks the originating document after every await, including a save dialog.
const { keyOf, asPrompt } = require('../src/session-handover');
const valid = id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(id);
const unavailable = () => ({ ok: false, error: 'This local session is no longer available on this board.' });
function create({ bridge, capture, current, copy, save, choose, open }) {
  return async function act(event, action, cardId) {
    if (!valid(cardId) || !['refresh', 'copy', 'save', 'open'].includes(action)) return unavailable();
    const token = capture(event);
    if (!token) return unavailable();
    const fresh = () => current(token);
    if (action === 'open') {
      const session = await bridge.sessionForCard(cardId);
      if (!session || !fresh()) return unavailable();
      return { ok: open(keyOf(session.adapter, session.sessionId)) === true };
    }
    let doc = await bridge.localHandover(cardId, { refresh: action === 'refresh' });
    if (!doc?.markdown || !fresh()) return unavailable();
    if (action === 'refresh') return { ok: true, markdown: doc.markdown };
    if (action === 'copy') { copy(asPrompt(doc.markdown)); return { ok: true }; }
    const destination = await choose(token);
    if (!destination) return { ok: false, cancelled: true };
    if (!fresh()) return unavailable();
    // Sharing may have been revoked while the native dialog was open.
    doc = await bridge.localHandover(cardId);
    if (!doc?.markdown || !fresh()) return unavailable();
    await save(destination, doc.markdown);
    return { ok: true };
  };
}
module.exports = { create };
