'use strict';
// Provider-neutral interaction contract for sessions Plexiform itself owns.
//
// Adapter shape (Codex now; Claude Code / Gemini ACP / local models later):
//   provider, label, available?, reason?, capabilities {newTurn, steer, interrupt, ack, echo, stream, existingSessions}
//   open({cwd}) -> {target}                      provider session/thread id, never sent to a renderer
//   send({target, text, clientId, expectedTurnId}) -> {turnId, mode: 'new-turn'|'steer'}
//   interrupt({target, turnId}), release?({target}), stop(), alive(), on(fn) -> off
//   Existing sessions (capabilities.existingSessions, startSessions:false, no open()):
//   discover() -> [{id, title, project, status, updatedAt}]   metadata only, never transcript
//   attach({target}) -> {target, status}                       subscribe to that exact thread
//   compact?({target, keep})  optional, with capability compact: true (and
//     compactKeep when the provider honours keep); see src/compaction.js
//   events: {kind: 'turn-started'|'delta'|'message'|'input-recorded'|'turn-completed'|'status'|'refused-request'|'closed'|'oversize'|'exit'
//     |'usage' {inputTokens, window}|'compacted', target, turnId, ...}
//
// Delivery is only claimed from the provider's own acknowledgement for the
// exact target: 'acknowledged' = the provider returned a turn id for a request
// addressed to this session's target; 'recorded' = the provider echoed our
// literal text with our client id inside that target and turn. Status changes,
// foreign turns and other targets never advance a delivery.
//
// Renderers must show delivery `text`, `response`, `error` and `notices`
// with textContent only: they are provider/model output, never markup.
const crypto = require('node:crypto');
const path = require('node:path');
const { redactSecrets } = require('./secret-patterns');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TEXT = 4000, MAX_BYTES = 8192, MAX_RESPONSE = 16000, MAX_DELIVERIES = 20, MAX_TURNS = 40, MAX_SESSIONS = 8, MAX_NOTICES = 5;
const FINAL = ['completed', 'interrupted', 'failed'];
const REPORT_RECENT_MS = 90_000;
const NOTICES = {
  approval: 'The provider asked for an approval; Plexiform refused it.',
  approvalElsewhere: 'Codex is waiting for an approval. Plexiform never answers approvals for sessions it did not start: answer it in a Codex terminal attached to this session, or interrupt this turn if none is open.',
  oversize: 'A provider update was too large to show and was dropped.',
};
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).every((k) => keys.includes(k));
const REPORT_SOURCES = Object.freeze(['human', 'provider', 'self-reported', 'observed']);
const CHILD_STATES = Object.freeze(['working', 'waiting', 'input', 'idle', 'ended']);
// Metadata is deliberately smaller than messages. Redact before truncation,
// so a credential straddling the visible limit cannot leave a partial secret.
function cleanReportText(v, max = 200) {
  if (typeof v !== 'string' || v.length > 8192) return '';
  const tokens = v.replace(/\b(?:bdt|brt|btk|btr|inv|clinv|pfi|pfm|pfr|pfc|pfcode)_[A-Za-z0-9_-]+\b|\b(?:brt1|bmr1)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted:token>');
  return [...redactSecrets(tokens, { docExamples: false })
    .replace(/(?:https?|file):\/\/[^\s<>"'`]+/gi, '<url>')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|(?<![\w.:/-])\/(?!\/))[^\s<>"'`]+/g, '<path>')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[A-Za-z0-9_-]{32,}\b/gi, '<id>')
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').trim()].slice(0, max).join('');
}
const refuse = (status, error) => ({ ok: false, status, error });
const ERRORS = {
  invalid: 'Check the selected session and message.',
  forbidden: 'This session belongs to a different Plexiform window.',
  gone: 'That session is no longer listed. Find sessions again and choose it.',
  stale: 'This session changed. Refresh and select it again.',
  busy: 'A message is being sent or a turn is running. Steer it or wait for it to finish.',
  unavailable: 'The provider did not accept the message.',
  foreignTurn: 'This turn was started outside Plexiform (in a Codex terminal or another app). Plexiform only steers or interrupts turns it started; wait for it to finish or use that terminal.',
};
// What an attached session may do without asking, in words, plus warnings shown on attach.
const APPROVAL_WORDS = { untrusted: 'asks before most commands', 'on-failure': 'asks when a sandboxed command fails', 'on-request': 'asks when it wants to go beyond its sandbox', never: 'never asks for approval', granular: 'custom approval rules' };
const SANDBOX_WORDS = { readOnly: 'read-only sandbox', workspaceWrite: 'can edit files in its folder', externalSandbox: 'external sandbox', dangerFullAccess: 'full access to your computer, no sandbox' };
function disclosure(p) {
  const approval = APPROVAL_WORDS[p?.approvalPolicy] ? p.approvalPolicy : 'unknown', sandbox = SANDBOX_WORDS[p?.sandbox] ? p.sandbox : 'unknown';
  const warnings = [];
  if (approval === 'never') warnings.push('This session never asks for approval: messages you send from Plexiform can run commands and edit files without asking.');
  if (sandbox === 'dangerFullAccess') warnings.push('This session has full access to your computer (no sandbox): messages you send from Plexiform run with that access.');
  if (approval === 'unknown' || sandbox === 'unknown') warnings.push('Codex did not report this session\'s permissions. Messages you send run with whatever it is allowed to do.');
  if (approval !== 'never') warnings.push('Plexiform cannot tell whether a Codex terminal is still attached to this session. If Codex asks for an approval, only that terminal can answer it; Plexiform never does.');
  return { permissions: `Permissions: ${APPROVAL_WORDS[approval] ?? 'approval policy unknown'} · ${SANDBOX_WORDS[sandbox] ?? 'sandbox unknown'}`, approvalPolicy: approval, sandbox, warnings };
}

// boardCurrent must be supplied by main; without it every session is refused.
// compaction: an optional createSessionCompactor() (src/compaction.js).
function createInteractionHub({ adapters = {}, workspace = () => null, boardCurrent = () => false, onEvent = () => {}, now = Date.now, compaction = null } = {}) {
  const sessions = new Map();
  // Discovery handles: opaque ids for existing provider threads, valid only
  // until the same actor discovers that provider again.
  const handles = new Map(), attaching = new Map();
  const isCurrent = (board) => { try { return boardCurrent(board) === true; } catch { return false; } };
  const reporting = () => ({ task: null, input: null, children: new Map() });
  const stamp = (v, at) => Number.isSafeInteger(v) && v >= 0 && v <= at;
  const privateText = (r, text, max = 200, childIds = []) => {
    if (typeof text !== 'string') return '';
    for (const id of [r.target, ...r.turns.keys(), ...r.reporting.children.keys(), ...childIds]) if (typeof id === 'string' && id) text = text.replaceAll(id, '<id>');
    return cleanReportText(text, max);
  };

  // Trusted main/hook seam, never an IPC operation. The caller must already
  // bind an observed report to this exact owned session and generation. Child
  // IDs stay in main; each child has its own report and receiver clock.
  function report(req, actor) {
    if (!closed(req, ['session', 'generation', 'source', 'taskTitle', 'inputNeeded', 'children', 'observedAt']) || !REPORT_SOURCES.includes(req.source)) return refuse('invalid', ERRORS.invalid);
    const { r, error } = lookup(req, actor, { board: false });
    if (error) return error;
    if (r.existing) return refuse('forbidden', ERRORS.forbidden);
    const at = now(), observed = req.observedAt === undefined ? at : req.observedAt;
    if (!stamp(at, at) || !stamp(observed, at) || (req.taskTitle !== undefined && (typeof req.taskTitle !== 'string' || req.taskTitle.length > 8192)) || (req.inputNeeded !== undefined && typeof req.inputNeeded !== 'boolean') || (req.children !== undefined && (!Array.isArray(req.children) || req.children.length > 20))) return refuse('invalid', ERRORS.invalid);
    const children = [];
    for (const c of req.children ?? []) {
      if (!closed(c, ['id', 'name', 'taskTitle', 'state', 'observedAt', 'createdAt']) || typeof c.id !== 'string' || !c.id || c.id.length > 200 || typeof c.name !== 'string' || c.name.length > 8192 || (c.taskTitle !== undefined && (typeof c.taskTitle !== 'string' || c.taskTitle.length > 8192)) || !CHILD_STATES.includes(c.state)) return refuse('invalid', ERRORS.invalid);
      const childAt = c.observedAt === undefined ? observed : c.observedAt, created = c.createdAt === undefined ? childAt : c.createdAt;
      if (!stamp(childAt, at) || !stamp(created, childAt)) return refuse('invalid', ERRORS.invalid);
      children.push({ c, childAt, created });
    }
    const meta = r.reporting;
    const childIds = children.map(({ c }) => c.id);
    if (req.taskTitle !== undefined && (req.source === 'human' || meta.task?.source !== 'human') && (!meta.task || observed > meta.task.observed_at)) meta.task = { title: privateText(r, req.taskTitle, 200, childIds), source: req.source, observed_at: observed, received_at: at };
    if (req.inputNeeded !== undefined && (!meta.input || observed > meta.input.observed_at)) meta.input = { needed: req.inputNeeded, source: req.source, observed_at: observed, received_at: at };
    for (const { c, childAt, created } of children) {
      const old = meta.children.get(c.id);
      if (old && childAt <= old.observed_at) continue; // replay never freshens a child
      if (!old && meta.children.size >= 20) continue;
      meta.children.set(c.id, { ref: old?.ref ?? crypto.randomUUID(), name: privateText(r, c.name, 80, childIds) || 'Agent', task_title: privateText(r, c.taskTitle ?? '', 200, childIds), state: c.state, source: req.source, observed_at: childAt, received_at: at, created_at: old?.created_at ?? created });
    }
    emit(r);
    return { ok: true, status: 'reported', state: dto(r) };
  }

  function turnOf(r, turnId) {
    if (!r.turns.has(turnId)) {
      r.turns.set(turnId, { tag: crypto.randomUUID(), status: 'started', error: null, response: '', inputs: [], notices: [], finishedAt: null });
      while (r.turns.size > MAX_TURNS) r.turns.delete(r.turns.keys().next().value);
    }
    return r.turns.get(turnId);
  }
  const notice = (t, text) => { if (t.notices.length < MAX_NOTICES && !t.notices.includes(text)) t.notices.push(text); };
  // Provider ids (target, turn id, client id) stay in main.
  function publicDelivery(r, d) {
    const t = d.turnId ? r.turns.get(d.turnId) : null;
    const recorded = !!t && t.inputs.some((i) => i.clientId === d.clientId && i.text === d.text);
    let state = d.state;
    if (state === 'acknowledged' && t) state = FINAL.includes(t.status) ? t.status : t.response ? 'responding' : recorded ? 'recorded' : 'acknowledged';
    if (state === 'acknowledged' && r.ended) state = 'failed';
    return { id: d.id, text: d.text, by: d.by ?? null, mode: d.mode, state, recorded, turn: t?.tag ?? null, response: t?.response ?? '', error: t?.error ?? null, notices: t ? [...t.notices] : [], sentAt: d.sentAt, finishedAt: t?.finishedAt ?? null };
  }
  function dto(r) {
    const active = r.activeTurn ? r.turns.get(r.activeTurn) : null;
    const reportAt = r.reporting.input?.observed_at, time = now();
    const inputCurrent = Number.isSafeInteger(reportAt) && reportAt >= 0 && reportAt <= time && time - reportAt <= REPORT_RECENT_MS;
    // A turn someone else started on an existing session is shown as working, never as a turn Plexiform can steer or interrupt.
    const shown = active && (!r.existing || r.own.has(r.activeTurn)) ? active : null;
    return {
      session: r.id, generation: r.generation, provider: { id: r.provider, label: r.adapter.label },
      ownership: r.existing ? 'existing-unmanaged' : 'plexiform-owned', label: r.existing ? `Unmanaged — started outside Plexiform · ${r.adapter.label}` : `Started by Plexiform · ${r.adapter.label}`,
      ...(r.existing ? { thread: { ...r.existing, warnings: [...r.existing.warnings] } } : {}),
      board: r.board, status: r.ended ? 'ended' : active || r.foreignBusy ? 'working' : compaction?.inFlight(r) ? 'compacting' : 'ready', activeTurn: shown?.tag ?? null,
      capabilities: { ...r.adapter.capabilities },
      reporting: { task: r.reporting.task && { ...r.reporting.task }, input: r.reporting.input && { ...r.reporting.input }, children: [...r.reporting.children.values()].map((c) => ({ ...c })) },
      task_title: r.reporting.task?.title ?? null, input_needed: !r.ended && r.reporting.input?.needed === true && inputCurrent,
      deliveries: [...r.deliveries.values()].map((d) => publicDelivery(r, d)),
    };
  }
  const emit = (r) => { try { onEvent(r.actor, dto(r)); } catch { /* renderer gone */ } };

  function subscribe(r) {
    r.off = r.adapter.on((e) => {
      if (r.ended) return;
      if (e.kind === 'exit') { r.ended = true; r.activeTurn = null; emit(r); return; }
      if (e.kind === 'oversize') {
        // One shared provider process (Codex) cannot attribute it: every unfinished turn is told. A provider that names the target only touches that session.
        if (e.target !== undefined && e.target !== r.target) return;
        for (const t of r.turns.values()) if (!FINAL.includes(t.status)) notice(t, NOTICES.oversize);
        emit(r); return;
      }
      // Another session's (or a replaced target's) event never touches this one.
      if (e.target !== r.target) return;
      if (e.kind === 'closed') { r.ended = true; r.activeTurn = null; emit(r); return; }
      if (['task-report', 'child-report', 'input-needed'].includes(e.kind)) {
        // Only an exact target and its active owned turn may report telemetry.
        if (r.existing || !r.activeTurn || e.turnId !== r.activeTurn) return;
        report({ session: r.id, generation: r.generation, source: 'provider', ...(e.kind === 'task-report' ? { taskTitle: e.taskTitle } : e.kind === 'input-needed' ? { inputNeeded: e.needed } : { children: [e.child] }) }, r.actor);
        return;
      }
      // An existing thread can be busy with a turn another client started before Plexiform subscribed.
      if (e.kind === 'status' && r.existing) { r.foreignBusy = e.status === 'active' && !r.activeTurn; emit(r); return; }
      if (compaction?.claims(r, e)) { emit(r); return; }
      if (e.kind === 'usage' || e.kind === 'compacted' || typeof e.turnId !== 'string') return;
      const t = turnOf(r, e.turnId);
      if (e.kind === 'turn-started') { if (!r.existing && r.reportTurn !== e.turnId) { r.reporting = reporting(); r.reportTurn = e.turnId; } r.activeTurn = e.turnId; r.foreignBusy = false; }
      else if (e.kind === 'turn-completed') { t.status = FINAL.includes(e.status) ? e.status : 'failed'; t.error = e.error ? String(e.error).slice(0, 300) : null; t.finishedAt = now(); if (r.activeTurn === e.turnId) { if (!r.existing) r.reporting.input = { needed: false, source: 'provider', observed_at: t.finishedAt, received_at: t.finishedAt }; r.activeTurn = null; compaction?.idle(r); } }
      else if (e.kind === 'input-recorded') { if (t.inputs.length < 20) t.inputs.push({ clientId: e.clientId, text: e.text }); }
      else if (e.kind === 'delta') t.response = (t.response + String(e.text)).slice(0, MAX_RESPONSE);
      else if (e.kind === 'message') t.response = String(e.text).slice(0, MAX_RESPONSE);
      else if (e.kind === 'refused-request') notice(t, NOTICES.approval);
      else if (e.kind === 'approval-elsewhere') notice(t, NOTICES.approvalElsewhere);
      else return;
      emit(r);
    });
  }
  // Ends a session before any await: later acks and events see r.ended.
  async function end(r) {
    if (r.ended && !sessions.has(r.id)) return;
    const { target, activeTurn } = r;
    r.ended = true; r.activeTurn = null; r.off?.(); sessions.delete(r.id);
    const compactTurn = compaction?.drop(r);
    if (compactTurn) { try { await r.adapter.interrupt({ target, turnId: compactTurn }); } catch { /* provider gone */ } }
    // Closing Plexiform's view of a session someone else started leaves its work running.
    if (activeTurn && !r.existing) { try { await r.adapter.interrupt({ target, turnId: activeTurn }); } catch { /* provider gone */ } }
    try { await r.adapter.release?.({ target }); } catch { /* provider gone */ }
  }
  // Every request names session + generation and arrives with the main-owned
  // actor. Replacement of target, session, actor or board is refused.
  // `board:false` is for stopping a session (interrupt, close): its owner can always stop it, whichever board is showing.
  function lookup(req, actor, { board = true } = {}) {
    if (!object(req) || typeof req.session !== 'string' || !UUID.test(req.session) || !Number.isSafeInteger(req.generation)) return { error: refuse('invalid', ERRORS.invalid) };
    const r = sessions.get(req.session);
    if (!r) return { error: refuse('stale', ERRORS.stale) };
    if (typeof actor !== 'string' || actor !== r.actor) return { error: refuse('forbidden', ERRORS.forbidden) };
    if (r.ended || req.generation !== r.generation || !r.adapter.alive()) return { error: refuse('stale', ERRORS.stale) };
    if (board && !isCurrent(r.board)) return { error: refuse('stale', ERRORS.stale) };
    return { r };
  }

  function capabilities() {
    return Object.entries(adapters).map(([id, a]) => {
      const available = a.available !== false, existing = typeof a.open !== 'function';
      return { provider: id, label: a.label, available, reason: !available ? a.reason ?? 'Not installed' : '', ownership: existing ? 'existing-unmanaged' : 'plexiform-owned', ...(existing && typeof a.precondition === 'string' ? { precondition: a.precondition } : {}), capabilities: { ...a.capabilities } };
    });
  }

  async function launch(req, actor) {
    if (!closed(req, ['provider', 'board']) || typeof req.provider !== 'string' || !Object.hasOwn(adapters, req.provider) || (req.board != null && (typeof req.board !== 'string' || req.board.length > 200)) || typeof actor !== 'string') return refuse('invalid', ERRORS.invalid);
    const board = req.board ?? null;
    if (!isCurrent(board)) return refuse('stale', ERRORS.stale);
    const adapter = adapters[req.provider];
    if (typeof adapter.open !== 'function') return refuse('invalid', ERRORS.invalid);
    if (adapter.available === false) return refuse('unavailable', adapter.reason ?? ERRORS.unavailable);
    for (const r of [...sessions.values()]) if (r.ended) sessions.delete(r.id);
    if (sessions.size >= MAX_SESSIONS) return refuse('unavailable', 'Close an owned session first.');
    const id = crypto.randomUUID();
    let target;
    try { ({ target } = await adapter.open({ cwd: workspace(id) })); } catch { return refuse('unavailable', ERRORS.unavailable); }
    if (typeof target !== 'string' || !target) return refuse('unavailable', ERRORS.unavailable);
    const r = { id, generation: 1, provider: req.provider, adapter, target, actor, board, activeTurn: null, sending: false, ended: false, turns: new Map(), deliveries: new Map(), reporting: reporting() };
    sessions.set(id, r); subscribe(r);
    return { ok: true, status: 'launched', state: dto(r) };
  }

  // ── Existing sessions (opt-in providers only). Provider thread ids stay in
  // main: the renderer gets an opaque handle per discovered thread.
  const existingAdapter = (id) => (typeof id === 'string' && Object.hasOwn(adapters, id) && adapters[id].capabilities?.existingSessions === true && typeof adapters[id].discover === 'function' && typeof adapters[id].attach === 'function' ? adapters[id] : null);
  async function discover(req, actor) {
    if (!closed(req, ['provider']) || typeof actor !== 'string') return refuse('invalid', ERRORS.invalid);
    const adapter = existingAdapter(req.provider);
    if (!adapter) return refuse('invalid', ERRORS.invalid);
    if (adapter.available === false) return refuse('unavailable', adapter.reason ?? ERRORS.unavailable);
    let found;
    try { found = await adapter.discover(); } catch { return refuse('unavailable', ERRORS.unavailable); }
    for (const [h, v] of handles) if (v.actor === actor && v.provider === req.provider) handles.delete(h);
    const threads = [];
    for (const t of Array.isArray(found) ? found.slice(0, 50) : []) {
      if (!object(t) || typeof t.id !== 'string' || !t.id) continue;
      const handle = crypto.randomUUID();
      const meta = { title: typeof t.title === 'string' ? t.title.slice(0, 120) : '', project: typeof t.project === 'string' ? path.basename(t.project).slice(0, 120) : '' };
      handles.set(handle, { actor, provider: req.provider, target: t.id, meta });
      const open = [...sessions.values()].find((r) => !r.ended && r.actor === actor && r.provider === req.provider && r.target === t.id);
      threads.push({ handle, ...meta, status: ['idle', 'active', 'notLoaded', 'systemError'].includes(t.status) ? t.status : 'unknown', updatedAt: Number.isSafeInteger(t.updatedAt) ? t.updatedAt : null, open: open ? open.id : null });
    }
    return { ok: true, status: 'discovered', threads };
  }
  async function attach(req, actor) {
    if (!closed(req, ['provider', 'handle', 'board']) || typeof req.handle !== 'string' || !UUID.test(req.handle) || (req.board != null && (typeof req.board !== 'string' || req.board.length > 200)) || typeof actor !== 'string') return refuse('invalid', ERRORS.invalid);
    const adapter = existingAdapter(req.provider);
    if (!adapter) return refuse('invalid', ERRORS.invalid);
    const h = handles.get(req.handle);
    if (!h || h.provider !== req.provider) return refuse('stale', ERRORS.gone);
    if (h.actor !== actor) return refuse('forbidden', ERRORS.forbidden);
    const board = req.board ?? null;
    if (!isCurrent(board)) return refuse('stale', ERRORS.stale);
    if (adapter.available === false) return refuse('unavailable', adapter.reason ?? ERRORS.unavailable);
    // Concurrent attaches of one thread by one actor share a single attempt and so a single session.
    const key = JSON.stringify([actor, req.provider, h.target]);
    let attempt = attaching.get(key);
    if (!attempt) {
      attempt = attachOnce(adapter, req, h, actor, board).finally(() => attaching.delete(key));
      attaching.set(key, attempt);
    }
    const out = await attempt;
    return out.r ? { ok: true, status: 'attached', state: dto(out.r) } : out;
  }
  async function attachOnce(adapter, req, h, actor, board) {
    const already = [...sessions.values()].find((r) => !r.ended && r.actor === actor && r.provider === req.provider && r.target === h.target);
    if (already) return { r: already };
    for (const r of [...sessions.values()]) if (r.ended) sessions.delete(r.id);
    if (sessions.size >= MAX_SESSIONS) return refuse('unavailable', 'Close a session first.');
    let result;
    try { result = await adapter.attach({ target: h.target }); } catch { return refuse('unavailable', ERRORS.unavailable); }
    // Bound to the exact thread id that was discovered, never to its label or folder.
    if (result?.target !== h.target || handles.get(req.handle) !== h) {
      if (result?.target === h.target) { try { await adapter.release?.({ target: h.target }); } catch { /* provider gone */ } }
      return refuse('stale', ERRORS.stale);
    }
    const id = crypto.randomUUID();
    const r = { id, generation: 1, provider: req.provider, adapter, target: h.target, actor, board, activeTurn: null, foreignBusy: result.status === 'active', existing: { ...h.meta, ...disclosure(result.permissions) }, own: new Set(), sending: false, ended: false, turns: new Map(), deliveries: new Map(), reporting: reporting() };
    sessions.set(id, r); subscribe(r);
    return { r };
  }

  // `by` (main-only, never from a request): the teammate a shared session's
  // message came from (src/remote-interaction.js), shown as "Sent by <by>".
  async function send(req, actor, { by = null } = {}) {
    if (!closed(req, ['session', 'generation', 'board', 'text', 'expectedTurn']) || typeof req.text !== 'string' || req.text.includes('\0')) return refuse('invalid', ERRORS.invalid);
    const text = req.text.trim();
    if (!text || text.length > MAX_TEXT || Buffer.byteLength(text) > MAX_BYTES) return refuse('invalid', ERRORS.invalid);
    if (req.expectedTurn != null && (typeof req.expectedTurn !== 'string' || !UUID.test(req.expectedTurn))) return refuse('invalid', ERRORS.invalid);
    const { r, error } = lookup(req, actor);
    if (error) return error;
    if ((req.board ?? null) !== r.board) return refuse('stale', ERRORS.stale);
    // One provider request per session at a time.
    if (r.sending) return refuse('busy', ERRORS.busy);
    let expectedTurnId = null;
    if (req.expectedTurn != null) {
      expectedTurnId = [...r.turns].find(([, t]) => t.tag === req.expectedTurn)?.[0] ?? null;
      if (r.existing && ((r.activeTurn && !r.own.has(r.activeTurn)) || (expectedTurnId && !r.own.has(expectedTurnId)) || (!r.activeTurn && r.foreignBusy))) return refuse('busy', ERRORS.foreignTurn);
      if (!expectedTurnId || expectedTurnId !== r.activeTurn || !r.adapter.capabilities.steer) return refuse('stale', ERRORS.stale);
    } else if (r.activeTurn || r.foreignBusy) return refuse('busy', ERRORS.busy);
    // A background compaction finishes (bounded) or is abandoned before the
    // message goes out, so the message lands on the compacted context.
    if (compaction?.inFlight(r)) {
      const gen = r.generation;
      r.sending = true;
      try { await compaction.settle(r); } finally { r.sending = false; }
      if (r.ended || r.generation !== gen) return refuse('stale', ERRORS.stale);
      if (r.activeTurn) return refuse('busy', ERRORS.busy);
    }
    const target = r.target, generation = r.generation;
    const d = { id: crypto.randomUUID(), clientId: crypto.randomUUID(), text, by: typeof by === 'string' && by && by.length <= 80 ? by : null, mode: expectedTurnId ? 'steer' : 'new-turn', state: 'sending', turnId: null, sentAt: now() };
    r.deliveries.set(d.id, d);
    while (r.deliveries.size > MAX_DELIVERIES) r.deliveries.delete(r.deliveries.keys().next().value);
    r.sending = true;
    let ack, uncertain = false;
    try { ack = await r.adapter.send({ target, text, clientId: d.clientId, expectedTurnId }); } catch (e) { ack = null; uncertain = e?.code === 'DELIVERY_UNCONFIRMED'; } finally { r.sending = false; }
    if (uncertain) { d.state = 'unconfirmed'; emit(r); return refuse('unconfirmed', 'No receipt yet; Claude may still act. Do not resend automatically.'); }
    if (!ack) { d.state = 'refused'; emit(r); return refuse('unavailable', ERRORS.unavailable); }
    // Closed or replaced while the provider answered: the ack belongs only
    // to the old target, and a turn it started there is stopped.
    if (r.ended || r.target !== target || r.generation !== generation) {
      d.state = 'refused';
      if (!expectedTurnId && typeof ack.turnId === 'string') { try { await r.adapter.interrupt({ target, turnId: ack.turnId }); } catch { /* provider gone */ } }
      if (!r.ended) emit(r);
      return refuse('stale', ERRORS.stale);
    }
    if (typeof ack.turnId !== 'string' || (expectedTurnId && ack.turnId !== expectedTurnId)) { d.state = 'refused'; emit(r); return refuse('stale', ERRORS.stale); }
    d.turnId = ack.turnId; d.mode = ack.mode === 'steer' ? 'steer' : 'new-turn'; d.state = 'acknowledged';
    if (!r.existing && d.mode === 'new-turn') {
      if (r.reportTurn !== ack.turnId) { r.reporting = reporting(); r.reportTurn = ack.turnId; }
      r.reporting.task = { title: privateText(r, text), source: 'human', observed_at: d.sentAt, received_at: now() };
    }
    if (r.existing && !expectedTurnId) r.own.add(ack.turnId);
    turnOf(r, ack.turnId);
    if (!expectedTurnId && !FINAL.includes(r.turns.get(ack.turnId).status)) r.activeTurn = ack.turnId;
    // The turn can finish before its ack arrives (while sending): check again now.
    else if (!r.activeTurn) queueMicrotask(() => { compaction?.maybeStart(r).catch(() => {}); });
    emit(r);
    return { ok: true, status: 'acknowledged', delivery: publicDelivery(r, d), state: dto(r) };
  }

  async function interrupt(req, actor) {
    if (!closed(req, ['session', 'generation', 'turn']) || typeof req.turn !== 'string' || !UUID.test(req.turn)) return refuse('invalid', ERRORS.invalid);
    const { r, error } = lookup(req, actor, { board: false });
    if (error) return error;
    const active = r.activeTurn ? r.turns.get(r.activeTurn) : null;
    if (r.existing && ((r.activeTurn && !r.own.has(r.activeTurn)) || (!r.activeTurn && r.foreignBusy) || [...r.turns].some(([id, t]) => t.tag === req.turn && !r.own.has(id)))) return refuse('busy', ERRORS.foreignTurn);
    if (!active || active.tag !== req.turn || !r.adapter.capabilities.interrupt) return refuse('stale', ERRORS.stale);
    try { await r.adapter.interrupt({ target: r.target, turnId: r.activeTurn }); } catch { return refuse('unavailable', ERRORS.unavailable); }
    return { ok: true, status: 'interrupt-requested', state: dto(r) };
  }

  function state(req, actor) {
    if (!closed(req, ['session']) || typeof req.session !== 'string' || !UUID.test(req.session)) return null;
    const r = sessions.get(req.session);
    return r && r.actor === actor ? dto(r) : null;
  }
  const list = (actor) => [...sessions.values()].filter((r) => r.actor === actor).map(dto);

  async function close(req, actor) {
    if (!closed(req, ['session', 'generation'])) return refuse('invalid', ERRORS.invalid);
    const r = object(req) ? sessions.get(req.session) : null;
    if (r && r.actor === actor && r.ended && req.generation === r.generation) { await end(r); return { ok: true, status: 'closed' }; }
    const { error } = lookup(req, actor, { board: false });
    if (error) return error;
    await end(r);
    return { ok: true, status: 'closed' };
  }
  // A document that is gone or replaced can never act again: its sessions
  // and provider threads are ended and their slots freed.
  async function reap(keep) {
    for (const [h, v] of handles) if (!keep(v.actor)) handles.delete(h);
    await Promise.all([...sessions.values()].filter((r) => !keep(r.actor)).map(end));
  }
  function stopAll() {
    for (const r of sessions.values()) { r.ended = true; r.off?.(); }
    sessions.clear(); handles.clear();
    for (const a of Object.values(adapters)) { try { a.stop?.(); } catch { /* gone */ } }
  }

  // Main-only seams (never over IPC): the provider target for proof logs, and
  // target replacement (provider relaunch), which bumps the generation.
  const targetOf = (id) => sessions.get(id)?.target ?? null;
  const reportTurnOf = (id) => sessions.get(id)?.reportTurn ?? null;
  async function replaceTarget(id) {
    const r = sessions.get(id);
    if (!r || r.ended || r.existing) return false;
    const old = { target: r.target, activeTurn: r.activeTurn };
    r.generation++; r.activeTurn = null; r.reportTurn = null; r.turns.clear(); r.deliveries.clear(); r.reporting = reporting(); r.target = null;
    const compactTurn = compaction?.drop(r);
    if (compactTurn) { try { await r.adapter.interrupt({ target: old.target, turnId: compactTurn }); } catch { /* provider gone */ } }
    if (old.activeTurn) { try { await r.adapter.interrupt({ target: old.target, turnId: old.activeTurn }); } catch { /* provider gone */ } }
    try { await r.adapter.release?.({ target: old.target }); } catch { /* provider gone */ }
    let target = null;
    try { ({ target } = await r.adapter.open({ cwd: workspace(id) })); } catch { /* below */ }
    if (r.ended) return false;
    if (typeof target !== 'string' || !target) { await end(r); return false; }
    r.target = target;
    emit(r);
    return true;
  }

  // Main calls this when the compactor setting changes: running compactions
  // of a provider that is now off are stopped.
  const compactionSettingsChanged = () => compaction?.settingsChanged([...sessions.values()]) ?? Promise.resolve();

  return { capabilities, launch, discover, attach, send, interrupt, state, list, close, reap, stopAll, targetOf, reportTurnOf, replaceTarget, report, compactionSettingsChanged };
}

module.exports = { createInteractionHub, ERRORS, NOTICES, cleanReportText, REPORT_SOURCES, CHILD_STATES };
