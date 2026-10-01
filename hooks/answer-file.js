// The answer protocol between whoever answers a waiting input (widget
// buttons, a phone via the desktop) and the blocked hook (set-status.js),
// over <requests>/<id>.*:
//
//   <id>.json    the request, written once by the hook (O_EXCL, 0600), with the
//                full tool input, toolInputHash = sha256(canonical input) (the
//                phone's hash) and decisionHash = decisionHashOf(request): the
//                kind, channel, tool, input, permission suggestions, cwd,
//                session and host together
//   <id>.answer  created exactly once: answerers write a temp file and link()
//                it into place, so EEXIST means someone else already answered.
//                Holds {v, id, decision, decisionHash, by, ack, nonce, extra?,
//                mac}. decision: allow | deny (tool permissions, plans,
//                questions) or accept | decline | cancel (MCP elicitations);
//                `extra` carries what a richer answer needs (question answers,
//                a permission suggestion index + that suggestion's hash, a plan
//                mode, a deny message, elicitation content). The hook judges
//                both against the kind of request it wrote (set-status.js
//                answerOutput).
//                At its deadline the hook claims <id>.answer the same way with
//                a `timeout` marker, so a late answer can't slip in unseen.
//   <id>.taken   the hook renamed an ack-wanting answer after acting on it
//   <id>.refused …or refused it (bad mac / hash mismatch / junk)
//
// Anyone running as this user can write into requests/, the agent included,
// so a file there proves nothing. Before it writes <id>.json the hook hands a
// fresh 32-byte key for that id to the running app over the signal server
// (never to disk); the app keeps it in memory (requestKeys) and every answer
// carries mac = HMAC-SHA256(key, canonical answer fields). The hook honours
// only an answer whose mac verifies and whose decisionHash is the one it is
// holding, so a forged file can't answer, and an answer can never release a
// different call or apply a different suggestion.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[A-Za-z0-9_-][\w.-]{0,199}$/;
const DECISIONS = new Set(['allow', 'deny', 'accept', 'decline', 'cancel']);
const HEX64 = /^[0-9a-f]{64}$/;

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
    } else if (k === 'suggestionHash') {
      if (typeof v !== 'string' || !HEX64.test(v)) return null;
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

// RFC 8785 canonical JSON; must stay byte-identical to src/deny/canonical.js (remote/ re-exports it)
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

// Everything an answer is judged against: what is asked, through which hook,
// for which tool and input, which permission rules a click could apply, and
// where and for whom it runs (cwd, session, host: shown to the person, and cwd
// decides what the phone's allow-list lets through).
const decisionHashOf = (r) => hashToolInput({ kind: r?.kind ?? null, channel: r?.channel ?? null, tool: r?.tool ?? null, toolInput: r?.toolInput ?? {}, permissionSuggestions: r?.permissionSuggestions ?? null, cwd: r?.cwd ?? null, sessionId: r?.sessionId ?? null, host: r?.host ?? null });

// The request file still says what its hash says (a request edited after the
// hook wrote it is never shown or answered).
function requestIntact(r) {
  if (!r || typeof r.decisionHash !== 'string') return false;
  try { return decisionHashOf(r) === r.decisionHash; } catch { return false; }
}

// HMAC over every field of the answer but the mac itself.
function answerMac(key, a) {
  const fields = { v: a.v, id: a.id, decision: a.decision, decisionHash: a.decisionHash, by: a.by, ack: a.ack, nonce: a.nonce, extra: a.extra ?? null };
  return crypto.createHmac('sha256', key).update(canonicalize(fields), 'utf8').digest('hex');
}

function macOk(key, a) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof a?.mac !== 'string' || !HEX64.test(a.mac)) return false;
  let want;
  try { want = Buffer.from(answerMac(key, a), 'hex'); } catch { return false; }
  return crypto.timingSafeEqual(want, Buffer.from(a.mac, 'hex'));
}

// Before handing over a key, the hook makes whatever listens on the port it
// found prove it holds the per-install token: it sends a random nonce (no
// secret) to POST /request-key/challenge and expects this HMAC back. The
// server's own port is in it, so a fake listener can't relay the challenge to
// the real app and replay the answer from a different port.
const requestKeyProof = (token, port, nonce) => crypto.createHmac('sha256', String(token)).update(`buddy.request-key.v1|${port}|${nonce}`, 'utf8').digest('hex');

// App side: the per-request keys hooks hand over the signal server, kept in
// memory only. First registration for an id wins (the hook registers before
// the id is visible anywhere); keys live no longer than any hook can wait.
function requestKeys({ ttlMs = STALE_REQUEST_MS, max = 1024, now = () => Date.now() } = {}) {
  const keys = new Map();
  const prune = () => { const t = now(); for (const [id, k] of keys) if (t - k.at > ttlMs) keys.delete(id); };
  return {
    register(id, hex) {
      prune();
      if (typeof id !== 'string' || !ID_RE.test(id) || typeof hex !== 'string' || !HEX64.test(hex) || keys.has(id) || keys.size >= max) return false;
      keys.set(id, { key: Buffer.from(hex, 'hex'), at: now() });
      return true;
    },
    get(id) { prune(); return keys.get(id)?.key || null; },
    forget(id) { keys.delete(id); },
  };
}

