// Abuse limits (CONTRACT §5.2, §5.3, §6.1): token buckets per member and per
// client IP for logins and mutations, and per connection for WS frames. They
// run on the hub monotonic clock, so tests drive them with the fake clock.

import { isLoopback } from './config.js';

// {capacity, per_ms}: at most `capacity` at once, refilled at capacity/per_ms.
export const DEFAULT_LIMITS = Object.freeze({
  login_ip: { capacity: 10, per_ms: 60_000 },
  mutate_ip: { capacity: 300, per_ms: 60_000 },
  mutate_member: { capacity: 120, per_ms: 60_000 },
  dispatch_member: { capacity: 30, per_ms: 60_000 },   // dispatch, retry, take_over_with_claude
  presence_member: { capacity: 60, per_ms: 60_000 },   // GET /api/boards/:id/presence (D37b)
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

  sweep() {
    const now = this.now();
    for (const [k, b] of this.buckets) if (now - b.at > IDLE_SWEEP_MS) this.buckets.delete(k);
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
