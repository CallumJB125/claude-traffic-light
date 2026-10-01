// Main-process side of the Tasks page. Talks to the supervisor's control socket
// through board/tasks-api/client.js (which reads tasks.token itself), keeps a
// cache of sanitised tasks, and hands the page small, validated shapes. The
// renderer never sees the socket, the token or a filesystem path it could pass
// back. If the supervisor isn't there it retries with a capped backoff.
'use strict';

const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { createGuard, takeoverCommand } = require('./tasks-guard.js');
const TV = require('./tasks-view.js');

const API_DIR = path.join(__dirname, '..', 'board', 'tasks-api');
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const MAX_FOLDERS = 60;
const MAX_UNREAD_SCAN = 60;
const REPLAY_KEEP = 2500;

async function loadApi() {
  const [client, protocol, face] = await Promise.all(['client.js', 'protocol.js', 'face.js'].map((f) => import(pathToFileURL(path.join(API_DIR, f)).href))); // privacy-flow: tasks-local
  return { client, P: protocol, taskFace: face.taskFace };
}

// code → how the empty state explains itself
const OFFLINE = Object.freeze({
  SUPERVISOR_UNREACHABLE: { title: "Tasks run in the background helper, which isn't running yet.", hint: 'Plexiform starts it for you once the tasks engine is installed. This page connects by itself as soon as it is up.' },
  UNAUTHENTICATED: { title: "The background helper didn't accept this app's key.", hint: 'Restart the helper, then try again.' },
  FORBIDDEN: { title: "The helper's key file is not private to you.", hint: 'Make tasks.token readable by you only, then try again.' },
  PROTOCOL_UNSUPPORTED: { title: 'This app and the background helper are different versions.', hint: 'Update Plexiform and restart the helper.' },
  INTERNAL: { title: 'Tasks could not start in this version of Plexiform.', hint: 'Update Plexiform. If it keeps happening, send feedback from the tray menu.' },
});

/**
 * opts: boardHome, homeDir, loadApi (tests), onChange(snapshot), onEvent(taskId, event), copy(text), seen {load(), save(obj)}, now, log
 */
