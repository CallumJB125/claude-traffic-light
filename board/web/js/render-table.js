// Table view: every card as one row, sortable and filterable. Pure: (model) →
// vnode. Rows open the same drawer as the board; nothing here mutates.
import { h } from './h.js';
import { icon } from './icons.js';
import { pill, avatarStack } from './render-board.js';
import { TABLE_COLUMNS, tableRows, summary } from './table.js';
import { fmtUsd, formatAge } from './view.js';
import { labelClass, labelColor } from './labels.js';

function headerCell(col, sort) {
  const active = sort.by === col.id;
  const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return h('th', { key: col.id, scope: 'col', class: `tcol-${col.id}${col.num ? ' is-num' : ''}`, 'aria-sort': ariaSort },
    h('button', { type: 'button', class: `th-sort${active ? ' is-active' : ''}`, 'data-action': 'table-sort', 'data-by': col.id },
      col.label,
      h('span', { class: `th-arrow${active && sort.dir === 'desc' ? ' is-desc' : ''}`, 'aria-hidden': 'true' }, active ? icon('chevron', 'icon-xs') : null)));
}

function row(r, model) {
  const selected = model.openCardId === r.id;
  const v = r.entry.view;
  const cls = [selected ? 'is-open' : null, v.archived ? 'is-archived' : null].filter(Boolean).join(' ') || null;
  return h('tr', { key: r.id, class: cls, 'data-tone': r.tone, 'data-card-id': r.id },
    h('td', { class: 'tcol-key num' }, r.key),
    h('th', { scope: 'row', class: 'tcol-title' },
      h('button', { type: 'button', class: 'card-open', 'data-action': 'open', 'data-card': r.id }, r.title),
      v.archived ? h('span', { class: 'label archived-badge' }, 'Archived') : null,
      r.pr?.url ? h('a', { class: 'row-pr num', href: r.pr.url, target: '_blank', rel: 'noopener noreferrer', title: `PR ${r.pr.state}` }, `#${r.pr.number}`) : null),
    h('td', { class: 'tcol-status' }, pill(r.entry.face)),
    h('td', { class: 'tcol-column' }, r.column_label),
    h('td', { class: 'tcol-people' }, avatarStack(r.people) ?? h('span', { class: 'muted' }, '—')),
    h('td', { class: 'tcol-repo num' }, r.repo ?? h('span', { class: 'muted' }, '—')),
    h('td', { class: 'tcol-labels' }, r.labels.length ? r.labels.map((l, i) => h('span', { key: l, class: labelClass(l, labelColor(l, i, v, model.labelColors)) }, l)) : null),
    h('td', { class: 'tcol-cost is-num num' }, r.cost == null ? h('span', { class: 'muted' }, '—')
      : [fmtUsd(r.cost), r.cap != null ? h('span', { class: 'muted' }, ` / ${fmtUsd(r.cap)}`) : null]),
    h('td', { class: 'tcol-age is-num num' }, r.age_ms == null ? '—' : formatAge(r.age_ms)));
}

export function tableScreen(model) {
  const t = model.table;
  const rows = tableRows(model.visible ?? model.entries, { members: model.members, sort: t.sort, filter: t.filter ?? '' });
  const s = summary(rows);
  const total = model.entries.length;
  return h('main', { class: 'tableview', id: 'board', 'aria-label': 'Cards as a table' },
    h('div', { class: 'tableview-bar' },
      h('p', { class: 'tableview-sum', role: 'status', 'aria-live': 'polite' },
        h('span', { class: 'num' }, s.count === total ? `${total} cards` : `${s.count} of ${total} cards`),
        s.needs ? h('span', { class: 'tableview-needs' }, icon('dot', 'icon-xs'), `${s.needs} need attention`) : null,
        s.spent > 0 ? h('span', { class: 'num' }, `${fmtUsd(s.spent)} spent`) : null)),
    h('div', { class: 'tableview-scroll' },
      h('table', { class: 'cardtable' },
        h('thead', null, h('tr', null, TABLE_COLUMNS.map((c) => headerCell(c, t.sort)))),
        h('tbody', null, rows.map((r) => row(r, model)))),
      rows.length ? null : h('p', { class: 'tableview-empty' }, total ? 'No cards match that filter. Esc clears it.' : 'No cards yet. New cards show up here.')));
}
