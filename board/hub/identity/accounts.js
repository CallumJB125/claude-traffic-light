// BOARD_AUTH=accounts (ACCOUNTS-API.md, CONTRACT D50–D58): email one-time
// codes (sign-up = sign-in), per-install desktop device tokens (Bearer), cookie
// sessions for a plain browser (with CSRF), step-up for account deletion, and
// an audit row for every auth event. HTTP wiring lives in hub/http.js; this
// file never sees a socket except through hub.closeCredSockets.

import { createHash, createHmac, hkdfSync, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { HubError } from '../db.js';
import { bearer, newDeviceToken, parseCookies, safeEqual, sha256hex } from '../auth.js';
import { limitOrThrow } from '../ratelimit.js';
import { EMAIL_ONLY } from '../views.js';

export const SESSION_COOKIE = '__Host-buddy_session';
export const FLOW_COOKIE = '__Host-buddy_flow';
export const FLOW_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const STEP_UP_MS = 5 * 60_000;
export const SESSION_IDLE_MS = 14 * 86_400_000;
export const SESSION_ABS_MS = 30 * 86_400_000;
export const SESSION_ROTATE_MS = 86_400_000;
const ROTATE_GRACE_MS = 60_000;
const TOUCH_MS = 60_000;
const LIVE_FLOWS_PER_EMAIL = 3;
const CLIENTS = new Set(['buddy_desktop', 'web']);
const FORM_FACTORS = new Set(['laptop', 'desktop']);
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function v6groups(a) {
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = a.includes('::') && tail ? tail.split(':') : [];
  return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
}

/** /24 for IPv4, /48 for IPv6: the only form an address is ever stored in. */
export function ipPrefix(ip) {
  const a = String(ip ?? '').replace(/^::ffff:/, '');
  if (isIP(a) === 4) return `${a.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(a) === 6) return `${v6groups(a).slice(0, 3).join(':')}::/48`;
  return null;
}

// Rate-limit key for an address: IPv6 by /64 (design §9.1), IPv4 whole.
const ipKey = (ip) => {
  const a = String(ip ?? '').replace(/^::ffff:/, '');
  return isIP(a) === 6 ? `${v6groups(a).slice(0, 4).join(':')}::/64` : a;
};

export function normalizeEmail(v) {
  if (typeof v !== 'string') throw new HubError('VALIDATION', 'email required');
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HubError('VALIDATION', 'email is not an address');
  return e;
}

export function maskEmail(e) {
  const [local, domain] = String(e).split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}

const optStr = (v, max, name) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw new HubError('VALIDATION', `${name} must be a string ≤ ${max}`);
  return v;
};

// Device names and platforms are chosen by whoever starts the flow: shown in
// the mail as quoted plain text, one line, bounded.
const mailSafe = (s, max = 60) => String(s ?? '').replace(/[\p{C}"]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export class Accounts {
  constructor(hub, { mailer }) {
    this.hub = hub;
    this.db = hub.db;
    this.mailer = mailer;
    const key = (label) => Buffer.from(hkdfSync('sha256', String(hub.secret), Buffer.alloc(0), `board-accounts:${label}`, 32));
    this.kCode = key('email-code');
    this.kCsrf = key('csrf');
    this.kRef = key('audit-email');
  }

  now() { return this.hub.iso(); }
  at(ms) { return new Date(this.hub.wallMs() + ms).toISOString(); }
  epoch() { return Number(this.db.meta('session_epoch') ?? 1); }
  codeHash(flowId, code) { return createHmac('sha256', this.kCode).update(`${flowId}:${code}`).digest('hex'); }
  csrfFor(sessionId) { return b64url(createHmac('sha256', this.kCsrf).update(sessionId).digest()); }
  // Audit rows about someone without an account yet carry a keyed hash, not the address.
  emailRef(email) { return createHmac('sha256', this.kRef).update(email).digest('hex').slice(0, 16); }

  audit(action, { user = null, target = null, detail = null, ip = null, org = null } = {}) {
    this.db.insert('audit', {
      actor: user ? `user:${user}` : 'anonymous', action, target, detail: detail ? JSON.stringify(detail) : null,
      at: this.now(), org_id: org, actor_user_id: user, ip_prefix: ip ? ipPrefix(ip) : null,
    });
  }

  liveUser(id) { return this.db.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', id); }

  // The origin a magic link points at: BOARD_PUBLIC_URL, else (loopback hub
  // only) the loopback Host the request came to. Never a Host from outside.
  linkOrigin(req) {
    if (this.hub.config.publicUrl) return new URL(this.hub.config.publicUrl).origin;
    const host = req?.headers?.host ?? '';
    return LOOPBACK_HOST.test(host) ? `http://${host}` : null;
  }

  // ── email one-time codes ──────────────────────────────────────────────────

  /** POST /api/auth/email/start → {flow_id, expires_in}. Same answer for every address. */
  start(body, { ip, ident = null, req = null, res = null }) {
    const purpose = body.purpose ?? 'signin';
    if (purpose !== 'signin' && purpose !== 'delete') throw new HubError('VALIDATION', "purpose must be 'signin' or 'delete'");
    let email;
    let client;
    let userId = null;
    if (purpose === 'delete') {
      if (!ident) throw new HubError('UNAUTHENTICATED', 'sign in first');
      email = ident.user.primary_email;
      if (!email) throw new HubError('FORBIDDEN', 'this account has no email address');
      client = ident.cred.kind === 'device' ? 'buddy_desktop' : 'web';
      userId = ident.user.id;
    } else {
      email = normalizeEmail(body.email);
      client = body.client ?? 'buddy_desktop';
      if (!CLIENTS.has(client)) throw new HubError('VALIDATION', "client must be 'buddy_desktop' or 'web'");
    }
    const deviceName = optStr(body.device_name, 100, 'device_name');
    const platform = optStr(body.platform, 50, 'platform');
    limitOrThrow(this.hub, 'auth_start_global', 'all');
    limitOrThrow(this.hub, 'auth_start_ip', ipKey(ip));
    const flowId = b64url(randomBytes(18));
    const out = { flow_id: flowId, expires_in: FLOW_TTL_MS / 1000 };
    const lim = this.hub.limiter;
    if (!lim.take('auth_start_email', email).ok || !lim.take('auth_start_email_hour', email).ok) {
      // Same answer, no mail, no row: a verify on this flow_id fails like a wrong code.
      this.audit('auth.code.suppressed', { user: userId, detail: { email_ref: this.emailRef(email), reason: 'email_rate' }, ip });
      return out;
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = this.now();
    let nonce = null;
    if (client === 'web' && purpose === 'signin') {
      nonce = b64url(randomBytes(24));
      appendCookie(res, `${FLOW_COOKIE}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${FLOW_TTL_MS / 1000}`);
    }
    this.hub.txn(() => {
      // At most three live flows per address: older ones die.
      this.db.run(`UPDATE login_flows SET dead_at = ? WHERE id IN (
        SELECT id FROM login_flows WHERE email = ? AND purpose = ? AND dead_at IS NULL AND consumed_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`, now, email, purpose, now, LIVE_FLOWS_PER_EMAIL - 1);
      this.db.insert('login_flows', {
        id: flowId, email, purpose, client, user_id: userId, device_name: deviceName, platform,
        code_hash: this.codeHash(flowId, code), browser_nonce_hash: nonce ? sha256hex(nonce) : null,
        created_at: now, expires_at: this.at(FLOW_TTL_MS), ip_prefix: ipPrefix(ip),
      });
      this.audit('auth.code.sent', { user: userId, target: flowId, detail: { email_ref: this.emailRef(email), client, purpose }, ip });
    });
    const link = client === 'web' && purpose === 'signin' ? this.linkOrigin(req) : null;
    const mail = codeMail({ purpose, client, code, deviceName, platform, link: link && `${link}/auth/email#f=${flowId}&c=${code}` });
    this.mailer.send({ to: email, ...mail, idempotencyKey: flowId })
      .catch((e) => this.hub.log.warn('sign-in mail failed', { mailer: this.mailer.kind, err: e.message }));
    return out;
  }

  /** POST /api/auth/email/verify. */
  verify(body, { ip, ident = null, req = null, res = null }) {
    limitOrThrow(this.hub, 'auth_verify_ip', ipKey(ip));
    const now = this.now();
    const flowId = typeof body.flow_id === 'string' ? body.flow_id : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const invalid = (msg = 'that code is wrong or has expired: ask for a new one', extra = {}) => new HubError('INVALID_TOKEN', msg, extra);
    const f = flowId ? this.db.get('SELECT * FROM login_flows WHERE id = ?', flowId) : null;
    if (!f || f.dead_at || f.consumed_at || f.verified_at || f.expires_at <= now) throw invalid();
    const lock = this.hub.limiter.take('auth_verify_email', f.email);
    if (!lock.ok) {
      const s = Math.max(1, Math.ceil(lock.retry_after_ms / 1000));
      this.audit('auth.lockout', { user: f.user_id, detail: { email_ref: this.emailRef(f.email) }, ip });
      throw new HubError('RATE_LIMITED', `too many attempts for this address; retry in ${s} s`, { retry_after_s: s });
    }
    if (!/^\d{6}$/.test(code) || !safeEqual(this.codeHash(f.id, code), f.code_hash)) {
      const attempts = f.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      this.hub.txn(() => {
        this.db.run('UPDATE login_flows SET attempts = ?, dead_at = ? WHERE id = ?', attempts, dead ? now : null, f.id);
        this.audit('auth.code.failed', { user: f.user_id, target: f.id, detail: { attempts, dead }, ip });
      });
      throw invalid(dead ? 'too many wrong codes: ask for a new one' : undefined, { attempts_left: MAX_ATTEMPTS - attempts });
    }
    if (f.purpose === 'delete') return this.stepUp(f, { ip, ident });
    // A magic link opened in another browser than the one that asked could be
    // someone mailing you their own link (login CSRF): ask first (design §4.3).
    if (f.client === 'web' && body.via === 'link' && body.confirm !== true) {
      let n = null;
      try { n = parseCookies(req?.headers?.cookie)[FLOW_COOKIE] ?? null; } catch { n = null; }
      if (!n || !f.browser_nonce_hash || !safeEqual(sha256hex(n), f.browser_nonce_hash)) {
        throw new HubError('CONFIRM_REQUIRED', 'this link was requested from another browser', { email_masked: maskEmail(f.email) });
      }
    }
    let device = null;
    if (f.client === 'buddy_desktop') {
      device = {
        name: optStr(body.device_name, 100, 'device_name') ?? f.device_name ?? 'Buddy desktop',
        platform: optStr(body.platform, 50, 'platform') ?? f.platform,
        form_factor: body.form_factor ?? null,
      };
      if (device.form_factor != null && !FORM_FACTORS.has(device.form_factor)) throw new HubError('VALIDATION', "form_factor must be 'laptop' or 'desktop'");
    }
    const known = this.db.get("SELECT 1 AS x FROM identities WHERE provider = 'email' AND subject = ?", f.email)
      ?? this.db.get('SELECT 1 AS x FROM users WHERE primary_email = ? AND deleted_at IS NULL', f.email);
    if (!known) limitOrThrow(this.hub, 'signup_ip', ipKey(ip));
    let out;
    let cookie = null;
    this.hub.txn(() => {
      if (!this.db.run('UPDATE login_flows SET verified_at = ?, consumed_at = ? WHERE id = ? AND consumed_at IS NULL', now, now, f.id).changes) throw invalid();
      const user = this.userForEmail(f.email, { ip });
      this.linkMembers(user.id, f.email);
      const base = { user: publicUser(user), teams: this.teams(user.id) };
      if (device) {
        const token = newDeviceToken();
        const id = randomUUID();
        this.db.insert('user_devices', {
          id, user_id: user.id, name: device.name, client: 'buddy_desktop', platform: device.platform, form_factor: device.form_factor,
          token_hash: sha256hex(token), created_at: now, last_seen_at: now, last_ip_prefix: ipPrefix(ip),
        });
        this.audit('auth.signin', { user: user.id, target: id, detail: { method: 'email', client: 'buddy_desktop' }, ip });
        out = { ...base, device_token: token, device_id: id };
      } else {
        const s = this.createSession(user.id, { ip, ua: req?.headers?.['user-agent'] });
        cookie = sessionCookie(s.value, SESSION_ABS_MS / 1000);
        this.audit('auth.signin', { user: user.id, target: s.id, detail: { method: 'email', client: 'web' }, ip });
        out = { ...base, csrf_token: this.csrfFor(s.id) };
      }
    });
    if (cookie) {
      appendCookie(res, cookie);
      appendCookie(res, `${FLOW_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    }
    return out;
  }

  stepUp(f, { ip, ident }) {
    if (!ident || ident.user.id !== f.user_id) throw new HubError('INVALID_TOKEN', 'that code is wrong or has expired: ask for a new one');
    this.hub.txn(() => {
      this.db.run('UPDATE login_flows SET verified_at = ? WHERE id = ?', this.now(), f.id);
      this.audit('auth.stepup', { user: f.user_id, target: f.id, detail: { purpose: f.purpose }, ip });
    });
    return { ok: true, flow_id: f.id, step_up_expires_in: STEP_UP_MS / 1000 };
  }

  // Sign-up = sign-in: the verified address finds its user, or makes one.
  userForEmail(email, { ip }) {
    const now = this.now();
    const byIdentity = this.db.get("SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = 'email' AND i.subject = ? AND u.deleted_at IS NULL", email);
    let user = byIdentity ?? this.db.get('SELECT * FROM users WHERE primary_email = ? AND deleted_at IS NULL', email);
    if (!user) {
      user = { id: randomUUID(), display_name: email.split('@')[0].slice(0, 100), primary_email: email, primary_email_verified_at: now, avatar_url: null, created_at: now, deleted_at: null };
      this.db.insert('users', user);
      this.audit('user.create', { user: user.id, detail: { method: 'email' }, ip });
    } else if (!user.primary_email_verified_at && user.primary_email === email) {
      this.db.run('UPDATE users SET primary_email_verified_at = ? WHERE id = ?', now, user.id);
      user = this.liveUser(user.id);
    }
    if (byIdentity) this.db.run("UPDATE identities SET last_used_at = ? WHERE provider = 'email' AND subject = ?", now, email);
    else this.db.insert('identities', { id: randomUUID(), user_id: user.id, provider: 'email', subject: email, email, email_verified: 1, created_at: now, last_used_at: now });
    return user;
  }

  // Member rows an admin added with this address before accounts (Access
  // mode, BOARD_BOOTSTRAP) join the user who just proved the address (§14).
  linkMembers(userId, email) {
    this.db.run('UPDATE members SET user_id = ? WHERE user_id IS NULL AND email IS NOT NULL AND lower(trim(email)) = ?', userId, email);
  }

  // ── credentials ───────────────────────────────────────────────────────────

  createSession(userId, { ip, ua }) {
    const value = b64url(randomBytes(32));
    const id = randomUUID();
    const now = this.now();
    this.db.insert('sessions', {
      id, id_hash: sha256hex(value), user_id: userId, auth_method: 'email', created_at: now, auth_at: now, last_seen_at: now, rotated_at: now,
      idle_expires_at: this.at(SESSION_IDLE_MS), abs_expires_at: this.at(SESSION_ABS_MS), session_epoch: this.epoch(),
      user_agent: typeof ua === 'string' ? ua.slice(0, 200) : null, ip_prefix: ipPrefix(ip),
    });
    return { id, value };
  }

  sessionLive(s, now = this.now()) {
    return !s.revoked_at && s.idle_expires_at > now && s.abs_expires_at > now && s.session_epoch === this.epoch();
  }

  /**
   * → {user, cred:{kind:'device'|'session', id}, setCookie?} or null (no
   * credential). An Authorization header that doesn't name a live device
   * throws UNAUTHENTICATED: a Bearer request never falls back to cookies.
   */
  authenticate(req, { ip = null, rotate = true } = {}) {
    if (req.headers.authorization != null) {
      const tok = bearer(req);
      const d = tok ? this.db.get('SELECT * FROM user_devices WHERE token_hash = ? AND revoked_at IS NULL', sha256hex(tok)) : null;
      const user = d && this.liveUser(d.user_id);
      if (!user) throw new HubError('UNAUTHENTICATED', 'device token unknown or revoked: sign in again');
      if (this.hub.ageOf(d.last_seen_at) == null || this.hub.ageOf(d.last_seen_at) >= TOUCH_MS) {
        this.db.run('UPDATE user_devices SET last_seen_at = ?, last_ip_prefix = COALESCE(?, last_ip_prefix) WHERE id = ?', this.now(), ipPrefix(ip), d.id);
      }
      return { user, cred: { kind: 'device', id: d.id } };
    }
    let value = null;
    try { value = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null; } catch { value = null; }
    if (!value) return null;
    const h = sha256hex(value);
    const now = this.now();
    const s = this.db.get('SELECT * FROM sessions WHERE id_hash = ? OR (prev_id_hash = ? AND prev_valid_until > ?)', h, h, now);
    const user = s && this.sessionLive(s, now) && this.liveUser(s.user_id);
    if (!user) return null;
    let setCookie = null;
    if (rotate && s.id_hash === h && this.hub.ageOf(s.rotated_at) >= SESSION_ROTATE_MS) {
      const next = b64url(randomBytes(32));
      this.db.run('UPDATE sessions SET id_hash = ?, prev_id_hash = ?, prev_valid_until = ?, rotated_at = ? WHERE id = ?', sha256hex(next), h, this.at(ROTATE_GRACE_MS), now, s.id);
      setCookie = sessionCookie(next, Math.max(0, Math.floor((Date.parse(s.abs_expires_at) - this.hub.wallMs()) / 1000)));
    }
    if (this.hub.ageOf(s.last_seen_at) >= TOUCH_MS) {
      const idle = this.at(SESSION_IDLE_MS);
      this.db.run('UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?', now, idle < s.abs_expires_at ? idle : s.abs_expires_at, s.id);
    }
    return { user, cred: { kind: 'session', id: s.id }, setCookie };
  }

  /** Still good? (the per-tick backstop for open browser sockets) */
  credValid(cred) {
    if (cred.kind === 'device') {
      const d = this.db.get('SELECT user_id FROM user_devices WHERE id = ? AND revoked_at IS NULL AND token_hash IS NOT NULL', cred.id);
      return !!(d && this.liveUser(d.user_id));
    }
    const s = this.db.get('SELECT * FROM sessions WHERE id = ?', cred.id);
    return !!(s && this.sessionLive(s) && this.liveUser(s.user_id));
  }

  csrfOk(ident, header) {
    return ident.cred.kind === 'session' && typeof header === 'string' && safeEqual(header, this.csrfFor(ident.cred.id));
  }

  // ── account ───────────────────────────────────────────────────────────────

  teams(userId) {
    const rows = this.db.all(`SELECT o.id, o.name, o.slug, m.role, m.id AS member_id FROM members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.removed_at IS NULL ORDER BY o.name, o.id`, userId);
    return rows.map((t) => ({ ...t, boards: this.db.all('SELECT id, name, key_prefix FROM boards WHERE org_id = ? ORDER BY name', t.id) }));
  }

  /** GET /api/account → {user, teams, pending_invites}. pending_invites stays [] until invites land (P3). */
  account(ident) {
    return {
      user: publicUser(ident.user),
      teams: this.teams(ident.user.id),
      pending_invites: [],
      ...(ident.cred.kind === 'session' ? { csrf_token: this.csrfFor(ident.cred.id) } : {}),
    };
  }

  listDevices(ident) {
    const rows = this.db.all('SELECT * FROM user_devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at', ident.user.id);
    return {
      devices: rows.map((d) => ({
        id: d.id, name: d.name, client: d.client, platform: d.platform, form_factor: d.form_factor,
        created_at: d.created_at, last_seen_at: d.last_seen_at, current: ident.cred.kind === 'device' && ident.cred.id === d.id,
      })),
    };
  }

  revokeDevice(ident, id, { ip, reason = 'revoked' } = {}) {
    const d = this.db.get('SELECT * FROM user_devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL', id, ident.user.id);
    if (!d) throw new HubError('NOT_FOUND', 'device not found');
    this.hub.txn(() => {
      this.db.run('UPDATE user_devices SET revoked_at = ?, token_hash = NULL, revoke_reason = ? WHERE id = ?', this.now(), reason, id);
      this.audit(reason === 'signout' ? 'auth.signout' : 'device.revoke', { user: ident.user.id, target: id, detail: { kind: 'device' }, ip });
      this.hub.later(() => this.hub.closeCredSockets({ kind: 'device', id }, reason === 'signout' ? 'signed out' : 'device revoked'));
    });
    return { ok: true };
  }

  signout(ident, { ip, res }) {
    if (ident.cred.kind === 'device') return this.revokeDevice(ident, ident.cred.id, { ip, reason: 'signout' });
    this.hub.txn(() => {
      this.db.run("UPDATE sessions SET revoked_at = ?, revoke_reason = 'signout' WHERE id = ? AND revoked_at IS NULL", this.now(), ident.cred.id);
      this.audit('auth.signout', { user: ident.user.id, target: ident.cred.id, detail: { kind: 'session' }, ip });
      this.hub.later(() => this.hub.closeCredSockets(ident.cred, 'signed out'));
    });
    appendCookie(res, `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  }

  /**
   * DELETE /api/account {flow_id}: needs a 'delete' flow this user verified
   * in the last 5 minutes (design §10.2, minimal): revoke every credential,
   * drop identities and flows, tombstone the user, soft-remove and
   * pseudonymise every membership. Journal rows keep pointing at member ids.
   */
  deleteAccount(ident, body, { ip }) {
    const user = ident.user;
    const f = typeof body.flow_id === 'string' ? this.db.get('SELECT * FROM login_flows WHERE id = ?', body.flow_id) : null;
    const age = f?.verified_at ? this.hub.ageOf(f.verified_at) : null;
    if (!f || f.purpose !== 'delete' || f.user_id !== user.id || f.consumed_at || age == null || age > STEP_UP_MS) {
      throw new HubError('STEP_UP_REQUIRED', "confirm with a fresh email code first (start + verify with purpose 'delete')", { max_age_s: STEP_UP_MS / 1000 });
    }
    const soleOwner = this.db.all(`SELECT o.id, o.name FROM members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.role = 'owner' AND m.removed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM members x WHERE x.org_id = m.org_id AND x.id != m.id AND x.role = 'owner' AND x.removed_at IS NULL)
        AND EXISTS (SELECT 1 FROM members x WHERE x.org_id = m.org_id AND x.id != m.id AND x.removed_at IS NULL)`, user.id);
    if (soleOwner.length) throw new HubError('CONFLICT', 'you are the only owner of a team with other members: make someone else owner first', { sole_owner_of: soleOwner });
    const now = this.now();
    const email = user.primary_email;
    const members = this.db.all('SELECT * FROM members WHERE user_id = ?', user.id);
    const creds = [
      ...this.db.all('SELECT id FROM user_devices WHERE user_id = ? AND revoked_at IS NULL', user.id).map((r) => ({ kind: 'device', id: r.id })),
      ...this.db.all('SELECT id FROM sessions WHERE user_id = ?', user.id).map((r) => ({ kind: 'session', id: r.id })),
    ];
    const runnerDevices = this.db.all('SELECT d.id FROM devices d JOIN members m ON m.id = d.member_id WHERE m.user_id = ? AND d.revoked_at IS NULL', user.id);
    this.hub.txn(() => {
      this.db.run("UPDATE user_devices SET revoked_at = COALESCE(revoked_at, ?), token_hash = NULL, revoke_reason = COALESCE(revoke_reason, 'account_deleted') WHERE user_id = ?", now, user.id);
      this.db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
      this.db.run('DELETE FROM login_flows WHERE user_id = ? OR email = ?', user.id, email ?? '');
      this.db.run('DELETE FROM identities WHERE user_id = ?', user.id);
      this.db.run("UPDATE users SET display_name = 'Deleted user', primary_email = NULL, primary_email_verified_at = NULL, avatar_url = NULL, deleted_at = ? WHERE id = ?", now, user.id);
      for (const m of members) {
        // github_login/github_id are NOT NULL and unique per org until the P2
        // rebuild: a private placeholder (never shown) and a stable negative id.
        this.db.run("UPDATE members SET removed_at = COALESCE(removed_at, ?), display_name = 'Deleted user', email = NULL, github_login = ?, github_id = ? WHERE id = ?",
          now, `${EMAIL_ONLY}deleted-${m.id}`, -Number.parseInt(createHash('sha256').update(`deleted:${m.id}`).digest('hex').slice(0, 12), 16), m.id);
        this.db.run('UPDATE devices SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL', now, m.id);
      }
      this.audit('user.deleted', { user: user.id, detail: { memberships: members.length }, ip });
      this.hub.later(() => {
        for (const c of creds) this.hub.closeCredSockets(c, 'account deleted');
        for (const d of runnerDevices) this.hub.runners.get(d.id)?.close(4403, 'account deleted');
        for (const m of members) this.hub.memberChanged(m.id);
      });
    });
    if (email) {
      this.mailer.send({ to: email, subject: 'Your Buddy account was deleted', text: 'Your Buddy account and its sign-in details were deleted. Cards and comments you wrote stay with their teams, shown as "Deleted user".\n\nIf you did not do this, reply to this email.\n' })
        .catch((e) => this.hub.log.warn('deletion mail failed', { mailer: this.mailer.kind, err: e.message }));
    }
    return { ok: true };
  }
}

export function publicUser(u) {
  return { id: u.id, display_name: u.display_name, email: u.primary_email, email_verified: !!u.primary_email_verified_at };
}

export function sessionCookie(value, maxAgeS) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeS}`;
}

export function appendCookie(res, cookie) {
  if (!res) return;
  const prev = res.getHeader('set-cookie');
  res.setHeader('set-cookie', prev == null ? [cookie] : [...[].concat(prev), cookie]);
}

function codeMail({ purpose, client, code, deviceName, platform, link }) {
  const what = client === 'buddy_desktop'
    ? `Buddy for desktop${deviceName ? ` on "${mailSafe(deviceName)}"` : ''}${platform ? ` (${mailSafe(platform, 30)})` : ''}`
    : 'Buddy in a web browser';
  const warn = 'Never share this code. Nobody from Buddy will ever ask you for it: anyone who asks you to read it out, forward it or type it somewhere else is trying to get into your account.';
  if (purpose === 'delete') {
    return {
      subject: `${code} confirms deleting your Buddy account`,
      text: `Someone signed in to your Buddy account asked to delete it.\n\nYour confirmation code: ${code}\n\nIt expires in 10 minutes and works once.\n\n${warn}\n\nIf this wasn't you, don't use the code, and sign out your devices.\n`,
    };
  }
  return {
    subject: `${code} is your Buddy sign-in code`,
    text: `Your Buddy sign-in code: ${code}\n\nThis signs in ${what}.\nIt expires in 10 minutes and works once.\n\n${warn}\n`
      + (link ? `\nOr open this link in the same browser:\n${link}\n` : '')
      + "\nIf you didn't ask for this, ignore this email: nobody gets in without the code.\n",
  };
}
