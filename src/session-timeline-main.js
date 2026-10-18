'use strict';

// Main-process side of the session Timeline page and its "Export replay".
// The Sessions page sends a handover key, a board card's Handover tab a
// session main already resolved; the page itself only names a listed
// session. Everything is read on this computer. Export writes one file to a
// place the person picks in the save dialog: nothing is uploaded or hosted.

const fs = require('node:fs');
const path = require('node:path');
const Timeline = require('./session-timeline.js');
const Replay = require('./session-replay.js');
const SummaryShare = require('./summary-share.js');
const Transcripts = require('./handover-transcripts.js');
const SessionHandover = require('./session-handover.js');
const { rowsFrom } = require('./session-handover-main.js');

const KEY = /^[\w.-]{1,200}$/;
const LIST_MAX = 50;
const PROVIDER = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini', hermes: 'Hermes', cursor: 'Cursor' };
const keyOf = (r) => SessionHandover.keyOf(r.adapter, r.sessionId);

const defaultTransitions = (rootDir) => (sid) => require('../mcp-server.js').buddyRecentTransitions({ root: rootDir, limit: 500, session: sid }).transitions;
function defaultCheckpoints(rootDir) {
  let cps = null;
  return async (sid) => {
    cps = cps || require('./checkpoints.js').createCheckpoints({ rootDir, entitlements: require('./entitlements') });
    return (await cps.turns(sid)).turns;
  };
}

