const test = require('node:test');
const assert = require('node:assert/strict');
const Help = require('../help.js');
const Rules = require('../rules.js');

// ── First run ──────────────────────────────────────────────────────────────
test('help auto-shows only on a real run with no marker yet', () => {
  assert.equal(Help.shouldAutoShow({ markerExists: false, devRun: false }), true);
  assert.equal(Help.shouldAutoShow({ markerExists: true, devRun: false }), false);
  assert.equal(Help.shouldAutoShow({ markerExists: false, devRun: true }), false);
  assert.equal(Help.MARKER, '.help-shown');
});

// ── Notification config ────────────────────────────────────────────────────
test('notifications default to on for every state, and a saved partial breakdown keeps the rest on', () => {
  assert.deepEqual(Help.notifyConfig(undefined), { on: true, kinds: { 'permission-ask': true, 'turn-failed': true, offline: true } });
  assert.deepEqual(Help.notifyConfig({}), { on: true, kinds: Help.NOTIFY_DEFAULTS });
  const c = Help.notifyConfig({ notifyOnStates: false, notifyStates: { offline: false } });
  assert.equal(c.on, false);
  assert.deepEqual(c.kinds, { 'permission-ask': true, 'turn-failed': true, offline: false });
});

// ── Notification dedup ─────────────────────────────────────────────────────
const ask = (id, extra = {}) => ({ sessionId: id, cwd: `/work/${id}`, signal: 'permission-ask', tool: 'Bash', ...extra });
const failed = (id, extra = {}) => ({ sessionId: id, cwd: `/work/${id}`, signal: 'turn-failed', ...extra });
const working = (id) => ({ sessionId: id, cwd: `/work/${id}`, signal: 'tool-use' });
const run = (prev, next, config = {}) => Help.notifications(prev, { sessions: [], pending: [], offline: false, ...next }, config);

test('the first look only records what is already going on', () => {
  const r = run(null, { sessions: [ask('a'), failed('b')], offline: true });
  assert.deepEqual(r.fire, []);
  assert.deepEqual([...r.keys].sort(), ['offline', 'permission-ask:a', 'turn-failed:b']);
});

test('one notification per state entry, never again while it holds, again once it comes back', () => {
  let r = run(null, { sessions: [working('a')] });
  r = run(r.keys, { sessions: [ask('a', { hostApp: 'Ghostty' })] });
  assert.equal(r.fire.length, 1);
  assert.equal(r.fire[0].kind, 'permission-ask');
  assert.equal(r.fire[0].title, 'Needs your input — a');
  assert.equal(r.fire[0].body, 'Claude wants to use Bash.');
  assert.equal(r.fire[0].hostApp, 'Ghostty');
  assert.equal(r.fire[0].cwd, '/work/a');
  // Polled again (and again) while still asking: silent.
  r = run(r.keys, { sessions: [ask('a')] });
  assert.deepEqual(r.fire, []);
  r = run(r.keys, { sessions: [ask('a')] });
  assert.deepEqual(r.fire, []);
  // Answered, then asks again: a new entry.
  r = run(r.keys, { sessions: [working('a')] });
  assert.deepEqual(r.fire, []);
  r = run(r.keys, { sessions: [ask('a')] });
  assert.equal(r.fire.length, 1);
});

test('each session is its own state; an AskUserQuestion reads as a question', () => {
  let r = run(new Set(['permission-ask:a']), { sessions: [ask('a'), ask('b', { askKind: 'question' })] });
  assert.deepEqual(r.fire.map((f) => f.key), ['permission-ask:b']);
  assert.equal(r.fire[0].body, 'Claude has a question for you.');
  assert.equal(r.fire[0].hostApp, null);
});

test('a failed turn says why, and a pending widget request counts as an ask', () => {
  const r = run(new Set(), {
    sessions: [failed('a', { failKind: 'network' }), working('b')],
    pending: [{ id: 'r1', sessionId: 'b', cwd: '/work/b', tool: 'Edit' }],
  });
  assert.deepEqual(r.fire.map((f) => f.key), ['turn-failed:a', 'permission-ask:b']);
  assert.equal(r.fire[0].body, 'No network. Retry in the terminal.');
  assert.equal(r.fire[1].body, 'Claude wants to use Edit.');
  // The session file catching up to the request is the same ask, not a new one.
  assert.deepEqual(run(r.keys, { sessions: [failed('a'), ask('b')] }).fire, []);
});

