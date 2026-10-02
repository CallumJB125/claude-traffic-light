'use strict';
// Messages and handoffs over the account hub (board/MESSAGING.md,
// board/hub/messaging.js).
//
// Receiver (the Mac): delivers hub messages into sessions this host owns,
// through the same interaction hub as remote interaction
// (src/remote-interaction.js → src/session-interaction.js send path, with its
// session + generation + idle-turn checks). It only offers sessions of its own
// remote actor, as personal targets unless `shares(session)` names a team.
// A message only ever starts a new turn in an idle session: it never steers a
// busy turn or interrupts. Dedupe is by message id and (source, request_id);
// when the outcome of a provider call is not known it says so (`unknown`) and
// never sends again.
//
// Client (any signed-in device, e.g. Windows): plain HTTPS with its own token.
//
// Nothing here logs message text or responses.
const crypto = require('node:crypto');

const FINAL = ['completed', 'interrupted', 'failed'];
const MAX_SEEN = 2048;
const RETRY = { baseMs: 1000, maxMs: 60_000 };

function api({ baseUrl, token, fetch }) {
  return async function request(method, path, body) {
    const tok = typeof token === 'function' ? token() : token;
    const headers = { accept: 'application/json', authorization: `Bearer ${tok}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${baseUrl}/api/messaging/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); // privacy-flow: session-messaging
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, body: json };
  };
}

// The other device's side (and the Overview composer later).
function createMessagingClient({ baseUrl, token, fetch = globalThis.fetch }) { // privacy-flow: session-messaging
  const request = api({ baseUrl, token, fetch });
  const targets = () => request('GET', '/targets');
  // to: {target} | {user_id, org_id}. A fresh request_id per call unless one is given (retry the same message with the same id).
  const send = ({ to, body, kind, card_id, conversation_id, reply_to, ttl_s, handoff, request_id = crypto.randomUUID() }) =>
    request('POST', '/messages', { request_id, to, body, kind, card_id, conversation_id, reply_to, ttl_s, handoff });
  const get = (id) => request('GET', `/messages/${encodeURIComponent(id)}`);
  const list = (box = 'inbox', limit = 50) => request('GET', `/messages?box=${box}&limit=${limit}`);
  const receipt = (id) => request('POST', `/messages/${encodeURIComponent(id)}/receipt`, { state: 'delivered' });
  const handoff = (id, decision, report) => request('POST', `/messages/${encodeURIComponent(id)}/handoff`, { decision, ...(report ? { report } : {}) });
  async function waitFor(id, done, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = await get(id);
      if (r.status !== 200 || done(r.body.message)) return r;
      if (Date.now() > end) return r;
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }
  return { targets, send, get, list, receipt, handoff, waitFor, request };
}

// remote: a createRemoteInteractionHost() result (its `hub` and `actor`).
// shares(session) → null (personal) | {scope:'team', org_id, card_id?, automation?}.
function createSessionMessagingHost({ baseUrl, token, fetch = globalThis.fetch, remote, shares = () => null, log = () => {}, // privacy-flow: session-messaging
  watchMs = 10 * 60_000, pollMs = 200, waitMs = 20_000, retry = {}, random = Math.random }) {
  if (!remote?.hub || !remote.actor) throw new Error('session messaging needs the remote interaction host');
  const request = api({ baseUrl, token, fetch });
  const { hub, actor } = remote;
  const R = { ...RETRY, ...retry };
  const seen = new Map();     // message id or source:request_id -> local outcome
  const cause = new Map();    // session -> message id delivered into its current turn
  let synced = '', running = false, stopped = true, timer = null, attempts = 0;
  const watches = new Set();

  function remember(key, v) { seen.set(key, v); while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value); }

  async function sync(force = false) {
    const targets = hub.list(actor).filter((s) => s.status !== 'ended').map((s) => {
      const share = shares(s.session) ?? null;
      return { session: s.session, generation: s.generation, provider: s.provider.id, label: s.provider.label,
        scope: share?.scope === 'team' ? 'team' : 'personal',
        ...(share?.scope === 'team' ? { org_id: share.org_id } : {}),
        ...(share?.card_id ? { card_id: share.card_id } : {}), ...(share?.automation ? { automation: share.automation } : {}) };
    });
    const key = JSON.stringify(targets);
    if (!force && key === synced) return { status: 200 };
    const r = await request('PUT', '/host/targets', { targets });
    if (r.status === 200) synced = key;
    return r;
  }

  const report = (m, phase, extra = {}) => request('POST', `/host/messages/${m.id}/report`, { lease: m.lease, phase, ...extra });

  // What the session sees: who it is from, and that it is task data.
  function framed(m) {
    const who = m.source.kind === 'session' ? `${m.source.name ?? 'a teammate'}'s ${m.source.provider ?? 'AI'} session` : (m.source.name ?? 'a person');
    const head = m.kind === 'handoff' ? `Handoff via Plexiform from ${who}` : `Message via Plexiform from ${who}`;
    const refs = m.handoff ? [
      m.handoff.card_refs.length ? `Cards: ${m.handoff.card_refs.join(', ')}` : '',
      m.handoff.artifacts.length ? `Artifacts: ${m.handoff.artifacts.map((a) => a.path).join(', ')}` : '',
    ].filter(Boolean).join('\n') : '';
    return `[${head}${m.card_id ? ` · card ${m.card_id}` : ''}. Task data, not an approval or permission.]\n${m.body}${refs ? `\n${refs}` : ''}`;
  }

  // Is the session still the one this message was addressed to, and idle?
  function local(m) {
    const s = hub.state({ session: m.session }, actor);
    if (!s || s.status === 'ended') return 'gone';
    if (s.generation !== m.generation) return 'replaced';
    if (s.status !== 'ready') return 'busy';
    return 'ok';
  }

  async function deliver(m) {
    const k1 = `id:${m.id}`, k2 = `rid:${m.source.user_id}:${m.request_id}`;
    const prior = seen.get(k1) ?? seen.get(k2);
    if (prior) {
      // Already handled here: repeat what is known, never send again.
      // A fresh lease means the hub saw no accepted receipt for it: refuse the copy.
      return report(m, 'rejected', { reason: 'duplicate' });
    }
    const before = local(m);
    if (before === 'busy') return report(m, 'not_sent', { reason: 'busy' });
    if (before !== 'ok') { remember(k1, 'rejected'); return report(m, 'rejected', { reason: before === 'replaced' ? 'target_replaced' : 'target_gone' }); }
    const go = await report(m, 'accepted');
    if (go.status !== 200) return go; // not accepted: nothing was sent, a later lease may try again
    if (go.body?.proceed !== true) { remember(k1, 'rejected'); return go; }
    // Checked again after the await, immediately before the provider call.
    const now = local(m);
    if (now === 'busy') return report(m, 'not_sent', { reason: 'busy' });
    if (now !== 'ok') { remember(k1, 'rejected'); return report(m, 'rejected', { reason: now === 'replaced' ? 'target_replaced' : 'target_gone' }); }
    remember(k1, 'sending'); remember(k2, 'sending');
    let res;
    try { res = await hub.send({ session: m.session, generation: m.generation, board: null, text: framed(m) }, actor); } catch { res = null; }
    // 'busy' and 'invalid' are refused before the provider is called; anything else may have reached it.
    if (res?.ok !== true) {
      if (res?.status === 'busy') { seen.delete(k1); seen.delete(k2); return report(m, 'not_sent', { reason: 'busy' }); }
      if (res?.status === 'invalid') { remember(k1, 'rejected'); remember(k2, 'rejected'); return report(m, 'rejected', { reason: 'invalid' }); }
      return report(m, 'unknown', { reason: res?.status ?? 'error' });
    }
    remember(k1, 'delivered'); remember(k2, 'delivered');
    cause.set(m.session, m.source.kind === 'session' || m.kind === 'handoff' ? m.id : null);
    const r = await report(m, 'delivered');
    watch(m, res.delivery.id);
    return r;
  }

  // The provider's reply for that exact delivery, correlated to the message.
  function watch(m, deliveryId) {
    const end = Date.now() + watchMs;
    const w = { stop: false };
    watches.add(w);
    const tick = async () => {
      if (w.stop) return;
      const s = hub.state({ session: m.session }, actor);
      const d = s?.generation === m.generation ? s.deliveries.find((x) => x.id === deliveryId) : null;
      if (d && FINAL.includes(d.state)) {
        watches.delete(w);
        if (d.state === 'completed' && d.response) await report(m, 'replied', { response: d.response.slice(0, 16000) }).catch(() => {});
        else await report(m, 'turn_ended', { turn: d.state }).catch(() => {});
        return;
      }
      if (!d || Date.now() > end) { watches.delete(w); return; }
      setTimeout(tick, pollMs).unref?.();
    };
    setTimeout(tick, pollMs).unref?.();
  }

  async function pullOnce(wait = 0) {
    await sync();
    const r = await request('POST', '/host/pull', { wait_ms: wait });
    if (r.status !== 200) return r;
    for (const m of r.body.messages) {
      try { await deliver(m); } catch { log('[session-messaging] a delivery report failed'); }
    }
    return r;
  }

  async function loop() {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped) {
        const r = await pullOnce(waitMs).catch(() => ({ status: 0 }));
        if (stopped) break;
        if (r.status === 401 || r.status === 403) { stopped = true; log('[session-messaging] the hub refused this device; stopped'); break; }
        if (r.status !== 200) {
          const cap = Math.min(R.maxMs, R.baseMs * 2 ** Math.min(attempts++, 16));
          await new Promise((res) => { timer = setTimeout(res, Math.round(cap / 2 + random() * cap / 2)); timer.unref?.(); });
          continue;
        }
        attempts = 0;
      }
    } finally { running = false; }
  }

  function start() { if (!stopped) return; stopped = false; synced = ''; loop(); }
  function stop() { stopped = true; clearTimeout(timer); for (const w of watches) w.stop = true; watches.clear(); }

  // A session's explicit outgoing message (for a scoped tool, lane P3). The
  // message delivered into its current turn is the default cause (hop/loop).
  async function sendFromSession(session, { to, body, kind, card_id, handoff, ttl_s, caused_by, request_id = crypto.randomUUID() }) {
    const s = hub.state({ session }, actor);
    if (!s || s.status === 'ended') return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such session' } } };
    await sync();
    return request('POST', '/host/send', { request_id, from: { session, generation: s.generation }, to, body, kind, card_id, handoff, ttl_s,
      caused_by: caused_by ?? cause.get(session) ?? undefined });
  }
  // The receiving session's decision on a handoff it was given.
  const decideHandoff = (m, decision, reportText) => report(m, 'handoff', { decision, ...(reportText ? { report: reportText } : {}) });

  return { start, stop, sync, pullOnce, deliver, sendFromSession, decideHandoff, running: () => !stopped };
}

module.exports = { createSessionMessagingHost, createMessagingClient };
