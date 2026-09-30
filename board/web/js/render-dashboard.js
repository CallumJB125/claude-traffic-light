// Dashboard view: flow metrics from the board journal. Pure: (model) → vnode.
// Charts are inline SVG from h(); every mark sits in pixels or percentages of
// its own box (no viewBox), so labels keep their size from phone to desktop.
// Each chart carries a text equivalent (a visually hidden table or a list).
import { h } from './h.js';
import { icon } from './icons.js';
import { avatar } from './render-board.js';
import { fmtUsd, formatAge, clock } from './view.js';

const BLOCKED_KIND_LABEL = {
  permission: 'Permission requests', question: 'Questions', clarify: 'Clarifications', decision: 'Decisions',
  plan: 'Plan approvals', conflict: 'Conflicts', loop: 'Loop checks', unknown: 'Other',
};

const dur = (ms) => (ms == null ? '—' : formatAge(ms));
const pct = (x) => `${Math.round(x * 100)}%`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function srTable(caption, head, rows) {
  return h('table', { class: 'sr-only' },
    h('caption', null, caption),
    h('thead', null, h('tr', null, head.map((c) => h('th', { key: c, scope: 'col' }, c)))),
    h('tbody', null, rows.map((r, i) => h('tr', { key: String(i) }, h('th', { scope: 'row' }, r[0]), r.slice(1).map((c, j) => h('td', { key: String(j) }, c))))));
}

// ── marks ───────────────────────────────────────────────────────────────────

const PLOT = { top: 22, base: 128, height: 152 };
const COL_W = 22;

/** Columns on one baseline, value on every cap (so no y-axis is needed). */
function columnChart({ label, data, fmt = String, thinTicks = false }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const span = PLOT.base - PLOT.top;
  const n = data.length;
  return h('svg', { class: 'viz', width: '100%', height: PLOT.height, 'aria-hidden': 'true', focusable: 'false' },
    h('line', { class: 'viz-axis', x1: 0, x2: '100%', y1: PLOT.base + 0.5, y2: PLOT.base + 0.5 }),
    data.map((d, i) => {
      const cx = `${((i + 0.5) / n) * 100}%`;
      const bh = d.value > 0 ? Math.max(2, (d.value / max) * span) : 0;
      const y = PLOT.base - bh;
      return h('g', { key: d.key ?? String(i), class: 'viz-col' },
        h('title', null, `${label(d)}: ${fmt(d.value)}`),
        // Hit target: the whole slot, taller than the mark.
        h('rect', { class: 'viz-hit', x: `${(i / n) * 100}%`, y: 0, width: `${100 / n}%`, height: PLOT.height }),
        bh ? [
          h('rect', { class: 'viz-mark', x: cx, y, width: COL_W, height: bh, rx: Math.min(4, bh / 2), transform: `translate(${-COL_W / 2} 0)` }),
          // Square the baseline end: only the data end is rounded.
          h('rect', { class: 'viz-mark', x: cx, y: PLOT.base - Math.min(4, bh), width: COL_W, height: Math.min(4, bh), transform: `translate(${-COL_W / 2} 0)` }),
        ] : null,
        h('text', { class: `viz-cap${d.value ? '' : ' is-zero'}`, x: cx, y: y - 6, 'text-anchor': 'middle' }, fmt(d.value)),
        // Every other tick (counted from the newest) can drop on narrow screens.
        h('text', { class: `viz-tick${thinTicks && (n - 1 - i) % 2 ? ' is-alt' : ''}`, x: cx, y: PLOT.base + 17, 'text-anchor': 'middle' }, d.label));
    }));
}

/** A horizontal bar in its own row: 8px thick, rounded at the data end only. */
function hbar(value, max, cls = 'viz-mark') {
  const w = max > 0 ? Math.max(value > 0 ? 1.5 : 0, (value / max) * 100) : 0;
  return h('svg', { class: 'viz viz-hbar', width: '100%', height: 8, 'aria-hidden': 'true', focusable: 'false' },
    h('rect', { class: 'viz-track', x: 0, y: 0, width: '100%', height: 8, rx: 4 }),
    w ? [h('rect', { class: cls, x: 0, y: 0, width: `${w}%`, height: 8, rx: 4 }), h('rect', { class: cls, x: 0, y: 0, width: `${Math.min(w, 2)}%`, height: 8 })] : null);
}

