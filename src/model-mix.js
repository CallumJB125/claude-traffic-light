'use strict';
// Model mix and the routine-Opus saving estimate, shared by the Lights card
// (usage.js modelMix), mcp-server buddy_model_mix, the Usage page's saving
// line and the weekly digest. A "routine" turn wrote a short reply on little
// new context (a tool round-trip, a quick answer): the kind a cheaper model
// usually handles as well. Pure: turns in, numbers and words out.
const Usage = require('../usage.js');

const DAY_MS = 86400000;
const isRoutine = (t) => t.output <= Usage.ROUTINE_OUTPUT && t.input + t.cacheWrite <= Usage.ROUTINE_NEW_INPUT;
const family = (k) => (k === 'fable-5' ? 'fable' : k);
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const r2 = (n) => Math.round(n * 100) / 100;
const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);

// Opus turns in [from, now], how many looked routine, and what those would
// have cost less on Sonnet (low end assumes Sonnet needs Usage.SLACK more).
function routineEstimate(turns, { from, now = Date.now() } = {}) {
  let opus = 0, routine = 0, low = 0, high = 0;
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || t.ts < from || t.ts > now || t.modelKey !== 'opus') continue;
    opus += 1;
    if (!isRoutine(t)) continue;
    routine += 1;
    const cost = Usage.costOf(t);
    const sonnet = Usage.costOf(t, 'sonnet');
    low += Math.max(0, cost - sonnet * Usage.SLACK);
    high += Math.max(0, cost - sonnet);
  }
  return { turns: opus, routine, share: opus ? routine / opus : 0, saving: { low: r2(low), high: r2(high) } };
}

const rangeText = (s) => (money(s.low) === money(s.high) ? money(s.high) : `${money(s.low)}–${money(s.high)}`);

// The one saving suggestion for the Usage page and the weekly digest; null
// when there is nothing worth suggesting.
function savingLine(est) {
  if (!est || !est.routine || !(est.saving.high > 0)) return null;
  return `About ${Math.round(est.share * 100)}% of this week's Opus turns looked routine; Sonnet would have cost ${rangeText(est.saving)} less.`;
}

function modelMix(turns, { now = Date.now() } = {}) {
  const windowOf = (from) => {
    const models = {};
    let cost = 0, count = 0;
    for (const t of turns) {
      if (t.ts < from || t.ts > now) continue;
      const c = Usage.costOf(t);
      if (c == null) continue;
      const m = models[family(t.modelKey)] || (models[family(t.modelKey)] = { turns: 0, cost: 0 });
      m.turns += 1;
      m.cost += c;
      cost += c;
      count += 1;
    }
    const list = Object.entries(models).map(([name, m]) => ({ name, turns: m.turns, cost: r2(m.cost), share: count ? m.turns / count : 0 })).sort((a, b) => b.cost - a.cost);
    return { from, turns: count, cost: r2(cost), models: list };
  };
  const today = windowOf(startOfDay(now));
  const weekFrom = startOfDay(now - 6 * DAY_MS);
  const week = windowOf(weekFrom);
  const opus = routineEstimate(turns, { from: weekFrom, now });
  const recommendation = !opus.turns
    ? 'No Opus turns in the last 7 days — nothing to suggest.'
    : !opus.routine
      ? 'Your Opus turns in the last 7 days all did substantial work — Opus looks well spent.'
      : `${Math.round(opus.share * 100)}% of your Opus turns in the last 7 days looked routine (short reply, little new context); on Sonnet they would have cost about ${rangeText(opus.saving)} less.`;
  return { today, week, opus, recommendation };
}

module.exports = { isRoutine, routineEstimate, savingLine, modelMix, startOfDay, DAY_MS };
