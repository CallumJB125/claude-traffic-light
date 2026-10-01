// BOARD_AUTH=accounts: Google and GitHub sign-in for the desktop app (CONTRACT
// D76–D78, ACCOUNTS-API.md "OAuth sign-in"). The app listens on a loopback
// port, the hub mints `state` (and Google's `nonce`) and hands back the
// provider URL; the app opens it, receives `?code&state` on its listener and
// posts both here with its PKCE verifier. The flow is burned before the
// provider is called, provider tokens are dropped as soon as the identity is
// read (never stored, logged or audited), and the result is the same device
// token an email code gives, or (purpose 'delete') a 5-minute step-up.

import { createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { HubError } from '../db.js';
import { safeEqual, sha256hex } from '../auth.js';
import { oauthProviders } from '../config.js';
import { ipKey, limitOrThrow } from '../ratelimit.js';
import { authoritativeVia, canonEmail, ipPrefix, publicUser, STEP_UP_MS } from './accounts.js';
import { BRAND } from '../../shared/brand.js';
import { createJwks, JwtInvalid, readCapped, verifyRs256 } from '../jwt.js';

export const OAUTH_FLOW_TTL_MS = 10 * 60_000;
export const OPEN_FLOWS_PER_CLIENT = 10;
const PROVIDER_TIMEOUT_MS = 10_000;
const PROVIDER_BODY_MAX = 64 * 1024;
const SWEEP_EVERY_MS = 60_000;
const KEEP_FLOWS_MS = 86_400_000;
const GMAIL = new Set(['gmail.com', 'googlemail.com']);
const SKEW_S = 60;
const JWKS_TTL_MS = 3_600_000;
const KID_REFETCH_MIN_MS = 10_000;
const PURPOSES = new Set(['signin', 'delete', 'delete_team']);
const FORM_FACTORS = new Set(['laptop', 'desktop']);
const REDIRECT_RE = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/callback$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;

export const GOOGLE = Object.freeze({
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: Object.freeze(['https://accounts.google.com', 'accounts.google.com']),
});
export const GITHUB = Object.freeze({
  authorize: 'https://github.com/login/oauth/authorize',
  token: 'https://github.com/login/oauth/access_token',
  user: 'https://api.github.com/user',
  emails: 'https://api.github.com/user/emails',
});

const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const s256 = (verifier) => b64url(createHash('sha256').update(verifier).digest());

// A name the app chose for the device: control and format characters stripped (L5).
const optStr = (v, max, name) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw new HubError('VALIDATION', `${name} must be a string ≤ ${max}`);
  return v.replace(/[\p{C}]/gu, '').trim() || null;
};

/**
 * Is this Google account authoritative for its address (D83)? Google itself
 * runs the mailbox: a Workspace account whose `hd` is the address's domain,
 * or a gmail.com / googlemail.com address. Anything else is an address Google
 * once verified, which may since have been recycled.
 */
export function googleAuthoritative(email, hd) {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return GMAIL.has(domain) || (typeof hd === 'string' && hd.toLowerCase() === domain);
}

/** A provider's address: NFKC, ASCII only (L4), canonical; else null. */
function providerEmail(v) {
  if (typeof v !== 'string') return null;
  const e = canonEmail(v);
  return /^[\x21-\x7e]+@[\x21-\x7e]+$/.test(e) && e.length <= 254 ? e : null;
}
const invalid = () => new HubError('INVALID_TOKEN', 'that sign-in is invalid or has expired: start again');
const unavailable = () => new HubError('PROVIDER_UNAVAILABLE', 'the sign-in provider could not be reached: try again shortly');
const refused = () => new HubError('PROVIDER_ERROR', 'the sign-in provider did not accept this sign-in: start again');

/** `redirect_uri` for the desktop loopback listener, or null. */
export function loopbackRedirect(v) {
  const m = typeof v === 'string' ? REDIRECT_RE.exec(v) : null;
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1024 && port <= 65535 ? v : null;
}

