// Buddy account client: one per team hub, Electron-free (main injects fetch
// and a sealed token store, tests inject a mock hub). The device token lives
// only in main; nothing here returns it to a caller except `accessToken()`,
// which main uses for its own requests and the runner's config.
//
// Every endpoint path is in ROUTES so the hub's final paths are a one-line
// change each (callumbaker-70's BOARD_AUTH=accounts, board/ACCOUNTS-API.md).
'use strict';

const crypto = require('node:crypto');
const { SCHEMES } = require('./brand');

const ROUTES = {
  health: ['GET', '/api/health'],
  emailStart: ['POST', '/api/auth/email/start'],
  emailVerify: ['POST', '/api/auth/email/verify'],
  account: ['GET', '/api/account'],
  signOut: ['POST', '/api/auth/signout'],
  deleteAccount: ['DELETE', '/api/account'],
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
  unenrol: ['DELETE', '/api/teams/:team/enrol'],
};

const ROLES = ['owner', 'admin', 'member', 'guest'];
const TIMEOUT_MS = 15_000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
// Invite tokens and ids travel in URLs and bodies; keep them to a safe alphabet.
const TOKEN_RE = /^[A-Za-z0-9_-]{1,200}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
// The hub counts a verified delete flow as fresh for 5 minutes (D56).
const STEP_UP_MS = 5 * 60_000;

function routePath(name, params = {}) {
  return ROUTES[name][1].replace(/:(\w+)/g, (_m, k) => {
    const v = String(params[k] ?? '');
    if (!ID_RE.test(v)) throw new Error(`bad ${k}`);
    return encodeURIComponent(v);
  });
}

// Hub errors are `{error:{code, message, ...extra}}` (ACCOUNTS-API.md). The
// hub's message is written for developers; these are the sentences a person sees.
const INVITE_GONE = 'This invite link isn’t valid any more. Ask for a new one.';
const CODE_TEXT = {
  LAST_OWNER: 'A team needs at least one owner. Make someone else an owner first.',
  FORBIDDEN: 'You don’t have permission to do that in this team.',
  NOT_FOUND: 'That no longer exists.',
};

// Wrong, expired and used codes are one answer on the hub, so they are one
// sentence here too; only the tries left differ.
function codeText(attemptsLeft) {
  const n = attemptsLeft;
  return Number.isInteger(n) && n > 0 ? `That code didn’t work. ${n} ${n === 1 ? 'try' : 'tries'} left.` : 'That code didn’t work. Send a new code.';
}

function waitText(retryAfterS) {
  const m = Math.ceil((Number(retryAfterS) > 0 ? Number(retryAfterS) : 60) / 60);
  return `Too many tries. Wait ${m <= 1 ? 'a minute' : `${m} minutes`} and try again.`;
}

function humanError(status, json, host) {
  const e = json?.error;
  const code = e?.code;
  if (code === 'RATE_LIMITED' || status === 429) return waitText(e?.retry_after_s);
  if (code === 'INVALID_TOKEN') return codeText(e?.attempts_left);
  if (code && CODE_TEXT[code]) return CODE_TEXT[code];
  if (status === 403) return CODE_TEXT.FORBIDDEN;
  if (status === 404) return CODE_TEXT.NOT_FOUND;
  if (status >= 500) return `${host} had a problem. Try again in a moment.`;
  const m = e?.message;
  // Short hub messages are fine to show; long ones are stack-ish noise.
  if (typeof m === 'string' && m.length > 0 && m.length <= 160) return m.charAt(0).toUpperCase() + m.slice(1);
  return `Something went wrong (${status}).`;
}

// Accept errors carry a second code (FORBIDDEN {code:'WRONG_ACCOUNT'},
// CONFLICT {code:'ALREADY_MEMBER'}); spread after the outer code it replaces
// it on the wire. `reason` and the extra fields are read too, so either
// encoding works.
function inviteOutcome(r) {
  if (r.ok) return r;
  const d = r.detail ?? {};
  const sub = d.reason ?? r.code;
  if (r.status === 403 && (sub === 'WRONG_ACCOUNT' || typeof d.email_masked === 'string')) {
    const masked = typeof d.email_masked === 'string' ? d.email_masked.slice(0, 120) : 'another email';
    return { ok: false, wrongAccount: true, error: `This invite is for ${masked}. Switch account?` };
  }
  if (r.status === 409 && (sub === 'ALREADY_MEMBER' || d.team?.id)) {
    const team = { id: String(d.team?.id ?? ''), name: String(d.team?.name ?? '').slice(0, 60) };
    return { ok: false, alreadyMember: true, team, error: `You’re already in ${team.name || 'this team'}.` };
  }
  if (r.code === 'INVALID_TOKEN') return { ok: false, gone: true, error: INVITE_GONE };
  return r;
}