function paths(dir, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const base = path.join(dir, id);
  return { id, req: `${base}.json`, ans: `${base}.answer`, taken: `${base}.taken`, refused: `${base}.refused` };
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
// leave <id>.taken behind so the answerer can confirm it was acted on. `key`
// is the request's key from requestKeys (only the app has it). `decisionHash`,
// when given, is the hash of the request the person was shown: the answer is
// refused if the file no longer matches it.
function writeAnswer(dir, id, decision, { by = 'desk', ack = false, extra = null, key = null, decisionHash = null } = {}) {
  const p = paths(dir, String(id || ''));
  if (!p) return { ok: false, error: 'bad request id' };
  if (!DECISIONS.has(decision)) return { ok: false, error: 'decision must be one of allow, deny, accept, decline, cancel' };
  const clean = cleanExtra(extra);
  if (!clean) return { ok: false, error: 'malformed answer' };
  let req;
  try { req = JSON.parse(fs.readFileSync(p.req, 'utf8')); } catch { return { ok: false, error: 'no such pending request (answered, timed out, or never existed)' }; }
  if (!req || typeof req.decisionHash !== 'string') return { ok: false, error: 'request has no decision hash (hook too old) — answer in the terminal' };
  if (!requestIntact(req) || (decisionHash !== null && decisionHash !== req.decisionHash)) return { ok: false, error: 'request changed since it was shown — answer in the terminal' };
  if (clean.permissionIndex !== undefined) {
    const s = Array.isArray(req.permissionSuggestions) ? req.permissionSuggestions[clean.permissionIndex] : undefined;
    if (!s) return { ok: false, error: 'no such permission suggestion' };
    const h = hashToolInput(s);
    if (clean.suggestionHash !== undefined && clean.suggestionHash !== h) return { ok: false, error: 'permission suggestion changed since it was shown' };
    clean.suggestionHash = h;
  } else if (clean.suggestionHash !== undefined) return { ok: false, error: 'malformed answer' };
  if (!Buffer.isBuffer(key) || key.length !== 32) return { ok: false, error: 'the app holds no key for this request — answer in the terminal' };
  const a = { v: 2, id: p.id, decision, decisionHash: req.decisionHash, by: String(by).slice(0, 40), ack: !!ack, nonce: crypto.randomBytes(16).toString('hex'), ...(Object.keys(clean).length ? { extra: clean } : {}) };
  a.mac = answerMac(key, a);
  try {
    if (!createExclusive(p.ans, JSON.stringify(a))) return { ok: false, error: 'already answered' };
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? 'no such pending request' : e.message };
  }
  return { ok: true, nonce: a.nonce };
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
// Read the answer, judge it against the request the hook is holding, and move
// it out of the way: renamed to .taken/.refused if the answerer wants an
// ack, removed otherwise. Valid only with a mac under the hook's own `key`
// and the hook's own `expectedHash` (decisionHash). consumeAnswerDetail
// returns {decision, extra} or null; consumeAnswer just the decision.
// `accept(answer)` lets the hook refuse an answer that doesn't fit the
// request's kind (so the answerer hears 'refused', not 'applied').
function consumeAnswerDetail(dir, id, expectedHash, key, accept = () => true) {
  const p = paths(dir, id);
  let a = null;
  try { a = JSON.parse(fs.readFileSync(p.ans, 'utf8')); } catch {}
  const extra = a ? cleanExtra(a.extra) : null;
  let valid = !!a && a.id === id && DECISIONS.has(a.decision) && a.decisionHash === expectedHash && !!extra && macOk(key, a);
  if (valid) { try { valid = !!accept({ decision: a.decision, extra }); } catch { valid = false; } }
  try {
    if (a && a.ack) fs.renameSync(p.ans, valid ? p.taken : p.refused);
    else fs.unlinkSync(p.ans);
  } catch {}
  return valid ? { decision: a.decision, extra } : null;
}

function consumeAnswer(dir, id, expectedHash, key) {
  const d = consumeAnswerDetail(dir, id, expectedHash, key, ({ decision }) => decision === 'allow' || decision === 'deny');
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

module.exports = { HOOK_MARGIN_MS, STALE_REQUEST_MS, DECISIONS, canonicalize, hashToolInput, decisionHashOf, requestIntact, answerMac, macOk, requestKeyProof, requestKeys, paths, createExclusive, cleanExtra, writeAnswer, awaitTaken, consumeAnswer, consumeAnswerDetail, claimTimeout, sweep, ID_RE };
