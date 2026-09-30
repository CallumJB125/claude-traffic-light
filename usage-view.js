// The Usage tab's history section, drawn from the permanent daily record
// (usage-history.js) through lightsApi.usageHistory. Charts are plain SVG built
// with element helpers: project names and model ids are user data, so nothing
// here goes through innerHTML. Analytics live in usage-insights.js.
//
//   UsageView.mount(container, { api, now?: () => ms })
(function () {
  const I = window.UsageInsights;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'unpriced', 'legacy'];
  const FAMILY_NAMES = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', unpriced: 'Unpriced', legacy: 'Estimated (cost only)' };
  const TOKEN_KINDS = [['input', 'Input'], ['output', 'Output'], ['cacheRead', 'Cache read'], ['cacheWrite', 'Cache write']];
  const RANGES = [['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['1y', 'Year'], ['all', 'All']];
  const W = 640;
  const PAD = { l: 44, r: 8, t: 8, b: 22 };

  function el(tag, attrs, ...kids) {
    const svg = ['svg', 'g', 'rect', 'path', 'line', 'circle', 'polyline', 'text', 'title', 'polygon'].includes(tag) && (attrs && attrs.xmlns !== 'html');
    const e = svg ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false || k === 'xmlns') continue;
      if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }
  const money = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(2)}`);
  const num = (v) => Math.round(v).toLocaleString('en-US');
  const short = (v) => (v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : String(Math.round(v)));
  const pctText = (v) => `${Math.round(v * 100)}%`;
  const base = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;
  // a round top, flat base: a bar anchored to its baseline
  const topRound = (x, y, w, h, r) => {
    const k = Math.max(0, Math.min(r, w / 2, h));
    return `M${x} ${y + h}V${y + k}Q${x} ${y} ${x + k} ${y}H${x + w - k}Q${x + w} ${y} ${x + w} ${y + k}V${y + h}Z`;
  };
  const niceMax = (v) => {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  };

  function mount(container, { api, now = () => Date.now() }) {
    const state = { range: '30d', compare: true, project: null, metric: 'cost', data: null, busy: false };
    const tip = el('div', { class: 'uv-tip', role: 'status', hidden: true });
    container.classList.add('uv');
    container.append(tip);
    const root = el('div', { class: 'uv-body' });
    container.append(root);

    const showTip = (evt, lines) => {
      tip.replaceChildren(...lines.map((l, i) => el('div', { class: i ? 'uv-tip-row' : 'uv-tip-head', text: l })));
      tip.hidden = false;
      const r = container.getBoundingClientRect();
      const x = Math.min(evt.clientX - r.left + 12, r.width - tip.offsetWidth - 8);
      tip.style.left = `${Math.max(4, x)}px`;
      tip.style.top = `${evt.clientY - r.top + container.scrollTop + 14}px`;
    };
    const hideTip = () => { tip.hidden = true; };
    // the keyboard's way to the same values: focusing a column shows its tooltip
    const showTipAtEl = (node, lines) => { const r = node.getBoundingClientRect(); showTip({ clientX: r.left + r.width / 2, clientY: r.top + 16 }, lines); };

    // one call: the main process reads its cached record once for everything
    async function fetchAll() {
      const b = await api.usageBundle({ range: state.range, project: state.project || undefined, compare: state.compare, now: now() });
      return { ...b, first: b.extent };
    }

    // ── chart frame ──────────────────────────────────────────────────────
    function card(title, sub, body, legend, tableRows) {
      const tbl = tableRows && tableRows.length ? el('details', { class: 'uv-table' }, el('summary', { text: 'Show as table' }),
        el('div', { class: 'uv-scroll' }, el('table', {}, el('thead', {}, el('tr', {}, ...tableRows[0].map((c) => el('th', { scope: 'col', text: c })))),
          el('tbody', {}, ...tableRows.slice(1).map((r) => el('tr', {}, ...r.map((c, i) => el(i ? 'td' : 'th', { scope: i ? null : 'row', text: c}))))))))
        : null;
      return el('section', { class: 'uv-card' }, el('h3', { text: title }), sub ? el('p', { class: 'uv-sub', text: sub }) : null, legend, body, tbl);
    }
    const legendOf = (items) => (items.length > 1 ? el('ul', { class: 'uv-legend' }, ...items.map(([label, cls]) => el('li', {}, el('i', { class: `uv-sw ${cls}` }), label))) : null);
    const svgOf = (h, label) => el('svg', { class: 'uv-svg', viewBox: `0 0 ${W} ${h}`, role: 'img', 'aria-label': label, preserveAspectRatio: 'xMidYMid meet' });
    function axes(svg, h, max, fmt, ticks = 3) {
      for (let i = 0; i <= ticks; i += 1) {
        const v = (max / ticks) * i;
        const y = PAD.t + (h - PAD.t - PAD.b) * (1 - i / ticks);
        svg.append(el('line', { class: 'uv-grid', x1: PAD.l, x2: W - PAD.r, y1: y, y2: y }), el('text', { class: 'uv-tick', x: PAD.l - 6, y: y + 3, 'text-anchor': 'end', text: fmt(v) }));
      }
    }
    // buckets: one per day, or one per week once there are too many for bars
    function bucketize(series) {
      if (series.length <= 120) return series.map((d) => ({ label: d.day, days: [d] }));
      const out = [];
      for (let i = 0; i < series.length; i += 7) { const days = series.slice(i, i + 7); out.push({ label: `${days[0].day} week`, days }); }
      return out;
    }
    const sumOf = (b, fn) => b.days.reduce((a, d) => a + fn(d), 0);

    // stacked bars: rows = buckets, each with parts [{key, value}], overlay columns for the tooltip
    function stackedBars({ buckets, keys, valueOf, classOf, nameOf, fmt, percent, label, markers = [], tipOf }) {
      const H = 170;
      const long = buckets.length > 60;
      const svg = svgOf(H, label);
      const totals = buckets.map((b) => keys.reduce((a, k) => a + valueOf(b, k), 0));
      const max = percent ? 1 : niceMax(Math.max(0, ...totals));
      axes(svg, H, max, percent ? (v) => `${Math.round(v * 100)}%` : fmt, 4);
      const inner = W - PAD.l - PAD.r;
      const step = inner / Math.max(1, buckets.length);
      const bw = Math.max(1.5, step - 2);
      const floor = H - PAD.b;
      const span = floor - PAD.t;
      buckets.forEach((b, i) => {
        const x = PAD.l + i * step + (step - bw) / 2;
        let y = floor;
        const live = keys.filter((k) => valueOf(b, k) > 0);
        live.forEach((k, j) => {
          const v = valueOf(b, k) / (percent ? totals[i] || 1 : max);
          const h = Math.max(1, v * span);
          y -= h;
          const top = j === live.length - 1;
          // 2px surface gap between stacked fills; the last one rounds its end
          svg.append(el('path', { class: `uv-fill ${classOf(k)}`, d: top ? topRound(x, y, bw, h, 4) : `M${x} ${y}h${bw}v${h}h${-bw}Z` }));
        });
        const hit = el('rect', { class: 'uv-hit', x: PAD.l + i * step, y: PAD.t, width: step, height: span, tabindex: 0, 'aria-label': tipOf(b, totals[i]).join(', ') });
        hit.addEventListener('mousemove', (e) => showTip(e, tipOf(b, totals[i])));
        hit.addEventListener('focus', () => showTipAtEl(hit, tipOf(b, totals[i])));
        hit.addEventListener('blur', hideTip);
        hit.addEventListener('mouseleave', hideTip);
        svg.append(hit);
      });
      [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1].filter((v, i, a) => a.indexOf(v) === i && buckets[v]).forEach((i) => {
        svg.append(el('text', { class: 'uv-tick', x: PAD.l + i * step + step / 2, y: H - 6, 'text-anchor': i === 0 ? 'start' : i === buckets.length - 1 ? 'end' : 'middle', text: long ? buckets[i].label.slice(0, 10) : buckets[i].label.slice(5, 10) }));
      });
      for (const m of markers) {
        const i = buckets.findIndex((b) => b.days.some((d) => d.day === m.day));
        if (i < 0) continue;
        const cx = PAD.l + i * step + step / 2;
        const g = el('g', { class: 'uv-marker' }, el('line', { x1: cx, x2: cx, y1: PAD.t, y2: floor }), el('polygon', { points: `${cx - 4},${floor + 1} ${cx + 4},${floor + 1} ${cx},${floor - 6}` }), el('title', { text: m.text }));
        g.addEventListener('mousemove', (e) => showTip(e, [m.text]));
        g.addEventListener('mouseleave', hideTip);
        svg.append(g);
      }
      return svg;
    }

    // a single line over buckets (null = a gap)
    function lineChart({ buckets, valueOf, fmt, max, label, tipOf, cls = 'uv-s1' }) {
      const H = 130;
      const svg = svgOf(H, label);
      const vals = buckets.map(valueOf);
      const top = max || niceMax(Math.max(0, ...vals.filter((v) => v != null)));
      axes(svg, H, top, fmt, 2);
      const inner = W - PAD.l - PAD.r;
      const step = inner / Math.max(1, buckets.length);
      const at = (v, i) => [PAD.l + i * step + step / 2, PAD.t + (H - PAD.t - PAD.b) * (1 - Math.min(1, v / top))];
      let run = [];
      // a single day between gaps is a dot: a one-point line draws nothing
      const flush = () => {
        if (run.length > 1) svg.append(el('polyline', { class: `uv-line ${cls}`, points: run.map((p) => p.join(',')).join(' ') }));
        else if (run.length === 1) svg.append(el('circle', { class: `uv-dot ${cls}`, cx: run[0][0], cy: run[0][1], r: 3 }));
        run = [];
      };
      vals.forEach((v, i) => { if (v == null) flush(); else run.push(at(v, i)); });
      flush();
      const last = vals.map((v, i) => [v, i]).filter(([v]) => v != null).pop();
      if (last) svg.append(el('circle', { class: `uv-dot ${cls}`, cx: at(last[0], last[1])[0], cy: at(last[0], last[1])[1], r: 4 }));
      buckets.forEach((b, i) => {
        const hit = el('rect', { class: 'uv-hit', x: PAD.l + i * step, y: PAD.t, width: step, height: H - PAD.t - PAD.b, tabindex: 0, 'aria-label': tipOf(b, vals[i]).join(', ') });
        hit.addEventListener('mousemove', (e) => showTip(e, tipOf(b, vals[i])));
        hit.addEventListener('focus', () => showTipAtEl(hit, tipOf(b, vals[i])));
        hit.addEventListener('blur', hideTip);
        hit.addEventListener('mouseleave', hideTip);
        svg.append(hit);
      });
      [0, buckets.length - 1].filter((v, i, a) => a.indexOf(v) === i && buckets[v]).forEach((i) => svg.append(el('text', { class: 'uv-tick', x: PAD.l + i * step + step / 2, y: H - 6, 'text-anchor': i === 0 ? 'start' : 'end', text: buckets[i].label.slice(5, 10) })));
      return svg;
    }

    const spark = (vals, cls = 'uv-s1') => {
      const svg = el('svg', { class: 'uv-spark', viewBox: '0 0 100 24', role: 'presentation', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
      const ok = vals.map((v, i) => [v, i]).filter(([v]) => v != null);
      if (ok.length < 2) return svg;
      const max = Math.max(...ok.map(([v]) => v), 1e-9);
      svg.append(el('polyline', { class: `uv-line ${cls}`, points: ok.map(([v, i]) => `${(i / (vals.length - 1)) * 100},${22 - (v / max) * 20}`).join(' ') }));
      return svg;
    };

    function heat(rows, cols, stepOf, title, label) {
      const cell = 11;
      const gap = 2;
      const vbw = PAD.l + cols * (cell + gap);
      const vbh = rows.length * (cell + gap) + 4;
      // natural size: a heatmap of squares grows with its data, not with the card
      const svg = el('svg', { class: 'uv-svg uv-heat', viewBox: `0 0 ${vbw} ${vbh}`, style: `width:${vbw}px;max-width:100%;height:auto`, role: 'img', 'aria-label': label, preserveAspectRatio: 'xMinYMin meet' });
      rows.forEach((r, y) => {
        svg.append(el('text', { class: 'uv-tick', x: PAD.l - 6, y: y * (cell + gap) + 9, 'text-anchor': 'end', text: r.label }));
        r.cells.forEach((c, x) => {
          if (!c) return;
          const rect = el('rect', { class: `uv-cell uv-step${stepOf(c)}`, x: PAD.l + x * (cell + gap), y: y * (cell + gap), width: cell, height: cell, rx: 2 });
          rect.addEventListener('mousemove', (e) => showTip(e, title(c, r, x)));
          rect.addEventListener('mouseleave', hideTip);
          svg.append(rect);
        });
      });
      return svg;
    }
    const scale = () => el('ul', { class: 'uv-scale', 'aria-hidden': 'true' }, el('li', { text: 'Less' }), ...[0, 1, 2, 3, 4].map((s) => el('li', {}, el('i', { class: `uv-cell uv-step${s}` }))), el('li', { text: 'More' }));

    // ── the whole section ────────────────────────────────────────────────
    function draw() {
      const d = state.data;
      if (!d) return;
      const { p } = d;
      const series = I.dailySeries(d.dayFamily.rows, p.from, p.to);
      const prevSeries = d.prevFamily && p.prev ? I.dailySeries(d.prevFamily.rows, p.prev.from, p.prev.to) : null;
      const buckets = bucketize(series);
      const isSub = d.mode === 'subscription';
      const unit = isSub ? 'API-equivalent $' : 'Cost';
      const kids = [];

      // header: range, compare, project filter, export
      kids.push(el('div', { class: 'uv-head' },
        el('div', { class: 'seg', role: 'group', 'aria-label': 'Range' }, ...RANGES.map(([k, l]) => el('button', { type: 'button', class: state.range === k ? 'on' : '', 'aria-pressed': String(state.range === k), text: l, onclick: () => { state.range = k; refresh(); } }))),
        el('label', { class: 'uv-check' }, el('input', { type: 'checkbox', checked: state.compare && state.range !== 'all' ? true : null, disabled: state.range === 'all' ? true : null, onchange: (e) => { state.compare = e.target.checked; refresh(); } }), 'Compare to previous period'),
        state.project ? el('button', { type: 'button', class: 'uv-chip', 'aria-label': `Clear filter: ${base(state.project)}`, onclick: () => { state.project = null; refresh(); } }, `Project: ${base(state.project)} ✕`) : null,
        el('span', { class: 'uv-spacer' }),
        el('button', { type: 'button', class: 'btn ghost', text: 'Export CSV', onclick: () => download('csv') }),
        el('button', { type: 'button', class: 'btn ghost', text: 'Export JSON', onclick: () => download('json') })));
      if (isSub) kids.push(el('p', { class: 'uv-note', text: 'Dollar figures are API-equivalent: what these tokens would cost at API list prices. On a subscription this is not a bill. Change this in Preferences → Spend.' }));
      if (d.progress) kids.push(el('p', { class: 'uv-note', text: `Reading older transcripts into the record… ${d.progress.done} of ${d.progress.of} files.` }));
      const legacy = d.dayFamily.legacyDays;
      if (legacy) kids.push(el('p', { class: 'uv-note', text: `${legacy} early day${legacy === 1 ? '' : 's'} before the record began are cost-only estimates (no turns or tokens).` }));
      const t = d.dayFamily.total;
      if (t.unpricedTurns) kids.push(el('p', { class: 'uv-note', text: `${num(t.unpricedTurns)} turn${t.unpricedTurns === 1 ? '' : 's'} on models with no price (${d.dayFamily.unpricedModels.join(', ')}) are shown as Unpriced and left out of the cost.` }));

      if (!d.first) {
        kids.push(el('p', { class: 'uv-empty', text: 'Nothing is recorded yet. Claude Buddy records your usage as you work, and reads the transcripts Claude Code still has the first time it runs.' }));
        root.replaceChildren(...kids);
        return;
      }

      // callouts
      const callouts = I.callouts({ cur: d.dayFamily.rows, prev: d.prevFamily ? d.prevFamily.rows : null, series, curFamily: familyTotals(d.dayFamily.rows), prevFamily: d.prevFamily ? familyTotals(d.prevFamily.rows) : null, curProject: d.projects.rows, prevProject: d.prevProjects ? d.prevProjects.rows : null, periodLabel: p.days === 30 ? 'last month' : p.days === 7 ? 'last week' : 'the period before' });
      if (callouts.length) kids.push(el('ul', { class: 'uv-callouts', 'aria-label': 'What changed' }, ...callouts.map((c) => el('li', { text: c.text }))));

      // tiles
      const tiles = I.tiles(d.dayFamily.rows, d.prevFamily ? d.prevFamily.rows : null);
      const tileSeries = { cost: series.map((s) => s.cost), turns: series.map((s) => s.turns), tokens: series.map((s) => s.tokens), cache: series.map((s) => s.cacheHit) };
      const fmtTile = { cost: money, turns: num, tokens: short, cache: (v) => (v == null ? '—' : pctText(v)) };
      kids.push(el('div', { class: 'uv-tiles' }, ...tiles.map((tl) => {
        const c = tl.change;
        const rounded = !c ? 0 : c.points ? Math.round(c.abs * 100) : c.pct == null ? 0 : Math.round(c.pct * 100);
        const good = tl.id === 'cache' && c && rounded !== 0 ? c.abs > 0 : null;
        const arrow = c && c.abs >= 0 ? '▲' : '▼';
        const delta = !c || (!c.points && c.pct == null) ? null : rounded === 0 ? 'no change' : `${arrow} ${Math.abs(rounded)}${c.points ? ' pts' : '%'}`;
        return el('div', { class: 'uv-tile' }, el('div', { class: 'uv-k', text: tl.id === 'cost' ? unit : tl.label }), el('div', { class: 'uv-v', text: fmtTile[tl.id](tl.value) }),
          el('div', { class: `uv-d${good === true ? ' up' : good === false ? ' down' : ''}`, text: delta ? `${delta} vs previous` : tl.id === 'cache' ? '' : p.prev && state.compare ? 'no change data' : '' }), spark(tileSeries[tl.id]));
      })));

      // 1 spend over time, by model family, with version-change markers
      const famKeys = FAMILIES.filter((f) => f !== 'unpriced' && series.some((s) => s.families[f] && s.families[f].cost > 0));
      const famClass = (k) => (k === 'legacy' || k === 'unpriced' ? 'uv-none' : `uv-s${FAMILIES.indexOf(k) + 1}`);
      const weekly = buckets.length && buckets[0].days.length > 1;
      const markers = versionMarkers(d.firstSeen, p.from, p.to);
      kids.push(card(`${unit} over time`, `${weekly ? 'Weekly totals' : 'Daily'}, stacked by model family. A ▲ marks the first day a new model version appeared.`,
        stackedBars({ buckets, keys: famKeys, valueOf: (b, k) => sumOf(b, (s) => (s.families[k] ? s.families[k].cost : 0)), classOf: famClass, fmt: money, label: `${unit} per ${weekly ? 'week' : 'day'} by model family`, markers,
          tipOf: (b, tot) => [b.label.length > 10 ? b.label : I.dayLabel(b.label), `${unit}: ${money(tot)}`, ...famKeys.filter((k) => sumOf(b, (s) => (s.families[k] ? s.families[k].cost : 0)) > 0).map((k) => `${FAMILY_NAMES[k]}: ${money(sumOf(b, (s) => (s.families[k] ? s.families[k].cost : 0)))}`)] }),
        legendOf(famKeys.map((k) => [FAMILY_NAMES[k], famClass(k)])),
        [['Day', ...famKeys.map((k) => FAMILY_NAMES[k]), 'Total'], ...buckets.map((b) => [b.label, ...famKeys.map((k) => money(sumOf(b, (s) => (s.families[k] ? s.families[k].cost : 0)))), money(sumOf(b, (s) => s.cost))])]));

      // 2 model share over time (100% of turns)
      const shareKeys = FAMILIES.filter((f) => f !== 'legacy' && series.some((s) => s.families[f] && s.families[f].turns > 0));
      kids.push(card('Model share over time', 'Share of turns on each model. Watch whether Opus creeps up.',
        stackedBars({ buckets, keys: shareKeys, percent: true, valueOf: (b, k) => sumOf(b, (s) => (s.families[k] ? s.families[k].turns : 0)), classOf: (k) => (k === 'unpriced' ? 'uv-none' : `uv-s${FAMILIES.indexOf(k) + 1}`), label: 'Share of turns by model family',
          tipOf: (b, tot) => [b.label.length > 10 ? b.label : I.dayLabel(b.label), ...shareKeys.filter((k) => sumOf(b, (s) => (s.families[k] ? s.families[k].turns : 0)) > 0).map((k) => `${FAMILY_NAMES[k]}: ${pctText(sumOf(b, (s) => (s.families[k] ? s.families[k].turns : 0)) / (tot || 1))}`)] }),
        legendOf(shareKeys.map((k) => [FAMILY_NAMES[k], k === 'unpriced' ? 'uv-none' : `uv-s${FAMILIES.indexOf(k) + 1}`])),
        [['Day', ...shareKeys.map((k) => FAMILY_NAMES[k])], ...buckets.map((b) => { const tot = sumOf(b, (s) => s.turns) || 1; return [b.label, ...shareKeys.map((k) => pctText(sumOf(b, (s) => (s.families[k] ? s.families[k].turns : 0)) / tot))]; })]));

      // 3 where the tokens go, and (its own chart: one axis each) the cache hit rate
      kids.push(card('Where the tokens go', 'Input, output and cache traffic per day.',
        stackedBars({ buckets, keys: TOKEN_KINDS.map((k) => k[0]), valueOf: (b, k) => sumOf(b, (s) => s[k]), classOf: (k) => `uv-s${TOKEN_KINDS.findIndex((x) => x[0] === k) + 1}`, fmt: short, label: 'Tokens per day by kind',
          tipOf: (b, tot) => [b.label.length > 10 ? b.label : I.dayLabel(b.label), `Tokens: ${short(tot)}`, ...TOKEN_KINDS.map(([k, l]) => `${l}: ${short(sumOf(b, (s) => s[k]))}`)] }),
        legendOf(TOKEN_KINDS.map(([, l], i) => [l, `uv-s${i + 1}`])),
        [['Day', ...TOKEN_KINDS.map((k) => k[1])], ...buckets.map((b) => [b.label, ...TOKEN_KINDS.map(([k]) => short(sumOf(b, (s) => s[k])))])]));
      kids.push(card('Cache hit rate', 'Cache reads as a share of everything sent in. A falling rate is usually money being wasted.',
        lineChart({ buckets, max: 1, fmt: (v) => `${Math.round(v * 100)}%`, label: 'Cache hit rate per day', valueOf: (b) => { const i = sumOf(b, (s) => s.input); const w = sumOf(b, (s) => s.cacheWrite); const r = sumOf(b, (s) => s.cacheRead); return i + w + r > 0 ? r / (i + w + r) : null; }, tipOf: (b, v) => [b.label.length > 10 ? b.label : I.dayLabel(b.label), v == null ? 'No traffic' : `Cache hit rate: ${pctText(v)}`] }),
        null, [['Day', 'Cache hit rate'], ...buckets.map((b) => { const i = sumOf(b, (s) => s.input); const w = sumOf(b, (s) => s.cacheWrite); const r = sumOf(b, (s) => s.cacheRead); return [b.label, i + w + r > 0 ? pctText(r / (i + w + r)) : '—']; })]));

      // 4 activity calendar
      const calSeries = series.slice(-371);
      const cal = I.calendar(calSeries, state.metric);
      const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const calRows = weekdays.map((label, wd) => ({ label, cells: cal.weeks.map((w) => w[wd] || null) }));
      kids.push(card('Activity calendar', 'One square per day.',
        heat(calRows, cal.weeks.length, (c) => c.step, (c) => [I.dayLabel(c.day), `${unit}: ${money(c.cost)}`, `Turns: ${num(c.turns)}`], 'Activity by day'),
        el('div', { class: 'uv-legendrow' }, el('div', { class: 'seg', role: 'group', 'aria-label': 'Size squares by' }, ...[['cost', unit], ['turns', 'Turns']].map(([k, l]) => el('button', { type: 'button', class: state.metric === k ? 'on' : '', 'aria-pressed': String(state.metric === k), text: l, onclick: () => { state.metric = k; draw(); } }))), scale()),
        [['Day', unit, 'Turns'], ...calSeries.filter((s) => s.cost || s.turns).map((s) => [s.day, money(s.cost), num(s.turns)])]));

      // 5 when you work
      const grid = I.workGrid(d.hours.rows, 'turns');
      const flat = grid.flat();
      const st = I.steps(flat);
      const order = [1, 2, 3, 4, 5, 6, 0];
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      kids.push(card('When you work', 'Turns by weekday and hour, local time.',
        heat(order.map((w) => ({ label: names[w], cells: grid[w].map((v, h) => ({ v, w, h, step: st[w * 24 + h] })) })), 24, (c) => c.step, (c) => [`${names[c.w]} ${String(c.h).padStart(2, '0')}:00`, `Turns: ${num(c.v)}`], 'Turns by weekday and hour'),
        el('div', { class: 'uv-legendrow' }, scale()),
        [['Weekday', ...Array.from({ length: 24 }, (_, h) => String(h))], ...order.map((w) => [names[w], ...grid[w].map((v) => num(v))])]));

      // 6 projects
      const projects = d.projects.rows.filter((r) => r.cost > 0 || r.turns > 0).slice(0, 10);
      const pmax = Math.max(1e-9, ...projects.map((r) => r.cost));
      const pdays = new Map();
      for (const r of d.projectDays.rows) { const at = r.key.lastIndexOf('|'); const proj = r.key.slice(0, at); const day = r.key.slice(at + 1); (pdays.get(proj) || pdays.set(proj, new Map()).get(proj)).set(day, r); }
      kids.push(card('Projects', 'Ranked by cost for this range. Click one to filter every chart to it.',
        el('ol', { class: 'uv-projects' }, ...projects.map((r) => {
          const days = pdays.get(r.key) || new Map();
          const line = series.map((s) => (days.get(s.day) ? days.get(s.day).cost : 0));
          return el('li', {}, el('button', { type: 'button', class: state.project === r.key ? 'on' : '', 'aria-label': `${base(r.key)}: ${money(r.cost)}. Filter to this project`, onclick: () => { state.project = state.project === r.key ? null : r.key; refresh(); } },
            el('span', { class: 'uv-pname', title: base(r.key), text: base(r.key) }), el('span', { class: 'uv-pval', text: money(r.cost) }), el('span', { class: 'uv-pbar' }, el('i', { style: `width:${Math.max(2, (r.cost / pmax) * 100)}%` })), spark(line)));
        })), null,
        [['Project', unit, 'Turns'], ...projects.map((r) => [base(r.key), money(r.cost), num(r.turns)])]));

      // 7 routine Opus over time
      const ro = I.routineOpus(series);
      const roB = bucketize(ro.map((r, i) => ({ day: r.day, r, families: series[i].families })));
      const opusTurns = series.reduce((a, s) => a + (s.families.opus ? s.families.opus.turns : 0), 0);
      const roTot = series.reduce((a, s, i) => ({ low: a.low + ro[i].low, high: a.high + ro[i].high }), { low: 0, high: 0 });
      kids.push(card('Routine Opus turns', opusTurns ? `Share of Opus turns that looked routine (a reply under 400 tokens on little new context). On Sonnet these would have cost about ${money(roTot.low)}–${money(roTot.high)} less over this range. An estimate: quality effects aren't counted.` : 'No Opus turns in this range.',
        opusTurns ? lineChart({ buckets: roB, max: 1, fmt: (v) => `${Math.round(v * 100)}%`, label: 'Share of Opus turns that looked routine', cls: 'uv-s2',
          valueOf: (b) => { const t = sumOf(b, (s) => (s.families.opus ? s.families.opus.turns : 0)); return t ? sumOf(b, (s) => (s.families.opus ? s.families.opus.routineTurns : 0)) / t : null; },
          tipOf: (b, v) => [b.label.length > 10 ? b.label : I.dayLabel(b.label), v == null ? 'No Opus turns' : `Routine: ${pctText(v)} of Opus turns`] }) : null,
        null, opusTurns ? [['Day', 'Routine share', 'Saving low', 'Saving high'], ...ro.filter((r) => r.share != null).map((r) => [r.day, pctText(r.share), money(r.low), money(r.high)])] : null));

      root.replaceChildren(...kids);
    }

    const familyTotals = (rows) => { const m = new Map(); for (const r of rows) { const f = r.key.split('|')[1]; m.set(f, (m.get(f) || 0) + r.turns); } return [...m].map(([key, turns]) => ({ key, turns })); };
    // the first day each exact model id appears, when its family had another id before
    function versionMarkers(firstSeen, from, to) {
      const byFamily = new Map();
      for (const [model, day] of Object.entries(firstSeen || {})) { const fam = /opus|sonnet|haiku|fable/.exec(model); const k = fam ? fam[0] : model; (byFamily.get(k) || byFamily.set(k, []).get(k)).push({ model, day }); }
      const out = [];
      // ids after a family's first, whose first day falls in this window
      for (const list of byFamily.values()) { list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.model < b.model ? -1 : 1)); list.slice(1).filter((m) => m.day >= from && m.day <= to).forEach((m) => out.push({ day: m.day, text: `${m.model.replace(/^claude-/, '')} first used` })); }
      return out;
    }
    function download(kind) {
      const d = state.data;
      if (!d) return;
      const text = kind === 'csv' ? I.toCsv(d.dayFamily.rows) : JSON.stringify({ range: { from: d.p.from, to: d.p.to }, mode: d.mode, total: d.dayFamily.total, rows: d.dayFamily.rows, priceVersion: d.dayFamily.priceVersion }, null, 2);
      const url = URL.createObjectURL(new Blob([text], { type: kind === 'csv' ? 'text/csv' : 'application/json' }));
      const a = el('a', { href: url, download: `claude-buddy-usage-${d.p.from}-to-${d.p.to}.${kind}` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function refresh() {
      if (state.busy) { state.again = true; return; }
      state.busy = true;
      try {
        state.data = await fetchAll();
        draw();
      } catch (err) {
        root.replaceChildren(el('p', { class: 'uv-empty', text: `Couldn't read the usage record: ${err.message}` }));
      } finally {
        state.busy = false;
        if (state.again) { state.again = false; refresh(); }
      }
    }
    return { refresh, state };
  }

  window.UsageView = { mount };
})();