function deleteOutcome(r) {
  if (r.code === 'STEP_UP_REQUIRED') return { ok: false, stepUp: true, error: 'That check timed out. Send a new code and do the check again.' };
  const owned = Array.isArray(r.detail?.sole_owner_of) ? r.detail.sole_owner_of.map((t) => String(t?.name ?? '').slice(0, 60)).filter(Boolean) : [];
  if (r.status === 409 && owned.length) {
    const names = owned.length === 1 ? owned[0] : `${owned.slice(0, -1).join(', ')} and ${owned.at(-1)}`;
    return { ok: false, soleOwner: true, error: `Transfer ownership of ${names} first.` };
  }
  return r;
}

/**
 * createAccountClient({origin, fetchImpl, store:{load(), save(obj), clear()}, now, onSignedOut})
 * Every method resolves `{ok:true, ...}` or `{ok:false, error:<sentence>, code?, signedOut?}`.
 * `store.load()` → `{hub, token, device_id, user}` or null.
 */
function createAccountClient({ origin, fetchImpl = fetch, store, now = () => Date.now(), onSignedOut = () => {} }) {
  const host = new URL(origin).host;
  let flow = null; // {id, email, purpose:'signin'|'delete', at, verifiedAt?}: the email-code flow in progress

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
      res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'manual' }); // privacy-flow: team-hub-account
    } catch {
      return { ok: false, error: `Couldn’t reach ${host}. Check the address and your connection.` };
    }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    // STEP_UP_REQUIRED is also a 401, but only means "do the check again".
    if (res.status === 401 && s && (json?.error?.code ?? 'UNAUTHENTICATED') === 'UNAUTHENTICATED') {
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
  const device = ({ deviceName, platform } = {}) => ({ device_name: String(deviceName ?? 'Mac').slice(0, 100), platform: String(platform ?? 'darwin').slice(0, 50) });
  const linkOk = (link) => typeof link === 'string' && link.startsWith(`${origin}/invite#`) && TOKEN_RE.test(link.slice(origin.length + 8));

  return {
    origin,
    signedIn: () => !!saved(),
    user: () => saved()?.user ?? null,
    /** For main's own requests and the runner's config; never for a page. */
    accessToken: async () => saved()?.token ?? null,

    async startEmail(email, dev = {}) {
      const e = String(email ?? '').trim().toLowerCase();
      const bad = need(EMAIL_RE.test(e), 'Enter your email address.');
      if (bad) return bad;
      // The mail names the device, so a phished person can see what they'd approve.
      const r = await call('emailStart', { body: { email: e, client: 'buddy_desktop', purpose: 'signin', ...device(dev) }, auth: false });
      if (!r.ok) return r;
      if (typeof r.flow_id !== 'string') return { ok: false, error: `${host} didn’t start a sign-in.` };
      flow = { id: r.flow_id, email: e, purpose: 'signin', at: now() };
      return { ok: true, email: e };
    },

    async verifyCode(code, dev = {}) {
      const c = String(code ?? '').replace(/\D/g, '');
      if (!flow || flow.purpose !== 'signin') return { ok: false, error: 'Start again: enter your email.' };
      const bad = need(c.length === 6, 'The code is 6 digits.');
      if (bad) return bad;
      const r = await call('emailVerify', { body: { flow_id: flow.id, code: c, ...device(dev) }, auth: false });
      // The flow stays on a bad code: "Send a new code" reuses its email.
      if (!r.ok) return r;
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

    pendingEmail: () => (flow?.purpose === 'signin' ? flow.email : null),

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
    removeMember: (team, member) => call('removeMember', { params: { team, member }, body: {} }),
    listInvites: (team) => call('invites', { params: { team } }),
    /** → {ok, invite, link|null}: `link` is shown once; the hub keeps only its hash. */
    async invite(team, email, role = 'member') {
      const e = String(email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(e)) return { ok: false, error: 'Enter their email address.' };
      if (!ROLES.includes(role) || role === 'owner') return { ok: false, error: 'Pick a role.' };
      const r = await call('invite', { params: { team }, body: { email: e, role, request_id: crypto.randomUUID() } });
      return r.ok ? { ...r, link: linkOk(r.link) ? r.link : null } : r;
    },
    revokeInvite: (team, invite) => call('revokeInvite', { params: { team, invite }, body: {} }),
    // No auth, and the token goes in the body, never the URL, so no log or proxy keeps it.
    async previewInvite(t) {
      if (!TOKEN_RE.test(String(t ?? ''))) return { ok: false, gone: true, error: INVITE_GONE };
      return inviteOutcome(await call('previewInvite', { body: { t }, auth: false }));
    },
    async acceptInvite(ref) {
      const body = ref?.inviteId ? { invite_id: String(ref.inviteId) } : { t: String(ref?.t ?? '') };
      if (body.t !== undefined && !TOKEN_RE.test(body.t)) return { ok: false, gone: true, error: INVITE_GONE };
      return inviteOutcome(await call('acceptInvite', { body }));
    },
    enrol: (team) => call('enrol', { params: { team }, body: {} }),
    unenrol: (team) => call('unenrol', { params: { team }, body: {} }),

    async signOut() {
      const r = saved() ? await call('signOut', { body: {} }) : { ok: true };
      // Forget the token whatever the hub said: signing out must always work offline.
      try { store.clear(); } catch { /* already gone */ }
      flow = null;
      return { ok: true, revoked: r.ok };
    },

    /** Account deletion, step 1: the hub emails a code to the signed-in address. */
    async startDelete() {
      const email = saved()?.user?.email ?? null;
      const r = await call('emailStart', { body: { purpose: 'delete', client: 'buddy_desktop' } });
      if (!r.ok) return r;
      if (typeof r.flow_id !== 'string') return { ok: false, error: `${host} didn’t send a code.` };
      flow = { id: r.flow_id, email, purpose: 'delete', at: now() };
      return { ok: true, email };
    },

    /** Step 2: verify the code, then delete. A verified flow is reused while fresh (e.g. after a CONFLICT). */
    async deleteAccount(code) {
      if (!flow || flow.purpose !== 'delete') return { ok: false, stepUp: true, error: 'Ask for a new code first.' };
      if (!(flow.verifiedAt && now() - flow.verifiedAt < STEP_UP_MS)) {
        const c = String(code ?? '').replace(/\D/g, '');
        if (c.length !== 6) return { ok: false, error: 'The code is 6 digits.' };
        const v = await call('emailVerify', { body: { flow_id: flow.id, code: c } });
        if (!v.ok) return v;
        flow.verifiedAt = now();
      }
      const r = await call('deleteAccount', { body: { flow_id: flow.id } });
      if (!r.ok) {
        if (r.code === 'STEP_UP_REQUIRED') flow = null;
        return deleteOutcome(r);
      }
      try { store.clear(); } catch { /* already gone */ }
      flow = null;
      return { ok: true };
    },
  };
}

// ── invite links ────────────────────────────────────────────────────────────

const decode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };

