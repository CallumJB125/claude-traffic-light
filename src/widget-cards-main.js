'use strict';
// Main-side wiring for the widget's session hover cards and the smarter strip
// (wave 1, lane A). Two IPC channels, both widget-only:
//   widget:session-cards → the strip model (src/widget-strip.js sessionRows)
//                          with one card per row (src/session-card-view.js)
//   widget:pin-session   → remember one session as pinned (config
//                          `widgetPinnedSession`), or null to unpin
//   widget:card-help     → copy one stuck-help prompt (explain mode) by handle
//   widget:resume-nudges → acknowledge a burn: a "pause nudges" rule lets that
//                          session's nudges through again
//   widget:session-open  → {id, how}: that session's own terminal, or its folder in
//                          the file manager or editor (QoL2)
//   widget:session-copy-resume → {id}: copy the command that resumes an ended
//                          session. Only ever copied, never run (QoL2)
// Both QoL2 channels take only an id: main re-finds the row and uses its own fields.
// Cards also carry the latest explain recap and the project's deploy line.
// Everything read here is local session metadata and the person's own usage
// record; nothing leaves the computer. // privacy-flow: widget-session-card
const Strip = require('./widget-strip.js');
const { sessionCard, IDLE } = require('./session-card-view.js');
const Actions = require('./session-row-actions.js');

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const idOf = (v) => (typeof v === 'string' && ID.test(v) ? v : null);

/**
 * ipcMain: Electron's (or a fake with handle()). getSessions(): {sessions, teammates}
 * or a bare sessions array. getSpend(sessionId): {cost_usd, unpriced}|null, may be
 * async. config: {load(): object, save(partial)}. allowed(e): sender gate (default: all).
 * now(): clock for tests. → { cards(), pin(id), pinned() }
 */
/* getExplain(session) → card slice | null; getDeploy(cwd) → deploy row | null;
 * nudgesPaused(id) → bool; copyHelp(handle) → {ok}; resumeNudges(id) → {ok}. All optional.
 * QoL2: home, platform; liveness(row) → 'alive'|'gone'|'unknown' (bounded here); openSession(how, row) → {feedback}
 * for how 'terminal'|'finder'|'editor'; copyText(text). */
const HOW = new Set(['terminal', 'finder', 'editor']);
const LIVENESS_MS = 1500;
const ACTION_GAP_MS = 500;
const closed = (req, keys) => !!req && typeof req === 'object' && !Array.isArray(req) && Object.getPrototypeOf(req) === Object.prototype
  && Object.keys(req).length === keys.length && keys.every((k) => Object.hasOwn(req, k));
