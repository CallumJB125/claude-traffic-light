// Abuse limits (CONTRACT §5.2, §5.3, §6.1): token buckets per member and per
// client IP for logins and mutations, and per connection for WS frames. They
// run on the hub monotonic clock, so tests drive them with the fake clock.

import { isIPv6 } from 'node:net'; // privacy-flow: hub-server
import { isLoopback } from './config.js';
import { HubError } from './db.js';

// {capacity, per_ms}: at most `capacity` at once, refilled at capacity/per_ms.
export const DEFAULT_LIMITS = Object.freeze({
  login_ip: { capacity: 10, per_ms: 60_000 },
  mutate_ip: { capacity: 300, per_ms: 60_000 },
  mutate_member: { capacity: 120, per_ms: 60_000 },
  dispatch_member: { capacity: 30, per_ms: 60_000 },   // dispatch, retry, take_over_with_claude
  presence_member: { capacity: 60, per_ms: 60_000 },   // GET /api/boards/:id/presence (D37b)
  agent_card_member: { capacity: 20, per_ms: 3_600_000 },    // board_create_card, per member the runs are for
  agent_lesson_member: { capacity: 30, per_ms: 3_600_000 },  // board_add_lesson, per member the runs are for
  webhook_conn: { capacity: 600, per_ms: 60_000 },          // inbound webhooks, per connection
  integration_conn: { capacity: 120, per_ms: 60_000 },      // actAs calls, per connection (never mutate_member)
  integration_card_conn: { capacity: 20, per_ms: 3_600_000 }, // actAs().createCard, per connection
  webhook_fail_ip: { capacity: 30, per_ms: 60_000 },        // failed webhook deliveries, per connection + client IP (/64)
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
// and from a loopback peer (cloudflared), never from a direct connection.
export function clientIp(req, config) {
  const peer = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  const cf = config.auth === 'access' && isLoopback(peer) ? req.headers['cf-connecting-ip'] : null;
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
