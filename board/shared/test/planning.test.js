import test from 'node:test';
import assert from 'node:assert/strict';
import { validDay, validRange, shiftDay, validZone, todayIn, orderGraph, criticalPath, MAX_GRAPH_CARDS } from '../planning.js';
test('Gregorian days and range limits reject normalization and preserve leap days', () => {
  for (const date of ['0001-01-01', '2000-02-29', '2028-02-29', '9999-12-31']) assert.equal(validDay(date), true, date);
  for (const date of ['0000-01-01', '1900-02-29', '2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-01-00', '2026-1-01', '2026-01-01T00:00:00Z', 1, null]) assert.equal(validDay(date), false, String(date));
  assert.equal(validRange(null, null), true);
  assert.equal(validRange('2026-01-02', '2026-01-01'), false);
  assert.equal(validRange('2000-01-01', '2026-01-01'), false);
  assert.equal(shiftDay('2028-02-28', 1), '2028-02-29');
  assert.equal(shiftDay('9999-12-31', 1), null);
  assert.equal(shiftDay('0001-01-01', -1), null);
});
test('IANA timezone affects today, never an all-day date across DST', () => {
  assert.equal(validZone('Africa/Johannesburg'), true); assert.equal(validZone('not/a-zone'), false);
  const instant = Date.parse('2026-03-08T06:59:00Z');
  assert.equal(todayIn('America/New_York', instant), '2026-03-08');
  assert.equal(todayIn('America/Los_Angeles', instant), '2026-03-07');
  assert.equal(shiftDay('2026-03-08', 1), '2026-03-09');
});
test('bounded iterative dependency traversal rejects cycles, self and outside edges', () => {
  const edge = (a, b) => ({ card_id: a, depends_on_card_id: b });
  assert.deepEqual(orderGraph(['a', 'b', 'c'], [edge('b', 'a'), edge('c', 'b')]).order, ['a', 'b', 'c']);
  assert.throws(() => orderGraph(['a', 'b'], [edge('b', 'a'), edge('a', 'b')]), /cycle/);
  assert.throws(() => orderGraph(['a'], [edge('a', 'a')]), /itself/);
  assert.throws(() => orderGraph(['a'], [edge('a', 'b')]), /outside/);
  assert.throws(() => orderGraph(Array.from({ length: MAX_GRAPH_CARDS + 1 }, (_, i) => String(i)), []), /large/);
});
test('critical path uses explicit durations, excludes done work and admits unknown dates', () => {
  const card = (id, days) => ({ id, column: 'todo', start_date: '2026-10-01', due_date: `2026-10-0${days}` });
  const result = criticalPath([card('a', 2), card('b', 3), card('c', 1)], [{ card_id: 'b', depends_on_card_id: 'a' }]);
  assert.equal(result.status, 'available'); assert.deepEqual(result.path, ['a', 'b']); assert.equal(result.slack_days.c, 4);
  assert.equal(criticalPath([card('a', 2), { id: 'b', column: 'todo' }], []).status, 'unknown');
  assert.equal(criticalPath([{ id: 'a', column: 'done' }], []).status, 'empty');
});
