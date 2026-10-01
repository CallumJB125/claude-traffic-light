// BOARD_AUTH=accounts (ACCOUNTS-API.md, CONTRACT D50–D58): email one-time
// codes (sign-up = sign-in), per-install desktop device tokens (Bearer), cookie
// sessions for a plain browser (with CSRF), step-up for account deletion, and
// an audit row for every auth event. HTTP wiring lives in hub/http.js; this
// file never sees a socket except through hub.closeCredSockets.

import { createHash, createHmac, hkdfSync, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net'; // privacy-flow: hub-server
import { HubError } from '../db.js';
import { bearer, newDeviceToken, parseCookies, safeEqual, sha256hex } from '../auth.js';
import { FailureBudget, ipKey, limitOrThrow, netKey, v6groups } from '../ratelimit.js';
import { oauthProviders, signupPolicy } from '../config.js';
import { EMAIL_ONLY } from '../views.js';
import { backfillSlugs, PURGE_AFTER_MS } from './teams.js';
import { BRAND } from '../../shared/brand.js';

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
// A silenced start's row (no mail) holds this instead of a code HMAC, so no code ever matches it.
const DUD = 'dud:';
// The one refusal a sign-up gets (D104): it names the mode, never the list.
export const SIGNUP_CLOSED_TEXT = 'Sign-up is invite-only right now. Ask a team owner for an invite.';
// Background sends failing this many times in a row: /api/auth/methods stops offering email until one succeeds.
export const MAIL_FAILING_AFTER = 5;
// Step-ups: deleting the account, deleting a team (L-H). One can't be spent on the other.
export const STEP_UP_PURPOSES = Object.freeze(['delete', 'delete_team']);
const PURPOSES = new Set(['signin', ...STEP_UP_PURPOSES]);
const CLIENTS = new Set(['buddy_desktop', 'web']);
const FORM_FACTORS = new Set(['laptop', 'desktop']);
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** /24 for IPv4, /48 for IPv6: the only form an address is ever stored in. */
export function ipPrefix(ip) {
  const a = String(ip ?? '').replace(/^::ffff:/, '');
  if (isIP(a) === 4) return `${a.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(a) === 6) return `${v6groups(a).slice(0, 3).join(':')}::/48`;
  return null;
}

/**
 * The one form an address is compared and stored in (L7): trimmed, lower-cased
 * by JS (full Unicode), never by SQLite's ASCII-only lower().
 */
export const canonEmail = (v) => String(v).normalize('NFKC').trim().toLowerCase();

/** Who proved a primary address so that an address match may link to it (D83): an email code, an authoritative Google account, or (NULL) the pre-OAuth paths. */
export const AUTHORITATIVE_VIA = Object.freeze([null, 'email', 'google']);
export const authoritativeVia = (u) => AUTHORITATIVE_VIA.includes(u?.primary_email_via ?? null);

export function normalizeEmail(v) {
  if (typeof v !== 'string') throw new HubError('VALIDATION', 'email required');
  const e = canonEmail(v);
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HubError('VALIDATION', 'email is not an address');
  return e;
}

/** The mailbox an address delivers to: `a+tag@x` and `a@x` are one (M-C; mail-rate keys only). */
export function mailbox(email) {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at).replace(/\+.*$/, '');
  return `${local || email.slice(0, at)}${email.slice(at)}`;
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

/**
 * A name people chose (team, inviter, device, platform), made safe for a
 * plain-text mail line: no control/format characters, quotes or angle
 * brackets, one line, bounded, and nothing a mail client would turn into a
 * link (schemes removed, domains defanged: evil[.]com).
 */
export function mailName(s, max = 60, fallback = 'Someone') {
  return String(s ?? '')
    .replace(/[\p{C}"<>`]/gu, ' ')
    .replace(/[a-z][a-z0-9+.-]*:\/\//gi, '')
    .replace(/\b([a-z0-9-]+)\.([a-z]{2,})\b/gi, '$1[.]$2')
    .replace(/\s+/g, ' ').trim().slice(0, max) || fallback;
}

