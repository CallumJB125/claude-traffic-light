'use strict';
// Cost guard: the monthly "Plexiform saved you $X" receipt. Every figure says
// how it was worked out and where it came from, and nothing is claimed that
// Plexiform didn't do:
//   saved      what Plexiform's own cost guard stopped this month (its log
//              of runaway sessions it stopped and caps it held), as a range
//   couldSave  routine Opus turns this month priced at Sonnet (usage.js
//              modelMix's test): advice, never counted as saved
//   burst      Claude Burst's compaction savings from its /api/history,
//              only when Burst is present, and always shown as Burst's
// Local only: Burst is read through src/burst-client.js (loopback, its
// existing flow); everything else is transcripts and the app's own log.
const Usage = require('../usage.js');
const { historyView } = require('./burst-requests.js');

const r2 = (n) => Math.round(n * 100) / 100;
const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
const rangeText = (lo, hi) => (money(lo) === money(hi) ? money(hi) : `${money(lo)}–${money(hi)}`);
const isRoutine = (t) => t.output <= Usage.ROUTINE_OUTPUT && t.input + t.cacheWrite <= Usage.ROUTINE_NEW_INPUT;

const SOURCES = {
  transcripts: 'Estimate from your Claude Code transcripts at API list prices',
  log: "Plexiform's cost guard log on this computer",
  burst: 'Claude Burst /api/history (compaction savings, API-equivalent prices)',
};
const METHODS = {
  saved: 'Each runaway session Plexiform stopped counts as one more runaway window at half to all of the spend it was stopped at. Budget caps held are counted, not priced.',
  couldSave: 'Opus turns with a reply under 400 tokens on under 4k new tokens of context, priced at Sonnet rates; the low end allows 35% more tokens on Sonnet. Not a saving until you switch.',
  burst: "Summed per repository as Burst reports it. Burst's savings, not Plexiform's.",
};

function monthOf(now) {
  const d = new Date(now);
  const from = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return { from, to: now, label: d.toLocaleString('en-US', { month: 'long', year: 'numeric' }), days: Math.floor((now - from) / 86400000) + 1 };
}

function couldSaveOf(turns, from, to) {
  let n = 0, low = 0, high = 0;
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || t.ts < from || t.ts > to || t.modelKey !== 'opus' || !isRoutine(t)) continue;
    const cost = Usage.costOf(t);
    const sonnet = Usage.costOf(t, 'sonnet');
    if (cost == null || sonnet == null) continue;
    n += 1;
    low += Math.max(0, cost - sonnet * Usage.SLACK);
    high += Math.max(0, cost - sonnet);
  }
  return { turns: n, low: r2(low), high: r2(high) };
}

function savedOf(log, from, to) {
  let low = 0, high = 0, runaways = 0, caps = 0;
  for (const e of Array.isArray(log) ? log : []) {
    if (!e || !Number.isFinite(e.at) || e.at < from || e.at > to) continue;
    if (e.kind === 'runaway' && e.stopped) {
      const c = Number.isFinite(e.cost) && e.cost > 0 ? e.cost : 0;
      runaways += 1; low += c / 2; high += c;
    } else if (e.kind === 'cap') caps += 1;
  }
  return { low: r2(low), high: r2(high), runawaysStopped: runaways, capsHeld: caps };
}

// → {savedUsd, days, source, method} when Burst is present and answers; else {available:false, reason}.
async function burstSaved(burst, days) {
  if (!burst || typeof burst.detect !== 'function') return { available: false, reason: 'not-checked' };
  try {
    const d = await burst.detect();
    if (!d || d.kind !== 'present') return { available: false, reason: d?.kind || 'absent' };
    const h = historyView(await burst.history({ days: Math.min(90, Math.max(1, days)) }));
    const saved = h.repos.reduce((n, r) => n + r.savedUsd, 0);
    return { available: true, savedUsd: r2(saved), days, source: SOURCES.burst, method: METHODS.burst };
  } catch { return { available: false, reason: 'unreachable' }; }
}

/**
 * {now, turns, log, burst: {detect, history}?, full}. full=false is the free
 * teaser: the headline and its source only.
 */
async function build({ now = Date.now(), turns = [], log = [], burst = null, full = false } = {}) {
  const m = monthOf(now);
  const saved = savedOf(log, m.from, m.to);
  const could = couldSaveOf(turns, m.from, m.to);
  const b = await burstSaved(burst, m.days);
  const burstLine = b.available ? `Claude Burst saved ${money(b.savedUsd)} by compaction (Burst's figure, not Plexiform's)` : null;
  const inMonth = (ms) => ms >= m.from && ms <= m.to;
  const active = (Array.isArray(turns) ? turns : []).some((t) => t && inMonth(t.ts)) || (Array.isArray(log) ? log : []).some((e) => e && inMonth(e.at));
  if (!full) {
    const headline = !active ? 'No activity yet this month' : could.high > 0
      ? `About ${rangeText(could.low, could.high)} of your Opus spend in ${m.label} looked routine enough for Sonnet`
      : `No routine Opus spend found in ${m.label}`;
    return { teaser: true, month: m.label, range: { from: m.from, to: m.to }, headline, source: SOURCES.transcripts, burst: b.available ? { savedUsd: b.savedUsd, source: b.source, line: burstLine } : null };
  }
  const headline = !active && !(saved.high > 0) ? 'No activity yet this month' : saved.high > 0
    ? `Plexiform saved you about ${rangeText(saved.low, saved.high)} in ${m.label}`
    : `Plexiform hasn't had to stop any spend in ${m.label}`;
  return {
    teaser: false, month: m.label, range: { from: m.from, to: m.to }, headline,
    saved: { ...saved, source: SOURCES.log, method: METHODS.saved },
    couldSave: { ...could, source: SOURCES.transcripts, method: METHODS.couldSave, line: could.high > 0 ? `You could save ${rangeText(could.low, could.high)} more by running ${could.turns} routine Opus turn${could.turns === 1 ? '' : 's'} on Sonnet` : null },
    burst: b.available ? { savedUsd: b.savedUsd, source: b.source, method: b.method, line: burstLine } : null,
  };
}

module.exports = { build, monthOf, couldSaveOf, savedOf, burstSaved, SOURCES, METHODS };
