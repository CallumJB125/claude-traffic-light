// Main-process side of the Tasks page. Talks to the supervisor's control socket
// through board/tasks-api/client.js (which reads tasks.token itself), keeps a
// cache of sanitised tasks, and hands the page small, validated shapes. The
// renderer never sees the socket, the token or a filesystem path it could pass
// back. If the supervisor isn't there it retries with a capped backoff.
'use strict';

const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { createGuard, takeoverCommand, tilde } = require('./tasks-guard.js');
const TV = require('./tasks-view.js');

const API_DIR = path.join(__dirname, '..', 'board', 'tasks-api');
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const MAX_FOLDERS = 60;
const MAX_UNREAD_SCAN = 60;
const REPLAY_KEEP = 2500;
const TAKEOVER_TTL_MS = 10 * 60 * 1000;
const UNREAD_SCAN_MIN_MS = 4000;
const LOCAL_SOURCES = ['local', 'cli'];
const { isDirWithin: isDirDefault } = require('./bounded-io.js');

async function loadApi() {
  const [client, protocol, face] = await Promise.all(['client.js', 'protocol.js', 'face.js'].map((f) => import(pathToFileURL(path.join(API_DIR, f)).href))); // privacy-flow: tasks-local
  return { client, P: protocol, taskFace: face.taskFace };
}

// code → how the empty state explains itself
const OFFLINE = Object.freeze({
  SUPERVISOR_UNREACHABLE: { title: 'The Tasks background helper is unavailable.', hint: 'Plexiform starts it when you open Tasks and reconnects automatically. Try again if it is taking too long.' },
  UNAUTHENTICATED: { title: "The background helper didn't accept this app's key.", hint: 'Restart the helper, then try again.' },
  FORBIDDEN: { title: "The helper's key file is not private to you.", hint: 'Make tasks.token readable by you only, then try again.' },
  PROTOCOL_UNSUPPORTED: { title: 'This app and the background helper are different versions.', hint: 'Update Plexiform and restart the helper.' },
  INTERNAL: { title: 'Tasks could not start in this version of Plexiform.', hint: 'Update Plexiform. If it keeps happening, send feedback from the tray menu.' },
});

/**
 * opts: boardHome, homeDir, loadApi (tests), onChange(snapshot), onEvent(wcId, taskId, event), copy(text), seen {load(), save(obj)},
 * confirmDialog(info, wcId) → Promise<boolean> (a native dialog; the page's own confirmation never counts for it), isDir(path) → boolean or a Promise of one, resolveBin, now, log
 */
