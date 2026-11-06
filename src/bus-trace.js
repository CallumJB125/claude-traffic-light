'use strict';
// The agent bus's trace (BACKBONE plan §3.6, G11): one JSONL line per bus op, so "why didn't Codex get it" has an
// answer. Shape is src/bus-contract.js TRACE_FIELDS plus ref (the handoff or note id). Every field passes a closed
// pattern or is dropped, so no note body, brief, title, path or CLI text can reach the file whatever a caller passes.
// Main writes <Plexiform data>/bus-trace.jsonl; the Tasks helper writes the same shape in its own data folder. Lines
// of one collaboration share a trace_id across both. Appends are queued and async (main never blocks on the bus);
// the file is 0600 and rotates to .1 at 5 MB. A write that fails is dropped: tracing never breaks the bus.
const fs = require('fs');
const crypto = require('crypto');
const C = require('./bus-contract.js');

const MAX_BYTES = 5 * 1024 * 1024;
const HANDLE = /^(?:(?:claude|codex|gemini)-[a-z0-9-]{1,16}-[0-9a-f]{4,6}|plexiform)$/;
const HEX16 = /^[0-9a-f]{16}$/;
const REASON = /^[A-Z][A-Z_]{1,39}$/;
const REF = /^(?:hof_[a-f0-9]{12,32}|note_[a-f0-9]{16,32}|tsk_[A-Za-z0-9]{1,64})$/;
const OPS = new Set(C.TRACE_OPS);
const RESULTS = new Set(C.TRACE_RESULTS);
const PROVIDERS = new Set([...C.PROVIDERS, C.ANY_PROVIDER, 'bus']);

const newTraceId = () => `tr_${crypto.randomBytes(8).toString('hex')}`;
const newSpan = () => `sp_${crypto.randomBytes(4).toString('hex')}`;
const repoKeyHash = (root) => (typeof root === 'string' && root ? crypto.createHash('sha256').update(root).digest('hex').slice(0, 16) : null);

/** The line as written: only known fields, each matching its pattern, else null. */
function sanitize(e, now) {
  const x = e && typeof e === 'object' ? e : {};
  const pick = (v, ok) => (ok(v) ? v : null);
  const to = typeof x.to === 'string' && (HANDLE.test(x.to) || PROVIDERS.has(x.to)) ? x.to : null;
  return {
    t: Number.isFinite(x.t) ? x.t : now,
    trace_id: C.isTraceId(x.trace_id) ? x.trace_id : newTraceId(),
    span: C.isSpanId(x.span) ? x.span : newSpan(),
    op: OPS.has(x.op) ? x.op : null,
    from_handle: pick(x.from_handle, (v) => typeof v === 'string' && HANDLE.test(v)),
    to,
    provider: pick(x.provider, (v) => PROVIDERS.has(v)),
    repo_key_hash: pick(x.repo_key_hash, (v) => typeof v === 'string' && HEX16.test(v)),
    result: RESULTS.has(x.result) ? x.result : null,
    reason: pick(x.reason, (v) => typeof v === 'string' && REASON.test(v)),
    ms: Number.isFinite(x.ms) && x.ms >= 0 ? Math.round(x.ms) : null,
    ref: pick(x.ref, (v) => typeof v === 'string' && REF.test(v)),
  };
}

/** A reply's outcome for the trace: refused (a {reason}), error, or ok. */
function resultOf(r, err = null) {
  if (err) return { result: 'error', reason: REASON.test(String(err.code || '')) ? err.code : 'ERROR' };
  if (r && typeof r === 'object' && typeof r.reason === 'string') return { result: 'refused', reason: r.reason };
  if (r && typeof r === 'object' && r.outcome === 'unknown') return { result: 'deferred', reason: null };
  return { result: 'ok', reason: null };
}

function createTrace({ file, now = Date.now, maxBytes = MAX_BYTES, fsp = fs.promises } = {}) {
  let size = null;
  let queue = Promise.resolve();
  function write(text) {
    queue = queue.then(async () => {
      if (size === null) size = await fsp.stat(file).then((s) => s.size, () => 0);
      if (size + text.length > maxBytes) { await fsp.rename(file, `${file}.1`).catch(() => {}); size = 0; }
      await fsp.appendFile(file, text, { mode: 0o600 });
      size += Buffer.byteLength(text);
    }).catch(() => { size = null; });
    return queue;
  }
  return {
    file,
    /** Appends one line; returns the sanitized record (so callers can reuse its trace_id). */
    append(e) {
      if (!file) return null;
      const rec = sanitize(e, now());
      if (!rec.op) return null;
      write(`${JSON.stringify(rec)}\n`);
      return rec;
    },
    flush: () => queue,
  };
}

module.exports = { createTrace, sanitize, resultOf, newTraceId, newSpan, repoKeyHash, MAX_BYTES };