function cardLabel(item) {
  const key = item.key ? h('span', { class: 'dash-key num' }, item.key) : null;
  const title = h('span', { class: 'dash-title' }, item.title ?? 'Removed card');
  // Only cards still on the board can open the drawer.
  return item.on_board
    ? h('button', { type: 'button', class: 'dash-card', 'data-action': 'open', 'data-card': item.card_id, title: item.title ?? '' }, key, title)
    : h('span', { class: 'dash-card is-gone', title: item.title ?? '' }, key, title);
}

function barList(items, { fmt, label = cardLabel, empty }) {
  if (!items.length) return h('p', { class: 'dash-empty' }, empty);
  const max = Math.max(...items.map((x) => x.value));
  return h('ol', { class: 'dash-bars' },
    items.map((x, i) => h('li', { key: x.card_id ?? x.kind ?? x.id ?? String(i), class: 'dash-bar' },
      h('div', { class: 'dash-bar-label' }, label(x)),
      h('span', { class: 'dash-bar-value num' }, fmt(x.value)),
      hbar(x.value, max))));
}

function panel(id, title, sub, ...body) {
  return h('section', { key: id, class: `dash-panel dash-${id}`, 'aria-labelledby': `dash-${id}-h` },
    h('header', { class: 'dash-panel-head' },
      h('h2', { id: `dash-${id}-h`, class: 'dash-h' }, title),
      sub ? h('p', { class: 'dash-sub' }, sub) : null),
    body);
}

// ── panels ──────────────────────────────────────────────────────────────────

