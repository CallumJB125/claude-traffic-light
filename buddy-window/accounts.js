// Buddy account client: one per team hub, Electron-free (main injects fetch
// and a sealed token store, tests inject a mock hub). The device token lives
// only in main; nothing here returns it to a caller except `accessToken()`,
// which main uses for its own requests and the board view's header.
//
// Every endpoint path is in ROUTES so the hub's final paths are a one-line
// change each (callumbaker-70's BOARD_AUTH=accounts, board/ACCOUNTS-API.md).
'use strict';

const crypto = require('node:crypto');

const ROUTES = {
  health: ['GET', '/api/health'],
  emailStart: ['POST', '/api/auth/email/start'],
  emailVerify: ['POST', '/api/auth/email/verify'],
  account: ['GET', '/api/account'],
  signOut: ['POST', '/api/auth/signout'],
  deleteAccount: ['POST', '/api/account/delete'],
  createTeam: ['POST', '/api/teams'],
  members: ['GET', '/api/teams/:team/members'],
  setRole: ['PATCH', '/api/teams/:team/members/:member'],
  removeMember: ['DELETE', '/api/teams/:team/members/:member'],
  invites: ['GET', '/api/teams/:team/invites'],
  invite: ['POST', '/api/teams/:team/invites'],
  revokeInvite: ['DELETE', '/api/teams/:team/invites/:invite'],
  previewInvite: ['POST', '/api/invites/preview'],
  acceptInvite: ['POST', '/api/invites/accept'],
  enrol: ['POST', '/api/teams/:team/enrol'],
  unenrol: ['DELETE', '/api/teams/:team/enrol/:enrollment'],
};

const ROLES = ['owner', 'admin', 'member', 'guest'];
const TIMEOUT_MS = 15_000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
// Invite tokens and ids travel in URLs and bodies; keep them to a safe alphabet.
const TOKEN_RE = /^[A-Za-z0-9_-]{1,200}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

function routePath(name, params = {}) {
  return ROUTES[name][1].replace(/:(\w+)/g, (_m, k) => {
    const v = String(params[k] ?? '');
    if (!ID_RE.test(v)) throw new Error(`bad ${k}`);
    return encodeURIComponent(v);
  });
}

// Hub errors are `{error:{code, message}}` (CONTRACT). The hub's message is
// written for developers; these are the sentences a person sees.
const INVITE_GONE = 'This invite link isn’t valid any more. Ask for a new one.';
const CODE_TEXT = {
  INVALID_CODE: 'That code isn’t right. Check the email and try again.',
  CODE_EXPIRED: 'That code has expired. Send a new one.',
  TOO_MANY_ATTEMPTS: 'Too many wrong codes. Send a new one.',
  RATE_LIMITED: 'Too many tries. Wait a minute and try again.',
  LAST_OWNER: 'A team needs at least one owner. Make someone else an owner first.',
  // One message for every dead invite: which one it was helps nobody.
  INVITE_EXPIRED: INVITE_GONE,
  INVITE_USED: INVITE_GONE,
  INVITE_REVOKED: INVITE_GONE,
  INVITE_NOT_FOUND: INVITE_GONE,
  FORBIDDEN: 'You don’t have permission to do that in this team.',
  NOT_FOUND: 'That no longer exists.',
};

function humanError(status, json, host) {
  const code = json?.error?.code;
  if (code && CODE_TEXT[code]) return CODE_TEXT[code];
  if (status === 429) return CODE_TEXT.RATE_LIMITED;
  if (status === 403) return CODE_TEXT.FORBIDDEN;
  if (status === 404) return CODE_TEXT.NOT_FOUND;
  if (status >= 500) return `${host} had a problem. Try again in a moment.`;
  const m = json?.error?.message;
  // Short hub messages are fine to show; long ones are stack-ish noise.
  if (typeof m === 'string' && m.length > 0 && m.length <= 160) return m.charAt(0).toUpperCase() + m.slice(1);
  return `Something went wrong (${status}).`;
}

