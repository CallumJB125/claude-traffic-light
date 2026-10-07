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
  mode: 'subscription',
  dailyBudget: 0,
  weeklyBudget: 0,
  warnAt: 0.8,
  runawayDollars: 40,
  runawayMinutes: 20,
  runawayTokens: 0,
  notifyRunaway: true,
  notifyBudgetWarning: true,
  notifyBudgetExceeded: true,
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
    // notifyBudget was one switch for both; an old value still maps to each.
    notifyBudgetWarning: (s.notifyBudgetWarning === undefined ? s.notifyBudget : s.notifyBudgetWarning) !== false,
    notifyBudgetExceeded: (s.notifyBudgetExceeded === undefined ? s.notifyBudget : s.notifyBudgetExceeded) !== false,
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

function period(spent, budget, warnAt, unpriced) {
  const share = budget > 0 ? spent / budget : 0;
  return { spent: Math.round(spent * 100) / 100, budget, share, level: budget <= 0 ? null : share >= 1 ? 'exceeded' : share >= warnAt ? 'warning' : null, unpriced };
}

// → { day, week, level, which, dayKey, weekKey }: `level` is the worse of
// the two periods; `which` is the period that set it.
function budgetStatus(turns, cfg, now = Date.now()) {
  const c = normalize(cfg);
  const dayFrom = startOfDay(now);
  const weekFrom = startOfWeek(now);
  let day = 0, week = 0, dayUnpriced = 0, weekUnpriced = 0;
  sinceScan(turns, Math.min(dayFrom, weekFrom), now, (t) => {
    const cost = costOf(t);
    // A model usage.js has no price for (a new or synthetic id) is counted,
    // so the total can say what it leaves out.
    if (cost == null) {
      if (t.ts >= weekFrom) weekUnpriced += 1;
      if (t.ts >= dayFrom) dayUnpriced += 1;
      return;
    }
    if (t.ts >= weekFrom) week += cost;
    if (t.ts >= dayFrom) day += cost;
  });
  const d = period(day, c.dailyBudget, c.warnAt, dayUnpriced);
  const w = period(week, c.weeklyBudget, c.warnAt, weekUnpriced);
  const rank = { exceeded: 2, warning: 1 };
  const worst = (rank[w.level] || 0) > (rank[d.level] || 0) ? 'week' : d.level ? 'day' : w.level ? 'week' : null;
  return { day: d, week: w, level: worst ? (worst === 'day' ? d.level : w.level) : null, which: worst, dayKey: new Date(dayFrom).toDateString(), weekKey: new Date(weekFrom).toDateString() };
}

// Every session's spend and new tokens in the last `runawayMinutes`. The
// burn is timed from the end of that session's previous turn (clamped to
// the window), since that is when the first counted turn started costing;
// a session with no earlier turn one window back is timed from its first
// counted turn.
function windowSessions(turns, c, now) {
  const W = c.runawayMinutes * 60000;
  const from = now - W;
  const by = new Map();
  sinceScan(turns, from - W, now, (t) => {
    if (!t.sessionId) return;
    if (t.ts < from) {
      const s = by.get(t.sessionId);
      if (s) s.start = from;
      return;
    }
    const s = by.get(t.sessionId) || { sessionId: t.sessionId, cwd: t.cwd, project: t.project, cost: 0, tokens: 0, first: t.ts, start: null };
    s.cost += costOf(t) || 0;
    s.tokens += tokensOf(t);
    s.first = Math.min(s.first, t.ts);
    if (!s.cwd && t.cwd) s.cwd = t.cwd;
    by.set(t.sessionId, s);
  });
  for (const s of by.values()) if (s.start == null) s.start = s.first;
  return by;
}

const overThreshold = (s, c, f = 1) => (c.runawayDollars > 0 && s.cost >= c.runawayDollars * f) || (c.runawayTokens > 0 && s.tokens >= c.runawayTokens * f);

