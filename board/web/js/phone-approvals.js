// Phone approvals and tasks (W2-B): pair this phone with a computer, add a
// passkey there, answer that computer's waiting permission requests, and
// start a task by text or voice. No DOM in the controller (node --test drives
// it with fakes); approvalsView() returns h.js vnodes, text nodes only.
//
// REQUIRES INDEPENDENT SECURITY REVIEW before release (remote/THREAT_MODEL.md,
// docs/PHONE-RUNBOOK.md).
//
// - Pairing: the computer shows a QR / link (src/remote-pairing-view.js)
//   carrying its keys, a one-time secret and its hub device id; the link's
//   fragment never reaches a server. The steps go through the hub in plain
//   (approval-relay.js), protected by the secret's MAC and signatures
//   (remote/pairing.js); the person types the code this phone shows into the
//   computer. Each pairing gets a fresh non-extractable signing key here.
// - Passkey: right after pairing, a user-verified platform passkey for this
//   site, sent to the computer over the end-to-end channel.
// - Approvals: fetched sealed (approvals.list), each notice checked against
//   the computer's own signing key; a decision is signed with this pairing's
//   key, then confirmed with the passkey (challenge = sha256 of the exact
//   signed text) and sent sealed. Only a computer-signed "applied" counts.
//   A "desk only" request can be denied here but never allowed.
// - Tasks: tasks.start (sealed) starts a session on that computer and sends
//   the text. Voice is the browser's own SpeechRecognition (no Plexiform
//   server hears audio).
// - Push: an empty notification ping (phone-sw.js); nothing is in it.

import { h } from './h.js';
import { PairingClient, parsePairingQr } from './remote/pairing.js';
import { verifyRequestNotice, signDecision, interpretResult, revealHidden } from './remote/decision.js';
import { b64url, fromB64url, utf8 } from './remote/encoding.js';
import { canonicalize } from './remote/canonical.js';

export const PAIR_OPS = Object.freeze(['pair.init', 'pair.reveal', 'pair.poll']);
const callPath = (host) => `/api/approvals/v1/hosts/${encodeURIComponent(host)}/call`;
const HOST_ID = /^[A-Za-z0-9_-]{1,100}$/;
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const resultOf = (r) => (r?.status === 200 ? r.body?.result ?? null : null);
const errorText = (r, fallback) => r?.body?.error?.message || fallback;

/** The computer's passkey registration challenge (remote/src/webauthn.js passkeyRegistrationChallenge). */
export function passkeyChallenge(did, deviceId) {
  return sha256(utf8(canonicalize({ t: 'buddy.passkey.reg', v: 1, did, deviceId })));
}

/**
 * A pairing link (or just its fragment) → {qr, host}. The link is
 * `<phone origin>/phone/#pair=1&hub=…&did=…&dpk=…&pid=…&s=…&exp=…&h=<host device id>`.
 */
export function parsePairingLink(text, { origin, now = Date.now() }) {
  const s = String(text ?? '').trim();
  const frag = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s;
  const p = new URLSearchParams(frag);
  if (p.get('pair') !== '1') throw new Error('That is not a Plexiform pairing code.');
  const host = p.get('h');
  if (!host || !HOST_ID.test(host)) throw new Error('That is not a Plexiform pairing code.');
  const qr = { v: 1, t: 'buddy.pair', hub: p.get('hub'), did: p.get('did'), dpk: p.get('dpk'), pid: p.get('pid'), s: p.get('s'), exp: Number(p.get('exp')) };
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const parsed = parsePairingQr(JSON.stringify(qr), { now, allowInsecureHub: local });
  let hubOrigin = null;
  try { hubOrigin = new URL(parsed.hub).origin; } catch { hubOrigin = null; }
  if (hubOrigin !== origin) throw new Error('This code is for a different Plexiform hub than the one this phone is signed in to.');
  return { qr: parsed, host };
}

const blank = () => ({
  open: false, busy: false, notice: null,
  items: null, loadedAt: null, error: null,
  results: {}, // `${host}|${requestId}` -> {applied, message}
  pairing: { stage: 'idle', sas: null, error: null, text: '' },
  push: { state: 'unknown' },
  task: { busy: false, message: null, providers: null },
  hosts: [], // [{id, name, paired, passkey}]
});

