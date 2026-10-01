// What the Usage pop-out shows, worked out from the per-turn usage the app
// already reads (usage.js). Pure. A row with nothing behind it is left out,
// never shown as 0 or "unknown". Claude Code writes nothing to disk about how
// much of the plan's 5-hour or weekly limit is used (spend.js says so), so
// there is no limit row: only figures this machine can really work out.
'use strict';

const { costOf } = require('../usage.js');
const { startOfDay, startOfWeek, money } = require('../spend.js');

const family = (k) => (k === 'fable-5' ? 'fable' : k);
const NAMES = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

// New tokens only, as Spend counts them: cache reads are re-sent context, so
// the words say "new".
function tokenText(n) {
  if (n >= 1e6) return `${(Math.round(n / 1e5) / 10).toFixed(1)}M new tokens`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k new tokens`;
  return `${n} new tokens`;
}

function build(turns, { now = Date.now(), mode = 'api' } = {}) {
  const dayFrom = startOfDay(now);
  const weekFrom = startOfWeek(now);
  let day = 0, week = 0, tokens = 0, dayTurns = 0;
  const byModel = {};
  for (const t of turns || []) {
    if (t.ts < weekFrom || t.ts > now) continue;
    const c = costOf(t);
    if (c == null) continue;
    week += c;
    if (t.ts >= dayFrom) { day += c; tokens += t.input + t.output + t.cacheWrite; dayTurns += 1; byModel[family(t.modelKey)] = (byModel[family(t.modelKey)] || 0) + c; }
  }
  const rows = [];
  if (dayTurns) rows.push({ id: 'today', label: 'Today', value: `${money(day)} · ${tokenText(tokens)}` });
  if (week >= 0.005) rows.push({ id: 'week', label: 'This week', value: money(week) });
  // Shares come from the unrounded per-model costs, and a spend that rounds to $0.00 has no meaningful split.
  const top = Object.entries(byModel).sort((x, y) => y[1] - x[1])[0];
  if (top && day >= 0.01) rows.push({ id: 'model', label: 'Busiest model today', value: `${NAMES[top[0]] || top[0]} · ${Math.min(100, Math.max(0, Math.round((top[1] / day) * 100)))}% of spend` });
  return {
    rows,
    note: mode === 'subscription' ? 'Estimated from published per-token prices; your plan is not billed per token.' : 'Estimated from published per-token prices.',
    empty: rows.length ? null : 'Nothing recorded yet this week.',
  };
}

module.exports = { build, tokenText };
