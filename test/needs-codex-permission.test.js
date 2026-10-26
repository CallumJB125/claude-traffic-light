'use strict';
// A6: a Codex permission wait (askKind 'request') with no request file and no
// ask object must reach every surface that lists what needs the person.
const test = require('node:test');
const assert = require('node:assert/strict');
const PendingInputs = require('../src/pending-inputs.js');
const Home = require('../src/home-main.js');
const Overview = require('../src/session-overview.js');
const R = require('../rules.js');

const NOW = Date.parse('2026-10-26T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const codexAsk = (over = {}) => ({ sessionId: 'c1', host: 'local', source: 'codex', cwd: '/w/notes-app', signal: 'permission-ask', askKind: 'request', signalSince: iso(10), updatedAt: iso(10), ...over });

test('a request ask with no request file is a Needs-you input at once', () => {
  const inputs = PendingInputs.collect({ sessions: [codexAsk()], now: NOW });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].kind, 'permission');
  assert.equal(inputs[0].answerable, false);
  assert.deepEqual(inputs[0].actions, ['open']);
  assert.equal(inputs[0].created_at, iso(10));
  assert.equal(Home.needs(inputs, NOW).total, 1);
});

test('the widget look and the Agents bucket already read it as needing the person', () => {
  const s = codexAsk();
  assert.equal(R.resolve(R.defaultRules(), [s], NOW).look.lamp, 'red');
  const snap = Overview.snapshot({ sessions: [s], now: NOW });
  assert.equal(JSON.stringify(snap).includes('Needs you'), true);
});

test('a notification ask with no ask object is held 1.2 s; a request ask is not', () => {
  const young = { askKind: 'notification', signalSince: iso(300), updatedAt: iso(300) };
  assert.equal(PendingInputs.collect({ sessions: [codexAsk(young)], now: NOW }).length, 0);
  assert.equal(PendingInputs.collect({ sessions: [codexAsk({ ...young, askKind: null })], now: NOW }).length, 0);
  const old = { askKind: 'notification', signalSince: iso(1300), updatedAt: iso(1300) };
  assert.equal(PendingInputs.collect({ sessions: [codexAsk(old)], now: NOW }).length, 1);
  assert.equal(PendingInputs.collect({ sessions: [codexAsk({ signalSince: iso(0) })], now: NOW }).length, 1);
});

test('one input per session: a request file or a real ask covers it', () => {
  const req = { id: 'r1', kind: 'permission', tool: 'Bash', sessionId: 'c1', createdAt: iso(5), toolInput: { command: 'ls' } };
  assert.equal(PendingInputs.collect({ requests: [req], sessions: [codexAsk()], now: NOW }).length, 1);
  const ask = { kind: 'notification', title: 't', message: 'm', at: iso(5) };
  assert.equal(PendingInputs.collect({ sessions: [codexAsk({ ask })], now: NOW }).length, 1);
});