export class Accounts {
  constructor(hub, { mailer }) {
    this.hub = hub;
    this.db = hub.db;
    this.mailer = mailer;
    // A send runs in the background after the hub has answered "started", so a broken
    // mailer is invisible to the person signing in: /api/health carries when one last failed.
    this.mailLastErrorAt = null;
    this.mailFailures = 0;
    if (mailer && !mailer.tracked) {
      const send = mailer.send.bind(mailer);
      mailer.send = async (mail) => {
        let out;
        try { out = await send(mail); } catch (e) { this.mailLastErrorAt = this.hub.iso(); this.mailFailures++; throw e; }
        this.mailFailures = 0;
        return out;
      };
      mailer.tracked = true;
    }
    const key = (label) => Buffer.from(hkdfSync('sha256', String(hub.secret), Buffer.alloc(0), `board-accounts:${label}`, 32));
    this.kCode = key('email-code');
    this.kCsrf = key('csrf');
    this.kRef = key('audit-email');
    this.canonicaliseStored();
    this.signup = signupPolicy(hub.config);
    if (this.signup.mode === 'allowlist' && !this.signup.domains.size && !this.signup.emails.size) {
      hub.log.warn('sign-up is invite-only: BOARD_SIGNUP=allowlist with an empty BOARD_SIGNUP_ALLOW');
    }
    // Wrong codes per address, every network together (H2).
    this.failures = new FailureBudget({ now: () => hub.mono(), budget: hub.config.authFailBudget ?? 20 });
    this.seedFailures();
  }

  // Wrong codes count against the address, except on a step-up: those only
  // ever come from the signed-in user, so they count against that user, and a
  // third party guessing sign-in codes can't block a deletion (M-A).
  budgetKey(f) { return f.purpose === 'signin' ? f.email : `delete|${f.user_id}`; }

  // The budget lives in memory: a restart re-reads the last 24 h of wrong codes
  // from login_flows (L-B), except those a later successful code cleared.
  seedFailures() {
    const rows = this.db.all(`SELECT f.email, f.purpose, f.user_id, f.attempts, f.created_at FROM login_flows f
      WHERE f.attempts > 0 AND f.created_at > ? AND NOT EXISTS (SELECT 1 FROM login_flows v
        WHERE v.email = f.email AND v.purpose = f.purpose AND v.verified_at IS NOT NULL AND v.verified_at >= f.created_at)`, this.at(-86_400_000));
    for (const f of rows) this.failures.seed(this.budgetKey(f), f.attempts, this.hub.mono() - (this.hub.ageOf(f.created_at) ?? 0));
  }

  /** Has this address an account (a verified email identity or a live user)? */
  hasAccount(email) {
    return !!(this.db.get("SELECT 1 AS x FROM identities WHERE provider = 'email' AND subject = ?", email)
      ?? this.db.get('SELECT 1 AS x FROM users WHERE primary_email = ? AND deleted_at IS NULL', email));
  }

  /**
   * May a NEW account be made for this verified address (D104)? Open mode:
   * always. Allowlist: the exact address or its exact domain is listed, or the
   * address holds a usable pending invite, or an unlinked live member row an
   * admin or BOARD_BOOTSTRAP made for it. `eligible` false (a Google address
   * Google is not authoritative for) never qualifies.
   */
  signupAllowed(email, { eligible = true } = {}) {
    const p = this.signup;
    if (p.mode === 'open') return true;
    if (!eligible) return false;
    if (p.emails.has(email) || p.domains.has(email.slice(email.lastIndexOf('@') + 1))) return true;
    const invites = this.db.all('SELECT * FROM invites WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', email, this.now());
    if (invites.some((inv) => this.hub.invites?.usable(inv))) return true;
    return this.db.all(`SELECT m.email FROM members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id IS NULL AND m.removed_at IS NULL AND m.email IS NOT NULL AND o.deleted_at IS NULL`).some((m) => canonEmail(m.email) === email);
  }

