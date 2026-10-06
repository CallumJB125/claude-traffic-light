import { fmtUsd } from './view.js';

// Per-card cost is the hub's rollup ({total_usd, reported_runs, unavailable_runs, status}).
// An AI with no dollar telemetry is "unavailable", never $0.
export function costText(cost) {
  if (!cost || cost.status === 'none') return null;
  if (cost.status === 'unavailable') return 'unavailable';
  const total = fmtUsd(Number(cost.total_usd.toFixed(2)));
  return cost.status === 'partial' ? `${total} + ${cost.unavailable_runs} run${cost.unavailable_runs > 1 ? 's' : ''} unavailable` : total;
}

// Board total over the cards in view, so it moves with live card updates.
export function boardCostRollup(views) {
  let usd = 0, reported = 0, unavailable = 0;
  for (const v of views) {
    const c = v.cost;
    if (!c || c.status === 'none') continue;
    reported += c.reported_runs; unavailable += c.unavailable_runs; usd += c.total_usd ?? 0;
  }
  return { total_usd: reported ? usd : null, reported_runs: reported, unavailable_runs: unavailable,
    status: !reported && !unavailable ? 'none' : !unavailable ? 'reported' : !reported ? 'unavailable' : 'partial' };
}

export function dailyCapText(daily) {
  return daily ? `${fmtUsd(daily.spent_usd)} of ${fmtUsd(daily.cap_usd)} today${daily.exceeded ? ': cap reached, new runs wait' : ''}` : null;
}
