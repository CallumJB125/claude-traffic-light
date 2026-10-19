'use strict';
// Main-side wiring for the widget's session hover cards and the smarter strip
// (wave 1, lane A). Two IPC channels, both widget-only:
//   widget:session-cards → the strip model (src/widget-strip.js sessionRows)
//                          with one card per row (src/session-card-view.js)
//   widget:pin-session   → remember one session as pinned (config
//                          `widgetPinnedSession`), or null to unpin
// Everything read here is local session metadata and the person's own usage
// record; nothing leaves the computer. // privacy-flow: widget-session-card
const Strip = require('./widget-strip.js');
const { sessionCard } = require('./session-card-view.js');

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const idOf = (v) => (typeof v === 'string' && ID.test(v) ? v : null);

/**
 * ipcMain: Electron's (or a fake with handle()). getSessions(): {sessions, teammates}
 * or a bare sessions array. getSpend(sessionId): {cost_usd, unpriced}|null, may be
 * async. config: {load(): object, save(partial)}. allowed(e): sender gate (default: all).
 * now(): clock for tests. → { cards(), pin(id), pinned() }
 */
function install({ ipcMain, getSessions = () => [], getSpend = () => null, config, allowed = () => true, now = Date.now, collapseAfter } = {}) {
  if (!config || typeof config.load !== 'function' || typeof config.save !== 'function') throw new Error('widget-cards-main: config {load, save} required');
  const pinned = () => idOf(config.load().widgetPinnedSession);

  async function cards() {
    let got;
    try { got = await getSessions(); } catch { got = []; }
    const sessions = Array.isArray(got) ? got : Array.isArray(got?.sessions) ? got.sessions : [];
    const teammates = Array.isArray(got?.teammates) ? got.teammates : [];
    const pinnedId = pinned();
    const model = Strip.sessionRows(sessions.map((s) => (s && idOf(s.sessionId) === pinnedId && pinnedId ? { ...s, pinned: true } : s)), { pinnedId, teammates, ...(collapseAfter ? { collapseAfter } : {}) });
    const at = now();
    const withCard = async (r) => {
      if (r.kind !== 'session') return r;
      let spend = null;
      if (!r.team && r.id) { try { spend = (await getSpend(r.id)) || null; } catch { spend = null; } }
      const card = sessionCard(r.session, { now: at, spend, teammate: r.team ? { name: r.name } : null });
      // The raw row stays in main; the card is what the renderer paints.
      const { session, ...rest } = r;
      return { ...rest, card };
    };
    return { rows: await Promise.all(model.rows.map(withCard)), team: await Promise.all(model.team.map(withCard)), pinnedId: model.pinnedId, collapsed: model.collapsed };
  }

  function pin(id) {
    const next = id === null || id === undefined ? null : idOf(id);
    if (id != null && !next) return { ok: false, pinned: pinned() };
    if (pinned() !== next) config.save({ widgetPinnedSession: next });
    return { ok: true, pinned: next };
  }

  ipcMain.handle('widget:session-cards', (e) => (allowed(e) ? cards() : null));
  ipcMain.handle('widget:pin-session', (e, id) => (allowed(e) ? pin(id) : { ok: false, pinned: null }));
  return { cards, pin, pinned };
}

module.exports = { install };
