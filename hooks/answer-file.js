// The answer protocol between whoever answers a permission request (widget
// buttons, the MCP tool, a phone via the desktop) and the blocked
// PermissionRequest hook (set-status.js), over <requests>/<id>.*:
//
//   <id>.json    the request, written once by the hook (O_EXCL, 0600), with the
//                full tool input and toolInputHash = sha256(canonical input)
//   <id>.answer  created exactly once: answerers write a temp file and link()
//                it into place, so EEXIST means someone else already answered.
//                Holds {decision, toolInputHash, by, ack, nonce, extra?}.
//                decision: allow | deny (tool permissions, plans, questions)
//                or accept | decline | cancel (MCP elicitations); `extra`
//                carries what a richer answer needs (question answers, a
//                permission suggestion index, a plan mode, a deny message,
//                elicitation content). The hook judges both against the kind
//                of request it wrote (set-status.js answerOutput).
//                At its deadline the hook claims <id>.answer the same way with
//                a `timeout` marker, so a late answer can't slip in unseen.
//   <id>.taken   the hook renamed an ack-wanting answer after acting on it
//   <id>.refused …or refused it (hash mismatch / junk)
//
// The hook only honours an answer whose toolInputHash matches the input it
// is holding, so an answer can never release a different tool call.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[A-Za-z0-9_-][\w.-]{0,199}$/;
const DECISIONS = new Set(['allow', 'deny', 'accept', 'decline', 'cancel']);

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const shortStr = (v, max) => typeof v === 'string' && v.length <= max;

// What an answerer may attach, shape-checked here so a junk answer never
// reaches the hook's output. null = refused.
function cleanExtra(extra) {
  if (extra == null) return {};
  if (!plain(extra)) return null;
  const out = {};
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    if (k === 'answers') {
      if (!plain(v) || Object.keys(v).length > 8 || !Object.entries(v).every(([q, a]) => shortStr(q, 2000) && shortStr(a, 2000))) return null;
    } else if (k === 'permissionIndex') {
      if (!Number.isInteger(v) || v < 0 || v > 31) return null;
    } else if (k === 'mode') {
      if (v !== 'acceptEdits' && v !== 'default') return null;
    } else if (k === 'message') {
      if (!shortStr(v, 1000)) return null;
    } else if (k === 'content') {
      if (!plain(v) || Object.keys(v).length > 50 || !Object.values(v).every((x) => ['string', 'number', 'boolean'].includes(typeof x) || (Array.isArray(x) && x.length <= 50 && x.every((y) => shortStr(y, 2000))))) return null;
      if (Object.values(v).some((x) => typeof x === 'string' && x.length > 10000)) return null;
    } else return null;
    out[k] = v;
  }
  return out;
}

// RFC 8785 canonical JSON; must stay byte-identical to remote/src/canonical.js
// (remote/test checks both on the same inputs).
function canonicalize(v, depth = 0) {
  if (depth > 64) throw new Error('too deeply nested');
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'string': return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new Error('non-finite number');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) {
        let out = '[';
        for (let i = 0; i < v.length; i++) {
          if (!(i in v)) throw new Error('sparse array');
          out += (i ? ',' : '') + canonicalize(v[i], depth + 1);
        }
        return out + ']';
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error('not a plain object');
      const keys = Object.keys(v).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(v[k], depth + 1)).join(',') + '}';
    }
    default: throw new Error(`unsupported ${typeof v}`);
  }
}

const hashToolInput = (input) => crypto.createHash('sha256').update(canonicalize(input ?? {}), 'utf8').digest('hex');

function paths(dir, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const base = path.join(dir, id);
  return { req: `${base}.json`, ans: `${base}.answer`, taken: `${base}.taken`, refused: `${base}.refused` };
}

