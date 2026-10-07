// Calendar and Timeline are hidden unless the planner flag is on; routes stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byClass, textOf } from '../js/h.js';
import { VIEWS, plannerEnabled } from '../js/views.js';
import { commandItems } from '../js/palette.js';
import { emptyFilters } from '../js/filters.js';
import { boardScreen } from '../js/render-board.js';
import { model } from './fixtures.js';

const labels = (v) => byClass(v, 'viewswitch-label').map((n) => textOf(n));

test('plannerEnabled: ?planner=1 on, ?planner=0 off, else the remembered choice', () => {
  assert.equal(plannerEnabled('', null), false);
  assert.equal(plannerEnabled('?planner=1', null), true);
  assert.equal(plannerEnabled('?planner=0', '1'), false);
  assert.equal(plannerEnabled('?view=table', '1'), true);
});

test('the switcher and palette drop Calendar and Timeline unless the planner is on; the views still exist', () => {
  assert.ok(VIEWS.some((v) => v.id === 'calendar') && VIEWS.some((v) => v.id === 'timeline'));
  const off = labels(boardScreen(model([], { view: 'board' })));
  assert.ok(off.length && !off.includes('Calendar') && !off.includes('Timeline'));
  const on = labels(boardScreen(model([], { view: 'board', showPlanner: true })));
  assert.ok(on.includes('Calendar') && on.includes('Timeline'));
  const ids = (showPlanner) => commandItems({ view: 'board', readOnly: false, filters: emptyFilters(), hasGive: false, showPlanner }).map((c) => c.id);
  assert.ok(!ids(false).includes('cmd:view-calendar') && ids(false).includes('cmd:view-table'));
  assert.ok(ids(true).includes('cmd:view-calendar') && ids(true).includes('cmd:view-timeline'));
});