function tiles(m) {
  const tp = m.throughput;
  const diff = tp.last_week == null ? null : tp.this_week - tp.last_week;
  const tile = (id, label, value, sub) => h('div', { key: id, class: 'dash-tile' },
    h('dt', { class: 'dash-tile-label' }, label),
    h('dd', { class: 'dash-tile-value' }, value),
    h('dd', { class: 'dash-tile-sub' }, sub));
  return h('dl', { class: 'dash-tiles' },
    tile('cycle', 'Median cycle time', dur(m.cycle.median_ms), m.cycle.count ? `p85 ${dur(m.cycle.p85_ms)} · ${plural(m.cycle.count, 'card')}` : 'No finished cards yet'),
    tile('done', 'Done in the last 7 days', String(tp.this_week), diff == null ? 'No earlier week' : diff === 0 ? 'Same as the week before' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)} on the week before`),
    tile('share', 'Finished by Claude', m.share.claude_pct == null ? '—' : pct(m.share.claude_pct), m.share.total ? `${m.share.claude} of ${plural(m.share.total, 'card')}` : 'No finished cards yet'),
    tile('blocked', 'Time blocked', dur(m.blocked.total_ms || null), m.blocked.cards ? `across ${plural(m.blocked.cards, 'card')}` : 'Nothing blocked'),
    tile('cost', 'Spent', fmtUsd(Number(m.cost.total_usd.toFixed(2))), m.cost.cards ? `median ${fmtUsd(Number(m.cost.median_usd.toFixed(2)))} per card` : 'No spend yet'));
}

function throughputPanel(m) {
  const tp = m.throughput;
  const data = tp.weeks.map((w, i) => ({ key: String(w.end_ms), label: i === tp.weeks.length - 1 ? 'This wk' : shortDate(w.start_ms), value: w.count, w }));
  const range = (w) => `${shortDate(w.start_ms)} – ${shortDate(w.end_ms)}`;
  return panel('throughput', 'Cards done per week', `Last ${tp.weeks.length} weeks · ${plural(tp.total, 'card')}`,
    tp.total
      ? h('figure', { class: 'dash-fig', 'aria-label': `Cards done per week, last ${tp.weeks.length} weeks: ${plural(tp.total, 'card')} in all, ${tp.this_week} in the last 7 days.` },
        columnChart({ data, label: (d) => range(d.w), thinTicks: true }),
        srTable('Cards done per week', ['Week', 'Done', 'By Claude', 'By people'], tp.weeks.map((w) => [range(w), String(w.count), String(w.claude), String(w.human)])))
      : h('p', { class: 'dash-empty' }, 'Not enough history yet: no cards finished in the last 8 weeks.'));
}

function cyclePanel(m) {
  const c = m.cycle;
  return panel('cycle', 'Cycle time', c.count ? `Start to done · last 4 weeks · median ${dur(c.median_ms)}` : 'Start to done · last 4 weeks',
    c.count
      ? h('figure', { class: 'dash-fig', 'aria-label': `Cycle time of ${plural(c.count, 'card')} finished in the last 4 weeks: median ${dur(c.median_ms)}, 85th percentile ${dur(c.p85_ms)}.` },
        columnChart({ data: c.buckets.map((b) => ({ key: b.id, label: b.label, value: b.count })), label: (d) => `Took ${d.label}` }),
        srTable('Finished cards by cycle time', ['Cycle time', 'Cards'], c.buckets.map((b) => [b.label, String(b.count)])))
      : h('p', { class: 'dash-empty' }, 'Not enough history yet: no cards finished in the last 4 weeks.'));
}

function sharePanel(m) {
  const s = m.share;
  if (!s.total) return panel('share', 'Who finished the work', 'Last 4 weeks', h('p', { class: 'dash-empty' }, 'Not enough history yet: no cards finished in the last 4 weeks.'));
  const p = s.claude / s.total;
  const item = (cls, name, n, what) => h('li', { class: 'dash-legend-item' },
    h('span', { class: `dash-swatch ${cls}`, 'aria-hidden': 'true' }),
    h('span', { class: 'dash-legend-name' }, name),
    h('span', { class: 'dash-legend-value' }, `${n} · ${pct(n / s.total)}`),
    h('span', { class: 'dash-legend-what' }, what));
  return panel('share', 'Who finished the work', `Last 4 weeks · ${plural(s.total, 'card')} done`,
    h('figure', { class: 'dash-fig', 'aria-label': `Of ${plural(s.total, 'card')} done in the last 4 weeks, Claude finished ${s.claude} (${pct(p)}) and people finished ${s.human} (${pct(1 - p)}).` },
      h('svg', { class: 'viz viz-share', width: '100%', height: 14, 'aria-hidden': 'true', focusable: 'false' },
        s.claude ? h('rect', { class: 'viz-claude', x: 0, y: 0, width: `${p * 100}%`, height: 14, rx: 4 }, h('title', null, `Claude: ${s.claude}`)) : null,
        s.human ? h('rect', { class: 'viz-mark', x: `${p * 100}%`, y: 0, width: `${(1 - p) * 100}%`, height: 14, rx: 4 }, h('title', null, `People: ${s.human}`)) : null,
        s.claude && s.human ? h('rect', { class: 'viz-gap', x: `${p * 100}%`, y: 0, width: 2, height: 14, transform: 'translate(-1 0)' }) : null),
      h('ul', { class: 'dash-legend' },
        item('viz-claude', 'Claude', s.claude, 'a run went through review to done'),
        item('viz-mark', 'People', s.human, 'moved to Done by hand, no run'))));
}

function waitPanel(m, model) {
  const b = m.bottleneck;
  const stageLabel = (s) => h('span', { class: 'dash-stage' },
    h('span', { class: 'dash-stage-name' }, s.label, s.id === b.slowest ? h('span', { class: 'dash-flag' }, 'slowest') : null),
    h('span', { class: 'dash-stage-meta' }, `${s.cards ? `median ${dur(s.median_ms)} a card` : 'no waits'}${s.now_count ? ` · ${s.now_count} waiting now, longest ${dur(s.now_oldest_ms)}` : ''}`));
  const stages = b.stages.map((s) => ({ ...s, value: s.total_ms }));
  const people = b.people.map((p) => {
    const mem = model.members?.get(p.member_id) ?? { member_id: p.member_id, name: p.name ?? 'Someone' };
    const what = [p.permissions ? plural(p.permissions, 'permission request') : null, p.asks ? plural(p.asks, 'question') : null].filter(Boolean).join(', ');
    return h('li', { key: p.member_id, class: 'dash-person' },
      avatar(mem),
      h('span', { class: 'dash-person-name' }, mem.name ?? mem.login),
      h('span', { class: 'dash-person-meta' }, `${plural(p.cards, 'card')} · ${what} · waiting ${dur(p.oldest_ms)}`));
  });
  return panel('wait', 'Where cards wait', 'Total time in each wait, last 4 weeks',
    stages.some((s) => s.value) ? barList(stages, { fmt: dur, label: stageLabel }) : h('p', { class: 'dash-empty' }, 'Not enough history yet: no waits recorded in the last 4 weeks.'),
    h('h3', { class: 'dash-h3' }, 'Waiting on'),
    people.length ? h('ul', { class: 'dash-people' }, people) : h('p', { class: 'dash-empty' }, 'Nobody. No open questions or permission requests.'),
    h('p', { class: 'dash-note' }, 'Reviews aren’t assigned to one person, so they aren’t counted here.'));
}

function blockedPanel(m) {
  const bk = m.blocked;
  return panel('blocked', 'Blocked time', bk.total_ms ? `Blocked or parked · last 4 weeks · ${dur(bk.total_ms)} in all` : 'Blocked or parked · last 4 weeks',
    bk.total_ms ? [
      h('h3', { class: 'dash-h3' }, 'By reason'),
      barList(bk.by_kind, { fmt: dur, label: (x) => h('span', { class: 'dash-kind' }, BLOCKED_KIND_LABEL[x.kind] ?? x.kind), empty: '' }),
      h('h3', { class: 'dash-h3' }, 'Longest blocked cards'),
      barList(bk.top, { fmt: dur, empty: '' }),
    ] : h('p', { class: 'dash-empty' }, 'Nothing was blocked in the last 4 weeks.'));
}

function costPanel(m) {
  const c = m.cost;
  return panel('cost', 'Cost per card', c.cards ? `Claude spend so far · ${fmtUsd(Number(c.total_usd.toFixed(2)))} across ${plural(c.cards, 'card')}` : 'Claude spend so far',
    barList(c.top, { fmt: (v) => fmtUsd(Number(v.toFixed(2))), empty: 'No spend recorded on any card yet.' }));
}

// ── screen ──────────────────────────────────────────────────────────────────

function statusBlock(kind, text, extra = null) {
  return h('div', { class: `dash-state dash-state-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    kind === 'error' ? icon('warn') : kind === 'loading' ? icon('sync', 'dash-spin') : icon('chart'),
    h('p', null, text), extra);
}

