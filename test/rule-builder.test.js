'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../rules.js');
const T = require('../src/rule-templates.js');
const W = require('../src/rule-words.js');
const { createRuleNotify, install, RATE_MS } = require('../src/rule-notify-main.js');

const ROOT = path.join(__dirname, '..');
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

test('there are at least 8 templates, each a valid rule that normalizes unchanged', () => {
  const list = T.list();
  assert.ok(list.length >= 8);
  assert.equal(new Set(list.map((t) => t.id)).size, list.length);
  const known = new Set(R.SIGNALS.map((s) => s.id));
  for (const t of list) {
    assert.ok(t.name && t.description && !t.description.includes('\n'), t.id);
    const raw = T.instantiate(t.id, () => 'x1');
    const n = R.normalizeRule(raw);
    assert.equal(n.id, 'x1');
    assert.equal(n.locked, false);
    assert.equal(n.enabled, true);
    assert.ok(n.when.signal.length && n.when.signal.every((s) => known.has(s)), `${t.id} signals`);
    for (const [k, v] of Object.entries(raw.then)) assert.deepEqual(n.then[k], v, `${t.id} then.${k} survives normalizeRule`);
    if (raw.when.forMinutes) assert.equal(n.when.forMinutes, raw.when.forMinutes);
    assert.deepEqual(R.normalizeRule(n), n, `${t.id} is stable`);
  }
  assert.equal(T.instantiate('nope'), null);
});

test('applying a template inserts a new rule under the locked ones and never overwrites', () => {
  const rules = R.defaultRules();
  const before = JSON.stringify(rules);
  const r = R.normalizeRule(T.instantiate('stuck', R.uid));
  const out = T.insert(rules, r);
  assert.equal(out.length, rules.length + 1);
  assert.equal(JSON.stringify(rules), before, 'input untouched');
  const at = out.findIndex((x) => x.id === r.id);
  assert.ok(out.slice(0, at).every((x) => x.locked) && !out[at].locked);
  const again = T.insert(out, R.normalizeRule(T.instantiate('stuck', R.uid)));
  assert.equal(again.filter((x) => x.name === r.name).length, 2, 'a second copy is added, not merged');
  const a = T.instantiate('ci-banner'); a.then.text = 'MUTATED';
  assert.equal(T.instantiate('ci-banner').then.text, 'CI FAILED', 'instances are deep copies');
});

test('describeRule: one plain sentence for every template', () => {
  const want = {
    stuck: 'When you send a prompt, Claude uses a tool, a tool finishes, a subagent starts or a subagent finishes, and it stays that way for over 15 minutes, show the facepalm pose, give Claude dizzy eyes and send a desktop notification.',
    celebrate: 'When Claude finishes a task, show the party pose, add a confetti screen effect, play the Glass sound and burst confetti.',
    'ci-banner': 'When CI failed on your branch, show the banner pose reading "CI FAILED", recolour the eyes and send a desktop notification.',
    'focus-quiet': "When you're busy (calendar or Focus), show the sleep pose, give Claude sleepy eyes and hold its pings while you're busy.",
    'waiting-5': 'When Claude asks permission, Claude is waiting for you or Claude finishes a task, and it stays that way for over 5 minutes, show the knock pose and notify you on your desktop and phone.',
    'ci-party': 'When CI passed on your branch or a deploy workflow finished, show the party pose, recolour the eyes and add fireworks.',
    nap: 'When no sessions running, show the sleep pose, give Claude sleepy eyes and add stars.',
    'over-budget': 'When spend is over your budget or a session is burning money fast, show the banner pose reading "OVER BUDGET", give Claude money eyes and send a desktop notification.',
    'question-2': 'When Claude asks permission, and it stays that way for over 2 minutes, show the wave pose, play the Ping sound and send a desktop notification.',
  };
  for (const t of T.list()) {
    const s = W.describeRule(R.normalizeRule(T.instantiate(t.id)), R.SIGNALS);
    assert.equal(s, want[t.id], t.id);
    assert.equal(s.split('. ').length, 1, 'one sentence');
  }
});

test('describeRule: lamps, scope, phone, off and empty rules', () => {
  const d = (r) => W.describeRule(R.normalizeRule(r), R.SIGNALS);
  assert.equal(d({ when: { signal: ['permission-ask'] }, then: { lamp: 'red', sound: 'beep' } }), 'When Claude asks permission, turn the lamp red and beep.');
  assert.equal(d({ when: { signal: ['tool-use'], tool: 'Bash', cwd: 'bondly*' }, then: { notify: 'phone' } }), 'When Claude uses a tool using Bash in bondly*, notify your phone.');
  assert.equal(d({ enabled: false, when: { signal: ['stop'] }, then: {} }), 'Off. When Claude finishes a task, change nothing you can see.');
  assert.match(d({ when: { signal: [] }, then: { lamp: 'off' } }), /^Never \(no signal picked\), turn the lamp off\.$/);
  assert.equal(d({ when: { signal: ['stop'], forMinutes: 1 }, then: { lamp: 'amber' } }), 'When Claude finishes a task, and it stays that way for over 1 minute, turn the lamp amber.');
});

