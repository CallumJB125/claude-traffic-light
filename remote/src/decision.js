// Signed remote decisions and the two desktop-signed messages around them.
//
//   desktop → phone  buddy.request  what is waiting (signed: the hub can't
//                                   change what the phone shows)
//   phone → desktop  buddy.decision allow|deny bound to requestId + sha256 of
//                                   the canonical tool input (signed by the device)
//   desktop → phone  buddy.result   applied|rejected (signed: the hub can't
//                                   fake success)
import { b64url, randomBytes } from './encoding.js';
import { hashToolInput } from './canonical.js';
import { signObject, verifyObject, importPublicRaw } from './keys.js';

export const DECISION_TTL_MS = 90 * 1000;
export const MAX_DECISION_TTL_MS = 120 * 1000;
export const CLOCK_SKEW_MS = 30 * 1000;

export const DECISION_KEYS = ['aud', 'cardId', 'decision', 'deviceId', 'expiresAt', 'issuedAt', 'nonce', 'requestId', 'sessionId', 't', 'toolInputHash', 'toolName', 'v'];

const isStr = (v, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max;

// Structural check of a parsed decision payload: exact key set and types.
export function decisionShapeOk(d) {
  if (!d || typeof d !== 'object') return false;
  const keys = Object.keys(d).sort();
  if (keys.length !== DECISION_KEYS.length || keys.some((k, i) => k !== DECISION_KEYS[i])) return false;
  return d.v === 1 && d.t === 'buddy.decision'
    && isStr(d.aud, 64) && isStr(d.requestId) && isStr(d.sessionId) && (d.cardId === null || isStr(d.cardId))
    && isStr(d.toolName, 256) && /^[0-9a-f]{64}$/.test(d.toolInputHash)
    && (d.decision === 'allow' || d.decision === 'deny') && isStr(d.deviceId, 64)
    && Number.isSafeInteger(d.issuedAt) && Number.isSafeInteger(d.expiresAt) && /^[A-Za-z0-9_-]{22,64}$/.test(d.nonce);
}

// ── Desktop: announce a pending request to the owner's devices ─────────────
export async function publishRequest(identity, pending, { deskOnly = null, now = Date.now(), ttlMs = 60000 } = {}) {
  const notice = {
    t: 'buddy.request', v: 1, did: identity.desktopId,
    requestId: pending.requestId, sessionId: pending.sessionId, cardId: pending.cardId ?? null,
    toolName: pending.toolName, toolInput: pending.toolInput ?? {}, toolInputHash: await hashToolInput(pending.toolInput),
    cwd: pending.cwd ?? null, repoLabels: pending.repoLabels ?? [],
    deskOnly: deskOnly && deskOnly.blocked ? { ruleId: deskOnly.ruleId, reason: deskOnly.reason } : null,
    issuedAt: now, expiresAt: now + ttlMs,
  };
  return signObject(identity.privateKey, notice);
}

// ── Phone: check a request notice came from the paired desktop ─────────────
// `paired` is what PairingClient.onComplete returned ({desktopPub, desktopId}).
export async function verifyRequestNotice(env, { desktopPub, desktopId }, { now = Date.now() } = {}) {
  const n = await verifyObject(await importPublicRaw(desktopPub), env, { maxBytes: 1024 * 1024 });
  if (!n || n.t !== 'buddy.request' || n.v !== 1) throw new Error('request not signed by your desktop');
  if (n.did !== desktopId) throw new Error('request is for a different desktop');
  if (!Number.isSafeInteger(n.expiresAt) || n.expiresAt <= now) throw new Error('request has expired');
  if ((await hashToolInput(n.toolInput)) !== n.toolInputHash) throw new Error('request hash does not match its input');
  return n;
}

// For the phone UI: make invisible or direction-changing characters visible,
// so a command or device name can't hide what it really says.
export function revealHidden(text) {
  return String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]|\udb40[\udc00-\udc7f]/g,
    (ch) => `⟨U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`);
}

// ── Phone: sign a decision ──────────────────────────────────────────────────
// The hash is computed here from the input the phone displayed, never taken
// from the notice, so a signature always covers what the human saw.
export async function signDecision({ device, desktopId, request, decision, now = Date.now(), ttlMs = DECISION_TTL_MS }) {
  if (decision !== 'allow' && decision !== 'deny') throw new TypeError('decision must be allow or deny');
  const payload = {
    t: 'buddy.decision', v: 1, aud: desktopId,
    requestId: request.requestId, sessionId: request.sessionId, cardId: request.cardId ?? null,
    toolName: request.toolName, toolInputHash: await hashToolInput(request.toolInput),
    decision, deviceId: device.deviceId,
    issuedAt: now, expiresAt: now + Math.min(ttlMs, MAX_DECISION_TTL_MS),
    nonce: b64url(randomBytes(16)),
  };
  const env = await signObject(device.privateKey, payload);
  return { envelope: { v: 1, kind: 'decision', ...env }, payload };
}

// ── Desktop: sign the outcome ───────────────────────────────────────────────
export function signResult(identity, { deviceId, requestId, nonce, status, decision, reason = null, now = Date.now() }) {
  return signObject(identity.privateKey, { t: 'buddy.result', v: 1, did: identity.desktopId, aud: deviceId, requestId, nonce, status, decision, reason, at: now });
}

const MESSAGES = {
  'desktop-offline': 'Desktop offline — not applied.',
  'already-answered': 'Already answered (at the desk or on another device) — yours was not applied.',
  'approve-at-desk': 'This one can only be approved at your desk.',
  expired: 'Too late — the request expired. Not applied.',
  'no-such-request': 'That request is no longer waiting. Not applied.',
};

// ── Phone: what to tell the human ───────────────────────────────────────────
// `outcome` is what the relay returned. Only a desktop-signed result for this
// exact decision (requestId + nonce) counts as applied; anything else —
// offline, timeout, a hub-made "ok" — is reported as not applied.
export async function interpretResult(outcome, { desktopPubRaw, sent }) {
  if (!outcome || outcome.status === 'desktop-offline') return { applied: false, status: 'desktop-offline', message: MESSAGES['desktop-offline'] };
  if (outcome.status !== 'delivered') return { applied: false, status: 'unknown', message: 'No answer from your desktop — assume not applied.' };
  // The desktop doesn't sign for senders it couldn't authenticate; the reason
  // is only a hint (the hub could have written it).
  if (outcome.body && outcome.body.unsigned === true) {
    return { applied: false, status: 'unverified', reason: typeof outcome.body.reason === 'string' ? outcome.body.reason : null, message: 'Your desktop did not accept this phone’s signature — not applied. Re-pair if this keeps happening.' };
  }
  const r = await verifyObject(await importPublicRaw(desktopPubRaw), outcome.body);
  if (!r || r.t !== 'buddy.result' || r.aud !== sent.deviceId || r.requestId !== sent.requestId || r.nonce !== sent.nonce) {
    return { applied: false, status: 'unverified', message: 'Reply was not signed by your desktop — not applied.' };
  }
  if (r.status === 'applied') return { applied: true, status: 'applied', decision: r.decision, message: r.decision === 'allow' ? 'Allowed.' : 'Denied.' };
  if (r.status === 'unknown') return { applied: false, status: 'unknown', reason: r.reason, message: 'Your desktop could not confirm Claude took the answer — treat it as not applied and check at your desk.' };
  return { applied: false, status: 'rejected', reason: r.reason, message: MESSAGES[r.reason] || `Not applied (${r.reason}).` };
}