function createTasksService(opts) {
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const homeDir = opts.homeDir || '';
  let api = null;
  let guard = null;
  let client = null;
  let started = false;
  let stopped = false;
  let attempt = 0;
  let retryTimer = null;
  let tick = null;
  let conn = { status: 'connecting', code: null };
  const tasks = new Map();
  const unread = new Map();
  const seen = new Map(Object.entries(opts.seen?.load?.() || {}));
  const folders = new Map();
  const takeovers = new Map();
  let ais = null;
  let open = null; // { id, sub }
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

  async function refresh() {
    const list = await client.listTasks({});
    const next = new Map();
    for (const v of Array.isArray(list) ? list : []) {
      const t = guard.sanitizeTask(v, { now: now(), homeDir });
      if (t) next.set(t.id, t);
    }
    tasks.clear();
    for (const [id, t] of next) tasks.set(id, t);
    publish();
    scanUnread([...tasks.keys()].slice(0, MAX_UNREAD_SCAN)).catch(() => {});
  }

  // Inbound messages newer than the last one the person saw in that task's thread.
  async function scanUnread(ids) {
    for (const id of ids) {
      if (!connected()) return;
      if (open && open.id === id) continue;
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
      if (open && open.id === id) markSeen(id, e.seq);
      else { unread.set(id, (unread.get(id) || 0) + 1); publishSoon(); }
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
      c = await api.client.connect({ env: { ...process.env, BOARD_HOME: opts.boardHome }, client: { name: 'plexiform-tasks', version: '1' } });
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
    open = null;
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
    if (stopped || client) return;
    try { await connectOnce(); } catch (e) {
      client = null;
      setConn('offline', OFFLINE[e.code] ? e.code : (api ? 'SUPERVISOR_UNREACHABLE' : 'INTERNAL'));
      log('tasks: offline', e.code);
      schedule();
    }
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
    const c = client;
    client = null;
    try { c?.close(); } catch { /* already closed */ }
  }

  const failure = (e) => { const code = codeOf(e); return { ok: false, code, text: TV.errorText(code) }; };

  async function openTask(id) {
    if (!connected() || typeof id !== 'string' || id.length > 128) return { ok: false, ...failure({ code: 'SUPERVISOR_UNREACHABLE' }) };
    await closeTask();
    const mine = { id, sub: null };
    try {
      const raw = await client.getTask(id);
      const detail = guard.sanitizeDetail(raw, { now: now(), homeDir });
      if (!detail) return failure({ code: 'NOT_FOUND' });
      const replay = [];
      let live = false;
      const sub = await client.subscribe(id, { fromSeq: 1, onReset: () => { if (open === mine) opts.onEvent?.(id, { type: 'reset' }); } }, (ev) => {
        const s = guard.sanitizeEvent(ev, now());
        if (!s || (s.type === 'state' && !s.patch)) return;
        if (s.type === 'message' && s.direction === 'in' && s.from.kind !== 'human') markSeen(id, s.seq);
        if (live) opts.onEvent?.(id, s); else replay.push(s);
      });
      mine.sub = sub;
      open = mine;
      live = true;
      markSeen(id, Math.max(0, ...detail.messages.filter((m) => m.direction === 'in').map((m) => m.seq)));
      return { ok: true, detail, replay: replay.slice(-REPLAY_KEEP) };
    } catch (e) { return failure(e); }
  }

  async function closeTask() {
    const o = open;
    open = null;
    if (o?.sub) await o.sub.unsubscribe();
  }

  async function act(req) {
    if (!connected()) return failure({ code: 'SUPERVISOR_UNREACHABLE' });
    const v = guard.validateAct(req, tasks.get(req?.id));
    if (!v.ok) {
      if (v.code === 'ILLEGAL_TRANSITION') refresh().catch(() => {});
      return { ok: false, code: v.code, text: TV.errorText(v.code) };
    }
    try {
      const r = await client.act(v.id, v.action, v.payload);
      const t = guard.sanitizeTask(r.task, { now: now(), homeDir });
      if (t) { tasks.set(t.id, t); publishSoon(); }
      const out = { ok: true, task: t };
      if (v.action === 'takeover' && r.takeover) {
        takeovers.set(v.id, r.takeover);
        out.takeover = { command: takeoverCommand(r.takeover, { mask: true }), note: typeof r.takeover.note === 'string' ? r.takeover.note.slice(0, 300) : '' };
      }
      return out;
    } catch (e) {
      if (['ILLEGAL_TRANSITION', 'NOT_FOUND', 'ALREADY_ANSWERED', 'HUB_OWNED'].includes(e?.code)) refresh().catch(() => {});
      return failure(e);
    }
  }

  function copyTakeover(id) {
    const t = takeovers.get(id);
    if (!t) return false;
    opts.copy?.(takeoverCommand(t));
    return true;
  }

  async function create(draft) {
    if (!connected()) return failure({ code: 'SUPERVISOR_UNREACHABLE' });
    const cwd = folders.get(typeof draft?.folder === 'string' ? draft.folder : '');
    const v = guard.validateCreate(draft, cwd);
    if (!v.ok) return { ok: false, code: v.code, text: TV.errorText(v.code) };
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
    // Recent folders come from the supervisor's own tasks, so they are trusted paths.
    const seenRoots = new Set();
    const recent = [];
    for (const t of [...tasks.values()].sort((a, b) => b.createdAtMs - a.createdAtMs)) {
      if (t.hub || !t.where || seenRoots.has(t.where)) continue;
      seenRoots.add(t.where);
      recent.push(registerFolder(t.where.startsWith('~') ? homeDir + t.where.slice(1) : t.where));
      if (recent.length >= 5) break;
    }
    return { ais: ais || [], recent };
  }

  // Folder choices are handed to the page as opaque handles with a display label.
  function registerFolder(p) {
    const label = homeDir && p.startsWith(homeDir) ? `~${p.slice(homeDir.length)}` : p;
    for (const [h, v] of folders) if (v === p) return { handle: h, label };
    if (folders.size >= MAX_FOLDERS) folders.delete(folders.keys().next().value);
    const handle = crypto.randomUUID();
    folders.set(handle, p);
    return { handle, label };
  }

  return { start, stop, retryNow, snapshot, openTask, closeTask, act, copyTakeover, create, composerInfo, registerFolder, markSeen };
}

module.exports = { createTasksService, OFFLINE };