test('normalizeRule keeps notify and forMinutes only when valid, and adds no keys otherwise', () => {
  const plain = R.normalizeRule({ when: { signal: ['stop'] }, then: { lamp: 'amber' } });
  assert.ok(!('notify' in plain.then) && !('forMinutes' in plain.when));
  const bad = R.normalizeRule({ when: { signal: ['stop'], forMinutes: 0 }, then: { notify: 'email' } });
  assert.ok(!('notify' in bad.then) && !('forMinutes' in bad.when));
  for (const v of [-1, 1.5, 1441, 'x']) assert.ok(!('forMinutes' in R.normalizeRule({ when: { signal: ['stop'], forMinutes: v } }).when), String(v));
  const good = R.normalizeRule({ when: { signal: ['stop'], forMinutes: '5' }, then: { notify: 'both' } });
  assert.equal(good.when.forMinutes, 5);
  assert.equal(good.then.notify, 'both');
  assert.deepEqual(R.NOTIFY_TARGETS, ['desktop', 'phone', 'both']);
});

test('engine: when.forMinutes holds a rule until the signal has lasted that long', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const rules = [
    { id: 'slow', name: 'Waiting 5', enabled: true, when: { signal: ['idle-nudge'], forMinutes: 5 }, then: { pose: 'knock' } },
    ...R.defaultRules(),
  ];
  const at = (mins) => R.resolve(rules, [{ signal: 'idle-nudge', sessionId: 's', cwd: '/a', updatedAt: iso(now - mins * MIN) }], now);
  assert.ok(!at(4).fired.includes('slow'));
  assert.notEqual(at(4).look.pose, 'knock');
  assert.ok(at(5).fired.includes('slow'));
  assert.equal(at(5).look.pose, 'knock');
  // No timestamp: a forMinutes rule cannot know, so it stays off; a plain rule still matches.
  const rule = R.normalizeRule(rules[0]);
  assert.equal(R.ruleMatches(rule, { signal: 'idle-nudge' }, now), false);
  assert.equal(R.ruleMatches(R.normalizeRule({ when: { signal: ['idle-nudge'] } }), { signal: 'idle-nudge' }, now), true);
  // liveSessions is what resolve matches against.
  assert.deepEqual(R.liveSessions([], now, {}).map((s) => s.signal), ['idle']);
});

function rig({ rules, config = {}, phone = false, busy = () => false } = {}) {
  let t = Date.parse('2026-10-19T12:00:00Z');
  let sessions = [];
  const shown = [];
  const n = createRuleNotify({
    now: () => t,
    config: () => ({ rules, ...config }),
    sessions: () => sessions,
    desktop: (title, body) => shown.push({ title, body }),
    phoneReady: () => phone,
    busy,
  });
  return {
    n, shown,
    advance: (ms) => { t += ms; },
    set: (list) => { sessions = list; },
    now: () => t,
  };
}
const WAITING = { id: 'w', name: 'Waiting on me', enabled: true, when: { signal: ['permission-ask'] }, then: { notify: 'desktop' } };

test('notify is edge-triggered: once per session per activation, primed on the first tick', () => {
  const r = rig({ rules: [WAITING] });
  r.set([{ signal: 'permission-ask', sessionId: 'a', cwd: '/x/proj', updatedAt: iso(r.now()) }]);
  assert.deepEqual(r.n.tick(), [], 'already active at launch: no ping');
  r.set([]); r.n.tick();
  r.advance(RATE_MS);
  r.set([{ signal: 'permission-ask', sessionId: 'a', cwd: '/x/proj', updatedAt: iso(r.now()) }]);
  const sent = r.n.tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(r.shown, [{ title: 'Waiting on me', body: 'Claude asks permission in proj' }]);
  r.advance(RATE_MS * 3); r.n.tick(); r.n.tick();
  assert.equal(r.shown.length, 1, 'still active: no repeat');
});

test('notify is rate limited to one per rule per two minutes', () => {
  const r = rig({ rules: [WAITING] });
  r.n.tick();
  r.set([{ signal: 'permission-ask', sessionId: 'a', cwd: '/a', updatedAt: iso(r.now()) }]);
  r.n.tick();
  r.set([{ signal: 'permission-ask', sessionId: 'a', cwd: '/a', updatedAt: iso(r.now()) }, { signal: 'permission-ask', sessionId: 'b', cwd: '/b', updatedAt: iso(r.now()) }]);
  r.advance(60000); r.n.tick();
  assert.equal(r.shown.length, 1, 'a second session inside the window is held');
  r.set([]); r.n.tick();
  r.advance(RATE_MS);
  r.set([{ signal: 'permission-ask', sessionId: 'b', cwd: '/b', updatedAt: iso(r.now()) }]);
  r.n.tick();
  assert.equal(r.shown.length, 2);
});