function span(ms) {
  return ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`;
}

function describe(s, c, now) {
  const overCost = c.runawayDollars > 0 && s.cost >= c.runawayDollars;
  const byTokens = !overCost && c.runawayTokens > 0 && s.tokens >= c.runawayTokens;
  const ms = Math.max(0, now - s.start);
  return {
    sessionId: s.sessionId, cwd: s.cwd || null, project: s.project || null,
    cost: Math.round(s.cost * 100) / 100, tokens: s.tokens, minutes: Math.round(ms / 6000) / 10,
    by: byTokens ? 'tokens' : 'cost',
    burn: byTokens ? `${Math.round(s.tokens / 1000)}k tokens in ${span(ms)}` : `${money(s.cost)} in ${span(ms)}`,
  };
}

// Sessions over the threshold right now (stateless; the MCP tool uses this).
function runaways(turns, cfg, now = Date.now()) {
  const c = normalize(cfg);
  if (c.runawayDollars <= 0 && c.runawayTokens <= 0) return [];
  return [...windowSessions(turns, c, now).values()].filter((s) => overThreshold(s, c)).map((s) => describe(s, c, now)).sort((a, b) => b.cost - a.cost);
}

// With hysteresis, for the app: a session enters when it crosses the
// threshold and stays (same firedAt, so one notification per episode) until
// its window spend falls under half of it. Hovering around the line, or a
// turn ending, doesn't make it leave and come back.
const RELEASE_AT = 0.5;
function latchRunaways(prev, turns, cfg, now = Date.now()) {
  const c = normalize(cfg);
  const latched = new Map();
  if (c.runawayDollars <= 0 && c.runawayTokens <= 0) return { latched, list: [] };
  for (const s of windowSessions(turns, c, now).values()) {
    const was = prev && prev.get(s.sessionId);
    if (overThreshold(s, c) || (was && overThreshold(s, c, RELEASE_AT))) latched.set(s.sessionId, { ...describe(s, c, now), firedAt: was ? was.firedAt : now });
  }
  return { latched, list: [...latched.values()].sort((a, b) => b.cost - a.cost) };
}

// What the rules engine gets as env.spend, plus the words the tooltip,
// notifications and the MCP tool use.
// `latch` (the previous snapshot's) turns on hysteresis; without it the
// runaway list is just who is over the threshold now.
function snapshot(turns, cfg, now = Date.now(), latch = null) {
  const c = normalize(cfg);
  const budget = budgetStatus(turns, c, now);
  const held = latch ? latchRunaways(latch, turns, c, now) : null;
  return {
    mode: c.mode,
    unit: c.mode === 'subscription' ? 'API-price equivalent (your plan is not billed per token)' : 'USD at API list prices',
    budget,
    budgetText: budgetText(budget, c),
    runaway: held ? held.list : runaways(turns, c, now),
    latch: held ? held.latched : null,
    runawayThreshold: { dollars: c.runawayDollars, tokens: c.runawayTokens, minutes: c.runawayMinutes },
  };
}

// The app's snapshot: recomputed only when the turns (by version), the
// spend settings or the minute change, carrying the runaway latch from one
// recompute to the next.
function tracker() {
  let memo = { key: null, value: null };
  let latch = new Map();
  let computed = 0;
  return {
    snapshot(turns, version, cfg, now = Date.now()) {
      const key = `${version}|${JSON.stringify(cfg)}|${Math.floor(now / 60000)}`;
      if (memo.key === key) return memo.value;
      computed += 1;
      const value = snapshot(turns, cfg, now, latch);
      latch = value.latch;
      memo = { key, value };
      return value;
    },
    get computed() { return computed; },
  };
}

// How far back a read must go for snapshot(): this week, and two runaway
// windows (the second finds each session's previous turn).
function readSince(cfg, now = Date.now()) {
  const c = normalize(cfg);
  return Math.min(startOfWeek(now), startOfDay(now), now - 2 * c.runawayMinutes * 60000);
}

function budgetText(b, c) {
  if (!b.level) return null;
  const p = b.which === 'day' ? b.day : b.week;
  const when = b.which === 'day' ? 'today' : 'this week';
  const eq = c && c.mode === 'subscription' ? ' (API-price equivalent)' : '';
  return `${money(p.spent)} of ${money(p.budget)} ${when}${eq}`;
}

module.exports = { DEFAULTS, MODES, RELEASE_AT, normalize, startOfDay, startOfWeek, money, budgetStatus, windowSessions, runaways, latchRunaways, snapshot, tracker, budgetText, readSince };
