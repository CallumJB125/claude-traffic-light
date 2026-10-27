'use strict';
// Home's task box (plan-orchestrator O4): main's side. The Home page sends folder handles and fixed shapes only; this
// file resolves them through the Tasks service (src/tasks-service.js) and keeps the effectful channels (run, stop)
// bound to the exact foreground Home document, the same pattern as src/tasks-main.js. Nothing here starts a task
// except compose:run, and compose:run is sent only by the page's Run button or ⌘↩ (Callum, 2026-10-24).
// Approvals and answers stay in Tasks: no channel here approves, denies or answers anything.
const crypto = require('crypto');
const path = require('path');
const CV = require('./compose-view.js');
const TV = require('./tasks-view.js');

const RUN_KEYS = ['text', 'folder', 'ai', 'permissionLevel', 'expectAi', 'requestId', 'peersKey', 'overrideBudget'];
const WORKTREE = /-buddy-[0-9a-f]{12}(?:[\\/]|$)/;

/** A fixed key for a preflight's peers: main compares its own, never the page's claim alone. */
function peersKeyOf(preflight) {
  const peers = Array.isArray(preflight?.peers) ? preflight.peers : [];
  return crypto.createHash('sha256').update(JSON.stringify(peers.map((p) => [p.id, p.state, p.branch, p.paths, p.uncertain]))).digest('hex').slice(0, 32);
}

/** What a row tells the card: no paths, no branch, no cost. */
function cardRow(t, activityMs = null) {
  if (!t) return null;
  return { state: t.state, label: String(t.label || '').slice(0, 60), reason: String(t.reason || '').slice(0, 300), ai: { id: t.ai?.id ?? null }, actions: Array.isArray(t.actions) ? t.actions.slice(0, 20) : [], stateSinceMs: t.stateSinceMs, lastActivityMs: [t.lastActivityMs, activityMs].filter(Number.isFinite).reduce((a, b) => Math.max(a, b), null) };
}

// Home's instance, as register(deps) has always wired it (plan-r2b-auth §2.2: these are the factory's defaults).
const HOME_COPY = Object.freeze({
  moved: 'Home changed while that was being checked. Nothing was started. Look again, then press Run.',
  focus: 'Focus Home and press Run again.',
  stopMoved: 'Home changed while stopping. Check the task in Tasks.',
});
const HOME_CHANNELS = Object.freeze({ info: 'compose:info', pickFolder: 'compose:pick-folder', route: 'compose:route', preflight: 'compose:preflight',
  run: 'compose:run', stop: 'compose:stop', openInTasks: 'compose:open-in-tasks' });
const HOME_PUSH = Object.freeze({ changed: 'compose:changed', event: 'compose:event', task: 'compose:task' });

/**
 * deps: { ipcMain, buddy() (buddyWin), service() (the Tasks service, started on use), config() (loadConfig),
 *         sessions() (local sessions), homeDir, isDir(p), muted(cwd), pickFolder(e) → path|null, openInTasks(id),
 *         shortcut() → the compose shortcut view, now?, log? }
 */
function register(deps) {
  return createCompose(deps);
}

/**
 * One task box bound to one page's document (redesign R2b-2: Home's and the new chat's). Every parameter defaults to
 * Home's; the new chat (main.js, chat-first preview only) passes its own:
 *   channels, push    the ipcMain names it registers and the pushes it sends (no `stop` → none registered; a missing
 *                     push name → that push is never sent)
 *   pageWc()          the page's webContents; docNow() {wcId, doc}; context() the buddy-window owner context
 *   copy              {moved, focus, stopMoved}; hidden() whether the box is switched off
 *   openCard          after a create, open the task for this document's card (Home) or not (the new chat: no card,
 *                     so no Tasks slot while it waits; review S1)
 *   oneAtATime        refuse a second run while one is in flight (BUSY), in main
 *   keepAlive         'live' (Home: while a task it started is live) or 'create' (the new chat: only until create returns)
 *   afterCreate       async ({id, wcId, current}) → true once main has moved to the new task's own page (S3 handoff);
 *                     the instance then retires, so the page left behind holds nothing
 *   settled(wcId)     after every run returns, so a document kept only for that run can go
 */
