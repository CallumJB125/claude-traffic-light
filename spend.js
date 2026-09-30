// Spend guardrails: daily/weekly budgets and runaway-session detection,
// computed from the per-turn usage usage.js reads out of the transcripts.
// Pure: main.js and mcp-server.js hand it turns (sorted by time, as
// Usage.readTurns returns them) and the saved `spend` config.
//
// Subscribers are not billed per token, and nothing Claude Code writes to
// disk says how much of the plan's usage window is gone (the statusline's
// `rate_limits` only reaches a statusline command). So a subscriber's budget
// is the same API-price estimate, labelled as an equivalent.
const { costOf } = require('./usage.js');

const DAY_MS = 86400000;
const MODES = ['api', 'subscription'];
// Runaway default: above the p99 of Callum's real 20-minute session spend
// (fixed 20-min buckets per session over 42 days / 233 sessions: p99 $35.24,
// p99.9 $55; see the F1 commit). $40 fired on 4 sessions in those 42 days.
const DEFAULTS = {
  mode: 'api',
  dailyBudget: 0,
  weeklyBudget: 0,
  warnAt: 0.8,
  runawayDollars: 40,
  runawayMinutes: 20,
  runawayTokens: 0,
  notifyRunaway: true,
  notifyBudget: true,
};

const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function normalize(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  return {
    mode: MODES.includes(s.mode) ? s.mode : DEFAULTS.mode,
    dailyBudget: num(s.dailyBudget, 0, 1e6, DEFAULTS.dailyBudget),
    weeklyBudget: num(s.weeklyBudget, 0, 1e7, DEFAULTS.weeklyBudget),
    warnAt: num(s.warnAt, 0.1, 1, DEFAULTS.warnAt),
    runawayDollars: num(s.runawayDollars, 0, 1e5, DEFAULTS.runawayDollars),
    runawayMinutes: num(s.runawayMinutes, 1, 240, DEFAULTS.runawayMinutes),
    runawayTokens: num(s.runawayTokens, 0, 1e10, DEFAULTS.runawayTokens),
    notifyRunaway: s.notifyRunaway !== false,
    notifyBudget: s.notifyBudget !== false,
  };
}

const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
// Budget weeks run Monday to Sunday, local time.
function startOfWeek(ms) {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
// New tokens only: cache reads are re-sent context, not work.
const tokensOf = (t) => t.input + t.output + t.cacheWrite;

// Walks back from the newest turn, so a poll costs the turns since `from`,
// not the whole 60-day history.
function sinceScan(turns, from, now, fn) {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t.ts < from) break;
    if (t.ts > now) continue;
    fn(t);
  }
}

function period(spent, budget, warnAt) {
  const share = budget > 0 ? spent / budget : 0;
  return { spent: Math.round(spent * 100) / 100, budget, share, level: budget <= 0 ? null : share >= 1 ? 'exceeded' : share >= warnAt ? 'warning' : null };
}

// → { day, week, level, which, dayKey, weekKey }: `level` is the worse of
// the two periods; `which` is the period that set it.
function budgetStatus(turns, cfg, now = Date.now()) {
  const c = normalize(cfg);
  const dayFrom = startOfDay(now);
  const weekFrom = startOfWeek(now);
  let day = 0, week = 0;
  sinceScan(turns, Math.min(dayFrom, weekFrom), now, (t) => {
    const cost = costOf(t);
    if (cost == null) return;
    if (t.ts >= weekFrom) week += cost;
    if (t.ts >= dayFrom) day += cost;
  });
  const d = period(day, c.dailyBudget, c.warnAt);
  const w = period(week, c.weeklyBudget, c.warnAt);
  const rank = { exceeded: 2, warning: 1 };
  const worst = (rank[w.level] || 0) > (rank[d.level] || 0) ? 'week' : d.level ? 'day' : w.level ? 'week' : null;
  return { day: d, week: w, level: worst ? (worst === 'day' ? d.level : w.level) : null, which: worst, dayKey: new Date(dayFrom).toDateString(), weekKey: new Date(weekFrom).toDateString() };
}

// Sessions whose spend (or new tokens) in the last `runawayMinutes` passed
// the threshold. `minutes` is the span actually burnt in, first counted turn
// to now, so "$7.40 in 18 min" says how fast, not just the window.
function runaways(turns, cfg, now = Date.now()) {
  const c = normalize(cfg);
  if (c.runawayDollars <= 0 && c.runawayTokens <= 0) return [];
  const from = now - c.runawayMinutes * 60000;
  const by = new Map();
  sinceScan(turns, from, now, (t) => {
    if (!t.sessionId) return;
    const s = by.get(t.sessionId) || { sessionId: t.sessionId, cwd: t.cwd, project: t.project, cost: 0, tokens: 0, first: t.ts };
    s.cost += costOf(t) || 0;
    s.tokens += tokensOf(t);
    s.first = Math.min(s.first, t.ts);
    if (!s.cwd && t.cwd) s.cwd = t.cwd;
    by.set(t.sessionId, s);
  });
  const out = [];
  for (const s of by.values()) {
    const overCost = c.runawayDollars > 0 && s.cost >= c.runawayDollars;
    const overTokens = c.runawayTokens > 0 && s.tokens >= c.runawayTokens;
    if (!overCost && !overTokens) continue;
    const minutes = Math.max(1, Math.round((now - s.first) / 60000));
    out.push({
      sessionId: s.sessionId, cwd: s.cwd || null, project: s.project || null,
      cost: Math.round(s.cost * 100) / 100, tokens: s.tokens, minutes,
      by: overCost ? 'cost' : 'tokens',
      burn: overCost || c.runawayTokens <= 0 ? `${money(s.cost)} in ${minutes} min` : `${Math.round(s.tokens / 1000)}k tokens in ${minutes} min`,
    });
  }
  return out.sort((a, b) => b.cost - a.cost);
}

// What the rules engine gets as env.spend, plus the words the tooltip,
// notifications and the MCP tool use.
function snapshot(turns, cfg, now = Date.now()) {
  const c = normalize(cfg);
  const budget = budgetStatus(turns, c, now);
  return {
    mode: c.mode,
    unit: c.mode === 'subscription' ? 'API-price equivalent (your plan is not billed per token)' : 'USD at API list prices',
    budget,
    budgetText: budgetText(budget, c),
    runaway: runaways(turns, c, now),
    runawayThreshold: { dollars: c.runawayDollars, tokens: c.runawayTokens, minutes: c.runawayMinutes },
  };
}

function budgetText(b, c) {
  if (!b.level) return null;
  const p = b.which === 'day' ? b.day : b.week;
  const when = b.which === 'day' ? 'today' : 'this week';
  const eq = c && c.mode === 'subscription' ? ' (API-price equivalent)' : '';
  return `${money(p.spent)} of ${money(p.budget)} ${when}${eq}`;
}

module.exports = { DEFAULTS, MODES, normalize, startOfDay, startOfWeek, money, budgetStatus, runaways, snapshot, budgetText };