/**
 * createAccountClient({origin, fetchImpl, store:{load(), save(obj), clear()}, now, onSignedOut})
 * Every method resolves `{ok:true, ...}` or `{ok:false, error:<sentence>, code?, signedOut?}`.
 * `store.load()` → `{hub, token, device_id, user}` or null.
 */
function createAccountClient({ origin, fetchImpl = fetch, store, now = () => Date.now(), onSignedOut = () => {} }) {
  const host = new URL(origin).host;
  let flow = null; // {id, email, purpose, at}: the email-code flow in progress

  function saved() {
    let s = null;
    try { s = store.load(); } catch { s = null; }
    // A token is only ever sent to the hub that issued it.
    if (!s || s.hub !== origin || typeof s.token !== 'string' || !s.token) return null;
    return s;
  }

  async function call(name, { params, body, auth = true } = {}) {
    const [method] = ROUTES[name];
    let url;
    try { url = origin + routePath(name, params); } catch { return { ok: false, error: 'That isn’t a valid id.' }; }
    const headers = { Accept: 'application/json' };
    const s = auth ? saved() : null;
    if (auth && !s) return { ok: false, signedOut: true, error: 'Sign in first.' };
    if (s) headers.Authorization = `Bearer ${s.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
      res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'manual' });
    } catch {
      return { ok: false, error: `Couldn’t reach ${host}. Check the address and your connection.` };
    }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    if (res.status === 401 && s) {
      // No refresh in this model: a 401 on the device token means it was
      // revoked (signed out elsewhere, account deleted, device removed).
      if (saved()?.token === s.token) { try { store.clear(); } catch { /* already gone */ } try { onSignedOut(); } catch { /* UI gone */ } }
      return { ok: false, signedOut: true, error: 'You’ve been signed out. Sign in again.' };
    }
    if (res.status < 200 || res.status >= 300 || !json || typeof json !== 'object') {
      return { ok: false, status: res.status, code: json?.error?.code ?? null, detail: json?.error ?? null, error: humanError(res.status, json, host) };
    }
    return { ok: true, ...json };
  }

  const need = (cond, error) => (cond ? null : { ok: false, error });

  return {
    origin,
    signedIn: () => !!saved(),
    user: () => saved()?.user ?? null,
    /** For main's own requests and the board view's Authorization header; never for a page. */
    accessToken: async () => saved()?.token ?? null,

    async startEmail(email) {
      const e = String(email ?? '').trim().toLowerCase();
      const bad = need(EMAIL_RE.test(e), 'Enter your email address.');
      if (bad) return bad;
      const r = await call('emailStart', { body: { email: e }, auth: false });
      if (!r.ok) return r;
      if (typeof r.flow_id !== 'string') return { ok: false, error: `${host} didn’t start a sign-in.` };
      flow = { id: r.flow_id, email: e, purpose: 'sign_in', at: now() };
      return { ok: true, email: e };
    },

    async verifyCode(code, { deviceName, platform } = {}) {
      const c = String(code ?? '').replace(/\D/g, '');
      if (!flow || flow.purpose !== 'sign_in') return { ok: false, error: 'Start again: enter your email.' };
      const bad = need(c.length === 6, 'The code is 6 digits.');
      if (bad) return bad;
      const r = await call('emailVerify', { body: { flow_id: flow.id, code: c, device_name: String(deviceName ?? 'Mac').slice(0, 100), platform: String(platform ?? 'darwin').slice(0, 20) }, auth: false });
      if (!r.ok) {
        if (r.code === 'CODE_EXPIRED' || r.code === 'TOO_MANY_ATTEMPTS') flow = null;
        return r;
      }
      if (typeof r.device_token !== 'string' || !r.device_token) return { ok: false, error: `${host} didn’t sign you in.` };
      try {
        store.save({ hub: origin, token: r.device_token, device_id: r.device_id ?? null, user: r.user ?? null });
      } catch {
        return { ok: false, error: 'This Mac couldn’t store your sign-in securely. Try again.' };
      }
      const email = flow.email;
      flow = null;
      return { ok: true, user: r.user ?? null, teams: Array.isArray(r.teams) ? r.teams : [], email };
    },

    pendingEmail: () => (flow?.purpose === 'sign_in' ? flow.email : null),

    me: () => call('account'),
    createTeam(name) {
      const n = String(name ?? '').trim();
      if (!n || n.length > 60) return Promise.resolve({ ok: false, error: 'Give the team a name (up to 60 characters).' });
      return call('createTeam', { body: { name: n, request_id: crypto.randomUUID() } });
    },
    listMembers: (team) => call('members', { params: { team } }),
    setRole(team, member, role) {
      if (!ROLES.includes(role)) return Promise.resolve({ ok: false, error: 'Pick a role.' });
      return call('setRole', { params: { team, member }, body: { role } });
    },
    removeMember: (team, member) => call('removeMember', { params: { team, member } }),
    listInvites: (team) => call('invites', { params: { team } }),
    invite(team, email, role = 'member') {
      const e = String(email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(e)) return Promise.resolve({ ok: false, error: 'Enter their email address.' });
      if (!ROLES.includes(role) || role === 'owner') return Promise.resolve({ ok: false, error: 'Pick a role.' });
      return call('invite', { params: { team }, body: { email: e, role, request_id: crypto.randomUUID() } });
    },
    revokeInvite: (team, invite) => call('revokeInvite', { params: { team, invite } }),
    // The token goes in the body, never the URL, so no log or proxy keeps it.
    previewInvite(t) {
      if (!TOKEN_RE.test(String(t ?? ''))) return Promise.resolve({ ok: false, error: CODE_TEXT.INVITE_NOT_FOUND });
      return call('previewInvite', { body: { t }, auth: !!saved() });
    },
    acceptInvite(ref) {
      const body = ref?.inviteId ? { invite_id: String(ref.inviteId) } : { t: String(ref?.t ?? '') };
      if (body.t !== undefined && !TOKEN_RE.test(body.t)) return Promise.resolve({ ok: false, error: CODE_TEXT.INVITE_NOT_FOUND });
      return call('acceptInvite', { body });
    },
    enrol: (team, name) => call('enrol', { params: { team }, body: { name: String(name ?? '').slice(0, 100), request_id: crypto.randomUUID() } }),
    unenrol: (team, enrollment) => call('unenrol', { params: { team, enrollment } }),

    async signOut() {
      const r = saved() ? await call('signOut', { body: {} }) : { ok: true };
      // Forget the token whatever the hub said: signing out must always work offline.
      try { store.clear(); } catch { /* already gone */ }
      flow = null;
      return { ok: true, revoked: r.ok };
    },

    async startStepUp() {
      const email = saved()?.user?.email;
      if (!email) return { ok: false, error: 'Sign in first.' };
      const r = await call('emailStart', { body: { email, purpose: 'step_up' }, auth: true });
      if (!r.ok) return r;
      flow = { id: r.flow_id, email, purpose: 'step_up', at: now() };
      return { ok: true, email };
    },

    async deleteAccount(code) {
      const c = String(code ?? '').replace(/\D/g, '');
      if (!flow || flow.purpose !== 'step_up') return { ok: false, error: 'Ask for a new code first.' };
      if (c.length !== 6) return { ok: false, error: 'The code is 6 digits.' };
      const r = await call('deleteAccount', { body: { flow_id: flow.id, step_up_code: c } });
      if (!r.ok) return r;
      try { store.clear(); } catch { /* already gone */ }
      flow = null;
      return { ok: true };
    },
  };
}

// ── invite links ────────────────────────────────────────────────────────────

/**
 * Parse an invite from a deep link or whatever someone pasted:
 *   claudebuddy://join?hub=<origin>&t=<token>
 *   claudebuddy://invite/<token>  ·  claudebuddy://invite?t=<token>
 *   https://<hub>/invite#<token>  (the universal link in the email; the
 *                                  token rides in the fragment so no server logs it)
 *   https://<hub>/invite/<token>
 *   <token>                       (a bare code)
 * → {hub: origin|null, token} or null. `hub` is attacker-controlled: the
 * caller decides whether to trust it (routeInvite). `normalizeHub` must
 * throw for anything that is not an acceptable hub origin.
 */
function parseInvite(input, { normalizeHub }) {
  const s = String(input ?? '').trim();
  if (!s || s.length > 2048) return null;
  const tok = (t) => (typeof t === 'string' && TOKEN_RE.test(t) ? t : null);
  if (!s.includes(':') && !s.includes('/')) { const t = tok(s); return t ? { hub: null, token: t } : null; }
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.username || u.password) return null;
  if (u.protocol === 'claudebuddy:') {
    // Chromium puts the part after `//` in host for non-special schemes.
    const where = (u.host || '').toLowerCase();
    const segs = u.pathname.split('/').filter(Boolean);
    if (where === 'join') {
      if (segs.length) return null;
      const t = tok(u.searchParams.get('t'));
      const rawHub = u.searchParams.get('hub');
      if (!t || !rawHub) return null;
      let hub;
      try { hub = normalizeHub(rawHub); } catch { return null; }
      // The hub must be exactly an origin, nothing trailing.
      if (rawHub.replace(/\/$/, '') !== hub) return null;
      return { hub, token: t };
    }
    if (where === 'invite') {
      if (segs.length === 1 && !u.search) { const t = tok(decodeURIComponent(segs[0])); return t ? { hub: null, token: t } : null; }
      if (segs.length === 0) { const t = tok(u.searchParams.get('t')); return t ? { hub: null, token: t } : null; }
    }
    return null;
  }
  if (u.protocol === 'https:' || u.protocol === 'http:') {
    const m = /^\/invite(?:\/([^/]+))?\/?$/.exec(u.pathname);
    if (!m || u.search) return null;
    let hub;
    try { hub = normalizeHub(u.origin); } catch { return null; }
    const raw = m[1] ?? u.hash.slice(1);
    if (m[1] && u.hash) return null;
    const t = tok(decodeURIComponent(raw));
    return t ? { hub, token: t } : null;
  }
  return null;
}