  requireSignup(email, opts) {
    if (!this.signupAllowed(email, opts)) throw new HubError('SIGNUP_CLOSED', SIGNUP_CLOSED_TEXT);
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

  // Only what the clients are offered: the email routes stay open, so someone mid-flow still
  // verifies, and a new start may still try (its success turns email back on).
  mailFailing() { return this.mailFailures >= MAIL_FAILING_AFTER; }

  /** GET /api/auth/methods (no auth): which sign-in buttons to show (D66, D76). Booleans only. */
  methods({ ip }) {
    limitOrThrow(this.hub, 'auth_methods_ip', ipKey(ip));
    const m = oauthProviders(this.hub.config);
    return { google: m.includes('google'), github: m.includes('github'), email: !!this.mailer && !this.mailFailing() };
  }

  // ── email one-time codes (only with a mailer, D66) ────────────────────────

  // The hub-wide daily cap on the mails anyone can make it send (sign-in
  // codes, invites, lockout notices; M2). Takes one when there is one. Mail to
  // an address without an account may use only half of it, so a flood of
  // made-up addresses can't stop existing accounts signing in (M-C).
  mailBudget(email) {
    const lim = this.hub.limiter;
    const known = this.hasAccount(email);
    if ((known || lim.peek('mail_global_new', 'all').ok) && lim.take('mail_global', 'all').ok) {
      if (!known) lim.take('mail_global_new', 'all');
      return true;
    }
    this.hub.log.warn('daily mail cap reached: mail not sent (BOARD_MAIL_DAILY_CAP)', { new_addresses_only: !known });
    return false;
  }

  requireMailer() {
    if (!this.mailer) throw new HubError('METHOD_DISABLED', 'email sign-in is not enabled on this hub');
  }

  /** POST /api/auth/email/start → {flow_id, expires_in}. Same answer for every address. */
  start(body, { ip, ident = null, req = null, res = null }) {
    this.requireMailer();
    const purpose = body.purpose ?? 'signin';
    if (!PURPOSES.has(purpose)) throw new HubError('VALIDATION', "purpose must be 'signin', 'delete' or 'delete_team'");
    let email;
    let client;
    let userId = null;
    if (purpose !== 'signin') {
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
    // Per mailbox (+tags folded, M-C); a step-up per user, so nobody else can use up its buckets (M-A).
    const box = purpose === 'signin' ? mailbox(email) : `delete|${userId}`;
    const mine = `${box}|${netKey(ip)}`;
    const now = this.now();
    let nonce = null;
    if (client === 'web' && purpose === 'signin') {
      nonce = b64url(randomBytes(24));
      appendCookie(res, `${FLOW_COOKIE}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${FLOW_TTL_MS / 1000}`);
    }
    const row = {
      id: flowId, email, purpose, client, user_id: userId, device_name: deviceName, platform,
      browser_nonce_hash: nonce ? sha256hex(nonce) : null, created_at: now, expires_at: this.at(FLOW_TTL_MS), ip_prefix: ipPrefix(ip),
    };
    // Silenced: the same answer and cookie, no mail, and a dud row no code matches, so a verify
    // counts down and the flow dies like a real one (a fixed "5 tries left" would say this
    // address asked recently). A dud never kills the flows the address already has.
    // A new address sign-up may not use (D104) is silenced before mailBudget: it spends no mail token.
    const quiet = !lim.take('auth_start_email', mine).ok || !lim.take('auth_start_email_hour', mine).ok || !lim.take('auth_start_email_all', box).ok
      ? 'email_rate' : purpose === 'signin' && !this.hasAccount(email) && !this.signupAllowed(email) ? 'signup_closed' : !this.mailBudget(email) ? 'mail_cap' : null;
    if (quiet) {
      this.hub.txn(() => {
        this.db.insert('login_flows', { ...row, code_hash: `${DUD}${randomBytes(32).toString('hex')}` });
        this.audit('auth.code.suppressed', { user: userId, detail: { email_ref: this.emailRef(email), reason: quiet }, ip });
      });
      return out;
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.hub.txn(() => {
      // At most three live flows per address: older ones die (duds don't count).
      this.db.run(`UPDATE login_flows SET dead_at = ? WHERE id IN (
        SELECT id FROM login_flows WHERE email = ? AND purpose = ? AND dead_at IS NULL AND consumed_at IS NULL AND expires_at > ? AND code_hash NOT LIKE '${DUD}%'
        ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`, now, email, purpose, now, LIVE_FLOWS_PER_EMAIL - 1);
      this.db.insert('login_flows', { ...row, code_hash: this.codeHash(flowId, code) });
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
    this.requireMailer();
    limitOrThrow(this.hub, 'auth_verify_ip', ipKey(ip));
    const now = this.now();
    const flowId = typeof body.flow_id === 'string' ? body.flow_id : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const invalid = (msg = 'that code is wrong or has expired: ask for a new one', extra = {}) => new HubError('INVALID_TOKEN', msg, extra);
    const f = flowId ? this.db.get('SELECT * FROM login_flows WHERE id = ?', flowId) : null;
    // A flow_id nobody was given answers like a fresh flow (L-G).
    if (!f) throw invalid(undefined, { attempts_left: MAX_ATTEMPTS });
    if (f.dead_at || f.consumed_at || f.verified_at || f.expires_at <= now) throw invalid();
    // The failure budget (H2): locked means no code is even checked.
    const budget = this.budgetKey(f);
    const locked = this.failures.lockedFor(budget);
    if (locked) {
      const s = Math.max(1, Math.ceil(locked / 1000));
      throw new HubError('RATE_LIMITED', `too many wrong codes for this address; retry in ${s} s`, { retry_after_s: s });
    }
    limitOrThrow(this.hub, 'auth_verify_email', `${f.purpose === 'signin' ? f.email : budget}|${netKey(ip)}`);
    if (!/^\d{6}$/.test(code) || !safeEqual(this.codeHash(f.id, code), f.code_hash)) {
      const attempts = f.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      const exhausted = this.failures.fail(budget);
      this.hub.txn(() => {
        this.db.run('UPDATE login_flows SET attempts = ?, dead_at = ? WHERE id = ?', attempts, dead ? now : null, f.id);
        this.audit('auth.code.failed', { user: f.user_id, target: f.id, detail: { attempts, dead }, ip });
        if (exhausted) this.audit('auth.lockout', { user: f.user_id, detail: { email_ref: this.emailRef(f.email), purpose: f.purpose, retry_after_s: Math.ceil(this.failures.lockedFor(budget) / 1000) }, ip });
      });
      if (exhausted && f.purpose === 'signin') this.lockNotice(f.email);
      throw invalid(dead ? 'too many wrong codes: ask for a new one' : undefined, { attempts_left: MAX_ATTEMPTS - attempts });
    }
    this.failures.reset(budget);
    if (f.purpose !== 'signin') return this.stepUp(f, { ip, ident });
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
        name: optStr(body.device_name, 100, 'device_name') ?? f.device_name ?? `${BRAND.name} desktop`,
        platform: optStr(body.platform, 50, 'platform') ?? f.platform,
        form_factor: body.form_factor ?? null,
      };
      if (device.form_factor != null && !FORM_FACTORS.has(device.form_factor)) throw new HubError('VALIDATION', "form_factor must be 'laptop' or 'desktop'");
    }
    if (!this.hasAccount(f.email)) limitOrThrow(this.hub, 'signup_ip', ipKey(ip));
    let out;
    let cookie = null;
    try {
      this.hub.txn(() => {
        if (!this.db.run('UPDATE login_flows SET verified_at = ?, consumed_at = ? WHERE id = ? AND consumed_at IS NULL', now, now, f.id).changes) throw invalid();
        const user = this.userForEmail(f.email, { ip });
        this.linkMembers(user.id, f.email);
        const base = { user: publicUser(user), teams: this.teams(user.id) };
        if (device) {
          const d = this.issueDevice(user.id, device, { ip, method: 'email' });
          out = { ...base, device_token: d.token, device_id: d.id };
        } else {
          const s = this.createSession(user.id, { ip, ua: req?.headers?.['user-agent'] });
          cookie = sessionCookie(s.value, SESSION_ABS_MS / 1000);
          this.audit('auth.signin', { user: user.id, target: s.id, detail: { method: 'email', client: 'web' }, ip });
          out = { ...base, csrf_token: this.csrfFor(s.id) };
        }
      });
    } catch (e) {
      // Re-checked where the account is made (the list or the invite may have changed since the start): the flow is spent.
      if (e.code === 'SIGNUP_CLOSED') {
        this.hub.txn(() => {
          this.db.run('UPDATE login_flows SET dead_at = ? WHERE id = ? AND consumed_at IS NULL', now, f.id);
          this.audit('auth.signup.refused', { target: f.id, detail: { method: 'email', email_ref: this.emailRef(f.email) }, ip });
        });
      }
      throw e;
    }
    if (cookie) {
      appendCookie(res, cookie);
      appendCookie(res, `${FLOW_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    }
    return out;
  }

  /** A desktop device token (`bdt_…`, shown once, stored as sha256) for a user who just signed in, inside the caller's transaction. */
  issueDevice(userId, device, { ip, method, subjectRef = null }) {
    const now = this.now();
    const token = newDeviceToken();
    const id = randomUUID();
    this.db.insert('user_devices', {
      id, user_id: userId, name: device.name, client: 'buddy_desktop', platform: device.platform, form_factor: device.form_factor,
      token_hash: sha256hex(token), created_at: now, last_seen_at: now, last_ip_prefix: ipPrefix(ip), session_epoch: this.epoch(),
    });
    this.audit('auth.signin', { user: userId, target: id, detail: { method, client: 'buddy_desktop', ...(subjectRef ? { subject_ref: subjectRef } : {}) }, ip });
    return { id, token };
  }

  // An address with an account hears (at most once a day) that someone is
  // guessing its codes; an address without one gets nothing.
  lockNotice(email) {
    if (!this.mailer) return;
    if (!this.hasAccount(email) || !this.hub.limiter.take('auth_lock_notice', mailbox(email)).ok || !this.mailBudget(email)) return;
    this.mailer.send({
      to: email,
      subject: `Someone is trying sign-in codes for your ${BRAND.name} account`,
      text: `Someone entered too many wrong ${BRAND.name} sign-in codes for this address, so signing in with an email code is paused for a while.\n\nIf this was you, wait and ask for a new code. If it wasn't, nobody got in: they would need a code from this mailbox. Never share a code with anyone.\n`,
    }).catch((e) => this.hub.log.warn('lockout notice mail failed', { mailer: this.mailer.kind, err: e.message }));
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
    if (!user || (!byIdentity && !authoritativeVia(user))) this.requireSignup(email);
    // An address a GitHub (or non-authoritative Google) sign-in put there is
    // not proof that its holder owns the mailbox: the code just proved it, so
    // the address moves to a new account, never into that one (D83).
    if (user && !byIdentity && !authoritativeVia(user)) {
      this.releasePrimary(user, { ip });
      user = null;
    }
    if (!user) {
      user = { id: randomUUID(), display_name: email.split('@')[0].slice(0, 100), primary_email: email, primary_email_verified_at: now, primary_email_via: 'email', avatar_url: null, created_at: now, deleted_at: null };
      this.db.insert('users', user);
      this.audit('user.create', { user: user.id, detail: { method: 'email' }, ip });
    } else if (!user.primary_email_verified_at && user.primary_email === email) {
      this.db.run('UPDATE users SET primary_email_verified_at = ? WHERE id = ?', now, user.id);
      user = this.liveUser(user.id);
    }
    if (byIdentity) this.db.run("UPDATE identities SET last_used_at = ? WHERE provider = 'email' AND subject = ?", now, email);
    else this.db.insert('identities', { id: randomUUID(), user_id: user.id, provider: 'email', subject: email, email, email_verified: 1, created_at: now, last_used_at: now, verified_at: now });
    return user;
  }

  /** A non-authoritative primary address yields to someone who proved the mailbox (D83). */
  releasePrimary(user, { ip }) {
    this.db.run('UPDATE users SET primary_email = NULL, primary_email_verified_at = NULL, primary_email_via = NULL WHERE id = ?', user.id);
    this.audit('user.email_released', { user: user.id, detail: { via: user.primary_email_via }, ip });
  }

  // Member rows an admin added with this address before accounts (Access
  // mode, BOARD_BOOTSTRAP) join the user who just proved the address (§14).
  // Compared in JS (canonEmail), like every other address check; the row
  // keeps the canonical form from then on.
  linkMembers(userId, email) {
    for (const m of this.db.all('SELECT id, email FROM members WHERE user_id IS NULL AND email IS NOT NULL')) {
      if (canonEmail(m.email) === email) this.db.run('UPDATE members SET user_id = ?, email = ? WHERE id = ?', userId, email, m.id);
    }
  }

  // Addresses written before L7 (migration 009 used SQLite's ASCII-only
  // lower(); an Access-era member row may keep its case): rewritten once in
  // canonical form. A row whose canonical form is already taken is left alone.
  canonicaliseStored() {
    const fix = (table, col, key = 'id') => {
      for (const r of this.db.all(`SELECT ${key} AS k, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`)) {
        const c = canonEmail(r.v);
        if (c === r.v) continue;
        try { this.db.run(`UPDATE ${table} SET ${col} = ? WHERE ${key} = ?`, c, r.k); } catch { /* the canonical form exists already */ }
      }
    };
    fix('members', 'email');
    fix('users', 'primary_email');
    fix('identities', 'email');
    for (const r of this.db.all("SELECT id, subject FROM identities WHERE provider = 'email'")) {
      const c = canonEmail(r.subject);
      if (c !== r.subject) try { this.db.run('UPDATE identities SET subject = ? WHERE id = ?', c, r.id); } catch { /* taken */ }
    }
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
      // A restore bumps the epoch: tokens from before it may have been revoked since the backup (L3).
      const user = d && d.session_epoch === this.epoch() && this.liveUser(d.user_id);
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
      const d = this.db.get('SELECT user_id, session_epoch FROM user_devices WHERE id = ? AND revoked_at IS NULL AND token_hash IS NOT NULL', cred.id);
      return !!(d && d.session_epoch === this.epoch() && this.liveUser(d.user_id));
    }
    const s = this.db.get('SELECT * FROM sessions WHERE id = ?', cred.id);
    return !!(s && this.sessionLive(s) && this.liveUser(s.user_id));
  }

  csrfOk(ident, header) {
    return ident.cred.kind === 'session' && typeof header === 'string' && safeEqual(header, this.csrfFor(ident.cred.id));
  }

  // ── account ───────────────────────────────────────────────────────────────

  teams(userId) {
    if (this.db.get('SELECT 1 AS x FROM orgs WHERE slug IS NULL LIMIT 1')) backfillSlugs(this.db);
    const rows = this.db.all(`SELECT o.id, o.name, o.slug, o.plan, m.role, m.id AS member_id FROM members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.removed_at IS NULL AND o.deleted_at IS NULL ORDER BY o.name, o.id`, userId);
    return rows.map((t) => ({ ...t, boards: this.db.all('SELECT id, name, key_prefix FROM boards WHERE org_id = ? ORDER BY name', t.id) }));
  }

  /** GET /api/account → {user, identities, teams, pending_invites} (invites for the user's verified addresses, P3). */
  account(ident) {
    return {
      user: publicUser(ident.user),
      // The sign-in methods this account has proven (provider names only, D78): the app offers these for a step-up.
      identities: this.db.all("SELECT DISTINCT provider FROM identities WHERE user_id = ? AND verified_at IS NOT NULL AND provider IN ('email','google','github') ORDER BY provider", ident.user.id),
      teams: this.teams(ident.user.id),
      pending_invites: this.hub.invites?.pendingFor(ident.user) ?? [],
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
      this.hub.enrolments?.revokeForUserDevice(id, reason);
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
   * The step-up that deleting an account ('delete') or a team ('delete_team')
   * needs: a flow of that purpose this user started and verified in the last
   * 5 minutes, not used yet; or (D78) an OAuth re-authentication of this user
   * from this same device token whose 5-minute window is open (`flow_id` names
   * it, or is left out). For a team (`teamId`) the OAuth step-up must name
   * that team (L6); for the account it must name none. → the flow, or STEP_UP_REQUIRED.
   */
  requireStepUp(userId, flowId, purpose = 'delete', cred = null, teamId = null) {
    const o = this.oauthStepUp(userId, flowId, purpose, cred, teamId);
    if (o) return o;
    const f = typeof flowId === 'string' ? this.db.get('SELECT * FROM login_flows WHERE id = ?', flowId) : null;
    const age = f?.verified_at ? this.hub.ageOf(f.verified_at) : null;
    if (!f || f.purpose !== purpose || f.user_id !== userId || f.consumed_at || age == null || age > STEP_UP_MS) {
      throw new HubError('STEP_UP_REQUIRED', `confirm it is you first: a fresh email code, or Google/GitHub again (purpose '${purpose}')`, { max_age_s: STEP_UP_MS / 1000, purpose });
    }
    return f;
  }

  oauthStepUp(userId, flowId, purpose, cred, teamId = null) {
    if (cred?.kind !== 'device') return null;
    const purposes = purpose === 'delete_team' ? ['delete', 'delete_team'] : ['delete'];
    const team = purpose === 'delete_team' ? teamId : null;
    const now = this.now();
    const rows = typeof flowId === 'string'
      ? [this.db.get('SELECT * FROM oauth_flows WHERE id = ?', flowId)]
      : this.db.all('SELECT * FROM oauth_flows WHERE user_id = ? AND stepup_until > ? AND consumed_at IS NULL ORDER BY stepup_until DESC', userId, now);
    const f = rows.find((r) => r && r.user_id === userId && r.cred_id === cred.id && purposes.includes(r.purpose) && (r.team_id ?? null) === team
      && !r.consumed_at && r.stepup_until && r.stepup_until > now);
    return f ? { ...f, oauth: true } : null;
  }

  /** Spend a step-up (inside the caller's transaction): single use. */
  consumeStepUp(f) {
    const table = f.oauth ? 'oauth_flows' : 'login_flows';
    if (!this.db.run(`UPDATE ${table} SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`, this.now(), f.id).changes) {
      throw new HubError('STEP_UP_REQUIRED', 'that confirmation was already used', { max_age_s: STEP_UP_MS / 1000 });
    }
  }

  /**
   * DELETE /api/account {flow_id}: needs a 'delete' flow this user verified
   * in the last 5 minutes (design §10.2, minimal), then eraseUser.
   */
  deleteAccount(ident, body, { ip }) {
    const step = this.requireStepUp(ident.user.id, body.flow_id, 'delete', ident.cred);
    return this.eraseUser(ident.user, { ip, step });
  }

  /**
   * Revoke every credential, drop identities and flows, tombstone the user,
   * soft-remove and pseudonymise every membership (journal rows keep pointing
   * at member ids). Also the operator's `hub/admin.js delete-user` (by: 'operator').
   */
  eraseUser(user, { ip = null, by = null, step = null } = {}) {
    const soleOwner = this.db.all(`SELECT o.id, o.name FROM members m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = ? AND m.role = 'owner' AND m.removed_at IS NULL AND o.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM members x WHERE x.org_id = m.org_id AND x.id != m.id AND x.role = 'owner' AND x.removed_at IS NULL)
        AND EXISTS (SELECT 1 FROM members x WHERE x.org_id = m.org_id AND x.id != m.id AND x.removed_at IS NULL)`, user.id);
    if (soleOwner.length) throw new HubError('CONFLICT', 'you are the only owner of a team with other members: make someone else owner first', { sole_owner_of: soleOwner });
    const now = this.now();
    const email = user.primary_email;
    // Every address the user held: all of them leave the database (M3).
    const addresses = [...new Set([email, ...this.db.all('SELECT email FROM identities WHERE user_id = ? AND email IS NOT NULL', user.id).map((r) => r.email)]
      .filter(Boolean).map((e) => e.toLowerCase()))];
    const inAddresses = `(${addresses.map(() => '?').join(',') || 'NULL'})`;
    const members = this.db.all('SELECT * FROM members WHERE user_id = ?', user.id);
    const creds = [
      ...this.db.all('SELECT id FROM user_devices WHERE user_id = ? AND revoked_at IS NULL', user.id).map((r) => ({ kind: 'device', id: r.id })),
      ...this.db.all('SELECT id FROM sessions WHERE user_id = ?', user.id).map((r) => ({ kind: 'session', id: r.id })),
    ];
    const runnerDevices = this.db.all('SELECT d.id FROM devices d JOIN members m ON m.id = d.member_id WHERE m.user_id = ? AND d.revoked_at IS NULL', user.id);
    this.hub.txn(() => {
      if (step) this.consumeStepUp(step);
      this.db.run(`UPDATE user_devices SET revoked_at = COALESCE(revoked_at, ?), token_hash = NULL, revoke_reason = COALESCE(revoke_reason, 'account_deleted'),
        name = 'Deleted device', platform = NULL, last_ip_prefix = NULL WHERE user_id = ?`, now, user.id);
      this.db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
      this.db.run(`DELETE FROM login_flows WHERE user_id = ? OR email IN ${inAddresses}`, user.id, ...addresses);
      this.db.run('DELETE FROM oauth_flows WHERE user_id = ?', user.id);
      this.db.run(`UPDATE runner_enrollments SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, 'account_deleted'), token_hash = NULL,
        name = 'Deleted device', last_ip_prefix = NULL WHERE user_id = ?`, now, user.id);
      // Invites to them: pending ones are withdrawn, then every invite they
      // accepted or that names one of their addresses forgets the address.
      this.db.run(`UPDATE invites SET revoked_at = ?, revoke_reason = 'account_deleted'
        WHERE email IN ${inAddresses} AND accepted_at IS NULL AND revoked_at IS NULL`, now, ...addresses);
      this.db.run(`UPDATE invites SET email = 'deleted:' || id WHERE accepted_by_user = ? OR email IN ${inAddresses}`, user.id, ...addresses);
      this.db.run('DELETE FROM identities WHERE user_id = ?', user.id);
      this.db.run("UPDATE users SET display_name = 'Deleted user', primary_email = NULL, primary_email_verified_at = NULL, avatar_url = NULL, deleted_at = ? WHERE id = ?", now, user.id);
      for (const m of members) this.hub.dropMemberPending(m.id);
      // Teams where they were the only member are soft-deleted with them (a
      // team needs an owner, D59); the purge after 7 days is P5.
      this.db.run(`UPDATE orgs SET deleted_at = ?, purge_after = ? WHERE deleted_at IS NULL AND id IN (
        SELECT m.org_id FROM members m WHERE m.user_id = ? AND m.removed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM members x WHERE x.org_id = m.org_id AND x.id != m.id AND x.removed_at IS NULL))`,
      now, this.at(PURGE_AFTER_MS), user.id);
      this.hub.revokeDeletedTeamConnections(now);
      this.hub.dropDeletedTeamLabels();
      for (const m of members) {
        // github_login/github_id are NOT NULL and unique per org until the P2
        // rebuild: a private placeholder (never shown) and a stable negative id.
        this.db.run("UPDATE members SET removed_at = COALESCE(removed_at, ?), display_name = 'Deleted user', email = NULL, github_login = ?, github_id = ? WHERE id = ?",
          now, `${EMAIL_ONLY}deleted-${m.id}`, -Number.parseInt(createHash('sha256').update(`deleted:${m.id}`).digest('hex').slice(0, 12), 16), m.id);
        this.db.run('UPDATE devices SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL', now, m.id);
        this.hub.invites?.revokeWhere('created_by', m.id, 'inviter_deleted');
      }
      this.audit('user.deleted', { user: user.id, detail: { memberships: members.length, ...(by ? { by } : {}) }, ip });
      this.hub.later(() => {
        for (const c of creds) this.hub.closeCredSockets(c, 'account deleted');
        for (const d of runnerDevices) {
          this.hub.runners.get(d.id)?.close(4403, 'account deleted');
          this.hub.presence.dropDevice(d.id);
        }
        for (const m of members) this.hub.memberChanged(m.id);
      });
    });
    if (email && this.mailer) {
      this.mailer.send({ to: email, subject: `Your ${BRAND.name} account was deleted`, text: `Your ${BRAND.name} account and its sign-in details were deleted. Cards and comments you wrote stay with their teams, shown as "Deleted user".\n\nIf you did not do this, reply to this email.\n` })
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
  // Chosen by whoever starts the flow: plain, one line, link-free (M2).
  const device = mailName(deviceName, 60, '');
  const plat = mailName(platform, 30, '');
  const what = client === 'buddy_desktop'
    ? `${BRAND.name} for desktop${device ? ` on "${device}"` : ''}${plat ? ` (${plat})` : ''}`
    : `${BRAND.name} in a web browser`;
  const warn = `Never share this code. Nobody from ${BRAND.name} will ever ask you for it: anyone who asks you to read it out, forward it or type it somewhere else is trying to get into your account.`;
  if (purpose === 'delete') {
    return {
      subject: `${code} confirms deleting your ${BRAND.name} account`,
      text: `Someone signed in to your ${BRAND.name} account asked to delete it.\n\nYour confirmation code: ${code}\n\nIt expires in 10 minutes and works once.\n\n${warn}\n\nIf this wasn't you, don't use the code, and sign out your devices.\n`,
    };
  }
  if (purpose === 'delete_team') {
    return {
      subject: `${code} confirms deleting a ${BRAND.name} team`,
      text: `Someone signed in to your ${BRAND.name} account asked to delete a team you own. Deleting a team removes it, its boards and its cards for every member.\n\nYour confirmation code: ${code}\n\nIt expires in 10 minutes, works once, and confirms deleting a team only (not your account).\n\n${warn}\n\nIf this wasn't you, don't use the code, and sign out your devices.\n`,
    };
  }
  return {
    subject: `${code} is your ${BRAND.name} sign-in code`,
    text: `Your ${BRAND.name} sign-in code: ${code}\n\nThis signs in ${what}.\nIt expires in 10 minutes and works once.\n\n${warn}\n`
      + (link ? `\nOr open this link in the same browser:\n${link}\n` : '')
      + "\nIf you didn't ask for this, ignore this email: nobody gets in without the code.\n",
  };
}
