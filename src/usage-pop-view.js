// What the Usage pop-out shows, worked out from the per-turn usage the app
// already reads (usage.js). Pure. A row with nothing behind it is left out,
// never shown as 0 or "unknown". Claude Code writes nothing to disk about how
// much of the plan's 5-hour or weekly limit is used (spend.js says so), so
// there is no limit row: only figures this machine can really work out.
'use strict';

const { costOf, modelMix } = require('../usage.js');
const { startOfDay, startOfWeek, money } = require('../spend.js');

const NAMES = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

// New tokens only, as Spend counts them: cache reads are re-sent context.
function tokenText(n) {
  if (n >= 1e6) return `${(Math.round(n / 1e5) / 10).toFixed(1)}M tokens`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k tokens`;
  return `${n} tokens`;
}

function build(turns, { now = Date.now(), mode = 'api' } = {}) {
  const dayFrom = startOfDay(now);
  const weekFrom = startOfWeek(now);
  let day = 0, week = 0, tokens = 0, dayTurns = 0;
  for (const t of turns || []) {
    if (t.ts < weekFrom || t.ts > now) continue;
    const c = costOf(t);
    if (c == null) continue;
    week += c;
    if (t.ts >= dayFrom) { day += c; tokens += t.input + t.output + t.cacheWrite; dayTurns += 1; }
  }
  const rows = [];
  if (dayTurns) rows.push({ id: 'today', label: 'Today', value: `${money(day)} · ${tokenText(tokens)}` });
  if (week > 0) rows.push({ id: 'week', label: 'This week', value: money(week) });
  const top = dayTurns ? modelMix(turns, { now }).today.models[0] : null;
  if (top && day > 0) rows.push({ id: 'model', label: 'Top model today', value: `${NAMES[top.name] || top.name} · ${Math.round((top.cost / day) * 100)}% of spend` });
  return {
    rows,
    note: mode === 'subscription' ? 'API-price equivalent: your plan is not billed per token.' : 'Estimated at API list prices.',
    empty: rows.length ? null : 'Nothing recorded yet this week.',
  };
}

module.exports = { build, tokenText };
