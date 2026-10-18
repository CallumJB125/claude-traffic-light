const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/teammate-tour.js');

test('tour: four steps in order ending with finding a shared session and asking', () => {
  assert.deepEqual(T.STEPS.map(s => s.id), ['home', 'projects', 'team', 'inbox']);
  assert.match(T.STEPS[3].title, /Find a shared session and ask/);
  assert.equal(T.next(3), 3);
});

test('tour: shown once per account; dismissal persists and other accounts still see it', () => {
  let s = T.parse(null);
  assert.equal(T.shouldShow(s, 'acct-1'), true);
  s = T.dismiss(s, 'acct-1', 123);
  const back = T.parse(T.serialize(s));
  assert.equal(T.shouldShow(back, 'acct-1'), false);
  assert.equal(T.shouldShow(back, 'acct-2'), true);
  assert.equal(T.shouldShow(T.parse('{"done":{"acct-1":"soon"}}'), 'acct-1'), true);
});