/**
 * What to do with a parsed invite. A hub named by a link that we have never
 * signed in to (or connected) gets an explicit confirmation first: the link
 * could come from anyone.
 *   {action:'confirm', hub}   unknown hub: "Join a team on <host>?"
 *   {action:'signin', hub}    known hub, signed out: sign in, then preview
 *   {action:'preview', hub}   known hub, signed in
 *   {action:'need-hub'}       no hub in the link and none we can assume
 */
function routeInvite(inv, { knownHubs = [], signedIn = () => false, lastHub = null }) {
  const known = new Set(knownHubs);
  const hub = inv.hub ?? (lastHub && known.has(lastHub) ? lastHub : (knownHubs.length === 1 ? knownHubs[0] : null));
  if (!hub) return { action: 'need-hub' };
  if (!known.has(hub)) return { action: 'confirm', hub };
  return { action: signedIn(hub) ? 'preview' : 'signin', hub };
}

/** Mask an email for "This invite is for c…@example.com". */
function maskEmail(e) {
  const m = /^([^@]+)@(.+)$/.exec(String(e ?? ''));
  return m ? `${m[1].charAt(0)}…@${m[2]}` : '';
}

/**
 * The only request URLs that may carry a hub's device token: the hub's exact
 * origin (scheme, host, port) and its WebSocket twin. `urls` feeds
 * session.webRequest's filter; `matches` is re-checked in the listener so the
 * guarantee doesn't rest on match-pattern semantics (which ignore ports).
 */
function bearerScope(origin) {
  const u = new URL(origin);
  if (u.origin !== origin) throw new Error('not an origin');
  const ws = u.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsOrigin = `${ws}//${u.host}`;
  return {
    urls: [`${origin}/*`, `${wsOrigin}/*`],
    matches(url) {
      let t;
      try { t = new URL(url); } catch { return false; }
      if (t.username || t.password) return false;
      if (t.protocol === u.protocol) return t.origin === origin;
      if (t.protocol === ws) return `${ws}//${t.host}` === wsOrigin;
      return false;
    },
  };
}

module.exports = { createAccountClient, ROUTES, ROLES, parseInvite, routeInvite, maskEmail, bearerScope, humanError, TOKEN_RE };
