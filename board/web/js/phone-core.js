// Phone control (the /phone/ PWA): the API client and the state machine,
// with no DOM, so node --test drives them with a fake fetch and clock.
//
// The phone talks to the hub's interaction relay
// (board/hub/interaction-relay.js) with its own desktop-kind device token
// (a `bdt_` from the email-code sign-in, see PHONE.md). Every request:
// Bearer only, credentials 'omit' (the board's cookie session never rides
// along), cache 'no-store', a fresh request_id per relay call. Provider text
// (delivery text, response, error, notices) is data: the renderer puts it in
// text nodes only.
//
// Shared with me: sessions a teammate shared with a team this account is in
// (board/hub/interaction-shares.js). They open through the share, never
// through the teammate's computer: watch-only shares show no composer;
// "watch and send" shares send, steer and interrupt but never close.
//
// Liveness: a status is "live" only while the long-poll keeps answering. A
// watch answers within 20 s, so a gap past LIVE_MS (or any failed poll) shows
// the last known status as not live, never as the current one.
//
// End-to-end (phone-e2e.js, docs/relay-e2e-threat-model.md): calls to a
// computer this phone is paired with go as {request_id, op, enc}; the args
// and the answer are sealed with keys only the phone and that computer hold,
// so the hub routes ciphertext. An answer that does not open is never shown.
// Without a pairing the call is plain, as before (the computer may refuse it).

import { createDeviceChannel } from './phone-e2e.js';

export const LIVE_MS = 30_000;
export const LIST_STALE_MS = 30_000;
export const WATCH_TIMEOUT_MS = 32_000; // the relay gives up at 25 s
export const CALL_TIMEOUT_MS = 15_000;
export const MAX_TEXT = 4000;
const BACKOFF_MAX_MS = 30_000;

export class NetworkError extends Error {
  constructor(message = 'network') { super(message); this.name = 'NetworkError'; }
}

/** Jittered exponential backoff: 1 s, 2 s, 4 s … capped at 30 s; failures ≥ 1. */
export function backoffMs(failures, rand = Math.random) {
  const base = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.max(0, failures - 1));
  return Math.round(base / 2 + rand() * (base / 2));
}

/**
 * The paired computers' channels. `store`: the vault ({agreementKey,
 * pairings}). channelFor(hostId) → a device channel, or null (not paired).
 */
export function createE2E({ store }) {
  const channels = new Map(); // host id -> {rec, ch}
  return {
    async channelFor(hostId) {
      if (typeof store?.pairings !== 'function') return null;
      const rec = (await store.pairings())[hostId];
      if (!rec) { channels.delete(hostId); return null; }
      const have = channels.get(hostId);
      if (have && have.rec.did === rec.did && have.rec.dev === rec.dev && have.rec.desktopAgree === rec.desktopAgree) return have.ch;
      const { privateKey } = await store.agreementKey();
      const ch = createDeviceChannel({ did: rec.did, dev: rec.dev, privateKey, peerPublic: rec.desktopAgree });
      channels.set(hostId, { rec, ch });
      return ch;
    },
    reset() { channels.clear(); },
  };
}

