// History view: what AI actually did, as swimlanes on a time axis. Pure: (model) -> vnode.
// model.history = { range, status: loading|ok|error, error, data, from, to, now, selected }.
import { h } from './h.js';
import { icon } from './icons.js';
import { fmtUsd, clock } from './view.js';
import { RANGES, OUTCOMES, buildHistory, axisTicks, durationText, noHandoverReason } from './history.js';

const ROW_PX = 30;
const pct = (x) => `${(x * 100).toFixed(3)}%`;
const costText = (b) => (b.observed ? 'not tracked' : b.cost_usd == null ? 'cost unavailable' : fmtUsd(b.cost_usd));

export function barSummary(b) {
  const o = OUTCOMES[b.outcome] ?? OUTCOMES.finished;
  return `${b.ai_label}: ${b.key} ${b.title}. ${o.label}${b.running ? ', still going' : ''}, ${durationText(b.durationMs)}, ${costText(b)}`;
}

function bar(b, selected, tabbable) {
  const o = OUTCOMES[b.outcome] ?? OUTCOMES.finished;
  return h('button', { key: b.id, type: 'button', class: `hbar hbar-${o.tone}${b.running ? ' is-running' : ''}${selected === b.id ? ' is-selected' : ''}`,
    'data-action': 'history-open', 'data-card': b.card_id, 'data-run': b.id, 'data-history-bar': '1', tabindex: tabbable ? '0' : '-1',
    'aria-label': barSummary(b), 'aria-pressed': selected === b.id ? 'true' : 'false',
    style: { left: pct(b.x0), width: pct(b.x1 - b.x0), top: `${b.row * ROW_PX + 3}px` } },
  h('span', { class: 'hbar-body' }, icon(o.icon, 'icon-xs'), h('span', { class: 'hbar-key num' }, b.key)),
  h('span', { class: `hbar-tip${b.x0 > 0.5 ? ' is-right' : ''}`, 'aria-hidden': 'true' },
    h('strong', null, `${b.key} ${b.title}`), h('span', null, `${b.ai_label} · ${o.label} · ${durationText(b.durationMs)} · ${costText(b)}`)));
}

function lane(l, selected, tabId, nowX) {
  return h('div', { key: l.id, class: `hlane${l.bars.length ? '' : ' is-empty'}`, role: 'group', 'aria-label': `${l.label}, ${l.bars.length} ${l.bars.length === 1 ? 'run' : 'runs'}` },
    h('div', { class: 'hlane-label' }, l.label, h('span', { class: 'hlane-count num' }, l.bars.length || '')),
    h('div', { class: 'hlane-track', style: { height: `${l.rows * ROW_PX + 6}px` } },
      nowX != null ? h('span', { class: 'hnow', 'aria-hidden': 'true', style: { left: pct(nowX) } }) : null,
      l.bars.map((b) => bar(b, selected, b.id === tabId))));
}

function summaryStrip(s, range) {
  const when = range === 'today' ? 'today' : range === '7d' ? 'in 7 days' : 'in 30 days';
  const spend = s.spendUsd == null ? 'unavailable' : `${fmtUsd(s.spendUsd)}${s.spendUnknown ? ` + ${s.spendUnknown} not reported` : ''}`;
  const tile = (label, value) => h('div', { class: 'dash-tile' }, h('dt', { class: 'dash-tile-label' }, label), h('dd', { class: 'dash-tile-value num' }, value));
  return h('dl', { class: 'dash-tiles hist-tiles', 'aria-label': 'Summary' },
    tile(`Runs ${when}`, String(s.runs)), tile('Time AI worked', s.workedMs ? durationText(s.workedMs) : '0 min'),
    tile('Spend where known', spend), tile('Stalled', String(s.stalled)));
}

function legend() {
  return h('ul', { class: 'hlegend', 'aria-label': 'Outcomes' }, Object.entries(OUTCOMES).map(([id, o]) =>
    h('li', { key: id, class: `hlegend-item hbar-${o.tone}` }, icon(o.icon, 'icon-xs'), o.label)));
}

function selectedPanel(bar) {
  if (!bar) return h('p', { class: 'hist-selected muted', role: 'status' }, 'Select a bar to open its card and handover.');
  return h('div', { class: 'hist-selected', role: 'status' },
    h('strong', null, `${bar.key} ${bar.title}`), h('span', null, barSummary(bar).split('. ').slice(1).join('. ')),
    bar.has_handover ? h('span', { class: 'muted' }, 'Handover is in the card.') : h('span', { class: 'muted' }, `No handover yet. ${noHandoverReason(bar)}`));
}

export function historyScreen(model) {
  const hs = model.history ?? { status: 'loading', range: 'today' };
  const built = hs.data ? buildHistory({ data: hs.data, from: hs.from, to: hs.to, now: hs.now }) : null;
  const all = built?.lanes.flatMap((l) => l.bars) ?? [];
  const selectedBar = all.find((b) => b.id === hs.selected) ?? null;
  const tabId = selectedBar?.id ?? all[0]?.id ?? null;
  let body;
  if (!built && hs.status === 'error') body = h('div', { class: 'dash-state dash-state-error', role: 'alert' }, icon('warn'), h('p', null, `Couldn’t load history. ${hs.error ?? ''}`.trim()),
    h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'history-refresh' }, 'Try again'));
  else if (!built) body = h('div', { class: 'dash-state dash-state-loading', role: 'status' }, icon('sync', 'dash-spin'), h('p', null, 'Reading what ran…'));
  else if (built.empty) body = h('div', { class: 'dash-state dash-state-empty hist-empty', role: 'status' }, icon('clock'),
    h('p', null, hs.range === 'today' ? 'Nothing has run today. Tackle a card with AI and it appears here.' : `Nothing has run in the last ${hs.range === '7d' ? '7' : '30'} days. Tackle a card with AI and it appears here.`),
    h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-action': 'view', 'data-view': 'board' }, 'Go to the board'));
  else body = [
    summaryStrip(built.summary, hs.range),
    h('div', { class: 'hchart' },
      h('div', { class: 'haxis', 'aria-hidden': 'true' }, h('span', { class: 'haxis-gap' }),
        h('div', { class: 'haxis-track' }, axisTicks(hs.range, hs.from, hs.to).map((t) => h('span', { key: t.label, class: 'haxis-tick num', style: { left: pct(t.x) } }, t.label)))),
      built.lanes.map((l) => lane(l, selectedBar?.id, tabId, built.nowX))),
    built.truncated ? h('p', { class: 'muted small' }, 'Showing the most recent 500 runs in this range.') : null,
    selectedPanel(selectedBar), legend(),
  ];
  return h('main', { class: 'dashview histview', id: 'board', 'aria-label': 'Run history' },
    h('div', { class: 'dashview-bar' },
      h('div', { class: 'viewswitch', role: 'group', 'aria-label': 'Time range' }, RANGES.map((r) =>
        h('button', { key: r.id, type: 'button', class: 'viewswitch-btn', 'data-action': 'history-range', 'data-range': r.id, 'aria-pressed': hs.range === r.id ? 'true' : 'false' }, r.label))),
      h('p', { class: 'dashview-sum' }, hs.updated_at ? `Updated ${clock(hs.updated_at).slice(0, 5)}` : 'Real runs, newest data from the hub',
        h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'history-refresh', 'aria-disabled': hs.status === 'loading' ? 'true' : null }, 'Refresh'))),
    body);
}
