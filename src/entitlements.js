// What this install may use: has(feature) and limits(), answered synchronously
// and offline from an optional cached entitlement token in the data root. No
// network and no process here: the refresh (W3-B) is a separate module that
// only ever writes the token file this one reads.
//
// The token is a compact JWT (EdDSA / Ed25519) the hub signs:
//   {sub, plan: 'plus'|'team', features?: [key], iat, exp, period_end?}
// exp already carries the offline grace (period end + 14 days), so a machine
// that never gets back online keeps its plan until exp and not a moment longer.
// Anything else — no file, a corrupt or oversized one, an unknown plan, a bad
// signature, no pinned key, an expired token — is the free plan. Never throws.
//
// Clock: the effective "now" is the latest of the wall clock, the last time
// this module saw the clock (entitlement-clock.json) and the token's own iat,
// so turning the clock back cannot stretch a token past its exp.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PLANS = Object.freeze(['free', 'plus', 'team']);
const RANK = Object.freeze({ free: 0, plus: 1, team: 2 });

// Every gated capability from the plan's free/paid table, with the lowest plan
// that has it. A free entry with a limit below is the "generous free taste".
const FEATURES = Object.freeze({
  'costguard.receipt': 'free', // free: teaser only (limits().receipt)
  'costguard.enforce': 'plus',
  'costguard.waste': 'plus',
  'costguard.teamRollup': 'team',
  'checkpoints': 'free', // free: last limits()['checkpoints.turns'] turns
  'checkpoints.review': 'plus',
  'checkpoints.reviewPolicy': 'team',
  'queue.windows': 'plus',
  'queue.morningReport': 'plus',
  'queue.push': 'plus',
  'memory.search': 'free', // free: last limits()['memory.days'] days
  'handoff.copy': 'free',
  'handoff.launch': 'plus',
  'sync': 'plus',
  'phone': 'plus',
  'billing.csv': 'free', // free: current month only (limits()['billing.months'])
  'billing.pdf': 'plus',
  'billing.rateCards': 'plus',
  'billing.clientProjection': 'team',
  'setups.personal': 'free',
  'setups.team': 'team',
});

const GB = 1024 ** 3;
const LIMITS = Object.freeze({
  free: Object.freeze({ 'checkpoints.turns': 3, 'checkpoints.days': 7, 'memory.days': 7, devices: 0, 'sync.bytes': 0, 'billing.months': 1, receipt: 'teaser' }),
  plus: Object.freeze({ 'checkpoints.turns': Infinity, 'checkpoints.days': 7, 'memory.days': Infinity, devices: 3, 'sync.bytes': 5 * GB, 'billing.months': Infinity, receipt: 'full' }),
  // Team: devices and sync storage are per seat.
  team: Object.freeze({ 'checkpoints.turns': Infinity, 'checkpoints.days': 7, 'memory.days': Infinity, devices: 3, 'sync.bytes': 5 * GB, 'billing.months': Infinity, receipt: 'full' }),
});

// The hub's Ed25519 public keys (PEM), pinned in the app. None until billing
// ships (W3-A), so until then every token is refused and every install is free.
const PINNED_KEYS = Object.freeze([]);

const TOKEN_FILE = 'entitlement.json';
const CLOCK_FILE = 'entitlement-clock.json';
const MAX_BYTES = 16 * 1024;
const CLOCK_WRITE_MS = 60 * 1000;

let cfg = null;
let cache = null; // {key, result}
let lastSeen = null; // ms, loaded once per configure
let lastWritten = 0;

function defaults() {
  return {
    root: process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), '.claude-traffic-light'),
    publicKeys: PINNED_KEYS,
    now: () => Date.now(),
  };
}

/** Tests and the W3-B refresh: point at another data root, keys or clock. Clears every cache. */
function configure(opts = {}) {
  cfg = { ...defaults(), ...opts };
  cache = null;
  lastSeen = null;
  lastWritten = 0;
}

const conf = () => cfg ?? (configure(), cfg);

function readSmall(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return { text: fs.readFileSync(file, 'utf8'), key: `${st.mtimeMs}:${st.size}` };
  } catch { return null; }
}

