// Abuse limits (CONTRACT §5.2, §5.3, §6.1): token buckets per member and per
// client IP for logins and mutations, and per connection for WS frames. They
// run on the hub monotonic clock, so tests drive them with the fake clock.

import { isLoopback } from './config.js';
import { HubError } from './db.js';

// {capacity, per_ms}: at most `capacity` at once, refilled at capacity/per_ms.
export const DEFAULT_LIMITS = Object.freeze({
  login_ip: { capacity: 10, per_ms: 60_000 },
  mutate_ip: { capacity: 300, per_ms: 60_000 },
  mutate_member: { capacity: 120, per_ms: 60_000 },
  dispatch_member: { capacity: 30, per_ms: 60_000 },   // dispatch, retry, take_over_with_claude
  agent_card_member: { capacity: 20, per_ms: 3_600_000 },    // board_create_card, per member the runs are for
  agent_lesson_member: { capacity: 30, per_ms: 3_600_000 },  // board_add_lesson, per member the runs are for
  // BOARD_AUTH=accounts (ACCOUNTS-API.md "Rate limits"; design §9.1)
  auth_start_email: { capacity: 3, per_ms: 15 * 60_000 },     // over: silent (same answer, no mail)
  auth_start_email_hour: { capacity: 10, per_ms: 3_600_000 }, // over: silent
  auth_start_ip: { capacity: 20, per_ms: 3_600_000 },
  auth_start_global: { capacity: 500, per_ms: 3_600_000 },
  auth_verify_ip: { capacity: 10, per_ms: 10 * 60_000 },
  auth_verify_email: { capacity: 10, per_ms: 15 * 60_000 },   // every verify attempt; empty = that email is locked out
  signup_ip: { capacity: 10, per_ms: 86_400_000 },            // new users per IP
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

  /** → {ok:true} or {ok:false, retry_after_ms}. */
  take(rule, key) {
    const lim = this.limits[rule];
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

/** Take one token or throw RATE_LIMITED with retry_after_s (HTTP routes and runner RPCs). */
export function limitOrThrow(hub, rule, key) {
  const r = hub.limiter.take(rule, key);
  if (!r.ok) {
    const s = Math.max(1, Math.ceil(r.retry_after_ms / 1000));
    throw new HubError('RATE_LIMITED', `too many requests; retry in ${s} s`, { retry_after_s: s });
  }
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