function register({ ipcMain, rootDir, home, user = null, hostname = null, writer = () => null, sessions = () => ({}), isExcluded = () => false, sessionsAllowed, pageAllowed, openPage, pageContents = () => null, dialog, BrowserWindow, downloads = () => home, transitions = defaultTransitions(rootDir), checkpointTurns = defaultCheckpoints(rootDir), locator = Transcripts.createLocator({ home }), now = Date.now, log = () => {} , shareSummary = null }) {
  let current = null, selectionVersion = 0;
  const documents = new WeakMap();

  const listed = () => {
    let rows = [];
    try { rows = rowsFrom({ ...(sessions() || {}), now: now() }); } catch { rows = []; }
    return rows.filter((r) => !isExcluded(r.cwd)).sort((a, b) => (b.lastActiveMs || 0) - (a.lastActiveMs || 0)).slice(0, LIST_MAX);
  };
  const rowFor = (key) => listed().find((r) => keyOf(r) === key) || (current && keyOf(current) === key ? current : null);

  async function timelineOf(row) {
    if (!row || isExcluded(row.cwd)) return null;
    let facts = null; try { facts = writer()?.facts?.(row.adapter, row.sessionId) ?? null; } catch { facts = null; }
    let file = null; try { file = locator.find(row.adapter, row.sessionId); } catch { file = null; }
    const cwd = row.cwd || facts?.cwd || '';
    if (isExcluded(cwd)) return null;
    let moves = []; try { moves = transitions(row.sessionId) || []; } catch { moves = []; }
    let turns = []; try { turns = (await checkpointTurns(row.sessionId)) || []; } catch { turns = []; }
    return Timeline.build({ adapter: row.adapter, sessionId: row.sessionId, cwd, branch: facts?.branch, state: row.state, facts, transcript: file ? Timeline.readTranscript(file, row.adapter) : null, transitions: moves, checkpoints: turns });
  }

  const choose = (key) => {
    // A named target must never fall back to whichever session is now first.
    const r = key == null ? current || listed()[0] || null : typeof key === 'string' && KEY.test(key) ? rowFor(key) : null;
    if (!r && key != null) { current = null; selectionVersion++; }
    if (r && (!current || keyOf(current) !== keyOf(r))) { current = r; selectionVersion++; }
    return r;
  };
  const guard = (e, row) => {
    const version = selectionVersion, sender = e.sender, frame = e.senderFrame;
    let document = documents.get(sender);
    if (!document) {
      document = { version: 0 }; documents.set(sender, document);
      for (const event of ['did-start-navigation', 'render-process-gone', 'destroyed']) sender?.on?.(event, () => { document.version++; });
    }
    const documentVersion = document.version;
    const processId = frame?.processId, routingId = frame?.routingId, url = frame?.url;
    return () => {
      try { return pageAllowed(e) && !sender?.isDestroyed?.() && !frame?.isDestroyed?.()
        && (!frame || (frame.processId === processId && frame.routingId === routingId && frame.url === url))
        && document.version === documentVersion && version === selectionVersion && row && current && keyOf(row) === keyOf(current) && !isExcluded(row.cwd); }
      catch { return false; }
    };
  };

  function show(row) {
    current = row; selectionVersion++;
    openPage('timeline');
    const wc = pageContents();
    if (wc && !wc.isDestroyed()) wc.send('timeline:changed');
    return true;
  }
  // A board card's Handover tab: { adapter, sessionId } main resolved from the card.
  function openSession(s) {
    if (!s || typeof s.sessionId !== 'string' || !KEY.test(s.sessionId) || typeof s.adapter !== 'string') return false;
    const key = SessionHandover.keyOf(s.adapter, s.sessionId);
    return show(rowFor(key) || { adapter: s.adapter, sessionId: s.sessionId, cwd: '', lastActiveMs: 0, state: null });
  }

  const label = (r) => `${PROVIDER[r.adapter] || r.adapter} · ${r.cwd ? path.basename(r.cwd) : r.sessionId.slice(0, 8)}`;
  const exportOf = async (row, includePrompts) => {
    const tl = await timelineOf(row);
    return tl && !isExcluded(tl.cwd) ? { ...Replay.exportReplay(tl, { includePrompts: includePrompts === true, home, user, hostname, now: now() }), cwd: tl.cwd } : null;
  };

  ipcMain.handle('timeline:open', (e, key) => {
    if (!sessionsAllowed(e) || typeof key !== 'string' || !KEY.test(key)) return false;
    const r = rowFor(key);
    return r ? show(r) : false;
  });
  ipcMain.handle('timeline:list', (e) => {
    if (!pageAllowed(e)) return null;
    const rows = listed();
    if (current && !isExcluded(current.cwd) && !rows.some((r) => keyOf(r) === keyOf(current))) rows.unshift(current);
    return { sessions: rows.map((r) => ({ key: keyOf(r), label: label(r) })), current: current ? keyOf(current) : rows[0] ? keyOf(rows[0]) : null };
  });
  ipcMain.handle('timeline:load', async (e, key) => {
    if (!pageAllowed(e)) return null;
    const row = choose(key);
    if (!row) return { empty: key == null ? 'No sessions are listed on this computer yet.' : 'This selected session is no longer available. Choose a session from the list.' };
    const valid = guard(e, row);
    const tl = await timelineOf(row);
    if (!valid() || (tl && isExcluded(tl.cwd))) return null;
    if (!tl) return { empty: 'This project is muted, so it has no timeline.' };
    const view = Timeline.forDisplay(tl, { home });
    return { key: keyOf(row), title: label(row), view: { ...view, events: view.events.map((ev) => ({ at: ev.at, kind: ev.kind, ...Timeline.describe(ev) })) } };
  });
  ipcMain.handle('timeline:preview', async (e, key, includePrompts) => {
    if (!pageAllowed(e)) return null;
    const row = choose(key), valid = guard(e, row);
    const out = await exportOf(row, includePrompts);
    return valid() && out && !isExcluded(out.cwd) ? out.summary : null;
  });
  // shareSummary: main-owned { shared(), send(payload), cardsFor(row), rootOf(cwd), author() }; absent = nothing is sent.
  ipcMain.handle('timeline:share-available', (e) => (pageAllowed(e) ? !!shareSummary : false));
  ipcMain.handle('timeline:share-summary', async (e, key) => {
    if (!pageAllowed(e)) return null;
    const row = choose(key), valid = guard(e, row);
    if (!row) return { ok: false, error: 'Choose a session first.' };
    if (!shareSummary) return { ok: false, error: 'No team hub is connected. Nothing was sent.' };
    const out = await exportOf(row, false);
    if (!out || !valid() || isExcluded(out.cwd)) return { ok: false, error: 'The selected session changed. Review its replay again.' };
    let root = null, cards = [];
    try { root = await shareSummary.rootOf(out.cwd); } catch { root = null; }
    try { cards = (await shareSummary.cardsFor(row)) || []; } catch { cards = []; }
    const bundle = SummaryShare.buildBundle({ replay: out, cards, session: { adapter: row.adapter, sessionId: row.sessionId, task: row.task || '', author: shareSummary.author?.() || 'You' }, home, user, now: now() });
    if (!valid()) return { ok: false, error: 'The selected session changed. Review its replay again.' };
    return SummaryShare.share({ root, bundle, shared: shareSummary.shared?.() || {}, send: shareSummary.send });
  });
  ipcMain.handle('timeline:export', async (e, key, includePrompts) => {
    if (!pageAllowed(e)) return null;
    const row = choose(key), valid = guard(e, row);
    const out = await exportOf(row, includePrompts);
    if (!out || !valid() || isExcluded(out.cwd)) return { ok: false, error: 'The selected session changed. Review its replay again.' };
    let dir = home; try { dir = downloads() || home; } catch { dir = home; }
    const pick = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender) ?? undefined, { title: 'Save session replay', buttonLabel: 'Save replay', defaultPath: path.join(dir, Replay.fileName(out.model)), filters: [{ name: 'Web page', extensions: ['html'] }] });
    if (pick.canceled || !pick.filePath) return { ok: false, cancelled: true };
    if (!valid() || isExcluded(out.cwd)) return { ok: false, error: 'The selected session changed. Review its replay again.' };
    try { fs.writeFileSync(pick.filePath, out.html, { mode: 0o600 }); } catch (err) { log('[timeline] export failed', err && err.code); return { ok: false, error: 'Could not save the file.' }; }
    return { ok: true, name: path.basename(pick.filePath) };
  });

  return { openSession, timelineOf, current: () => current };
}

module.exports = { register };
