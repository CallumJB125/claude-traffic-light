'use strict';
// The chat-first thread document's main side (redesign R2a, plan-r2.md §2).
// It shows one row's chat or session activity and offers two navigation
// effects. R2b-1 adds exactly one act: thread:message, a reply to the bound
// task only (plan-r2b-auth.md §2.1), through tasksService.act and
// guard.validateAct unchanged. Approve, deny, answer, stop and every other
// Tasks act stay on tasks-main.js owner() (the Tasks page) until R6a.
// Provisional, awaiting Callum (plan-r2b-auth §7 item 1): no Stop from the chat
// before R6a (the alternative is a thread:stop shaped like compose:stop).
//
// Guard T, for every channel: the exact thread webContents and its main frame,
// the document generation, the request's row id === the row the document was
// opened for (boundId), the chat-first gate; re-checked after every await.
// Effects (open-in-tasks, go-to-terminal) also need the window focused and the
// thread on screen, and run at most once per 500 ms per document (labfix-review S1).
// One thread is alive at a time; its Tasks slot lives only while it is shown
// (index.js retires it, and main closes the slot through retire()).

const ROW_ID = /^[0-9a-f]{64}$/;
const EFFECT_MS = 500;
const CHANNELS = Object.freeze(['thread:open', 'thread:state', 'thread:close', 'thread:open-in-tasks', 'thread:go-to-terminal', 'thread:copy-link', 'thread:message']);
// The reply's own bound: guard's (TV.LIMITS.message), checked before any await.
const MESSAGE_BYTES = 8192;
const REPLY_TEXT = Object.freeze({
  FOCUS: 'Focus this chat and send again.',
  BUSY: 'Still sending your last message.',
  CONFLICT: 'Your message may have been sent. Check the chat before sending again.',
  NOT_FOUND: 'This chat has ended or moved.',
  VALIDATION: 'That message could not be sent. Check it and try again.',
  CONFIRM_REQUIRED: 'This needs the Tasks page. Use Open in Tasks.',
});
// Provisional, awaiting Callum (plan-r2.md §7 item 3): the link form may change.
const LINK = (id) => `plexiform://thread/${id}`;

