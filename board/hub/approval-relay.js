// Phone approvals relay (W2-B; remote/THREAT_MODEL.md, docs/PHONE-RUNBOOK.md).
// REQUIRES INDEPENDENT SECURITY REVIEW before release.
//
// Two routes, both thin:
//
//   POST /api/approvals/v1/hosts/:host_id/call   phone → one of its computers
//     Approval and task ops travel ONLY as W2-A envelopes (`enc`, opaque
//     here: shape check only); a plaintext body for them is refused. Pairing
//     steps are the one plaintext exception: they exist before any shared
//     key, and are protected end to end by the QR secret's MAC and both
//     sides' signatures (remote/src/pairing.js), so the hub can relay or
//     drop them but not forge or alter them. Routing, replay refusal,
//     revocation re-checks and timeouts are the interaction relay's
//     (interaction-relay.js forward()).
//
//   POST /api/approvals/v1/ping                  computer → hub
//     "Something is waiting": no request id, no content. The hub sends an
//     empty Web Push to the user's phones (push.js). Rate-limited per user;
//     only a computer that shares its sessions (host role, full sign-in) may
//     ask; on a hub that sells plans, only for a paid account.
//
// The hub never decides anything and never answers a permission request:
// decisions are signed by the phone, carry a passkey assertion, are sealed
// for the computer and are judged there (RemoteApprovals.handleDecision).
// Nothing in board/hub writes `.answer` files (THREAT_MODEL §9.3; tested).

import { HubError } from './db.js';
import { encShapeOk } from './interaction-relay.js';

export const APPROVAL_OPS = Object.freeze(['hello', 'approvals.list', 'approvals.decide', 'approvals.passkey', 'tasks.start']);
export const PAIR_OPS = Object.freeze(['pair.init', 'pair.reveal', 'pair.poll']);
export const APPROVAL_LIMITS = Object.freeze({ pairArgsBytes: 4096, pingMinMs: 5_000, pingsPerHour: 120 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => object(v) && Object.keys(v).every((k) => keys.includes(k));
const invalid = () => new HubError('VALIDATION', 'invalid approval request');

export class ApprovalRelay {
  constructor(hub, relay, push, limits = {}) {
    this.hub = hub;
    this.relay = relay;
    this.push = push;
    this.limits = { ...APPROVAL_LIMITS, ...limits };
    this.pings = new Map(); // user id -> {last, times: [mono ms]}
  }

  async call(ident, hostId, body) {
    this.relay.asClient(ident);
    if (!closed(body, ['request_id', 'op', 'args', 'enc']) || typeof body.request_id !== 'string' || !UUID.test(body.request_id)) throw invalid();
    if (APPROVAL_OPS.includes(body.op)) {
      // End to end only: a plaintext approval, decision or task is never relayed.
      if (body.args !== undefined || !encShapeOk(body.enc)) throw invalid();
      return this.relay.forward(ident, hostId, body.request_id, body.op, { enc: body.enc });
    }
    if (PAIR_OPS.includes(body.op)) {
      if (body.enc !== undefined || !object(body.args) || Buffer.byteLength(JSON.stringify(body.args)) > this.limits.pairArgsBytes) throw invalid();
      return this.relay.forward(ident, hostId, body.request_id, body.op, { args: body.args });
    }
    throw invalid();
  }

  async ping(ident, body) {
    if (!closed(body, [])) throw invalid();
    if (ident?.cred?.kind !== 'device' || ident.cred.scope === 'relay' || this.relay.role(ident.cred.id) !== 'host') {
      throw new HubError('FORBIDDEN', 'only a computer that shares its sessions can notify your phone');
    }
    if (this.hub.billing?.configured && !this.hub.billing.effective(ident.user.id)) {
      throw new HubError('PLAN_REQUIRED', 'Phone approvals need Plexiform Plus', { feature: 'phone', plan: 'plus' });
    }
    const t = this.hub.mono();
    let p = this.pings.get(ident.user.id);
    if (!p) { p = { last: -Infinity, times: [] }; this.pings.set(ident.user.id, p); }
    p.times = p.times.filter((x) => t - x < 3_600_000);
    // A burst of requests is one ping: the phone fetches everything waiting.
    if (t - p.last < this.limits.pingMinMs) return { ok: true, sent: 0, coalesced: true };
    if (p.times.length >= this.limits.pingsPerHour) throw new HubError('RATE_LIMITED', 'too many phone notifications; try again later', { retry_after_s: 60 });
    p.last = t;
    p.times.push(t);
    const r = await this.push.ping(ident.user.id, { except: ident.cred.id });
    return { ok: true, sent: r.sent };
  }

  routes(route) {
    const callMax = Math.ceil((this.relay.limits.argsBytes + 64) * 4 / 3) + 1024;
    route('POST', '/api/approvals/v1/hosts/:host_id/call', ({ ident, params, body }) => this.call(ident, params.host_id, body), { auth: 'user', replay: false, strictBody: true, maxBody: callMax });
    route('POST', '/api/approvals/v1/ping', ({ ident, body }) => this.ping(ident, body), { auth: 'user', replay: false, strictBody: true, maxBody: 256 });
  }
}