function createTasksService(opts) {
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const homeDir = opts.homeDir || '';
  let api = null;
  let guard = null;
  let client = null;
  let started = false;
  let connecting = false;
  let stopped = false;
  let attempt = 0;
  let retryTimer = null;
  let tick = null;
  let conn = { status: 'connecting', code: null };
  const tasks = new Map();
  const unread = new Map();
  const seen = new Map(Object.entries(opts.seen?.load?.() || {}));
  const folders = new Map();
  const roots = new Map();         // taskId → the supervisor's raw repo root (never rebuilt from a display label)
  const takeovers = new Map();     // taskId → { t, at }
  const relayed = new Map();       // taskId → { approvals: Map(id → {tool, inputSummary, hash}), asks: Set }
  const slots = new Map();         // webContents id → { id, sub, gen }: one open task per page
  let gen = 0;
  const isDir = opts.isDir || isDirDefault;
  const canSchedule = () => { try { return opts.canSchedule ? opts.canSchedule() === true : require('./entitlements.js').has('queue.windows'); } catch { return false; } };
  let ais = null;
  let lastJson = '';
  let publishTimer = null;

  const connected = () => conn.status === 'connected' && !!client;

  function snapshot() {
    if (!guard) {
      const off = conn.status === 'offline' ? OFFLINE[conn.code] || OFFLINE.SUPERVISOR_UNREACHABLE : null;
      return { conn: { status: conn.status, code: conn.code, title: off ? off.title : '', hint: off ? off.hint : '' }, tasks: [] };
    }
    const c = connected();
    const rows = [...tasks.values()].map((t) => ({ ...guard.withLease(t, { connected: c, leaseGreen: c && client.isGreen(t.id) }), unread: unread.get(t.id) || 0 }));
    const off = !c && (OFFLINE[conn.code] || OFFLINE.SUPERVISOR_UNREACHABLE);
    return { conn: { status: conn.status, code: conn.code, title: off ? off.title : '', hint: off ? off.hint : '' }, tasks: TV.sortTasks(rows) };
  }

  function publish({ force = false } = {}) {
    const snap = snapshot();
    // Ages are absolute and the page keeps its own clock, so an unchanged snapshot needs no message.
    const json = JSON.stringify(snap);
    if (!force && json === lastJson) return;
    lastJson = json;
    opts.onChange?.(snap);
  }
  function publishSoon() {
    if (publishTimer) return;
    publishTimer = setTimeout(() => { publishTimer = null; publish(); }, 40);
  }

  function setConn(status, code = null) { conn = { status, code }; publish({ force: true }); }

  function codeOf(e) {
    const code = e?.code;
    return api && api.P.ERRORS.includes(code) ? code : (e?.code === 'ENOENT' ? 'SUPERVISOR_UNREACHABLE' : 'INTERNAL');
  }

  let refreshing = null;
  let refreshQueued = false;
  // At most one refresh in flight and one queued behind it, however many events ask for one.
  function refresh() {
    if (refreshing) { refreshQueued = true; return refreshing; }
    refreshing = doRefresh().finally(() => {
      refreshing = null;
      if (refreshQueued) { refreshQueued = false; refresh().catch(() => {}); }
    });
    return refreshing;
  }
  async function doRefresh() {
    const list = await client.listTasks({});
    const next = new Map();
    for (const v of Array.isArray(list) ? list : []) {
      const t = guard.sanitizeTask(v, { now: now(), homeDir });
      if (t) { next.set(t.id, t); if (typeof v.repo?.root === 'string') roots.set(t.id, v.repo.root); }
    }
    tasks.clear();
    for (const [id, t] of next) tasks.set(id, t);
    publish();
    scanUnreadSoon();
  }

  let lastScan = 0;
  let scanTimer = null;
  function scanUnreadSoon() {
    if (scanTimer) return;
    const wait = Math.max(0, lastScan + UNREAD_SCAN_MIN_MS - now());
    scanTimer = setTimeout(() => {
      scanTimer = null; lastScan = now();
      scanUnread([...tasks.keys()].slice(0, MAX_UNREAD_SCAN)).catch(() => {});
    }, wait);
  }

  const isOpen = (id) => [...slots.values()].some((x) => x.id === id);

  // Inbound messages newer than the last one the person saw in that task's thread.
  async function scanUnread(ids) {
    for (const id of ids) {
      if (!connected()) return;
      if (isOpen(id)) continue;
      try {
        const after = seen.get(id) || 0;
        const msgs = await client.listMessages(id, after ? { afterSeq: after } : {});
        const n = (Array.isArray(msgs) ? msgs : []).filter((m) => m.direction === 'in' && m.from?.kind !== 'human').length;
        if (n !== (unread.get(id) || 0)) { unread.set(id, n); publishSoon(); }
      } catch { /* the task vanished or the link dropped: the next refresh retries */ }
    }
  }

  function onGlobalEvent(e) {
    const id = e.taskId;
    if (e.type === 'state') {
      const t = tasks.get(id);
      if (!t) { refresh().catch(() => {}); return; }
      tasks.set(id, guard.applyState(t, e, now()));
      publishSoon();
    } else if (e.type === 'cost') {
      const t = tasks.get(id);
      if (t) { tasks.set(id, { ...t, cost: { usd: Number.isFinite(e.usd) ? e.usd : t.cost.usd, budgetUsd: Number.isFinite(e.budgetUsd) ? e.budgetUsd : t.cost.budgetUsd } }); publishSoon(); }
    } else if (e.type === 'message' && e.direction === 'in' && e.from?.kind !== 'human') {
      if (isOpen(id)) markSeen(id, e.seq);
      else { unread.set(id, (unread.get(id) || 0) + 1); publishSoon(); }
    } else if (e.type === 'handover') {
      // A new packet changes the paused/recoverable row's version and reason.
      refresh().catch(() => {});
    }
  }

  function markSeen(id, seq) {
    if (seq && seq > (seen.get(id) || 0)) { seen.set(id, seq); opts.seen?.save?.(Object.fromEntries(seen)); }
    if (unread.get(id)) { unread.set(id, 0); publishSoon(); }
  }

  async function connectOnce() {
    if (!api) { api = await (opts.loadApi || loadApi)(); guard = createGuard({ P: api.P, taskFace: api.taskFace }); }
    setConn('connecting');
    let c;
    try {
      await opts.ensureSupervisor?.();
      if (stopped) return;
      c = await api.client.connect({ env: { ...process.env, BOARD_HOME: opts.boardHome }, client: { name: 'plexiform-tasks', version: '1' } });
      if (stopped) { c.close(); return; }
    } catch (e) {
      throw Object.assign(new Error('connect'), { code: codeOf(e) });
    }
    client = c;
    c.on('error', () => {});
    c.on('hb', () => publishSoon());
    c.on('reset', () => { refresh().catch(() => {}); });
    c.on('close', (err) => onClosed(err));
    try {
      await refresh();
      await c.subscribe('*', { onReset: () => { refresh().catch(() => {}); } }, onGlobalEvent);
    } catch (e) {
      c.close();
      throw Object.assign(new Error('setup'), { code: codeOf(e) });
    }
    attempt = 0;
    setConn('connected');
  }

  function onClosed(err) {
    if (client === null || stopped) return;
    client = null;
    slots.clear();
    setConn('offline', codeOf(err));
    schedule();
  }

  function schedule() {
    if (stopped || retryTimer) return;
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    retryTimer = setTimeout(() => { retryTimer = null; run(); }, wait);
  }

  async function run() {
    if (stopped || client || connecting) return;
    connecting = true;
    try { await connectOnce(); } catch (e) {
      client = null;
      setConn('offline', OFFLINE[e.code] ? e.code : (api ? 'SUPERVISOR_UNREACHABLE' : 'INTERNAL'));
      log('tasks: offline', e.code);
      schedule();
    } finally { connecting = false; }
  }

  function start() {
    if (started) return;
    started = true;
    tick = setInterval(() => { if (connected()) publish(); }, 2000);
    run();
  }

  function retryNow() {
    if (!started || stopped || client) return;
    clearTimeout(retryTimer);
    retryTimer = null;
    attempt = 0;
    run();
  }

  function stop() {
    stopped = true;
    clearInterval(tick);
    clearTimeout(retryTimer);
    clearTimeout(publishTimer);
    clearTimeout(scanTimer);
    const c = client;
    client = null;
    try { c?.close(); } catch { /* already closed */ }
  }

  const failure = (e) => { const code = codeOf(e); return { ok: false, code, text: TV.errorText(code) }; };

  const hashOf = (a) => crypto.createHash('sha256').update(`${a.tool}\0${a.inputSummary}`).digest('hex');
  // What the page was shown as answerable: act() refuses an approval or ask id main did not relay.
  function remember(detail) {
    relayed.set(detail.id, {
      approvals: new Map(detail.openApprovals.map((a) => [a.approvalId, { tool: a.tool, inputSummary: a.inputSummary, hash: hashOf(a) }])),
      asks: new Set(detail.openAsk ? [detail.openAsk.askId] : []),
    });
  }

  async function openTask(id, wcId = 0) {
    if (!connected() || typeof id !== 'string' || id.length > 128) return failure({ code: 'SUPERVISOR_UNREACHABLE' });
    await closeTask(wcId);
    const mine = { id, sub: null, gen: ++gen };
    slots.set(wcId, mine);
    const stale = () => slots.get(wcId) !== mine;
    try {
      const raw = await client.getTask(id);
      if (stale()) return failure({ code: 'NOT_FOUND' });
      const detail = guard.sanitizeDetail(raw, { now: now(), homeDir });
      if (!detail) { slots.delete(wcId); return failure({ code: 'NOT_FOUND' }); }
      if (typeof raw.repo?.root === 'string') roots.set(id, raw.repo.root);
      remember(detail);
      const replay = [];
      let live = false;
      const sub = await client.subscribe(id, { fromSeq: 1, onReset: () => { if (!stale()) opts.onEvent?.(wcId, id, { type: 'reset' }); } }, (ev) => {
        const s = guard.sanitizeEvent(ev, now());
        if (!s || (s.type === 'state' && !s.patch)) return;
        if (s.type === 'message' && s.direction === 'in' && s.from.kind !== 'human') markSeen(id, s.seq);
        if (s.type === 'state' || s.type === 'refresh') { if (live) refreshOpen(wcId, mine); if (s.type === 'refresh') return; }
        if (live) opts.onEvent?.(wcId, id, s); else replay.push(s);
      });
      if (stale()) { await sub.unsubscribe(); return failure({ code: 'NOT_FOUND' }); }
      mine.sub = sub;
      live = true;
      markSeen(id, Math.max(0, ...detail.messages.filter((m) => m.direction === 'in').map((m) => m.seq)));
      return { ok: true, detail, replay: replay.filter((e) => e.type !== 'refresh').slice(-REPLAY_KEEP) };
    } catch (e) { if (!stale()) slots.delete(wcId); return failure(e); }
  }

  // A prompt that changed (approval, ask, state) is re-fetched, so what is shown is never stale.
  const refreshingOpen = new Set();
  const pendingOpen = new Set();
  async function refreshOpen(wcId, mine) {
    if (refreshingOpen.has(mine)) { pendingOpen.add(mine); return; }
    refreshingOpen.add(mine);
    try {
      const raw = await client.getTask(mine.id);
      if (slots.get(wcId) !== mine) return;
      const detail = guard.sanitizeDetail(raw, { now: now(), homeDir });
      if (!detail) return;
      remember(detail);
      opts.onEvent?.(wcId, mine.id, { type: 'detail', detail });
    } catch { /* the next event retries */ } finally {
      refreshingOpen.delete(mine);
      if (pendingOpen.delete(mine) && slots.get(wcId) === mine && connected()) queueMicrotask(() => refreshOpen(wcId, mine));
    }
  }

  async function saveCheckpoint(req, wcId = 0) {
    if (!connected()) return failure({ code: 'SUPERVISOR_UNREACHABLE' });
    const v = guard.validateCheckpoint(req);
    if (!v.ok) return failure(v);
    const mine = slots.get(wcId);
    if (!mine || mine.id !== v.id) return failure({ code: 'NOT_FOUND' });
    try {
      const r = await client.saveCheckpoint(v.id, v.expectedVersion, v.data);
      if (!connected() || slots.get(wcId) !== mine) return failure({ code: 'NOT_FOUND' });
      const checkpoint = guard.sanitizeCheckpoint(r.checkpoint);
      if (!checkpoint) return failure({ code: 'INTERNAL' });
      refreshOpen(wcId, mine);
      return { ok: true, checkpoint };
    } catch (e) { return failure(e); }
  }

  async function closeTask(wcId = 0) {
    const o = slots.get(wcId);
    slots.delete(wcId);
    if (o?.sub) await o.sub.unsubscribe();
  }

  const NATIVE_LABEL = { discard: 'Discard', openPr: 'Open pull request', takeover: 'Take over in terminal', approve: 'Allow', deny: 'Deny' };
  // The wording main shows in its own dialog, from its own cached facts, never the page's.
  function dialogInfo(req, row, ctx) {
    const a = req.action === 'approve' ? ctx.approvals.get(req.payload?.approvalId) : null;
    const start = a?.tool === 'StartTask';
    const label = start ? 'Accept and start' : req.action === 'approve' ? 'Allow for this task' : NATIVE_LABEL[req.action];
    const lines = {
      discard: 'Its branch and worktree are deleted. This cannot be undone.',
      openPr: 'The helper pushes the branch to GitHub with your gh login and opens a pull request.',
      takeover: 'The background run stops and you carry on in your terminal. The copied command contains no secret.',
    };
    const detail = start
      ? `This task came from ${row.source}. It will run in ${row.where || 'its folder'} with ${TV.AI_NAME[row.ai.id] || 'an AI'} at permission level "${row.permissionLevel}".`
      : req.action === 'approve' ? `${a.tool} will be allowed without asking again for the rest of this task.` : lines[req.action] || '';
    return { action: req.action, label, title: row.title || 'Untitled task', where: row.where, ai: TV.AI_NAME[row.ai.id] || '', source: row.source, detail };
  }

  async function act(req, wcId = 0, current = () => true) {
    if (!connected()) return failure({ code: 'SUPERVISOR_UNREACHABLE' });
    const row = tasks.get(req?.id);
    const ctx = relayed.get(req?.id) || { approvals: new Map(), asks: new Set() };
    let v = guard.validateAct(req, row, ctx);
    if (!v.ok && v.native) {
      let yes = false;
      try { yes = !!(await opts.confirmDialog?.(dialogInfo(req, row, ctx), wcId)); } catch { yes = false; }
      if (!yes) return { ok: false, code: 'CONFIRM_REQUIRED', text: '', cancelled: true };
      if (!connected()) return failure({ code: 'SUPERVISOR_UNREACHABLE' });
      v = guard.validateAct(req, tasks.get(req.id), { ...(relayed.get(req.id) || ctx), nativeConfirmed: true });
    }
    if (!v.ok) {
      if (v.code === 'ILLEGAL_TRANSITION') refresh().catch(() => {});
      return { ok: false, code: v.code, text: TV.errorText(v.code) };
    }
    try {
      if(current()!==true)return {ok:false,code:'ILLEGAL_TRANSITION',text:''};
      const r = await client.act(v.id, v.action, v.payload);
      const t = guard.sanitizeTask(r.task, { now: now(), homeDir });
      if (t) { tasks.set(t.id, t); publishSoon(); }
      const out = { ok: true, task: t };
      if (v.action === 'takeover' && r.takeover) {
        takeovers.set(v.id, { t: r.takeover, at: now() });
        out.takeover = { command: takeoverCommand(r.takeover, { mask: true, resolve: opts.resolveBin }), note: typeof r.takeover.note === 'string' ? r.takeover.note.slice(0, 300) : '' };
      }
      if (v.action === 'handback') takeovers.delete(v.id);
      return out;
    } catch (e) {
      if (['ILLEGAL_TRANSITION', 'NOT_FOUND', 'ALREADY_ANSWERED', 'HUB_OWNED'].includes(e?.code)) refresh().catch(() => {});
      return failure(e);
    }
  }

  // The copy is single-use and short-lived; it holds no secret (takeoverCommand drops them).
  function copyTakeover(id) {
    const e = takeovers.get(id);
    takeovers.delete(id);
    if (!e || now() - e.at > TAKEOVER_TTL_MS) return false;
    opts.copy?.(takeoverCommand(e.t, { resolve: opts.resolveBin }));
    return true;
  }

  async function create(draft) {
    if (!connected()) return failure({ code: 'SUPERVISOR_UNREACHABLE' });
    const cwd = folders.get(typeof draft?.folder === 'string' ? draft.folder : '');
    const v = guard.validateCreate(draft, cwd, { canSchedule: canSchedule() });
    if (!v.ok && v.code === 'PLAN_REQUIRED') return { ok: false, code: 'PLAN_REQUIRED', text: TV.errorText('PLAN_REQUIRED') };
    if (!v.ok || !(await isDir(cwd))) return { ok: false, code: 'VALIDATION', text: TV.errorText('VALIDATION') };
    try {
      const r = await client.createTask(v.spec, { requestId: typeof draft.requestId === 'string' && /^[\w-]{8,128}$/.test(draft.requestId) ? draft.requestId : undefined });
      refresh().catch(() => {});
      return { ok: true, id: r.id };
    } catch (e) { return failure(e); }
  }

  async function composerInfo() {
    if (connected()) {
      try { ais = guard.sanitizeAis(await client.detectAIs()); } catch { /* keep the last list */ }
    }
    // Recent folders come only from tasks started on this Mac (local, cli), by their raw root kept here.
    const seenRoots = new Set();
    const recent = [];
    for (const t of [...tasks.values()].sort((a, b) => b.createdAtMs - a.createdAtMs)) {
      const root = roots.get(t.id);
      if (t.hub || !LOCAL_SOURCES.includes(t.source) || !root || seenRoots.has(root) || !(await isDir(root))) continue;
      seenRoots.add(root);
      recent.push(registerFolder(root));
      if (recent.length >= 5) break;
    }
    return { ais: ais || [], recent, canSchedule: canSchedule() };
  }

  // Folder choices are handed to the page as opaque handles with a display label.
  function registerFolder(p) {
    const label = tilde(p, homeDir);
    for (const [h, v] of folders) if (v === p) return { handle: h, label };
    if (folders.size >= MAX_FOLDERS) folders.delete(folders.keys().next().value);
    const handle = crypto.randomUUID();
    folders.set(handle, p);
    return { handle, label };
  }

  return { start, stop, retryNow, snapshot, openTask, closeTask, act, saveCheckpoint, copyTakeover, create, composerInfo, registerFolder, markSeen };
}

module.exports = { createTasksService, OFFLINE };
