'use strict';
// Spend safety (lane B): per-project daily caps, a projected-today line,
// retry-loop spotting in transcripts, and, for Claude Pro/Max subscribers, an
// estimate of how close they are to the plan's 5-hour and weekly limits.
// Pure: turns (usage.js), transcript lines and settings in, plain values out.
//
// Subscribers are not charged per token. Claude Code writes nothing to disk
// that says how much of the plan's usage is gone, so the limit view is an
// estimate: the API-price equivalent of local turns against a rough per-plan
// reference. It is labelled as an estimate everywhere it shows.
const { costOf } = require('../usage.js');
const Brand = require('../brand.js');

const HOUR_MS = 3600000;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;
const PLANS = Object.freeze(['auto', 'api', 'pro', 'max5', 'max20']);
const PLAN_LABEL = Object.freeze({ api: 'API key (pay per token)', pro: 'Claude Pro', max5: 'Claude Max 5x', max20: 'Claude Max 20x' });
// Rough reference points, in API-price-equivalent dollars per window. Anthropic
// does not publish these; they only turn local usage into a "how close" bar.
const REFERENCE = Object.freeze({
  pro: { fiveHour: 10, week: 80 },
  max5: { fiveHour: 50, week: 400 },
  max20: { fiveHour: 200, week: 1600 },
});
const LOOP_MIN = 3;
const MAX_CAPS = 50;

const money = (n) => (n >= 100 ? `$${Math.round(n)}` : `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`);
const r2 = (n) => Math.round(n * 100) / 100;
const folderOf = (cwd) => (typeof cwd === 'string' ? cwd.split(/[\\/]/).filter(Boolean).pop() || null : null);
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

function normalize(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const caps = {};
  if (s.projectCaps && typeof s.projectCaps === 'object') {
    for (const [k, v] of Object.entries(s.projectCaps).slice(0, MAX_CAPS)) {
      const n = Number(v);
      if (typeof k === 'string' && k.trim() && k.length <= 200 && Number.isFinite(n) && n > 0) caps[k.trim()] = Math.min(1e5, n);
    }
  }
  return {
    plan: PLANS.includes(s.plan) ? s.plan : 'auto',
    showApiPrices: s.showApiPrices === true,
    projectCaps: caps,
    notifyLoops: s.notifyLoops !== false,
  };
}

// The plan from ~/.claude.json's oauthAccount (tier fields only) and the
// environment. → 'api' | 'pro' | 'max5' | 'max20' | null when nothing says.
function detectPlan({ claudeJson = null, env = {} } = {}) {
  if (env && typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY) return 'api';
  const o = claudeJson && typeof claudeJson === 'object' ? claudeJson.oauthAccount : null;
  if (!o || typeof o !== 'object') return null;
  const tier = `${o.organizationRateLimitTier || ''} ${o.userRateLimitTier || ''}`.toLowerCase();
  if (/max_?20x/.test(tier)) return 'max20';
  if (/max_?5x/.test(tier)) return 'max5';
  const type = String(o.organizationType || '').toLowerCase();
  if (type === 'claude_max') return 'max5';
  if (type === 'claude_pro' || o.billingType === 'stripe_subscription') return 'pro';
  return null;
}

// The plan in use: the person's choice wins, then detection, then the spend
// mode they picked in Preferences (subscription → Pro as the cautious guess).
function effectivePlan(settings, detected, spendMode) {
  const s = normalize(settings);
  if (s.plan !== 'auto') return s.plan;
  if (detected) return detected;
  return spendMode === 'api' ? 'api' : 'pro';
}

function todayByProject(turns, now) {
  const from = startOfDay(now);
  const by = new Map();
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || !(t.ts >= from) || t.ts > now) continue;
    const p = folderOf(t.cwd) || t.project || 'Unknown project';
    by.set(p, (by.get(p) || 0) + (costOf(t) || 0));
  }
  return by;
}

// Every capped project with today's spend. level: null | 'warning' | 'over'.
function projectCaps(turns, settings, now = Date.now(), warnAt = 0.8) {
  const caps = normalize(settings).projectCaps;
  const by = todayByProject(turns, now);
  return Object.entries(caps).map(([project, cap]) => {
    const spent = r2(by.get(project) || 0);
    const level = spent >= cap ? 'over' : spent >= cap * warnAt ? 'warning' : null;
    return { project, cap, spent, level, text: `${project}: ${money(spent)} of its ${money(cap)} daily cap` };
  }).sort((a, b) => b.spent / b.cap - a.spent / a.cap);
}

// Today so far, and where it lands if the last two hours' pace carries on to
// midnight. Nothing to say before there is an hour of turns today.
function projectedToday(turns, now = Date.now()) {
  const from = startOfDay(now);
  let spent = 0, recent = 0, first = null;
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || !(t.ts >= from) || t.ts > now) continue;
    const c = costOf(t) || 0;
    spent += c;
    if (t.ts >= now - 2 * HOUR_MS) recent += c;
    if (first == null || t.ts < first) first = t.ts;
  }
  if (first == null || spent <= 0) return { spent: 0, projected: 0, ready: false, text: '' };
  const span = Math.min(2 * HOUR_MS, now - Math.max(first, now - 2 * HOUR_MS));
  if (now - first < HOUR_MS / 2 || span <= 0) return { spent: r2(spent), projected: r2(spent), ready: false, text: '' };
  const left = startOfDay(now) + 24 * HOUR_MS - now;
  const projected = spent + (recent / span) * left;
  return { spent: r2(spent), projected: r2(projected), ready: true, text: `Projected today: about ${money(projected)} if the last two hours' pace keeps up until midnight (${money(spent)} so far)` };
}