// Write `text` to `file` only if `file` doesn't exist yet, atomically: the
// content is complete before the name appears. false = someone was first.
function createExclusive(file, text) {
  const tmp = `${file}.tmp.${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ── Answerer side ───────────────────────────────────────────────────────────
// { ok: true, nonce } or { ok: false, error }. `ack: true` asks the hook to
// leave <id>.taken behind so the answerer can confirm it was acted on.
function writeAnswer(dir, id, decision, { by = 'desk', ack = false, extra = null } = {}) {
  const p = paths(dir, String(id || ''));
  if (!p) return { ok: false, error: 'bad request id' };
  if (!DECISIONS.has(decision)) return { ok: false, error: 'decision must be one of allow, deny, accept, decline, cancel' };
  const clean = cleanExtra(extra);
  if (!clean) return { ok: false, error: 'malformed answer' };
  let req;
  try { req = JSON.parse(fs.readFileSync(p.req, 'utf8')); } catch { return { ok: false, error: 'no such pending request (answered, timed out, or never existed)' }; }
  if (!req || typeof req.toolInputHash !== 'string') return { ok: false, error: 'request has no input hash (hook too old) — answer in the terminal' };
  const nonce = crypto.randomBytes(16).toString('hex');
  const body = JSON.stringify({ v: 1, decision, toolInputHash: req.toolInputHash, by: String(by).slice(0, 40), ack: !!ack, nonce, ...(Object.keys(clean).length ? { extra: clean } : {}) });
  try {
    if (!createExclusive(p.ans, body)) return { ok: false, error: 'already answered' };
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? 'no such pending request' : e.message };
  }
  return { ok: true, nonce };
}

// After an ack-wanting writeAnswer: 'applied' (the hook took our answer),
// 'refused' (the hook rejected it), 'lost' (the hook took someone else's),
// or 'unknown' (nothing within the timeout — never report success then).
async function awaitTaken(dir, id, nonce, { timeoutMs = 1500, intervalMs = 50 } = {}) {
  const p = paths(dir, id);
  if (!p) return 'unknown';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const [file, outcome] of [[p.taken, 'applied'], [p.refused, 'refused']]) {
      let a = null;
      try { a = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (a && a.nonce === nonce) {
        try { fs.unlinkSync(file); } catch {}
        return outcome;
      }
      if (outcome === 'applied') return 'lost';
    }
    if (Date.now() >= deadline) return 'unknown';
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── Hook side ───────────────────────────────────────────────────────────────
// Read the answer, judge it against the input the hook is holding, and move
// it out of the way: renamed to .taken/.refused if the answerer wants an
// ack, removed otherwise. consumeAnswerDetail returns {decision, extra} or
// null; consumeAnswer just the decision. `accept(answer)` lets the hook refuse
// an answer that doesn't fit the request's kind (so the answerer hears
// 'refused', not 'applied').
function consumeAnswerDetail(dir, id, expectedHash, accept = () => true) {
  const p = paths(dir, id);
  let a = null;
  try { a = JSON.parse(fs.readFileSync(p.ans, 'utf8')); } catch {}
  const extra = a ? cleanExtra(a.extra) : null;
  let valid = !!a && DECISIONS.has(a.decision) && a.toolInputHash === expectedHash && !!extra;
  if (valid) { try { valid = !!accept({ decision: a.decision, extra }); } catch { valid = false; } }
  try {
    if (a && a.ack) fs.renameSync(p.ans, valid ? p.taken : p.refused);
    else fs.unlinkSync(p.ans);
  } catch {}
  return valid ? { decision: a.decision, extra } : null;
}

function consumeAnswer(dir, id, expectedHash) {
  const d = consumeAnswerDetail(dir, id, expectedHash, ({ decision }) => decision === 'allow' || decision === 'deny');
  return d ? d.decision : null;
}

// At the deadline: true if the hook got the last word (nobody answered);
// false if an answer is already there and must be consumed instead.
function claimTimeout(dir, id) {
  const p = paths(dir, id);
  try {
    return createExclusive(p.ans, JSON.stringify({ v: 1, decision: 'timeout', by: 'hook', ack: false }));
  } catch {
    return true;
  }
}

// The hook stops waiting this long before Claude Code's hook timeout.
const HOOK_MARGIN_MS = 5000;
// No live hook is older than its timeout (60 s): a request file older than
// this belongs to a hook that was killed, and must not be shown or answered.
const STALE_REQUEST_MS = 75 * 1000;

// Leftovers from killed hooks or answerers nobody came back for.
function sweep(dir, { maxAgeMs = 10 * 60 * 1000, staleRequestMs = STALE_REQUEST_MS, now = Date.now() } = {}) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return; }
  for (const f of files) {
    const leftover = /\.(answer|taken|refused)$|\.answer\.tmp\.[0-9a-f]+$/.test(f);
    if (!leftover && !f.endsWith('.json')) continue;
    const file = path.join(dir, f);
    try { if (now - fs.statSync(file).mtimeMs > (leftover ? maxAgeMs : staleRequestMs)) fs.unlinkSync(file); } catch {}
  }
}

module.exports = { HOOK_MARGIN_MS, STALE_REQUEST_MS, DECISIONS, canonicalize, hashToolInput, paths, createExclusive, cleanExtra, writeAnswer, awaitTaken, consumeAnswer, consumeAnswerDetail, claimTimeout, sweep, ID_RE };