export class OAuth {
  constructor(hub, { accounts, fetchImpl = globalThis.fetch }) { // privacy-flow: hub-server
    this.hub = hub;
    this.db = hub.db;
    this.accounts = accounts;
    this.fetch = fetchImpl;
    this.kSub = Buffer.from(hkdfSync('sha256', String(hub.secret), Buffer.alloc(0), 'board-accounts:oauth-subject', 32));
    // No failure lockout (M1): flows are single use, behind 256-bit state +
    // PKCE; oauth_exchange_ip (30/h per /64) bounds the attempts.
    this.sweptAt = -Infinity;
    this.jwks = createJwks({
      load: async () => {
        const r = await this.call(GOOGLE.jwks, { headers: { accept: 'application/json' } });
        if (!r.ok || !Array.isArray(r.json?.keys)) throw unavailable();
        return r.json;
      },
      now: () => this.hub.mono(), ttlMs: JWKS_TTL_MS, kidRefetchMs: KID_REFETCH_MIN_MS,
    });
  }

  configured(provider) { return oauthProviders(this.hub.config).includes(provider); }
  clientId(p) { return this.hub.config[`${p}ClientId`]; }
  clientSecret(p) { return this.hub.config[`${p}ClientSecret`]; }
  subjectRef(provider, subject) { return createHash('sha256').update(this.kSub).update(`${provider}:${subject}`).digest('hex').slice(0, 16); }

  /** POST /api/auth/oauth/start → {flow_id, url, state, expires_in}. */
  start(body, { ip, ident = null }) {
    const provider = body.provider;
    if (provider !== 'google' && provider !== 'github') throw new HubError('VALIDATION', "provider must be 'google' or 'github'");
    if (!this.configured(provider)) throw new HubError('METHOD_DISABLED', `${provider} sign-in is not enabled on this hub`);
    const purpose = body.purpose ?? 'signin';
    if (!PURPOSES.has(purpose)) throw new HubError('VALIDATION', "purpose must be 'signin', 'delete' or 'delete_team'");
    if ((body.client ?? 'buddy_desktop') !== 'buddy_desktop') throw new HubError('VALIDATION', "client must be 'buddy_desktop'");
    if (typeof body.code_challenge !== 'string' || !CHALLENGE_RE.test(body.code_challenge)) throw new HubError('VALIDATION', 'code_challenge must be a base64url SHA-256 (43 characters)');
    const redirect = loopbackRedirect(body.redirect_uri);
    if (!redirect) throw new HubError('VALIDATION', 'redirect_uri must be http://127.0.0.1:<port 1024–65535>/callback');
    const deviceName = optStr(body.device_name, 100, 'device_name');
    const platform = optStr(body.platform, 50, 'platform');
    let userId = null;
    let credId = null;
    let teamId = null;
    if (purpose !== 'signin') {
      // A step-up comes from the signed-in desktop app, and only it may spend it.
      if (ident?.cred.kind !== 'device') throw new HubError('UNAUTHENTICATED', 'sign in first');
      userId = ident.user.id;
      credId = ident.cred.id;
      // A team-deletion step-up names the one team it may delete (L6).
      if (body.team_id != null && (typeof body.team_id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(body.team_id))) throw new HubError('VALIDATION', 'team_id must be a team id');
      teamId = body.team_id ?? null;
      if (purpose === 'delete_team' && !teamId) throw new HubError('VALIDATION', "purpose 'delete_team' needs team_id");
    }
    limitOrThrow(this.hub, 'oauth_start_ip', ipKey(ip));
    const now = this.accounts.now();
    const prefix = ipPrefix(ip);
    const key = ipKey(ip);
    const open = this.db.all('SELECT expires_at FROM oauth_flows WHERE ip_key IS ? AND used = 0 AND expires_at > ? ORDER BY expires_at', key, now);
    if (open.length >= OPEN_FLOWS_PER_CLIENT) {
      const s = Math.max(1, Math.ceil((Date.parse(open[0].expires_at) - this.hub.wallMs()) / 1000));
      throw new HubError('RATE_LIMITED', `too many sign-ins in progress from this address; retry in ${s} s`, { retry_after_s: s });
    }
    const flowId = b64url(randomBytes(18));
    const state = b64url(randomBytes(32));
    const nonce = provider === 'google' ? b64url(randomBytes(32)) : null;
    this.hub.txn(() => {
      this.db.insert('oauth_flows', {
        id: flowId, provider, purpose, client: 'buddy_desktop', state_hash: sha256hex(state), nonce, code_challenge: body.code_challenge,
        redirect_uri: redirect, device_name: deviceName, platform, user_id: userId, cred_id: credId, team_id: teamId,
        created_at: now, expires_at: this.accounts.at(OAUTH_FLOW_TTL_MS), ip_prefix: prefix, ip_key: key,
      });
      this.accounts.audit('auth.oauth.start', { user: userId, target: flowId, detail: { provider, purpose }, ip });
    });
    return { flow_id: flowId, url: this.authorizeUrl(provider, { state, nonce, challenge: body.code_challenge, redirect }), state, expires_in: OAUTH_FLOW_TTL_MS / 1000 };
  }