const refreshBtn = (busy, label = 'Refresh') => h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'dashboard-refresh', disabled: busy, 'aria-busy': busy ? 'true' : null }, label);

export function dashboardScreen(model) {
  const d = model.dashboard ?? { status: 'loading' };
  const m = d.metrics;
  const busy = d.status === 'loading';
  let body;
  if (!m && d.status === 'error') body = statusBlock('error', `Couldn’t load the board’s history. ${d.error ?? ''}`.trim(), refreshBtn(false, 'Try again'));
  else if (!m) body = statusBlock('loading', 'Reading the board’s history…');
  else if (!m.has_history && !m.cost.cards) body = statusBlock('empty', 'Not enough history yet. The dashboard fills in as cards move across the board.');
  else {
    body = [
      tiles(m),
      h('div', { class: 'dash-grid' },
        throughputPanel(m), cyclePanel(m), sharePanel(m), waitPanel(m, model), blockedPanel(m), costPanel(m)),
    ];
  }
  return h('main', { class: 'dashview', id: 'board', 'aria-label': 'Board dashboard' },
    h('div', { class: 'dashview-bar' },
      h('p', { class: 'dashview-sum', role: 'status', 'aria-live': 'polite' },
        d.updated_at ? `From the board’s journal · updated ${clock(d.updated_at).slice(0, 5)}` : 'From the board’s journal',
        m && d.status === 'error' ? h('span', { class: 'dashview-stale' }, icon('warn', 'icon-xs'), 'Refresh failed; showing the last good numbers') : null),
      m ? refreshBtn(busy) : null),
    body);
}
