// Remote interaction relay (accounts mode only). A signed-in Plexiform on one
// device reaches a Plexiform-owned session on another device of the SAME
// account: client --HTTPS--> hub --WS--> host device's interaction hub.
//
// Identity is only what accounts mode already issues: per-install desktop
// device tokens (`bdt_`, user_devices). The host socket and every client call
// authenticate with one; no new credential, no provider login. The hub
// routes a call only to a live host device of the caller's own user, stamps
// the frame with that user and the calling device (never taken from the
// body), and re-checks both credentials before forwarding and before
// answering, so a revoked device is cut off at once. The host pins its own
// user and enforces the session contract (session/generation/turn
// staleness, actor binding) itself.
//
// The hub keeps no conversation content: text and responses pass through in
// memory and are never logged or cached (the generic request_id response
// cache is off for these routes; replays are refused instead).

import { randomUUID } from 'node:crypto';
import { HubError } from './db.js';
import { WS_CLOSE } from '../shared/protocol.js';

export const INTERACTION_WS_PATH = '/ws/interaction-host';
export const RELAY_OPS = Object.freeze(['capabilities', 'list', 'state', 'launch', 'send', 'interrupt', 'close', 'watch']);
export const RELAY_LIMITS = Object.freeze({
  argsBytes: 16 * 1024, replyBytes: 768 * 1024, timeoutMs: 25_000, pendingPerHost: 32,
  replayTtlMs: 10 * 60_000, replayPerUser: 4096,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).every((k) => keys.includes(k));
const invalid = () => new HubError('VALIDATION', 'invalid interaction request');
// Offline, foreign, revoked and unknown hosts all look the same: no oracle.
const noHost = () => new HubError('NOT_FOUND', 'that device is not available');

export class InteractionRelay {
  constructor(hub, limits = {}) {
    this.hub = hub;
    this.limits = { ...RELAY_LIMITS, ...limits };
    this.hosts = new Map(); // user_devices.id -> host
    this.seen = new Map();  // user id -> Map(request_id -> expires at, hub mono ms)
  }

  credValid(cred) {
    try { return this.hub.accounts.credValid(cred) === true; } catch { return false; }
  }

  /** After the upgrade authenticated a desktop device token. Newest connection of a device wins. */
  attach(ws, { user, cred }) {
    const prior = this.hosts.get(cred.id);
    if (prior) this.drop(prior, WS_CLOSE.REPLACED, 'replaced by a newer connection');
    const host = { ws, userId: user.id, cred: { kind: cred.kind, id: cred.id }, pending: new Map(), closed: false };
    this.hosts.set(cred.id, host);
    ws.on('message', (data, isBinary) => this.onFrame(host, data, isBinary));
    ws.on('close', () => this.drop(host));
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'relay.welcome', user: user.id, device: cred.id }));
  }

  drop(host, code = null, reason = '') {
    if (host.closed) return;
    host.closed = true;
    if (this.hosts.get(host.cred.id) === host) this.hosts.delete(host.cred.id);
    for (const p of host.pending.values()) { clearTimeout(p.timer); p.reject(noHost()); }
    host.pending.clear();
    if (code) { try { host.ws.close(code, reason); } catch { /* gone */ } }
  }

  /** From hub.closeCredSockets: a revoked or signed-out device stops hosting now. */
  closeCred(cred, reason = 'device revoked') {
    const host = this.hosts.get(cred?.id);
    if (host && host.cred.kind === cred.kind) this.drop(host, WS_CLOSE.UNAUTHENTICATED, reason);
  }

  onFrame(host, data, isBinary) {
    if (host.closed) return;
    let f;
    try { if (isBinary) throw invalid(); f = JSON.parse(String(data)); } catch { return this.drop(host, 1008, 'bad frame'); }
    if (!closed(f, ['type', 'id', 'result']) || f.type !== 'relay.reply' || typeof f.id !== 'string' || !object(f.result)) return this.drop(host, 1008, 'bad frame');
    const p = host.pending.get(f.id);
    if (!p) return; // late reply after a timeout: dropped
    host.pending.delete(f.id);
    clearTimeout(p.timer);
    if (Buffer.byteLength(String(data)) > this.limits.replyBytes) return p.reject(new HubError('PAYLOAD_TOO_LARGE', 'the device answer is too large'));
    p.resolve(f.result);
  }

  liveHost(userId, hostId) {
    const host = typeof hostId === 'string' ? this.hosts.get(hostId) : null;
    if (!host || host.closed || host.userId !== userId) return null;
    if (!this.credValid(host.cred)) { this.drop(host, WS_CLOSE.UNAUTHENTICATED, 'device revoked'); return null; }
    return host;
  }

  hostsFor(ident) {
    if (ident?.cred?.kind !== 'device') throw new HubError('FORBIDDEN', 'remote sessions need the desktop app');
    const out = [];
    for (const [id, host] of this.hosts) {
      if (!this.liveHost(ident.user.id, id)) continue;
      const d = this.hub.db.get('SELECT name, platform FROM user_devices WHERE id = ?', id);
      out.push({ id, name: d?.name ?? 'Device', platform: d?.platform ?? null, current: id === ident.cred.id });
    }
    return { hosts: out };
  }

  // Replays are refused, not answered from a cache: a send is never repeated
  // and its earlier answer (which carries text) is never stored here.
  replayed(userId, rid) {
    const t = this.hub.mono();
    let m = this.seen.get(userId);
    if (!m) { m = new Map(); this.seen.set(userId, m); }
    for (const [k, exp] of m) { if (exp > t) break; m.delete(k); }
    if (m.has(rid)) return true;
    m.set(rid, t + this.limits.replayTtlMs);
    while (m.size > this.limits.replayPerUser) m.delete(m.keys().next().value);
    return false;
  }

  async call(ident, hostId, body) {
    if (ident?.cred?.kind !== 'device') throw new HubError('FORBIDDEN', 'remote sessions need the desktop app');
    if (!closed(body, ['request_id', 'op', 'args']) || typeof body.request_id !== 'string' || !UUID.test(body.request_id)
      || !RELAY_OPS.includes(body.op) || (body.args !== undefined && !object(body.args))) throw invalid();
    const args = body.args ?? {};
    if (Buffer.byteLength(JSON.stringify(args)) > this.limits.argsBytes) throw new HubError('PAYLOAD_TOO_LARGE', 'message too large');
    const host = this.liveHost(ident.user.id, hostId);
    if (!host) throw noHost();
    if (this.replayed(ident.user.id, body.request_id)) throw new HubError('CONFLICT', 'This request was already sent. Refresh and try again.', { reason: 'REPLAYED' });
    if (host.pending.size >= this.limits.pendingPerHost) throw new HubError('RATE_LIMITED', 'that device is busy; try again shortly', { retry_after_s: 1 });
    const id = randomUUID();
    const frame = { type: 'relay.request', id, rid: body.request_id, user: ident.user.id, from: ident.cred.id, op: body.op, args };
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { host.pending.delete(id); reject(new HubError('TIMEOUT', 'that device did not answer in time')); }, this.limits.timeoutMs);
      timer.unref?.();
      host.pending.set(id, { resolve, reject, timer });
      try { host.ws.send(JSON.stringify(frame)); } catch { clearTimeout(timer); host.pending.delete(id); reject(noHost()); }
    });
    // Revoked while the device was answering: the answer is not delivered.
    if (!this.credValid(ident.cred)) throw new HubError('UNAUTHENTICATED', 'device token unknown or revoked: sign in again');
    if (!this.liveHost(ident.user.id, hostId)) throw noHost();
    return { host: hostId, result };
  }

  routes(route) {
    route('GET', '/api/interaction/v1/hosts', ({ ident }) => this.hostsFor(ident), { auth: 'user', replay: false });
    route('POST', '/api/interaction/v1/hosts/:host_id/call', ({ ident, params, body }) => this.call(ident, params.host_id, body), { auth: 'user', replay: false, strictBody: true, maxBody: this.limits.argsBytes + 1024 });
  }

  close() {
    for (const host of [...this.hosts.values()]) this.drop(host, WS_CLOSE.HUB_SHUTDOWN, 'hub shutting down');
    this.seen.clear();
  }
}
