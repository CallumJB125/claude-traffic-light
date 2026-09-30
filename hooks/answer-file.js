// The answer protocol between whoever answers a permission request (widget
// buttons, the MCP tool, a phone via the desktop) and the blocked
// PermissionRequest hook (set-status.js), over <requests>/<id>.*:
//
//   <id>.json    the request, written once by the hook (O_EXCL, 0600), with the
//                full tool input and toolInputHash = sha256(canonical input)
//   <id>.answer  created exactly once: answerers write a temp file and link()
//                it into place, so EEXIST means someone else already answered.
//                Holds {decision, toolInputHash, by, ack, nonce}.
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
function writeAnswer(dir, id, decision, { by = 'desk', ack = false } = {}) {
  const p = paths(dir, String(id || ''));
  if (!p) return { ok: false, error: 'bad request id' };
  if (decision !== 'allow' && decision !== 'deny') return { ok: false, error: 'decision must be "allow" or "deny"' };
  let req;
  try { req = JSON.parse(fs.readFileSync(p.req, 'utf8')); } catch { return { ok: false, error: 'no such pending request (answered, timed out, or never existed)' }; }
  if (!req || typeof req.toolInputHash !== 'string') return { ok: false, error: 'request has no input hash (hook too old) — answer in the terminal' };
  const nonce = crypto.randomBytes(16).toString('hex');
  const body = JSON.stringify({ v: 1, decision, toolInputHash: req.toolInputHash, by: String(by).slice(0, 40), ack: !!ack, nonce });
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
// ack, removed otherwise. Returns 'allow' | 'deny' | null.
function consumeAnswer(dir, id, expectedHash) {
  const p = paths(dir, id);
  let a = null;
  try { a = JSON.parse(fs.readFileSync(p.ans, 'utf8')); } catch {}
  const valid = !!a && (a.decision === 'allow' || a.decision === 'deny') && a.toolInputHash === expectedHash;
  try {
    if (a && a.ack) fs.renameSync(p.ans, valid ? p.taken : p.refused);
    else fs.unlinkSync(p.ans);
  } catch {}
  return valid ? a.decision : null;
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

module.exports = { HOOK_MARGIN_MS, STALE_REQUEST_MS, canonicalize, hashToolInput, paths, createExclusive, writeAnswer, awaitTaken, consumeAnswer, claimTimeout, sweep, ID_RE };
