// Two thin rings around the character: how long the current turn has run
// against the person's usual turn, and today's spend against the daily
// budget. Pure: no Electron, no DOM. Plain script for the widget
// (window.WidgetRingsView) and CommonJS for Node and main.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WidgetRingsView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Fewer closed turns than this and "usual" means nothing yet.
  const MIN_TURNS = 3;
  const MAX_TURNS = 30;
  // A turn shorter than this is a quick exchange, not a measure of the usual.
  const MIN_TURN_MS = 5000;
  const BANDS = Object.freeze({ green: 'green', amber: 'amber', red: 'red' });
  const NONE = Object.freeze({ show: false, fraction: 0, over: false, label: '', band: null });

  const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const round = (v) => Math.round(v * 1000) / 1000;

  function median(values) {
    const xs = (Array.isArray(values) ? values : []).map(finite).filter((v) => v !== null && v >= 0).sort((a, b) => a - b);
    if (!xs.length) return null;
    const mid = xs.length >> 1;
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  }

  // Durations of recent closed turns → the usual turn length, or null until
  // there are enough of them.
  function usualTurnMs(durations, { min = MIN_TURNS } = {}) {
    const xs = (Array.isArray(durations) ? durations : []).map(finite).filter((v) => v !== null && v >= MIN_TURN_MS).slice(-MAX_TURNS);
    return xs.length >= min ? median(xs) : null;
  }

  // Keep a bounded, most-recent-last list of closed turn durations.
  function recordTurn(durations, ms, { max = MAX_TURNS } = {}) {
    const list = Array.isArray(durations) ? durations.slice() : [];
    const v = finite(ms);
    if (v === null || v < 0) return list;
    list.push(v);
    return list.slice(Math.max(0, list.length - max));
  }

  function duration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  // The turn ring: elapsed since `startedAt` as a share of `usualMs`
  // (durations may be given instead and the median is taken). Nothing to
  // show without a running turn or a usual to compare it with.
  function turnRing({ startedAt, now, usualMs, durations } = {}) {
    const t = finite(now) ?? Date.now();
    const start = finite(startedAt);
    const usual = finite(usualMs) ?? usualTurnMs(durations);
    if (start === null || usual === null || usual <= 0) return NONE;
    const elapsed = Math.max(0, t - start);
    const fraction = clamp01(elapsed / usual);
    const over = elapsed > usual;
    return {
      show: true,
      fraction: round(fraction),
      over,
      band: over ? BANDS.amber : BANDS.green,
      label: `This turn ${duration(elapsed)} · your usual ${duration(usual)}${over ? ' · longer than usual' : ''}`,
    };
  }

  const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);

  // The spend ring: today's spend against the daily budget, with the budget's
  // own warning threshold (`warnAt`, 0.8 by default) deciding amber. No budget set → nothing.
  function spendRing({ today, budget, warnAt = 0.8 } = {}) {
    const spent = finite(today);
    const cap = finite(budget);
    if (spent === null || spent < 0 || cap === null || cap <= 0) return NONE;
    const share = spent / cap;
    const over = share >= 1;
    const warn = clamp01(finite(warnAt) ?? 0.8);
    return {
      show: true,
      fraction: round(clamp01(share)),
      over,
      band: over ? BANDS.red : share >= warn ? BANDS.amber : BANDS.green,
      label: `${money(spent)} of ${money(cap)} today${over ? ' · over budget' : ''}`,
    };
  }

  // Both rings from the live state main holds, plus whether anything shows.
  function rings({ turn = {}, spend = {} } = {}) {
    const t = turnRing(turn);
    const s = spendRing(spend);
    return { turn: t, spend: s, show: t.show || s.show };
  }

  return { MIN_TURNS, MAX_TURNS, MIN_TURN_MS, BANDS, NONE, median, usualTurnMs, recordTurn, duration, turnRing, spendRing, rings };
});
