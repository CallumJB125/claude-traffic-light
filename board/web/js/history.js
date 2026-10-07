// History view: pure layout from the hub's runs to swimlane bars. Time is milliseconds;
// x is a 0..1 fraction of the window so the renderer can use percentages.

export const RANGES = [{ id: 'today', label: 'Today' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }];
const DAY = 86_400_000;

export const LANES = [
  { id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }, { id: 'gemini', label: 'Gemini' },
  { id: 'hermes', label: 'Hermes' }, { id: 'observed', label: 'Observed' },
];

// Outcome: label, icon and tone token (never colour alone: the icon and label travel with every bar).
export const OUTCOMES = {
  running: { label: 'Running', icon: 'lamp', tone: 'green' },
  finished: { label: 'Finished', icon: 'check', tone: 'done' },
  stopped: { label: 'Stopped', icon: 'stop', tone: 'grey' },
  failed: { label: 'Failed', icon: 'cross', tone: 'red' },
  stalled: { label: 'Stalled', icon: 'warn', tone: 'amber' },
  budget: { label: 'Hit budget', icon: 'warn', tone: 'amber' },
  limit: { label: 'Hit limit', icon: 'clock', tone: 'violet' },
  observed: { label: 'Observed', icon: 'eye', tone: 'quiet' },
};

/** The window for a range, anchored on `now` (local days; Today runs from midnight to the hour after next). */
export function rangeWindow(range, now) {
  const d = new Date(now);
  const days = range === '30d' ? 30 : range === '7d' ? 7 : 1;
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1 - days).getTime(), midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  // Today stops an hour past now so a morning of work is not squeezed into a sliver of a 24 h axis.
  const to = range === 'today' ? Math.min(midnight, new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 2).getTime()) : midnight;
  return { from, to };
}

/** Time to a 0..1 position in the window (clamped). */
export function timeToX(ms, from, to) {
  return to > from ? Math.min(1, Math.max(0, (ms - from) / (to - from))) : 0;
}

/** Greedy interval packing: each bar gets the lowest row whose last bar ended before this one starts (plus a gap). */
export function packRows(bars, gap = 0) {
  const sorted = [...bars].sort((a, b) => a.x0 - b.x0 || a.x1 - b.x1);
  const ends = [];
  for (const b of sorted) {
    let row = ends.findIndex((end) => b.x0 >= end + gap);
    if (row < 0) { row = ends.length; ends.push(0); }
    ends[row] = b.x1;
    b.row = row;
  }
  return ends.length;
}

const laneOfAi = (ai) => (ai === 'hermes-dgx' ? 'hermes' : LANES.some((l) => l.id === ai) ? ai : 'claude');
const MIN_W = 0.025;

/** Hub reply + window -> lanes of positioned bars, a summary strip, axis ticks and the now marker. */
export function buildHistory({ data, from, to, now }) {
  const bars = [];
  for (const r of data?.runs ?? []) {
    const start = Date.parse(r.started_at), end = r.ended_at ? Date.parse(r.ended_at) : now;
    bars.push({ id: r.id, lane: laneOfAi(r.ai), card_id: r.card_id, key: r.key, title: r.title, ai_label: r.ai_label,
      outcome: r.outcome, start, end, running: !r.ended_at, cost_usd: r.cost_usd ?? null, has_handover: !!r.has_handover, observed: false });
  }
  for (const o of data?.observed ?? []) {
    const start = Date.parse(o.started_at), end = o.ended_at ? Date.parse(o.ended_at) : Date.parse(o.last_seen_at ?? o.started_at);
    bars.push({ id: `obs:${o.card_id}`, lane: 'observed', card_id: o.card_id, key: o.key, title: o.title, ai_label: o.provider,
      outcome: 'observed', start, end: Math.max(start, end), running: false, cost_usd: null, has_handover: false, observed: true });
  }
  for (const b of bars) {
    b.x0 = timeToX(b.start, from, to);
    b.x1 = Math.max(timeToX(Math.min(b.end, to), from, to), Math.min(1, b.x0 + MIN_W));
    b.durationMs = Math.max(0, b.end - b.start);
  }
  const lanes = LANES.map((l) => {
    const own = bars.filter((b) => b.lane === l.id);
    const rows = packRows(own, MIN_W / 2);
    return { ...l, bars: own.sort((a, b) => a.start - b.start), rows: Math.max(1, rows) };
  });
  const runBars = bars.filter((b) => !b.observed);
  const known = runBars.filter((b) => b.cost_usd != null);
  const summary = {
    runs: runBars.length,
    workedMs: unionMs(runBars, from, to),
    spendUsd: known.length ? known.reduce((s, b) => s + b.cost_usd, 0) : null,
    spendUnknown: runBars.length - known.length,
    stalled: runBars.filter((b) => b.outcome === 'stalled').length,
  };
  return { lanes, summary, empty: !bars.length, nowX: now >= from && now <= to ? timeToX(now, from, to) : null, truncated: !!data?.truncated };
}

/** Time covered by at least one run, so two AIs working at once count once. */
export function unionMs(bars, from, to) {
  const spans = bars.map((b) => [Math.max(b.start, from), Math.min(b.end, to)]).filter(([a, z]) => z > a).sort((a, b) => a[0] - b[0]);
  let total = 0, cur = null;
  for (const [a, z] of spans) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], z);
    else { if (cur) total += cur[1] - cur[0]; cur = [a, z]; }
  }
  return cur ? total + cur[1] - cur[0] : total;
}

/** Axis ticks: every 1 to 3 hours for Today, each day for 7 days, about every 5 days for 30. */
export function axisTicks(range, from, to) {
  const out = [];
  const step = range === 'today' ? (to - from > 12 * 3_600_000 ? 3 : to - from > 6 * 3_600_000 ? 2 : 1) * 3_600_000 : range === '7d' ? DAY : 5 * DAY;
  for (let t = from; t < to; t += step) {
    const d = new Date(t);
    out.push({ x: timeToX(t, from, to), label: range === 'today' ? `${String(d.getHours()).padStart(2, '0')}:00` : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) });
  }
  return out;
}

/** Arrow-key target: left/right walk a lane in time order, up/down hop to the nearest bar in the next lane that has any. */
export function neighborBar(lanes, id, key) {
  const li = lanes.findIndex((l) => l.bars.some((b) => b.id === id));
  if (li < 0) return null;
  const bars = lanes[li].bars, i = bars.findIndex((b) => b.id === id);
  if (key === 'ArrowRight') return bars[i + 1]?.id ?? null;
  if (key === 'ArrowLeft') return bars[i - 1]?.id ?? null;
  const dir = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
  if (!dir) return null;
  for (let j = li + dir; j >= 0 && j < lanes.length; j += dir) {
    if (!lanes[j].bars.length) continue;
    const mid = bars[i].start;
    return lanes[j].bars.reduce((best, b) => (Math.abs(b.start - mid) < Math.abs(best.start - mid) ? b : best)).id;
  }
  return null;
}

export const durationText = (ms) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'under a minute';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
};

/** The reason a bar has no handover to show. */
export function noHandoverReason(bar) {
  if (bar.observed) return 'This session was observed, not run by the board, so it has no handover.';
  if (bar.running) return 'The run is still going. The handover is written when it stops.';
  if (bar.outcome === 'failed' || bar.outcome === 'stopped') return 'The run ended before a handover was saved.';
  return 'No handover was saved for this run.';
}
