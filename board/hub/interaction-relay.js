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
//
// Roles (user_devices.interaction_role, migration 048): a device is either a
// 'client' (default) or a 'host', set only by the device itself through PUT
// /api/interaction/v1/role after an explicit opt-in in its app. Only a host
// device may open the host socket (checked at the upgrade and on every
// route); only a client device may list or call hosts. A stolen client token
// therefore cannot pose as another device's host, and a host token cannot
// drive other hosts.
//
// Replacement rule: while a host socket is live, a new connection for the
// same device is refused (409) unless it presents the resume nonce the hub
// gave the live connection in its welcome (only the real host has it; it is
// fresh for every connection and never stored). A refused attempt is told to
// the live host (relay.notice) and the hub pings the live socket; if it does
// not answer within probeMs it is dropped, so a host whose old socket died
// half-open gets back in on its next retry. A replaced socket is closed with
// 4409 REPLACED, which the host shows instead of retrying.

import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { HubError } from './db.js';
import { WS_CLOSE } from '../shared/protocol.js';

export const INTERACTION_WS_PATH = '/ws/interaction-host';
export const RELAY_OPS = Object.freeze(['capabilities', 'list', 'state', 'launch', 'send', 'interrupt', 'close', 'watch']);
export const RELAY_LIMITS = Object.freeze({
  argsBytes: 16 * 1024, replyBytes: 768 * 1024, timeoutMs: 25_000, pendingPerHost: 32,
  // Shared-session calls (interaction-shares.js): all teammates together, and each one.
  sharedPendingPerHost: 16, pendingPerTeammate: 4,
  replayTtlMs: 10 * 60_000, replayPerUser: 4096, probeMs: 5_000,
});
export const RESUME_HEADER = 'x-plexiform-resume';
// Ops whose effect may have happened even when the device's answer is lost.
const MUTATING = new Set(['launch', 'send', 'interrupt', 'close']);
const ROLES = ['client', 'host'];
// Platforms the desktop app reports at sign-in (`${process.platform}-${arch}`,
// or the bare platform). Only these may host: the phone ('phone-web') and any
// other client are callers only. Self-declared at sign-in, so this narrows a
// phone token's reach; it is not proof of a desktop (PHONE.md, host proof-of-possession).
const HOST_PLATFORM = /^(darwin|win32|linux)(-[a-z0-9_]{1,20})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).every((k) => keys.includes(k));
const invalid = () => new HubError('VALIDATION', 'invalid interaction request');
// Offline, foreign, revoked and unknown hosts all look the same: no oracle.
const noHost = () => new HubError('NOT_FOUND', 'that device is not available');
const outcomeUnknown = (why) => new HubError('TIMEOUT', `${why} The outcome is unknown: check the session state before trying again.`, { reason: 'OUTCOME_UNKNOWN' });
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

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

  role(deviceId) {
    return this.hub.db.get('SELECT interaction_role AS r FROM user_devices WHERE id = ?', deviceId)?.r ?? null;
  }

  /**
   * At the upgrade, after a desktop device token authenticated: null to go
   * ahead, or [status, text] to refuse. See the replacement rule above.
   */
  admit({ cred }, headers = {}) {
    if (this.role(cred.id) !== 'host') return [403, 'Forbidden'];
    const live = this.hosts.get(cred.id);
    if (!live || live.closed) return null;
    if (sameSecret(headers[RESUME_HEADER], live.resume)) return null;
    try { live.ws.send(JSON.stringify({ type: 'relay.notice', kind: 'replace-refused' })); } catch { /* gone */ }
    this.probe(live);
    return [409, 'Conflict'];
  }

  probe(host) {
    if (host.probing) return;
    host.probing = setTimeout(() => this.drop(host, 1001, 'no answer'), this.limits.probeMs);
    host.probing.unref?.();
    try { host.ws.ping(); } catch { this.drop(host); }
  }

  /** After admit(). Only a resumed connection of the same device replaces a live one. */
  attach(ws, { user, cred }, headers = {}) {
    // Re-checked: another connection may have attached while this one upgraded.
    if (this.admit({ cred }, headers)) { try { ws.close(1008, 'another connection is live'); } catch { /* gone */ } return; }
    const prior = this.hosts.get(cred.id);
    if (prior) this.drop(prior, WS_CLOSE.REPLACED, 'replaced by a newer connection');
    const host = { ws, userId: user.id, cred: { kind: cred.kind, id: cred.id }, pending: new Map(), closed: false, resume: randomBytes(24).toString('base64url'), probing: null };
    this.hosts.set(cred.id, host);
    ws.on('message', (data, isBinary) => this.onFrame(host, data, isBinary));
    ws.on('pong', () => { clearTimeout(host.probing); host.probing = null; });
    ws.on('close', () => this.drop(host));
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'relay.welcome', user: user.id, device: cred.id, resume: host.resume }));
  }

  drop(host, code = null, reason = '') {
    if (host.closed) return;
    host.closed = true;
    clearTimeout(host.probing);
    if (this.hosts.get(host.cred.id) === host) this.hosts.delete(host.cred.id);
    // A mutating op already on the wire may have happened: say the outcome is
    // unknown (its request_id stays used). A read just failed: free its id.
    for (const p of host.pending.values()) { clearTimeout(p.timer); p.lost(); }
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
    if (this.role(host.cred.id) !== 'host') { this.drop(host, WS_CLOSE.NORMAL, 'hosting turned off'); return null; }
    return host;
  }

  asClient(ident) {
    if (ident?.cred?.kind !== 'device') throw new HubError('FORBIDDEN', 'remote sessions need the desktop app');
    if (this.role(ident.cred.id) !== 'client') throw new HubError('FORBIDDEN', 'this device offers its sessions to your other devices; use one of those');
  }

  // A hosting desktop can also use another owner's explicitly shared session.
  // Own-device remote control retains the stricter asClient role boundary.
  asSharedClient(ident) {
    if (ident?.cred?.kind !== 'device') throw new HubError('FORBIDDEN', 'shared sessions need the desktop app');
    if (!this.credValid(ident.cred)) throw new HubError('UNAUTHENTICATED', 'device token unknown or revoked: sign in again');
  }

  /** PUT role: the calling device's own role, nothing else's. */
  setRole(ident, body) {
    if (ident?.cred?.kind !== 'device') throw new HubError('FORBIDDEN', 'remote sessions need the desktop app');
    if (!closed(body, ['role']) || !ROLES.includes(body.role)) throw invalid();
    if (body.role === 'host') {
      const platform = this.hub.db.get('SELECT platform FROM user_devices WHERE id = ?', ident.cred.id)?.platform;
      if (typeof platform !== 'string' || !HOST_PLATFORM.test(platform)) throw new HubError('FORBIDDEN', 'only the desktop app can share its sessions');
    }
    this.hub.db.run('UPDATE user_devices SET interaction_role = ? WHERE id = ? AND revoked_at IS NULL', body.role, ident.cred.id);
    const live = this.hosts.get(ident.cred.id);
    if (body.role !== 'host' && live) this.drop(live, WS_CLOSE.NORMAL, 'hosting turned off');
    return { role: body.role };
  }

  hostsFor(ident) {
    this.asClient(ident);
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
  // Marks rid as used only when it is dispatched (a 429 or an offline host
  // leaves it free to retry); never answered from a cache.
  replayed(userId, rid) {
    const t = this.hub.mono();
    this.sweep(t);
    let m = this.seen.get(userId);
    if (!m) { m = new Map(); this.seen.set(userId, m); }
    if (m.has(rid)) return true;
    m.set(rid, t + this.limits.replayTtlMs);
    while (m.size > this.limits.replayPerUser) m.delete(m.keys().next().value);
    return false;
  }

  sweep(t) {
    for (const [u, m] of this.seen) {
      for (const [k, exp] of m) { if (exp > t) break; m.delete(k); }
      if (!m.size) this.seen.delete(u);
    }
  }

  unburn(userId, rid) {
    const m = this.seen.get(userId);
    m?.delete(rid);
    if (m && !m.size) this.seen.delete(userId);
  }

  async call(ident, hostId, body) {
    this.asClient(ident);
    if (!closed(body, ['request_id', 'op', 'args']) || typeof body.request_id !== 'string' || !UUID.test(body.request_id)
      || !RELAY_OPS.includes(body.op) || (body.args !== undefined && !object(body.args))) throw invalid();
    const args = body.args ?? {};
    if (Buffer.byteLength(JSON.stringify(args)) > this.limits.argsBytes) throw new HubError('PAYLOAD_TOO_LARGE', 'message too large');
    const host = this.liveHost(ident.user.id, hostId);
    if (!host) throw noHost();
    if (host.pending.size >= this.limits.pendingPerHost) throw new HubError('RATE_LIMITED', 'that device is busy; try again shortly', { retry_after_s: 1 });
    if (this.replayed(ident.user.id, body.request_id)) throw new HubError('CONFLICT', 'This request was already sent. Refresh and try again.', { reason: 'REPLAYED' });
    const frame = { type: 'relay.request', rid: body.request_id, user: ident.user.id, from: ident.cred.id, op: body.op, args };
    const result = await this.dispatch(host, frame, () => this.unburn(ident.user.id, body.request_id));
    // Revoked while the device was answering: the answer is not delivered.
    if (!this.credValid(ident.cred)) throw new HubError('UNAUTHENTICATED', 'device token unknown or revoked: sign in again');
    if (!this.liveHost(ident.user.id, hostId)) throw noHost();
    return { host: hostId, result };
  }

  /** One frame to a live host → its result. `unsent` runs when it never left the hub. */
  dispatch(host, frame, unsent = () => {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.pending.delete(id);
        // A send the device finishes after this is not a failure: say so.
        reject(MUTATING.has(frame.op) ? outcomeUnknown('That device did not answer in time.') : new HubError('TIMEOUT', 'that device did not answer in time'));
      }, this.limits.timeoutMs);
      timer.unref?.();
      const lost = () => {
        if (MUTATING.has(frame.op)) return reject(outcomeUnknown('The connection to that device dropped.'));
        unsent();
        reject(noHost());
      };
      host.pending.set(id, { resolve, reject, timer, lost, by: frame.share?.user ?? null });
      try { host.ws.send(JSON.stringify({ type: frame.type, id, ...frame })); } catch { clearTimeout(timer); host.pending.delete(id); unsent(); reject(noHost()); }
    });
  }

  routes(route) {
    route('PUT', '/api/interaction/v1/role', ({ ident, body }) => this.setRole(ident, body), { auth: 'user', replay: false, strictBody: true });
    route('GET', '/api/interaction/v1/hosts', ({ ident }) => this.hostsFor(ident), { auth: 'user', replay: false });
    route('POST', '/api/interaction/v1/hosts/:host_id/call', ({ ident, params, body }) => this.call(ident, params.host_id, body), { auth: 'user', replay: false, strictBody: true, maxBody: this.limits.argsBytes + 1024 });
  }

  close() {
    for (const host of [...this.hosts.values()]) this.drop(host, WS_CLOSE.HUB_SHUTDOWN, 'hub shutting down');
    this.seen.clear();
  }
}
