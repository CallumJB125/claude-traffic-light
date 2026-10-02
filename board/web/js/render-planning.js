import { h } from './h.js';
import { pill } from './render-board.js';
import { calendarDays, scheduledOn } from './calendar.js';
import { timelineModel } from './timeline.js';
import { todayIn } from '../../shared/planning.js';
const button = (label, action, props = {}) => h('button', { type: 'button', class: 'btn btn-sm', 'data-action': action, ...props }, label);
function controls(model) {
  const p = model.planner;
  return h('div', { class: 'planner-controls' }, button('Previous', 'planning-nav', { 'data-direction': '-1' }),
    h('strong', null, model.view === 'calendar' && p.period === 'month' ? p.anchor.slice(0, 7) : p.anchor),
    button('Next', 'planning-nav', { 'data-direction': '1' }), button('Today', 'planning-today'),
    model.view === 'calendar' ? h('label', null, 'View ', h('select', { 'data-change': 'planning-period', 'aria-label': 'Calendar period' }, ['month', 'week'].map(v => h('option', { value: v, selected: p.period === v }, v === 'month' ? 'Month' : 'Week')))) : null,
    h('form', { 'data-form': 'planning-zone', class: 'planner-zone' }, h('label', null, 'Today’s timezone ', h('input', { name: 'zone', value: p.zone, maxlength: '100', required: true, 'aria-label': 'IANA timezone' })), h('button', { type: 'submit', class: 'btn btn-sm' }, 'Set')),
    h('p', { class: 'muted' }, 'Dates are all-day. Changing timezone does not move them.'));
}
export function planningEditor(model) {
  const p = model.planner, card = model.entries.find(e => e.view.id === p.edit)?.view;
  if (!card) return null;
  const candidates = model.entries.filter(e => e.view.id !== card.id && !e.view.archived && e.view.planning_in_scope !== false), candidateIds = new Set(candidates.map(e => e.view.id));
  const selected = p.draft?.dependencies ?? card.depends_on ?? [];
  return h('section', { class: 'planning-editor', 'aria-label': `Plan ${card.key}` }, h('h2', null, `Plan ${card.key}`),
    h('form', { 'data-form': 'planning-card', 'data-card': card.id },
      h('label', null, 'Start date', h('input', { type: 'date', name: 'start', value: p.draft?.start ?? card.start_date ?? '', min: '0001-01-01', max: '9999-12-31' })),
      h('label', null, 'Due date', h('input', { type: 'date', name: 'due', value: p.draft?.due ?? card.due_date ?? '', min: '0001-01-01', max: '9999-12-31' })),
      h('label', null, 'Predecessors (Ctrl or Cmd selects several)', h('select', { name: 'dependencies', multiple: true, size: '4', 'aria-label': 'Predecessor cards' }, candidates.map(e => h('option', { key: e.view.id, value: e.view.id, selected: selected.includes(e.view.id) }, `${e.view.key} · ${e.view.title}`)), selected.filter(id => !candidateIds.has(id)).map(id => h('option', { key: id, value: id, selected: true }, 'Unavailable predecessor — remove before saving')))),
      h('p', { class: 'muted' }, 'Dependencies describe the plan. They do not start or authorize agent runs.'),
      p.error ? h('p', { class: 'error', role: 'alert' }, p.error) : null,
      h('button', { type: 'submit', class: 'btn', disabled: p.busy || model.readOnly || null }, p.busy ? 'Saving…' : 'Save plan'),
      button('Clear dates', 'planning-clear', { 'data-card': card.id, disabled: p.busy || model.readOnly || null }), button('Close editor', 'planning-close')));
}
function cardItem(entry, model) {
  const card = entry.view;
  return h('article', { key: card.id, class: 'planner-card', 'data-card-id': card.id },
    h('button', { type: 'button', class: 'card-open', draggable: !model.readOnly && !card.archived && !model.planner.busy ? 'true' : null, 'data-action': 'open', 'data-card': card.id, 'data-planning-card': card.id, title: 'Open card. Alt + Left or Right moves dates by one day.' }, `${card.key} · ${card.title}`),
    pill(entry.face), h('span', { class: 'muted' }, card.due_date ? `Due ${card.due_date}` : card.start_date ? `Starts ${card.start_date}` : 'Unscheduled'),
    button('Plan', 'planning-edit', { 'data-card': card.id, disabled: model.readOnly || card.archived || model.planner.busy || null }),
    scheduledOn(card) ? [button('Earlier', 'planning-move', { 'data-card': card.id, 'data-direction': '-1', disabled: model.readOnly || card.archived || model.planner.busy || null }), button('Later', 'planning-move', { 'data-card': card.id, 'data-direction': '1', disabled: model.readOnly || card.archived || model.planner.busy || null })] : null);
}
export function planningScreen(model) {
  const entries = (model.visible ?? model.entries).filter(e => !e.view.archived && e.view.planning_in_scope !== false), p = model.planner;
  const today = todayIn(p.zone), unscheduled = entries.filter(e => !scheduledOn(e.view));
  let content;
  if (model.view === 'calendar') {
    const days = calendarDays(p.anchor, p.period);
    content = h('div', { class: 'calendar-grid', 'aria-label': `${p.period} calendar` }, days.map(date => h('section', { key: date, class: `calendar-day${date === today ? ' is-today' : ''}${date.slice(0, 7) !== p.anchor.slice(0, 7) ? ' outside-month' : ''}`, 'data-planning-day': date, 'aria-label': date },
      h('h2', null, new Intl.DateTimeFormat('en', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${date}T00:00:00Z`))), entries.filter(e => scheduledOn(e.view) === date).map(e => cardItem(e, model)))));
  } else {
    const t = timelineModel(model.entries.filter(e => !e.view.archived && e.view.planning_in_scope !== false).map(e => e.view), p.anchor), byId = new Map(model.entries.map(e => [e.view.id, e.view]));
    const visibleIds = new Set(entries.map(e => e.view.id)); t.ranges = t.ranges.filter(r => visibleIds.has(r.card.id));
    content = [h('p', { class: 'planner-path', role: 'status' }, t.critical.status === 'available' ? `Planned critical path: ${t.critical.path.map(id => byId.get(id)?.key ?? id).join(' → ')}. Based on explicit durations; dates are not rescheduled.` : t.critical.reason ?? 'No open work to calculate.'),
      h('div', { class: 'timeline-scroll' }, h('table', { class: 'timeline-table' }, h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Card and dependencies'), ...t.days.map(date => h('th', { key: date, scope: 'col', 'data-planning-day': date, title: date }, date.slice(5))))),
        h('tbody', null, t.ranges.map(r => h('tr', { key: r.card.id, class: r.critical ? 'is-critical' : null }, h('th', { scope: 'row' }, cardItem(entries.find(e => e.view.id === r.card.id), model),
          h('p', { class: 'muted' }, r.card.depends_on?.length ? `After ${(r.card.depends_on ?? []).map(id => byId.get(id)?.key ?? 'Unavailable card').join(', ')}` : 'No predecessors'),
          r.slack != null ? h('p', { class: 'muted' }, `${r.slack} planned slack days`) : null),
          r.span ? [r.offset ? h('td', { colspan: r.offset }) : null, h('td', { colspan: r.span, class: 'timeline-bar', title: `${r.card.start_date ?? r.card.due_date} to ${r.card.due_date ?? r.card.start_date}` }, button(`${r.card.start_date ?? r.card.due_date} → ${r.card.due_date ?? r.card.start_date}`, 'planning-edit', { 'data-card': r.card.id, disabled: model.readOnly || null })), r.offset + r.span < t.days.length ? h('td', { colspan: t.days.length - r.offset - r.span }) : null] : h('td', { colspan: t.days.length, class: 'muted' }, scheduledOn(r.card) ? 'Outside this range' : 'Unscheduled'))))))];
  }
  return h('main', { id: 'board', class: 'planning-view' }, controls(model),
    p.busy ? h('p', { role: 'status' }, 'Saving plan…') : null,
    p.error && !p.edit ? h('p', { role: 'alert', class: 'error' }, p.error) : null,
    planningEditor(model), content,
    h('section', { class: 'planner-unscheduled', 'aria-label': 'Unscheduled cards' }, h('h2', null, `Unscheduled · ${unscheduled.length}`), unscheduled.map(e => cardItem(e, model))),
    entries.length ? null : h('p', { class: 'muted' }, 'No cards match this view.'));
}
