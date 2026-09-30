// BOARD_AUTH=accounts: Google and GitHub sign-in for the desktop app (CONTRACT
// D76–D78, ACCOUNTS-API.md "OAuth sign-in"). The app listens on a loopback
// port, the hub mints `state` (and Google's `nonce`) and hands back the
// provider URL; the app opens it, receives `?code&state` on its listener and
// posts both here with its PKCE verifier. The flow is burned before the
// provider is called, provider tokens are dropped as soon as the identity is
// read (never stored, logged or audited), and the result is the same device
// token an email code gives, or (purpose 'delete') a 5-minute step-up.

import { createHash, createPublicKey, hkdfSync, randomBytes, randomUUID, verify as cryptoVerify } from 'node:crypto';
import { HubError } from '../db.js';
import { safeEqual, sha256hex } from '../auth.js';
import { oauthProviders } from '../config.js';
import { FailureBudget, ipKey, limitOrThrow } from '../ratelimit.js';
import { canonEmail, ipPrefix, publicUser, STEP_UP_MS } from './accounts.js';
import { BRAND } from '../../shared/brand.js';

export const OAUTH_FLOW_TTL_MS = 10 * 60_000;
export const OPEN_FLOWS_PER_NETWORK = 5;
const PROVIDER_TIMEOUT_MS = 10_000;
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