  authorizeUrl(provider, { state, nonce, challenge, redirect }) {
    // Never access_type=offline: no refresh token is ever asked for.
    const q = provider === 'google'
      ? { client_id: this.clientId(provider), redirect_uri: redirect, response_type: 'code', scope: 'openid email profile', state, nonce, prompt: 'select_account', code_challenge: challenge, code_challenge_method: 'S256' }
      : { client_id: this.clientId(provider), redirect_uri: redirect, scope: 'read:user user:email', state, allow_signup: 'true', code_challenge: challenge, code_challenge_method: 'S256' };
    return `${provider === 'google' ? GOOGLE.authorize : GITHUB.authorize}?${new URLSearchParams(q)}`;
  }

  /**
   * POST /api/auth/oauth/exchange {flow_id, code, state, code_verifier} →
   * the email-verify body ({user, teams, device_token, device_id}), or for a
   * step-up exactly {stepup_until}.
   */
  async exchange(body, { ip, ident = null }) {
    limitOrThrow(this.hub, 'oauth_exchange_ip', ipKey(ip));
    const fail = (e, f = null, reason = e.code) => {
      this.accounts.audit('auth.oauth.failed', { user: f?.user_id ?? null, target: f?.id ?? null, detail: { provider: f?.provider ?? null, reason }, ip });
      return e;
    };
    const flowId = typeof body.flow_id === 'string' ? body.flow_id : '';
    const f = flowId ? this.db.get('SELECT * FROM oauth_flows WHERE id = ?', flowId) : null;
    if (!f) throw fail(invalid());
    if (!this.configured(f.provider)) throw new HubError('METHOD_DISABLED', `${f.provider} sign-in is not enabled on this hub`);
    // Every check, then the burn: no await in between, so two exchanges of
    // one flow can't both pass (the burn needs changes=1).
    const code = typeof body.code === 'string' && body.code.length <= 2048 ? body.code : '';
    const state = typeof body.state === 'string' && STATE_RE.test(body.state) ? body.state : '';
    const verifier = typeof body.code_verifier === 'string' && VERIFIER_RE.test(body.code_verifier) ? body.code_verifier : '';
    const reason = f.used ? 'used'
      : f.expires_at <= this.accounts.now() ? 'expired'
        : f.ip_prefix !== ipPrefix(ip) ? 'network'
          : body.provider != null && body.provider !== f.provider ? 'provider'
            : body.redirect_uri != null && body.redirect_uri !== f.redirect_uri ? 'redirect_uri'
              : !state || !safeEqual(sha256hex(state), f.state_hash) ? 'state'
                : !verifier || !safeEqual(s256(verifier), f.code_challenge) ? 'verifier'
                  : !code ? 'code'
                    : f.purpose !== 'signin' && (ident?.cred.kind !== 'device' || ident.user.id !== f.user_id || ident.cred.id !== f.cred_id) ? 'step_up_credential'
                      : null;
    // A flow that fails any check is spent too: one attempt per flow.
    const burned = this.db.run('UPDATE oauth_flows SET used = 1, used_at = ? WHERE id = ? AND used = 0', this.accounts.now(), f.id).changes === 1;
    if (reason || !burned) throw fail(invalid(), f, reason ?? 'used');

    let who;
    try {
      who = f.provider === 'google' ? await this.google(f, code, verifier) : await this.github(f, code, verifier);
    } catch (e) {
        if (e instanceof HubError) throw fail(e, f);
      this.hub.log.warn('oauth exchange failed', { provider: f.provider });
      throw unavailable();
    }
    if (f.purpose !== 'signin') return this.stepUp(f, who, { ip, fail });
    return this.signIn(f, who, body, { ip });
  }