/**
 * Parse an invite from a deep link or whatever someone pasted:
 *   plexiform://join?hub=<origin>&t=<token>
 *   plexiform://invite/<token>  ·  plexiform://invite?t=<token>
 *   (and the same under the legacy claudebuddy:// scheme)
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
  if (SCHEMES.includes(u.protocol.slice(0, -1))) {
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
      if (segs.length === 1 && !u.search) { const t = tok(decode(segs[0])); return t ? { hub: null, token: t } : null; }
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
    const t = tok(decode(raw));
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
 *   {action:'need-hub'}       no hub in the link, and not exactly one known hub
 */
function routeInvite(inv, { knownHubs = [], signedIn = () => false }) {
  const known = new Set(knownHubs);
  // With several known hubs, guessing (say the last one used) would send the
  // token to a hub it wasn't minted for: ask instead.
  const hub = inv.hub ?? (knownHubs.length === 1 ? knownHubs[0] : null);
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

/**
 * The hub partition's onBeforeSendHeaders, for every URL (`<all_urls>`), so a
 * redirect off the hub is seen too: our token is stripped wherever it shows
 * up, a page's own Authorization is stripped outside the hub, and ours is set
 * only in scope. Nothing rests on Chromium dropping the header on a
 * cross-origin redirect.
 */
function bearerHeaders(requestHeaders, url, { scope, token }) {
  const ours = token ? `Bearer ${token}` : null;
  const inScope = scope.matches(url);
  const headers = { ...requestHeaders };
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== 'authorization') continue;
    // In scope with a token, ours replaces whatever was there.
    if (!inScope || ours) delete headers[k];
  }
  if (inScope && ours) headers.Authorization = ours;
  return headers;
}

module.exports = { createAccountClient, ROUTES, ROLES, parseInvite, routeInvite, maskEmail, bearerScope, bearerHeaders, humanError, codeText, TOKEN_RE, INVITE_GONE };
