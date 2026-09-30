// What the Usage tab derives from the record's rows: periods, headline tiles
// with their change, the trend callouts, and the heatmap grids. Pure
// functions (no DOM, no disk), so the thresholds are tested in Node; the tab
// only draws what comes back. Plain script for the window, CommonJS for Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UsageInsights = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY = 86400000;
  const RANGES = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
  const p2 = (n) => String(n).padStart(2, '0');
  const key = (t) => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
  // local noon, so adding days never lands on the wrong side of a DST change
  const dayAt = (k) => new Date(`${k}T12:00:00`).getTime();
  const addDays = (k, n) => key(dayAt(k) + n * DAY);
  const daysBetween = (a, b) => Math.round((dayAt(b) - dayAt(a)) / DAY) + 1;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayLabel = (k) => { const d = new Date(dayAt(k)); return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };

  // This period and the one just before it, of the same length. "All" runs
  // from the first recorded day and has nothing to compare against.
  function period(range, now, firstDay) {
    const to = key(now);
    if (range === 'all') {
      const from = firstDay && firstDay < to ? firstDay : to;
      return { range, from, to, days: daysBetween(from, to), prev: null };
    }
    const days = RANGES[range] || 30;
    const from = addDays(to, -(days - 1));
    return { range, from, to, days, prev: { from: addDays(from, -days), to: addDays(from, -1) } };
  }

  const tokensOf = (r) => r.input + r.output + r.cacheRead + r.cacheWrite;
  // cache reads over everything that went in: a falling rate is money wasted
  const cacheHit = (r) => { const d = r.cacheRead + r.input + r.cacheWrite; return d > 0 ? r.cacheRead / d : null; };
  function totalsOf(rows) {
    const t = { cost: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTurns: 0, routineTurns: 0, routineCost: 0, routineSonnetCost: 0 };
    for (const r of rows) for (const k of Object.keys(t)) t[k] += r[k] || 0;
    t.tokens = tokensOf(t);
    t.cacheHit = cacheHit(t);
    return t;
  }
  // change against the previous period; null where there is nothing to compare
  function change(cur, prev) {
    if (prev == null || cur == null) return null;
    const abs = cur - prev;
    return { abs, pct: prev > 0 ? abs / prev : null };
  }
  function tiles(cur, prev) {
    const c = totalsOf(cur);
    const p = prev ? totalsOf(prev) : null;
    return [
      { id: 'cost', label: 'Cost', value: c.cost, change: p ? change(c.cost, p.cost) : null },
      { id: 'turns', label: 'Turns', value: c.turns, change: p ? change(c.turns, p.turns) : null },
      { id: 'tokens', label: 'Tokens', value: c.tokens, change: p ? change(c.tokens, p.tokens) : null },
      { id: 'cache', label: 'Cache hit rate', value: c.cacheHit, change: p && p.cacheHit != null && c.cacheHit != null ? { abs: c.cacheHit - p.cacheHit, pct: null, points: true } : null },
    ];
  }

  // Per-day series from day×family rows, every day in the period present
  // (zero where nothing was recorded), for the trend lines and the charts.
  function dailySeries(dayFamilyRows, from, to) {
    const n = daysBetween(from, to);
    const days = Array.from({ length: n }, (_, i) => addDays(from, i));
    const at = new Map(days.map((d) => [d, { day: d, cost: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, families: {} }]));
    for (const r of dayFamilyRows) {
      const [d, fam] = r.key.split('|');
      const a = at.get(d);
      if (!a) continue;
      for (const k of ['cost', 'turns', 'input', 'output', 'cacheRead', 'cacheWrite']) a[k] += r[k] || 0;
      const f = a.families[fam] || (a.families[fam] = { cost: 0, turns: 0, routineTurns: 0, routineCost: 0, routineSonnetCost: 0 });
      for (const k of Object.keys(f)) f[k] += r[k] || 0;
    }
    return days.map((d) => { const a = at.get(d); a.tokens = tokensOf(a); a.cacheHit = cacheHit(a); return a; });
  }

  // A heatmap cell's step, 0–4: zero is its own (an empty day), and the rest
  // split the busiest day's value into quarters.
  function steps(values) {
    const max = Math.max(0, ...values);
    return values.map((v) => (v <= 0 || max <= 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 4 - 1e-9))));
  }
  // weekday × hour (rows of 'weekday-hour': key "weekday:hour") as a 7×24 grid
  function workGrid(rows, metric = 'turns') {
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of rows) { const [w, h] = r.key.split(':').map(Number); if (grid[w]) grid[w][h] += r[metric] || 0; }
    return grid;
  }
  // calendar weeks (Mon-first columns of 7 days) for the activity heatmap
  function calendar(series, metric = 'cost') {
    if (!series.length) return { weeks: [], steps: [] };
    const first = new Date(dayAt(series[0].day)).getDay();
    const lead = (first + 6) % 7; // Monday = 0
    const cells = [...new Array(lead).fill(null), ...series];
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    const st = steps(series.map((d) => d[metric]));
    const byDay = new Map(series.map((d, i) => [d.day, st[i]]));
    return { weeks: weeks.map((w) => w.map((c) => (c ? { ...c, step: byDay.get(c.day) } : null))) };
  }

  // ── Callouts ───────────────────────────────────────────────────────────
  // At most three plain lines, each from a real period-over-period
  // difference, and only when it clears a floor on both sample size and size
  // of change. Silence beats noise.
  const MIN = { turns: 50, sharePts: 10, cachePts: 10, cacheTurns: 30, busiestRatio: 2, busiestDollars: 5, busiestDays: 7 };
  const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
  const pct = (v) => `${Math.round(v * 100)}%`;
  function callouts({ cur, prev, series, curFamily, prevFamily, curProject, prevProject, periodLabel = 'last period' }) {
    const out = [];
    const share = (rows, fam) => { const t = rows.reduce((a, r) => a + r.turns, 0); const f = rows.filter((r) => r.key === fam).reduce((a, r) => a + r.turns, 0); return { t, s: t ? f / t : 0 }; };
    if (prev && curFamily && prevFamily) {
      const c = share(curFamily, 'opus');
      const p = share(prevFamily, 'opus');
      const pts = Math.round((c.s - p.s) * 100);
      if (c.t >= MIN.turns && p.t >= MIN.turns && Math.abs(pts) >= MIN.sharePts) out.push({ id: 'opus-share', text: `Opus share ${pts > 0 ? 'up' : 'down'} ${Math.abs(pts)} pts vs ${periodLabel}` });
    }
    const ct = totalsOf(cur);
    const pt = prev ? totalsOf(prev) : null;
    if (pt && ct.cacheHit != null && pt.cacheHit != null && ct.turns >= MIN.cacheTurns && pt.turns >= MIN.cacheTurns && (pt.cacheHit - ct.cacheHit) * 100 >= MIN.cachePts) {
      // name the project that lost the most hits
      let worst = null;
      if (curProject && prevProject) {
        const before = new Map(prevProject.map((r) => [r.key, cacheHit(r)]));
        for (const r of curProject) {
          const b = before.get(r.key);
          const now = cacheHit(r);
          if (b == null || now == null) continue;
          const lost = (b - now) * (r.cacheRead + r.input + r.cacheWrite);
          if (lost > 0 && (!worst || lost > worst.lost)) worst = { name: r.key, lost };
        }
        const total = (pt.cacheHit - ct.cacheHit) * (ct.cacheRead + ct.input + ct.cacheWrite);
        if (worst && worst.lost < total * 0.5) worst = null;
      }
      out.push({ id: 'cache-fell', text: `Cache hit rate fell from ${pct(pt.cacheHit)} to ${pct(ct.cacheHit)}${worst ? `, mostly in ${worst.name}` : ''}` });
    }
    const days = series.filter((d) => d.cost > 0);
    if (days.length >= MIN.busiestDays) {
      const sorted = days.map((d) => d.cost).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const top = days.reduce((a, d) => (d.cost > a.cost ? d : a));
      if (top.cost >= median * MIN.busiestRatio && top.cost >= MIN.busiestDollars) out.push({ id: 'busiest', text: `Your busiest day was ${dayLabel(top.day)} (${money(top.cost)})` });
    }
    return out.slice(0, 3);
  }

  // Routine Opus over time: per day, the share of Opus turns that looked
  // routine and the Sonnet saving range (low allows 35% more tokens, the
  // same rule as the Model mix card).
  const SLACK = 1.35;
  function routineOpus(series) {
    return series.map((d) => {
      const o = d.families.opus;
      if (!o || !o.turns) return { day: d.day, share: null, low: 0, high: 0 };
      return { day: d.day, share: o.routineTurns / o.turns, low: Math.max(0, o.routineCost - o.routineSonnetCost * SLACK), high: Math.max(0, o.routineCost - o.routineSonnetCost) };
    });
  }

  // ── Export ─────────────────────────────────────────────────────────────
  const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  // A spreadsheet runs a cell that starts with = + - or @ as a formula; a
  // project name can be anything, so those get a leading quote.
  const safe = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
  function toCsv(rows) {
    const head = ['day', 'family', 'turns', 'cost', 'input', 'output', 'cacheRead', 'cacheWrite', 'unpricedTurns'];
    const lines = [head.join(',')];
    for (const r of rows) { const [d, f] = String(r.key).split('|'); lines.push([d, f, r.turns, r.cost, r.input, r.output, r.cacheRead, r.cacheWrite, r.unpricedTurns].map((v) => csvCell(safe(v))).join(',')); }
    return `${lines.join('\n')}\n`;
  }

  return { DAY, RANGES, MIN, SLACK, key, dayAt, addDays, daysBetween, dayLabel, period, totalsOf, change, tiles, dailySeries, steps, workGrid, calendar, callouts, routineOpus, toCsv, money, cacheHit };
});
