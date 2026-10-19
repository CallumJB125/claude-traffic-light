'use strict';
// The widget's notification lane (src/widget-lane-view.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../src/widget-lane-view.js');

const T = 1_000_000;
const ev = (kind, sessionId, text, at = T, id = `${kind}-${sessionId}-${at}`) => ({ id, kind, sessionId, text, at });

test('laneModel keeps the last three live events, newest first, with age and fading', () => {
  let list = [];
  list = L.pushEvent(list, ev('needs-you', 'a', 'app needs your OK', T), T);
  list = L.pushEvent(list, ev('finished', 'b', 'api finished', T + 1000), T + 1000);
  list = L.pushEvent(list, ev('stuck', 'c', 'web has gone quiet', T + 2000), T + 2000);
  list = L.pushEvent(list, ev('ci-failed', 'd', 'CI failed', T + 3000), T + 3000);
  assert.equal(list.length, 3, 'the list is capped');
  const rows = L.laneModel(list, { now: T + 3000 });
  assert.deepEqual(rows.map((r) => r.kind), ['ci-failed', 'stuck', 'finished']);
  assert.deepEqual(rows.map((r) => r.age), [0, 1000, 2000]);
  assert.ok(rows.every((r) => r.fading === false));
  const later = L.laneModel(list, { now: T + 1000 + 7000 });
  assert.equal(later.find((r) => r.kind === 'finished').fading, true, 'fades in its last stretch');
  assert.equal(L.laneModel(list, { now: T + 1000 + 8000 }).some((r) => r.kind === 'finished'), false, 'gone after ttl');
});

test('pushEvent dedupes by kind and session, keeping the newer one', () => {
  let list = L.pushEvent([], ev('needs-you', 'a', 'first', T), T);
  list = L.pushEvent(list, ev('needs-you', 'a', 'second', T + 500), T + 500);
  list = L.pushEvent(list, ev('finished', 'a', 'done', T + 600), T + 600);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((e) => e.text), ['second', 'done']);
});

test('max and ttl are options; nothing past ttl is ever returned', () => {
  const list = [ev('stuck', 'a', 'x', T), ev('stuck', 'b', 'y', T + 10), ev('stuck', 'c', 'z', T + 20)];
  assert.equal(L.laneModel(list, { now: T + 20, max: 2 }).length, 2);
  assert.equal(L.laneModel(list, { now: T + 100, ttlMs: 90 }).length, 1);
});

test('off-contract events are refused and text is clipped and de-controlled', () => {
  assert.deepEqual(L.pushEvent([], { kind: 'nope', text: 'x' }, T), []);
  assert.deepEqual(L.pushEvent([], { kind: 'stuck', text: '' }, T), []);
  assert.deepEqual(L.pushEvent([], null, T), []);
  const [e] = L.pushEvent([], { kind: 'teammate', text: `a\u0000b\n${'x'.repeat(300)}` }, T);
  assert.equal(e.text.length, L.TEXT_MAX);
  assert.ok(!/[\u0000-\u001f]/.test(e.text));
  assert.equal(e.at, T, 'a missing time is now');
});

test('nextChangeMs points at the next fade or expiry', () => {
  const list = [ev('stuck', 'a', 'x', T)];
  assert.equal(L.nextChangeMs(list, { now: T }), L.TTL_MS - L.FADE_MS);
  assert.equal(L.nextChangeMs(list, { now: T + L.TTL_MS - 1000 }), 1000);
  assert.equal(L.nextChangeMs([], { now: T }), null);
});

test('the widget renders lane text with textContent only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'widget.js'), 'utf8');
  const block = src.slice(src.indexOf('// Notification lane and rings'), src.indexOf('// Voice states from main'));
  assert.ok(block.length > 100);
  assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(block, /text\.textContent = r\.text/);
});