const optStr = (v, max, name) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw new HubError('VALIDATION', `${name} must be a string ≤ ${max}`);
  return v;
};
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
    // Mismatched exchanges per client network (a replayed code, a wrong state or verifier).
    this.failures = new FailureBudget({ now: () => hub.mono(), budget: hub.config.authFailBudget ?? 20 });
    this.jwks = { keys: new Map(), fetchedAt: -Infinity, triedAt: -Infinity };
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
    if (purpose !== 'signin') {
      // A step-up comes from the signed-in desktop app, and only it may spend it.
      if (ident?.cred.kind !== 'device') throw new HubError('UNAUTHENTICATED', 'sign in first');
      userId = ident.user.id;
      credId = ident.cred.id;
    }
    limitOrThrow(this.hub, 'oauth_start_ip', ipKey(ip));
    const now = this.accounts.now();
    const prefix = ipPrefix(ip);
    const open = this.db.all('SELECT expires_at FROM oauth_flows WHERE ip_prefix IS ? AND used = 0 AND expires_at > ? ORDER BY expires_at', prefix, now);
    if (open.length >= OPEN_FLOWS_PER_NETWORK) {
      const s = Math.max(1, Math.ceil((Date.parse(open[0].expires_at) - this.hub.wallMs()) / 1000));
      throw new HubError('RATE_LIMITED', `too many sign-ins in progress from this network; retry in ${s} s`, { retry_after_s: s });
    }
    const flowId = b64url(randomBytes(18));
    const state = b64url(randomBytes(32));
    const nonce = provider === 'google' ? b64url(randomBytes(32)) : null;
    this.hub.txn(() => {
      this.db.insert('oauth_flows', {
        id: flowId, provider, purpose, client: 'buddy_desktop', state_hash: sha256hex(state), nonce, code_challenge: body.code_challenge,
        redirect_uri: redirect, device_name: deviceName, platform, user_id: userId, cred_id: credId,
        created_at: now, expires_at: this.accounts.at(OAUTH_FLOW_TTL_MS), ip_prefix: prefix,
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
   * step-up {ok, flow_id, stepup_until, step_up_expires_in}.
   */
  async exchange(body, { ip, ident = null }) {
    limitOrThrow(this.hub, 'oauth_exchange_ip', ipKey(ip));
    const budget = `oauth|${ipKey(ip)}`;
    const locked = this.failures.lockedFor(budget);
    if (locked) {
      const s = Math.max(1, Math.ceil(locked / 1000));
      throw new HubError('RATE_LIMITED', `too many failed sign-ins from this network; retry in ${s} s`, { retry_after_s: s });
    }
    const fail = (e, f = null, reason = e.code) => {
      this.failures.fail(budget);
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
      if (e instanceof HubError && e.code !== 'PROVIDER_UNAVAILABLE' && e.code !== 'EMAIL_UNVERIFIED') throw fail(e, f);
      if (e instanceof HubError) {
        this.accounts.audit('auth.oauth.failed', { user: f.user_id, target: f.id, detail: { provider: f.provider, reason: e.code }, ip });
        throw e;
      }
      this.hub.log.warn('oauth exchange failed', { provider: f.provider });
      throw unavailable();
    }
    if (f.purpose !== 'signin') return this.stepUp(f, who, { ip, fail });
    return this.signIn(f, who, body, { ip });
  }

  // ── providers (the provider's tokens live only inside these calls) ────────

  async call(url, init) {
    let res;
    try {
      res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) }); // privacy-flow: hub-server
    } catch {
      throw unavailable();
    }
    if (res.status >= 500 || res.status === 429) throw unavailable();
    let json = null;
    try { json = await res.json(); } catch { json = null; }
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
    return { provider: 'google', subject: c.sub, email: canonEmail(c.email), name: typeof c.name === 'string' ? c.name : null, login: null };
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
      return { provider: 'github', subject: String(u.json.id), email: canonEmail(primary.email), name: typeof u.json.name === 'string' && u.json.name ? u.json.name : login, login };
    } finally {
      token = null;
      headers.authorization = null;
    }
  }

  // ── Google id_token (RS256 against Google's JWKS, cached) ─────────────────

  async refreshJwks() {
    this.jwks.triedAt = this.hub.mono();
    const r = await this.call(GOOGLE.jwks, { headers: { accept: 'application/json' } });
    if (!r.ok || !Array.isArray(r.json?.keys)) throw unavailable();
    const next = new Map();
    for (const jwk of r.json.keys) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
      try { next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* skip a bad key */ }
    }
    this.jwks = { keys: next, fetchedAt: this.hub.mono(), triedAt: this.jwks.triedAt };
  }

  async keyFor(kid) {
    const now = this.hub.mono();
    const stale = now - this.jwks.fetchedAt >= JWKS_TTL_MS;
    const unknown = !this.jwks.keys.has(kid);
    if (stale || (unknown && now - this.jwks.triedAt >= KID_REFETCH_MIN_MS)) {
      try { await this.refreshJwks(); } catch (e) {
        // A stale cache that still knows the kid is better than no answer.
        if (!this.jwks.keys.has(kid) || !Number.isFinite(this.jwks.fetchedAt)) throw e;
      }
    }
    return this.jwks.keys.get(kid) ?? null;
  }

  async verifyIdToken(token, f) {
    const parts = token.split('.');
    if (parts.length !== 3) throw invalid();
    let header;
    let claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { throw invalid(); }
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !claims || typeof claims !== 'object') throw invalid();
    const key = await this.keyFor(header.kid);
    if (!key) throw invalid();
    if (!cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw invalid();
    const t = this.hub.wallMs() / 1000;
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!GOOGLE.issuers.includes(claims.iss) || !auds.includes(this.clientId('google'))) throw invalid();
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S <= t) throw invalid();
    if (typeof claims.iat !== 'number' || claims.iat - SKEW_S > t) throw invalid();
    if (typeof claims.nonce !== 'string' || !f.nonce || !safeEqual(claims.nonce, f.nonce)) throw invalid();
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw invalid();
    return claims;
  }

  // ── accounts ──────────────────────────────────────────────────────────────

  // A proven identity: one a provider sign-in wrote (migration 009's
  // admin-typed GitHub ids have no verified_at and never count).
  identity(provider, subject) {
    return this.db.get('SELECT * FROM identities WHERE provider = ? AND subject = ?', provider, subject);
  }

  /** The live user who already proved this address: an email code, a verified primary address, or another provider. */
  userByEmail(email) {
    return this.db.get(`SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id
        WHERE u.deleted_at IS NULL AND i.email_verified = 1 AND i.verified_at IS NOT NULL
          AND ((i.provider = 'email' AND i.subject = ?) OR (i.provider IN ('google','github') AND i.email = ?))
        ORDER BY i.created_at LIMIT 1`, email, email)
      ?? this.db.get('SELECT * FROM users WHERE primary_email = ? AND deleted_at IS NULL', email);
  }

  // Resolve (provider, subject) → user, else link by the provider-verified
  // address, else create. Inside the caller's transaction.
  resolveUser(who, { ip }) {
    const now = this.accounts.now();
    const ident = this.identity(who.provider, who.subject);
    let user = ident?.verified_at ? this.accounts.liveUser(ident.user_id) : null;
    let linked = false;
    if (!user) {
      user = this.userByEmail(who.email);
      linked = !!user;
    }
    if (!user) {
      user = {
        id: randomUUID(), display_name: (who.name || who.email.split('@')[0]).replace(/[\p{C}]/gu, ' ').trim().slice(0, 100) || who.email.split('@')[0].slice(0, 100),
        primary_email: who.email, primary_email_verified_at: now, avatar_url: null, created_at: now, deleted_at: null,
      };
      this.db.insert('users', user);
      this.accounts.audit('user.create', { user: user.id, detail: { method: who.provider }, ip });
    } else if (!user.primary_email_verified_at && user.primary_email === who.email) {
      this.db.run('UPDATE users SET primary_email_verified_at = ? WHERE id = ?', now, user.id);
      user = this.accounts.liveUser(user.id);
    }
    if (ident) {
      this.db.run('UPDATE identities SET user_id = ?, email = ?, email_verified = 1, login = ?, verified_at = COALESCE(verified_at, ?), last_used_at = ? WHERE id = ?',
        user.id, who.email, who.login, now, now, ident.id);
    } else {
      this.db.insert('identities', { id: randomUUID(), user_id: user.id, provider: who.provider, subject: who.subject, email: who.email, email_verified: 1, login: who.login, created_at: now, last_used_at: now, verified_at: now });
    }
    if (linked || (ident && !ident.verified_at)) {
      this.accounts.audit('identity.link', { user: user.id, detail: { provider: who.provider, subject_ref: this.subjectRef(who.provider, who.subject) }, ip });
    }
    this.accounts.linkMembers(user.id, who.email);
    return user;
  }

  signIn(f, who, body, { ip }) {
    const device = {
      name: f.device_name ?? `${BRAND.name} desktop`,
      platform: f.platform,
      form_factor: body.form_factor ?? null,
    };
    if (device.form_factor != null && !FORM_FACTORS.has(device.form_factor)) throw new HubError('VALIDATION', "form_factor must be 'laptop' or 'desktop'");
    const known = this.identity(who.provider, who.subject)?.verified_at || this.userByEmail(who.email);
    if (!known) limitOrThrow(this.hub, 'signup_ip', ipKey(ip));
    let out;
    this.hub.txn(() => {
      const user = this.resolveUser(who, { ip });
      const d = this.accounts.issueDevice(user.id, device, { ip, method: who.provider, subjectRef: this.subjectRef(who.provider, who.subject) });
      this.failures.reset(`oauth|${ipKey(ip)}`);
      out = { user: publicUser(this.accounts.liveUser(user.id)), teams: this.accounts.teams(user.id), device_token: d.token, device_id: d.id };
    });
    return out;
  }

  // Re-authentication for a deletion: the same provider identity the account
  // already holds, from the same device token that started the flow.
  stepUp(f, who, { ip, fail }) {
    const ident = this.identity(who.provider, who.subject);
    if (!ident?.verified_at || ident.user_id !== f.user_id || !this.accounts.liveUser(f.user_id)) {
      throw fail(new HubError('WRONG_ACCOUNT', `sign in with the ${f.provider === 'google' ? 'Google' : 'GitHub'} account this ${BRAND.name} account uses`), f);
    }
    const until = this.accounts.at(STEP_UP_MS);
    this.hub.txn(() => {
      this.db.run('UPDATE oauth_flows SET stepup_until = ? WHERE id = ?', until, f.id);
      this.db.run('UPDATE identities SET last_used_at = ? WHERE id = ?', this.accounts.now(), ident.id);
      this.accounts.audit('auth.stepup', { user: f.user_id, target: f.id, detail: { purpose: f.purpose, method: f.provider }, ip });
    });
    this.failures.reset(`oauth|${ipKey(ip)}`);
    return { ok: true, flow_id: f.id, stepup_until: until, step_up_expires_in: STEP_UP_MS / 1000 };
  }
}
