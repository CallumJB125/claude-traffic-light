// Shared saved views and moments: two small panels under the pinboard. Views are
// named filter combinations any writer saves for the team (board.settings.views);
// applying one sets this browser's filters. Moments are dated notes the team
// keeps — a ship, a decision, a demo (board.settings.moments). Text only.
import { h } from './h.js';
import { momentThread } from './comments.js';

export const MOMENT_KINDS = Object.freeze([['moment', 'Moment'], ['ship', 'Shipped'], ['decision', 'Decision'], ['demo', 'Demo']]);
const KIND_LABEL = Object.fromEntries(MOMENT_KINDS);
const WEEK_MS = 7 * 24 * 3600_000;

export function describeView(values) {
  return Object.entries(values || {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
}

export function sharedViewsPanel(model) {
  if (model.view !== 'board' && model.view !== 'table') return null;
  if (!model.board || model.localCard) return null;
  const views = Array.isArray(model.board.settings?.views) ? model.board.settings.views : [];
  return h('details', { class: 'pinboard shared-views', open: model.viewsOpen || undefined, 'data-action-toggle': 'views' },
    h('summary', { class: 'pinboard-summary' }, h('span', { class: 'pinboard-title' }, 'Team views'), h('span', { class: 'muted small' }, views.length ? `${views.length} saved for everyone` : 'Save a filter combination the whole team can reuse')),
    views.length ? h('ul', { class: 'pin-list', 'aria-label': 'Shared views' }, views.map((v) => h('li', { class: 'pin pin-view', 'data-view': v.id },
      h('button', { type: 'button', class: 'link pin-label', 'data-action': 'view-apply', 'data-view': v.id, title: describeView(v.values) }, v.name),
      h('span', { class: 'pin-value muted small' }, describeView(v.values)),
      h('span', { class: 'pin-by muted small' }, v.by ? `saved by ${v.by}` : ''),
      model.readOnly ? null : h('button', { type: 'button', class: 'pin-remove', 'data-action': 'view-remove', 'data-view': v.id, 'aria-label': `Remove view: ${v.name}`, title: 'Remove view' }, '×'))))
      : h('p', { class: 'muted small pin-empty' }, 'No shared views yet.'),
    model.readOnly ? null : h('form', { class: 'pin-form', 'data-form': 'view-save', 'aria-label': 'Save the current filters as a team view' },
      h('input', { name: 'name', type: 'text', maxlength: '60', required: true, placeholder: 'Name this view (e.g. Needs review)', 'aria-label': 'View name' }),
      h('button', { type: 'submit', class: 'small', disabled: model.filtersActive ? undefined : true, title: model.filtersActive ? 'Saves the filters you have on now' : 'Set some filters first' }, 'Save current filters')));
}

export function shippedThisWeek(entries, moments, now = Date.now()) {
  const done = (entries || []).filter((e) => e.view && e.view.column === 'done' && !e.view.archived && Number.isFinite(e.view.state_age_ms) && e.view.state_age_ms <= WEEK_MS)
    .map((e) => ({ kind: 'card', id: e.view.id, label: `${e.view.key} ${e.view.title}`, at: now - e.view.state_age_ms, by: e.view.run?.owner?.name || null, pr: e.view.pr?.number || null }));
  const shipped = (moments || []).filter((m) => m.kind === 'ship' && now - Date.parse(m.at) <= WEEK_MS).map((m) => ({ kind: 'moment', id: m.id, label: m.label, at: Date.parse(m.at), by: m.by || null, note: m.note || '' }));
  return [...done, ...shipped].sort((a, b) => b.at - a.at).slice(0, 12);
}

const commentsLabel = (t) => (t?.status === 'ready' ? (t.items.length ? `${t.items.length} comment${t.items.length === 1 ? '' : 's'}` : 'Comment') : 'Comments');

export function momentsPanel(model, now = Date.now()) {
  if (model.view !== 'board' || !model.board || model.localCard) return null;
  const moments = Array.isArray(model.board.settings?.moments) ? model.board.settings.moments : [];
  const shipped = shippedThisWeek(model.entries, moments, now);
  const when = (iso) => { const ms = now - Date.parse(iso); return !(ms >= 0) ? '' : ms < 3600_000 ? `${Math.max(1, Math.floor(ms / 60_000))} min ago` : ms < 86_400_000 ? `${Math.floor(ms / 3600_000)} h ago` : `${Math.floor(ms / 86_400_000)} d ago`; };
  return h('details', { class: 'pinboard moments', open: model.momentsOpen || undefined, 'data-action-toggle': 'moments' },
    h('summary', { class: 'pinboard-summary' }, h('span', { class: 'pinboard-title' }, 'Moments'), h('span', { class: 'muted small' }, shipped.length ? `${shipped.length} shipped this week` : moments.length ? `${moments.length} marked` : 'Mark a ship, a decision or a demo so the team remembers it')),
    shipped.length ? h('div', { class: 'shipped-week' }, h('h4', { class: 'small' }, 'Shipped this week'), h('ul', { class: 'pin-list', 'aria-label': 'Shipped this week' }, shipped.map((s) => h('li', { class: `pin pin-ship pin-ship-${s.kind}`, 'data-shipped': s.id },
      h('span', { class: 'pin-label' }, s.label), s.pr ? h('span', { class: 'pin-value muted small' }, `PR #${s.pr}`) : null, h('span', { class: 'pin-by muted small' }, [s.by, when(new Date(s.at).toISOString())].filter(Boolean).join(' · ')))))) : null,
    moments.length ? h('ul', { class: 'pin-list', 'aria-label': 'Moments' }, moments.slice(0, 20).map((m) => h('li', { class: `pin pin-moment pin-moment-${m.kind}`, 'data-moment': m.id },
      h('span', { class: 'pin-kind' }, KIND_LABEL[m.kind] || 'Moment'),
      h('span', { class: 'pin-label' }, m.label),
      m.note ? h('span', { class: 'pin-value' }, m.note) : null,
      h('span', { class: 'pin-by muted small' }, [m.by ? `by ${m.by}` : '', when(m.at)].filter(Boolean).join(' · ')),
      model.readOnly ? null : h('button', { type: 'button', class: 'pin-remove', 'data-action': 'moment-remove', 'data-moment': m.id, 'aria-label': `Remove moment: ${m.label}`, title: 'Remove moment' }, '×'),
      h('button', { type: 'button', class: 'link small pin-comments', 'data-action': 'moment-comments', 'data-moment': m.id, 'aria-expanded': model.momentOpen?.has?.(m.id) ? 'true' : 'false' }, commentsLabel(model.momentThreads?.get?.(m.id))),
      model.momentOpen?.has?.(m.id) ? momentThread(model, m.id) : null)))
      : h('p', { class: 'muted small pin-empty' }, 'No moments yet. Teammates can also mark one from a session in Plexiform.'),
    model.readOnly ? null : h('form', { class: 'pin-form', 'data-form': 'moment-mark', 'aria-label': 'Mark a moment' },
      h('select', { name: 'kind', 'aria-label': 'What kind of moment' }, MOMENT_KINDS.map(([k, l]) => h('option', { value: k }, l))),
      h('input', { name: 'label', type: 'text', maxlength: '120', required: true, placeholder: 'What happened (e.g. Checkout went live)', 'aria-label': 'Moment' }),
      h('input', { name: 'note', type: 'text', maxlength: '500', placeholder: 'A line of context (optional)', 'aria-label': 'Note' }),
      h('button', { type: 'submit', class: 'small' }, 'Mark')));
}
