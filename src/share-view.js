'use strict';
// L32 (plan-l32 App PR delta, Rev 4): a grantee's app tells the team hub it has a teammate's shared session open, so
// the owner sees "Alice watching". HTTP beats on the grantee's own team-hub client (hub.view), keyed by share; not
// the card-keyed board presence (presence-owner.js).
//
// - One open share at a time (a thread window shows one document), keyed by (docKey, ref) (A-S3).
// - Nothing is sent until the thread has painted "‹Owner› can see you're watching" (painted(docKey), S2). A ref change
//   closes the old one and needs a new paint.
// - Then a beat now and every BEAT_MS, one request in flight. Each beat re-checks, through `showing(docKey)`, that the
//   same document is bound to the same share and its window is visible and not minimised. Hidden: viewing:false once,
//   only if a beat was sent (A-S4). Shown again (D-S2): back to 'pending' (the line shows again) and no beat until a
//   fresh painted() for this (docKey, ref).
// - 404/405 ('unsupported': an older hub, or the share is gone for this person): stop for this (docKey, ref) until the
//   thread is reopened. The hub's TTL ages out the last beat, so no viewing:false follows.
// - `watching(docKey)` is what the thread may say (D2a, D-S1): 'pending' before the first outcome, 'on' after an
//   accepted beat. 'off' only on 404/405, an accepted viewing:false (the hub's 50-viewer cap: then no more beats this
//   open), hidden, or the beat ending. A 401 or a network failure keeps the line: a lost beat may have landed and the
//   hub keeps it for 90 s, so the line is never taken down while the owner may still see this person.
// - close/clearAll: viewing:false fire-and-forget, only if a beat was sent.
const { BEAT_MS } = require('./session-presence');

function createShareView({ showing = () => false, setTimeout: st = globalThis.setTimeout, clearTimeout: ct = globalThis.clearTimeout, beatMs = BEAT_MS } = {}) {
  let cur = null; // { docKey, route, painted, sent, inFlight, timer, stopped, watching, paused }
  const safe = (fn, d) => { try { return fn(); } catch { return d; } };
  function bye(c) {
    if (!c.sent) return;
    c.sent = false;
    try { Promise.resolve(c.route.beat(false)).catch(() => {}); } catch { /* fire and forget */ }
  }
  function disarm(c) { if (c.timer) { ct(c.timer); c.timer = null; } }
  function arm(c) {
    disarm(c);
    if (c.stopped || cur !== c) return;
    c.timer = st(() => { c.timer = null; void tick(c); }, beatMs);
    c.timer?.unref?.();
  }
  async function tick(c) {
    if (cur !== c || c.stopped || !c.painted) return;
    if (!safe(() => c.route.live(), false)) { c.stopped = true; c.watching = 'off'; bye(c); disarm(c); return; }
    if (safe(() => showing(c.docKey), false) !== true) {
      // Hidden or minimised: not watching. Say so once, keep checking for show.
      if (!c.paused) { c.paused = true; c.watching = 'off'; bye(c); }
      arm(c);
      return;
    }
    if (c.paused) {
      // D-S2: shown again. The line comes back first; the beat waits for the thread to paint it.
      c.paused = false; c.painted = false; c.watching = 'pending'; disarm(c);
      return;
    }
    if (c.inFlight) { arm(c); return; }
    c.inFlight = true;
    let r = null;
    try { r = await c.route.beat(true); } catch { r = { ok: false, status: 'network' }; }
    c.inFlight = false;
    if (cur !== c || c.stopped) return;
    if (r && r.ok === true && r.viewing === true) { c.sent = true; c.watching = 'on'; }
    else if (r && r.ok === true) { c.stopped = true; c.sent = false; c.watching = 'off'; disarm(c); return; } // not taken (cap)
    else if (r?.status === 'unsupported') { c.stopped = true; c.sent = false; c.watching = 'off'; disarm(c); return; }
    // A 401 or a failure: keep the state and the line (D-S1); the next beat tries again.
    arm(c);
  }
  const api = {
    // The thread bound this document to a share. Records only: no beat before painted().
    open(docKey, route) {
      if (typeof docKey !== 'string' || !route || typeof route.ref !== 'string' || typeof route.beat !== 'function' || typeof route.live !== 'function') return;
      if (cur && cur.docKey === docKey && cur.route.ref === route.ref) { if (!cur.stopped) cur.route = route; return; }
      api.close();
      cur = { docKey, route, painted: false, sent: false, inFlight: false, timer: null, stopped: false, watching: 'pending', paused: false };
    },
    // The renderer has shown "‹Owner› can see you're watching" in this document: beats may start.
    painted(docKey, ref = null) {
      const c = cur;
      if (!c || c.docKey !== docKey || (ref !== null && c.route.ref !== ref) || c.painted || c.stopped) return false;
      c.painted = true;
      void tick(c);
      return true;
    },
    // Wake on show without waiting for the next beat.
    poke(docKey) { const c = cur; if (c && c.docKey === docKey && c.painted && !c.stopped && c.paused) void tick(c); },
    // 'pending' until the first beat's outcome: the thread keeps the line it painted.
    watching(docKey) { return cur && cur.docKey === docKey ? cur.watching : 'off'; },
    key: () => (cur ? cur.docKey : null),
    close(docKey = null) {
      const c = cur;
      if (!c || (docKey !== null && c.docKey !== docKey)) return;
      cur = null; c.stopped = true; disarm(c); bye(c);
    },
    clearAll() { api.close(); },
    size: () => (cur ? 1 : 0),
  };
  return api;
}

module.exports = { createShareView };