/**
 * api: phone-core createApi (request, hosts, call); e2e: its createE2E; vault:
 * phone-vault; credentials: navigator.credentials; push: {subscribe(key) →
 * PushSubscription, state() → 'on'|'off'|'unsupported'} or null.
 */
export function createApprovals({ api, e2e, vault, credentials, push = null, origin, rpId, now = () => Date.now(), uuid, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), deviceName = 'Phone' }) {
  let state = blank();
  const subs = new Set();
  const set = (patch) => { state = { ...state, ...patch }; for (const fn of [...subs]) fn(state); };

  async function acall(host, op, args) {
    if (PAIR_OPS.includes(op)) return api.request('POST', callPath(host), { request_id: uuid(), op, args });
    const ch = await e2e.channelFor(host);
    if (!ch) return { status: 409, body: { error: { code: 'NOT_PAIRED', message: 'Pair this phone with that computer first.' } } };
    return ch.call(op, args, (rid, name, enc) => api.request('POST', callPath(host), { request_id: rid, op: name, enc }), uuid);
  }

  async function hostList() {
    const r = await api.hosts().catch(() => null);
    const live = r?.status === 200 && Array.isArray(r.body?.hosts) ? r.body.hosts : [];
    const pairs = await vault.pairings();
    return live.map((x) => ({ id: x.id, name: x.name || 'Computer', paired: !!pairs[x.id]?.dpk, passkey: !!pairs[x.id]?.credentialId }));
  }

  async function load() {
    set({ busy: true, error: null });
    const hosts = await hostList();
    const pairs = await vault.pairings();
    const items = [];
    let error = null;
    for (const host of hosts.filter((x) => x.paired)) {
      const rec = pairs[host.id];
      const r = await acall(host.id, 'approvals.list', {}).catch(() => null);
      const res = resultOf(r);
      if (!res?.ok || !Array.isArray(res.items)) { error = res?.error || errorText(r, `Couldn’t reach ${host.name}.`); continue; }
      for (const env of res.items.slice(0, 20)) {
        try {
          const notice = await verifyRequestNotice(env, { desktopPub: rec.dpk, desktopId: rec.did }, { now: now() });
          items.push({ host: host.id, hostName: host.name, notice });
        } catch { error = 'A request that your computer did not sign was hidden.'; }
      }
    }
    if (!state.task.providers && hosts.some((x) => x.paired)) loadProviders(hosts.find((x) => x.paired).id);
    set({ busy: false, hosts, items, loadedAt: now(), error });
  }

  async function loadProviders(host) {
    const r = await api.call(host, 'capabilities', {}).catch(() => null);
    const list = Array.isArray(r?.body?.result?.providers) ? r.body.result.providers.filter((p) => p && p.available && p.ownership === 'plexiform-owned').map((p) => ({ id: p.provider, label: p.label })) : null;
    if (list) set({ task: { ...state.task, providers: list } });
  }

  function fail(stage, error) { set({ busy: false, pairing: { ...state.pairing, stage, error } }); return false; }

  async function pair(text) {
    let link;
    try { link = parsePairingLink(text, { origin, now: now() }); } catch (e) { return fail('idle', e.message); }
    const { qr, host } = link;
    set({ busy: true, pairing: { stage: 'sending', sas: null, error: null, text: '' } });
    try {
      const keyPair = await vault.newSigningKey();
      const agree = await vault.agreementKey();
      const client = await PairingClient.begin(qr, { deviceName, keyPair, agreeKeyPair: { privateKey: agree.privateKey, publicKey: agree.publicKey } });
      const r1 = resultOf(await acall(host, 'pair.init', client.init));
      if (!r1?.ok) return fail('error', 'Your computer did not accept the pairing. Show a new code there and try again.');
      const { reveal, sas } = await client.onChallenge(r1.challenge);
      const r2 = resultOf(await acall(host, 'pair.reveal', reveal));
      if (!r2?.ok) return fail('error', 'Your computer did not accept the pairing. Show a new code there and try again.');
      set({ busy: false, pairing: { stage: 'code', sas, error: null, text: '' } });
      let complete = null;
      while (!complete) {
        if (now() > qr.exp + 60_000) return fail('error', 'The pairing timed out. Show a new code on your computer.');
        await sleep(1500);
        const r3 = resultOf(await acall(host, 'pair.poll', { pid: qr.pid }).catch(() => null));
        if (r3?.ok && r3.state === 'complete') complete = r3.complete;
        else if (r3 && r3.ok === false) return fail('error', 'The pairing ended on your computer (a wrong code cancels it). Start again there.');
      }
      const paired = await client.onComplete(complete);
      await vault.savePairing(host, { did: paired.desktopId, dev: paired.deviceId, desktopAgree: paired.desktopAgree, dpk: paired.desktopPub, sign: keyPair });
      set({ pairing: { stage: 'passkey', sas: null, error: null, text: '' } });
      const ok = await registerPasskey(host);
      set({ pairing: { stage: ok ? 'done' : 'error', sas: null, error: ok ? null : 'Paired, but the passkey was not added, so this phone can’t approve yet. Pair again to retry.', text: '' } });
      await load();
      return ok;
    } catch (e) {
      return fail('error', e?.message || 'The pairing failed.');
    }
  }

  async function registerPasskey(host) {
    const rec = (await vault.pairings())[host];
    if (!rec?.dpk) return false;
    let cred;
    try {
      cred = await credentials.create({ publicKey: {
        rp: { id: rpId, name: 'Plexiform' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `plexiform-${rec.dev.slice(0, 8)}`, displayName: 'Plexiform approvals' },
        challenge: await passkeyChallenge(rec.did, rec.dev),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        attestation: 'none', timeout: 120_000,
      } });
    } catch { return false; }
    const resp = cred?.response;
    if (!resp || typeof resp.getPublicKey !== 'function') return false;
    const spki = resp.getPublicKey();
    if (!spki) return false;
    const args = {
      credentialId: b64url(cred.rawId), publicKey: b64url(spki), algorithm: resp.getPublicKeyAlgorithm(),
      authenticatorData: b64url(resp.getAuthenticatorData()), clientDataJSON: b64url(resp.clientDataJSON),
    };
    const res = resultOf(await acall(host, 'approvals.passkey', args).catch(() => null));
    if (!res?.ok) return false;
    await vault.savePasskey(host, args.credentialId);
    return true;
  }

  /** Allow or deny one waiting request: sign, passkey, send sealed, believe only a signed "applied". */
  async function decide(host, requestId, decision) {
    const key = `${host}|${requestId}`;
    const item = (state.items ?? []).find((x) => x.host === host && x.notice.requestId === requestId);
    const rec = (await vault.pairings())[host];
    const done = (applied, message) => { set({ busy: false, results: { ...state.results, [key]: { applied, message } } }); return applied; };
    if (!item || !rec?.sign) return done(false, 'That request is no longer here. Refresh.');
    if (decision === 'allow' && item.notice.deskOnly) return done(false, 'This one can only be approved at your desk.');
    if (!rec.credentialId) return done(false, 'Add a passkey first: pair this phone again.');
    set({ busy: true });
    const { envelope, payload } = await signDecision({ device: { deviceId: rec.dev, privateKey: rec.sign.privateKey }, desktopId: rec.did, request: item.notice, decision, now: now() });
    let cred;
    try {
      cred = await credentials.get({ publicKey: {
        challenge: await sha256(utf8(envelope.payload)), rpId,
        allowCredentials: [{ type: 'public-key', id: fromB64url(rec.credentialId) }],
        userVerification: 'required', timeout: 60_000,
      } });
    } catch { return done(false, 'Cancelled — nothing was sent.'); }
    const a = cred?.response;
    if (!a) return done(false, 'Cancelled — nothing was sent.');
    const assertion = { authenticatorData: b64url(a.authenticatorData), clientDataJSON: b64url(a.clientDataJSON), signature: b64url(a.signature) };
    const r = await acall(host, 'approvals.decide', { envelope, assertion }).catch(() => null);
    const res = resultOf(r);
    const outcome = res?.ok ? { status: 'delivered', body: res.body } : r?.status === 404 ? { status: 'desktop-offline' } : { status: 'timeout' };
    const verdict = await interpretResult(outcome, { desktopPubRaw: rec.dpk, sent: payload });
    done(verdict.applied, verdict.message);
    if (verdict.applied) set({ items: (state.items ?? []).filter((x) => x !== item) });
    return verdict.applied;
  }

  async function startTask(host, provider, text) {
    const t = String(text ?? '').trim();
    if (!t) { set({ task: { ...state.task, message: 'Type what the task should do.' } }); return false; }
    set({ task: { ...state.task, busy: true, message: null } });
    const r = await acall(host, 'tasks.start', { provider, text: t }).catch(() => null);
    const res = resultOf(r);
    const ok = !!res?.ok;
    set({ task: { ...state.task, busy: false, message: ok ? 'Started. Open the computer’s sessions to follow it.' : res?.error || errorText(r, 'The task did not start. Check the computer before trying again.') } });
    return ok;
  }

  async function enablePush() {
    if (!push) { set({ push: { state: 'unsupported' } }); return false; }
    const k = await api.request('GET', '/api/push/v1/key').catch(() => null);
    if (k?.status !== 200 || typeof k.body?.publicKey !== 'string') { set({ push: { state: 'unavailable' } }); return false; }
    let sub;
    try { sub = await push.subscribe(fromB64url(k.body.publicKey)); } catch { set({ push: { state: 'denied' } }); return false; }
    const r = await api.request('PUT', '/api/push/v1/subscription', { endpoint: sub.endpoint }).catch(() => null);
    const ok = r?.status === 200;
    set({ push: { state: ok ? 'on' : 'unavailable' } });
    return ok;
  }

  return {
    get state() { return state; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    open(prefill = '') { set({ open: true, notice: null, pairing: { ...state.pairing, text: prefill || state.pairing.text } }); if (push) set({ push: { state: push.state() } }); return load(); },
    close() { set({ open: false }); },
    reset() { state = blank(); },
    load, pair, registerPasskey, decide, startTask, enablePush,
  };
}

// ── View ───────────────────────────────────────────────────────────────────

const btn = (action, label, { kind = '', id, disabled = false } = {}) =>
  h('button', { type: 'button', class: `btn ${kind}`.trim(), 'data-action': action, 'data-id': id ?? null, disabled: disabled || null }, label);

/** What a request is about, as text: the command for a shell, else the input itself (shortened). */
export function describeInput(notice) {
  const i = notice.toolInput ?? {};
  const raw = typeof i.command === 'string' ? i.command : typeof i.file_path === 'string' ? i.file_path : canonicalize(i);
  const text = revealHidden(raw);
  return text.length > 2000 ? `${text.slice(0, 2000)} … (+${text.length - 2000} characters, see it at your desk)` : text;
}

const PAIR_TEXT = {
  sending: 'Pairing…',
  code: null,
  passkey: 'Paired. Now confirm with Face ID, Touch ID or your fingerprint to add a passkey for approvals.',
  done: 'Paired, with a passkey. This phone can now answer that computer’s requests.',
};

function pairSection(st) {
  const p = st.pairing;
  return h('section', { class: 'approvals-pair', 'aria-labelledby': 'pair-title' },
    h('h2', { id: 'pair-title' }, 'Pair with a computer'),
    p.stage === 'code'
      ? h('div', { class: 'sas', role: 'status' },
        h('p', null, 'Type this code into Plexiform on your computer:'),
        h('p', { class: 'sas-code', 'aria-label': `Code ${p.sas.split('').join(' ')}` }, `${p.sas.slice(0, 3)} ${p.sas.slice(3)}`),
        h('p', { class: 'muted small' }, 'Only type it on your own computer. Never read it out to anyone.'))
      : PAIR_TEXT[p.stage] ? h('p', { role: 'status' }, PAIR_TEXT[p.stage]) : null,
    p.error ? h('p', { class: 'field-error', role: 'alert' }, p.error) : null,
    ['idle', 'error', 'done'].includes(p.stage)
      ? h('form', { class: 'stack', 'data-form': 'pair', novalidate: true },
        h('label', { for: 'pair-link' }, 'Pairing link from your computer (Settings → Phone)'),
        h('textarea', { id: 'pair-link', name: 'link', rows: '3', autocomplete: 'off', spellcheck: 'false', value: p.text }),
        h('button', { type: 'submit', class: 'btn primary', disabled: st.busy || null }, 'Pair'))
      : null);
}

function requestRow(x, st, now) {
  const n = x.notice;
  const key = `${x.host}|${n.requestId}`;
  const res = st.results[key];
  const secs = Math.max(0, Math.round((n.expiresAt - now) / 1000));
  return h('li', { key, class: 'approval' },
    h('p', { class: 'row-title' }, `${n.toolName} on ${x.hostName}`),
    n.deskOnly ? h('p', { class: 'pill warn' }, `Desk only: ${n.deskOnly.reason}`) : null,
    h('pre', { class: 'approval-input' }, describeInput(n)),
    n.cwd ? h('p', { class: 'muted small' }, `In ${revealHidden(n.cwd)}`) : null,
    h('p', { class: 'muted small' }, secs ? `Waiting · ${secs} s left` : 'Expired'),
    res ? h('p', { role: 'status', class: res.applied ? 'ok-text' : 'warn-text' }, res.message) : null,
    h('div', { class: 'actions' },
      btn('approve', 'Allow', { kind: 'primary', id: key, disabled: st.busy || !!n.deskOnly || !secs }),
      btn('deny', 'Deny', { id: key, disabled: st.busy || !secs })));
}

function taskSection(st) {
  const paired = st.hosts.filter((x) => x.paired);
  if (!paired.length) return null;
  const providers = st.task.providers ?? [{ id: 'codex', label: 'Codex' }];
  return h('section', { class: 'approvals-task', 'aria-labelledby': 'task-title' },
    h('h2', { id: 'task-title' }, 'Start a task'),
    h('form', { class: 'stack', 'data-form': 'task', novalidate: true },
      h('label', { for: 'task-host' }, 'On'),
      h('select', { id: 'task-host', name: 'host' }, paired.map((x) => h('option', { value: x.id }, x.name))),
      h('label', { for: 'task-provider' }, 'With'),
      h('select', { id: 'task-provider', name: 'provider' }, providers.map((p) => h('option', { value: p.id }, p.label || p.id))),
      h('label', { for: 'task-text' }, 'What should it do?'),
      h('textarea', { id: 'task-text', name: 'text', rows: '3', maxlength: '4000' }),
      h('div', { class: 'actions' },
        btn('task-voice', 'Speak', { kind: 'quiet' }),
        h('button', { type: 'submit', class: 'btn primary', disabled: st.task.busy || null }, st.task.busy ? 'Starting…' : 'Start')),
      h('p', { class: 'muted small' }, 'Speak uses your phone browser’s own speech recognition; Plexiform’s servers never get the audio.'),
      st.task.message ? h('p', { role: 'status' }, st.task.message) : null));
}

const PUSH_TEXT = { on: 'Notifications are on.', denied: 'Notifications are blocked for this site in your phone’s settings.', unsupported: 'This browser can’t show notifications. On iPhone, add Plexiform to your Home Screen first.', unavailable: 'Your hub doesn’t send notifications yet.' };

export function approvalsView(st, now) {
  const items = st.items;
  return h('main', { class: 'screen approvals' },
    h('header', { class: 'bar' },
      h('button', { type: 'button', class: 'btn icon', 'data-action': 'approvals-back', 'aria-label': 'Back to your computers' }, h('span', { 'aria-hidden': 'true' }, '‹')),
      h('h1', { tabindex: '-1' }, 'Approvals'),
      btn('approvals-refresh', 'Refresh', { kind: 'quiet small', disabled: st.busy })),
    st.error ? h('p', { class: 'muted warn-text', role: 'status' }, st.error) : null,
    h('section', { 'aria-labelledby': 'waiting-title' },
      h('h2', { id: 'waiting-title' }, 'Waiting on you'),
      items == null ? h('p', { class: 'muted' }, 'Loading…')
        : items.length ? h('ul', { class: 'list', role: 'list' }, items.map((x) => requestRow(x, st, now)))
          : h('p', { class: 'muted' }, st.hosts.some((x) => x.paired) ? 'Nothing is waiting.' : 'Pair this phone with a computer to answer its requests here.')),
    h('section', { 'aria-labelledby': 'push-title' },
      h('h2', { id: 'push-title' }, 'Notifications'),
      h('p', { class: 'muted small' }, 'A notification only says that something needs you. What it is stays encrypted until you open it here.'),
      PUSH_TEXT[st.push.state] ? h('p', { role: 'status' }, PUSH_TEXT[st.push.state]) : null,
      st.push.state === 'on' || st.push.state === 'unsupported' ? null : btn('push-on', 'Turn on notifications', { kind: 'small' })),
    taskSection(st),
    pairSection(st));
}