// One rolling window kind: a window opens with the first turn after the last
// one closed and lasts `len`. → {used, startedAt, resetsAt} for the open one.
function openWindow(turns, len, now) {
  let start = null, used = 0;
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || !Number.isFinite(t.ts) || t.ts > now || t.ts < now - 2 * len) continue;
    if (start == null || t.ts >= start + len) { start = t.ts; used = 0; }
    used += costOf(t) || 0;
  }
  if (start == null || now >= start + len) return { used: 0, startedAt: null, resetsAt: null };
  return { used, startedAt: start, resetsAt: start + len };
}

function countdown(ms) {
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

// "How close you are to your Claude limit", estimated. null for API users.
function limitEstimate(turns, plan, now = Date.now()) {
  const ref = REFERENCE[plan];
  if (!ref) return null;
  const sorted = (Array.isArray(turns) ? turns.slice() : []).sort((a, b) => a.ts - b.ts);
  const row = (w, limit, name) => {
    const fraction = Math.min(1.5, w.used / limit);
    const pct = Math.round(fraction * 100);
    return {
      fraction, percent: pct, resetsAt: w.resetsAt, usedUsd: r2(w.used),
      text: w.resetsAt
        ? `${name}: about ${pct}% used, resets in ${countdown(w.resetsAt - now)}`
        : `${name}: nothing used yet`,
      band: fraction >= 0.9 ? 'red' : fraction >= 0.7 ? 'amber' : 'green',
    };
  };
  return {
    plan, label: PLAN_LABEL[plan],
    fiveHour: row(openWindow(sorted, FIVE_HOURS_MS, now), ref.fiveHour, '5-hour window'),
    week: row(openWindow(sorted, WEEK_MS, now), ref.week, 'Weekly window'),
    estimate: true,
    note: `Estimate only. Worked out from the Claude Code transcripts on this ${Brand.machine()}, so use on other devices or claude.ai is not counted, and Anthropic does not publish the exact limits. You are not charged per token on this plan.`,
  };
}

// Tool calls and their results, from transcript JSONL lines (one session).
// → [{id, name, key, error}] in order; key is name + input, so the same call
// repeated has the same key. Inputs stay in memory and are only compared.
function toolCalls(lines) {
  const calls = [];
  const byId = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    if (typeof line !== 'string' || (!line.includes('tool_use') && !line.includes('tool_result'))) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const content = j && j.message && Array.isArray(j.message.content) ? j.message.content : [];
    for (const c of content) {
      if (c && c.type === 'tool_use' && typeof c.id === 'string') {
        const call = { id: c.id, name: String(c.name || 'tool').slice(0, 60), key: `${c.name}\u0000${JSON.stringify(c.input ?? null).slice(0, 4000)}`, error: null, ts: Date.parse(j.timestamp) || null };
        calls.push(call);
        byId.set(c.id, call);
      } else if (c && c.type === 'tool_result' && byId.has(c.tool_use_id)) {
        byId.get(c.tool_use_id).error = c.is_error === true;
      }
    }
  }
  return calls;
}

// The same failing tool call, back to back, at the end of the session: that is
// a retry loop. → {tool, count, since} or null.
function retryLoop(lines, min = LOOP_MIN) {
  const calls = toolCalls(lines).filter((c) => c.error !== null);
  if (!calls.length) return null;
  const last = calls[calls.length - 1];
  if (!last.error) return null;
  let n = 0, since = last.ts;
  for (let i = calls.length - 1; i >= 0 && calls[i].error && calls[i].key === last.key; i--) { n++; since = calls[i].ts; }
  return n >= min ? { tool: last.name, count: n, since } : null;
}

function loopText(l, cwd) {
  const where = folderOf(cwd);
  return `Retry loop${where ? ` in ${where}` : ''}: the same ${l.tool} call failed ${l.count} times in a row`;
}

// The runaway notification's sentence, also used by the widget lane.
function burnText(r, subscriber) {
  return `This session burned ${r.burn}${subscriber && !/tokens/.test(r.burn) ? ' (API-price equivalent)' : ''}`;
}

// Runaway sessions whose nudges a "pause nudges" rule holds: every enabled
// rule listening for 'runaway' with then.pauseNudges pauses each runaway
// session until the person acknowledges that burn (acked: Set of
// `${sessionId}|${firedAt}`). → [{sessionId, firedAt, rule}]
function nudgePauses(rules, runaway, acked = new Set()) {
  const rule = (Array.isArray(rules) ? rules : []).find((r) => r && r.enabled !== false && r.then && r.then.pauseNudges === true
    && r.when && (Array.isArray(r.when.signal) ? r.when.signal : [r.when.signal]).includes('runaway'));
  if (!rule) return [];
  return (Array.isArray(runaway) ? runaway : [])
    .filter((r) => r && typeof r.sessionId === 'string' && !acked.has(`${r.sessionId}|${r.firedAt || 0}`))
    .map((r) => ({ sessionId: r.sessionId, firedAt: r.firedAt || 0, rule: rule.name || 'Pause nudges' }));
}

module.exports = { nudgePauses, PLANS, PLAN_LABEL, REFERENCE, LOOP_MIN, normalize, detectPlan, effectivePlan, projectCaps, projectedToday, limitEstimate, openWindow, countdown, toolCalls, retryLoop, loopText, burnText, folderOf };
