const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/teammate-tour.js');

test('tour: four steps in order ending with finding a shared session and asking', () => {
  assert.deepEqual(T.STEPS.map(s => s.id), ['home', 'projects', 'team', 'inbox']);
  assert.match(T.STEPS[3].title, /Find a shared session and ask/);
  assert.equal(T.next(3), 3);
  assert.equal(T.STEPS[0].title, 'Inbox', 'step 1 describes the Inbox (A5)');
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

test('tour (A5): a dismissal made before the account was known holds once it is (null → account)', () => {
  let s = T.dismiss(T.parse(null), null, 5);
  assert.deepEqual(Object.keys(s.done), ['local']);
  const back = T.parse(T.serialize(s));
  assert.equal(T.shouldShow(back, null), false);
  assert.equal(T.shouldShow(back, 'acct-1'), false, 'after a restart the account id is known; still done');
  assert.equal(T.decide(back, { team: { account: 'acct-1' }, firstRunTour: 'finished' }, 'acct-1'), 'done');
});

test('tour (A5): decides only on a settled Home state, never while the widget tour runs, and is done when that one is skipped', () => {
  const fresh = T.parse(null);
  assert.equal(T.decide(fresh, null, null), 'wait');
  assert.equal(T.decide(fresh, { needs: null }, null), 'wait', 'team not asked yet');
  assert.equal(T.decide(fresh, { team: null, firstRunTour: 'running' }, null), 'wait');
  assert.equal(T.decide(fresh, { team: null, firstRunTour: 'pending' }, null), 'wait', 'setup open or the widget tour about to start');
  assert.equal(T.decide(fresh, { team: null, firstRunTour: 'skipped' }, null), 'dismiss');
  for (const status of ['finished', 'not-started', 'interrupted', null, undefined]) assert.equal(T.decide(fresh, { team: null, firstRunTour: status }, null), 'show', String(status));
  assert.equal(T.decide(T.dismiss(fresh, 'acct-1'), { team: null, firstRunTour: 'skipped' }, 'acct-1'), 'done');
});
