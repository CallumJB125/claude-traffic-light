// Abuse limits (CONTRACT §5.2, §5.3, §6.1): token buckets per member and per
// client IP for logins and mutations, and per connection for WS frames. They
// run on the hub monotonic clock, so tests drive them with the fake clock.

import { isIP, isIPv6 } from 'node:net'; // privacy-flow: hub-server
import { isLoopback } from './config.js';
import { HubError } from './db.js';

// {capacity, per_ms}: at most `capacity` at once, refilled at capacity/per_ms.
export const DEFAULT_LIMITS = Object.freeze({
  remote_public_ip: { capacity: 60, per_ms: 60_000 },
  remote_request_ip: { capacity: 120, per_ms: 60_000 },
  remote_request_grant: { capacity: 120, per_ms: 60_000 },
  client_feedback_guest: { capacity: 10, per_ms: 3_600_000 }, // new client tasks; persistent retries do not spend it
  login_ip: { capacity: 10, per_ms: 60_000 },
  mutate_ip: { capacity: 300, per_ms: 60_000 },
  mutate_member: { capacity: 120, per_ms: 60_000 },
  dispatch_member: { capacity: 30, per_ms: 60_000 },   // dispatch, retry, take_over_with_claude
  presence_member: { capacity: 60, per_ms: 60_000 },   // GET /api/boards/:id/presence (D37b)
  communication_write_member: { capacity: 60, per_ms: 3_600_000 },
  communication_read_member: { capacity: 60, per_ms: 60_000 },
  ownership_read_member: { capacity: 60, per_ms: 60_000 }, // staff/runner projections, including declaration responses
  search_member: { capacity: 60, per_ms: 60_000 },     // bounded staff search, including invalid queries
  overview_member: { capacity: 30, per_ms: 60_000 },   // bounded selected-team overview
  workflow_member: { capacity: 20, per_ms: 3_600_000 }, // new definitions/versions/task sets
  capture_routes_user: { capacity: 30, per_ms: 60_000 },
  capture_report_user: { capacity: 120, per_ms: 60_000 }, // across all of this user's memberships
  label_rewrite_board: { capacity: 10, per_ms: 3_600_000 },  // label rename / delete with strip: each rewrites up to 2,000 cards (D91), per board
  agent_card_member: { capacity: 20, per_ms: 3_600_000 },    // board_create_card, per member the runs are for
  agent_lesson_member: { capacity: 30, per_ms: 3_600_000 },  // board_add_lesson, per member the runs are for
  // BOARD_AUTH=accounts (ACCOUNTS-API.md "Rate limits"; design §9.1)
  // Per address AND requesting network (/24, /64): a third party exhausting
  // them can't silence the owner's own sign-in from elsewhere (M1).
  auth_start_email: { capacity: 3, per_ms: 15 * 60_000 },     // over: silent (same answer, no mail)
  auth_start_email_hour: { capacity: 10, per_ms: 3_600_000 }, // over: silent
  auth_start_email_all: { capacity: 40, per_ms: 3_600_000 },  // per address, every network together; over: silent
  auth_start_ip: { capacity: 20, per_ms: 3_600_000 },
  auth_methods_ip: { capacity: 60, per_ms: 60_000 },          // GET /api/auth/methods (no auth)
  auth_start_global: { capacity: 500, per_ms: 3_600_000 },
  auth_verify_ip: { capacity: 10, per_ms: 10 * 60_000 },
  auth_verify_email: { capacity: 10, per_ms: 15 * 60_000 },   // verify attempts per address AND network; the lockout is the failure budget
  auth_lock_notice: { capacity: 1, per_ms: 86_400_000 },      // "someone is trying codes" mail, per address
  mail_global: { capacity: 2000, per_ms: 86_400_000 },        // sign-in, invite and notice mails, whole hub (BOARD_MAIL_DAILY_CAP)
  mail_global_new: { capacity: 1000, per_ms: 86_400_000 },    // … of which mail to addresses without an account (half the cap; M-C)
  signup_ip: { capacity: 10, per_ms: 86_400_000 },            // new users per IP
  team_create_user: { capacity: 3, per_ms: 86_400_000 },      // POST /api/teams (design §9.1)
  oauth_start_ip: { capacity: 20, per_ms: 3_600_000 },        // POST /api/auth/oauth/start, per /64 (D77)
  oauth_exchange_ip: { capacity: 30, per_ms: 3_600_000 },     // POST /api/auth/oauth/exchange, per /64 (D77)
  runner_enrol_user: { capacity: 30, per_ms: 3_600_000 },     // POST /api/teams/:id/enrol, per user (D79)
  invite_team: { capacity: 20, per_ms: 86_400_000 },          // invites sent (create + resend), per team
  invite_user: { capacity: 50, per_ms: 86_400_000 },          // … per inviting user
  invite_ip: { capacity: 50, per_ms: 3_600_000 },             // … per client IP
  invite_preview_ip: { capacity: 30, per_ms: 10 * 60_000 },   // POST /api/invites/preview (no auth)
  invite_accept_ip: { capacity: 30, per_ms: 10 * 60_000 },
  invite_accept_user: { capacity: 30, per_ms: 10 * 60_000 },
  webhook_conn: { capacity: 600, per_ms: 60_000 },          // inbound webhooks, per connection
  integration_conn: { capacity: 120, per_ms: 60_000 },      // actAs calls, per connection (never mutate_member)
  integration_card_conn: { capacity: 20, per_ms: 3_600_000 }, // actAs().createCard, per connection
  integration_card_day_conn: { capacity: 100, per_ms: 86_400_000 }, // … and per day, only for a connector that declares dailyCardCap (its cap, unless set here)
  integration_card_subject: { capacity: 5, per_ms: 3_600_000 }, // … and per (connection, provider user) when act() names meta.subject
  integration_user_cmd: { capacity: 30, per_ms: 60_000 },   // webhooks per (connection, provider user) a connector's rateSubject names (D42 addendum C3)
  integration_rate_audit_conn: { capacity: 6, per_ms: 60_000 }, // … its refusals audited, per connection
  integration_prepare_member: { capacity: 5, per_ms: 3_600_000 },  // POST /api/integrations/:target/prepare (D97), per admin
  integration_prepare_org: { capacity: 10, per_ms: 86_400_000 },    // … per team
  integration_identity_member: { capacity: 10, per_ms: 3_600_000 }, // POST /api/integrations/:id/identity/start (D98), per member
  integration_link_fail_ip: { capacity: 30, per_ms: 10 * 60_000 },  // failed identity callbacks, per client network (/64)
  webhook_fail_ip: { capacity: 30, per_ms: 60_000 },        // failed webhook deliveries, per connection + client IP (/64)
  vault_health_conn: { capacity: 1, per_ms: 60_000 },       // 'vault_error' health write + log, per connection
  share_write_user: { capacity: 60, per_ms: 3_600_000 },    // POST /api/interaction/v1/shares (interaction-shares.js)
  share_call_user: { capacity: 240, per_ms: 60_000 },       // shared-session calls, per teammate (a watch long-polls)
  share_call_team: { capacity: 1200, per_ms: 60_000 },      // … and per team, all its teammates together
  ws_browser: { capacity: 60, per_ms: 10_000 },
  ws_runner: { capacity: 3000, per_ms: 10_000 },
});

