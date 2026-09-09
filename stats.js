// Time accounting: how long each day was spent working, waiting on you, or
// idle, how much of that was per project and per hour, how long permission
// prompts sat unanswered, which tools ran, and what it cost. Pure functions
// over a plain object so main.js can persist it and the Lights window can
// chart it.
//
//   stats = {
//     days: { 'YYYY-MM-DD': {
//       working, waiting, idle, done,          // ms, whole-machine
//       projects: { name: { working, waiting, done } },   // ms, per session
//       hours: number[24],                     // ms of working time by hour
//       asks: number[],                        // permission-ask latencies, ms
//       tools: { project: { Tool: count } },
//       failed: { project: { Tool: count } },
//       cost: number|null,                     // cached ccusage snapshot
//       sessionsPeak,
//     } },
//     pending: { sessionId: startedAtMs },     // asks still unanswered
//     seen: { sessionId: updatedAt },          // last event we counted
//   }
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrafficLightStats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const WAITING = new Set(['permission-ask', 'limit-hit']);
  const DONE = new Set(['stop', 'idle-nudge']);
  const TOOL_SIGNALS = new Set(['tool-use', 'tool-done', 'tool-failed']);
  const FAILED_SIGNAL = 'tool-failed';
  // A prompt nobody answered for longer than this was almost certainly
  // abandoned (laptop shut, session killed), not answered slowly.
  const MAX_ASK_MS = 2 * 3600000;

  function dayKey(t) {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function project(cwd) {
    return (cwd || '').split('/').filter(Boolean).pop() || 'unknown';
  }

  // What the machine as a whole is doing, given every live session.
  function kindOf(sessions) {
    if (!sessions.length) return 'idle';
    if (sessions.some((s) => WAITING.has(s.signal))) return 'waiting';
    if (sessions.some((s) => !DONE.has(s.signal))) return 'working';
    return 'done';
  }

  // What one session is doing.
  function sessionKind(s) {
    if (WAITING.has(s.signal)) return 'waiting';
    if (DONE.has(s.signal)) return 'done';
    return 'working';
  }

  function emptyDay() {
    return {
      working: 0, waiting: 0, idle: 0, done: 0,
      projects: {}, sessionsPeak: 0,
      hours: new Array(24).fill(0),
      asks: [], tools: {}, failed: {}, cost: null,
    };
  }

  function emptyProject() {
    return { working: 0, waiting: 0, done: 0, peak: 0 };
  }

  // Days written by older builds carry `projects[name] = <ms>` and no hours,
  // asks or tool counts. Fill the shape in on read so every consumer can
  // assume the modern one. Idempotent.
  function migrateDay(day) {
    if (!day || typeof day !== 'object') return emptyDay();
    const d = { ...emptyDay(), ...day };
    const projects = {};
    for (const [name, v] of Object.entries(day.projects || {})) {
      if (typeof v === 'number') projects[name] = { ...emptyProject(), working: v };
      else projects[name] = { ...emptyProject(), ...v };
    }
    d.projects = projects;
    d.hours = Array.isArray(day.hours) && day.hours.length === 24 ? day.hours.slice() : new Array(24).fill(0);
    d.asks = Array.isArray(day.asks) ? day.asks.slice() : [];
    d.tools = day.tools && typeof day.tools === 'object' ? day.tools : {};
    d.failed = day.failed && typeof day.failed === 'object' ? day.failed : {};
    d.cost = typeof day.cost === 'number' ? day.cost : null;
    return d;
  }

  function dayOf(stats, key) {
    if (!stats.days) stats.days = {};
    const cur = stats.days[key];
    if (!cur || !Array.isArray(cur.hours) || cur.hours.length !== 24) stats.days[key] = migrateDay(cur);
    return stats.days[key];
  }

  // Permission prompts: a session that enters `permission-ask` / `limit-hit`
  // starts a clock; the next signal from it (or its disappearance) stops it.
  // Returns the samples closed on this pass, and files them on their day.
  function trackAsks(stats, sessions, now = Date.now(), maxAskMs = MAX_ASK_MS) {
    if (!stats.pending || typeof stats.pending !== 'object') stats.pending = {};
    const pending = stats.pending;
    const live = new Map();
    for (const s of sessions) if (s && s.sessionId) live.set(s.sessionId, s);
    const closed = [];
    for (const [id, startedAt] of Object.entries(pending)) {
      const s = live.get(id);
      if (s && WAITING.has(s.signal)) continue;      // still sitting there
      delete pending[id];
      const ms = now - startedAt;
      if (ms < 0 || ms > maxAskMs) continue;         // abandoned, not answered
      dayOf(stats, dayKey(now)).asks.push(ms);
      closed.push({ sessionId: id, ms });
    }
    for (const [id, s] of live) {
      if (WAITING.has(s.signal) && !(id in pending)) pending[id] = now;
    }
    return closed;
  }

  // Tool mix: each session file holds only its latest event, so count a tool
  // once per distinct `updatedAt` we see for that session.
  function countTools(stats, sessions, now = Date.now()) {
    if (!stats.seen || typeof stats.seen !== 'object') stats.seen = {};
    let day = null;
    const counted = [];
    for (const s of sessions) {
      if (!s || !s.sessionId) continue;
      const stamp = String(s.updatedAt || '');
      if (stats.seen[s.sessionId] === stamp) continue;
      stats.seen[s.sessionId] = stamp;
      if (!TOOL_SIGNALS.has(s.signal) || !s.tool) continue;
      const p = project(s.cwd);
      if (!day) day = dayOf(stats, dayKey(now));
      const bucket = s.signal === FAILED_SIGNAL ? day.failed : day.tools;
      if (!bucket[p]) bucket[p] = {};
      bucket[p][s.tool] = (bucket[p][s.tool] || 0) + 1;
      counted.push({ project: p, tool: s.tool, failed: s.signal === FAILED_SIGNAL });
    }
    const ids = new Set(sessions.map((s) => s && s.sessionId));
    for (const id of Object.keys(stats.seen)) if (!ids.has(id)) delete stats.seen[id];
    return counted;
  }

  // Cache a day's spend so it outlives ccusage's own reporting window.
  function recordCost(stats, key, cost) {
    if (typeof cost !== 'number' || !isFinite(cost)) return stats;
    dayOf(stats, key).cost = cost;
    return stats;
  }

  // Attribute `elapsedMs` (time since the previous tick) to today's bucket.
  // A tick after a long sleep would otherwise credit hours to whatever state
  // happened to be current, so anything over `maxGapMs` is dropped — but the
  // event-driven counters (asks, tools) still run, since they don't measure
  // duration.
  function tick(stats, sessions, now = Date.now(), elapsedMs = 0, maxGapMs = 60000) {
    if (!stats.days) stats.days = {};
    trackAsks(stats, sessions, now);
    countTools(stats, sessions, now);
    if (elapsedMs <= 0 || elapsedMs > maxGapMs) return stats;
    const day = dayOf(stats, dayKey(now));
    const kind = kindOf(sessions);
    day[kind] += elapsedMs;
    if (kind === 'working') day.hours[new Date(now).getHours()] += elapsedMs;
    day.sessionsPeak = Math.max(day.sessionsPeak, sessions.length);
    const live = {};
    for (const s of sessions) {
      const p = project(s.cwd);
      if (!day.projects[p]) day.projects[p] = emptyProject();
      day.projects[p][sessionKind(s)] += elapsedMs;
      live[p] = (live[p] || 0) + 1;
    }
    for (const [p, n] of Object.entries(live)) day.projects[p].peak = Math.max(day.projects[p].peak, n);
    return stats;
  }

  // Keep the store bounded: drop days older than `keepDays`.
  function prune(stats, now = Date.now(), keepDays = 60) {
    if (!stats.days) return stats;
    const cutoff = dayKey(now - keepDays * 86400000);
    for (const k of Object.keys(stats.days)) if (k < cutoff) delete stats.days[k];
    return stats;
  }

  function median(xs) {
    if (!xs.length) return 0;
    const a = [...xs].sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
  }

  // Median / worst / count of the permission-prompt latencies in `asks`.
  function latency(asks) {
    const xs = (asks || []).filter((x) => typeof x === 'number' && x >= 0);
    return { median: median(xs), worst: xs.length ? Math.max(...xs) : 0, count: xs.length };
  }

  // Flatten { project: { tool: n } } into a ranked list for one project, or
  // across all of them when `name` is null.
  function topTools(day, name = null, n = 6) {
    const d = migrateDay(day);
    const merge = (bucket) => {
      const out = {};
      for (const [p, tools] of Object.entries(bucket)) {
        if (name && p !== name) continue;
        for (const [t, c] of Object.entries(tools)) out[t] = (out[t] || 0) + c;
      }
      return out;
    };
    const used = merge(d.tools);
    const bad = merge(d.failed);
    for (const [t, c] of Object.entries(bad)) used[t] = (used[t] || 0) + c;
    return Object.entries(used)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([tool, count]) => ({ tool, count, failed: bad[tool] || 0 }));
  }

  function addTools(into, from) {
    for (const [p, tools] of Object.entries(from || {})) {
      if (!into[p]) into[p] = {};
      for (const [t, c] of Object.entries(tools)) into[p][t] = (into[p][t] || 0) + c;
    }
    return into;
  }

  // Last `n` days (oldest first, today last) plus rollups across them.
  function summary(stats, now = Date.now(), n = 7) {
    const days = [];
    const projects = {};
    const tools = {};
    const failed = {};
    for (let i = n - 1; i >= 0; i -= 1) {
      const t = now - i * 86400000;
      const key = dayKey(t);
      const d = migrateDay((stats.days && stats.days[key]) || null);
      days.push({
        key,
        label: new Date(t).toLocaleDateString(undefined, { weekday: 'short' }),
        date: new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        ...d,
        response: latency(d.asks),
      });
      for (const [p, v] of Object.entries(d.projects)) {
        if (!projects[p]) projects[p] = { ...emptyProject(), ms: 0 };
        projects[p].working += v.working;
        projects[p].waiting += v.waiting;
        projects[p].done += v.done;
        projects[p].peak = Math.max(projects[p].peak, v.peak || 0);
        projects[p].ms += v.working + v.waiting + v.done;
      }
      addTools(tools, d.tools);
      addTools(failed, d.failed);
    }
    const ranked = Object.entries(projects)
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(([name, v]) => ({ name, ...v, tools: topTools({ tools, failed }, name) }));
    const total = (k) => days.reduce((a, d) => a + d[k], 0);
    const cost = days.reduce((a, d) => a + (d.cost || 0), 0);
    const asks = days.flatMap((d) => d.asks);
    return {
      days,
      projects: ranked,
      totals: {
        working: total('working'), waiting: total('waiting'), idle: total('idle'),
        done: total('done'), cost, response: latency(asks),
      },
      today: compare(stats, now, n),
    };
  }

  // Today's hero numbers against the average of the `n` days before it, so
  // "3h working" reads as fast or slow at a glance.
  function compare(stats, now = Date.now(), n = 7) {
    const todayKey = dayKey(now);
    const today = migrateDay((stats.days && stats.days[todayKey]) || null);
    const prior = [];
    for (let i = 1; i <= n; i += 1) {
      const key = dayKey(now - i * 86400000);
      if (stats.days && stats.days[key]) prior.push(migrateDay(stats.days[key]));
    }
    const avg = (pick) => (prior.length ? prior.reduce((a, d) => a + pick(d), 0) / prior.length : 0);
    const field = (pick) => {
      const value = pick(today);
      const average = avg(pick);
      return { value, average, delta: value - average, hasAverage: prior.length > 0 };
    };
    return {
      key: todayKey,
      working: field((d) => d.working),
      waiting: field((d) => d.waiting),
      cost: field((d) => d.cost || 0),
      response: { ...latency(today.asks), averageMedian: avg((d) => latency(d.asks).median) },
    };
  }

  function fmt(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return '0m';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  }

  // Short form for latencies, which live in the seconds-to-minutes range.
  function fmtShort(ms) {
    if (!ms) return '—';
    if (ms < 1000) return '0s';
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    return fmt(ms);
  }

  // Rows for the CSV export: one line per day, flat and spreadsheet-ready.
  function toCsv(sum) {
    const head = ['day', 'working_ms', 'waiting_ms', 'idle_ms', 'done_ms', 'sessions_peak', 'cost_usd', 'asks', 'response_median_ms', 'response_worst_ms', 'top_project', 'tool_calls', 'tool_failures'];
    const lines = [head.join(',')];
    for (const d of sum.days) {
      const top = Object.entries(d.projects).sort((a, b) => (b[1].working + b[1].waiting) - (a[1].working + a[1].waiting))[0];
      const count = (b) => Object.values(b).reduce((a, t) => a + Object.values(t).reduce((x, c) => x + c, 0), 0);
      lines.push([
        d.key, d.working, d.waiting, d.idle, d.done, d.sessionsPeak,
        d.cost == null ? '' : d.cost.toFixed(4),
        d.response.count, d.response.median, d.response.worst,
        top ? `"${top[0].replace(/"/g, '""')}"` : '',
        count(d.tools), count(d.failed),
      ].join(','));
    }
    return lines.join('\n');
  }

  return {
    tick, prune, summary, compare, kindOf, sessionKind, dayKey, project, fmt, fmtShort,
    trackAsks, countTools, recordCost, migrateDay, latency, topTools, toCsv, emptyDay,
  };
});
