// Browser sign-in uses a distinct registered web client and a fixed callback.
// State alone never authorizes a callback: the authenticated encrypted cookie
// binds the initiating browser and keeps PKCE/invite secrets out of SQLite.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { HubError } from '../db.js';
import { parseCookies, safeEqual, sha256hex } from '../auth.js';
import { ipKey, limitOrThrow } from '../ratelimit.js';
import { ipPrefix, appendCookie, sessionCookie, SESSION_ABS_MS } from './accounts.js';
import { OAUTH_FLOW_TTL_MS, OPEN_FLOWS_PER_CLIENT, SEPARATE_ACCOUNT_MESSAGE } from './oauth.js';

export const WEB_OAUTH_COOKIE = '__Host-plexiform_oauth';
const AAD = Buffer.from(`${WEB_OAUTH_COOKIE}:v1`);
const RANDOM_RE = /^[A-Za-z0-9_-]{43}$/;
const FLOW_RE = /^[A-Za-z0-9_-]{24}$/;
const ERRORS = new Set(['INVALID_TOKEN', 'METHOD_DISABLED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_ERROR', 'EMAIL_UNVERIFIED', 'SIGNUP_CLOSED', 'SIGNUP_PAUSED', 'RATE_LIMITED']);
const invalid = () => new HubError('INVALID_TOKEN', 'that sign-in is invalid or has expired: start again');
const random = (n = 32) => randomBytes(n).toString('base64url');
const s256 = (v) => createHash('sha256').update(v).digest('base64url');
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => keys.includes(k));

function invitation(v) {
  if (v == null) return null;
  if (!closed(v, ['kind', 'token']) || !['team', 'client'].includes(v.kind) || typeof v.token !== 'string'
    || !(v.kind === 'team' ? /^inv_[A-Za-z0-9_-]{43}$/ : /^clinv_[A-Za-z0-9_-]{43}$/).test(v.token)) {
    throw new HubError('VALIDATION', 'invalid invitation');
  }
  return { kind: v.kind, token: v.token };
}

export class WebOAuth {
  constructor(hub) {
    this.hub = hub; this.db = hub.db; this.accounts = hub.accounts; this.oauth = hub.oauth;
    this.key = Buffer.from(hkdfSync('sha256', String(hub.secret), Buffer.alloc(0), 'board-accounts:browser-oauth-cookie:v1', 32));
  }

  redirect(provider) {
    if (!this.oauth.configured(provider, 'web')) throw new HubError('METHOD_DISABLED', 'browser sign-in is not enabled');
    const u = new URL(this.hub.config.publicUrl);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw invalid();
    return `${u.origin}/api/auth/oauth/web/${provider}/callback`;
  }

