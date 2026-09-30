// The desktop's gate for remote decisions. Everything a phone sends ends up
// in handleDecision, which applies a decision only if all of these hold, in
// this order:
//   1. well-formed canonical payload, addressed to this desktop (aud)
//   2. device known and not revoked; ECDSA signature valid for its key
//   3. issuedAt/expiresAt sane (TTL ≤ 120 s, ≤ 30 s clock skew), not expired
//   4. nonce not seen before for this device (replay cache)
//   5. request still pending; sessionId, cardId, toolName match
//   6. sha256(canonical pending tool input) == signed toolInputHash
//   7. policy says this device's owner may act (owner; teammates off by default)
//   8. allow only: remote allow-list + deny-list pass → else "approve at your desk"
//   9. first-wins settle, and the hook confirms it took the answer
// Rejections before step 2 succeeds are answered unsigned (the desktop never
// signs anything for a sender it hasn't authenticated). Every outcome is
// audited in a hash chain; unauthenticated noise is rate-limited.
import { utf8 } from './encoding.js';
import { canonicalize, hashToolInput, sha256Hex } from './canonical.js';
import { verifyBytes, parseCanonical } from './keys.js';
import { decisionShapeOk, publishRequest, signResult, MAX_DECISION_TTL_MS, CLOCK_SKEW_MS } from './decision.js';
import { compileRules, DEFAULT_RULES } from './denylist.js';
import { remoteVerdict, DEFAULT_BASH_ALLOW } from './allowlist.js';
import { ReplayCache } from './replay.js';

const MAX_ENVELOPE_BYTES = 4096;
export const GENESIS_HASH = '0'.repeat(64);

// Build the "who may act" policy. The session owner always may. A teammate
// (card assignee on a runner session) only if teammate approvals are turned
// on AND they are on this desktop's own teammate list — the assignee list
// from the hub is intersected with it, never trusted alone. Off by default
// until teammate device certificates exist (THREAT_MODEL.md O1).
export function makeOwnerPolicy({ allowTeammates = false, teammates = [] } = {}) {
  const local = new Set(teammates);
  return ({ device, pending }) => {
    if (!device || typeof device.ownerId !== 'string' || !pending) return false;
    if (typeof pending.ownerId === 'string' && device.ownerId === pending.ownerId) return true;
    return allowTeammates && pending.runner === true && Array.isArray(pending.assigneeIds)
      && pending.assigneeIds.includes(device.ownerId) && local.has(device.ownerId);
  };
}
export const ownerOnly = makeOwnerPolicy();

export class RemoteApprovals {
  constructor({
    identity, registry, pending,
    authorize = ownerOnly,
    rules = DEFAULT_RULES,
    bashAllow = DEFAULT_BASH_ALLOW,
    // Per repo, off by default: may a phone approve test/build commands here?
    trustTestCommands = () => false,
    repoLabels = (p) => p.repoLabels || [],
    audit = () => {},
    auditHead = { head: GENESIS_HASH, seq: 0 },
    unverifiedAuditPerMinute = 20,
    clock = () => Date.now(),
    replay,
    maxTtlMs = MAX_DECISION_TTL_MS,
    skewMs = CLOCK_SKEW_MS,
  }) {
    Object.assign(this, { identity, registry, pending, authorize, bashAllow, trustTestCommands, repoLabels, audit, clock, maxTtlMs, skewMs, unverifiedAuditPerMinute });
    this.rules = compileRules(rules);
    this.replay = replay || new ReplayCache({ clock });
    this.chain = { seq: auditHead.seq ?? 0, head: auditHead.head ?? GENESIS_HASH };
    this.noise = { windowStart: 0, count: 0, suppressed: 0 };
    this.auditQueue = Promise.resolve();
  }

