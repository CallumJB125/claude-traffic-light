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

/**
 * deps: { ipcMain, buddy() (buddyWin), service() (the Tasks service, started on use), config() (loadConfig),
 *         sessions() (local sessions), homeDir, isDir(p), muted(cwd), pickFolder(e) → path|null, openInTasks(id),
 *         shortcut() → the compose shortcut view, now?, log? }
 */
function register(deps) {
  const { ipcMain } = deps;
  const now = deps.now || Date.now;
  const svc = () => { const s = deps.service(); s.start?.(); return s; };
  const hidden = () => deps.config()?.homeComposer === false;
  let started = null; // {wcId, doc, ids: Set, last, title}: the tasks this Home document started

  const homeWc = () => { const wc = deps.buddy()?.pageWebContents?.('home'); return wc && !wc.isDestroyed() ? wc : null; };
  const fromHome = (e) => { const wc = homeWc(); return !!wc && e?.sender === wc && e.senderFrame === wc.mainFrame; };
  // The Home document right now, selected or not: {wcId, doc} or null.
  const docNow = () => deps.buddy()?.homeDocument?.() ?? null;
  const mine = (wcId) => { const d = docNow(); return !!started && !!d && started.wcId === wcId && d.wcId === wcId && started.doc === d.doc; };
  function owner() {
    const c = deps.buddy()?.homeContext?.();
    if (!c?.foreground || !c.window || !c.contents || c.window.isDestroyed() || c.contents.isDestroyed() || !c.contents.mainFrame
      || !Number.isSafeInteger(c.generation) || !Number.isSafeInteger(c.document)) return null;
    return { window: c.window, contents: c.contents, frame: c.contents.mainFrame, generation: c.generation, document: c.document, account: c.account, workspace: c.workspace };
  }
  const same = (before) => { const after = owner(); return !!before && !!after && Object.keys(before).every((k) => before[k] === after[k]); };
  const refused = (code, text) => ({ ok: false, code, text: text ?? TV.errorText(code) });
  const MOVED = 'Home changed while that was being checked. Nothing was started. Look again, then press Run.';

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

  ipcMain.handle('compose:info', async (e, ...args) => {
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

  ipcMain.handle('compose:pick-folder', async (e, ...args) => {
    if (!fromHome(e) || args.length || hidden()) return null;
    const dir = await deps.pickFolder(e);
    try { if (!dir || !path.isAbsolute(dir) || !(await deps.isDir(dir))) return null; } catch { return null; }
    return svc().registerFolder(dir);
  });

  ipcMain.handle('compose:route', async (e, ...args) => {
    if (!fromHome(e) || args.length !== 1 || hidden()) return refused('ILLEGAL_TRANSITION', '');
    return svc().route(args[0]);
  });

  ipcMain.handle('compose:preflight', async (e, ...args) => {
    if (!fromHome(e) || args.length !== 1 || hidden()) return refused('ILLEGAL_TRANSITION', '');
    const r = await svc().preflight(args[0]);
    return r?.ok ? { ok: true, preflight: { ...r.preflight, key: peersKeyOf(r.preflight) } } : r;
  });

  // The only channel that starts anything.
  ipcMain.handle('compose:run', async (e, ...args) => {
    const before = owner();
    if (!before || e.sender !== before.contents || e.senderFrame !== before.frame || args.length !== 1 || hidden()) return refused('ILLEGAL_TRANSITION', 'Focus Home and press Run again.');
    const req = args[0];
    if (!req || typeof req !== 'object' || Object.keys(req).some((k) => !RUN_KEYS.includes(k))) return refused('VALIDATION');
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
    try { await s.openTask(r.id, e.sender.id); } catch { /* the card still follows the list snapshot */ }
    return { ok: true, id: r.id };
  });

  // Stop only: exactly {id, confirmed}, for a task this Home document started (review R6). Never another action.
  ipcMain.handle('compose:stop', async (e, ...args) => {
    const before = owner();
    if (!before || e.sender !== before.contents || e.senderFrame !== before.frame || args.length !== 1) return refused('ILLEGAL_TRANSITION', '');
    const req = args[0];
    if (!req || typeof req !== 'object' || Object.keys(req).sort().join() !== 'confirmed,id' || typeof req.id !== 'string' || typeof req.confirmed !== 'boolean') return refused('VALIDATION');
    const ours = () => same(before) && mine(e.sender.id) && before.document === started.doc && started.ids.has(req.id);
    if (!ours()) return refused('NOT_FOUND');
    const r = await svc().act({ id: req.id, action: 'stop', confirmed: req.confirmed }, e.sender.id, ours);
    if (!ours()) return refused('CONFLICT', 'Home changed while stopping. Check the task in Tasks.');
    return r;
  });

  ipcMain.handle('compose:open-in-tasks', (e, ...args) => {
    if (!fromHome(e) || args.length !== 1 || typeof args[0] !== 'string' || !mine(e.sender.id) || !started.ids.has(args[0])) return false;
    return !!deps.openInTasks(args[0]);
  });

  /** Home's document retired (navigation, crash, destroyed): its slot and its started set go with it (finding 3). */
  function retire(wcId) {
    if (!started || started.wcId !== wcId) return;
    started = null;
    try { deps.service().closeTask(wcId); } catch { /* nothing open */ }
  }

  /** R1: Home stays alive only while a task it started is known and live. */
  function busy() {
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
    if (line && wc && wc.id === wcId) wc.send('compose:event', { id, line, at: started.activityAt });
    return true;
  }

  let lastRow = '', lastConn = null;
  function onChange(snap) {
    // The helper connecting or going away: Home asks for its info again (the box was offline, or is now).
    const conn = snap?.conn?.status ?? null;
    if (conn !== lastConn) { lastConn = conn; const wc = homeWc(); if (wc && !hidden()) { try { wc.send('compose:changed'); } catch { /* closed */ } } }
    if (!started) return;
    const wc = homeWc();
    if (!wc || !mine(wc.id)) return;
    const found = (snap?.tasks || []).find((t) => t && t.id === started.last);
    const row = cardRow(found, started.activityAt);
    const msg = { id: started.last, row, connected: snap?.conn?.status === 'connected' };
    const json = JSON.stringify(msg);
    if (json === lastRow) return;
    lastRow = json;
    wc.send('compose:task', msg);
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

module.exports = { register, openCompose, peersKeyOf, cardRow, RUN_KEYS };
