// The synced document set and its op log (W3-C). Pure: no files, no network.
//
// A doc is one small metadata record keyed by id: a memory-index session row,
// a checkpoint session summary or a handover document. Raw transcripts are
// never synced unless the user opted in (kind 'transcript', allowTranscripts).
// Every string passes src/secret-patterns.js before it leaves this module, and
// only allowlisted fields of each kind are kept.
//
// Merge: last-writer-wins per doc id under a Lamport clock. Each op carries
// (l, d): the device's Lamport time and its device id. An op replaces the doc
// when (l, d) is greater, comparing l first and d as a tiebreak, so every
// device that has seen the same ops holds the same docs, in any order and with
// repeats. A delete is a tombstone op and wins the same way.
'use strict';

const crypto = require('crypto');
const { redactSecrets } = require('../secret-patterns');

const STR = 200;
const KINDS = Object.freeze({
  memory: Object.freeze({ tool: 40, sid: 128, repo: STR, branch: STR, title: 160, started: 'n', ended: 'n', cost: 'n' }),
  checkpoint: Object.freeze({ sid: 128, repo: STR, source: 40, turns: 'n', updatedAt: 'n', skip: 80 }),
  handover: Object.freeze({ key: 160, title: 160, updatedAt: 'n', text: 64 * 1024 }),
  transcript: Object.freeze({ sid: 128, tool: 40, text: 256 * 1024 }),
});
const ID = /^[A-Za-z0-9_.:@/-]{1,300}$/;
const MAX_BATCH_BYTES = 256 * 1024;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Only the allowlisted fields of a kind, strings scrubbed then clipped. null = not syncable. */
function sanitize(kind, data, { allowTranscripts = false } = {}) {
  const spec = KINDS[kind];
  if (!spec || (kind === 'transcript' && !allowTranscripts) || !data || typeof data !== 'object') return null;
  const out = {};
  for (const [k, lim] of Object.entries(spec)) {
    const v = data[k];
    if (lim === 'n') { if (Number.isFinite(v)) out[k] = v; continue; }
    if (typeof v === 'string' && v) out[k] = clip(redactSecrets(v), lim);
  }
  return out;
}

const cmp = (a, b) => (a.l - b.l) || (a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
const hashOf = (kind, data, deleted) => crypto.createHash('sha256').update(JSON.stringify([kind, data ?? null, !!deleted])).digest('base64url');

function validOp(op) {
  return op && typeof op === 'object' && typeof op.id === 'string' && ID.test(op.id) && Object.hasOwn(KINDS, op.k)
    && Number.isSafeInteger(op.l) && op.l >= 1 && typeof op.d === 'string' && op.d.length >= 1 && op.d.length <= 128
    && (op.x === true ? op.v === undefined : op.v && typeof op.v === 'object');
}

/**
 * The document set of one device. state (persisted by the caller):
 *   {lamport, docs: {id: {k, v?, x?, l, d, h}}, pending: [op]}
 */
function createLog({ deviceId, state = null, allowTranscripts = false } = {}) {
  if (typeof deviceId !== 'string' || !deviceId) throw new Error('deviceId required');
  const s = { lamport: 0, docs: {}, pending: [], ...(state ?? {}) };

  function apply(op) {
    if (!validOp(op)) return false;
    s.lamport = Math.max(s.lamport, op.l);
    const cur = s.docs[op.id];
    if (cur && cmp(op, cur) <= 0) return false;
    const v = op.x ? undefined : sanitize(op.k, op.v, { allowTranscripts: true });
    if (!op.x && !v) return false;
    s.docs[op.id] = { k: op.k, ...(op.x ? { x: true } : { v }), l: op.l, d: op.d, h: hashOf(op.k, v, op.x) };
    return true;
  }

  function local(id, kind, v, deleted) {
    const h = hashOf(kind, v, deleted);
    const cur = s.docs[id];
    if (cur && cur.h === h) return null; // unchanged: no op
    if (!cur && deleted) return null;
    const op = { id, k: kind, l: s.lamport + 1, d: deviceId, ...(deleted ? { x: true } : { v }) };
    apply(op);
    s.pending.push(op);
    return op;
  }

  return {
    /** Set a doc from local data. Unchanged content makes no op. → op | null */
    put(id, kind, data) {
      if (typeof id !== 'string' || !ID.test(id)) return null;
      const v = sanitize(kind, data, { allowTranscripts });
      return v ? local(id, kind, v, false) : null;
    },
    /** Delete a doc (a tombstone op). → op | null */
    remove(id) {
      const cur = s.docs[id];
      return cur && !cur.x ? local(id, cur.k, undefined, true) : null;
    },
    /** Apply remote ops (any order, repeats fine). → number applied */
    merge(ops) {
      let n = 0;
      for (const op of Array.isArray(ops) ? ops : []) if (apply(op)) n++;
      return n;
    },
    /** Pending ops as batches of at most MAX_BATCH_BYTES of JSON; does not clear them. */
    batches(max = MAX_BATCH_BYTES) {
      const out = [];
      let cur = [];
      let size = 2;
      for (const op of s.pending) {
        const n = Buffer.byteLength(JSON.stringify(op)) + 1;
        if (cur.length && size + n > max) { out.push(cur); cur = []; size = 2; }
        cur.push(op); size += n;
      }
      if (cur.length) out.push(cur);
      return out;
    },
    /** Drop pending ops once uploaded. */
    sent(ops) {
      const done = new Set(ops);
      s.pending = s.pending.filter((op) => !done.has(op));
    },
    /** Live docs: {id: {kind, data}} (tombstones left out). */
    docs() {
      const out = {};
      for (const [id, d] of Object.entries(s.docs)) if (!d.x) out[id] = { kind: d.k, data: d.v };
      return out;
    },
    ids: () => Object.keys(s.docs).filter((id) => !s.docs[id].x),
    state: () => s,
  };
}

module.exports = { createLog, sanitize, KINDS, MAX_BATCH_BYTES };
