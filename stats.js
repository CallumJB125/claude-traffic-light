// Time accounting: how long each day was spent working, waiting on you, or
// idle, and how much of that was per project. Pure functions over a plain
// object so main.js can persist it and the Lights window can chart it.
//
//   stats = { days: { 'YYYY-MM-DD': { working, waiting, idle, done, projects: { name: ms }, sessionsPeak } } }
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrafficLightStats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const WAITING = new Set(['permission-ask', 'limit-hit']);
  const DONE = new Set(['stop', 'idle-nudge']);

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

  function emptyDay() {
    return { working: 0, waiting: 0, idle: 0, done: 0, projects: {}, sessionsPeak: 0 };
  }

  // Attribute `elapsedMs` (time since the previous tick) to today's bucket.
  // A tick after a long sleep would otherwise credit hours to whatever state
  // happened to be current, so anything over `maxGapMs` is dropped.
  function tick(stats, sessions, now = Date.now(), elapsedMs = 0, maxGapMs = 60000) {
    if (!stats.days) stats.days = {};
    if (elapsedMs <= 0 || elapsedMs > maxGapMs) return stats;
    const key = dayKey(now);
    const day = stats.days[key] || (stats.days[key] = emptyDay());
    day[kindOf(sessions)] += elapsedMs;
    day.sessionsPeak = Math.max(day.sessionsPeak, sessions.length);
    for (const s of sessions) {
      if (DONE.has(s.signal)) continue;
      const p = project(s.cwd);
      day.projects[p] = (day.projects[p] || 0) + elapsedMs;
    }
    return stats;
  }

  // Keep the store bounded: drop days older than `keepDays`.
  function prune(stats, now = Date.now(), keepDays = 60) {
    if (!stats.days) return stats;
    const cutoff = dayKey(now - keepDays * 86400000);
    for (const k of Object.keys(stats.days)) if (k < cutoff) delete stats.days[k];
    return stats;
  }

  // Last `n` days (oldest first, today last) plus a project ranking across them.
  function summary(stats, now = Date.now(), n = 7) {
    const days = [];
    const projects = {};
    for (let i = n - 1; i >= 0; i -= 1) {
      const t = now - i * 86400000;
      const key = dayKey(t);
      const d = (stats.days && stats.days[key]) || emptyDay();
      days.push({ key, label: new Date(t).toLocaleDateString(undefined, { weekday: 'short' }), ...d });
      for (const [p, ms] of Object.entries(d.projects)) projects[p] = (projects[p] || 0) + ms;
    }
    const ranked = Object.entries(projects).sort((a, b) => b[1] - a[1]).map(([name, ms]) => ({ name, ms }));
    const total = (k) => days.reduce((a, d) => a + d[k], 0);
    return { days, projects: ranked, totals: { working: total('working'), waiting: total('waiting'), idle: total('idle'), done: total('done') } };
  }

  function fmt(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return '0m';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  }

  return { tick, prune, summary, kindOf, dayKey, project, fmt };
});