test('offline fires once while sessions are open, and not at all with none', () => {
  let r = run(new Set(), { sessions: [working('a')], offline: true });
  assert.deepEqual(r.fire.map((f) => f.key), ['offline']);
  assert.equal(r.fire[0].title, 'No network');
  r = run(r.keys, { sessions: [working('a'), working('b')], offline: true });
  assert.deepEqual(r.fire, []);
  assert.deepEqual(run(new Set(), { sessions: [], offline: true }).fire, []);
});

test('the master toggle and the per-state breakdown silence notifications but still track state', () => {
  const next = { sessions: [ask('a'), failed('b')], offline: true };
  const off = run(new Set(), next, { notifyOnStates: false });
  assert.deepEqual(off.fire, []);
  // Turning it back on mid-state doesn't replay what was already going on.
  assert.deepEqual(run(off.keys, next, {}).fire, []);
  const some = run(new Set(), next, { notifyStates: { 'turn-failed': false, offline: false } });
  assert.deepEqual(some.fire.map((f) => f.key), ['permission-ask:a']);
});

test('non-notifiable signals never fire', () => {
  const r = run(new Set(), { sessions: [working('a'), { sessionId: 'c', cwd: '/c', signal: 'stop' }, { sessionId: 'd', cwd: '/d', signal: 'idle-nudge' }, { sessionId: 'e', signal: 'limit-hit' }] });
  assert.deepEqual(r.fire, []);
});

// ── Explanations ───────────────────────────────────────────────────────────
const rules = Rules.defaultRules();
const stateFor = (sessions, env = {}) => {
  const { look, fired, owned } = Rules.resolve(rules, sessions, Date.now(), env);
  return { look, fired, owned, firedNames: Rules.firedNames(rules, fired, owned), reason: sessions.length ? 'session' : 'idle', sessions, minions: Rules.liveAgents(sessions) };
};

test('explains a permission ask by the rule that owns the lamp, with its pose', () => {
  const h = Help.explain(stateFor([ask('a')]), rules);
  assert.equal(h.headline, 'Needs your input');
  assert.equal(h.lamp, 'amber');
  assert.match(h.meaning, /answer in the terminal/);
  assert.deepEqual(h.why.find((w) => w.label === 'Pose'), { label: 'Pose', value: 'waving at you', rule: 'Needs your input' });
  assert.equal(h.agents, null);
});

test('explains the agent chips and who is working', () => {
  const s = { ...working('a'), tool: 'Agent', agents: [{ id: 'x', name: 'executor', kind: 'subagent', status: 'working' }, { id: 'y', name: 'verifier', kind: 'teammate', status: 'waiting' }] };
  const h = Help.explain(stateFor([s]), rules);
  assert.match(h.agents.text, /2 little chips/);
  assert.match(h.agents.text, /Green and bobbing = working/);
  assert.deepEqual(h.agents.list.map((a) => a.name), ['executor', 'verifier']);
  assert.ok(h.why.some((w) => w.label === 'Eyes' && w.value === 'purple eyes' && w.rule === 'Subagent running'));
});

test('explains gardening by the rule that turned the Garden effect on', () => {
  const garden = rules.map((r) => (r.id === 'idle' ? { ...r, then: { ...r.then, effect: 'garden' } } : r));
  const { look, fired, owned } = Rules.resolve(garden, []);
  const h = Help.explain({ look, fired, owned, firedNames: Rules.firedNames(garden, fired, owned), reason: 'idle', sessions: [] }, garden, { travel: 'Gardening' });
  assert.equal(h.headline, 'Nothing running');
  assert.match(h.activity, /gardening.*“Nothing running” has the Garden effect on/);
});

test('a rule the user repurposed gets a generic line built from its signals', () => {
  const custom = [{ ...Rules.normalizeRule({ id: 'mine', name: 'Deploying', when: { signal: ['tool-use'], tool: 'Bash' }, then: { lamp: 'red' } }) }];
  const { look, fired, owned } = Rules.resolve(custom, [{ ...working('a'), tool: 'Bash' }]);
  const h = Help.explain({ look, fired, owned, firedNames: Rules.firedNames(custom, fired, owned), reason: 'session', sessions: [working('a')] }, custom);
  assert.equal(h.headline, 'Deploying');
  assert.equal(h.meaning, 'Your rule — it fires when Claude uses a tool.');
});
