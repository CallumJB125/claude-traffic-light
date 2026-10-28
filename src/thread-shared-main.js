'use strict';
// T3 (plan-t3 §2): send, steer, stop and propose inside a teammate's shared thread, for an interact share only.
// thread-main owns Guard T; this file holds the thread's own selections and its per-document authority from the
// Overview service (its own controls and coordinator, src/overview-service.js sharedThreadAuthority).
//
// A thread selection wraps the subsystem's one-use token and binds, at review: the operation, the exact text,
// the document and its authority. Confirm takes only the selection and the text, never an operation. Main arms it
// 600 ms after it delivered the card. It's consumed before the first await. A retired, expired or foreign
// selection is refused and nothing is dispatched. Nothing here retries.
const crypto = require('node:crypto');
const { turnTag } = require('./shared-thread-view');

const ARM_MS = 600;
const SELECTION_MS = 45_000;
// T3b (plan-t3b): after one carded send, steer or stop is accepted, later ones in this thread skip the card.
const WINDOW_MS = 30 * 60_000; // absolute, from the first accepted send
const DIRECT_MS = 5_000;       // a card-less selection is confirmed at once or not at all
const PROPOSALS_MIN_MS = 10_000;
const MAX_TEXT = 4000;
const MAX_BYTES = 8192;
const MAX_PER_DOC = 16;
const OPS = Object.freeze(['send', 'steer', 'stop', 'propose', 'queue']);
const QUEUE_NOTICE = 'Sent once, when the session is idle, while Plexiform is running and you are signed in as you. If the share ends, becomes watch-only or you sign in as someone else, it is dropped and not sent.';
const QUEUE_STATE = Object.freeze({ queued: 'queued', blocked: 'queued', sending: 'sending', acknowledged: 'received', unconfirmed: 'unconfirmed', refused: 'not-sent', expired: 'not-sent' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = Object.freeze(['stale', 'forbidden', 'busy', 'unavailable', 'unconfirmed', 'invalid', 'unsupported', 'refused']);
const TEXT = Object.freeze({
  WATCH: 'Shared with you to watch only. The owner can choose Allow sending.',
  MOVED: 'This session moved on. Your draft is kept; review it again.',
  BUSY: 'Another action on this session is awaiting a receipt. Inspect it before sending again.',
  UNCONFIRMED: 'No receipt yet. The provider may have acted. Inspect this session before sending again.',
  OWNER_ACTED: 'The owner has already acted on this proposal.',
  UNAVAILABLE: 'This action is unavailable for this shared session right now.',
  INVALID: 'Check the message and try again.',
  NOT_READY: 'Take a moment to read the card, then confirm.',
  REVIEW_AGAIN: 'Review needed again. Your draft is kept.',
  IN_FLIGHT: 'Still sending your last message.',
  STEER_NOTE: 'This does not confirm the requested change was applied.',
  QUEUE_FAILED: 'Could not queue it. Check the queue before trying again.',
});
// The hub's proposal statuses, as the requester sees them (board/hub/interaction-proposals.js).
const PROPOSAL_STATUS = Object.freeze({ pending: 'awaiting', approved: 'approved', expired: 'expired', revoked: 'rejected', superseded: 'expired', dispatching: 'sending', sent: 'sent', refused: 'refused', unconfirmed: 'unconfirmed' });

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const line = (v, max) => (typeof v === 'string' ? v.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const prose = (v, max) => (typeof v === 'string' ? v.replace(CONTROL, '').slice(0, max) : '');
const fail = (status, error) => ({ ok: false, status, error });
const textOk = (t) => typeof t === 'string' && !t.includes('\0') && !!t.trim() && t.trim().length <= MAX_TEXT && Buffer.byteLength(t.trim()) <= MAX_BYTES;
// A subsystem failure, reduced to the fixed keys.
function mapped(out, fallback = TEXT.UNAVAILABLE) {
  const status = STATUSES.includes(out?.status) ? out.status : 'unavailable';
  const error = status === 'busy' ? TEXT.BUSY : status === 'unconfirmed' ? TEXT.UNCONFIRMED : line(out?.error, 300) || fallback;
  return fail(status, error);
}

function createSharedThreadActions({ authority = null, now = Date.now } = {}) {
  const auths = new Map(); // `${wcId}:${generation}` → { boundId, auth }
  const selections = new Map(); // selection → record
  const proposalReads = new Map(); // docKey → { at, pending, result }
  const queueReads = new Map(); // docKey → { at, pending, result }
  const queueSecrets = new Map(); // docKey → random key for this document's opaque queue row keys
  let askEach = false; // T3b: "Ask me each time" (this run of the app; off by default). On, no window opens.
  const docKey = (c) => `${c.contents.id}:${c.generation}`;

  function drop(key) {
    for (const [s, rec] of selections) if (rec.doc === key) selections.delete(s);
  }
  function forget(key) {
    const held = auths.get(key);
    if (held) { try { held.auth.invalidate(); } catch { /* gone */ } }
    auths.delete(key); proposalReads.delete(key); queueReads.delete(key); queueSecrets.delete(key); drop(key);
  }
  // The thread's authority for its bound row, built once per document; rebuilt only when the bound route changed
  // (and then every selection the old one minted is dropped).
  function authOf(c, still) {
    const key = docKey(c);
    let held = auths.get(key);
    if (held && (held.boundId !== c.boundId || !safeLive(held.auth))) { forget(key); held = null; }
    if (held) return held.auth;
    if (typeof authority !== 'function') return null;
    for (const k of [...auths.keys()]) if (k.startsWith(`${c.contents.id}:`)) forget(k);
    let auth = null;
    try { auth = authority(c.boundId, { read: () => still(c), effect: () => still(c, true) }) ?? null; } catch { auth = null; }
    if (!auth) return null;
    auths.set(key, { boundId: c.boundId, auth });
    return auth;
  }
  const safeLive = (a) => { try { return a.live() === true; } catch { return false; } };
  function prune(key) {
    const t = now();
    for (const [s, rec] of selections) if (rec.expires < t) selections.delete(s);
    const mine = [...selections].filter(([, r]) => r.doc === key);
    for (const [s] of mine.slice(0, Math.max(0, mine.length - MAX_PER_DOC))) selections.delete(s);
  }
  function mint(c, auth, rec) {
    const key = docKey(c), selection = crypto.randomUUID();
    prune(key);
    selections.set(selection, { ...rec, doc: key, boundId: c.boundId, auth, deliveredAt: now() });
    return selection;
  }

  // The card: every string from main, set with textContent by the page.
  function card(op, owner, provider, text) {
    const target = `${owner}'s ${provider} session`;
    const C = {
      send: { title: `Send to ${owner}'s session`, target, notes: [], confirm: 'Send' },
      steer: { title: `Steer ${owner}'s current turn`, target: `${target} · this current turn only`, notes: [TEXT.STEER_NOTE], confirm: 'Steer this turn' },
      stop: { title: `Stop ${owner}'s current turn`, target: `${target} · this current turn only`, notes: ['Asks the provider to stop the current turn. Work already done stays.'], confirm: 'Stop turn' },
      queue: { title: `Queue for ${owner}'s session`, target, notes: [QUEUE_NOTICE, 'Expires in 7 days.'], confirm: 'Queue message' },
      propose: { title: `Propose to ${owner}`, target, notes: [`Nothing runs until ${owner} approves it. Approval allows one send.`], confirm: 'Send proposal' },
      'send-approved': { title: `Send ${owner}'s approved message`, target, notes: [], confirm: 'Send approved message' },
      withdraw: { title: 'Withdraw this proposal', target, notes: [`${owner} won't be able to approve it.`], confirm: 'Withdraw' },
    }[op];
    return { op, title: C.title, text, target: C.target, notes: C.notes, confirm: C.confirm, armMs: ARM_MS };
  }

  // The window's identity: the bound row (fixed per authority), the effective scope and the expiry the share had when it opened.
  const identity = (t) => ({ ref: t.ref, scope: t.scope, expiresAt: t.expiresAt ?? null });
  const sameIdentity = (a, b) => !!a && !!b && a.ref === b.ref && a.scope === b.scope && a.expiresAt === b.expiresAt;
  const windowLive = (held) => !!held?.window && held.window.until > now() && !askEach;
  const seenOk = (v) => plain(v) && Object.keys(v).sort().join(',') === 'generation,turn' && ['string', 'number'].includes(typeof v.generation) && (v.turn === null || ['string', 'number'].includes(typeof v.turn));

  // thread:shared-review [boundId, {op, text[, seen]} | {askEach: boolean}]
  async function reviewInner(c, req, still) {
    if (plain(req) && Object.keys(req).join(',') === 'askEach' && typeof req.askEach === 'boolean') {
      askEach = req.askEach;
      if (askEach) for (const h of auths.values()) h.window = null;
      return { ok: true, status: 'ask-each', askEach };
    }
    const keys = plain(req) ? Object.keys(req).sort().join(',') : '';
    if (!plain(req) || (keys !== 'op,text' && keys !== 'op,seen,text') || !OPS.includes(req.op) || typeof req.text !== 'string' || (keys === 'op,seen,text' && !seenOk(req.seen))) return fail('invalid', TEXT.INVALID);
    const { op, text } = req;
    // A queued message is never window-eligible: no `seen`, always a card.
    if (op === 'queue' && keys !== 'op,text') return fail('invalid', TEXT.INVALID);
    if (op === 'stop' ? text !== '' : !textOk(text)) return fail('invalid', TEXT.INVALID);
    const auth = authOf(c, still);
    if (!auth) return fail('unavailable', TEXT.UNAVAILABLE);
    let t;
    try { t = await auth.resolve(); } catch { t = null; }
    if (!still(c)) return null;
    if (!t?.hub) return mapped(t);
    if (t.scope !== 'interact') { const h = auths.get(docKey(c)); if (h) h.window = null; return fail('forbidden', TEXT.WATCH); }
    const owner = line(auth.owner, 80) || 'Teammate';
    if (op === 'propose') {
      let p;
      try { p = await auth.propose(text); } catch { p = null; }
      if (!still(c)) return null;
      if (p?.ok !== true || !Array.isArray(p.assignments) || p.assignments.length !== 1) return mapped(p);
      const a = p.assignments[0];
      if (a.status !== 'review') return fail('unavailable', line(a.reason, 300) || TEXT.UNAVAILABLE);
      const expires = Math.min(Number.isFinite(p.expiresAt) ? p.expiresAt : 0, now() + SELECTION_MS);
      const selection = mint(c, auth, { op, text, inner: p.proposal, expires });
      return { ok: true, status: 'review', selection, card: card(op, owner, line(a.target?.provider, 60) || 'AI', prose(a.text, MAX_TEXT)) };
    }
    let r;
    try { r = await auth.inspect(); } catch { r = null; }
    if (!still(c)) return null;
    if (r?.ok !== true || typeof r.selection !== 'string') return mapped(r);
    if (op === 'queue') {
      const st = r.state, why = typeof auth.queue?.enqueue !== 'function' ? TEXT.UNAVAILABLE : st.status === 'ended' ? 'This session has ended.'
        : st.status === 'ready' && (st.activeTurn ?? null) === null ? 'Send now; the session is idle.' : st.capabilities?.newTurn === false ? TEXT.UNAVAILABLE : !Number.isSafeInteger(st.generation) || typeof st.provider?.id !== 'string' ? TEXT.UNAVAILABLE : '';
      if (why) return fail('unavailable', why);
      // Bound to the generation only: it waits for the current turn to end by design.
      const selection = mint(c, auth, { op, text, inner: null, generation: st.generation, provider: st.provider.id, providerLabel: line(st.provider.label, 60), requestId: crypto.randomUUID(), expires: now() + SELECTION_MS });
      return { ok: true, status: 'review', selection, card: card(op, owner, line(st.provider.label, 60) || 'AI', text.trim()) };
    }
    const cap = r.capabilities?.[op === 'stop' ? 'interrupt' : op];
    if (cap?.available !== true) return fail('unavailable', line(cap?.reason, 300) || TEXT.UNAVAILABLE);
    // T3b: inside the window a send, steer or stop skips the card, but only when the page's own view of the session
    // (generation and turn) equals the fresh one; anything else gets the card.
    const held = auths.get(docKey(c));
    const turn = r.state.activeTurn ?? null;
    if (windowLive(held) && keys === 'op,seen,text' && sameIdentity(held.window.share, identity(t))
      && req.seen.generation === r.state.generation && req.seen.turn === turnTag(turn)) {
      if (held.busyUntil > now()) return fail('busy', TEXT.IN_FLIGHT);
      const expires = now() + DIRECT_MS;
      held.busyUntil = expires;
      const selection = mint(c, auth, { op, text, inner: r.selection, generation: r.state.generation, turn, expires, direct: true, window: held.window });
      return { ok: true, status: 'direct', selection };
    }
    // An expired window, or one whose share changed (id, effective scope, expiry), ends here; the card shows and the page stops saying "straight away".
    if (held?.window && (!windowLive(held) || !sameIdentity(held.window.share, identity(t)))) held.window = null;
    const selection = mint(c, auth, { op, text, inner: r.selection, generation: r.state.generation, turn, expires: now() + SELECTION_MS });
    return { ok: true, status: 'review', selection, card: card(op, owner, line(r.state.provider?.label, 60) || 'AI', op === 'stop' ? '' : text.trim()) };
  }

  // An answer says when the window ends while there is one (no key = no window), so the page's composer line follows main, never its own clock.
  const withWindow = (c, res) => { const held = auths.get(docKey(c)); return res && typeof res === 'object' && windowLive(held) ? { ...res, window: held.window.until } : res; };
  const review = async (c, req, still) => withWindow(c, await reviewInner(c, req, still));
  const confirm = async (c, req, still) => withWindow(c, await confirmInner(c, req, still));
  // thread:shared-confirm [boundId, {selection, text}]
  async function confirmInner(c, req, still) {
    if (!plain(req) || Object.keys(req).sort().join(',') !== 'selection,text' || typeof req.selection !== 'string' || !UUID.test(req.selection) || typeof req.text !== 'string') return fail('invalid', TEXT.INVALID);
    const rec = selections.get(req.selection), key = docKey(c);
    const held = auths.get(key);
    if (!rec || rec.doc !== key || rec.boundId !== c.boundId || rec.expires < now() || !held || held.auth !== rec.auth || !safeLive(rec.auth)) { if (rec && rec.doc === key) selections.delete(req.selection); return fail('stale', TEXT.MOVED); }
    // A card-less selection is honoured only while the very window it was minted under is still open (M2).
    if (rec.direct && (held.window !== rec.window || !windowLive(held))) { selections.delete(req.selection); held.busyUntil = 0; if (held.window === rec.window) held.window = null; return fail('stale', TEXT.REVIEW_AGAIN); }
    if (!rec.direct && now() - rec.deliveredAt < ARM_MS) return fail('not-ready', TEXT.NOT_READY);
    if (req.text !== rec.text) return fail('invalid', TEXT.INVALID);
    // One use, before the first await.
    selections.delete(req.selection);
    if (rec.direct) held.busyUntil = Infinity;
    try { return await run(c, rec, still, held); } finally { if (rec.direct) held.busyUntil = 0; }
  }
  async function run(c, rec, still, held) {
    const auth = rec.auth, op = rec.op;
    // The scope, read fresh (a share downgraded to watch since review refuses here, before any dispatch).
    let t;
    try { t = await auth.resolve(); } catch { t = null; }
    if (!still(c, true)) return fail('stale', TEXT.MOVED);
    if (!t?.hub) return mapped(t, TEXT.MOVED);
    if (t.scope !== 'interact') { held.window = null; return fail('forbidden', TEXT.WATCH); }
    // The share is the one the window opened on, with the same scope and expiry; otherwise the card comes back.
    if (rec.direct && !sameIdentity(rec.window.share, identity(t))) { held.window = null; return fail('stale', TEXT.REVIEW_AGAIN); }
    let out;
    if (op === 'send' || op === 'steer' || op === 'stop') {
      try { out = await auth.act(rec.inner, op === 'stop' ? 'interrupt' : op, op === 'stop' ? '' : rec.text); } catch { return fail('unconfirmed', TEXT.UNCONFIRMED); }
      if (!still(c)) return fail('unconfirmed', TEXT.UNCONFIRMED);
      if (out?.ok !== true) {
        // An answer that says access changed ends the window (T3b); an offline owner or a plain failure does not.
        if (out?.status === 'forbidden' || out?.status === 'unauthenticated' || out?.status === 'gone') held.window = null;
        return out?.status === 'stale' ? fail('stale', TEXT.MOVED) : mapped(out);
      }
      // The first accepted card opens the window (not one opened by it, not with Ask me each time on).
      if (!rec.direct && !askEach && !windowLive(held)) held.window = { openedAt: now(), until: now() + WINDOW_MS, share: identity(t) };
      const d = out.delivery;
      return { ok: true, status: 'sent', receipt: d && typeof d.id === 'string' ? { id: line(d.id, 100), state: line(d.state, 40) || 'unknown' } : null, ...(op === 'steer' ? { note: TEXT.STEER_NOTE } : {}) };
    }
    if (op === 'queue') {
      try { out = await auth.queue.enqueue({ text: rec.text, requestId: rec.requestId, generation: rec.generation, provider: rec.provider, providerLabel: rec.providerLabel }); } catch { return fail('unavailable', TEXT.QUEUE_FAILED); }
      if (!still(c)) return fail('unavailable', TEXT.QUEUE_FAILED);
      if (out?.ok === true) return { ok: true, status: 'queued' };
      if (out?.status === 'full') return fail('refused', line(out.error, 300) || TEXT.QUEUE_FAILED);
      return out?.status === 'stale' ? fail('stale', TEXT.MOVED) : mapped(out, TEXT.QUEUE_FAILED);
    }
    if (op === 'propose') {
      try { out = await auth.requestOwner(rec.inner); } catch { return fail('unconfirmed', TEXT.UNCONFIRMED); }
      if (!still(c)) return fail('unconfirmed', TEXT.UNCONFIRMED);
      // The assignment's status, not the call's ok (plan-t3 M3): a refused or unconfirmed request is never Awaiting.
      const a = Array.isArray(out?.assignments) ? out.assignments[0] : null;
      if (out?.ok === true && a?.status === 'awaiting-owner') return { ok: true, status: 'awaiting' };
      if (a?.status === 'refused') return fail('refused', line(a.reason, 300) || TEXT.UNAVAILABLE);
      if (a?.status === 'unconfirmed') return fail('unconfirmed', line(a.reason, 300) || TEXT.UNCONFIRMED);
      return mapped(out);
    }
    if (op === 'send-approved') {
      try { out = await auth.remoteSend(rec.inner); } catch { return fail('unconfirmed', TEXT.UNCONFIRMED); }
      if (!still(c)) return fail('unconfirmed', TEXT.UNCONFIRMED);
      if (out?.ok !== true) return out?.status === 'stale' ? fail('stale', TEXT.MOVED) : mapped(out);
      const rcpt = out.proposal?.receipt;
      return { ok: true, status: 'sent', receipt: rcpt && typeof rcpt.id === 'string' ? { id: line(rcpt.id, 100), state: line(rcpt.state, 40) || 'unknown' } : null };
    }
    if (op === 'withdraw') {
      // Refused once the owner has acted: a second fresh list, after consuming and before the cancel.
      let list;
      try { list = await auth.remoteList(); } catch { list = null; }
      if (!still(c, true)) return fail('stale', TEXT.MOVED);
      if (list?.offline === true) return mapped(list);
      const p = Array.isArray(list?.proposals) ? list.proposals.find((x) => x.id === rec.proposalId) : null;
      if (!p) return fail('stale', TEXT.OWNER_ACTED);
      if (p.status !== 'pending') return fail('stale', TEXT.OWNER_ACTED);
      try { out = await auth.remoteCancel(rec.inner); } catch { out = null; }
      if (!still(c)) return fail('stale', TEXT.MOVED);
      if (out?.ok === true) return { ok: true, status: 'withdrawn' };
      return out?.status === 'stale' ? fail('stale', TEXT.OWNER_ACTED) : mapped(out);
    }
    return fail('invalid', TEXT.INVALID);
  }

  // thread:shared-proposals [boundId]: my own proposals to this share, at most one read per 10 s per document.
  async function proposals(c, still) {
    const key = docKey(c), last = proposalReads.get(key), at = now();
    if (last && (last.pending || at - last.at < PROPOSALS_MIN_MS)) return last.pending ?? last.result;
    const auth = authOf(c, still);
    if (!auth) return fail('unavailable', TEXT.UNAVAILABLE);
    const entry = { at, pending: null, result: null };
    proposalReads.set(key, entry);
    entry.pending = (async () => {
      let t, list;
      try { t = await auth.resolve(); } catch { t = null; }
      if (!still(c)) { proposalReads.delete(key); return null; }
      if (!t?.hub) { entry.pending = null; entry.result = mapped(t); return entry.result; }
      if (t.scope !== 'interact') { entry.pending = null; entry.result = fail('forbidden', TEXT.WATCH); return entry.result; }
      try { list = await auth.remoteList(); } catch { list = null; }
      entry.pending = null;
      if (!still(c)) { proposalReads.delete(key); return null; }
      if (list?.ok !== true || !Array.isArray(list.proposals)) { entry.result = mapped(list); return entry.result; }
      // Only this list's actions stay valid.
      for (const [s, rec] of selections) if (rec.doc === key && (rec.op === 'send-approved' || rec.op === 'withdraw')) selections.delete(s);
      const owner = line(auth.owner, 80) || 'Teammate';
      const items = list.proposals.slice(0, 20).map((p) => {
        const status = PROPOSAL_STATUS[p.status] ?? 'unconfirmed';
        const item = { status, title: line(p.title, 120), text: prose(p.text, MAX_TEXT), expiresAt: typeof p.expiresAt === 'string' ? p.expiresAt : null, receipt: p.receipt ? { state: line(p.receipt.state, 40) || 'unknown' } : null, action: null };
        const op = status === 'approved' ? 'send-approved' : status === 'awaiting' ? 'withdraw' : null;
        if (op && typeof p.selection === 'string') {
          const selection = mint(c, auth, { op, text: '', inner: p.selection, proposalId: p.id, expires: now() + SELECTION_MS });
          item.action = { selection, card: card(op, owner, 'AI', item.text) };
        }
        return item;
      });
      entry.result = { ok: true, status: 'ready', proposals: items };
      return entry.result;
    })();
    return entry.pending;
  }

  // thread:shared-queue [boundId]: my queued messages to this share. Rows carry an opaque per-document key, never a store id.
  const QUEUE_MIN_MS = 2000;
  const rowKey = (c, id) => {
    const dk = docKey(c);
    let secret = queueSecrets.get(dk);
    if (!secret) { secret = crypto.randomBytes(32); queueSecrets.set(dk, secret); }
    return crypto.createHmac('sha256', secret).update(id).digest('hex').slice(0, 32);
  };
  const reasonOf = (reason, owner) => { const r = line(reason, 300); return r.startsWith('The owner ') ? `${owner} ${r.slice('The owner '.length)}` : r; };
  async function queueItems(c, auth) {
    let out;
    try { out = await auth.queue.list(); } catch { out = null; }
    return out?.ok === true && Array.isArray(out.items) ? out.items : null;
  }
  async function queueList(c, still) {
    const key = docKey(c), last = queueReads.get(key), at = now();
    if (last && (last.pending || at - last.at < QUEUE_MIN_MS)) return last.pending ?? last.result;
    const auth = authOf(c, still);
    if (!auth || typeof auth.queue?.list !== 'function') return fail('unavailable', TEXT.UNAVAILABLE);
    const entry = { at, pending: null, result: null };
    queueReads.set(key, entry);
    entry.pending = (async () => {
      let t, items;
      try { t = await auth.resolve(); } catch { t = null; }
      if (!still(c)) { queueReads.delete(key); return null; }
      if (!t?.hub) { entry.pending = null; entry.result = mapped(t); return entry.result; }
      if (t.scope !== 'interact') { entry.pending = null; entry.result = fail('forbidden', TEXT.WATCH); return entry.result; }
      items = await queueItems(c, auth);
      entry.pending = null;
      if (!still(c)) { queueReads.delete(key); return null; }
      if (!items) { entry.result = fail('unavailable', TEXT.UNAVAILABLE); return entry.result; }
      const owner = line(auth.owner, 80) || 'Teammate';
      entry.result = {
        ok: true, status: 'ready',
        items: items.slice(0, 16).filter((i) => i.status !== 'cancelled' && QUEUE_STATE[i.status]).map((i) => ({
          key: rowKey(c, i.id), text: prose(i.text, 200), state: QUEUE_STATE[i.status], reason: reasonOf(i.reason, owner),
          expiresAt: Number.isFinite(i.expiresAt) ? i.expiresAt : null, receipt: i.receipt ? { state: line(i.receipt.state, 40) || 'unknown' } : null,
        })),
      };
      return entry.result;
    })();
    return entry.pending;
  }
  // thread:shared-queue-remove [boundId, {key, op}]: cancel a waiting message, or discard a finished one's saved copy.
  async function queueRemove(c, req, still) {
    if (!plain(req) || Object.keys(req).sort().join(',') !== 'key,op' || typeof req.key !== 'string' || !/^[0-9a-f]{32}$/.test(req.key) || !['cancel', 'discard'].includes(req.op)) return fail('invalid', TEXT.INVALID);
    const auth = authOf(c, still);
    if (!auth || typeof auth.queue?.list !== 'function') return fail('unavailable', TEXT.UNAVAILABLE);
    let t;
    try { t = await auth.resolve(); } catch { t = null; }
    if (!still(c, true)) return fail('stale', TEXT.MOVED);
    if (!t?.hub) return mapped(t);
    if (t.scope !== 'interact') return fail('forbidden', TEXT.WATCH);
    // The key is mapped back to a store id among this share's own items only; anything else is unknown.
    const items = await queueItems(c, auth);
    if (!still(c, true)) return fail('stale', TEXT.MOVED);
    const item = items?.find((i) => rowKey(c, i.id) === req.key);
    if (!item) return fail('stale', 'That message is no longer in the queue.');
    const waiting = item.status === 'queued' || item.status === 'blocked';
    if (req.op === 'cancel' ? !waiting : (waiting || item.status === 'sending')) return fail('stale', 'That message has changed. Look at the queue again.');
    let out;
    try { out = req.op === 'cancel' ? await auth.queue.cancel(item.id) : await auth.queue.discard(item.id); } catch { out = null; }
    queueReads.delete(docKey(c));
    return out?.ok === true ? { ok: true, status: req.op === 'cancel' ? 'cancelled' : 'discarded' } : fail(out?.status === 'unconfirmed' ? 'unconfirmed' : 'stale', out?.status === 'unconfirmed' ? TEXT.UNCONFIRMED : 'That message has changed. Look at the queue again.');
  }

  // After each thread:shared-state read: a card whose session moved on (generation, turn) or went to watch retires.
  function afterRead(c, result) {
    const key = docKey(c), held = auths.get(key);
    // What the page needs to show the composer line: when the window ends (0 = none) and the setting.
    if (result && result.gone !== true) { result.window = windowLive(held) ? held.window.until : 0; result.askEach = askEach; }
    if (!held) return;
    if (!result || result.gone === true) { forget(key); return; }
    let seen = null;
    try { seen = held.auth.seen(); } catch { seen = null; }
    if (!seen) return;
    if (seen.scope !== 'interact') { drop(key); proposalReads.delete(key); held.window = null; return; }
    for (const [s, rec] of selections) {
      if (rec.doc !== key || rec.generation === undefined) continue;
      if (rec.generation !== seen.generation || (rec.op !== 'queue' && rec.turn !== seen.turn)) selections.delete(s);
    }
  }

  return {
    review, confirm, proposals, queueList, queueRemove, afterRead,
    retire(wcId) { for (const k of [...auths.keys(), ...proposalReads.keys(), ...queueReads.keys()]) if (k.startsWith(`${wcId}:`)) forget(k); for (const [s, rec] of selections) if (rec.doc.startsWith(`${wcId}:`)) selections.delete(s); },
    stop() { for (const k of [...auths.keys()]) forget(k); selections.clear(); proposalReads.clear(); queueReads.clear(); queueSecrets.clear(); },
    size: () => selections.size,
  };
}

module.exports = { createSharedThreadActions, ARM_MS, SELECTION_MS, WINDOW_MS, DIRECT_MS, PROPOSALS_MIN_MS, TEXT, PROPOSAL_STATUS, OPS };
