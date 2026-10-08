
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../widget.js'), 'utf8');
const refreshSource = source.slice(source.indexOf('let refreshSeq = 0;'), source.indexOf('// Every waiting input'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(fetch) {
  const pendingTimers = [], painted = [], bubble = [];
  const context = { window: { trafficLight: { getAggregateStatus: fetch } }, setTimeout: f => { pendingTimers.push(f); return pendingTimers.length; }, clearTimeout() {}, clearInterval() {},
    rig: { look: { lamp: 'green', pose: 'work', minions: 2, agents: ['old'], showRoster: true }, setLook: look => { context.rig.look = look; } },
    tooltip: { textContent: 'Working' }, bubble: { update: items => bubble.push(items) }, confettiTimer: 1, sleepSince: 1, smokeSince: 1, lastRuleId: 'old', console: { error() {} }, applyStatus: data => painted.push(data) };
  vm.createContext(context); vm.runInContext(refreshSource, context);
  return { context, painted, bubble, pendingTimers, refresh: () => context.refresh() };
}
test('hung widget refresh drops old green/agents/input and refuses a late reply', async () => {
  let resolve; const f = fixture(() => new Promise(r => { resolve = r; }));
  const done = f.refresh(); f.pendingTimers[0](); await done;
  assert.equal(f.context.rig.look.lamp, 'off'); assert.equal(f.context.rig.look.minions, 0);
  assert.equal(f.context.rig.look.showRoster, false); assert.equal(f.context.rig.look.celebrate, false);
  assert.equal(f.bubble[0].length, 0); assert.match(f.context.tooltip.textContent, /unavailable/);
  resolve({ look: { lamp: 'green' } }); await tick(); assert.equal(f.painted.length, 0);
});
test('null or unreadable widget status clears stale reports', async () => {
  for (const value of [null, {}, { look: null }]) { const f = fixture(async () => value); await f.refresh(); assert.equal(f.context.rig.look.lamp, 'off'); assert.match(f.context.tooltip.textContent, /unavailable/); }
});
test('older widget refresh failure cannot erase a newer accepted state', async () => {
  let reject; let count = 0; const fresh = { look: { lamp: 'amber' } };
  const f = fixture(() => ++count === 1 ? new Promise((_, r) => { reject = r; }) : Promise.resolve(fresh));
  const old = f.refresh(); await f.refresh(); reject(new Error('old')); await old;
  assert.equal(f.painted[0], fresh); assert.equal(f.bubble.length, 0);
});
test('widget periodically refreshes metadata when push delivery is lost', () => {
  const calls = [], timers = [], context = { refresh: () => calls.push('fetched'), window: { trafficLight: { onStatusChanged: () => {} } }, setInterval: (fn, ms) => timers.push({ fn, ms }) };
  const start = source.indexOf('refresh();\nwindow.trafficLight.onStatusChanged(refresh);');
  const end = source.indexOf('setInterval(refresh, 5000);', start) + 'setInterval(refresh, 5000);'.length;
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(calls.length, 1); assert.equal(timers.length, 1); assert.ok(timers[0].ms <= 5000);
  timers[0].fn(); assert.equal(calls.length, 2, 'timer fetches despite absent status pushes');
});

test('stale/offline/unavailable reports cannot paint working green, while manual looks retain human intent', () => {
  const start = source.indexOf('function reportedLook(data) {'), end = source.indexOf('function applyStatus(data) {', start);
  const c = { hovering: true, aim: {} }; vm.createContext(c); vm.runInContext(source.slice(start, end), c);
  for (const providerStatus of [{ available: false }, { online: false, providers: [{ recent: 1 }] }, { providers: [{ recent: 0 }, { recent: 0 }] }]) {
    const data = { reason: 'session', look: { lamp: 'green', pose: 'work', minions: 2, agents: ['old'], celebrate: true }, providerStatus };
    const look = c.reportedLook(data); assert.equal(look.lamp, 'off'); assert.equal(look.minions, 0); assert.equal(look.showRoster, false);
    for (const reason of ['manual', 'preview', 'travel']) assert.equal(c.reportedLook({ ...data, reason }).lamp, 'green');
  }
  assert.equal(c.reportedLook({ reason: 'session', look: { lamp: 'amber' }, providerStatus: { online: true, available: true, providers: [{ recent: 1 }, { recent: 0 }] } }).lamp, 'amber');
});
