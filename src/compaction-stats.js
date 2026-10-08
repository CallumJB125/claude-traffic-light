'use strict';
// Ledger for the in-app compactor. Stores numbers only: provider, time,
// context tokens before/after, what the compaction itself cost, and where
// each number came from. Never message text, session ids or provider targets.
//
// What is true, and so what is shown:
//  - reduced = before - after. before = input tokens the provider reported for
//    the last turn before compaction; after = input tokens it reported for the
//    first turn after (which also carries that turn's new message, so the
//    reduction is understated, never overstated). This is a one-time drop in
//    the context each later turn re-sends, not money saved.
//  - cost = the compaction turn's own tokens (input + output). A compaction
//    sends the whole context to a model, so it costs at least `before` input
//    tokens plus the summary. costSource 'provider' only when the provider
//    reported it; Codex 0.159 reports 0/0 for the compaction turn, which is
//    recorded as 'unknown', never as free.
//  - payback: the reduction pays for the cost only over FUTURE turns, after
//    about cost / reduced more turns. With an unknown cost the floor (the
//    context it had to read, `before`) gives "at least" that many turns,
//    labelled an estimate. No money figure is shown: nothing here records how
//    many turns followed, so a net saving is never claimed.
// source 'estimate' (both for reduction and cost): Plexiform-held histories,
// ~4 characters per token. Kept apart from provider-reported numbers.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PROVIDERS } = require('./compaction');

const MAX_ENTRIES = 100;
const VERSION = 2;
const SOURCES = ['provider', 'estimate'];
const COST_SOURCES = ['provider', 'estimate', 'unknown'];
const LOCK_WAIT_MS = 1000, LOCK_STALE_MS = 5000;
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const sint = (v) => (Number.isSafeInteger(v) ? v : 0);
const TOTAL_KEYS = ['compactions', 'measured', 'providerMeasured', 'reducedTokens', 'estimatedReducedTokens', 'costTokens', 'costReported', 'estimatedCostTokens', 'costUnknown', 'unknownCostFloorTokens'];
const SIGNED = new Set(['reducedTokens', 'estimatedReducedTokens']);

function emptyTotals() {
  return Object.fromEntries(PROVIDERS.map((p) => [p, Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0]))]));
}
function cleanEntry(e) {
  if (!e || typeof e !== 'object' || !PROVIDERS.includes(e.provider) || !SOURCES.includes(e.source) || !Number.isFinite(e.at)) return null;
  const before = int(e.before), after = int(e.after);
  const measured = before !== null && after !== null;
  const cost = int(e.cost);
  const costSource = cost !== null && COST_SOURCES.includes(e.costSource) && e.costSource !== 'unknown' ? e.costSource : 'unknown';
  return { at: e.at, provider: e.provider, source: e.source, before: measured ? before : null, after: measured ? after : null, reduced: measured ? before - after : null, cost: costSource === 'unknown' ? null : cost, costSource };
}
function cleanTotals(t) {
  const out = emptyTotals();
  if (!t || typeof t !== 'object') return out;
  for (const p of PROVIDERS) {
    const v = t[p];
    if (!v || typeof v !== 'object') continue;
    for (const k of TOTAL_KEYS) out[p][k] = SIGNED.has(k) ? sint(v[k]) : int(v[k]) ?? 0;
  }
  return out;
}
// v1 stored {compactions, measured, savedTokens, estimatedTokens} and entries
// with `saved`; it never recorded the compaction's own cost, so every v1
// compaction migrates with an unknown cost.
function migrateV1(raw) {
  const totals = emptyTotals();
  const t = raw.totals && typeof raw.totals === 'object' ? raw.totals : {};
  for (const p of PROVIDERS) {
    const v = t[p] && typeof t[p] === 'object' ? t[p] : {};
    totals[p].compactions = int(v.compactions) ?? 0;
    totals[p].measured = int(v.measured) ?? 0;
    totals[p].reducedTokens = sint(v.savedTokens);
    totals[p].estimatedReducedTokens = sint(v.estimatedTokens);
    // v1 did not split measured by source; only local entries were estimates.
    totals[p].providerMeasured = p === 'local' ? 0 : totals[p].measured;
    totals[p].costUnknown = totals[p].compactions;
  }
  const entries = (Array.isArray(raw.entries) ? raw.entries : []).map((e) => cleanEntry({ ...e, cost: null, costSource: 'unknown' })).filter(Boolean).slice(-MAX_ENTRIES);
  // Only the retained entries know their `before`: a smaller floor is still a floor.
  for (const e of entries) if (e.source === 'provider' && e.before !== null) totals[e.provider].unknownCostFloorTokens += e.before;
  return { v: VERSION, totals, entries };
}
const empty = () => ({ v: VERSION, totals: emptyTotals(), entries: [] });