  // ── providers (the provider's tokens live only inside these calls) ────────

  // No redirects followed, at most 64 KB read (L3).
  async call(url, init) {
    let res;
    try {
      res = await this.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) }); // privacy-flow: hub-server
    } catch {
      throw unavailable();
    }
    if (res.status >= 500 || res.status === 429) throw unavailable();
    let json = null;
    try { json = JSON.parse(await readCapped(res, PROVIDER_BODY_MAX)); } catch { json = null; }
    return { status: res.status, ok: res.ok, json };
  }

  tokenRequest(provider, f, code, verifier) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code, client_id: this.clientId(provider), client_secret: this.clientSecret(provider),
      redirect_uri: f.redirect_uri, code_verifier: verifier,
    });
    return this.call(provider === 'google' ? GOOGLE.token : GITHUB.token, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString(),
    });
  }

  async google(f, code, verifier) {
    const r = await this.tokenRequest('google', f, code, verifier);
    const idToken = r.ok && typeof r.json?.id_token === 'string' ? r.json.id_token : null;
    if (!idToken) throw refused();
    const c = await this.verifyIdToken(idToken, f);
    if (c.email_verified !== true || typeof c.email !== 'string' || !c.email) throw new HubError('EMAIL_UNVERIFIED', 'that Google account has no verified email address');
    const email = providerEmail(c.email);
    if (!email) throw invalid();
    return { provider: 'google', subject: c.sub, email, name: typeof c.name === 'string' ? c.name : null, login: null, authoritative: googleAuthoritative(email, c.hd) };
  }

  async github(f, code, verifier) {
    const r = await this.tokenRequest('github', f, code, verifier);
    // GitHub answers a bad code with 200 {error: 'bad_verification_code'}.
    let token = r.ok && typeof r.json?.access_token === 'string' ? r.json.access_token : null;
    if (!token) throw refused();
    const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': `${BRAND.name}-hub`, 'x-github-api-version': '2022-11-28' };
    try {
      const [u, e] = await Promise.all([this.call(GITHUB.user, { headers }), this.call(GITHUB.emails, { headers })]);
      if (!u.ok || !e.ok || !Number.isSafeInteger(u.json?.id) || u.json.id <= 0 || !Array.isArray(e.json)) throw refused();
      const primary = e.json.find((x) => x && x.primary === true && x.verified === true && typeof x.email === 'string');
      if (!primary) throw new HubError('EMAIL_UNVERIFIED', 'that GitHub account has no verified primary email address');
      const login = typeof u.json.login === 'string' ? u.json.login.slice(0, 100) : null;
      const email = providerEmail(primary.email);
      if (!email) throw invalid();
      // GitHub never proves an address well enough to join an existing account (D83).
      return { provider: 'github', subject: String(u.json.id), email, name: typeof u.json.name === 'string' && u.json.name ? u.json.name : login, login, authoritative: false };
    } finally {
      token = null;
      headers.authorization = null;
    }
  }

  // ── Google id_token (RS256 against Google's JWKS, cached) ─────────────────

  async verifyIdToken(token, f) {
    try {
      return await verifyRs256(token, { keyFor: this.jwks.keyFor, issuers: GOOGLE.issuers, audience: this.clientId('google'), nonce: f.nonce, nowS: this.hub.wallMs() / 1000, skewS: SKEW_S });
    } catch (e) {
      if (e instanceof JwtInvalid) throw invalid();
      throw e;
    }
  }

  // ── accounts ──────────────────────────────────────────────────────────────

  // A proven identity: one a provider sign-in wrote (migration 009's
  // admin-typed GitHub ids have no verified_at and never count).
  identity(provider, subject) {
    return this.db.get('SELECT * FROM identities WHERE provider = ? AND subject = ?', provider, subject);
  }

  /**
   * The live user who proved this address authoritatively (D83): an email
   * code, an authoritative Google account, or a verified primary address an
   * authoritative path set. A GitHub or non-authoritative Google address never
   * counts.
   */
  userByEmail(email) {
    return this.db.get(`SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id
        WHERE u.deleted_at IS NULL AND i.email_verified = 1 AND i.verified_at IS NOT NULL
          AND ((i.provider = 'email' AND i.subject = ?) OR (i.provider = 'google' AND i.email = ?))
        ORDER BY i.created_at LIMIT 1`, email, email)
      ?? this.db.get(`SELECT * FROM users WHERE primary_email = ? AND deleted_at IS NULL AND primary_email_verified_at IS NOT NULL
        AND (primary_email_via IS NULL OR primary_email_via IN ('email','google'))`, email);
  }

  // Resolve (provider, subject) → user; else, only for a provider
  // authoritative for the address, link to the account that proved it; else
  // create a separate account. Inside the caller's transaction.
  resolveUser(who, { ip }) {
    const now = this.accounts.now();
    const ident = this.identity(who.provider, who.subject);
    let user = ident?.verified_at ? this.accounts.liveUser(ident.user_id) : null;
    let linked = false;
    if (!user && who.authoritative) {
      user = this.userByEmail(who.email);
      linked = !!user;
    }
    if (!user) {
      // D104: GitHub's verified primary address (never through a domain: entry), or one Google is authoritative for; never a weaker one.
      const signupVia = this.accounts.requireSignup(who.email, { eligible: who.provider === 'github' || who.authoritative, domains: who.provider !== 'github' });
      // The address is the new account's primary unless someone holds it: an
      // authoritative newcomer takes it from a weaker holder; a weaker newcomer gets none.
      const holder = this.db.get('SELECT * FROM users WHERE primary_email = ? AND deleted_at IS NULL', who.email);
      if (holder && who.authoritative && !(holder.primary_email_verified_at && authoritativeVia(holder))) this.accounts.releasePrimary(holder, { ip });
      const primary = !holder || who.authoritative ? who.email : null;
      const via = who.authoritative ? 'google' : who.provider === 'github' ? 'github' : 'google_weak';
      user = {
        id: randomUUID(), display_name: (who.name || who.email.split('@')[0]).replace(/[\p{C}]/gu, ' ').trim().slice(0, 100) || who.email.split('@')[0].slice(0, 100),
        primary_email: primary, primary_email_verified_at: primary ? now : null, primary_email_via: primary ? via : null, avatar_url: null, created_at: now, deleted_at: null, signup_via: signupVia,
      };
      this.db.insert('users', user);
      this.accounts.audit('user.create', { user: user.id, detail: { method: who.provider }, ip });
    }
    // email_verified: an address good enough for an invite (GitHub primary+verified,
    // authoritative Google); a non-authoritative Google address is kept but never counts.
    const emailVerified = who.provider === 'github' || who.authoritative ? 1 : 0;
    if (ident) {
      this.db.run('UPDATE identities SET user_id = ?, email = ?, email_verified = ?, login = ?, verified_at = COALESCE(verified_at, ?), last_used_at = ? WHERE id = ?',
        user.id, who.email, emailVerified, who.login, now, now, ident.id);
    } else {
      this.db.insert('identities', { id: randomUUID(), user_id: user.id, provider: who.provider, subject: who.subject, email: who.email, email_verified: emailVerified, login: who.login, created_at: now, last_used_at: now, verified_at: now });
    }
    if (linked || (ident && !ident.verified_at)) {
      this.accounts.audit('identity.link', { user: user.id, detail: { provider: who.provider, subject_ref: this.subjectRef(who.provider, who.subject) }, ip });
    }
    // Access-era member rows join only an account that proved the address authoritatively.
    if (who.authoritative) this.accounts.linkMembers(user.id, who.email);
    return user;
  }

  signIn(f, who, body, { ip }) {
    const device = {
      name: f.device_name ?? `${BRAND.name} desktop`,
      platform: f.platform,
      form_factor: body.form_factor ?? null,
    };
    if (device.form_factor != null && !FORM_FACTORS.has(device.form_factor)) throw new HubError('VALIDATION', "form_factor must be 'laptop' or 'desktop'");
    const known = this.identity(who.provider, who.subject)?.verified_at || (who.authoritative && this.userByEmail(who.email));
    if (!known) limitOrThrow(this.hub, 'signup_ip', ipKey(ip));
    let out;
    try {
      this.hub.txn(() => {
        const user = this.resolveUser(who, { ip });
        const d = this.accounts.issueDevice(user.id, device, { ip, method: who.provider, subjectRef: this.subjectRef(who.provider, who.subject) });
        // The flow now belongs to the account: erasure finds it (M4).
        this.db.run('UPDATE oauth_flows SET user_id = ?, cred_id = ? WHERE id = ?', user.id, d.id, f.id);
        out = { user: publicUser(this.accounts.liveUser(user.id)), teams: this.accounts.teams(user.id), device_token: d.token, device_id: d.id };
      });
    } catch (e) {
      if (e.code === 'SIGNUP_CLOSED') this.accounts.audit('auth.signup.refused', { target: f.id, detail: { method: who.provider, subject_ref: this.subjectRef(who.provider, who.subject) }, ip });
      throw e;
    }
    return out;
  }

  // Re-authentication for a deletion: the same provider identity the account
  // already holds, from the same device token that started the flow. Another
  // identity is the generic INVALID_TOKEN (never a 401, which would sign the
  // app out, and nothing about which identity the account has).
  stepUp(f, who, { ip, fail }) {
    const ident = this.identity(who.provider, who.subject);
    if (!ident?.verified_at || ident.user_id !== f.user_id || !this.accounts.liveUser(f.user_id)) throw fail(invalid(), f, 'step_up_identity');
    const until = this.accounts.at(STEP_UP_MS);
    this.hub.txn(() => {
      this.db.run('UPDATE oauth_flows SET stepup_until = ? WHERE id = ?', until, f.id);
      this.db.run('UPDATE identities SET last_used_at = ? WHERE id = ?', this.accounts.now(), ident.id);
      this.accounts.audit('auth.stepup', { user: f.user_id, target: f.id, detail: { purpose: f.purpose, method: f.provider }, ip });
    });
    // Exactly this: the app already holds flow_id (DELETE … {flow_id}).
    return { stepup_until: until };
  }

  /** The reaper (M4): flows a day past expiry go, unless a step-up window is still open; email code flows (duds too) a day past expiry. At most once a minute. */
  sweep() {
    const now = this.hub.mono();
    if (now - this.sweptAt < SWEEP_EVERY_MS) return;
    this.sweptAt = now;
    this.db.run('DELETE FROM oauth_flows WHERE expires_at < ? AND (stepup_until IS NULL OR stepup_until < ?)', this.accounts.at(-KEEP_FLOWS_MS), this.accounts.now());
    // A day past a 10-minute expiry is past the 24 h of wrong codes seedFailures re-reads.
    this.db.run('DELETE FROM login_flows WHERE expires_at < ?', this.accounts.at(-KEEP_FLOWS_MS));
  }
}
