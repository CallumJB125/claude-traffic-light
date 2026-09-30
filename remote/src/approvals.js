// The desktop's gate for remote decisions. Everything a phone or teammate
// sends ends up in handleDecision, which applies a decision only if all of
// these hold, in this order:
//   1. well-formed canonical payload, addressed to this desktop (aud)
//   2. device known and not revoked; ECDSA signature valid for its key
//   3. issuedAt/expiresAt sane (TTL ≤ 120 s, ≤ 30 s clock skew), not expired
//   4. nonce not seen before for this device (replay cache)
//   5. request still pending; sessionId, cardId, toolName match
//   6. sha256(canonical pending tool input) == signed toolInputHash
//   7. injected policy says this device's owner may act (owner / assignee)
//   8. allow only: the deny-list doesn't match → else "approve at your desk"
//   9. first-wins settle of the pending request
// Every outcome is audited and answered with a desktop-signed result.
import { utf8 } from './encoding.js';
import { hashToolInput } from './canonical.js';
import { verifyBytes, parseCanonical } from './keys.js';
import { decisionShapeOk, publishRequest, signResult, MAX_DECISION_TTL_MS, CLOCK_SKEW_MS } from './decision.js';
import { compileRules, evaluateDenyList, DEFAULT_RULES } from './denylist.js';
import { ReplayCache } from './replay.js';

const MAX_ENVELOPE_BYTES = 4096;

// Session owner may always act; card assignees may act on runner sessions.
export function ownerOrAssignee({ device, pending }) {
  if (!device || typeof device.ownerId !== 'string' || !pending) return false;
  if (typeof pending.ownerId === 'string' && device.ownerId === pending.ownerId) return true;
  return pending.runner === true && Array.isArray(pending.assigneeIds) && pending.assigneeIds.includes(device.ownerId);
}

export class RemoteApprovals {
  constructor({
    identity, registry, pending,
    authorize = ownerOrAssignee,
    rules = DEFAULT_RULES,
    repoLabels = (p) => p.repoLabels || [],
    audit = () => {},
    clock = () => Date.now(),
    replay,
    maxTtlMs = MAX_DECISION_TTL_MS,
    skewMs = CLOCK_SKEW_MS,
  }) {
    Object.assign(this, { identity, registry, pending, authorize, repoLabels, audit, clock, maxTtlMs, skewMs });
    this.rules = compileRules(rules);
    this.replay = replay || new ReplayCache({ clock });
  }

  async #denyCheck(p) {
    return evaluateDenyList(this.rules, { toolName: p.toolName, toolInput: p.toolInput, repoLabels: await this.repoLabels(p) });
  }

  // The signed notice sent to the owner's (and assignees') devices.
  async announce(p) {
    return publishRequest(this.identity, p, { deskOnly: await this.#denyCheck(p), now: this.clock() });
  }

  async handleDecision(env) {
    const now = this.clock();
    let d = null;
    let device = null;
    let pendingReq = null;

    const finish = async (status, reason, extra = {}) => {
      const event = {
        type: status === 'applied' ? 'remote.decision.applied' : 'remote.decision.rejected',
        at: now, via: 'remote', reason: reason ?? null,
        requestId: d?.requestId ?? null, sessionId: d?.sessionId ?? null, cardId: d?.cardId ?? null,
        toolName: d?.toolName ?? null, toolInputHash: d?.toolInputHash ?? null, decision: d?.decision ?? null,
        deviceId: d?.deviceId ?? null, deviceVerified: !!device, deviceName: device?.name ?? null, ownerId: device?.ownerId ?? null,
        ...extra,
      };
      try { await this.audit(event); } catch { /* audit must never change the outcome */ }
      const body = d ? await signResult(this.identity, { deviceId: d.deviceId, requestId: d.requestId, nonce: d.nonce, status, decision: d.decision, reason: reason ?? null, now }) : null;
      return { status, reason: reason ?? null, body, event };
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

    pendingReq = await this.pending.get(d.requestId);
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
      const hit = await this.#denyCheck(pendingReq);
      if (hit.blocked) return reject('approve-at-desk', { ruleId: hit.ruleId, ruleReason: hit.reason });
    }

    const won = await this.pending.settle(d.requestId, d.decision, { by: 'remote', deviceId: d.deviceId, ownerId: device.ownerId, at: now });
    if (!won) return reject('already-answered');
    await this.registry.touch(d.deviceId);
    return finish('applied', null);
  }
}