// Turns until a one-time reduction has paid for its cost. `atLeast` when the
// cost is a floor (unknown cost) rather than a recorded number.
function payback(cost, reduced, basis) {
  if (!Number.isFinite(reduced)) return { kind: 'unmeasured' };
  if (reduced <= 0) return { kind: 'never', reduced };
  if (!Number.isFinite(cost)) return { kind: 'unknown' };
  return { kind: basis === 'floor' ? 'at-least' : 'about', turns: Math.max(1, Math.ceil(cost / reduced)), basis };
}
function entryPayback(e) {
  if (e.reduced === null) return payback(NaN, NaN);
  if (e.costSource !== 'unknown') return payback(e.cost, e.reduced, e.costSource);
  return e.source === 'provider' ? payback(e.before, e.reduced, 'floor') : payback(NaN, e.reduced);
}

function createLedger({ file = null, fsImpl = fs } = {}) {
  let data = empty();
  // Wrong version or unreadable: kept beside the ledger, never discarded.
  function quarantine() {
    let dest = `${file}.corrupt`;
    try { fsImpl.statSync(dest); dest = `${file}.corrupt-${Date.now()}`; } catch { /* free */ }
    try { fsImpl.renameSync(file, dest); } catch { /* gone already */ }
  }
  function load() {
    if (!file) return data;
    let text;
    try { text = fsImpl.readFileSync(file, 'utf8'); } catch (err) { return err.code === 'ENOENT' ? empty() : data; }
    let raw;
    try { raw = JSON.parse(text); } catch { raw = null; }
    if (raw && typeof raw === 'object' && raw.v === VERSION) return { v: VERSION, totals: cleanTotals(raw.totals), entries: (Array.isArray(raw.entries) ? raw.entries : []).map(cleanEntry).filter(Boolean).slice(-MAX_ENTRIES) };
    if (raw && typeof raw === 'object' && raw.v === 1) return migrateV1(raw);
    quarantine();
    return empty();
  }
  data = load();
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  // Two app instances may share the file: each write re-reads under a lock
  // file and merges its entry into what is on disk.
  function lock() {
    const lf = `${file}.lock`, end = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try { fsImpl.closeSync(fsImpl.openSync(lf, 'wx', 0o600)); return () => { try { fsImpl.unlinkSync(lf); } catch { /* gone */ } }; } catch (err) { if (err.code !== 'EEXIST') return () => {}; }
      try { if (Date.now() - fsImpl.statSync(lf).mtimeMs > LOCK_STALE_MS) { fsImpl.unlinkSync(lf); continue; } } catch { continue; }
      if (Date.now() > end) return () => {};
      sleep(10);
    }
  }
  function save() {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fsImpl.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fsImpl.renameSync(tmp, file);
    } catch (err) { try { fsImpl.unlinkSync(tmp); } catch { /* none */ } throw err; }
  }
  function apply(e) {
    const t = data.totals[e.provider];
    t.compactions++;
    if (e.reduced !== null) {
      t.measured++;
      if (e.source === 'provider') { t.providerMeasured++; t.reducedTokens += e.reduced; } else t.estimatedReducedTokens += e.reduced;
    }
    if (e.costSource === 'provider') { t.costTokens += e.cost; t.costReported++; }
    else if (e.costSource === 'estimate') t.estimatedCostTokens += e.cost;
    else {
      t.costUnknown++;
      if (e.source === 'provider' && e.before !== null) t.unknownCostFloorTokens += e.before;
    }
    data.entries.push(e);
    if (data.entries.length > MAX_ENTRIES) data.entries.splice(0, data.entries.length - MAX_ENTRIES);
  }
  function record(input) {
    const e = cleanEntry(input);
    if (!e) return null;
    if (!file) { apply(e); return e; }
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const unlock = lock();
    try { data = load(); apply(e); save(); } finally { unlock(); }
    return e;
  }
  // What Preferences shows. Provider-reported and estimated numbers stay apart.
  function summary() {
    data = load();
    const providers = {};
    const total = Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0]));
    for (const p of PROVIDERS) {
      providers[p] = { ...data.totals[p] };
      for (const k of TOTAL_KEYS) total[k] += data.totals[p][k];
    }
    // Provider-measured reductions against every provider compaction's cost.
    // Any unknown cost makes the answer a floor ("at least").
    const reduced = total.providerMeasured ? total.reducedTokens : NaN;
    const costKnown = total.costReported > 0 || total.unknownCostFloorTokens > 0;
    total.payback = payback(costKnown ? total.costTokens + total.unknownCostFloorTokens : NaN, reduced, total.costUnknown > 0 ? 'floor' : 'provider');
    const l = data.entries[data.entries.length - 1];
    const last = l ? { ...l, payback: entryPayback(l) } : null;
    return { providers, total, last, moneyShown: false };
  }
  const entries = () => data.entries.map((e) => ({ ...e }));
  return { record, summary, entries };
}

module.exports = { createLedger, MAX_ENTRIES, VERSION };
