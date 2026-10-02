'use strict';
// Existing Codex CLI sessions on Codex's SHARED app-server daemon (see
// board/CODEX-DAEMON.md for the verified facts). Opt-in only: until the user
// ticks the preference, nothing here touches the socket.
//
// Plexiform never starts, stops or configures the daemon; the human does that
// (running `codex` in a terminal attaches to it, starting it when missing).
// It connects to the documented control socket (WebSocket over a Unix socket,
// 0600, owned by this user) as one more client, like `codex app-server proxy`.
//
// Privacy: the daemon's thread metadata includes `preview` (usually the first
// user message) and other clients' turns stream to every subscriber. Only an
// allowlist of metadata fields is kept, transcript methods (thread/read,
// thread/turns/list, thread/items/list) are never called, and text is only
// passed on for turns Plexiform itself started (a steer only adds to one of those).
// Approvals belong to the human's terminal: server requests are never answered.
// Turns Plexiform did not start are never steered or interrupted.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const METHODS = new Set(['initialize', 'thread/loaded/list', 'thread/list', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt', 'thread/unsubscribe']);
const REQUEST_MS = 15_000;
const MAX_MESSAGE = 4 * 1024 * 1024;
const MAX_THREADS = 50;
const OPT_IN = 'Let Plexiform message Codex CLI sessions running on the shared Codex daemon';
// The exact commands the human runs, with the CLI's real path (it is often not on PATH).
const commands = (bin) => { const codex = !bin || bin === 'codex' ? 'codex' : `'${bin.replace(/'/g, "'\\''")}'`; return { attach: codex, start: `${codex} app-server daemon start` }; };
function reasons(bin) {
  const c = commands(bin);
  return {
    off: `Off. Turn on "${OPT_IN}" in Preferences to message Codex CLI sessions you started yourself.`,
    noBin: 'Codex CLI not found.',
    notRunning: `The shared Codex daemon is not running. In Terminal, start your Codex session with \`${c.attach}\` (it attaches to the shared daemon and starts it if needed), or run \`${c.start}\` first. Plexiform never starts it for you.`,
    unsafe: 'The Codex daemon socket is not private to your user account, so Plexiform will not connect to it.',
  };
}
const REASONS = reasons('codex');

function defaultSocketPath(env = process.env) {
  const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
  return path.join(home, 'app-server-control', 'app-server-control.sock');
}