function createCompose(deps, params = {}) {
  const { ipcMain } = deps;
  const now = deps.now || Date.now;
  const svc = () => { const s = deps.service(); s.start?.(); return s; };
  const channels = params.channels || HOME_CHANNELS;
  const push = params.push || HOME_PUSH;
  const copy = params.copy || HOME_COPY;
  const openCard = params.openCard !== false;
  const keepAlive = params.keepAlive === 'create' ? 'create' : 'live';
  const hidden = params.hidden || (() => deps.config()?.homeComposer === false);
  let started = null; // {wcId, doc, ids: Set, last, title}: the tasks this document started
  let creating = 0; // runs in flight (keepAlive 'create', oneAtATime)

  const homeWc = params.pageWc ? () => { const wc = params.pageWc(); return wc && !wc.isDestroyed() ? wc : null; }
    : () => { const wc = deps.buddy()?.pageWebContents?.('home'); return wc && !wc.isDestroyed() ? wc : null; };
  const fromHome = (e) => { const wc = homeWc(); return !!wc && e?.sender === wc && e.senderFrame === wc.mainFrame; };
  // The page's document right now, selected or not: {wcId, doc} or null.
  const docNow = params.docNow || (() => deps.buddy()?.homeDocument?.() ?? null);
  const context = params.context || (() => deps.buddy()?.homeContext?.());
  const send = (wc, name, msg) => { if (!name || !wc) return; if (msg === undefined) wc.send(name); else wc.send(name, msg); };
  const mine = (wcId) => { const d = docNow(); return !!started && !!d && started.wcId === wcId && d.wcId === wcId && started.doc === d.doc; };
  function owner() {
    const c = context();
    if (!c?.foreground || !c.window || !c.contents || c.window.isDestroyed() || c.contents.isDestroyed() || !c.contents.mainFrame
      || !Number.isSafeInteger(c.generation) || !Number.isSafeInteger(c.document)) return null;
    return { window: c.window, contents: c.contents, frame: c.contents.mainFrame, generation: c.generation, document: c.document, account: c.account, workspace: c.workspace };
  }
  const same = (before) => { const after = owner(); return !!before && !!after && Object.keys(before).every((k) => before[k] === after[k]); };
  const refused = (code, text) => ({ ok: false, code, text: text ?? TV.errorText(code) });
  const MOVED = copy.moved;

  /** Finding 9: the most recent local session's project, never a task's worktree, ~ itself or a muted project. */
  async function defaultFolder() {
    const home = deps.homeDir ? path.resolve(deps.homeDir) : null;
    const rows = (deps.sessions() || []).filter((s) => s && typeof s.cwd === 'string' && path.isAbsolute(s.cwd) && !s.taskId && !WORKTREE.test(s.cwd)
      && path.resolve(s.cwd) !== home && !deps.muted?.(s.cwd))
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    for (const s of rows) if (await deps.isDir(s.cwd)) return s.cwd;
    return null;
  }

  function usable(a) { return !TV.aiOption(a).disabled; }

  ipcMain.handle(channels.info, async (e, ...args) => {
    if (!fromHome(e) || args.length) return null;
    if (hidden()) return { hidden: true };
    const s = svc();
    const snap = s.snapshot();
    const connected = snap?.conn?.status === 'connected';
    let info = null;
    try { info = await s.composerInfo(); } catch { info = null; }
    const dir = await defaultFolder().catch(() => null);
    const recent = Array.isArray(info?.recent) ? info.recent.slice(0, 5) : [];
    // One registerFolder call for the default (the handle pool is shared with Tasks); Tasks' recent ones already are.
    const folder = dir ? s.registerFolder(dir) : recent[0] ?? null;
    const ais = (Array.isArray(info?.ais) ? info.ais : []).filter((a) => a && CV.AI_NAME[a.id]).map((a) => ({ id: a.id, label: CV.AI_NAME[a.id], usable: usable(a) }));
    const d = docNow();
    const own = started && d && started.wcId === e.sender.id && started.doc === d.doc ? started : null;
    const row = own ? (snap.tasks || []).find((t) => t.id === own.last) : null;
    return { hidden: false, connected, ais, folder, recent, shortcut: deps.shortcut?.() ?? null,
      task: own ? { id: own.last, title: own.title, row: cardRow(row, own.activityAt) } : null };
  });

  ipcMain.handle(channels.pickFolder, async (e, ...args) => {
    if (!fromHome(e) || args.length || hidden()) return null;
    const dir = await deps.pickFolder(e);
    try { if (!dir || !path.isAbsolute(dir) || !(await deps.isDir(dir))) return null; } catch { return null; }
    return svc().registerFolder(dir);
  });

  ipcMain.handle(channels.route, async (e, ...args) => {
    if (!fromHome(e) || args.length !== 1 || hidden()) return refused('ILLEGAL_TRANSITION', '');
    return svc().route(args[0]);
  });

  ipcMain.handle(channels.preflight, async (e, ...args) => {
    if (!fromHome(e) || args.length !== 1 || hidden()) return refused('ILLEGAL_TRANSITION', '');
    const r = await svc().preflight(args[0]);
    return r?.ok ? { ok: true, preflight: { ...r.preflight, key: peersKeyOf(r.preflight) } } : r;
  });

  // The only channel that starts anything.
  ipcMain.handle(channels.run, async (e, ...args) => {
    const before = owner();
    if (!before || e.sender !== before.contents || e.senderFrame !== before.frame || args.length !== 1 || hidden()) return refused('ILLEGAL_TRANSITION', copy.focus);
    const req = args[0];
    if (!req || typeof req !== 'object' || Object.keys(req).some((k) => !RUN_KEYS.includes(k))) return refused('VALIDATION');
    if (params.oneAtATime === true && creating > 0) return refused('BUSY', 'Still starting the last one.');
    creating++;
    try { return await run(e, req, before); } finally {
      creating--;
      try { params.settled?.(e.sender.id); } catch { /* never blocks the answer */ }
    }
  });

  async function run(e, req, before) {
    const s = svc();
    // Finding 10 and R4: main checks the project's other work itself, right before create. A failed check refuses.
    let check;
    try { check = await s.preflight({ folder: req.folder }); } catch { check = null; }
    if (!same(before)) return refused('CONFLICT', MOVED);
    if (!check?.ok) return refused('CONFLICT', check?.text || 'Could not check other work in this project. Nothing was started. Try again.');
    if (check.preflight.peers.length && peersKeyOf(check.preflight) !== req.peersKey) {
      return { ok: false, code: 'PEERS_CHANGED', text: 'Other work in this project changed. Look at it again before starting.', preflight: { ...check.preflight, key: peersKeyOf(check.preflight) } };
    }
    const draft = { text: req.text, folder: req.folder, ai: req.ai, permissionLevel: req.permissionLevel, surface: 'background', when: 'now',
      ...(req.expectAi !== undefined ? { expectAi: req.expectAi } : {}), ...(typeof req.requestId === 'string' ? { requestId: req.requestId } : {}), overrideBudget: req.overrideBudget === true };
    const r = await s.create(draft, { wcId: e.sender.id, current: () => same(before) });
    if (!same(before)) return r?.ok ? { ok: false, code: 'STARTED_ELSEWHERE', id: r.id, text: "Started. It's in Tasks." } : refused('CONFLICT', MOVED);
    if (!r?.ok) return r;
    if (!started || started.wcId !== e.sender.id || started.doc !== before.document) started = { wcId: e.sender.id, doc: before.document, ids: new Set(), last: null, title: '' };
    started.ids.add(r.id); started.last = r.id; started.activityAt = now(); started.title = String(req.text).trim().slice(0, 200);
    if (params.afterCreate) {
      let moved = false;
      try { moved = (await params.afterCreate({ id: r.id, wcId: e.sender.id, current: () => same(before) })) === true; } catch { moved = false; }
      // S3 handoff: the task's own page has it now. Nothing stays behind for this document (review S1).
      if (moved) { retire(e.sender.id); return { ok: true, id: r.id, opened: true }; }
      if (!same(before)) return { ok: false, code: 'STARTED_ELSEWHERE', id: r.id, text: "Started. It's in Tasks." };
    }
    if (openCard) { try { await s.openTask(r.id, e.sender.id); } catch { /* the card still follows the list snapshot */ } }
    return { ok: true, id: r.id };
  }

  // Stop only: exactly {id, confirmed}, for a task this Home document started (review R6). Never another action.
  if (channels.stop) ipcMain.handle(channels.stop, async (e, ...args) => {
    const before = owner();
    if (!before || e.sender !== before.contents || e.senderFrame !== before.frame || args.length !== 1) return refused('ILLEGAL_TRANSITION', '');
    const req = args[0];
    if (!req || typeof req !== 'object' || Object.keys(req).sort().join() !== 'confirmed,id' || typeof req.id !== 'string' || typeof req.confirmed !== 'boolean') return refused('VALIDATION');
    const ours = () => same(before) && mine(e.sender.id) && before.document === started.doc && started.ids.has(req.id);
    if (!ours()) return refused('NOT_FOUND');
    const r = await svc().act({ id: req.id, action: 'stop', confirmed: req.confirmed }, e.sender.id, ours);
    if (!ours()) return refused('CONFLICT', copy.stopMoved);
    return r;
  });

  ipcMain.handle(channels.openInTasks, (e, ...args) => {
    if (!fromHome(e) || args.length !== 1 || typeof args[0] !== 'string' || !mine(e.sender.id) || !started.ids.has(args[0])) return false;
    return !!deps.openInTasks(args[0]);
  });

  /** The document retired (navigation, crash, destroyed, or the S3 handoff): its slot and its started set go with it (finding 3). */
  function retire(wcId) {
    if (keepAlive === 'create') {
      // The new chat: closeTask always, even with nothing started or with `started` left by an earlier document
      // (one that died mid-create), so no slot of this document's outlives it. Only this document's record is cleared.
      if (started && started.wcId === wcId) started = null;
      try { deps.service().closeTask(wcId); } catch { /* nothing open */ }
      return;
    }
    if (!started || started.wcId !== wcId) return;
    started = null;
    try { deps.service().closeTask(wcId); } catch { /* nothing open */ }
  }

  /** R1: Home stays alive only while a task it started is known and live. The new chat: only while a create is in flight. */
  function busy() {
    if (keepAlive === 'create') return creating > 0;
    if (!started) return false;
    const d = docNow();
    if (!d || d.wcId !== started.wcId || d.doc !== started.doc) return false;
    let snap;
    try { snap = deps.service().snapshot(); } catch { return false; }
    if (snap?.conn?.status !== 'connected') return false;
    return [...started.ids].some((id) => CV.isLive((snap.tasks || []).find((t) => t && t.id === id)?.state));
  }

  /** From the Tasks service's onEvent: true when the event was Home's (sent or dropped here). */
  function onEvent(wcId, id, event) {
    if (!started || wcId !== started.wcId) return false;
    if (!mine(wcId) || !started.ids.has(id)) return true;
    if (id === started.last) started.activityAt = now();
    const line = CV.eventLine(event);
    const wc = homeWc();
    if (line && wc && wc.id === wcId) send(wc, push.event, { id, line, at: started.activityAt });
    return true;
  }

  let lastRow = '', lastConn = null;
  function onChange(snap) {
    // The helper connecting or going away: Home asks for its info again (the box was offline, or is now).
    const conn = snap?.conn?.status ?? null;
    if (conn !== lastConn) { lastConn = conn; const wc = homeWc(); if (wc && !hidden()) { try { send(wc, push.changed); } catch { /* closed */ } } }
    if (!started || !push.task) return;
    const wc = homeWc();
    if (!wc || !mine(wc.id)) return;
    const found = (snap?.tasks || []).find((t) => t && t.id === started.last);
    const row = cardRow(found, started.activityAt);
    const msg = { id: started.last, row, connected: snap?.conn?.status === 'connected' };
    const json = JSON.stringify(msg);
    if (json === lastRow) return;
    lastRow = json;
    send(wc, push.task, msg);
  }

  return { retire, busy, onEvent, onChange, isHomeWc: (wcId) => homeWc()?.id === wcId, defaultFolder, _started: () => started, _now: now };
}

/**
 * The menu bar's New task… and the shortcut: focus Home's box, or with the box hidden the Tasks composer. Either only
 * shows an empty (or kept) draft; nothing starts until Run. deps: { ready() (the window can open), config(), openPage(id), buddy() }
 */
function openCompose(deps) {
  if (!deps.ready()) return false;
  if (deps.config()?.homeComposer === false) { deps.openPage('tasks'); return deps.buddy()?.tasksCompose?.() ?? false; }
  deps.openPage('home');
  return deps.buddy()?.focusComposer?.() ?? false;
}

module.exports = { register, createCompose, openCompose, peersKeyOf, cardRow, RUN_KEYS, HOME_CHANNELS, HOME_PUSH, HOME_COPY };
