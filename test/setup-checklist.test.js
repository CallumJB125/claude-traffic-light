'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build, createForHelp } = require('../src/setup-checklist');

const okReport = { checks: [{ id: 'hooks', status: 'ok', detail: 'Installed.' }] };

test('a fresh install shows four steps, each with a fix that Help may open', () => {
  const c = build({ report: { checks: [{ id: 'hooks', status: 'fail', detail: 'No hooks.', next: 'Reinstall.' }] }, account: { signedIn: false }, tasks: [] });
  assert.deepEqual(c.rows.map((r) => r.id), ['hooks', 'signin', 'team', 'tackle']);
  assert.deepEqual(c.rows.map((r) => r.state), ['todo', 'todo', 'todo', 'todo']);
  assert.equal(c.done, 0);
  assert.ok(c.rows.every((r) => ['overview', 'join', 'settings'].includes(r.fix.destination)));
  assert.match(c.rows[0].detail, /No hooks\. Reinstall\./);
});

test('every step reads its own source and the panel completes when all are done', () => {
  const c = build({ report: okReport, account: { signedIn: true, name: 'Ada', teamName: 'Core' }, tasks: [{ id: 't' }] });
  assert.equal(c.complete, true);
  assert.ok(c.rows.every((r) => r.state === 'done' && r.fix === null));
});

test('missing sources are unknown, never done', () => {
  const c = build({});
  assert.deepEqual(c.rows.map((r) => r.state), ['unknown', 'unknown', 'unknown', 'unknown']);
  assert.equal(c.complete, false);
});

test('signed in without a team leaves only the team step open', () => {
  const c = build({ report: okReport, account: { signedIn: true }, tasks: [{}] });
  assert.deepEqual(c.rows.map((r) => r.state), ['done', 'done', 'todo', 'done']);
});

test('the health report is reused for a few seconds and a throwing source is just unknown', () => {
  let t = 0, runs = 0;
  const f = createForHelp({ report: () => { runs++; return okReport; }, account: () => { throw new Error('x'); }, tasks: () => null, now: () => t });
  f(); t = 4000; f();
  assert.equal(runs, 1);
  t = 6000; assert.equal(f().rows[1].state, 'unknown');
  assert.equal(runs, 2);
});