// The rendezvous path is a symlink to the real socket. Both the socket and the
// directory holding it must belong to this user and be closed to others
// (no sticky shared directory, no root-owned one). `id` pins the inode so the
// socket can be checked again once connected.
function checkSocket(socketPath, { fsImpl = fs, uid = process.getuid?.() } = {}) {
  let real, st, dir;
  try { real = fsImpl.realpathSync(socketPath); st = fsImpl.statSync(real); dir = fsImpl.statSync(path.dirname(real)); } catch { return { ok: false, reason: 'notRunning' }; }
  if (!st.isSocket()) return { ok: false, reason: 'notRunning' };
  if (typeof uid !== 'number' || st.uid !== uid || dir.uid !== uid) return { ok: false, reason: 'unsafe' };
  if ((st.mode & 0o077) !== 0 || (dir.mode & 0o077) !== 0) return { ok: false, reason: 'unsafe' };
  return { ok: true, real, id: `${st.dev}:${st.ino}` };
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
// Metadata allowlist. `preview`, `path`, `gitInfo`, `turns` and every other field are dropped here.
// Only interactive CLI threads: sub-agent, exec, app-server, ephemeral and unknown-source threads are never listed or attached.
function threadMeta(t) {
  if (!t || typeof t.id !== 'string' || !t.id || t.id.length > 100 || t.parentThreadId || t.ephemeral !== false || t.source !== 'cli' || t.agentNickname || t.agentRole) return null;
  return { id: t.id, title: clean(t.name, 120), project: clean(path.basename(clean(t.cwd, 1000)), 120), status: clean(t.status?.type, 20) || 'unknown', updatedAt: Number.isSafeInteger(t.updatedAt) ? t.updatedAt : null };
}
// The session's own permissions, as Codex reports them on resume (never changed by Plexiform).
const APPROVAL = ['untrusted', 'on-failure', 'on-request', 'never'], SANDBOX = ['readOnly', 'workspaceWrite', 'externalSandbox', 'dangerFullAccess'];
const permissionsOf = (r) => ({
  approvalPolicy: APPROVAL.includes(r?.approvalPolicy) ? r.approvalPolicy : r?.approvalPolicy && typeof r.approvalPolicy === 'object' && r.approvalPolicy.granular ? 'granular' : 'unknown',
  sandbox: SANDBOX.includes(r?.sandbox?.type) ? r.sandbox.type : 'unknown',
});
const inputText = (content) => (Array.isArray(content) ? content : []).filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');

function defaultConnect(realPath) {
  return new (require('ws'))(`ws+unix://${realPath}:/`, { maxPayload: MAX_MESSAGE, perMessageDeflate: false }); // privacy-flow: codex-daemon
}

function createCodexDaemon({ bin, enabled = () => false, socketPath = defaultSocketPath(), connect = defaultConnect, fsImpl = fs, uid = process.getuid?.(), clientVersion = '0' } = {}) {
  const events = new EventEmitter();
  const pending = new Map();
  // Turns Plexiform started (turn id -> thread id), marked as the turn/start
  // response is read. Only these are streamed, steered or interrupted.
  const ours = new Map(), clientIds = new Set();
  // Subscriptions per thread: several Plexiform sessions (windows) can share one; unsubscribe only when the last detaches.
  const subs = new Map();
  let ws = null, ready = null, nextId = 1, open = false;
  const REASON = reasons(bin), COMMAND = commands(bin);

  function state() {
    if (enabled() !== true) return { ok: false, reason: 'off' };
    if (!bin) return { ok: false, reason: 'noBin' };
    return checkSocket(socketPath, { fsImpl, uid });
  }

  function fail(error) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); }
  // `onResult` runs as the response is read, before any later notification on the same socket.
  function request(method, params, onResult = null) {
    // Transcript and settings methods are not on the list and can never be sent.
    if (!METHODS.has(method)) return Promise.reject(new Error(`${method} is not used by Plexiform`));
    return new Promise((resolve, reject) => {
      if (!ws || !open) { reject(new Error('Codex daemon is not connected')); return; }
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, REQUEST_MS);
      pending.set(id, { resolve, reject, timer, onResult });
      try { ws.send(JSON.stringify({ id, method, params })); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  const emit = (e) => events.emit('event', e);
  function onNotification({ method, params: p = {} }) {
    const target = p.threadId;
    if (typeof target !== 'string') return;
    const turnId = typeof p.turnId === 'string' ? p.turnId : null;
    const mine = turnId !== null && ours.get(turnId) === target;
    if (method === 'turn/started' && typeof p.turn?.id === 'string') emit({ kind: 'turn-started', target, turnId: p.turn.id });
    else if (method === 'turn/completed' && typeof p.turn?.id === 'string') {
      const own = ours.get(p.turn.id) === target;
      // Another client's error text is that session's content: only our own turns carry it.
      emit({ kind: 'turn-completed', target, turnId: p.turn.id, status: ['completed', 'interrupted', 'failed'].includes(p.turn.status) ? p.turn.status : 'failed', error: own && typeof p.turn.error?.message === 'string' ? p.turn.error.message : null });
      if (own) ours.delete(p.turn.id);
    } else if (method === 'item/agentMessage/delta' && mine && typeof p.delta === 'string') emit({ kind: 'delta', target, turnId, text: p.delta });
    else if (method === 'item/completed' && mine) {
      const item = p.item;
      if (item?.type === 'agentMessage' && typeof item.text === 'string') emit({ kind: 'message', target, turnId, text: item.text });
      // Only our own message is echoed back; other clients' input is never passed on.
      else if (item?.type === 'userMessage' && typeof item.clientId === 'string' && clientIds.has(item.clientId)) emit({ kind: 'input-recorded', target, turnId, clientId: item.clientId, text: inputText(item.content) });
    } else if (method === 'thread/status/changed' && typeof p.status?.type === 'string') emit({ kind: 'status', target, status: p.status.type });
    else if (method === 'thread/closed') emit({ kind: 'closed', target });
  }
  function onMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message || typeof message !== 'object') return;
    // A server request (approval, elicitation, tool call) goes to every
    // subscriber; the human's terminal answers it. Plexiform stays silent.
    if (Object.hasOwn(message, 'id') && typeof message.method === 'string') {
      const target = message.params?.threadId;
      if (typeof target === 'string') emit({ kind: 'approval-elsewhere', target, turnId: typeof message.params?.turnId === 'string' ? message.params.turnId : null });
      return;
    }
    if (Object.hasOwn(message, 'id')) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(Object.assign(new Error(String(message.error.message ?? 'Codex request failed').slice(0, 300)), { code: message.error.code }));
      else { try { p.onResult?.(message.result); } catch { /* checked by the caller */ } p.resolve(message.result); }
      return;
    }
    if (typeof message.method === 'string') onNotification(message);
  }

  function start() {
    if (ready) return ready;
    const s = state();
    if (!s.ok) return Promise.reject(new Error(REASON[s.reason]));
    const self = connect(s.real);
    ws = self;
    const closedNow = () => {
      if (ws !== self) return;
      ws = null; ready = null; open = false; ours.clear(); clientIds.clear(); subs.clear();
      fail(new Error('Codex daemon connection closed'));
      emit({ kind: 'exit' });
    };
    self.on('message', onMessage);
    self.on('close', closedNow);
    self.on('error', closedNow);
    const attempt = new Promise((resolve, reject) => {
      // The socket is checked again once connected: a swap between the check and the connect is refused.
      self.once('open', () => { const again = checkSocket(socketPath, { fsImpl, uid }); if (!again.ok || again.real !== s.real || again.id !== s.id) { reject(new Error(REASON.unsafe)); return; } open = true; resolve(); });
      self.once('close', () => reject(new Error('Codex daemon connection closed')));
      self.once('error', () => reject(new Error('Codex daemon connection failed')));
    }).then(() => request('initialize', { clientInfo: { name: 'plexiform', title: 'Plexiform', version: String(clientVersion) } }))
      .then(() => { self.send(JSON.stringify({ method: 'initialized' })); })
      .catch((error) => { if (ready === attempt) ready = null; try { self.close(); } catch { /* gone */ } throw error; });
    ready = attempt;
    return ready;
  }

  // Threads loaded on the daemon right now, metadata only.
  async function discover() {
    await start();
    const loaded = await request('thread/loaded/list', { limit: MAX_THREADS });
    const ids = new Set((Array.isArray(loaded?.data) ? loaded.data : []).filter((id) => typeof id === 'string').slice(0, MAX_THREADS));
    if (!ids.size) return [];
    const listed = await request('thread/list', { limit: MAX_THREADS, useStateDbOnly: true });
    const meta = new Map();
    for (const t of Array.isArray(listed?.data) ? listed.data : []) { const m = threadMeta(t); if (m && ids.has(m.id)) meta.set(m.id, m); }
    return [...ids].filter((id) => meta.has(id)).map((id) => meta.get(id));
  }
  // Subscribe to exactly this thread. It must still be loaded on the daemon;
  // its turns are excluded and only its approval policy and sandbox type are kept.
  async function attach({ target }) {
    await start();
    const loaded = await request('thread/loaded/list', { limit: MAX_THREADS });
    if (!Array.isArray(loaded?.data) || !loaded.data.includes(target)) throw new Error('That Codex session is no longer running on the daemon');
    // Checked before subscribing: a sub-agent, exec, app-server or ephemeral thread is never resumed.
    const listed = await request('thread/list', { limit: MAX_THREADS, useStateDbOnly: true });
    if (!(Array.isArray(listed?.data) ? listed.data : []).some((t) => t?.id === target && threadMeta(t))) throw new Error('Plexiform only messages interactive Codex CLI sessions');
    const result = await request('thread/resume', { threadId: target, excludeTurns: true });
    if (result?.thread?.id !== target) throw new Error('Codex resumed a different thread');
    subs.set(target, (subs.get(target) ?? 0) + 1);
    if (!threadMeta(result.thread)) { await release({ target }).catch(() => {}); throw new Error('Plexiform only messages interactive Codex CLI sessions'); }
    return { target, status: clean(result.thread.status?.type, 20) || 'unknown', permissions: permissionsOf(result) };
  }
  async function send({ target, text, clientId, expectedTurnId = null }) {
    if (!state().ok) throw new Error('Codex daemon messaging is off or unreachable');
    await start();
    const input = [{ type: 'text', text, text_elements: [] }];
    if (expectedTurnId) {
      if (ours.get(expectedTurnId) !== target) throw new Error('Plexiform only steers turns it started');
      clientIds.add(clientId);
      const result = await request('turn/steer', { threadId: target, expectedTurnId, input, clientUserMessageId: clientId });
      if (typeof result?.turnId !== 'string') throw new Error('Codex did not acknowledge the steer');
      return { turnId: result.turnId, mode: 'steer' };
    }
    clientIds.add(clientId);
    const result = await request('turn/start', { threadId: target, input, clientUserMessageId: clientId }, (r) => { if (typeof r?.turn?.id === 'string') ours.set(r.turn.id, target); });
    if (typeof result?.turn?.id !== 'string') throw new Error('Codex did not acknowledge the turn');
    return { turnId: result.turn.id, mode: 'new-turn' };
  }
  async function interrupt({ target, turnId }) {
    if (ours.get(turnId) !== target) throw new Error('Plexiform only interrupts turns it started');
    await start(); await request('turn/interrupt', { threadId: target, turnId }); return true;
  }
  // Stop receiving this thread's updates once no Plexiform session uses it. The session itself keeps running.
  async function release({ target }) {
    const n = subs.get(target) ?? 0;
    if (n > 1) { subs.set(target, n - 1); return false; }
    subs.delete(target);
    if (!ws || !open || n === 0) return false;
    await request('thread/unsubscribe', { threadId: target }); return true;
  }
  function stop() { const w = ws; if (w) { try { w.close(); } catch { /* gone */ } } }

  return {
    provider: 'codex-daemon', label: 'Codex CLI (shared daemon)',
    get available() { return state().ok; },
    get reason() { const s = state(); return s.ok ? '' : REASON[s.reason]; },
    precondition: `Start your Codex session in Terminal with \`${COMMAND.attach}\` (without --no-daemon, --profile, --oss or -c overrides, which run without the shared daemon). Codex desktop-app conversations cannot be reached.`,
    capabilities: Object.freeze({ newTurn: true, steer: true, interrupt: true, ack: 'turn-id', echo: 'client-message-id', stream: true, existingSessions: true, startSessions: false, compact: false }),
    discover, attach, send, interrupt, release, stop,
    // Test seam only (never wired to IPC): the same allowlisted request path the adapter uses.
    _request: (method, params) => request(method, params),
    on: (fn) => { events.on('event', fn); return () => events.off('event', fn); },
    alive: () => !!ws && open && enabled() === true,
  };
}

module.exports = { createCodexDaemon, defaultSocketPath, checkSocket, threadMeta, permissionsOf, commands, reasons, METHODS, REASONS, OPT_IN };
