// Project pinboard: the staging URL, designs, useful commands, conventions and
// current priorities in one small shared panel on the board. Data lives in the
// hub's board settings (PUT/POST/DELETE /api/boards/:id/pins); every writer can
// add or remove, viewers read. Text reaches the DOM as text nodes only.
import { h } from './h.js';

export const PIN_KINDS = Object.freeze([['link', 'Link'], ['command', 'Command'], ['note', 'Convention'], ['priority', 'Priority']]);

function pinRow(p, model) {
  const value = p.kind === 'link'
    ? h('a', { href: p.value, target: '_blank', rel: 'noopener noreferrer', class: 'pin-value' }, p.value.replace(/^https:\/\//, ''))
    : p.kind === 'command' ? h('code', { class: 'pin-value pin-code' }, p.value)
    : p.value ? h('span', { class: 'pin-value' }, p.value) : null;
  return h('li', { class: `pin pin-${p.kind}`, 'data-pin': p.id },
    h('span', { class: 'pin-kind' }, PIN_KINDS.find(([k]) => k === p.kind)?.[1] ?? p.kind),
    h('span', { class: 'pin-label' }, p.label),
    value,
    h('span', { class: 'pin-by muted small' }, p.by ? `pinned by ${p.by}` : ''),
    model.readOnly ? null : h('button', { type: 'button', class: 'pin-remove', 'data-action': 'pin-remove', 'data-pin': p.id, 'aria-label': `Remove pin: ${p.label}`, title: 'Remove pin' }, '×'));
}

export function pinboardPanel(model) {
  if (model.view !== 'board' || !model.board || model.localCard) return null;
  const pins = Array.isArray(model.board.settings?.pins) ? model.board.settings.pins : [];
  const order = { priority: 0, link: 1, command: 2, note: 3 };
  const sorted = [...pins].sort((a, b) => order[a.kind] - order[b.kind]);
  return h('details', { class: 'pinboard', open: model.pinboardOpen || undefined, 'data-action-toggle': 'pinboard' },
    h('summary', { class: 'pinboard-summary' }, h('span', { class: 'pinboard-title' }, 'Pinboard'), h('span', { class: 'muted small' }, pins.length ? `${pins.length} pinned` : 'Keep the staging URL, designs, commands, conventions and priorities here')),
    sorted.length ? h('ul', { class: 'pin-list', 'aria-label': 'Pinned items' }, sorted.map((p) => pinRow(p, model))) : h('p', { class: 'muted small pin-empty' }, 'Nothing pinned yet. Teammates can also pin from a session in Plexiform.'),
    model.readOnly ? null : h('form', { class: 'pin-form', 'data-form': 'pin-add', 'aria-label': 'Add a pin' },
      h('select', { name: 'kind', 'aria-label': 'What kind of pin' }, PIN_KINDS.map(([k, l]) => h('option', { value: k }, l))),
      h('input', { name: 'label', type: 'text', maxlength: '80', required: true, placeholder: 'Label (e.g. Staging)', 'aria-label': 'Label' }),
      h('input', { name: 'value', type: 'text', maxlength: '500', placeholder: 'https://… or a command, note or priority', 'aria-label': 'Value' }),
      h('button', { type: 'submit', class: 'small' }, 'Pin')));
}
