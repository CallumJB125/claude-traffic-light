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
  const terminalLaunches = new Map(); // Retire pending one-use command files before handback or shutdown.
  const terminalLaunching = new Set();
  const retireTerminal = id => { try { terminalLaunches.get(id)?.(); } catch { /* no repeat launch */ } terminalLaunches.delete(id); };
  const integrationReviews = new Map(); // opaque page handle -> exact helper review and selected document
  const providerReviews = new Map(); // reviewed source snapshot and exact next AI
  const pullRequestReviews = new Map(); // exact GitHub destination, text and source; opaque renderer handle
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

  function setConn(status, code = null) { if (status !== 'connected') { integrationReviews.clear(); providerReviews.clear(); pullRequestReviews.clear(); takeovers.clear(); for (const id of terminalLaunches.keys()) retireTerminal(id); } conn = { status, code }; publish({ force: true }); }

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
      if (e.state && e.state !== 'handed_over') { takeovers.delete(id); retireTerminal(id); }
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
    takeovers.clear();
    for (const id of terminalLaunches.keys()) retireTerminal(id);
    pullRequestReviews.clear();
    integrationReviews.clear();
    providerReviews.clear();
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
    for (const [id, value] of takeovers) if (value.wcId === wcId) takeovers.delete(id);
    for (const [key, value] of pullRequestReviews) if (value.wcId === wcId) pullRequestReviews.delete(key);
    for (const [key, value] of integrationReviews) if (value.wcId === wcId) integrationReviews.delete(key);
    for (const [key, value] of providerReviews) if (value.wcId === wcId) providerReviews.delete(key);
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
      openPr: 'Creates a draft pull request for the exact reviewed, already published branch. Nothing is pushed.',
      takeover: 'The background run stops and you carry on in your terminal. The copied command contains no secret.',
    };
    const detail = start
      ? `This task came from ${row.source}. It will run in ${row.where || 'its folder'} with ${TV.AI_NAME[row.ai.id] || 'an AI'} at permission level "${row.permissionLevel}".`
      : req.action === 'approve' ? `${a.tool} will be allowed without asking again for the rest of this task.` : lines[req.action] || '';
    return { action: req.action, label, title: row.title || 'Untitled task', where: row.where, ai: TV.AI_NAME[row.ai.id] || '', source: row.source, detail };
  }

  async function act(req, wcId = 0, current = () => true) {
    if (req?.action === 'openPr') return pullRequest(req,wcId,current);
    if (req?.action === 'merge') return integrate(req, wcId, current);
    if (req?.action === 'switchAi') return switchProvider(req, wcId, current);
    if (!connected()) return failure({ code: 'SUPERVISOR_UNREACHABLE' });
    if (['handback', 'discard'].includes(req?.action) && terminalLaunching.has(req.id)) return failure({ code: 'SESSION_BUSY' });
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
      if (['handback', 'discard'].includes(v.action)) { takeovers.delete(v.id); retireTerminal(v.id); }
      const r = await client.act(v.id, v.action, v.payload);
      const t = guard.sanitizeTask(r.task, { now: now(), homeDir });
      if (t) { tasks.set(t.id, t); publishSoon(); }
      const out = { ok: true, task: t };
      if (v.action === 'takeover' && r.takeover) {
        const mine = slots.get(wcId);
        const canOpen = typeof opts.launchTerminal === 'function' && !!mine && mine.id === v.id && t?.state === 'handed_over' && !!t.repo && !t.workInPlace && !t.hub && ['claude', 'codex'].includes(t.ai.id) && t.cost.budgetUsd === null;
        takeovers.set(v.id, { t: r.takeover, at: now(), wcId, mine, current, channel: client, ai: t?.ai.id, permissionLevel: t?.permissionLevel, seq: t?.lastSeq, canOpen, busy: false });
        out.takeover = { command: takeoverCommand(r.takeover, { mask: true, resolve: opts.resolveBin }), canOpen, note: typeof r.takeover.note === 'string' ? r.takeover.note.slice(0, 300) : '' };
      }
      if (v.action === 'handback') takeovers.delete(v.id);
      return out;
    } catch (e) {
      if (['ILLEGAL_TRANSITION', 'NOT_FOUND', 'ALREADY_ANSWERED', 'HUB_OWNED'].includes(e?.code)) refresh().catch(() => {});
      return failure(e);
    }
  }

  async function pullRequest(req,wcId,current) {
    const mine=slots.get(wcId),row=tasks.get(req?.id),channel=client;
    const owner=()=>connected() && client===channel && slots.get(wcId)===mine && current()===true;
    const alive=()=>owner() && tasks.get(req.id)?.state==='in_review' && tasks.get(req.id)?.actions.includes('openPr');
    if (!req || Object.keys(req).some(k=>!['id','action','payload','confirmed'].includes(k)) || !mine || mine.id!==req.id || !row || !alive()) return failure({code:'ILLEGAL_TRANSITION'});
    const p=req.payload;
    if (!p || typeof p!=='object' || Array.isArray(p)) return failure({code:'VALIDATION'});
    let dispatched=false,reviewed=null;
    try {
      let result;
      if (p.phase==='preview') {
        if (Object.keys(p).some(k=>!['phase','title','body'].includes(k)) || typeof p.title!=='string' || p.title.length>120 || !p.title.trim() || typeof p.body!=='string' || p.body.length>10000) return failure({code:'VALIDATION'});
        for (const [key,r] of pullRequestReviews) if (r.wcId===wcId || r.expiresAt<=now()) pullRequestReviews.delete(key);
        result=await channel.act(req.id,'openPr',{phase:'preview',title:p.title,body:p.body});
        if (!alive()) return failure({code:'CONFLICT'});
        const r=result.pullRequest;
        if (r?.status==='unconfirmed') return {ok:true,pullRequest:{status:'unconfirmed',reason:'A creation was already attempted. Check the saved receipt; do not create a duplicate.'}};
        if (!r || r.status!=='review' || !/^[A-Za-z0-9][\w.-]{0,99}\/[A-Za-z0-9][\w.-]{0,99}$/.test(r.repo??'') || !/^[A-Za-z0-9-]{1,100}$/.test(r.account??'')
          || ![r.branch,r.base].every(v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\u0000-\u001f\u007f]/.test(v))
          || ![r.head,r.baseHead].every(v=>/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(v??'')) || typeof r.title!=='string' || r.title.length>120 || typeof r.body!=='string' || r.body.length>10500
          || typeof r.patch!=='string' || Buffer.byteLength(r.patch)>256*1024 || !/^[0-9a-f-]{36}$/.test(r.id??'') || !/^[0-9a-f]{64}$/.test(r.hash??'') || !Number.isSafeInteger(r.expiresAt) || r.expiresAt<=now() || r.expiresAt>now()+300000) return failure({code:'INTERNAL'});
        const handle=crypto.randomUUID();while(pullRequestReviews.size>=100)pullRequestReviews.delete(pullRequestReviews.keys().next().value);
        pullRequestReviews.set(handle,{...r,mine,channel,current,wcId,task:req.id});
        return {ok:true,pullRequest:{status:'review',review:handle,repo:r.repo,account:r.account,branch:r.branch,base:r.base,head:r.head,baseHead:r.baseHead,title:r.title,body:r.body,patch:r.patch,expiresAt:r.expiresAt}};
      }
      if (p.phase==='receipt' && Object.keys(p).length===1) result=await channel.act(req.id,'openPr',{phase:'receipt'});
      else {
        if (p.phase!=='apply' || Object.keys(p).length!==2 || typeof p.review!=='string') return failure({code:'VALIDATION'});
        const r=pullRequestReviews.get(p.review);pullRequestReviews.delete(p.review);
        if (!r || r.task!==req.id || r.wcId!==wcId || r.mine!==mine || r.channel!==channel || r.expiresAt<=now() || !r.current()) return failure({code:'CONFLICT'});
        reviewed=r;
        const yes=await opts.confirmDialog?.({action:'openPr',label:'Create draft pull request',title:r.title,where:row.where,
          detail:`Create this draft on GitHub as ${r.account}?\n${r.repo}: ${r.branch} → ${r.base}\nHead: ${r.head}\nBase: ${r.baseHead}\nNothing is pushed. Later commits to these branches change the pull request.\n\n${r.body}`},wcId);
        if (!yes) return {ok:false,cancelled:true,code:'CONFIRM_REQUIRED',text:''};
        if (!alive() || !r.current() || r.expiresAt<=now()) return failure({code:'CONFLICT'});
        dispatched=true;
        result=await channel.act(req.id,'openPr',{phase:'apply',reviewId:r.id,reviewHash:r.hash,confirm:true});
      }
      if (!owner() || reviewed && !reviewed.current()) return failure({code:'CONFLICT'});
      const r=result?.pullRequest;
      if (r?.status==='created' && Number.isSafeInteger(r.number) && r.number>0 && /^https:\/\/github\.com\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*\/pull\/[1-9][0-9]*$/.test(r.url??'')) {
        const detail=await channel.getTask(req.id);
        if (!owner() || reviewed && !reviewed.current()) return failure({code:'CONFLICT'});
        if (result.task?.id!==req.id || result.task?.state!=='done' || result.task?.outcome!=='pr_opened' || detail?.id!==req.id || detail?.pr?.url!==r.url || detail?.pr?.number!==r.number || reviewed && r.url!==`https://github.com/${reviewed.repo}/pull/${r.number}`) return failure({code:'INTERNAL'});
        const task=guard.sanitizeTask(result.task,{now:now(),homeDir});if(task){tasks.set(task.id,task);publishSoon();}
        return {ok:true,task,pullRequest:{status:'created',number:r.number,url:r.url,draft:r.draft===true,changed:r.changed===true}};
      }
      if (!alive()) return failure({code:'CONFLICT'});
      if (['refused','unconfirmed'].includes(r?.status)) return {ok:true,pullRequest:{status:r.status,reason:r.status==='refused'?'GitHub refused this draft. Check the account, branch and any existing pull request.':'The receipt is unconfirmed. Check its saved receipt or inspect GitHub; do not retry creation.'}};
      return failure({code:'INTERNAL'});
    } catch(e) {
      if (!owner()) return failure({code:'CONFLICT'});
      if (e?.details?.outcome==='unconfirmed' || dispatched && !['CONFLICT','POLICY_DENIED','VALIDATION'].includes(e?.code)) return {ok:true,pullRequest:{status:'unconfirmed',reason:'The receipt is unconfirmed. Check its saved receipt or inspect GitHub; do not retry creation.'}};
      return {ok:false,code:codeOf(e),text:e?.code==='POLICY_DENIED'?'Commit and publish the task branch, sign in to GitHub CLI, then review again. A standard github.com origin and a clean task worktree are required.':TV.errorText(codeOf(e))};
    }
  }

  async function switchProvider(req, wcId, current) {
    const mine = slots.get(wcId), channel = client, row = tasks.get(req?.id);
    const alive = () => connected() && client === channel && slots.get(wcId) === mine && current() === true
      && tasks.get(req.id)?.actions.includes('switchAi');
    if (!req || Object.keys(req).some(k => !['id', 'action', 'payload', 'confirmed'].includes(k)) || !mine || mine.id !== req.id || !row || !alive()) return failure({ code: 'ILLEGAL_TRANSITION' });
    const p = req.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return failure({ code: 'VALIDATION' });
    let dispatched = false;
    try {
      if ((p.phase === 'preview' && Object.keys(p).length === 2 || !p.phase && Object.keys(p).length === 1) && ['claude', 'codex'].includes(p.ai)) {
        for (const [key, value] of providerReviews) if (value.wcId === wcId || value.expiresAt <= now()) providerReviews.delete(key);
        const result = await channel.act(req.id, 'switchAi', { phase: 'preview', ai: p.ai });
        if (!alive()) return failure({ code: 'CONFLICT' });
        const r = result.providerChange;
        if (!r || r.status !== 'review' || !api.P.AIS.includes(r.from) || r.to !== p.ai || !['plan', 'ask', 'auto-edits', 'auto'].includes(r.permissionLevel)
          || typeof r.planFirst !== 'boolean' || !(r.budgetUsd === null || Number.isFinite(r.budgetUsd) && r.budgetUsd > 0)
          || !Number.isFinite(r.spentUsd) || r.spentUsd < 0 || !Number.isSafeInteger(r.contextVersion) || r.contextVersion < 1
          || typeof r.handover !== 'string' || Buffer.byteLength(r.handover) > 128 * 1024 || typeof r.branch !== 'string' || r.branch.length > 256
          || typeof r.messagesText !== 'string' || Buffer.byteLength(r.messagesText) > 64 * 1024
          || !Array.isArray(r.files) || r.files.length > 500 || r.files.some(f => !f || typeof f.path !== 'string' || f.path.length > 1024 || /[\u0000-\u001f\u007f]/.test(f.path) || !['A', 'M', 'D'].includes(f.status))
          || typeof r.patch !== 'string' || Buffer.byteLength(r.patch) > 256 * 1024 || !/^[0-9a-f-]{36}$/.test(r.id ?? '') || !/^[0-9a-f]{64}$/.test(r.hash ?? '')
          || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= now() || r.expiresAt > now() + 5 * 60_000) return failure({ code: 'INTERNAL' });
        const handle = crypto.randomUUID();
        while (providerReviews.size >= 100) providerReviews.delete(providerReviews.keys().next().value);
        providerReviews.set(handle, { id: req.id, wcId, mine, channel, current, helperId: r.id, hash: r.hash, expiresAt: r.expiresAt, from: r.from, to: r.to, contextVersion: r.contextVersion, permissionLevel: r.permissionLevel, budgetUsd: r.budgetUsd, spentUsd: r.spentUsd });
        return { ok: true, providerChange: { status: 'review', review: handle, from: r.from, to: r.to, permissionLevel: r.permissionLevel, planFirst: r.planFirst,
          budgetUsd: r.budgetUsd, spentUsd: r.spentUsd, contextVersion: r.contextVersion, handover: r.handover, messagesText: r.messagesText, branch: r.branch, files: r.files.map(f => ({ path: f.path, status: f.status })), patch: r.patch, expiresAt: r.expiresAt } };
      }
      if (p.phase !== 'apply' || Object.keys(p).length !== 2 || typeof p.review !== 'string') return failure({ code: 'VALIDATION' });
      const r = providerReviews.get(p.review); providerReviews.delete(p.review);
      if (!r || r.id !== req.id || r.wcId !== wcId || r.mine !== mine || r.channel !== channel || r.current() !== true || r.expiresAt <= now()) return failure({ code: 'CONFLICT' });
      const yes = await opts.confirmDialog?.({ action: 'switchAi', label: `Continue with ${TV.AI_NAME[r.to]}`, title: row.title || 'Untitled task', where: row.where,
        detail: `Start a new ${TV.AI_NAME[r.to]} session from the reviewed ${TV.AI_NAME[r.from]} task context v${r.contextVersion}?\nThe worktree and files are kept. Permission level stays ${r.permissionLevel}. The new AI uses its default model and must receive fresh plan approval when planning is required.\n${r.budgetUsd === null ? 'This task has no spend cap.' : `Task cap stays $${r.budgetUsd}; $${r.spentUsd} already spent.`}\nThe old conversation is not resumed by the new AI.\nReview: ${r.hash}` }, wcId);
      if (yes !== true) return { ok: false, code: 'CONFIRM_REQUIRED', text: '', cancelled: true };
      if (!alive() || r.expiresAt <= now()) return failure({ code: 'CONFLICT' });
      dispatched = true;
      const result = await channel.act(req.id, 'switchAi', { phase: 'apply', reviewId: r.helperId, reviewHash: r.hash, confirm: true });
      const task = guard.sanitizeTask(result.task, { now: now(), homeDir });
      if (task) { tasks.set(task.id, task); publishSoon(); }
      if (result.providerChange?.status !== 'queued' || result.providerChange.to !== r.to) throw Object.assign(new Error('unconfirmed'), { code: 'INTERNAL' });
      return { ok: true, task, providerChange: { status: 'queued', from: r.from, to: r.to, contextVersion: r.contextVersion } };
    } catch (e) {
      if (dispatched && ['TIMEOUT', 'SUPERVISOR_UNREACHABLE', 'INTERNAL'].includes(e?.code)) return { ok: false, code: 'CONFLICT', text: 'Provider handover receipt unconfirmed. Inspect this task before trying again; the new AI may already have started.' };
      if (e?.code === 'CONFLICT') return { ok: false, code: 'CONFLICT', text: 'The task files, context or provider changed. Your worktree is kept. Review the handover again.' };
      if (e?.code === 'POLICY_DENIED') return { ok: false, code: e.code, text: 'These files or repository settings need a manual provider handover. Your worktree is kept.' };
      return failure(e);
    }
  }

  // Integration is reviewed before any native confirmation. Renderer fields
  // never become Git refs, paths, helper review IDs or hashes.
  async function integrate(req, wcId, current) {
    const mine = slots.get(wcId), row = tasks.get(req?.id), channel = client;
    const alive = () => connected() && client === channel && slots.get(wcId) === mine && current() === true
      && tasks.get(req.id)?.state === 'in_review' && tasks.get(req.id)?.actions.includes('merge');
    if (!req || Object.keys(req).some(k => !['id', 'action', 'payload', 'confirmed'].includes(k)) || !mine || mine.id !== req.id || !row || !alive()) return failure({ code: 'ILLEGAL_TRANSITION' });
    const p = req.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return failure({ code: 'VALIDATION' });
    let dispatched = false;
    try {
      let result;
      if (p.phase === 'preview' && Object.keys(p).length === 1) {
        for (const [key, value] of integrationReviews) if (value.wcId === wcId || value.expiresAt <= now()) integrationReviews.delete(key);
        result = await channel.act(req.id, 'merge', { phase: 'preview' });
        if (!alive()) return failure({ code: 'CONFLICT' });
        const r = result.integration;
        if (!r || !['review', 'dirty', 'conflict', 'ownership', 'unchanged'].includes(r.status) || typeof r.branch !== 'string' || r.branch.length > 200
          || !Array.isArray(r.files) || r.files.length > 500 || r.files.some(f => !f || typeof f.path !== 'string' || f.path.length > 1024 || /[\u0000-\u001f\u007f]/.test(f.path) || !['A', 'M', 'D'].includes(f.status))
          || typeof r.patch !== 'string' || Buffer.byteLength(r.patch) > 256 * 1024) return failure({ code: 'INTERNAL' });
        const c = r.coordination;
        if (!c || c.scope !== 'local-tasks' || c.advisory !== true || !Number.isSafeInteger(c.decisionVersion) || c.decisionVersion < 0
          || !Number.isSafeInteger(c.observedClaims) || c.observedClaims < 0 || c.observedClaims > 500 || !Array.isArray(c.conflicts) || c.conflicts.length > c.observedClaims
          || c.conflicts.some(p => !p || !/^tsk_[0-9a-f]{12}$/.test(p.taskId ?? '') || !/^[a-z_]{1,30}$/.test(p.state ?? '')
            || !['destination-active', 'paths-unconfirmed', 'overlap'].includes(p.reason) || !Array.isArray(p.paths) || p.paths.length > 20
            || p.paths.some(v => typeof v !== 'string' || v.length > 1024 || /[\u0000-\u001f\u007f]/.test(v)))) return failure({ code: 'INTERNAL' });
        const canApply = r.status === 'review' && r.canApply === true && /^[0-9a-f-]{36}$/.test(r.id ?? '') && /^[0-9a-f]{64}$/.test(r.hash ?? '')
          && Number.isSafeInteger(r.expiresAt) && r.expiresAt > now() && r.expiresAt <= now() + 5 * 60_000;
        if (r.status === 'review' && (!canApply || c.conflicts.length) || r.status === 'ownership' && !c.conflicts.length) return failure({ code: 'INTERNAL' });
        const handle = canApply ? crypto.randomUUID() : null;
        if (handle) { while (integrationReviews.size >= 100) integrationReviews.delete(integrationReviews.keys().next().value); integrationReviews.set(handle, { id: req.id, wcId, mine, channel, current, helperId: r.id, hash: r.hash, expiresAt: r.expiresAt, branch: r.branch, count: r.files.length, decisionVersion: c.decisionVersion }); }
        const reason = { review: 'Creates a local merge commit. Nothing is pushed. The task worktree is kept.', dirty: 'Your checkout has changes. Save or commit them first; Plexiform has left them unchanged.', conflict: 'These changes conflict with your branch. Resolve them in the task worktree and review again.', ownership: 'Other local tasks may still change these paths. Inspect the tasks below and resolve the overlap or wait for them to finish, then review again.', unchanged: 'There are no new changes to integrate.' }[r.status];
        const coordination = { decisionVersion: c.decisionVersion, observedClaims: c.observedClaims, conflicts: c.conflicts.map(p => ({ taskId: p.taskId, title: tasks.get(p.taskId)?.title || p.taskId, state: p.state, reason: p.reason, paths: [...p.paths] })) };
        return { ok: true, integration: { status: r.status, canApply, review: handle, branch: r.branch, reason, coordination, files: r.files.map(f => ({ path: f.path, status: f.status })), patch: r.patch, expiresAt: canApply ? r.expiresAt : null } };
      }
      if (p.phase !== 'apply' || Object.keys(p).length !== 2 || typeof p.review !== 'string') return failure({ code: 'VALIDATION' });
      const r = integrationReviews.get(p.review); integrationReviews.delete(p.review);
      if (!r || r.id !== req.id || r.wcId !== wcId || r.mine !== mine || r.channel !== channel || r.expiresAt <= now() || r.current() !== true) return failure({ code: 'CONFLICT' });
      const yes = await opts.confirmDialog?.({ action: 'merge', label: 'Integrate reviewed changes', title: row.title || 'Untitled task', where: row.where,
        detail: `Integrate the ${r.count} reviewed file change${r.count === 1 ? '' : 's'} into ${r.branch}? This creates a local merge commit. Nothing is pushed. The task worktree is kept.\nTask context version: ${r.decisionVersion}\nReview: ${r.hash}` }, wcId);
      if (yes !== true) return { ok: false, code: 'CONFIRM_REQUIRED', text: '', cancelled: true };
      if (!alive() || r.expiresAt <= now()) return failure({ code: 'CONFLICT' });
      dispatched = true;
      result = await channel.act(req.id, 'merge', { phase: 'apply', reviewId: r.helperId, reviewHash: r.hash, confirm: true });
      const task = guard.sanitizeTask(result.task, { now: now(), homeDir });
      if (task) { tasks.set(task.id, task); publishSoon(); }
      if (result.integration?.status !== 'merged' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(result.integration.commit ?? '')) return failure({ code: 'CONFLICT' });
      return { ok: true, task, integration: { status: 'merged', branch: r.branch } };
    } catch (e) {
      if (e?.details?.outcome === 'unconfirmed' || dispatched && ['TIMEOUT', 'SUPERVISOR_UNREACHABLE', 'INTERNAL'].includes(e?.code)) return { ok: false, code: 'CONFLICT', text: 'Integration receipt unconfirmed. Inspect your branch before reviewing another integration; it may already have changed.' };
      if (e?.code === 'CONFLICT') return { ok: false, code: 'CONFLICT', text: 'The integration review changed or Git refused it. Your task worktree is kept. Inspect the task context, other active tasks and your checkout, then review again.' };
      if (e?.code === 'POLICY_DENIED') return { ok: false, code: e.code, text: 'This repository or change needs manual integration. The task worktree is kept; nothing was integrated.' };
      return failure(e);
    }
  }

  // The copy is single-use and short-lived; it holds no secret (takeoverCommand drops them).
  function copyTakeover(id) {
    const e = takeovers.get(id);
    if (e?.busy) return false;
    takeovers.delete(id);
    if (!e || now() - e.at > TAKEOVER_TTL_MS || !connected() || e.channel !== client || e.current() !== true) return false;
    opts.copy?.(takeoverCommand(e.t, { resolve: opts.resolveBin }));
    return true;
  }

  async function openTerminal(id, wcId = 0, current = () => true) {
    const e = takeovers.get(id), mine = slots.get(wcId);
    const alive = () => connected() && e?.channel === client && e.wcId === wcId && !!mine && e.mine === mine && slots.get(wcId) === mine
      && e.current() === true && current() === true && now() - e.at < TAKEOVER_TTL_MS && tasks.get(id)?.state === 'handed_over';
    if (!e?.canOpen || e.busy || !alive()) return failure({ code: 'CONFLICT' });
    e.busy = true;
    try {
      const row = tasks.get(id);
      const yes = await opts.confirmDialog?.({ action: 'openTerminal', label: 'Open in Terminal', title: row.title || 'Untitled task', where: row.where,
        detail: `Continue the same ${TV.AI_NAME[e.ai]} session in Terminal with its existing permissions. Exit it before choosing Hand back in Tasks. Opening Terminal does not confirm an AI response.\n\n${takeoverCommand(e.t, { mask: true, resolve: opts.resolveBin })}` }, wcId);
      if (yes !== true) return { ok: false, code: 'CONFIRM_REQUIRED', text: '', cancelled: true };
      if (!alive() || takeovers.get(id) !== e) return failure({ code: 'CONFLICT' });
      const raw = await e.channel.getTask(id);
      if (!alive() || raw.state !== 'handed_over' || raw.sessionId !== e.t.sessionId || raw.worktree !== e.t.cwd || raw.ai?.id !== e.ai
        || raw.lastSeq !== e.seq || raw.permissionLevel !== e.permissionLevel || raw.workInPlace || !raw.repo || raw.cost?.budgetUsd != null) return failure({ code: 'CONFLICT' });
      // Consume before the OS request. An uncertain response must never launch a duplicate.
      takeovers.delete(id);
      terminalLaunching.add(id);
      const result = await opts.launchTerminal(e.t, alive);
      if (typeof result?.cancelPending === 'function') terminalLaunches.set(id, result.cancelPending);
      if (!connected() || client !== e.channel || tasks.get(id)?.state !== 'handed_over') retireTerminal(id);
      // Terminal taking focus is expected after dispatch. The exact document is
      // checked by the launcher immediately before that request, not afterward.
      return result?.status === 'requested'
        ? { ok: true, status: 'requested', text: 'Terminal launch requested. Continue there, then exit the session and choose Hand back. Watch the session for its response.' }
        : { ok: false, code: 'CONFLICT', status: 'unconfirmed', text: 'Terminal launch could not be confirmed. Check Terminal before handing the task back; Plexiform will not launch it again automatically.' };
    } catch (error) { return failure(error); }
    finally { e.busy = false; terminalLaunching.delete(id); }
  }

  // extra.startAfter: main's own known reset time for a 'reset' task (Home's "Resume this at reset"); the page cannot set it.
  // extra.wcId: the page's webContents, for the native confirmation of a budget override.
  // extra.current: main's exact document/account/workspace guard; other main callers retain their existing API.
  async function create(draft, extra = {}) {
    if (!connected()) return failure({ code: 'SUPERVISOR_UNREACHABLE' });
    const channel = client, current = () => connected() && client === channel && (!extra.current || extra.current() === true);
    if (!current()) return failure({ code: 'CONFLICT' });
    const cwd = folders.get(typeof draft?.folder === 'string' ? draft.folder : '');
    const v = guard.validateCreate(draft, cwd, { canSchedule: canSchedule() });
    if (!v.ok && v.code === 'PLAN_REQUIRED') return { ok: false, code: 'PLAN_REQUIRED', text: TV.errorText('PLAN_REQUIRED') };
    if (!v.ok || !(await isDir(cwd))) return { ok: false, code: 'VALIDATION', text: TV.errorText('VALIDATION') };
    if (!current()) return failure({ code: 'CONFLICT' });
    if (v.spec.afterReset && Number.isFinite(extra?.startAfter)) v.spec.startAfter = Math.round(extra.startAfter);
    let held = null;
    try { held = await opts.startGuard?.(cwd); } catch { held = null; }
    if (!current()) return failure({ code: 'CONFLICT' });
    if (held) {
      if (draft.overrideBudget !== true) return { ok: false, code: 'BUDGET_HELD', text: held.text, canOverride: true };
      let yes = false;
      try { yes = !!(await opts.confirmDialog?.({ action: 'create', label: 'Start anyway', title: 'Start over the limit', where: tilde(cwd, homeDir), detail: `${held.text}\nThis one task will start regardless. Nothing already running is stopped either way.` }, extra?.wcId ?? 0)); } catch { yes = false; }
      if (!yes) return { ok: false, code: 'CONFIRM_REQUIRED', text: '', cancelled: true };
    }
    if (!current()) return failure({ code: 'CONFLICT' });
    try {
      const r = await channel.createTask(v.spec, { requestId: typeof draft.requestId === 'string' && /^[\w-]{8,128}$/.test(draft.requestId) ? draft.requestId : undefined });
      refresh().catch(() => {});
      return { ok: true, id: r.id };
    } catch (e) { return failure(e); }
  }

  // Advisory observations from the existing local helper, never a filesystem lock.
  async function preflight(req, extra = {}) {
    const unavailable = () => ({ ok: false, code: 'CONFLICT', text: 'Could not inspect known local work. Check the folder again before starting.' });
    const cwd = folders.get(typeof req?.folder === 'string' ? req.folder : '');
    if (!req || Object.keys(req).some(k => k !== 'folder') || !cwd) return failure({ code: 'VALIDATION' });
    const channel = client, current = () => connected() && client === channel && (!extra.current || extra.current() === true);
    if (!current()) return unavailable();
    const active = new Set(['queued', 'claimed', 'running', 'quiet', 'blocked', 'suspended', 'reconnecting', 'unresponsive', 'orphaned', 'handing_over', 'handed_over']);
    const uncertainStates = new Set(['suspended', 'reconnecting', 'unresponsive', 'orphaned', 'handing_over', 'handed_over', 'done', 'failed']);
    const clean = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
    const contains = (root, folder) => { const rel = path.relative(root, folder); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
    try {
      if (!(await isDir(cwd)) || !current()) return unavailable();
      const list = await channel.listTasks({});
      if (!current() || !Array.isArray(list) || list.length > 5000) return unavailable();
      // Source describes who requested a task, not where it runs. A local Board/phone task can also write here.
      const local = list.filter(t => t && !t.hub && typeof t.id === 'string' && t.id.length <= 128);
      const repoRoots = [...new Set(local.map(t => t.repo?.root).filter(root => typeof root === 'string' && path.isAbsolute(root) && contains(root, cwd)))];
      const root = repoRoots.sort((a, b) => b.length - a.length)[0] || cwd;
      const claims = await channel.getClaims(root);
      if (!current() || claims?.repo !== root || !Array.isArray(claims.claims) || claims.claims.length > 5000) return unavailable();
      const byClaim = new Map(claims.claims.filter(c => c && typeof c.taskId === 'string' && c.taskId.length <= 128).map(c => [c.taskId, c]));
      const relevant = local.filter(t => t.repo?.root === root && (active.has(t.state) || byClaim.has(t.id)));
      // Non-Git rows omit their folder in listTasks; inspect only active local rows through the existing detail API.
      const folderRows = local.filter(t => !t.repo && active.has(t.state));
      if (folderRows.length > 40) return unavailable();
      for (const t of folderRows) {
        const detail = await channel.getTask(t.id);
        if (!current() || !detail || typeof detail.worktree !== 'string') return unavailable();
        if (path.isAbsolute(detail.worktree) && contains(detail.worktree, cwd)) relevant.push(t);
      }
      // A claim may appear between listTasks and getClaims; retain it as explicitly uncertain.
      const listed = new Map(list.map(t => [t?.id, t]));
      for (const [id, claim] of byClaim) if (!listed.has(id)) relevant.push({ id, title: 'Local task', state: 'unknown', branch: claim.branch });
      const peers = relevant.slice(0, 40).map(raw => {
        const claim = byClaim.get(raw.id), allPaths = Array.isArray(claim?.paths) ? claim.paths : [];
        const paths = allPaths.filter(p => typeof p === 'string' && p.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(p) && !path.isAbsolute(p) && !path.win32.isAbsolute(p) && !p.split(/[\\/]/).includes('..')).slice(0, 20).map(p => clean(p, 300));
        const t = guard.sanitizeTask(raw, { now: now(), homeDir });
        return { id: clean(t.id, 128), title: clean(t.title, 200), state: raw.state === 'unknown' ? 'unknown' : t.state, branch: clean(t.branch, 200) || null, paths,
          uncertain: raw.state === 'unknown' || uncertainStates.has(t.state) || raw.workInPlace === true || !claim || paths.length === 0 || paths.length !== allPaths.length || allPaths.some(p => typeof p !== 'string' || p.length > 300) };
      });
      return { ok: true, preflight: { checkedAt: now(), peers, note: `Known local Tasks only; other apps and remote work may be missing. Paths are observed so far and can change. Git tasks start in an isolated worktree by default.${relevant.length > 40 ? ' Showing the first 40 tasks.' : ''}` } };
    } catch { return unavailable(); }
  }

  // The helper runs only some AIs; any other AI found on this Mac (src/ai-tools.js
  // quick(), via opts.detectedTools) is still listed, marked as not in Tasks yet.
  function withDetected(list) {
    let found = [];
    try { found = opts.detectedTools ? opts.detectedTools() || [] : []; } catch { found = []; }
    const listed = new Set(list.map((a) => a.id));
    const extra = found.filter((t) => t && t.installed && Object.hasOwn(TV.AI_NAME, t.id) && !listed.has(t.id))
      .map((t) => ({ id: t.id, label: TV.AI_NAME[t.id], installed: true, loggedIn: null, health: 'warn', note: 'Not in Tasks yet.', tasks: false, capabilities: { background: false, permissionRouting: false, costReport: false } }));
    return [...list, ...extra];
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
    return { ais: withDetected(ais || []), recent, canSchedule: canSchedule() };
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

  return { start, stop, retryNow, snapshot, openTask, closeTask, act, saveCheckpoint, copyTakeover, openTerminal, create, preflight, composerInfo, registerFolder, markSeen, folderOf: (handle) => folders.get(handle) ?? null };
}

module.exports = { createTasksService, OFFLINE };
