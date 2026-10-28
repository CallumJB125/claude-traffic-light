'use strict';
// The chat-first thread document's main side (redesign R2a, plan-r2.md §2).
// It shows one row's chat or session activity and offers two navigation
// effects. R2b-1 adds thread:message, a reply to the bound task only
// (plan-r2b-auth.md §2.1), through tasksService.act and guard.validateAct
// unchanged. R4-1a (plan-r4.md §2, §11) adds thread:act: Allow once, Deny,
// an answer, a supervisor resume choice and Stop, for the bound task only, each
// on a request main delivered to this document at least 600 ms ago and still
// showing the same thing. R4-1b (plan-r4 §2.5, §3) adds the kinds that need the
// Tasks page's native dialog: Allow for this task, StartTask's Accept and Deny,
// and switch AI (preview, then apply). The dialog is tasks-service's, raised
// through main's confirmDialog and the thread's own ticket (index.js
// threadConfirm); this file never raises one and never skips one.
// Every other Tasks act stays on tasks-main.js owner() (the Tasks page) until R6a.
// R4-2 (plan-r4-2.md) adds a terminal session's hook requests: thread:inputs reads
// only the bound session's, and thread:answer-input answers one of them through
// main's `hook` (main.js), the same rebuilt answer and decision hash as the widget.
// The 600 ms arm and C-F's second click ("Allow anyway") are both held here, per
// document, from what main actually returned to it; the page's say-so is never enough.
//
// Guard T, for every channel: the exact thread webContents and its main frame,
// the document generation, the request's row id === the row the document was
// opened for (boundId), the chat-first gate; re-checked after every await.
// Effects (open-in-tasks, go-to-terminal) also need the window focused and the
// thread on screen, and run at most once per 500 ms per document (labfix-review S1).
// One thread is alive at a time; its Tasks slot lives only while it is shown
// (index.js retires it, and main closes the slot through retire()).

const { createSharedThreadActions } = require('./thread-shared-main');
const ROW_ID = /^[0-9a-f]{64}$/;
const EFFECT_MS = 500;
const CHANNELS = Object.freeze(['thread:open', 'thread:state', 'thread:close', 'thread:open-in-tasks', 'thread:go-to-terminal', 'thread:copy-link', 'thread:message', 'thread:act', 'thread:inputs', 'thread:answer-input', 'thread:shared-state', 'thread:open-team', 'thread:shared-review', 'thread:shared-confirm', 'thread:shared-proposals']);
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
// thread:act (R4-1a). BUSY is shared with a reply; CONFLICT only once the act may have been sent (plan-r4 §10 S1).
const ARM_MS = 600;
const ID_MAX = 128;
const ANSWER_MAX = 20000; // guard's TV.LIMITS.answer
const ACT_TEXT = Object.freeze({
  FOCUS: 'Focus this chat and try again.',
  BUSY: 'Still sending your last choice.',
  NOT_READY: 'This request changed. Look at it again, then choose.',
  CONFLICT: 'Your answer may have been sent. Check the chat before choosing again.',
  CONFLICT_STOP: 'Stop may have been sent. Check the chat before stopping again.',
  NOT_FOUND: 'This request has already been answered, or it has gone.',
  ALREADY_ANSWERED: 'This request has already been answered.',
  VALIDATION: 'That choice could not be sent. Look at it again.',
  CONFIRM_REQUIRED: 'This needs the Tasks page. Use Open in Tasks.',
  CONFLICT_SWITCH: 'The switch may have started. Check the chat before trying again.',
  REVIEW_GONE: 'This review has gone. Review the handover again.',
});
const AIS = Object.freeze(['claude', 'codex']);
// The exact keys of each request; anything else is refused before any await.
const ACT_KEYS = Object.freeze({
  approve: ['action', 'approvalId', 'id', 'scope'],
  deny: ['action', 'approvalId', 'id'],
  answer: ['action', 'answer', 'askId', 'id'],
  choose: ['action', 'askId', 'choiceId', 'id'],
  stop: ['action', 'confirmed', 'id'],
  switchAi: ['action', 'ai', 'id'], // the preview; the apply names the review instead (below)
});
const SWITCH_APPLY_KEYS = 'action,id,review';
// thread:answer-input (R4-2). The extras are checked again by main (AnswerMore.check) before any write.
const INPUT_ID_MAX = 100;
const INPUT_KEYS = new Set(['id', 'inputId', 'optionId', 'more']);
const INPUT_TEXT = Object.freeze({
  FOCUS: 'Focus this chat and answer again.',
  BUSY: 'Still sending your last answer.',
  OFF: 'Answering from Plexiform is off. Answer in the terminal.',
  GONE: 'This request is no longer waiting.',
  NOT_FOUND: 'This request isn’t this chat’s.',
  FLAGGED: 'Needs a careful look. Press Allow anyway if you mean it.',
  NOT_READY: 'This request changed. Look at it again, then choose.',
  VALIDATION: 'That answer could not be sent. Look at it again.',
});
// Provisional, awaiting Callum (plan-r2.md §7 item 3): the link form may change.
const LINK = (id) => `plexiform://thread/${id}`;

