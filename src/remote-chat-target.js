'use strict';
// T4c (outputs/plan-t4c.md Rev 1): a Plexiform chat (a Tasks engine task) as a shared-session target. It is the
// same {state, send, interrupt, targetOf} face src/remote-interaction.js already serves a shared session from, so
// the host's share checks, projection and receipts apply unchanged.
//
// Inert until T4c-2: only register() makes a chat reachable, and only the owner's confirmed Share calls it. Nothing
// in T4c-1 does. What a teammate sees starts strictly after the share (S3/C-M3): the subscription starts after the
// task's lastSeq at register time, and the state below is a closed key list with no title, folder, branch or prompt.
//
// Sending (C-M1/C-M2): the engine decides, under its task lock, whether the chat can take the message at once; if
// not it answers SESSION_BUSY and nothing is recorded. The teammate's id and name ride only in the message's
// `from` label (never the prompt). There is no stop or steer for a teammate (Q2, S5).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = 'chat';
const MAX_CHATS = 8, MAX_DELIVERIES = 20, MAX_TEXT = 4000, MAX_BYTES = 8192, MAX_RESPONSE = 16000;
const ENDED = new Set(['done', 'failed', 'handed_over']);
// A pause, a handover or a provider switch makes earlier composer state stale.
const REGEN = new Set(['parked', 'suspended', 'handing_over', 'handed_over']);
const LABEL = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', hermes: 'Hermes' };
const ERRORS = {
  invalid: 'Check the selected session and message.',
  stale: 'This chat changed. Refresh and try again.',
  busy: 'The chat is working. Send when it has finished.',
  forbidden: 'This chat can no longer take messages from teammates.',
  unavailable: 'The chat did not accept the message.',
  unsupported: "Only the chat's owner can stop it.",
};
const refuse = (status, error) => ({ ok: false, status, error });
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).every((k) => keys.includes(k));
const keyOf = (row) => `${row.ai?.id}|${row.permissionLevel}|${row.workInPlace === true}`;

/**
 * tasks: {
 *   row(id) → the sanitized task row (state, ai, permissionLevel, workInPlace, lastSeq) | null   (synchronous)
 *   detail(id) → Promise<{sessionId, workInPlace, lastSeq} | null>
 *   watch(id, fromSeq, onEvent, onReset) → Promise<{stop()}>
 *   shareMessage(id, body, share, requestId) → Promise<{ok:true, messageId} | {ok:false, code}>
 * }
 */
