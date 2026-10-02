import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDays, nextAnchor, movedDates } from '../js/calendar.js';
import { timelineModel } from '../js/timeline.js';
import { planningScreen, planningEditor } from '../js/render-planning.js';
import { byAttr, byClass, textOf } from '../js/h.js';
const entry = (id, fields = {}) => ({ view: { id, key: id.toUpperCase(), title: 'Work', column: 'todo', run_state: 'todo', start_date: null, due_date: null, depends_on: [], ...fields }, face: { state: 'todo', tone: 'grey', label: 'To do', icon: 'dot', actions: [] } });
const model = (view = 'calendar') => ({ view, entries: [entry('a', { start_date: '2026-10-01', due_date: '2026-10-03' }), entry('b')], planner: { anchor: '2026-10-01', period: 'month', zone: 'Africa/Johannesburg', edit: null }, readOnly: false });
test('Calendar month/week and boundary navigation preserve exact day spans', () => {
  assert.equal(calendarDays('2026-10-01').length, 42); assert.equal(calendarDays('2026-10-01')[0], '2026-09-28');
  assert.equal(calendarDays('2026-10-01', 'week').length, 7); assert.equal(nextAnchor('2026-12-01', 1, 'month'), '2027-01-01'); assert.equal(nextAnchor('2026-10-01', 1, 'week'), '2026-10-08');
  assert.ok(calendarDays('9999-12-01').every(Boolean));
  assert.deepEqual(movedDates({ start_date: '2026-03-07', due_date: '2026-03-08' }, '2026-03-09'), { start_date: '2026-03-08', due_date: '2026-03-09' });
  assert.deepEqual(movedDates({}, '2026-10-01'), { due_date: '2026-10-01' });
});
test('Timeline clips bars and labels incomplete critical-path data unknown', () => {
  const value = timelineModel([entry('a', { start_date: '2026-09-28', due_date: '2026-10-04' }).view, entry('b').view], '2026-10-01');
  assert.equal(value.ranges[0].offset, 0); assert.equal(value.ranges[0].span, 4); assert.equal(value.critical.status, 'unknown'); assert.equal(value.days.length, 28);
});
test('Calendar and Timeline reuse open actions, keyboard moves and readable forms; viewers cannot edit', () => {
  const m = model(), calendar = planningScreen(m);
  assert.ok(byClass(calendar, 'calendar-day').length === 42); assert.ok(byAttr(calendar, 'data-action', 'open').length); assert.ok(byAttr(calendar, 'data-action', 'planning-move').length);
  assert.ok(byAttr(calendar, 'data-form', 'planning-zone').length); assert.ok(byAttr(calendar, 'data-planning-card').every(n => n.props.title.includes('Alt')));
  const timeline = planningScreen(model('timeline')); assert.equal(byClass(timeline, 'timeline-table').length, 1); assert.match(textOf(timeline), /start and due date/);
  const readonly = planningScreen({ ...m, readOnly: true }); assert.ok(byAttr(readonly, 'data-action', 'planning-edit').every(n => n.props.disabled)); assert.ok(byAttr(readonly, 'data-planning-card').every(n => !n.props.draggable));
  m.planner.edit = 'a'; const editor = planningEditor(m); assert.ok(byAttr(editor, 'data-form', 'planning-card').length); assert.ok(byAttr(editor, 'name', 'dependencies').length); assert.match(textOf(editor), /do not start or authorize/);
});
test('stale dependencies remain selected until explicitly removed; out-of-scope cards are excluded', () => {
  const m = model(); m.entries[0].view.depends_on = ['missing']; m.planner.edit = 'a';
  const editor = planningEditor(m); assert.equal(byAttr(editor, 'value', 'missing')[0].props.selected, true); assert.match(textOf(editor), /Unavailable predecessor/);
  m.entries[0].view.planning_in_scope = false; const screen = planningScreen(m); assert.equal(byAttr(screen, 'data-planning-card', 'a').length, 0);
});