function createThreadMain({ buddy, chatPreview = false, target, tasks, activity, openInTasks, goToTerminal, hook = null, copy = () => {}, header = () => null, now = Date.now, sharedRead = null, presence = null, openTeam = null, sharedAuthority = null }) {
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
  const GONE_SHARED = Object.freeze({ gone: true, reason: 'unavailable' });
  // T2: a teammate's shared session. Read-only: main holds the route, this file only asks for the fixed projection.
  // Presence (ledger 30/31) is one slot in main's presence owner, set while this document shows the share.
  const SHARED_MIN_MS = 2000;
  const sharedReads = new Map(); // `${wcId}:${generation}` -> { at, pending, result }
  let presenceDoc = null; // `${wcId}:${generation}` of the document that holds the thread's presence slot
  function setPresence(c, t) {
    if (!presence || !t || typeof t.cardId !== 'string' || !t.cardId || typeof t.teamId !== 'string') return;
    try { presence.set('thread', { team: t.teamId, card: t.cardId }); presenceDoc = `${c.contents.id}:${c.generation}`; } catch { /* presence is best effort */ }
  }
  function clearPresence(wcId = null) {
    if (presenceDoc === null || (wcId !== null && !presenceDoc.startsWith(`${wcId}:`))) return;
    presenceDoc = null;
    try { presence?.set('thread', null); } catch { /* best effort */ }
  }
  // T3 (plan-t3 §2): send, steer, stop and propose for a bound interact share. Guard T here; the rest in thread-shared-main.
  const shared = createSharedThreadActions({ authority: sharedAuthority, now });
  // Guard T for a channel whose args are [boundId, request].
  function guardWith(e, args, { effect = false } = {}) {
    const c = ctx();
    if (!c || !e || e.sender !== c.contents || e.senderFrame !== c.frame) return null;
    if (args.length !== 2 || typeof args[0] !== 'string' || args[0] !== c.boundId) return null;
    if (effect && c.foreground !== true) return null;
    return c;
  }
  const sharedBound = (c) => { const t = resolve(c.boundId); return !!t && t.kind === 'shared'; };
  async function sharedReview(e, args) {
    const c = guardWith(e, args);
    if (!c || !sharedBound(c)) return null;
    if (!rateOk(c, 'shared-review')) return { ok: false, status: 'busy', error: 'Wait a moment, then try again.' };
    return shared.review(c, args[1], still);
  }
  async function sharedConfirm(e, args) {
    const c = guardWith(e, args, { effect: true });
    if (!c || !sharedBound(c)) return null;
    if (!rateOk(c, 'shared-confirm')) return { ok: false, status: 'busy', error: 'Wait a moment, then try again.' };
    return shared.confirm(c, args[1], still);
  }
  async function sharedProposals(e, args) {
    const c = guard(e, args);
    if (!c || !sharedBound(c)) return null;
    return shared.proposals(c, still);
  }
  const headerOf = (t, id) => { try { return header(t, id) ?? null; } catch { return null; } };

  async function closeSlot(wcId) {
    if (slot && slot.wcId === wcId) slot = null;
    forget(wcId);
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
      // The detail reaches this document as this reply: what it shows is now armed (plan-r4 §2.2 step 6).
      record(c, t.taskId, r.detail);
      return { kind: 'task', header: head, detail: r.detail, replay: r.replay };
    }
    if (t.kind === 'session') {
      let a = null;
      try { a = await activity({ source: t.source, sessionId: t.sessionId }); } catch { a = null; }
      if (!still(c)) return null;
      return { kind: 'session', header: head, origin: t.origin ?? null, activity: a };
    }
    if (t.kind === 'shared') {
      setPresence(c, t);
      return { kind: 'shared', header: null };
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
    if (t.kind === 'shared') return { kind: 'shared', header: null };
    return { kind: 'task', header: head };
  }

  async function close(e, args) {
    const c = guard(e, args);
    if (!c) return false;
    clearPresence(c.contents.id);
    shared.retire(c.contents.id);
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

  // ── the shown arm (plan-r4 §2.2 step 6, §11.2) ──
  // `${wcId}:${generation}:${kind}:${id}` → { hash, tool, at, choices? }. Recorded only for a detail main actually
  // delivered to this document, with the hash tasks-service relayed for it (shownHash). The same hash keeps its first
  // delivery time; a changed hash re-arms that one request only.
  const shown = new Map();
  const shownKey = (c, kind, id) => `${c.contents.id}:${c.generation}:${kind}:${id}`;
  const relayedHash = (wcId, taskId, kind, id) => { try { return tasks()?.shownHash?.(wcId, taskId, kind, id) ?? null; } catch { return null; } };
  // switch AI (R4-1b, §2.5): at most one review handle per document, the one main last returned to it.
  const reviews = new Map(); // wcId → { handle, generation, at, expiresAt }
  // The act in flight per document: tasks-service may call a preview's `current` again at apply time,
  // so "refused before the send" is recorded on whichever act is running now (plan-r4 §10 S1 nit).
  const running = new Map(); // wcId → { refused }
  function forget(wcId) {
    for (const m of [shown, hookShown, anyway, inputsRead]) for (const k of m.keys()) if (String(k).startsWith(`${wcId}:`)) m.delete(k);
    reviews.delete(wcId);
  }
  function record(c, taskId, detail) {
    if (!detail || typeof detail !== 'object') return;
    const wcId = c.contents.id, live = new Set(), t = now();
    const put = (kind, id, extra) => {
      const h = relayedHash(wcId, taskId, kind, id);
      if (!h || typeof h.hash !== 'string') return;
      const key = shownKey(c, kind, id), old = shown.get(key);
      live.add(key);
      shown.set(key, old && old.hash === h.hash ? old : { hash: h.hash, tool: h.tool ?? null, at: t, ...extra });
    };
    // Up to 10 approvals, as sanitizeDetail relays (tasks-guard.js:110); one ask.
    for (const a of (Array.isArray(detail.openApprovals) ? detail.openApprovals : []).slice(0, 10)) if (a && typeof a.approvalId === 'string') put('approval', a.approvalId, {});
    const k = detail.openAsk;
    if (k && typeof k.askId === 'string') put('ask', k.askId, { choices: Array.isArray(k.choices) ? k.choices.map((ch) => ({ id: ch.id, action: ch.action, payload: ch.payload })) : [] });
    // This document's other requests are gone: drop them, so nothing outlives what the page shows.
    const prefix = `${wcId}:`;
    for (const key of shown.keys()) if (key.startsWith(prefix) && !live.has(key)) shown.delete(key);
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

  // thread:act (R4-1a, plan-r4 §2): approve once, deny, answer, choose (resume) or stop, for the bound task only.
  async function act(e, args) {
    const fail = (code, text = ACT_TEXT[code] ?? '') => ({ ok: false, code, text });
    // 1. Sender, frame, argc.
    const before = ctx();
    if (!before || !e || e.sender !== before.contents || e.senderFrame !== before.frame || args.length !== 1) return null;
    // 2. Foreground.
    if (before.foreground !== true) return fail('ILLEGAL_TRANSITION', ACT_TEXT.FOCUS);
    // 3. The exact shape, the bound id, field bounds: all before any await.
    const req = args[0];
    if (!plain(req) || typeof req.action !== 'string' || !Object.hasOwn(ACT_KEYS, req.action)) return fail('VALIDATION');
    const apply = req.action === 'switchAi' && Object.hasOwn(req, 'review');
    const extra = !['stop', 'switchAi'].includes(req.action) && Object.hasOwn(req, 'confirmed');
    const keys = Object.keys(req).filter((k) => !(extra && k === 'confirmed')).sort().join(',');
    if (keys !== (apply ? SWITCH_APPLY_KEYS : ACT_KEYS[req.action].join(',')) || req.id !== before.boundId) return fail('VALIDATION');
    if (extra && req.confirmed !== true) return fail('VALIDATION');
    const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= ID_MAX;
    if (req.action === 'approve' && (!id(req.approvalId) || !['once', 'task'].includes(req.scope))) return fail('VALIDATION');
    if (req.action === 'deny' && !id(req.approvalId)) return fail('VALIDATION');
    if (req.action === 'answer' && (!id(req.askId) || typeof req.answer !== 'string' || !req.answer.trim() || req.answer.trim().length > ANSWER_MAX)) return fail('VALIDATION');
    if (req.action === 'choose' && (!id(req.askId) || !id(req.choiceId) || req.choiceId.length > 60)) return fail('VALIDATION');
    if (req.action === 'stop' && req.confirmed !== true) return fail('VALIDATION');
    if (req.action === 'switchAi' && (apply ? typeof req.review !== 'string' || !/^[0-9a-f-]{36}$/.test(req.review) : !AIS.includes(req.ai))) return fail('VALIDATION');
    // 4. One act or reply in flight per document, and the per-document rate.
    const busy = `${before.contents.id}:${before.generation}`;
    if (sending.has(busy) || !rateOk(before, 'message')) return fail('BUSY');
    // 5. Main resolves the task.
    const t = resolve(before.boundId);
    if (!t || t.kind !== 'task' || typeof t.taskId !== 'string') return fail('NOT_FOUND');
    const taskId = t.taskId, wcId = before.contents.id;
    // 6. The shown arm: delivered to this document, still the same, and on screen for 600 ms.
    const kind = req.action === 'approve' || req.action === 'deny' ? 'approval' : ['stop', 'switchAi'].includes(req.action) ? null : 'ask';
    const reqId = kind === 'approval' ? req.approvalId : req.askId;
    let armed = null;
    if (kind) {
      armed = shown.get(shownKey(before, kind, reqId)) ?? null;
      const h = relayedHash(wcId, taskId, kind, reqId);
      if (!armed) return fail(h ? 'NOT_READY' : 'NOT_FOUND');
      if (!h || h.hash !== armed.hash || now() - armed.at < ARM_MS) return fail('NOT_READY');
    }
    // 7. A StartTask is accepted once, exactly as its card offers (plan-r4 §2.1); the guard would force it anyway.
    if (req.action === 'approve' && req.scope === 'task' && armed.tool === 'StartTask') return fail('VALIDATION');
    // A switch apply names the handle main last returned to this document, on screen for 600 ms (§2.5).
    if (apply) {
      const h = reviews.get(wcId);
      if (!h || h.handle !== req.review || h.generation !== before.generation) return fail('NOT_READY', ACT_TEXT.REVIEW_GONE);
      if (now() - h.at < ARM_MS) return fail('NOT_READY');
      reviews.delete(wcId);
    }
    let send;
    if (req.action === 'approve') send = { action: 'approve', payload: { approvalId: req.approvalId, scope: req.scope } };
    else if (apply) send = { action: 'switchAi', payload: { phase: 'apply', review: req.review } };
    else if (req.action === 'switchAi') send = { action: 'switchAi', payload: { ai: req.ai } };
    else if (req.action === 'deny') send = { action: 'deny', payload: { approvalId: req.approvalId } };
    else if (req.action === 'answer') send = { action: 'answer', payload: { askId: req.askId, answer: req.answer.trim() } };
    else if (req.action === 'stop') send = { action: 'stop', confirmed: true };
    else {
      // choose: main's own copy of the choice it delivered; the page names only its id.
      const ch = (armed.choices || []).find((c) => c && c.id === req.choiceId);
      if (!ch) return fail('VALIDATION');
      if (ch.action === 'resume' && ch.payload && ['now', 'reset'].includes(ch.payload.when)) send = { action: 'resume', payload: { when: ch.payload.when } };
      // A switch-AI choice is that switch's preview; what it shows is the review, not the ask (§2.4, §2.5).
      else if (ch.action === 'switchAi' && ch.payload && AIS.includes(ch.payload.ai)) send = { action: 'switchAi', payload: { ai: ch.payload.ai } };
      else return fail('CONFIRM_REQUIRED');
    }
    // A task's own task.confirm: the page asked twice; forwarded only when main's row asks for it (plan-r4 §2.6).
    if (extra) {
      let row = null;
      try { row = (tasks()?.snapshot?.()?.tasks || []).find((x) => x && x.id === taskId) ?? null; } catch { row = null; }
      if (!row || !Array.isArray(row.confirm) || !row.confirm.includes(send.action)) return fail('VALIDATION');
      send.confirmed = true;
    }
    // 8. Checked by tasks-service immediately before client.act (after any dialog): the document, the task,
    // and (for a request) the same hash. A switch is the chat's only (S2): its review outlives the ask.
    const switching = send.action === 'switchAi';
    const base = () => chatPreview === true && !stopped && still(before, true) && resolve(before.boundId)?.taskId === taskId;
    const current = () => base() && (switching || !kind || relayedHash(wcId, taskId, kind, reqId)?.hash === armed.hash);
    const mine = { refused: false };
    const atSend = () => { const ok = current(); if (!ok) { const act = running.get(wcId); if (act) act.refused = true; } return ok; };
    sending.add(busy); running.set(wcId, mine);
    let r = null;
    try {
      try { r = await tasks().act({ id: taskId, ...send }, wcId, atSend); } catch { r = null; }
    } finally { sending.delete(busy); if (running.get(wcId) === mine) running.delete(wcId); }
    // 9. Nothing was sent: the request changed, or the dialog was cancelled or never opened. Sent, or maybe sent: say so (S1).
    if (mine.refused) return fail('NOT_READY');
    if (r?.cancelled === true) return { ok: false, code: 'CONFIRM_REQUIRED', cancelled: true, text: '' };
    // After the send only the chat itself is checked: a request that was answered disappears, which is success, not a change.
    if (!base()) return fail('CONFLICT', req.action === 'stop' ? ACT_TEXT.CONFLICT_STOP : switching ? (typeof r?.text === 'string' && r.text ? r.text.slice(0, 300) : ACT_TEXT.CONFLICT_SWITCH) : ACT_TEXT.CONFLICT);
    // A preview: keep its handle for this document, and hand the page the review to read.
    if (switching && send.payload.phase !== 'apply') {
      const pc = r?.ok === true ? r.providerChange : null;
      if (!pc || pc.status !== 'review' || typeof pc.review !== 'string') return fail('CONFLICT', ACT_TEXT.REVIEW_GONE);
      reviews.set(wcId, { handle: pc.review, generation: before.generation, at: now(), expiresAt: pc.expiresAt });
      return { ok: true, review: { review: pc.review, from: pc.from, to: pc.to, permissionLevel: pc.permissionLevel, planFirst: pc.planFirst, budgetUsd: pc.budgetUsd, spentUsd: pc.spentUsd,
        contextVersion: pc.contextVersion, branch: pc.branch, handover: pc.handover, messagesText: pc.messagesText, files: pc.files, patch: pc.patch, expiresAt: pc.expiresAt } };
    }
    if (r && r.ok === true) return { ok: true };
    // 10. Engine and guard codes, as plain sentences.
    const code = typeof r?.code === 'string' ? r.code : 'INTERNAL';
    return { ...fail(code, ACT_TEXT[code] ?? (typeof r?.text === 'string' ? r.text.slice(0, 300) : '')), ...(r?.cancelled === true ? { cancelled: true } : {}) };
  }

  // ── R4-2: the bound session's hook requests (plan-r4-2.md) ──
  // `${wcId}:${generation}:${inputId}` → { hash, danger, at }: what thread:inputs returned to this document.
  const hookShown = new Map();
  // C-F (plan-r4-2 §8 S1): a FLAGGED reply arms "Allow anyway" for that request, option, hash and danger only.
  const anyway = new Map(); // `${wcId}:${generation}:${inputId}` → { optionId, hash, danger, at }
  const inputsRead = new Map(); // `${wcId}:${generation}` → { at, reply, key }
  const hookKey = (c, inputId) => `${c.contents.id}:${c.generation}:${inputId}`;
  const sessionOf = (c) => { const t = resolve(c.boundId); return t && t.kind === 'session' && typeof t.sessionId === 'string' ? t : null; };
  function hookRead(t) {
    let r = null;
    try { r = hook?.inputs?.({ source: t.source, sessionId: t.sessionId }) ?? null; } catch { r = null; }
    const items = Array.isArray(r?.items) ? r.items.filter((x) => x && x.input && typeof x.input.id === 'string') : [];
    return { answering: r?.answering === true, items };
  }
  const viewKey = (items) => JSON.stringify(items.map((x) => [x.input.id, x.hash ?? null, x.danger ?? null, x.input.answerable === true]));
  function inputs(e, args) {
    const c = guard(e, args);
    if (!c) return null;
    const t = sessionOf(c);
    if (!t) return GONE;
    const rk = `${c.contents.id}:${c.generation}`, last = inputsRead.get(rk), t0 = now();
    // At most one fresh read per 500 ms per document; inside it, the last reply again (nothing new is armed).
    if (last && !last.stale && t0 - last.at < EFFECT_MS) return last.reply;
    const { answering, items } = hookRead(t);
    if (!still(c)) return null;
    const live = new Set();
    for (const x of items) {
      if (typeof x.hash !== 'string' || x.input.answerable !== true) continue;
      const key = hookKey(c, x.input.id), old = hookShown.get(key);
      live.add(key);
      hookShown.set(key, old && old.hash === x.hash && old.danger === (x.danger ?? null) ? old : { hash: x.hash, danger: x.danger ?? null, at: t0 });
    }
    const prefix = `${rk}:`;
    for (const key of hookShown.keys()) if (key.startsWith(prefix) && !live.has(key)) { hookShown.delete(key); anyway.delete(key); }
    const reply = { inputs: items.map((x) => x.input), answering };
    inputsRead.set(rk, { at: t0, reply, key: viewKey(items) });
    return reply;
  }
  function answerInput(e, args) {
    const fail = (code, text = INPUT_TEXT[code] ?? '') => ({ ok: false, code, text });
    // 1. Sender, frame, argc.
    const before = ctx();
    if (!before || !e || e.sender !== before.contents || e.senderFrame !== before.frame || args.length !== 1) return null;
    // 2. Foreground.
    if (before.foreground !== true) return fail('ILLEGAL_TRANSITION', INPUT_TEXT.FOCUS);
    // 3. The exact shape and the bound id, before anything else.
    const req = args[0];
    if (!plain(req) || req.id !== before.boundId || !Object.keys(req).every((k) => INPUT_KEYS.has(k))) return fail('VALIDATION');
    const short = (v) => typeof v === 'string' && v.length > 0 && v.length <= INPUT_ID_MAX;
    if (!short(req.inputId) || !short(req.optionId)) return fail('VALIDATION');
    const more = Object.hasOwn(req, 'more') ? req.more : {};
    let okMore = false;
    try { okMore = hook?.checkMore?.(more) === true; } catch { okMore = false; }
    if (!okMore) return fail('VALIDATION');
    // 4. One answer in flight per document, and the per-document rate.
    const busy = `${before.contents.id}:${before.generation}`;
    if (sending.has(busy) || !rateOk(before, 'answer-input')) return fail('BUSY');
    // 5. Main resolves the session; a task's thread answers through thread:act.
    const t = sessionOf(before);
    if (!t) return fail('NOT_FOUND');
    // 6. Main's own checks, from the request file: the setting, the session, the rebuilt answer.
    let p = null;
    try { p = hook?.prepare?.({ source: t.source, sessionId: t.sessionId }, req.inputId, req.optionId, more) ?? null; } catch { p = null; }
    if (!p || p.ok !== true) return fail(typeof p?.code === 'string' && Object.hasOwn(INPUT_TEXT, p.code) ? p.code : 'GONE');
    // 7. The arm: returned to this document, still the same hash and danger, on screen for 600 ms.
    const key = hookKey(before, req.inputId), armed = hookShown.get(key);
    if (!armed || typeof p.hash !== 'string' || armed.hash !== p.hash || armed.danger !== (p.danger ?? null) || now() - armed.at < ARM_MS) return fail('NOT_READY');
    // 8. C-F: a flagged allow takes a second click, which main itself offered (S1).
    if (p.flagged === true) {
      const tok = anyway.get(key);
      if (more.anyway !== true || !tok) {
        anyway.set(key, { optionId: req.optionId, hash: p.hash, danger: p.danger ?? null, at: now() });
        return fail('FLAGGED');
      }
      anyway.delete(key);
      if (tok.optionId !== req.optionId || tok.hash !== p.hash || tok.danger !== (p.danger ?? null)) return fail('NOT_READY');
      if (now() - tok.at < ARM_MS) { anyway.set(key, tok); return fail('NOT_READY'); }
    }
    // 9. The document is still this one, focused, on the same session; then the one write.
    if (!still(before, true) || sessionOf(before)?.sessionId !== t.sessionId) return fail('NOT_READY');
    sending.add(busy);
    let w = null;
    try { w = p.write(); } catch { w = null; } finally { sending.delete(busy); }
    hookShown.delete(key); anyway.delete(key); inputsRead.delete(busy);
    if (w && w.ok === true) return { ok: true };
    return fail('GONE', typeof w?.error === 'string' ? `That answer wasn’t sent (${w.error.slice(0, 200)}).` : INPUT_TEXT.GONE);
  }
  // main's broadcastStatus: a ping, with no data, when the bound session's requests changed.
  function inputsChanged() {
    const c = ctx();
    if (!c || !hook) return;
    const t = sessionOf(c);
    if (!t) return;
    // Only a document that has read is pinged; its next read is then fresh, whatever the rate.
    const last = inputsRead.get(`${c.contents.id}:${c.generation}`);
    if (!last) return;
    const key = viewKey(hookRead(t).items);
    if (last.key === key) return;
    last.key = key; last.stale = true;
    try { c.contents.send('thread:inputs-changed', { id: c.boundId }); } catch { /* closed */ }
  }

  // thread:shared-state (T2): the bound teammate share's projection. Read-only; the route never leaves main.
  // A 2 s floor per document and one read in flight: a second call inside either gets the same result.
  async function sharedState(e, args) {
    const c = guard(e, args);
    if (!c) return null;
    const t = resolve(c.boundId);
    if (!t) return GONE_SHARED;
    if (t.kind !== 'shared') return null;
    if (typeof sharedRead !== 'function') return GONE_SHARED;
    const key = `${c.contents.id}:${c.generation}`, last = sharedReads.get(key), at = now();
    if (last && (last.pending || at - last.at < SHARED_MIN_MS)) return last.pending ? last.pending : last.result;
    const entry = { at, pending: null, result: null };
    sharedReads.set(key, entry);
    entry.pending = (async () => {
      let r = null;
      try { r = await sharedRead(c.boundId, () => still(c)); } catch { r = null; }
      entry.pending = null;
      if (!still(c) || r === null) { sharedReads.delete(key); return null; }
      if (r.gone === true) { clearPresence(c.contents.id); r = { gone: true, reason: typeof r.reason === 'string' ? r.reason : 'ended' }; }
      if (r.unavailable !== true) shared.afterRead(c, r);
      entry.result = r;
      return r;
    })();
    return entry.pending;
  }

  // "Team overview" / "Open in Team sessions" (T2): navigation only, the same one-shot hint a sidebar click arms.
  async function toTeam(e, args) {
    const c = guard(e, args, { effect: true });
    if (!c || !rateOk(c, 'open-team')) return false;
    const t = resolve(c.boundId);
    if (!t || t.kind !== 'shared' || typeof openTeam !== 'function') return false;
    try { return (await openTeam(c.boundId)) === true; } catch { return false; }
  }

  // Copy link: the clipboard gets this row's link, nothing else. A teammate's share has no stable link (its row id is per run).
  function copyLink(e, args) {
    const c = guard(e, args, { effect: true });
    if (!c || !rateOk(c, 'copy-link')) return false;
    const t = resolve(c.boundId);
    if (!t || t.kind === 'shared') return false;
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
      ipc.handle('thread:act', (e, ...a) => act(e, a));
      ipc.handle('thread:inputs', (e, ...a) => inputs(e, a));
      ipc.handle('thread:answer-input', (e, ...a) => answerInput(e, a));
      ipc.handle('thread:shared-state', (e, ...a) => sharedState(e, a));
      ipc.handle('thread:open-team', (e, ...a) => toTeam(e, a));
      ipc.handle('thread:shared-review', (e, ...a) => sharedReview(e, a));
      ipc.handle('thread:shared-confirm', (e, ...a) => sharedConfirm(e, a));
      ipc.handle('thread:shared-proposals', (e, ...a) => sharedProposals(e, a));
    },
    // tasks-service onEvent, before the Tasks pages: true when the event is the thread slot's.
    onEvent(wcId, taskId, event) {
      if (!slot || slot.wcId !== wcId) return false;
      const c = ctx();
      if (c && c.contents.id === wcId && c.generation === slot.generation && taskId === slot.taskId) {
        let sent = false;
        try { c.contents.send('thread:event', { id: c.boundId, event }); sent = true; } catch { /* closed */ }
        // A detail follows remember() (tasks-service refreshOpen): arm what it shows, once it was really sent (S5).
        if (sent && event && event.type === 'detail') record(c, taskId, event.detail);
      }
      return true;
    },
    // index.js: the thread document is gone, reloaded, hidden or left.
    retire(wcId) { if (Number.isSafeInteger(wcId)) { clearPresence(wcId); shared.retire(wcId); for (const k of [...sharedReads.keys()]) if (k.startsWith(`${wcId}:`)) sharedReads.delete(k); void closeSlot(wcId); } },
    inputsChanged,
    slot: () => (slot ? { ...slot } : null),
    stop() { stopped = true; clearPresence(); shared.stop(); if (slot) void closeSlot(slot.wcId); },
  };
}

module.exports = { createThreadMain, CHANNELS, EFFECT_MS, LINK, REPLY_TEXT, MESSAGE_BYTES, ACT_TEXT, ARM_MS, INPUT_TEXT };
