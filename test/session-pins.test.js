const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/session-pins.js');

const e = (name, title, provider = 'codex', board = 'App') => ({ id: Math.random().toString(16).slice(2), owner: { name }, provider: { id: provider }, board: { label: board }, task: { title } });

test('pins: keyed by who/AI/board/task, so the pin survives a new opaque session id and a restart', () => {
  let s = P.togglePin(P.empty(), e('Ana', 'Fix login'));
  const again = P.parse(P.serialize(s));
  assert.equal(P.pinned(again, e('Ana', 'Fix login')), true);
  assert.equal(P.pinned(again, e('Ana', 'Other task')), false);
  s = P.togglePin(again, e('Ana', 'Fix login'));
  assert.equal(s.pins.length, 0);
});

test('pins: pinned sessions sort first, most recently pinned on top, others keep their order', () => {
  const a = e('Ana', 'A'), b = e('Ben', 'B'), c = e('Cy', 'C');
  let s = P.togglePin(P.empty(), b); s = P.togglePin(s, c);
  assert.deepEqual(P.order(s, [a, b, c]).map(x => x.task.title), ['C', 'B', 'A']);
});

test('pins: saved filters keep only known keys, replace by name and round-trip; garbage parses to empty', () => {
  let s = P.saveFilter(P.empty(), 'Ana on App', { person: 'Ana', project: 'App', bogus: 'x' });
  s = P.saveFilter(s, 'Ana on App', { person: 'Ana', focus: 'attention' });
  assert.equal(s.filters.length, 1);
  assert.deepEqual(s.filters[0].values, { person: 'Ana', focus: 'attention' });
  assert.deepEqual(P.parse(P.serialize(s)), s);
  assert.deepEqual(P.parse('nope'), P.empty());
  assert.deepEqual(P.parse('{"pins":["bad"],"filters":[{"name":"","values":{}}]}'), P.empty());
  assert.equal(P.removeFilter(s, 'Ana on App').filters.length, 0);
});
