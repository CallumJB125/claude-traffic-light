'use strict';

// Registers the Sessions page's board and launch actions (src/session-actions.js). Each handler
// checks its sender; the page sends only opaque handles, short text and booleans.

const SessionActions = require('./session-actions.js');

function register({ ipcMain, sessionsAllowed, sessions, bridge, capture, tasks, clipboard, pickFolder, openPage, pageExists }) {
  let actions = null, forBridge = null;
  const get = () => {
    const b = bridge();
    if (!b) return null;
    if (!actions || forBridge !== b) {
      forBridge = b;
      actions = SessionActions.create({
        sessions, repoOf: require('./work-capture.js').repoFor, rootOf: b.gitRoot, boards: b.boards, capture: { captureOnce: (r, k) => capture().captureOnce(r, k), routing: async (repos) => (await capture().captureRouting?.(repos)) ?? [], choose: async (repo, key) => (await capture().captureChoose?.(repo, key)) === true },
        links: b.links, tickets: b.tickets ?? null, captured: () => b.rows(), tasks, clipboard, pickFolder, openPage, pageExists,
      });
    }
    return actions;
  };
  const str = (v, n = 200) => typeof v === 'string' && v.length <= n;
  const gone = { ok: false, text: 'Plexiform is still starting. Try again in a moment.' };
  const handle = (channel, ok, run) => ipcMain.handle(channel, async (e, ...args) => {
    if (!sessionsAllowed(e)) return null;
    const a = get();
    if (!a) return gone;
    if (!ok(...args)) return { ok: false, text: 'That request was not understood.' };
    try { return await run(a, ...args); } catch { return { ok: false, text: 'Something went wrong. Try again.' }; }
  });
  handle('sessions:setup', () => true, (a) => a.setup());
  handle('sessions:pick-folder', () => true, (a) => a.chooseFolder());
  handle('sessions:link-repo', (o) => o && str(o.folder) && str(o.board), (a, o) => a.linkRepo({ folder: o.folder, board: o.board }));
  handle('sessions:link-from-session', (h) => str(h), (a, h) => a.linkFromSession(h));
  handle('sessions:start', (o) => o && str(o.folder) && str(o.ai, 20) && (o.prompt === undefined || str(o.prompt, 8000)), (a, o) => a.startSession(o));
  handle('sessions:make-card', (h, b) => str(h) && str(b), (a, h, b) => a.makeCard(h, b));
  handle('sessions:search-cards', (q) => str(q, 80), (a, q) => a.searchCards(q));
  handle('sessions:attach', (h, r) => str(h) && str(r), (a, h, r) => a.attach(h, r));
  handle('sessions:share', (h, on) => str(h) && typeof on === 'boolean', async (a, h, on) => ({ ok: await a.shareHandover(h, on) }));
  handle('sessions:ticket-draft', (h) => str(h), (a, h) => a.ticketDraft(h));
  handle('sessions:ticket-create', (r, t, d) => str(r, 100) && str(t, 200) && str(d, 8000), (a, r, t, d) => a.ticketCreate(r, t, d));
  handle('sessions:routing', () => true, (a) => a.routing());
  handle('sessions:route-choose', (r, k) => str(r, 300) && str(k, 100), (a, r, k) => a.routeChoose(r, k));
  handle('sessions:route-ask', (r, t) => str(r, 300) && str(t, 100), (a, r, t) => a.routeAsk(r, t));
  handle('sessions:route-link', (r, b) => str(r, 300) && str(b, 100), (a, r, b) => a.routeLink(r, b));
  handle('sessions:connect', () => true, async (a) => { a.connect(); return { ok: true }; });
  return { rowInfo: (row) => get()?.rowInfo(row) ?? null };
}

module.exports = { register };
