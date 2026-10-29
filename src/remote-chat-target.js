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

const crypto = require('node:crypto');

const ACTOR = 'chat';
const MAX_CHATS = 8, MAX_DELIVERIES = 20, MAX_TEXT = 4000, MAX_BYTES = 8192, MAX_RESPONSE = 16000;
const ENDED = new Set(['done', 'failed', 'handed_over']);
// A pause, a handover or a provider switch makes earlier composer state stale.
const REGEN = new Set(['parked', 'suspended', 'handing_over', 'handed_over']);
const WAITING = new Set(['queued', 'parked', 'blocked', 'suspended']);
const OWN_SOURCES = new Set(['local', 'cli']); // a chat started on this computer, not one a relay created
const PERMISSION = { plan: 'Plan only', ask: 'Ask me first', 'auto-edits': 'Edit files' };
const LABEL = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', hermes: 'Hermes' };
const ERRORS = {
  invalid: 'Check the selected session and message.',
  stale: 'This chat changed. Refresh and try again.',
  busy: 'The chat is working. Send when it has finished.',
  // N3: refused because the chat is queued, paused or blocked, not because it is mid-turn.
  waiting: "The chat is waiting, not idle. Send when it's idle.",
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
 *   detail(id) → Promise<{workInPlace, lastSeq} | null>
 *   watch(id, fromSeq, onEvent, onReset) → Promise<{stop()}>
 *   shareMessage(id, body, share, requestId) → Promise<{ok:true, messageId} | {ok:false, code}>
 * }
 */