const IDLE_SWEEP_MS = 10 * 60_000;

export class RateLimiter {
  constructor({ now, limits = DEFAULT_LIMITS }) {
    this.now = now;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.buckets = new Map();
  }

  /** → {ok:true} or {ok:false, retry_after_ms}. `over`: {capacity, per_ms} in place of the rule's own. */
  take(rule, key, over = null) {
    const lim = over ?? this.limits[rule];
    if (!lim) throw new Error(`unknown rate limit ${rule}`);
    const now = this.now();
    const k = `${rule}|${key}`;
    let b = this.buckets.get(k);
    if (!b) { b = { tokens: lim.capacity, at: now }; this.buckets.set(k, b); }
    const rate = lim.capacity / lim.per_ms;
    b.tokens = Math.min(lim.capacity, b.tokens + (now - b.at) * rate);
    b.at = now;
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
    return { ok: false, retry_after_ms: Math.ceil((1 - b.tokens) / rate) };
  }

  /** Would take() succeed? Same answer, spends nothing and creates no bucket. */
  peek(rule, key) {
    const lim = this.limits[rule];
    if (!lim) throw new Error(`unknown rate limit ${rule}`);
    const b = this.buckets.get(`${rule}|${key}`);
    if (!b) return { ok: true };
    const rate = lim.capacity / lim.per_ms;
    const tokens = Math.min(lim.capacity, b.tokens + (this.now() - b.at) * rate);
    return tokens >= 1 ? { ok: true } : { ok: false, retry_after_ms: Math.ceil((1 - tokens) / rate) };
  }

  // A bucket may go only once it would have refilled anyway: an hourly rule
  // swept after 10 idle minutes would come back full and could be waited out.
  sweep() {
    const now = this.now();
    for (const [k, b] of this.buckets) {
      const per = this.limits[k.slice(0, k.indexOf('|'))]?.per_ms ?? 0;
      if (now - b.at > Math.max(IDLE_SWEEP_MS, per)) this.buckets.delete(k);
    }
  }
}

/**
 * Failed-attempt budget per key (H2): at most `budget` failures in any
 * rolling `windowMs`. Each exhaustion also locks the key for lockBaseMs,
 * doubling per exhaustion up to lockCapMs (the count of exhaustions decays
 * two windows after the last lock ends, or on reset()). Counts failures, never attempts.
 * Idle keys are swept at most once a minute; past `maxKeys` the least recently
 * failed key goes first (memory stays bounded under a spray of addresses).
 */