function loadLastSeen() {
  if (lastSeen !== null) return lastSeen;
  const got = readSmall(path.join(conf().root, CLOCK_FILE));
  let v = 0;
  try { v = Number(JSON.parse(got?.text ?? 'null')?.lastSeen) || 0; } catch { v = 0; }
  lastSeen = Number.isFinite(v) && v > 0 ? v : 0;
  return lastSeen;
}

function saveLastSeen(t) {
  if (t <= lastSeen) return;
  lastSeen = t;
  if (t - lastWritten < CLOCK_WRITE_MS) return;
  lastWritten = t;
  try {
    const dir = conf().root;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `${CLOCK_FILE}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ lastSeen: t }), { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, CLOCK_FILE));
  } catch { /* the in-memory value still holds for this run */ }
}

const b64url = (s) => Buffer.from(s, 'base64url');
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** The verified claims of a compact EdDSA JWT, or null. */
function verifyToken(token, keys) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL_RE.test(p))) return null;
  let header, claims;
  try {
    header = JSON.parse(b64url(parts[0]).toString('utf8'));
    claims = JSON.parse(b64url(parts[1]).toString('utf8'));
  } catch { return null; }
  if (header?.alg !== 'EdDSA' || (header.typ !== undefined && header.typ !== 'JWT')) return null;
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = b64url(parts[2]);
  for (const pem of keys ?? []) {
    try {
      const key = crypto.createPublicKey(pem);
      if (key.asymmetricKeyType !== 'ed25519') continue;
      if (crypto.verify(null, data, key, sig)) return claims;
    } catch { /* a bad pinned key is skipped, never fatal */ }
  }
  return null;
}

const FREE = (reason) => Object.freeze({ plan: 'free', source: 'default', reason, features: Object.freeze([]), expiresAt: null, periodEnd: null, inGrace: false });

/**
 * The current entitlement: {plan, source:'default'|'token', reason, features,
 * expiresAt, periodEnd, inGrace}. inGrace is true between the paid period's
 * end and exp (the offline grace), so a banner can say "renews soon".
 */
function status() {
  try {
    const c = conf();
    const file = readSmall(path.join(c.root, TOKEN_FILE));
    const wall = Number(c.now());
    const seen = loadLastSeen();
    if (!file) { saveLastSeen(wall); return FREE('missing'); }
    const key = `${file.key}:${file.text.length}`;
    let parsed;
    if (cache?.key === key) parsed = cache.parsed;
    else {
      let token = null;
      try { token = JSON.parse(file.text)?.token; } catch { token = null; }
      parsed = verifyToken(token, c.publicKeys);
      cache = { key, parsed };
    }
    if (!parsed) { saveLastSeen(wall); return FREE('invalid'); }
    const { plan, exp, iat } = parsed;
    if (plan !== 'plus' && plan !== 'team') { saveLastSeen(wall); return FREE('invalid'); }
    if (!Number.isFinite(exp) || !Number.isFinite(iat) || exp <= iat) { saveLastSeen(wall); return FREE('invalid'); }
    const now = Math.max(wall, seen, iat * 1000);
    saveLastSeen(now);
    if (now >= exp * 1000) return FREE('expired');
    const extra = Array.isArray(parsed.features) ? parsed.features.filter((f) => typeof f === 'string' && Object.hasOwn(FEATURES, f)) : [];
    const periodEnd = Number.isFinite(parsed.period_end) && parsed.period_end <= exp ? parsed.period_end * 1000 : null;
    return Object.freeze({ plan, source: 'token', reason: 'ok', features: Object.freeze([...new Set(extra)]), expiresAt: exp * 1000, periodEnd, inGrace: periodEnd !== null && now >= periodEnd });
  } catch {
    return FREE('error');
  }
}

/** Does this install have `feature` (a FEATURES key)? Unknown keys are false. */
function has(feature) {
  if (typeof feature !== 'string' || !Object.hasOwn(FEATURES, feature)) return false;
  const s = status();
  return RANK[s.plan] >= RANK[FEATURES[feature]] || s.features.includes(feature);
}

/** The current plan's limits (a frozen object; Infinity means unlimited). */
function limits() {
  return LIMITS[status().plan] ?? LIMITS.free;
}

const plan = () => status().plan;

module.exports = { has, limits, plan, status, configure, PLANS, FEATURES, LIMITS, TOKEN_FILE, CLOCK_FILE };
