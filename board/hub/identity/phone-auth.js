// Phone sign-in reuses browser OAuth, then issues only a relay-scoped device.
// The phone keeps its PKCE verifier. No device token travels through a URL.
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { HubError } from '../db.js';
import { safeEqual } from '../auth.js';
import { limitOrThrow, ipKey } from '../ratelimit.js';
const TTL = 5 * 60000;
const ID = /^[A-Za-z0-9_-]{32}$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/;
const closed = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).every((k) => keys.includes(k));
const invalid = () => new HubError('INVALID_TOKEN', 'phone sign-in expired or invalid; start again');
export class PhoneAuth {
  constructor(hub) { this.hub = hub; this.flows = new Map(); }
  sweep() { for (const [id, f] of this.flows) if (f.expires <= this.hub.wallMs()) this.flows.delete(id); }
  get(id) { this.sweep(); if (!ID.test(id) || !this.flows.has(id)) throw invalid(); return this.flows.get(id); }
  start(body, { ip }) {
    if (!closed(body, ['challenge']) || !PROOF.test(body.challenge)) throw invalid();
    limitOrThrow(this.hub, 'phone_start_ip', ipKey(ip)); this.sweep();
    if (this.flows.size >= 1000) throw new HubError('RATE_LIMITED', 'phone sign-in busy');
    const id = randomBytes(24).toString('base64url'); const code = String(randomInt(100000, 1000000));
    this.flows.set(id, { challenge: body.challenge, code, expires: this.hub.wallMs() + TTL, userId: null });
    return { id, code, expires_in: TTL / 1000, url: `${this.hub.config.publicUrl}/phone-connect#${id}` };
  }
  describe(id) { const f = this.get(id); return { code: f.code, approved: !!f.userId }; }
  approve(body, { ident, ip }) {
    if (!closed(body, ['id', 'code']) || ident?.cred?.kind !== 'session') throw new HubError('FORBIDDEN', 'sign in in this browser first');
    limitOrThrow(this.hub, 'phone_approve_user', ident.user.id);
    const f = this.get(body.id);
    if (!safeEqual(String(body.code), f.code) || f.userId) throw invalid();
    f.userId = ident.user.id; f.sessionId = ident.cred.id; f.epoch = this.hub.accounts.epoch();
    this.hub.accounts.audit('phone.authorize', { user: ident.user.id, target: body.id, ip });
    return { ok: true, url: `${this.hub.config.phoneOrigin || this.hub.config.publicUrl}/phone/#signin=${body.id}` };
  }
  exchange(body, { ip }) {
    if (!closed(body, ['id', 'verifier']) || !PROOF.test(body.verifier)) throw invalid();
    limitOrThrow(this.hub, 'phone_exchange_ip', ipKey(ip));
    const f = this.get(body.id);
    if (!safeEqual(createHash('sha256').update(body.verifier).digest('base64url'), f.challenge)) throw invalid();
    if (!f.userId) return { pending: true };
    if (f.epoch !== this.hub.accounts.epoch() || !this.hub.db.get('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', f.userId)) { this.flows.delete(body.id); throw invalid(); }
    const session = this.hub.db.get('SELECT * FROM sessions WHERE id = ? AND user_id = ?', f.sessionId, f.userId);
    if (!session || !this.hub.accounts.sessionLive(session)) { this.flows.delete(body.id); throw invalid(); }
    let device;
    this.hub.txn(() => { device = this.hub.accounts.issueDevice(f.userId, { name: 'Phone', platform: 'phone-web', form_factor: null, scope: 'relay' }, { ip, method: 'browser-phone' }); });
    this.flows.delete(body.id);
    return { device_token: device.token, device_id: device.id };
  }
}