function createRemoteChatTargets({ tasks, now = Date.now, enabled = () => true }) {
  const chats = new Map(); // share session uuid → entry
  // T4c-2 §0: the hub's `session` for a chat is a random UUID minted here, one per chat for this process (re-sharing
  // reuses it, so a new share replaces the team's old one), never the provider's session id.
  const byTask = new Map(); // taskId → share session uuid

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
    // `kind` (C2-S2) only lets the teammate's app call it a chat; older apps ignore unknown keys.
    return {
      kind: 'chat', session, generation: c.generation, provider: { id, label: LABEL[id] ?? 'AI' }, status: statusOf(row), activeTurn: null,
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
    if (!d || d.workInPlace === true || !Number.isSafeInteger(d.lastSeq)) return { ok: false };
    const row = tasks.row(taskId);
    if (!row || row.workInPlace === true) return { ok: false };
    let session = byTask.get(taskId);
    const had = session && chats.get(session);
    if (had && !had.dropped) { had.pinned = true; return { ok: true, session }; }
    if (chats.size >= MAX_CHATS) return { ok: false, full: true };
    if (!session) { session = crypto.randomUUID(); byTask.set(taskId, session); }
    // `pinned`: the owner's Share is between register() and the hub's answer; the sweep leaves it alone until release().
    const c = { taskId, boundarySeq: d.lastSeq, lastSeq: d.lastSeq, generation: 1, key: keyOf(row), deliveries: [], sent: new Map(), sub: null, dropped: false, pinned: true };
    chats.set(session, c);
    try {
      c.sub = await tasks.watch(taskId, d.lastSeq + 1, (e) => onEvent(c, e), () => { c.generation++; });
    } catch { chats.delete(session); return { ok: false }; }
    if (chats.get(session) !== c) { try { c.sub?.stop(); } catch { /* gone */ } return { ok: false }; }
    return { ok: true, session };
  }
  // C2-M1: dropping a chat ends its subscription and its deliveries; its share id is kept (byTask), so a later
  // Share reuses it and subscribes again from the chat's lastSeq then.
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
      // C2-S5: which busy it is comes from one read of the row after the refusal.
      if (code === 'SESSION_BUSY') return refuse('busy', WAITING.has(tasks.row(c.taskId)?.state) ? ERRORS.waiting : ERRORS.busy);
      return code === 'CONFLICT' ? refuse('stale', ERRORS.stale)
        : code === 'POLICY_DENIED' ? refuse('forbidden', ERRORS.forbidden) : refuse('unavailable', ERRORS.unavailable);
    }
    // The engine recorded it: the receipt says so even if the chat changed meanwhile (it can't be unsent).
    c.sent.set(r.messageId, by.slice(0, 80));
    while (c.sent.size > MAX_DELIVERIES * 2) c.sent.delete(c.sent.keys().next().value);
    const d = addDelivery(c, { id: String(r.messageId), text, by: by.slice(0, 80), seq: null, state: 'acknowledged', recorded: true, turn: null, response: '', sentAt: now(), finishedAt: null });
    d.hidden = false; d.by = by.slice(0, 80);
    return { ok: true, status: 'acknowledged', delivery: publicDelivery(d), state: state({ session: req.session }, actor) };
  }

  const liveShares = (host, session, t = now()) => {
    let list = [];
    try { list = host?.shared?.() ?? []; } catch { list = []; }
    return (Array.isArray(list) ? list : []).filter((x) => object(x) && typeof x.id === 'string' && x.session === session && (x.expiresAt === null || (Number.isFinite(x.expiresAt) && x.expiresAt > t)));
  };
  // C2-M1/C2-S1: after the owner's Share (either way) or Stop sharing, a chat with no live share is dropped: no
  // subscription and no deliveries are kept while nobody can watch.
  function release(session, host) {
    const c = chats.get(session);
    if (!c) return;
    c.pinned = false;
    if (!liveShares(host, session).length) unregister(session);
  }
  // Main's 5 s pass (plan §2.5, C2-S4). A chat that ended, or that the connected Tasks helper no longer lists, has
  // its shares stopped and is dropped; an unreachable helper is not a reason. A new host (sign-out, another account)
  // drops every chat: the old host's shares went with it.
  let lastHost, swept = false;
  function sweep(host, connected) {
    const changed = swept && host !== lastHost;
    lastHost = host; swept = true;
    for (const [session, c] of [...chats]) {
      if (c.dropped) continue;
      if (changed || !host) { unregister(session); continue; }
      const row = tasks.row(c.taskId);
      const gone = row ? ENDED.has(row.state) : connected === true;
      if (gone) {
        for (const x of liveShares(host, session)) { try { host.stopSharing(x.id); } catch { /* already stopped */ } }
        unregister(session);
      } else if (!c.pinned && !liveShares(host, session).length) unregister(session);
    }
  }
  // The owner's thread (thread-owner-main targetOf): a chat this computer started that is still going. A read: it
  // never registers. `session` is null until the first confirmed Share.
  function ownerTarget(taskId) {
    if (!enabled() || typeof taskId !== 'string') return null;
    const row = tasks.row(taskId);
    if (!row || !OWN_SOURCES.has(row.source) || ENDED.has(row.state)) return null;
    const id = typeof row.ai?.id === 'string' ? row.ai.id : '';
    return {
      chat: true, taskId, session: byTask.get(taskId) ?? null, provider: LABEL[id] ?? 'AI', workInPlace: row.workInPlace === true,
      folder: typeof row.repo?.name === 'string' && row.repo.name ? row.repo.name.slice(0, 120) : 'its folder',
      permission: PERMISSION[row.permissionLevel] ?? 'Edit files',
    };
  }

  const hub = {
    state,
    send,
    async interrupt() { return refuse('unsupported', ERRORS.unsupported); },
    targetOf() { return null; },
    list() { return []; },
  };
  return {
    hub, register, unregister, release, sweep, ownerTarget,
    // For main's sharedTarget: a registered chat only, never anything else.
    target(session) { return enabled() && entryFor(session, ACTOR) ? { hub, actor: ACTOR } : null; },
    // The owner side's read: this chat's share id, if it was ever shared in this process. A lookup only: it never
    // registers or subscribes.
    sessionOf(taskId) { return enabled() && typeof taskId === 'string' ? byTask.get(taskId) ?? null : null; },
    registered: () => [...chats].filter(([, c]) => !c.dropped).map(([session, c]) => ({ session, taskId: c.taskId })),
    taskOf(session) { const c = enabled() ? entryFor(session, ACTOR) : null; return c ? c.taskId : null; },
    size: () => chats.size,
  };
}

module.exports = { createRemoteChatTargets, ACTOR };