function createRemoteChatTargets({ tasks, now = Date.now, enabled = () => true }) {
  const chats = new Map(); // session uuid → entry

  function entryFor(session, actor) {
    if (actor !== ACTOR || typeof session !== 'string') return null;
    const c = chats.get(session);
    return c && !c.dropped && tasks.row(c.taskId) ? c : null;
  }
  function freshen(c, row) {
    const k = keyOf(row);
    if (k !== c.key) { c.key = k; c.generation++; }
  }
  function statusOf(row) {
    if (ENDED.has(row.state)) return 'ended';
    return row.state === 'in_review' ? 'ready' : 'working';
  }
  function publicDelivery(d) {
    return { id: d.id, text: d.text, by: d.by, mode: 'new-turn', stoppedBy: null, state: d.state, recorded: d.recorded, turn: d.turn, response: d.response, error: null, notices: [], sentAt: d.sentAt, finishedAt: d.finishedAt };
  }
  function state({ session } = {}, actor) {
    if (!enabled()) return null;
    const c = entryFor(session, actor);
    if (!c) return null;
    const row = tasks.row(c.taskId);
    freshen(c, row);
    const id = typeof row.ai?.id === 'string' ? row.ai.id : 'ai';
    // Closed keys (S3): no board, title, folder, branch, owner or principal.
    return {
      session, generation: c.generation, provider: { id, label: LABEL[id] ?? 'AI' }, status: statusOf(row), activeTurn: null,
      capabilities: { send: true, steer: false, interrupt: false }, board: null,
      activity: null, reporting: { task: null, input: null, children: [] }, task_title: null, input_needed: false,
      deliveries: c.deliveries.filter((d) => !d.hidden).map(publicDelivery),
    };
  }

  function addDelivery(c, d) {
    const had = c.deliveries.find((x) => x.id === d.id);
    if (had) return had;
    c.deliveries.push(d);
    while (c.deliveries.length > MAX_DELIVERIES) c.deliveries.shift();
    return d;
  }
  function onEvent(c, e) {
    if (!object(e) || !Number.isSafeInteger(e.seq) || e.seq <= c.boundarySeq) return; // never anything from before the share
    c.lastSeq = Math.max(c.lastSeq, e.seq);
    if (e.type === 'message' && e.direction === 'in') {
      // Q3: the owner's and teammates' messages only; agent relays are not shown.
      const fromShare = e.from?.kind === 'member' && c.sent.has(e.id);
      // A teammate's message can arrive before its send() returns: kept hidden (it still collects its response)
      // until that send names it, and never shown otherwise. Agent relays and other parties are never shown.
      const pendingMember = e.from?.kind === 'member' && !fromShare;
      if (e.from?.kind !== 'human' && e.from?.kind !== 'member') return;
      const d = addDelivery(c, { id: String(e.id), text: String(e.body ?? '').slice(0, MAX_TEXT), by: fromShare ? c.sent.get(e.id) : null, hidden: pendingMember, seq: e.seq, state: 'recorded', recorded: true, turn: null, response: '', sentAt: Number.isSafeInteger(e.createdAt) ? e.createdAt : now(), finishedAt: null });
      d.seq = e.seq;
      if (d.state === 'acknowledged') d.state = 'recorded';
    } else if (e.type === 'transcript' && e.role === 'assistant' && typeof e.text === 'string') {
      const d = [...c.deliveries].reverse().find((x) => x.seq != null && x.seq < e.seq && x.finishedAt == null);
      if (!d) return;
      if (d.turn == null && Number.isSafeInteger(e.turn)) d.turn = String(e.turn);
      d.response = (d.response + e.text).slice(0, MAX_RESPONSE);
      d.state = 'responding';
    } else if (e.type === 'state' && typeof e.state === 'string') {
      if (e.state === 'in_review' || ENDED.has(e.state)) {
        for (const d of c.deliveries) if (d.finishedAt == null && d.seq != null && d.seq < e.seq) { d.finishedAt = now(); d.state = e.state === 'failed' ? 'failed' : 'completed'; }
      }
      if (REGEN.has(e.state)) c.generation++;
    }
  }

  async function register(taskId) {
    if (!enabled() || typeof taskId !== 'string' || !taskId) return { ok: false };
    const d = await tasks.detail(taskId);
    if (!d || d.workInPlace === true || typeof d.sessionId !== 'string' || !UUID.test(d.sessionId) || !Number.isSafeInteger(d.lastSeq)) return { ok: false };
    const row = tasks.row(taskId);
    if (!row || row.workInPlace === true) return { ok: false };
    const had = chats.get(d.sessionId);
    if (had && !had.dropped) return { ok: true, session: d.sessionId };
    if (chats.size >= MAX_CHATS) return { ok: false, full: true };
    const c = { taskId, boundarySeq: d.lastSeq, lastSeq: d.lastSeq, generation: 1, key: keyOf(row), deliveries: [], sent: new Map(), sub: null, dropped: false };
    chats.set(d.sessionId, c);
    try {
      c.sub = await tasks.watch(taskId, d.lastSeq + 1, (e) => onEvent(c, e), () => { c.generation++; });
    } catch { chats.delete(d.sessionId); return { ok: false }; }
    return { ok: true, session: d.sessionId };
  }
  function unregister(session) {
    const c = chats.get(session);
    if (!c) return;
    c.dropped = true; chats.delete(session);
    try { c.sub?.stop(); } catch { /* the link is gone */ }
  }

  // `by`, `byId`, `share`, `frame`: main-only, from the host's own share record and the relayed frame (never a request).
  async function send(req, actor, { by = null, byId = null, share = null, frame = null, fresh = () => true } = {}) {
    if (fresh() !== true) return refuse('stale', ERRORS.stale);
    if (!closed(req, ['session', 'generation', 'board', 'text', 'expectedTurn'])) return refuse('invalid', ERRORS.invalid);
    if (req.expectedTurn !== undefined) return refuse('stale', ERRORS.stale); // no steering a shared chat
    const c = enabled() ? entryFor(req.session, actor) : null;
    if (!c) return refuse('stale', ERRORS.stale);
    if (typeof by !== 'string' || !by || typeof byId !== 'string' || !byId || typeof share !== 'string' || !share || typeof frame !== 'string' || !frame) return refuse('invalid', ERRORS.invalid);
    const text = typeof req.text === 'string' ? req.text.trim() : '';
    if (!text || req.text.includes('\0') || text.length > MAX_TEXT || Buffer.byteLength(text) > MAX_BYTES) return refuse('invalid', ERRORS.invalid);
    const row = tasks.row(c.taskId);
    freshen(c, row);
    if (req.generation !== c.generation || (req.board ?? null) !== null || statusOf(row) === 'ended') return refuse('stale', ERRORS.stale);
    if (row.workInPlace === true) return refuse('forbidden', ERRORS.forbidden);
    const r = await tasks.shareMessage(c.taskId, text, {
      key: share.slice(0, 128), by: { memberId: byId.slice(0, 128), name: by.slice(0, 80) },
      expect: { permissionLevel: row.permissionLevel, ai: row.ai?.id },
    }, `share:${share}:${frame}`.slice(0, 128));
    if (!r?.ok) {
      const code = r?.code;
      return code === 'SESSION_BUSY' ? refuse('busy', ERRORS.busy) : code === 'CONFLICT' ? refuse('stale', ERRORS.stale)
        : code === 'POLICY_DENIED' ? refuse('forbidden', ERRORS.forbidden) : refuse('unavailable', ERRORS.unavailable);
    }
    // The engine recorded it: the receipt says so even if the chat changed meanwhile (it can't be unsent).
    c.sent.set(r.messageId, by.slice(0, 80));
    while (c.sent.size > MAX_DELIVERIES * 2) c.sent.delete(c.sent.keys().next().value);
    const d = addDelivery(c, { id: String(r.messageId), text, by: by.slice(0, 80), seq: null, state: 'acknowledged', recorded: true, turn: null, response: '', sentAt: now(), finishedAt: null });
    d.hidden = false; d.by = by.slice(0, 80);
    return { ok: true, status: 'acknowledged', delivery: publicDelivery(d), state: state({ session: req.session }, actor) };
  }

  const hub = {
    state,
    send,
    async interrupt() { return refuse('unsupported', ERRORS.unsupported); },
    targetOf() { return null; },
    list() { return []; },
  };
  return {
    hub, register, unregister,
    // For main's sharedTarget: a registered chat only, never anything else.
    target(session) { return enabled() && entryFor(session, ACTOR) ? { hub, actor: ACTOR } : null; },
    size: () => chats.size,
  };
}

module.exports = { createRemoteChatTargets, ACTOR };
