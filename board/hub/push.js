// Phone push (W2-B; docs/PHONE-RUNBOOK.md, PRIVACY.md flow:phone-push).
// REQUIRES INDEPENDENT SECURITY REVIEW before release.
//
// A phone's Web Push subscription is stored per phone sign-in (migration
// 061): only the push service's endpoint address. When one of the user's
// computers says a request is waiting (approval-relay.js ping), the hub POSTs
// an EMPTY message to each endpoint, signed with the operator's VAPID key
// (RFC 8292). No payload means nothing to encrypt and nothing for Apple,
// Google, Mozilla or Microsoft to read: they learn only that this endpoint
// got a ping, and when. The phone then fetches what is waiting through the
// end-to-end relay. Off unless BOARD_PUSH_VAPID_* are set (owner-gated).
//
// Endpoints are the push services' own addresses only (PUSH_HOSTS), https,
// no credentials, no redirects followed: a phone can't point the hub at
// anything else.

import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { HubError } from './db.js';

// The browsers' push services. A subscription naming any other host is refused.
export const PUSH_HOSTS = Object.freeze(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', '.push.apple.com', '.notify.windows.com']);
export const PUSH_LIMITS = Object.freeze({ perUser: 10, timeoutMs: 10_000, ttlS: 60, jwtS: 12 * 3600 });

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).every((k) => keys.includes(k));

/** VAPID keys from the hub env: public = base64url raw P-256 point (65 bytes), private = base64url scalar (32 bytes). */
export function vapidKey({ publicKey, privateKey }) {
  const pub = Buffer.from(String(publicKey ?? ''), 'base64url');
  const d = Buffer.from(String(privateKey ?? ''), 'base64url');
  if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) throw new Error('BOARD_PUSH_VAPID_PUBLIC_KEY / _PRIVATE_KEY are not a P-256 key pair (base64url raw point and scalar)');
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
  return { key, publicKey: b64u(pub) };
}

export class PushService {
  constructor(hub, { fetchImpl, hosts = PUSH_HOSTS, allowHttp = false, limits = {} } = {}) {
    this.hub = hub;
    this.fetch = fetchImpl;
    this.hosts = hosts;
    this.allowHttp = allowHttp;
    this.limits = { ...PUSH_LIMITS, ...limits };
    const c = hub.config;
    this.vapid = c.pushVapidPublicKey && c.pushVapidPrivateKey && c.pushVapidSubject
      ? { ...vapidKey({ publicKey: c.pushVapidPublicKey, privateKey: c.pushVapidPrivateKey }), subject: c.pushVapidSubject } : null;
  }

  get configured() { return !!this.vapid; }
  get db() { return this.hub.db; }

  requireConfigured() {
    if (!this.vapid) throw new HubError('METHOD_DISABLED', 'push notifications are not set up on this hub');
  }

  endpointOk(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length < 12 || endpoint.length > 1024) return false;
    let u;
    try { u = new URL(endpoint); } catch { return false; }
    if (u.username || u.password || u.hash) return false;
    if (u.protocol !== 'https:' && !(this.allowHttp && u.protocol === 'http:')) return false;
    const host = u.hostname.toLowerCase();
    return this.hosts.some((h) => (h.startsWith('.') ? host.endsWith(h) && host.length > h.length : host === h));
  }

  key() {
    this.requireConfigured();
    return { publicKey: this.vapid.publicKey };
  }

  /** PUT: the calling device's own subscription (one per device), replaced in place. */
  subscribe(ident, body) {
    this.requireConfigured();
    if (ident?.cred?.kind !== 'device') throw new HubError('FORBIDDEN', 'push needs the phone app');
    if (!closed(body, ['endpoint']) || !this.endpointOk(body.endpoint)) throw new HubError('VALIDATION', 'that is not a push subscription this hub accepts');
    const have = this.db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ? AND device_id != ?', ident.user.id, ident.cred.id).n;
    if (have >= this.limits.perUser) throw new HubError('QUOTA_EXCEEDED', 'too many devices get notifications; remove one first', { resource: 'push_subscriptions', limit: this.limits.perUser });
    this.db.run(`INSERT INTO push_subscriptions (device_id, user_id, endpoint, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET endpoint = excluded.endpoint, created_at = excluded.created_at, last_ok_at = NULL`, ident.cred.id, ident.user.id, body.endpoint, this.hub.iso());
    return { ok: true };
  }

  unsubscribe(ident) {
    if (ident?.cred?.kind !== 'device') throw new HubError('FORBIDDEN', 'push needs the phone app');
    this.db.run('DELETE FROM push_subscriptions WHERE device_id = ? AND user_id = ?', ident.cred.id, ident.user.id);
    return { ok: true };
  }

  jwt(audience) {
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(this.hub.wallMs() / 1000) + this.limits.jwtS, sub: this.vapid.subject }));
    const sig = cryptoSign('sha256', Buffer.from(`${head}.${claims}`), { key: this.vapid.key, dsaEncoding: 'ieee-p1363' });
    return `${head}.${claims}.${b64u(sig)}`;
  }

  /** An empty push to each live subscription of this user (never the caller's own device). → {sent, failed} */
  async ping(userId, { except = null } = {}) {
    if (!this.vapid) return { sent: 0, failed: 0 };
    const subs = this.db.all(`SELECT p.device_id, p.endpoint FROM push_subscriptions p JOIN user_devices d ON d.id = p.device_id
      WHERE p.user_id = ? AND d.user_id = p.user_id AND d.revoked_at IS NULL`, userId).filter((s) => s.device_id !== except);
    let sent = 0, failed = 0;
    for (const s of subs) {
      if (!this.endpointOk(s.endpoint)) { this.db.run('DELETE FROM push_subscriptions WHERE device_id = ?', s.device_id); continue; }
      let status = 0;
      try {
        const res = await this.fetch(s.endpoint, { // privacy-flow: phone-push
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(this.limits.timeoutMs),
          headers: { authorization: `vapid t=${this.jwt(new URL(s.endpoint).origin)}, k=${this.vapid.publicKey}`, ttl: String(this.limits.ttlS), urgency: 'high', topic: 'needs-you', 'content-length': '0' },
        });
        status = res.status;
      } catch { status = 0; }
      if (status >= 200 && status < 300) { sent++; this.db.run('UPDATE push_subscriptions SET last_ok_at = ? WHERE device_id = ?', this.hub.iso(), s.device_id); }
      else {
        failed++;
        // Gone at the push service: forget it (the phone subscribes again when it next opens).
        if (status === 404 || status === 410) this.db.run('DELETE FROM push_subscriptions WHERE device_id = ?', s.device_id);
      }
    }
    return { sent, failed };
  }

  routes(route) {
    route('GET', '/api/push/v1/key', () => this.key(), { auth: 'user', replay: false });
    route('PUT', '/api/push/v1/subscription', ({ ident, body }) => this.subscribe(ident, body), { auth: 'user', replay: false, strictBody: true, maxBody: 2048 });
    route('DELETE', '/api/push/v1/subscription', ({ ident }) => this.unsubscribe(ident), { auth: 'user', replay: false });
  }
}