test('quiet hours, timed quiet, snooze and project mutes suppress notify (dropped, not queued)', () => {
  const ask = (r) => [{ signal: 'permission-ask', sessionId: 'a', cwd: '/x/proj', updatedAt: iso(r.now()) }];
  const cases = [
    (now) => ({ quietUntil: now + MIN }),
    (now) => ({ snoozeUntil: now + MIN }),
    () => ({ mutedProjects: ['proj'] }),
    () => ({ quietHours: { enabled: true, start: '00:00', end: '23:59' } }),
  ];
  for (const make of cases) {
    const config = {};
    const r = rig({ rules: [WAITING], config });
    Object.assign(config, make(r.now()));
    r.n.tick();
    r.set(ask(r));
    r.n.tick();
    assert.equal(r.shown.length, 0, JSON.stringify(config));
    delete config.quietUntil; delete config.snoozeUntil; delete config.mutedProjects; delete config.quietHours;
    r.advance(RATE_MS); r.n.tick();
    assert.equal(r.shown.length, 0, 'the held activation does not fire later');
  }
});

test('notify targets: phone sends nothing until paired, both sends the desktop half, disabled rules never fire', () => {
  for (const [target, n] of [['phone', 0], ['both', 1], ['desktop', 1]]) {
    const r = rig({ rules: [{ ...WAITING, then: { notify: target } }] });
    r.n.tick();
    r.set([{ signal: 'permission-ask', sessionId: 'a', updatedAt: iso(r.now()) }]);
    const sent = r.n.tick();
    assert.equal(sent.length, 1, target);
    assert.equal(r.shown.length, n, target);
    assert.deepEqual(r.n.status(), { desktop: true, phone: false, phoneNote: 'Pair a phone first' });
  }
  const off = rig({ rules: [{ ...WAITING, enabled: false }] });
  off.n.tick(); off.set([{ signal: 'permission-ask', sessionId: 'a', updatedAt: iso(off.now()) }]);
  assert.deepEqual(off.n.tick(), []);
});

test('notify honours forMinutes: fires when the wait crosses the threshold', () => {
  const rule = { ...WAITING, when: { signal: ['permission-ask'], forMinutes: 5 } };
  const r = rig({ rules: [rule] });
  const since = r.now();
  r.n.tick();
  r.set([{ signal: 'permission-ask', sessionId: 'a', updatedAt: iso(since) }]);
  r.advance(4 * MIN); r.n.tick();
  assert.equal(r.shown.length, 0);
  r.advance(MIN); r.n.tick();
  assert.equal(r.shown.length, 1);
});

test('install wires the status channel and a desktop Notification', () => {
  const handlers = {};
  const shown = [];
  class FakeNotification { constructor(o) { this.o = o; } static isSupported() { return true; } show() { shown.push(this.o); } }
  const realSet = global.setInterval;
  let tickFn = null;
  global.setInterval = (fn) => { tickFn = fn; return { unref() {} }; };
  let sessions = [];
  try {
    install({ Notification: FakeNotification, handle: (ch, allowed, fn) => { handlers[ch] = { allowed, fn }; }, allowed: () => true, config: () => ({ rules: [WAITING] }), sessions: () => sessions });
  } finally { global.setInterval = realSet; }
  assert.deepEqual(handlers['rule-notify:status'].fn(), { desktop: true, phone: false, phoneNote: 'Pair a phone first' });
  tickFn();
  sessions = [{ signal: 'permission-ask', sessionId: 'a', updatedAt: new Date().toISOString() }];
  tickFn();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].silent, true);
  assert.equal(shown[0].title, 'Waiting on me');
});

test('main installs the notifier in one line and the Lights page carries the picker, preview and notify control', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.equal(main.split('\n').filter((l) => l.includes("require('./src/rule-notify-main.js').install(")).length, 1);
  const html = fs.readFileSync(path.join(ROOT, 'lights.html'), 'utf8');
  for (const id of ['rule-template', 'rule-words', 'notify', 'for-minutes']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.ok(html.indexOf('src="rules.js"') < html.indexOf('src="src/rule-words.js"') && html.indexOf('src="src/rule-words.js"') < html.indexOf('src="lights-view.js"'));
  assert.match(fs.readFileSync(path.join(ROOT, 'lights-preload.js'), 'utf8'), /rule-notify:status/);
  assert.match(fs.readFileSync(path.join(ROOT, 'board', 'CONTRACT.md'), 'utf8'), /`rule-notify:status`/);
});

test('a meeting or screen share holds notify like a nudge (dropped, not replayed)', () => {
  let inMeeting = true;
  const r = rig({ rules: [WAITING], busy: () => inMeeting });
  r.n.tick();
  r.set([{ signal: 'permission-ask', sessionId: 'a', cwd: '/x/proj', updatedAt: iso(r.now()) }]);
  r.n.tick();
  assert.equal(r.shown.length, 0, 'held during the meeting');
  inMeeting = false;
  r.advance(RATE_MS); r.n.tick();
  assert.equal(r.shown.length, 0, 'still the same activation: not replayed after the meeting');
  r.set([]); r.n.tick();
  r.set([{ signal: 'permission-ask', sessionId: 'a', cwd: '/x/proj', updatedAt: iso(r.now()) }]);
  r.n.tick();
  assert.equal(r.shown.length, 1, 'a new activation after the meeting notifies');
});