export class FailureBudget {
  constructor({ now, budget = 20, windowMs = 86_400_000, lockBaseMs = 3_600_000, lockCapMs = 86_400_000, maxKeys = 20_000, sweepMs = 60_000 }) {
    Object.assign(this, { now, budget, windowMs, lockBaseMs, lockCapMs, maxKeys, sweepMs });
    this.keys = new Map();   // key → {fails:[mono], k: exhaustions, until: lock end}; least recently failed first
    this.sweptAt = -Infinity;
  }

  state(key) {
    const now = this.now();
    const e = this.keys.get(key);
    if (!e) return null;
    while (e.fails.length && e.fails[0] <= now - this.windowMs) e.fails.shift();
    if (e.k && now - e.until > 2 * this.windowMs) e.k = 0;
    if (!e.fails.length && !e.k && e.until <= now) { this.keys.delete(key); return null; }
    return e;
  }

  /** ms until the key may fail again; 0 = open. */
  lockedFor(key) {
    const e = this.state(key);
    if (!e) return 0;
    const now = this.now();
    const rolling = e.fails.length >= this.budget ? e.fails[e.fails.length - this.budget] + this.windowMs - now : 0;
    return Math.max(0, rolling, e.until - now);
  }

  // The entry for key, made the most recent; sweeps and evicts first.
  touch(key) {
    const now = this.now();
    if (now - this.sweptAt >= this.sweepMs) {
      this.sweptAt = now;
      for (const k of [...this.keys.keys()]) this.state(k);
    }
    const e = this.state(key) ?? { fails: [], k: 0, until: 0 };
    this.keys.delete(key);
    this.keys.set(key, e);
    while (this.keys.size > this.maxKeys) this.keys.delete(this.keys.keys().next().value);
    return e;
  }

  /** Record a failure → true when it exhausted the budget (a lockout began). */
  fail(key) {
    const now = this.now();
    const e = this.touch(key);
    e.fails.push(now);
    if (e.fails.length < this.budget) return false;
    e.k += 1;
    e.until = now + Math.min(this.lockCapMs, this.lockBaseMs * 2 ** (e.k - 1));
    return true;
  }

  /** Restore `n` failures recorded at monotonic time `at` (a restart must not unlock). */
  seed(key, n, at) {
    const e = this.touch(key);
    for (let i = 0; i < n; i++) e.fails.push(at);
    e.fails.sort((a, b) => a - b);
    this.state(key);
  }

  reset(key) { this.keys.delete(key); }
}

/** Take one token or throw RATE_LIMITED with retry_after_s (HTTP routes and runner RPCs). */
export function limitOrThrow(hub, rule, key, over = null) {
  const r = hub.limiter.take(rule, key, over);
  if (!r.ok) {
    const s = Math.max(1, Math.ceil(r.retry_after_ms / 1000));
    throw new HubError('RATE_LIMITED', `too many requests; retry in ${s} s`, { retry_after_s: s });
  }
}

export function v6groups(a) {
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = a.includes('::') && tail ? tail.split(':') : [];
  return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
}

const bare = (ip) => String(ip ?? '').replace(/^::ffff:/, '');

/** Rate-limit key for a client address: IPv6 by its /64 (design §9.1), IPv4 whole. */
export function ipKey(ip) {
  const a = bare(ip);
  return isIP(a) === 6 ? `${v6groups(a).slice(0, 4).join(':')}::/64` : a;
}

/** The requesting network: IPv4 /24, IPv6 /64 (per-address limits pair the address with this). */
export function netKey(ip) {
  const a = bare(ip);
  if (isIP(a) === 4) return `${a.split('.').slice(0, 3).join('.')}.0/24`;
  return ipKey(a);
}

// Behind Cloudflare Tunnel every request comes from cloudflared on loopback;
// the edge's CF-Connecting-IP is the client. Only trusted with Access in front
// (or BOARD_TRUST_CF_IP in accounts mode) and from a loopback peer
// (cloudflared), never from a direct connection.
export function clientIp(req, config) {
  const peer = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  const trusted = config.auth === 'access' || (config.auth === 'accounts' && config.trustCfIp);
  const cf = trusted && isLoopback(peer) ? req.headers['cf-connecting-ip'] : null;
  return typeof cf === 'string' && cf ? cf : peer;
}

/**
 * The failure-bucket key for a client IP: an IPv6 client usually holds a whole
 * /64, so it is keyed on that prefix (one address per failure would never run
 * out); IPv4 and IPv4-mapped addresses stay as they are.
 */
export function failBucketKey(ip) {
  const a = String(ip ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (!isIPv6(a)) return a;
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const full = tail === undefined ? h : [...h, ...Array(8).fill('0')].slice(0, 8 - (tail ? tail.split(':').length : 0));
  return `${full.slice(0, 4).map((x) => parseInt(x, 16).toString(16)).join(':')}::/64`;
}
