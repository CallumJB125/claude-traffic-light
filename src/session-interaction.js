'use strict';
// Provider-neutral interaction contract for sessions Plexiform itself owns.
//
// Adapter shape (Codex now; Claude Code / Gemini ACP / local models later):
//   provider, label, available?, reason?, capabilities {newTurn, steer, interrupt, ack, echo, stream, existingSessions}
//   open({cwd}) -> {target}                      provider session/thread id, never sent to a renderer
//   send({target, text, clientId, expectedTurnId}) -> {turnId, mode: 'new-turn'|'steer'}
//   interrupt({target, turnId}), release?({target}), stop(), alive(), on(fn) -> off
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TEXT = 4000, MAX_BYTES = 8192, MAX_RESPONSE = 16000, MAX_DELIVERIES = 20, MAX_TURNS = 40, MAX_SESSIONS = 8, MAX_NOTICES = 5;
const FINAL = ['completed', 'interrupted', 'failed'];
const NOTICES = {
  approval: 'The provider asked for an approval; Plexiform refused it.',
  oversize: 'A provider update was too large to show and was dropped.',
};
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).every((k) => keys.includes(k));
const refuse = (status, error) => ({ ok: false, status, error });
const ERRORS = {
  invalid: 'Check the selected session and message.',
  forbidden: 'This session belongs to a different Plexiform window.',
  stale: 'This session changed. Refresh and select it again.',
  busy: 'A message is being sent or a turn is running. Steer it or wait for it to finish.',
  unavailable: 'The provider did not accept the message.',
};

// boardCurrent must be supplied by main; without it every session is refused.
// compaction: an optional createSessionCompactor() (src/compaction.js).
function createInteractionHub({ adapters = {}, workspace = () => null, boardCurrent = () => false, onEvent = () => {}, now = Date.now, compaction = null } = {}) {
  const sessions = new Map();
  const isCurrent = (board) => { try { return boardCurrent(board) === true; } catch { return false; } };

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
    return {
      session: r.id, generation: r.generation, provider: { id: r.provider, label: r.adapter.label },
      ownership: 'plexiform-owned', label: `Started by Plexiform · ${r.adapter.label}`,
      board: r.board, status: r.ended ? 'ended' : active ? 'working' : compaction?.inFlight(r) ? 'compacting' : 'ready', activeTurn: active?.tag ?? null,
      capabilities: { ...r.adapter.capabilities },
      deliveries: [...r.deliveries.values()].map((d) => publicDelivery(r, d)),
    };
  }
  const emit = (r) => { try { onEvent(r.actor, dto(r)); } catch { /* renderer gone */ } };

  function attach(r) {
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
      if (compaction?.claims(r, e)) { emit(r); return; }
      if (e.kind === 'usage' || e.kind === 'compacted' || typeof e.turnId !== 'string') return;
      const t = turnOf(r, e.turnId);
      if (e.kind === 'turn-started') r.activeTurn = e.turnId;
      else if (e.kind === 'turn-completed') { t.status = FINAL.includes(e.status) ? e.status : 'failed'; t.error = e.error ? String(e.error).slice(0, 300) : null; t.finishedAt = now(); if (r.activeTurn === e.turnId) { r.activeTurn = null; compaction?.idle(r); } }
      else if (e.kind === 'input-recorded') { if (t.inputs.length < 20) t.inputs.push({ clientId: e.clientId, text: e.text }); }
      else if (e.kind === 'delta') t.response = (t.response + String(e.text)).slice(0, MAX_RESPONSE);
      else if (e.kind === 'message') t.response = String(e.text).slice(0, MAX_RESPONSE);
      else if (e.kind === 'refused-request') notice(t, NOTICES.approval);
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
    if (activeTurn) { try { await r.adapter.interrupt({ target, turnId: activeTurn }); } catch { /* provider gone */ } }
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
    return Object.entries(adapters).map(([id, a]) => ({ provider: id, label: a.label, available: a.available !== false, reason: a.available === false ? a.reason ?? 'Not installed' : '', ownership: 'plexiform-owned', capabilities: { ...a.capabilities } }));
  }

  async function launch(req, actor) {
    if (!closed(req, ['provider', 'board']) || typeof req.provider !== 'string' || !Object.hasOwn(adapters, req.provider) || (req.board != null && (typeof req.board !== 'string' || req.board.length > 200)) || typeof actor !== 'string') return refuse('invalid', ERRORS.invalid);
    const board = req.board ?? null;
    if (!isCurrent(board)) return refuse('stale', ERRORS.stale);
    const adapter = adapters[req.provider];
    if (adapter.available === false) return refuse('unavailable', adapter.reason ?? ERRORS.unavailable);
    for (const r of [...sessions.values()]) if (r.ended) sessions.delete(r.id);
    if (sessions.size >= MAX_SESSIONS) return refuse('unavailable', 'Close an owned session first.');
    const id = crypto.randomUUID();
    let target;
    try { ({ target } = await adapter.open({ cwd: workspace(id) })); } catch { return refuse('unavailable', ERRORS.unavailable); }
    if (typeof target !== 'string' || !target) return refuse('unavailable', ERRORS.unavailable);
    const r = { id, generation: 1, provider: req.provider, adapter, target, actor, board, activeTurn: null, sending: false, ended: false, turns: new Map(), deliveries: new Map() };
    sessions.set(id, r); attach(r);
    return { ok: true, status: 'launched', state: dto(r) };
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
      if (!expectedTurnId || expectedTurnId !== r.activeTurn || !r.adapter.capabilities.steer) return refuse('stale', ERRORS.stale);
    } else if (r.activeTurn) return refuse('busy', ERRORS.busy);
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
    let ack;
    try { ack = await r.adapter.send({ target, text, clientId: d.clientId, expectedTurnId }); } catch { ack = null; } finally { r.sending = false; }
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
    await Promise.all([...sessions.values()].filter((r) => !keep(r.actor)).map(end));
  }
  function stopAll() {
    for (const r of sessions.values()) { r.ended = true; r.off?.(); }
    sessions.clear();
    for (const a of Object.values(adapters)) { try { a.stop?.(); } catch { /* gone */ } }
  }

  // Main-only seams (never over IPC): the provider target for proof logs, and
  // target replacement (provider relaunch), which bumps the generation.
  const targetOf = (id) => sessions.get(id)?.target ?? null;
  async function replaceTarget(id) {
    const r = sessions.get(id);
    if (!r || r.ended) return false;
    const old = { target: r.target, activeTurn: r.activeTurn };
    r.generation++; r.activeTurn = null; r.turns.clear(); r.deliveries.clear(); r.target = null;
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

  return { capabilities, launch, send, interrupt, state, list, close, reap, stopAll, targetOf, replaceTarget, compactionSettingsChanged };
}

module.exports = { createInteractionHub, ERRORS, NOTICES };
