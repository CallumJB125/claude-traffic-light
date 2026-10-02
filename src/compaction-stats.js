'use strict';
// Savings ledger for the in-app compactor. Stores numbers only: provider,
// time, context tokens before/after, and where they came from. Never message
// text, session ids or provider targets.
//
// source 'provider': before = input tokens the provider reported for the last
//   turn before compaction; after = input tokens it reported for the first
//   turn after (which also includes that turn's new message, so the saving is
//   understated, never overstated). Later turns benefit too; not counted.
// source 'estimate': Plexiform-held histories, ~4 characters per token.
// A compaction whose before/after was not reported is counted but adds no
// tokens: no savings number is shown without a recorded before/after.
const fs = require('node:fs');
const path = require('node:path');
const { PROVIDERS } = require('./compaction');

const MAX_ENTRIES = 100;
const VERSION = 1;
// USD per million input tokens, list price, for a rough estimate only.
// Cached input is cheaper, so this can overstate the money saved.
const DEFAULT_PRICES = Object.freeze({ codex: 1.25, claude: 3, gemini: 1.25, local: 0 });
const SOURCES = ['provider', 'estimate'];
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

function emptyTotals() {
  return Object.fromEntries(PROVIDERS.map((p) => [p, { compactions: 0, measured: 0, savedTokens: 0, estimatedTokens: 0 }]));
}
function cleanEntry(e) {
  if (!e || typeof e !== 'object' || !PROVIDERS.includes(e.provider) || !SOURCES.includes(e.source) || !Number.isFinite(e.at)) return null;
  const before = int(e.before), after = int(e.after);
  const measured = before !== null && after !== null;
  return { at: e.at, provider: e.provider, source: e.source, before: measured ? before : null, after: measured ? after : null, saved: measured ? before - after : null };
}
function cleanTotals(t) {
  const out = emptyTotals();
  if (!t || typeof t !== 'object') return out;
  for (const p of PROVIDERS) {
    const v = t[p];
    if (!v || typeof v !== 'object') continue;
    for (const k of ['compactions', 'measured']) out[p][k] = int(v[k]) ?? 0;
    for (const k of ['savedTokens', 'estimatedTokens']) out[p][k] = Number.isSafeInteger(v[k]) ? v[k] : 0;
  }
  return out;
}

function createLedger({ file = null, prices = () => DEFAULT_PRICES, fsImpl = fs } = {}) {
  let data = { v: VERSION, totals: emptyTotals(), entries: [] };
  if (file) {
    try {
      const raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      if (raw && raw.v === VERSION) data = { v: VERSION, totals: cleanTotals(raw.totals), entries: (Array.isArray(raw.entries) ? raw.entries : []).map(cleanEntry).filter(Boolean).slice(-MAX_ENTRIES) };
    } catch { /* none yet, or unreadable: start empty */ }
  }
  function save() {
    if (!file) return;
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(data));
    fsImpl.renameSync(tmp, file);
  }
  function record(input) {
    const e = cleanEntry(input);
    if (!e) return null;
    const t = data.totals[e.provider];
    t.compactions++;
    if (e.saved !== null) {
      t.measured++;
      if (e.source === 'provider') t.savedTokens += e.saved; else t.estimatedTokens += e.saved;
    }
    data.entries.push(e);
    if (data.entries.length > MAX_ENTRIES) data.entries.splice(0, data.entries.length - MAX_ENTRIES);
    save();
    return e;
  }
  function priceOf(p) {
    const v = prices()?.[p];
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_PRICES[p];
  }
  // What Preferences shows. dollars are estimates from the price table.
  function summary() {
    const providers = {};
    let compactions = 0, measured = 0, savedTokens = 0, estimatedTokens = 0, dollars = 0;
    for (const p of PROVIDERS) {
      const t = data.totals[p];
      const d = (t.savedTokens + t.estimatedTokens) * priceOf(p) / 1e6;
      providers[p] = { ...t, estimatedDollars: d, pricePerMillion: priceOf(p) };
      compactions += t.compactions; measured += t.measured; savedTokens += t.savedTokens; estimatedTokens += t.estimatedTokens; dollars += d;
    }
    const last = data.entries.length ? { ...data.entries[data.entries.length - 1] } : null;
    return { providers, total: { compactions, measured, savedTokens, estimatedTokens, estimatedDollars: dollars }, last, dollarsAreEstimates: true };
  }
  const entries = () => data.entries.map((e) => ({ ...e }));
  return { record, summary, entries };
}

module.exports = { createLedger, DEFAULT_PRICES, MAX_ENTRIES };