  async #verdict(p) {
    let trust = false;
    try { trust = (await this.trustTestCommands(p)) === true; } catch { trust = false; }
    return remoteVerdict(this.rules, { toolName: p.toolName, toolInput: p.toolInput, repoLabels: await this.repoLabels(p), cwd: p.cwd }, { bashAllow: this.bashAllow, trustTestCommands: trust });
  }

  // Hash-chained: each event carries seq, prevHash and hash =
  // sha256(prevHash ‖ canonical(event)). Serialised so the chain stays linear.
  #emit(event) {
    const run = this.auditQueue.then(async () => {
      const body = { ...event, seq: ++this.chain.seq, prevHash: this.chain.head };
      body.hash = await sha256Hex(this.chain.head + canonicalize(body));
      this.chain.head = body.hash;
      try { await this.audit(body); } catch { /* audit must never change the outcome */ }
      return body;
    });
    this.auditQueue = run.catch(() => {});
    return run;
  }

  // Unauthenticated rejections are capped per minute; the overflow is counted
  // and reported in the next event that gets through.
  #admitUnverified(now) {
    if (now - this.noise.windowStart >= 60000) {
      this.noise.windowStart = now;
      this.noise.count = 0;
    }
    if (this.noise.count >= this.unverifiedAuditPerMinute) { this.noise.suppressed++; return false; }
    this.noise.count++;
    return true;
  }

  // The signed notice sent to the owner's devices.
  async announce(p) {
    return publishRequest(this.identity, p, { deskOnly: await this.#verdict(p), now: this.clock() });
  }

  async handleDecision(env) {
    const now = this.clock();
    let d = null;
    let device = null;

    const finish = async (status, reason, extra = {}) => {
      const verified = !!device;
      const event = {
        type: status === 'applied' ? 'remote.decision.applied' : status === 'unknown' ? 'remote.decision.unconfirmed' : 'remote.decision.rejected',
        at: now, via: 'remote', reason: reason ?? null,
        requestId: d?.requestId ?? null, sessionId: d?.sessionId ?? null, cardId: d?.cardId ?? null,
        toolName: d?.toolName ?? null, toolInputHash: d?.toolInputHash ?? null, decision: d?.decision ?? null,
        deviceId: d?.deviceId ?? null, deviceVerified: verified, deviceName: device?.name ?? null, ownerId: device?.ownerId ?? null,
        // The signed decision itself, as evidence (payload carries no tool input).
        envelope: verified ? { payload: env.payload, sig: env.sig } : null,
        ...extra,
      };
      if (!verified && !this.#admitUnverified(now)) return { status, reason: reason ?? null, body: { unsigned: true, status, reason: reason ?? null }, event: null };
      if (this.noise.suppressed) { event.suppressedUnverified = this.noise.suppressed; this.noise.suppressed = 0; }
      const logged = await this.#emit(event);
      const body = verified
        ? await signResult(this.identity, { deviceId: d.deviceId, requestId: d.requestId, nonce: d.nonce, status, decision: d.decision, reason: reason ?? null, now })
        : { unsigned: true, status, reason: reason ?? null };
      return { status, reason: reason ?? null, body, event: logged };
    };
    const reject = (reason, extra) => finish('rejected', reason, extra);

    if (!env || env.v !== 1 || env.kind !== 'decision' || typeof env.payload !== 'string' || typeof env.sig !== 'string') return reject('malformed');
    if (utf8(env.payload).length > MAX_ENVELOPE_BYTES) return reject('malformed');
    const parsed = parseCanonical(env.payload);
    if (!parsed || !decisionShapeOk(parsed)) return reject('malformed');
    d = parsed;
    if (d.aud !== this.identity.desktopId) return reject('wrong-audience');

    const active = await this.registry.activeKey(d.deviceId);
    if (!active) return reject((await this.registry.get(d.deviceId)) ? 'revoked' : 'unknown-device');
    if (!(await verifyBytes(active.key, env.sig, utf8(env.payload)))) return reject('bad-signature');
    device = active.record;

    if (d.expiresAt <= d.issuedAt || d.expiresAt - d.issuedAt > this.maxTtlMs) return reject('bad-expiry');
    if (d.issuedAt > now + this.skewMs) return reject('not-yet-valid');
    if (d.expiresAt <= now) return reject('expired');

    const seen = this.replay.checkAndRecord(d.deviceId, d.nonce, d.expiresAt + this.skewMs);
    if (seen !== 'ok') return reject(seen === 'replay' ? 'replay' : 'replay-cache-full');

    const pendingReq = await this.pending.get(d.requestId);
    if (!pendingReq) return reject('no-such-request');
    if (pendingReq.sessionId !== d.sessionId || (pendingReq.cardId ?? null) !== d.cardId || pendingReq.toolName !== d.toolName) return reject('request-mismatch');
    let hash;
    try { hash = await hashToolInput(pendingReq.toolInput); } catch { return reject('uncanonical-input'); }
    if (hash !== d.toolInputHash) return reject('hash-mismatch');

    let allowed = false;
    try {
      const a = await this.authorize({ device, pending: pendingReq, decision: d.decision });
      allowed = a === true || (a && typeof a === 'object' && a.ok === true);
    } catch { allowed = false; }
    if (!allowed) return reject('not-authorized');

    if (d.decision === 'allow') {
      let v;
      try { v = await this.#verdict(pendingReq); } catch { v = { blocked: true, ruleId: 'check-failed', reason: 'could not check this input' }; }
      if (v.blocked) return reject('approve-at-desk', { ruleId: v.ruleId, ruleReason: v.reason });
    }

    const outcome = await this.pending.settle(d.requestId, d.decision, { by: 'remote', deviceId: d.deviceId, ownerId: device.ownerId, at: now, toolInputHash: hash });
    if (outcome === 'already-answered') return reject('already-answered');
    if (outcome !== 'applied') return finish('unknown', outcome === 'refused' ? 'hook-refused' : 'not-confirmed');
    await this.registry.touch(d.deviceId);
    return finish('applied', null);
  }
}