function createThreadMain({ buddy, chatPreview = false, target, tasks, activity, openInTasks, goToTerminal, copy = () => {}, header = () => null, now = Date.now }) {
  let slot = null; // { wcId, generation, taskId }
  // Documents that asked the Tasks service for a slot: only these are closed, so a terminal
  // session's thread (or a document that never read) never reaches, or starts, the service.
  const asked = new Set();
  let stopped = false;
  const effects = new Map(); // `${wcId}:${generation}:${channel}` → last time

  function ctx() {
    if (chatPreview !== true || stopped) return null;
    let c = null;
    try { c = buddy()?.threadContext?.() ?? null; } catch { c = null; }
    if (!c || !c.window || !c.contents || c.window.isDestroyed?.() || c.contents.isDestroyed?.() || !c.frame || c.contents.mainFrame !== c.frame) return null;
    if (!Number.isSafeInteger(c.generation) || typeof c.boundId !== 'string' || !ROW_ID.test(c.boundId)) return null;
    return c;
  }
  // account and workspace (R2b-1): a reply sent across a sign-in or workspace switch is refused.
  const equal = (a, b) => !!a && !!b && a.window === b.window && a.contents === b.contents && a.frame === b.frame && a.generation === b.generation && a.boundId === b.boundId && a.account === b.account && a.workspace === b.workspace;
  // The sender is the thread document, asking about its own row.
  function guard(e, args, { effect = false } = {}) {
    const c = ctx();
    if (!c || !e || e.sender !== c.contents || e.senderFrame !== c.frame) return null;
    if (args.length !== 1 || typeof args[0] !== 'string' || args[0] !== c.boundId) return null;
    if (effect && c.foreground !== true) return null;
    return c;
  }
  const still = (c, effect = false) => { const n = ctx(); return equal(c, n) && (!effect || n.foreground === true); };
  function rateOk(c, channel) {
    const key = `${c.contents.id}:${c.generation}:${channel}`, t = now(), last = effects.get(key);
    if (last != null && t - last < EFFECT_MS) return false;
    effects.set(key, t);
    if (effects.size > 64) for (const k of [...effects.keys()].slice(0, effects.size - 64)) effects.delete(k);
    return true;
  }
  const resolve = (id) => { try { return target(id) ?? null; } catch { return null; } };
  const GONE = Object.freeze({ gone: true });
  const headerOf = (t, id) => { try { return header(t, id) ?? null; } catch { return null; } };

  async function closeSlot(wcId) {
    if (slot && slot.wcId === wcId) slot = null;
    if (!asked.delete(wcId)) return;
    try { await tasks()?.closeTask?.(wcId); } catch { /* already closed */ }
  }

  async function open(e, args) {
    const c = guard(e, args);
    if (!c) return null;
    const t = resolve(c.boundId);
    if (!t) return GONE;
    const head = headerOf(t, c.boundId);
    if (t.kind === 'task') {
      const wcId = c.contents.id;
      asked.add(wcId);
      let r = null;
      try { r = await tasks().openTask(t.taskId, wcId); } catch { r = null; }
      if (!still(c)) { await closeSlot(wcId); return null; }
      if (!r || r.ok !== true) { await closeSlot(wcId); return { kind: 'task', header: head, error: r?.error ?? 'This chat could not be opened.' }; }
      slot = { wcId, generation: c.generation, taskId: t.taskId };
      return { kind: 'task', header: head, detail: r.detail, replay: r.replay };
    }
    if (t.kind === 'session') {
      let a = null;
      try { a = await activity({ source: t.source, sessionId: t.sessionId }); } catch { a = null; }
      if (!still(c)) return null;
      return { kind: 'session', header: head, origin: t.origin ?? null, activity: a };
    }
    return GONE;
  }

  // A refresh: the header, and a session's activity. A task's live changes come as thread:event.
  async function state(e, args) {
    const c = guard(e, args);
    if (!c) return null;
    const t = resolve(c.boundId);
    if (!t) { await closeSlot(c.contents.id); return GONE; }
    const head = headerOf(t, c.boundId);
    if (t.kind === 'session') {
      let a = null;
      try { a = await activity({ source: t.source, sessionId: t.sessionId }); } catch { a = null; }
      return still(c) ? { kind: 'session', header: head, origin: t.origin ?? null, activity: a } : null;
    }
    return { kind: 'task', header: head };
  }

  async function close(e, args) {
    const c = guard(e, args);
    if (!c) return false;
    await closeSlot(c.contents.id);
    return true;
  }

  // "Open to answer": the Tasks page, revealing only the task this thread is bound to.
  async function toTasks(e, args) {
    const c = guard(e, args, { effect: true });
    if (!c || !rateOk(c, 'open-in-tasks')) return false;
    const t = resolve(c.boundId);
    if (!t || t.kind !== 'task') return false;
    try { return (await openInTasks(t.taskId)) === true; } catch { return false; }
  }

  // "Go to it": this computer's own terminal session the thread is bound to.
  async function toTerminal(e, args) {
    const c = guard(e, args, { effect: true });
    if (!c || !rateOk(c, 'go-to-terminal')) return { ok: false };
    const t = resolve(c.boundId);
    if (!t || t.kind !== 'session') return { ok: false };
    let r = null;
    try { r = await goToTerminal({ source: t.source, sessionId: t.sessionId }); } catch { r = null; }
    return r && typeof r === 'object' ? { ok: r.ok === true, ...(typeof r.note === 'string' ? { note: r.note.slice(0, 300) } : {}) } : { ok: false };
  }

  // Reply (R2b-1, plan-r2b-auth §2.1): {id, body} only; main resolves the task and fixes the action.
  const sending = new Set(); // `${wcId}:${generation}` with a reply in flight
  const refuse = (code, text = REPLY_TEXT[code] ?? '') => ({ ok: false, code, text });
  const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
  async function message(e, args) {
    // 1. Sender and frame first, so no other document learns this thread's focus state.
    const before = ctx();
    if (!before || !e || e.sender !== before.contents || e.senderFrame !== before.frame || args.length !== 1) return null;
    // 2. Foreground (S1).
    if (before.foreground !== true) return refuse('ILLEGAL_TRANSITION', REPLY_TEXT.FOCUS);
    // 3. Exact keys, the bound id, a bounded body: all before any await.
    const req = args[0];
    if (!plain(req) || Object.keys(req).sort().join(',') !== 'body,id' || req.id !== before.boundId) return refuse('VALIDATION');
    if (typeof req.body !== 'string' || !req.body.trim() || Buffer.byteLength(req.body.trim()) > MESSAGE_BYTES) return refuse('VALIDATION');
    // 6. One in flight per document, and S1's per-document rate.
    const key = `${before.contents.id}:${before.generation}`;
    if (sending.has(key) || !rateOk(before, 'message')) return refuse('BUSY');
    // 4. Main resolves the task; a session's thread, a paired device's row or a gone task has none.
    const t = resolve(before.boundId);
    if (!t || t.kind !== 'task' || typeof t.taskId !== 'string') return refuse('NOT_FOUND');
    const taskId = t.taskId;
    // 7. Checked by tasks-service immediately before client.act, the point of no return.
    const current = () => chatPreview === true && !stopped && still(before, true) && resolve(before.boundId)?.taskId === taskId;
    sending.add(key);
    let r = null;
    try {
      // 5. The action is main's.
      try { r = await tasks().act({ id: taskId, action: 'message', payload: { body: req.body } }, before.contents.id, current); } catch { r = null; }
    } finally { sending.delete(key); }
    if (!current()) return refuse('CONFLICT');
    if (r && r.ok === true) return { ok: true };
    const code = typeof r?.code === 'string' ? r.code : 'INTERNAL';
    // validateAct unchanged: a task that can't take a message now is ILLEGAL_TRANSITION, and the page shows why.
    return refuse(code, REPLY_TEXT[code] ?? (typeof r?.text === 'string' ? r.text.slice(0, 300) : ''));
  }

  // Copy link: the clipboard gets this row's link, nothing else.
  function copyLink(e, args) {
    const c = guard(e, args, { effect: true });
    if (!c || !rateOk(c, 'copy-link') || !resolve(c.boundId)) return false;
    try { copy(LINK(c.boundId)); return true; } catch { return false; }
  }

  return {
    CHANNELS,
    register(ipc) {
      if (chatPreview !== true) return;
      ipc.handle('thread:open', (e, ...a) => open(e, a));
      ipc.handle('thread:state', (e, ...a) => state(e, a));
      ipc.handle('thread:close', (e, ...a) => close(e, a));
      ipc.handle('thread:open-in-tasks', (e, ...a) => toTasks(e, a));
      ipc.handle('thread:go-to-terminal', (e, ...a) => toTerminal(e, a));
      ipc.handle('thread:copy-link', (e, ...a) => copyLink(e, a));
      ipc.handle('thread:message', (e, ...a) => message(e, a));
    },
    // tasks-service onEvent, before the Tasks pages: true when the event is the thread slot's.
    onEvent(wcId, taskId, event) {
      if (!slot || slot.wcId !== wcId) return false;
      const c = ctx();
      if (c && c.contents.id === wcId && c.generation === slot.generation && taskId === slot.taskId) {
        try { c.contents.send('thread:event', { id: c.boundId, event }); } catch { /* closed */ }
      }
      return true;
    },
    // index.js: the thread document is gone, reloaded, hidden or left.
    retire(wcId) { if (Number.isSafeInteger(wcId)) void closeSlot(wcId); },
    slot: () => (slot ? { ...slot } : null),
    stop() { stopped = true; if (slot) void closeSlot(slot.wcId); },
  };
}

module.exports = { createThreadMain, CHANNELS, EFFECT_MS, LINK, REPLY_TEXT, MESSAGE_BYTES };
