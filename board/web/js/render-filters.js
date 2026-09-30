// The filter bar above the Board and Table views. Pure: (model) → vnode.
import { h } from './h.js';
import { icon } from './icons.js';
import { CHIPS, isFiltering } from './filters.js';

export function filterBar(model) {
  const f = model.filters;
  const info = model.filterInfo;
  if (!f || !info) return null;
  const active = isFiltering(f);
  const { counts, labels, people } = info.options;
  const freeLabels = labels.filter((l) => !f.labels.includes(l.label));
  return h('div', { class: `filterbar${active ? ' is-active' : ''}`, role: 'search', 'aria-label': 'Filter cards' },
    h('label', { class: 'filter-search' },
      h('span', { class: 'sr-only' }, 'Search cards by key, title, label or person'),
      icon('search', 'icon-xs'),
      h('input', { class: 'filter-input', type: 'search', value: f.q, placeholder: 'Search cards', 'data-input': 'filter-q', 'aria-keyshortcuts': '/', autocomplete: 'off', spellcheck: 'false' }),
      h('kbd', { class: 'kbd', 'aria-hidden': 'true' }, '/')),
    h('div', { class: 'filter-chips', role: 'group', 'aria-label': 'Quick filters' },
      CHIPS.map((c) => h('button', {
        key: c.id, type: 'button', class: 'fchip', 'data-action': 'filter-chip', 'data-chip': c.id,
        'aria-pressed': f.chips.includes(c.id) ? 'true' : 'false', title: c.hint,
      }, c.label, h('span', { class: 'fchip-n num' }, String(counts[c.id] ?? 0))))),
    f.labels.map((l) => h('button', { key: `l-${l}`, type: 'button', class: 'fchip is-label', 'data-action': 'filter-label-off', 'data-label': l, 'aria-pressed': 'true', 'aria-label': `Label ${l}, remove filter` },
      l, icon('close', 'icon-xs'))),
    freeLabels.length ? h('label', { class: 'filter-pick' },
      h('span', { class: 'sr-only' }, 'Filter by label'),
      h('select', { class: 'input input-sm', 'data-change': 'filter-label', value: '' },
        h('option', { value: '' }, 'Label'),
        freeLabels.map((l) => h('option', { key: l.label, value: l.label }, `${l.label} (${l.n})`)))) : null,
    people.length ? h('label', { class: 'filter-pick' },
      h('span', { class: 'sr-only' }, 'Filter by person'),
      h('select', { class: 'input input-sm', 'data-change': 'filter-assignee', value: f.assignee ?? '' },
        h('option', { value: '' }, 'Anyone'),
        people.map((p) => h('option', { key: p.id, value: p.id, selected: f.assignee === p.id }, p.name)))) : null,
    h('p', { class: 'filter-count num', role: 'status', 'aria-live': 'polite' },
      active ? `${info.shown} of ${info.total} cards` : `${info.total} cards`),
    active ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'filter-clear' }, 'Clear') : null);
}
