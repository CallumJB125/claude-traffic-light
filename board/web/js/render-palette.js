// ⌘K palette. Pure: (dialog state, model) → vnode. A native modal <dialog>
// (focus is trapped, Esc closes); the input keeps focus and the highlighted
// row is exposed with aria-activedescendant, so a screen reader follows the
// arrows without focus ever leaving the field.
import { h } from './h.js';
import { icon } from './icons.js';
import { paletteResults } from './palette.js';

function titleWithHits(title, indices) {
  if (!indices.length) return title;
  const hit = new Set(indices);
  const out = [];
  let run = '';
  let on = false;
  [...title].forEach((ch, i) => {
    const is = hit.has(i);
    if (is !== on && run) { out.push(on ? h('span', { class: 'pal-hit' }, run) : run); run = ''; }
    on = is;
    run += ch;
  });
  if (run) out.push(on ? h('span', { class: 'pal-hit' }, run) : run);
  return out;
}

export function paletteDialog(dlg, model) {
  const results = paletteResults(dlg, model);
  const index = results.length ? Math.min(dlg.index ?? 0, results.length - 1) : -1;
  const give = dlg.scope === 'give';
  let lastKind = null;
  const rows = [];
  results.forEach(({ item, indices }, i) => {
    if (!give && !dlg.query?.trim() && item.kind !== lastKind) {
      rows.push(h('li', { key: `g-${item.kind}`, role: 'presentation', class: 'pal-group' }, item.kind === 'card' ? 'Cards' : 'Commands'));
    }
    lastKind = item.kind;
    rows.push(h('li', {
      key: item.id, id: `pal-opt-${i}`, role: 'option', class: 'pal-opt', 'aria-selected': i === index ? 'true' : 'false',
      'data-action': 'palette-run', 'data-index': String(i), 'data-kind': item.kind, 'data-tone': item.tone ?? null,
    },
    h('span', { class: 'pal-icon' }, item.kind === 'card' ? icon('diamond', 'icon-xs') : icon(item.icon ?? 'chevron', 'icon-xs')),
    h('span', { class: 'pal-title' }, titleWithHits(item.title, indices)),
    item.hint ? h('span', { class: `pal-hint${item.kind === 'command' ? ' num' : ''}` }, item.hint) : null));
  });
  return h('dialog', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': give ? 'Tackle a card with AI' : 'Command palette', 'data-dialog': 'palette' },
    h('div', { class: 'pal-field' },
      icon('search', 'icon-xs'),
      h('input', {
        class: 'pal-input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list',
        'aria-activedescendant': index >= 0 ? `pal-opt-${index}` : null, 'aria-label': give ? 'Pick a card to tackle with AI' : 'Search cards and commands',
        placeholder: give ? 'Pick a card to tackle with AI' : 'Jump to a card or run a command', value: dlg.query ?? '',
        'data-input': 'palette-q', autofocus: true, autocomplete: 'off', spellcheck: 'false',
      }),
      h('kbd', { class: 'kbd', 'aria-hidden': 'true' }, 'Esc')),
    h('ul', { id: 'pal-list', class: 'pal-list', role: 'listbox', 'aria-label': 'Results' },
      rows.length ? rows : h('li', { key: 'none', role: 'presentation', class: 'pal-empty' }, give ? 'No card can be assigned to an AI right now.' : 'Nothing matches.')),
    h('p', { class: 'pal-foot', 'aria-hidden': 'true' },
      h('span', null, h('kbd', { class: 'kbd' }, '↑↓'), ' move'),
      h('span', null, h('kbd', { class: 'kbd' }, '↵'), ' choose'),
      give ? null : h('span', null, h('kbd', { class: 'kbd' }, '⌘↵'), ' tackle card with AI')),
    h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' }, results.length ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'No results'));
}