export function createApi({ fetch, uuid, origin = '', e2e = null }) {
  let token = null;
  async function request(method, path, body, { timeout = CALL_TIMEOUT_MS, signal = null, auth = true } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && token) headers.authorization = `Bearer ${token}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const onAbort = () => ctl.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetch(`${origin}${path}`, { // privacy-flow: phone-control
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctl.signal,
      });
    } catch {
      throw new NetworkError(signal?.aborted ? 'aborted' : 'network');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, body: json };
  }
  async function call(host, op, args = {}, o) {
    const path = `/api/interaction/v1/hosts/${encodeURIComponent(host)}/call`;
    const ch = e2e ? await e2e.channelFor(host) : null;
    if (!ch) return request('POST', path, { request_id: uuid(), op, args }, o);
    return ch.call(op, args, (rid, name, enc) => request('POST', path, { request_id: rid, op: name, enc }, o), uuid);
  }
  return {
    setToken(t) { token = t; if (!t) e2e?.reset(); },
    hasToken: () => !!token,
    hosts: (o) => request('GET', '/api/interaction/v1/hosts', undefined, o),
    call,
    shared: (o) => request('GET', '/api/interaction/v1/shared', undefined, o),
    sharedCall: (share, op, args = {}, o) => request('POST', `/api/interaction/v1/shared/${encodeURIComponent(share)}/call`, { request_id: uuid(), op, args }, o),
    startEmail: (email, deviceName) => request('POST', '/api/auth/email/start', { email, client: 'buddy_desktop', device_name: deviceName, platform: 'phone-web' }, { auth: false }),
    // scope 'relay': the hub accepts this sign-in only for remote sessions and signing out (PHONE.md).
    verifyEmail: (flowId, code, deviceName) => request('POST', '/api/auth/email/verify', { flow_id: flowId, code, device_name: deviceName, platform: 'phone-web', scope: 'relay' }, { auth: false }),
    signOut: () => request('POST', '/api/auth/signout', {}),
  };
}

const errorOf = (r) => r?.body?.error ?? null;
const msgOf = (r, fallback) => errorOf(r)?.message || fallback;

export const STATUS_LABEL = { ready: 'Ready', working: 'Working', ended: 'Ended' };
export const DELIVERY_LABEL = {
  sending: 'Sending', acknowledged: 'Received', recorded: 'Received', responding: 'Responding',
  completed: 'Done', interrupted: 'Interrupted', failed: 'Failed',
};

/** Seconds/minutes ago, for "last known" labels. */
export function ago(ms) {
  if (ms == null) return 'never';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/**
 * What the session screen may claim. `live` is true only while the long-poll
 * is answering; otherwise the status is a last-known value and sending is off.
 */
export function sessionView(sess, now) {
  const st = sess?.state ?? null;
  if (!st) return { live: false, ended: false, status: null, label: 'Loading…', canSend: false, canInterrupt: false, canSteer: false, readOnly: !!sess?.readOnly };
  const ended = st.status === 'ended';
  const fresh = sess.lastOkAt != null && now - sess.lastOkAt < LIVE_MS;
  const live = !ended && sess.link === 'live' && fresh;
  const known = STATUS_LABEL[st.status] ?? 'Unknown';
  let label;
  let detail = null;
  if (ended) label = 'Ended';
  else if (live) label = known;
  else {
    label = sess.link === 'offline' ? 'Offline' : sess.link === 'gone' ? 'Unavailable' : 'Reconnecting';
    detail = `Last known: ${known}, ${ago(sess.lastOkAt == null ? null : now - sess.lastOkAt)}`;
  }
  const working = st.status === 'working' && !!st.activeTurn;
  const caps = st.capabilities ?? {};
  const writable = !sess.readOnly;
  return {
    live, ended, status: live || ended ? st.status : 'unknown', label, detail,
    canSend: writable && live && !sess.pending,
    canSteer: writable && live && working && caps.steer !== false,
    canInterrupt: writable && live && working && caps.interrupt !== false && !sess.pending,
    working, readOnly: !writable,
  };
}

/**
 * The controller: one state object, replaced on every change (subscribers
 * re-render). `api` from createApi; `vault` {load, save, clear}; `sleep(ms,
 * signal)` resolves early when `wake()` is called (online / visible).
 */
export function createController({ api, vault, now = Date.now, online = () => true, deviceName = 'Phone', rand = Math.random }) {
  let state = {
    view: 'boot', busy: false, notice: null,
    auth: { email: '', flowId: null, deviceName, error: null },
    hosts: { items: null, loadedAt: null, error: null },
    shared: { items: null, error: null },
    host: null,
    share: null,
    sessions: { items: null, providers: null, loadedAt: null, error: null },
    session: null,
  };
  const subs = new Set();
  const set = (patch) => { state = { ...state, ...patch }; for (const fn of subs) fn(state); };
  const setSession = (patch) => { if (state.session) set({ session: { ...state.session, ...patch } }); };
  let loop = 0;            // bumps to stop the current watch loop
  let wakeFn = null;
  let loopAbort = null;
  let token = null;        // the sign-in in use (also in the vault)
  let untold = null;       // a sign-in signed out here that the hub was not told about

  function sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); if (wakeFn === done) wakeFn = null; resolve(); }
      wakeFn = done;
    });
  }

  async function signedOut(message = 'You were signed out on this phone. Sign in again.', notice = { tone: 'warn', text: message }) {
    loop++;
    loopAbort?.abort();
    api.setToken(null);
    token = null;
    try { await vault.clear(); } catch { /* storage gone */ }
    set({ view: 'signin', busy: false, host: null, share: null, session: null, notice, shared: { items: null, error: null },
      hosts: { items: null, loadedAt: null, error: null }, sessions: { items: null, providers: null, loadedAt: null, error: null },
      auth: { ...state.auth, flowId: null, error: null } });
  }

  // A relay answer that is not a result: sign-out, offline host, limits.
  function failure(r) {
    if (r.status === 401) { signedOut(); return null; }
    const e = errorOf(r);
    // Sent, then the link to the computer dropped or timed out: it may have happened.
    if (e?.reason === 'OUTCOME_UNKNOWN') return 'Outcome unknown: your computer may have done this. Check the session before trying again.';
    if (r.status === 404) return state.share ? 'That shared session is no longer available: it was stopped, ended or its computer is offline.' : 'That computer is not reachable. Check it is awake, signed in and sharing sessions.';
    if (r.status === 403) return msgOf(r, 'This phone is not allowed to use remote sessions.');
    if (r.status === 413) return 'That message is too long to send.';
    if (r.status === 429) return msgOf(r, 'Your computer is busy. Try again in a moment.');
    if (e?.reason === 'REPLAYED') return 'That request was already sent. Check the conversation before trying again.';
    return msgOf(r, 'Something went wrong. Try again.');
  }

  async function boot() {
    try { token = await vault.load(); } catch { token = null; }
    if (!token) return set({ view: 'signin' });
    api.setToken(token);
    set({ view: 'hosts' });
    await loadHosts();
  }

  async function startSignIn(email, name) {
    const em = String(email ?? '').trim();
    const dn = String(name ?? '').trim().slice(0, 60) || deviceName;
    if (!/^[^\s@]+@[^\s@]+$/.test(em)) return set({ auth: { ...state.auth, error: 'Enter your email address.' } });
    set({ busy: true, notice: null, auth: { ...state.auth, email: em, deviceName: dn, error: null } });
    let r;
    try { r = await api.startEmail(em, dn); } catch { return set({ busy: false, auth: { ...state.auth, error: 'No connection. Check your network and try again.' } }); }
    if (r.status !== 200 || !r.body?.flow_id) return set({ busy: false, auth: { ...state.auth, error: msgOf(r, 'Could not send a code. Try again.') } });
    set({ busy: false, auth: { ...state.auth, flowId: r.body.flow_id } });
  }

  async function verifyCode(code) {
    const c = String(code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(c)) return set({ auth: { ...state.auth, error: 'Enter the 6-digit code from the email.' } });
    set({ busy: true, auth: { ...state.auth, error: null } });
    let r;
    try { r = await api.verifyEmail(state.auth.flowId, c, state.auth.deviceName); } catch { return set({ busy: false, auth: { ...state.auth, error: 'No connection. Check your network and try again.' } }); }
    const got = r.body?.device_token;
    if (r.status !== 200 || typeof got !== 'string') return set({ busy: false, auth: { ...state.auth, error: msgOf(r, 'That code did not work. Ask for a new one.') } });
    try { await vault.save(got); } catch { return set({ busy: false, auth: { ...state.auth, error: 'This browser cannot store the sign-in. Check private browsing is off.' } }); }
    token = got;
    api.setToken(token);
    set({ busy: false, view: 'hosts', notice: untold ? UNTOLD : null, auth: { ...state.auth, flowId: null, error: null } });
    await loadHosts();
  }

  function restartSignIn() { set({ auth: { ...state.auth, flowId: null, error: null } }); }

  // Signed out on the hub (200), or the hub already refuses it (401).
  async function tellHub() {
    let r = null;
    try { r = await api.signOut(); } catch { r = null; }
    return r?.status === 200 || r?.status === 401;
  }
  const UNTOLD = {
    tone: 'error',
    text: 'Signed out on this phone, but Plexiform could not be told, so this phone\'s sign-in still works until it is removed. Try again, or remove this phone from your account on another device.',
    action: { action: 'retry-signout', label: 'Try again' }, sticky: true,
  };
  const SIGNED_OUT = 'Signed out. This phone no longer has access.';

  async function signOut() {
    set({ busy: true });
    const held = token;
    if (await tellHub()) return signedOut(SIGNED_OUT);
    // Never claim access is gone when the hub still accepts the sign-in:
    // keep it in memory only (not in the vault) so the retry can tell the hub.
    untold = held;
    await signedOut(null, UNTOLD);
  }

  async function retrySignOut() {
    if (!untold) return;
    set({ busy: true });
    api.setToken(untold);
    const told = await tellHub();
    api.setToken(token);
    if (told) untold = null;
    set({ busy: false, notice: told ? { tone: 'warn', text: SIGNED_OUT } : UNTOLD });
  }

  // Sessions teammates shared with this account; a failure here never hides your own computers.
  async function loadShared() {
    if (typeof api.shared !== 'function') return;
    let r;
    try { r = await api.shared(); } catch { return set({ shared: { ...state.shared, error: 'Could not check sessions shared with you.' } }); }
    if (r.status !== 200) { const m = failure(r); if (m) set({ shared: { ...state.shared, error: m } }); return; }
    set({ shared: { items: Array.isArray(r.body?.shared) ? r.body.shared : [], error: null } });
  }

  async function loadHosts() {
    loadShared();
    let r;
    try { r = await api.hosts(); } catch {
      return set({ hosts: { ...state.hosts, error: online() ? 'Could not reach Plexiform. Retrying…' : 'You are offline.' } });
    }
    if (r.status !== 200) { const m = failure(r); if (m) set({ hosts: { ...state.hosts, error: m } }); return; }
    const items = Array.isArray(r.body?.hosts) ? r.body.hosts.filter((x) => !x.current) : [];
    set({ hosts: { items, loadedAt: now(), error: null } });
  }

  // Calls for the open session go through its share, or to your own computer.
  const relay = (op, args, o) => (state.share ? api.sharedCall(state.share.id, op, args, o) : api.call(state.host.id, op, args, o));

  async function openShared(id) {
    const share = state.shared.items?.find((x) => x.id === id);
    if (!share) return;
    loop++;
    set({ busy: true, notice: null, host: null, share });
    let r;
    try { r = await api.sharedCall(share.id, 'state', { session: share.session }); } catch {
      return set({ busy: false, share: null, notice: { tone: 'error', text: online() ? 'Could not reach that shared session.' : 'You are offline.' } });
    }
    set({ busy: false });
    const res = r.body?.result;
    if (r.status !== 200 || !res?.ok) {
      const m = r.status !== 200 ? failure(r) : res?.error ?? 'That shared session is no longer available.';
      set({ share: null, notice: m ? { tone: 'error', text: m } : null });
      return loadHosts();
    }
    enterSession(res.state, share.scope !== 'interact');
  }

  async function openHost(id) {
    const host = state.hosts.items?.find((x) => x.id === id);
    if (!host) return;
    loop++;
    set({ view: 'sessions', host, share: null, session: null, notice: null, sessions: { items: null, providers: null, loadedAt: null, error: null } });
    await loadSessions();
  }

  async function loadSessions() {
    const host = state.host;
    if (!host) return;
    let list, caps;
    try {
      [list, caps] = await Promise.all([api.call(host.id, 'list'), state.sessions.providers ? null : api.call(host.id, 'capabilities')]);
    } catch {
      return set({ sessions: { ...state.sessions, error: online() ? 'Could not reach your computer. Retrying…' : 'You are offline.' } });
    }
    if (state.host !== host) return;
    if (list.status !== 200) { const m = failure(list); if (m) set({ sessions: { ...state.sessions, error: m } }); return; }
    const res = list.body?.result;
    if (!res?.ok) return set({ sessions: { ...state.sessions, error: res?.error ?? 'Your computer refused the request.' } });
    const providers = caps?.status === 200 && caps.body?.result?.ok ? caps.body.result.providers : state.sessions.providers;
    set({ sessions: { items: res.sessions, providers, loadedAt: now(), error: null } });
  }

  function back() {
    loop++;
    loopAbort?.abort();
    if (state.view === 'session' && state.share) { set({ view: 'hosts', share: null, session: null, notice: null }); loadHosts(); return; }
    if (state.view === 'session') { set({ view: 'sessions', session: null, notice: null }); loadSessions(); return; }
    if (state.view === 'sessions') { set({ view: 'hosts', host: null, notice: null }); loadHosts(); }
  }

  function enterSession(st, readOnly = false) {
    const id = ++loop;
    set({ view: 'session', notice: null, session: { id: st.session, state: st, version: 0, lastOkAt: now(), link: 'live', failures: 0, pending: false, error: null, readOnly } });
    watchLoop(id);
  }

  async function openSession(sessionId) {
    const host = state.host;
    if (!host) return;
    set({ busy: true });
    let r;
    try { r = await api.call(host.id, 'state', { session: sessionId }); } catch {
      return set({ busy: false, sessions: { ...state.sessions, error: online() ? 'Could not reach your computer.' : 'You are offline.' } });
    }
    set({ busy: false });
    if (r.status !== 200) { const m = failure(r); if (m) set({ sessions: { ...state.sessions, error: m } }); return; }
    const res = r.body?.result;
    if (!res?.ok) { set({ sessions: { ...state.sessions, error: res?.error ?? 'That session is no longer available.' } }); return loadSessions(); }
    enterSession(res.state);
  }

  async function launch(provider) {
    const host = state.host;
    if (!host) return;
    set({ busy: true, notice: null });
    let r;
    try { r = await api.call(host.id, 'launch', { provider }); } catch { return set({ busy: false, notice: { tone: 'error', text: 'No connection: the session may not have started. Refresh before trying again.' } }); }
    set({ busy: false });
    if (r.status !== 200) { const m = failure(r); if (m) set({ notice: { tone: 'error', text: m } }); return; }
    const res = r.body?.result;
    if (!res?.ok) return set({ notice: { tone: 'error', text: res?.error ?? 'Your computer could not start a session.' } });
    enterSession(res.state);
  }

  async function watchLoop(id) {
    const ctl = new AbortController();
    loopAbort = ctl;
    while (loop === id && state.session) {
      const s = state.session;
      if (s.state?.status === 'ended') return;
      let r;
      try {
        r = await relay('watch', { session: s.id, after: s.version }, { timeout: WATCH_TIMEOUT_MS, signal: ctl.signal });
      } catch {
        if (loop !== id) return;
        const failures = s.failures + 1;
        setSession({ link: online() ? 'stale' : 'offline', failures });
        await sleep(backoffMs(failures, rand));
        continue;
      }
      if (loop !== id) return;
      if (r.status === 200 && r.body?.result) {
        const res = r.body.result;
        if (res.ok) {
          setSession({ state: res.state, version: res.version, lastOkAt: now(), link: 'live', failures: 0, error: null });
          if (res.state.status === 'ended') return;
          continue;
        }
        // The session was closed or replaced on the computer.
        setSession({ link: 'gone', error: res.error ?? 'This session is no longer available.' });
        return;
      }
      if (r.status === 401) { signedOut(); return; }
      const failures = s.failures + 1;
      const retry = Number(errorOf(r)?.retry_after_s);
      setSession({ link: r.status === 404 ? 'gone' : 'stale', failures, error: failure(r) });
      await sleep(Math.max(backoffMs(failures, rand), Number.isFinite(retry) ? retry * 1000 : 0));
    }
  }

  // Ops on the open session: the answer's state is the newest known state,
  // but liveness still comes from the poll.
  async function op(name, args) {
    const s = state.session;
    if (!s || s.pending) return false;
    setSession({ pending: true });
    set({ notice: null });
    let r;
    try { r = await relay(name, args); } catch {
      setSession({ pending: false });
      set({ notice: { tone: 'error', text: name === 'send'
        ? 'No connection: your message may not have been sent. Check the conversation before sending it again.'
        : 'No connection. Try again.' } });
      return false;
    }
    setSession({ pending: false });
    if (r.status !== 200) { const m = failure(r); if (m) set({ notice: { tone: 'error', text: m } }); return false; }
    const res = r.body?.result ?? {};
    if (res.state && state.session?.id === s.id) setSession({ state: res.state });
    if (!res.ok) {
      set({ notice: { tone: res.status === 'busy' ? 'warn' : 'error', text: res.error ?? 'Your computer refused that.' } });
      return false;
    }
    wakeFn?.();
    return true;
  }

  async function send(text) {
    const s = state.session;
    const t = String(text ?? '');
    if (!s || !t.trim()) return false;
    if (t.length > MAX_TEXT) { set({ notice: { tone: 'error', text: `Messages can be up to ${MAX_TEXT} characters.` } }); return false; }
    const v = sessionView(s, now());
    if (!v.canSend) { set({ notice: { tone: 'warn', text: 'Not connected to your computer right now. Wait for it to reconnect.' } }); return false; }
    const args = { session: s.id, generation: s.state.generation, text: t };
    if (v.canSteer) args.expectedTurn = s.state.activeTurn;
    return op('send', args);
  }

  function interrupt() {
    const s = state.session;
    if (!s?.state?.activeTurn) return false;
    return op('interrupt', { session: s.id, generation: s.state.generation, turn: s.state.activeTurn });
  }

  function close() {
    const s = state.session;
    // Only the owner closes a shared session.
    if (!s || state.share) return false;
    return op('close', { session: s.id, generation: s.state.generation });
  }

  // Back online / back in view: retry now instead of after the backoff.
  function wake() { wakeFn?.(); }

  return {
    get state() { return state; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    boot, startSignIn, verifyCode, restartSignIn, signOut, retrySignOut, loadHosts, loadShared, openHost, openShared, loadSessions,
    openSession, launch, back, send, interrupt, close, wake, dismissNotice: () => { if (!state.notice?.sticky) set({ notice: null }); },
  };
}