function install({ ipcMain, getSessions = () => [], getSpend = () => null, config, allowed = () => true, now = Date.now, collapseAfter,
  getExplain = () => null, getDeploy = () => null, nudgesPaused = () => false, copyHelp = () => ({ ok: false }), resumeNudges = () => ({ ok: false }),
  home = null, platform = process.platform, liveness = null, openSession = null, copyText = null } = {}) {
  if (!config || typeof config.load !== 'function' || typeof config.save !== 'function') throw new Error('widget-cards-main: config {load, save} required');
  const pinned = () => idOf(config.load().widgetPinnedSession);
  const sessionsOf = async () => {
    let got;
    try { got = await getSessions(); } catch { got = []; }
    return { got, sessions: Array.isArray(got) ? got : Array.isArray(got?.sessions) ? got.sessions : [] };
  };
  // Is the session still running? Bounded; anything but a clear answer is 'unknown'.
  async function aliveness(row) {
    if (typeof liveness !== 'function') return 'unknown';
    let timer;
    try { return await Promise.race([liveness(row), new Promise((r) => { timer = setTimeout(() => r('unknown'), LIVENESS_MS); })]); } catch { return 'unknown'; } finally { clearTimeout(timer); }
  }
  // Offered only for an idle session of your own that is not known to be running: resuming a running one would
  // start a second process on the same conversation.
  const resumable = async (row) => !!(row && !row.remote && IDLE.has(row.signal) && Actions.resumeCommand(row) && (await aliveness(row)) !== 'alive');

  async function cards() {
    const { got, sessions } = await sessionsOf();
    const teammates = Array.isArray(got?.teammates) ? got.teammates : [];
    const pinnedId = pinned();
    const model = Strip.sessionRows(sessions.map((s) => (s && idOf(s.sessionId) === pinnedId && pinnedId ? { ...s, pinned: true } : s)), { pinnedId, teammates, ...(collapseAfter ? { collapseAfter } : {}) });
    const at = now();
    const withCard = async (r) => {
      if (r.kind !== 'session') return r;
      let spend = null;
      if (!r.team && r.id) { try { spend = (await getSpend(r.id)) || null; } catch { spend = null; } }
      const own = !r.team && r.session;
      const quiet = (fn) => { try { return fn() || null; } catch { return null; } };
      const card = sessionCard(r.session, { now: at, spend, teammate: r.team ? { name: r.name } : null, home, platform,
        resumable: !!(own && copyText && (await resumable(r.session))),
        explain: own ? quiet(() => getExplain(r.session)) : null,
        deploy: own && typeof r.session.cwd === 'string' ? quiet(() => getDeploy(r.session.cwd)) : null,
        nudgesPaused: !!(own && r.id && quiet(() => nudgesPaused(r.id))) });
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

  // A session of your own on this computer, re-found by its id.
  async function ownRow(id) {
    const { sessions } = await sessionsOf();
    return sessions.find((s) => s && typeof s === 'object' && !s.remote && idOf(s.sessionId) === id) || null;
  }
  // One QoL2 action per sender every half second.
  const lastAction = new Map();
  function tooSoon(e) {
    const key = e && e.sender && e.sender.id != null ? e.sender.id : 0;
    const t = now();
    if (lastAction.has(key) && t - lastAction.get(key) < ACTION_GAP_MS) return true;
    lastAction.set(key, t);
    return false;
  }
  const GONE = { ok: false, feedback: "That session isn't listed any more." };

  async function open(req) {
    const row = await ownRow(req.id);
    if (!row || typeof openSession !== 'function') return GONE;
    const r = await openSession(req.how, row);
    return { ok: !!(r && r.ok !== false), feedback: r && typeof r.feedback === 'string' ? r.feedback : '' };
  }

  // Copies text only: no process is started here, whatever the row says.
  async function copyResume(req) {
    const row = await ownRow(req.id);
    if (!row || typeof copyText !== 'function') return GONE;
    const text = Actions.resumeCommand(row);
    if (!text) return { ok: false, feedback: "Plexiform can't make a resume command for this session." };
    if ((await aliveness(row)) === 'alive') return { ok: false, feedback: "It's still running. Open it instead." };
    copyText(text);
    return { ok: true, feedback: 'Copied the resume command.' };
  }

  ipcMain.handle('widget:session-cards', (e) => (allowed(e) ? cards() : null));
  ipcMain.handle('widget:session-open', (e, req) => (allowed(e) && closed(req, ['id', 'how']) && HOW.has(req.how) && idOf(req.id) && !tooSoon(e) ? open(req) : { ok: false, feedback: '' }));
  ipcMain.handle('widget:session-copy-resume', (e, req) => (allowed(e) && closed(req, ['id']) && idOf(req.id) && !tooSoon(e) ? copyResume(req) : { ok: false, feedback: '' }));
  ipcMain.handle('widget:pin-session', (e, id) => (allowed(e) ? pin(id) : { ok: false, pinned: null }));
  ipcMain.handle('widget:card-help', (e, h) => (allowed(e) && typeof h === 'string' && h.length <= 40 ? copyHelp(h) : { ok: false }));
  ipcMain.handle('widget:resume-nudges', (e, id) => (allowed(e) && idOf(id) ? resumeNudges(id) : { ok: false }));
  return { cards, pin, pinned, open, copyResume };
}

module.exports = { install };