  seal(payload) {
    const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', this.key, iv); c.setAAD(AAD);
    const bytes = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), bytes]).toString('base64url');
  }

  cookie(req) {
    try {
      const v = parseCookies(req.headers.cookie ?? '')[WEB_OAUTH_COOKIE];
      if (typeof v !== 'string' || v.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(v)) throw invalid();
      const b = Buffer.from(v, 'base64url'); if (b.length < 29 || b.toString('base64url') !== v) throw invalid();
      const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12)); d.setAAD(AAD); d.setAuthTag(b.subarray(12, 28));
      const p = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
      if (!closed(p, ['phase', 'flow_id', 'browser_nonce', 'verifier', 'invitation', 'notice']) || !['start', 'result'].includes(p.phase)
        || !FLOW_RE.test(p.flow_id) || !RANDOM_RE.test(p.browser_nonce)
        || (p.phase === 'start' ? !RANDOM_RE.test(p.verifier) || p.notice != null : p.verifier != null)
        || (p.notice != null && p.notice !== 'SEPARATE_ACCOUNT')) throw invalid();
      return { ...p, invitation: invitation(p.invitation) };
    } catch { throw invalid(); }
  }

  setCookie(res, payload, ttl = OAUTH_FLOW_TTL_MS / 1000) {
    appendCookie(res, `${WEB_OAUTH_COOKIE}=${payload ? this.seal(payload) : ''}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${payload ? Math.max(0, Math.floor(ttl)) : 0}`);
  }

  start(body, { ip, req, res }) {
    if (!closed(body, ['provider', 'invitation']) || !['google', 'github'].includes(body.provider)) throw new HubError('VALIDATION', 'choose Google or GitHub');
    const resume = invitation(body.invitation); const redirect = this.redirect(body.provider);
    limitOrThrow(this.hub, 'oauth_start_ip', ipKey(ip));
    const now = this.accounts.now();
    if (this.db.get('SELECT COUNT(*) AS n FROM oauth_web_flows WHERE ip_key = ? AND used = 0 AND expires_at > ?', ipKey(ip), now).n >= OPEN_FLOWS_PER_CLIENT) throw new HubError('RATE_LIMITED', 'too many open sign-ins', { retry_after_s: OAUTH_FLOW_TTL_MS / 1000 });
    const state = random(); const browser = random(); const verifier = random(); const id = random(18);
    const nonce = body.provider === 'google' ? random() : null;
    this.hub.txn(() => {
      this.db.insert('oauth_web_flows', { id, provider: body.provider, state_hash: sha256hex(state), browser_nonce_hash: sha256hex(browser), code_challenge: s256(verifier), nonce,
        redirect_uri: redirect, created_at: now, expires_at: this.accounts.at(OAUTH_FLOW_TTL_MS), ip_prefix: ipPrefix(ip), ip_key: ipKey(ip), session_epoch: this.accounts.epoch() });
      this.accounts.audit('auth.oauth.start', { target: id, detail: { provider: body.provider, client: 'web', purpose: 'signin' }, ip });
    });
    this.setCookie(res, { phase: 'start', flow_id: id, browser_nonce: browser, verifier, invitation: resume });
    return { url: this.oauth.authorizeUrl(body.provider, { client: 'web', state, nonce, challenge: s256(verifier), redirect }), expires_in: OAUTH_FLOW_TTL_MS / 1000 };
  }

  // Called only on the exact public callback routes. Failure always sends a
  // fixed own-page destination; provider exceptions/description are discarded.
  async callback(provider, query, { req, res, ip }) {
    let p = null; let f = null; let proven = null; let outcome = 'INVALID_TOKEN'; let claimed = false; let notice = null;
    try {
      limitOrThrow(this.hub, 'oauth_exchange_ip', ipKey(ip));
      p = this.cookie(req);
      f = this.db.get('SELECT * FROM oauth_web_flows WHERE id = ?', p.flow_id);
      if (p.phase !== 'start' || !f || f.used || !safeEqual(sha256hex(p.browser_nonce), f.browser_nonce_hash)) throw invalid();
      const state = query.get('state'); const code = query.get('code'); const error = query.get('error');
      // Lax cookies accompany cross-site top-level GETs. A forged callback
      // must not spend the initiating browser's legitimate pending flow.
      if (f.provider !== provider || query.getAll('state').length !== 1 || !RANDOM_RE.test(state ?? '') || !safeEqual(sha256hex(state), f.state_hash)
        || !safeEqual(s256(p.verifier), f.code_challenge) || query.getAll('code').length > 1 || query.getAll('error').length > 1
        || (query.has('code') === query.has('error')) || (query.has('code') ? typeof code !== 'string' || !/^[^\s\u0000-\u001f\u007f]{1,2048}$/u.test(code)
          : typeof error !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(error))) throw invalid();
      claimed = this.db.run('UPDATE oauth_web_flows SET used = 1, used_at = ? WHERE id = ? AND used = 0', this.accounts.now(), f.id).changes === 1;
      if (!claimed) throw invalid();
      if (f.expires_at <= this.accounts.now() || f.session_epoch !== this.accounts.epoch() || f.ip_prefix !== ipPrefix(ip)
        || f.redirect_uri !== this.redirect(provider)) throw invalid();
      if (error) throw new HubError('PROVIDER_ERROR', 'sign-in was cancelled');
      const flow = { ...f, client: 'web' };
      const who = provider === 'google' ? await this.oauth.google(flow, code, p.verifier) : await this.oauth.github(flow, code, p.verifier);
      proven = who;
      // Restore, expiry and configuration changes while the provider answers
      // must not issue a credential under an obsolete flow.
      if (f.session_epoch !== this.accounts.epoch() || f.expires_at <= this.accounts.now() || f.redirect_uri !== this.redirect(provider)) throw invalid();
      const known = this.oauth.identity(who.provider, who.subject)?.verified_at || (who.authoritative && this.oauth.userByEmail(who.email));
      if (!known) limitOrThrow(this.hub, 'signup_ip', ipKey(ip));
      let session;
      this.hub.txn(() => {
        const user = this.oauth.resolveUser(who, { ip });
        notice = user.separateAccount ? 'SEPARATE_ACCOUNT' : null;
        session = this.accounts.createSession(user.id, { ip, ua: req.headers['user-agent'], method: provider });
        this.db.run("UPDATE oauth_web_flows SET outcome = 'OK', user_id = ?, session_id = ? WHERE id = ?", user.id, session.id, f.id);
        this.accounts.audit('auth.signin', { user: user.id, target: session.id, detail: { method: provider, client: 'web' }, ip });
      });
      appendCookie(res, sessionCookie(session.value, SESSION_ABS_MS / 1000));
      outcome = 'OK';
    } catch (e) {
      outcome = ERRORS.has(e?.code) ? e.code : 'INVALID_TOKEN';
      if (claimed) {
        this.db.run('UPDATE oauth_web_flows SET outcome = ? WHERE id = ?', outcome, f.id);
        this.accounts.audit(outcome === 'SIGNUP_CLOSED' ? 'auth.signup.refused' : 'auth.oauth.failed', { target: f.id, detail: { provider: f.provider, client: 'web', reason: outcome, ...(outcome === 'SIGNUP_CLOSED' && proven ? { method: f.provider, subject_ref: this.oauth.subjectRef(f.provider, proven.subject) } : {}) }, ip });
      }
    }
    if (claimed) this.setCookie(res, { phase: 'result', flow_id: f.id, browser_nonce: p.browser_nonce, invitation: p.invitation, ...(outcome === 'OK' && notice ? { notice } : {}) }, (Date.parse(f.expires_at) - this.hub.wallMs()) / 1000);
    res.writeHead(303, { location: `/signin#oauth=${claimed ? 'web' : 'invalid'}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
  }

  result(body, { req, res, ident, ip }) {
    if (!closed(body, []) || Object.keys(body).length) throw new HubError('VALIDATION', 'no result fields are accepted');
    const p = this.cookie(req); const f = this.db.get('SELECT * FROM oauth_web_flows WHERE id = ?', p.flow_id);
    if (p.phase !== 'result' || !f || !f.used || !f.outcome || f.consumed_at || f.expires_at <= this.accounts.now()
      || f.session_epoch !== this.accounts.epoch() || f.ip_prefix !== ipPrefix(ip) || !safeEqual(sha256hex(p.browser_nonce), f.browser_nonce_hash)) throw invalid();
    if (f.outcome === 'OK' && (ident?.cred.kind !== 'session' || ident.user.id !== f.user_id || ident.cred.id !== f.session_id
      || !this.accounts.credValid(ident.cred) || !this.accounts.csrfOk(ident, req.headers['x-csrf-token']))) throw invalid();
    if (!this.db.run('UPDATE oauth_web_flows SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', this.accounts.now(), f.id).changes) throw invalid();
    this.setCookie(res, null);
    // A sign-in that made a second account says so (accounts are not linked yet), as the desktop exchange does.
    const notice = f.outcome === 'OK' && p.notice === 'SEPARATE_ACCOUNT' ? { notice: { code: 'SEPARATE_ACCOUNT', provider: f.provider, message: SEPARATE_ACCOUNT_MESSAGE(f.provider) } } : {};
    return { ok: f.outcome === 'OK', ...(f.outcome === 'OK' ? {} : { error: { code: f.outcome } }), ...notice, invitation: p.invitation };
  }

  sweep() { this.db.run('DELETE FROM oauth_web_flows WHERE expires_at < ?', this.accounts.at(-86_400_000)); }
}
