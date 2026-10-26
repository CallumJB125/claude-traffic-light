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
  assert.equal(Home.today(null, inputs, NOW).longestWaitMs, 10);
});

test('a pane dialog for the same session replaces the session-sourced permission item', () => {
  const dialog = { key: 'k', dialog: 'permission', title: 'Permission needed', text: 't', options: [], sessionId: 'c1', cwd: '/w/notes-app', seenAt: iso(5) };
  const kinds = PendingInputs.collect({ sessions: [codexAsk()], dialogs: [dialog], now: NOW }).map((i) => i.kind);
  assert.deepEqual(kinds, ['dialog']);
});

test('a Codex request_user_input is a question, not a permission', () => {
  const s = codexAsk({ askKind: null, codexLifecycle: 1, codexClosedTurn: false, codexTurnId: 't1', codexInputRequests: [{ id: 'q1', turnId: 't1', kind: 'sync', askedAt: iso(10) }] });
  const [i] = PendingInputs.collect({ sessions: [s], now: NOW });
  assert.equal(i.kind, 'question');
  assert.equal(i.answerable, false);
});

test('the widget look and the Agents bucket already read it as needing the person', () => {
  const s = codexAsk();
  assert.equal(R.resolve(R.defaultRules(), [s], NOW).look.lamp, 'red');
  const snap = Overview.snapshot({ sessions: [s], now: NOW });
  assert.equal(snap.sessions[0].bucket, 'needs');
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

// U5
const CardView = require('../src/session-card-view.js');
test('disambiguate: only a provider+project collision gets a tag; id is the fallback', () => {
  const rows = [
    { provider: 'Claude Code', project: 'notes-app', id: 'aaaa1111' }, { provider: 'Claude Code', project: 'notes-app', id: 'bbbb2222' },
    { provider: 'Codex', project: 'notes-app', id: 'cccc3333' }, { provider: 'Claude Code', project: 'other', id: 'dddd4444' },
  ];
  assert.deepEqual(CardView.disambiguate(rows), ['1111', '2222', '', '']);
  const tmux = rows.map((r, i) => ({ ...r, tmux: i < 2 ? `win${i}` : undefined }));
  assert.deepEqual(CardView.disambiguate(tmux).slice(0, 2), ['win0 1111', 'win1 2222'], 'the id tail always; the window as extra text');
  const same = rows.map((r) => ({ ...r, tmux: 'w' }));
  assert.deepEqual(CardView.disambiguate(same).slice(0, 2), ['w 1111', 'w 2222']);
  assert.deepEqual(CardView.disambiguate([]), []);
});

test('two same-folder sessions read differently on Needs you and Running now', () => {
  const sessions = [codexAsk({ sessionId: 'aaaa1111', cwd: '/w/notes-app' }), codexAsk({ sessionId: 'bbbb2222', cwd: '/w/notes-app' })];
  const inputs = PendingInputs.collect({ sessions, now: NOW });
  const projects = Home.needs(inputs, NOW).items.map((i) => i.project);
  assert.equal(new Set(projects).size, 2);
  assert.ok(projects.every((p) => /notes-app \(\w{4}\)/.test(p)), projects.join());
  const run = Home.running(sessions.map((s) => ({ ...s, updatedAt: iso(1000) })), NOW);
  assert.equal(new Set(run.items.map((i) => i.tag)).size, 2);
  const solo = Home.running([{ ...sessions[0], updatedAt: iso(1000) }], NOW);
  assert.equal(solo.items[0].tag, undefined);
});

// A7
const CV = require('../src/compose-view.js');
const { cardRow } = require('../src/compose-main.js');
test('a quiet task counts from its last activity, not its last state change', () => {
  const row = { state: 'quiet', label: 'Quiet', stateSinceMs: NOW - 1000, lastActivityMs: NOW - 12 * 60_000 };
  assert.match(CV.cardView({ title: 't', ai: 'claude', row }, NOW).status, /12 min/);
  assert.match(CV.cardView({ title: 't', ai: 'claude', row: { ...row, state: 'running', stateSinceMs: NOW - 5 * 60_000 } }, NOW).status, /5 min/);
  assert.match(CV.cardView({ title: 't', ai: 'claude', row }, NOW + 30 * 60_000).status, /42 min/);
  assert.equal(cardRow({ state: 'quiet' }, NOW).lastActivityMs, NOW);
  assert.equal(cardRow({ state: 'quiet' }).lastActivityMs, null);
});

test('the start-time tag is local HH:MM', () => {
  const at = new Date(2026, 9, 26, 9, 5).getTime();
  const rows = [{ provider: 'Codex', project: 'p', startedAt: at }, { provider: 'Codex', project: 'p', startedAt: at + 120000 }];
  assert.deepEqual(CardView.disambiguate(rows), ['09:05', '09:07']);
});

// C-D (PR 5b hard gate): the production path runs Rules.classifySession before collect.
test('classifySession → collect: two same-folder asks keep distinct tags, and grouping follows the label the overview prints', () => {
  const classify = (s) => R.classifySession(s, { now: NOW, isGone: () => false, workingStaleMs: 360000, waitingStaleMs: 4 * 3600000 });
  const raw = [codexAsk({ sessionId: 'aaaa1111', cwd: '/w/notes-app' }), codexAsk({ sessionId: 'bbbb2222', cwd: '/w/notes-app' })];
  const sessions = raw.map((s) => classify(s).session);
  assert.ok(sessions.every(Boolean));
  const inputs = PendingInputs.collect({ sessions, now: NOW });
  assert.equal(inputs.length, 2);
  assert.equal(new Set(inputs.map((i) => i.tag)).size, 2, inputs.map((i) => i.tag).join());
  assert.equal(Home.needs(inputs, NOW).total, 2);
  // Two unknown sources print as "Local AI": one group, so they are told apart.
  const odd = [codexAsk({ source: 'foo', sessionId: 'x-1111', cwd: '/w/app' }), codexAsk({ source: 'bar', sessionId: 'y-2222', cwd: '/w/app' })];
  const tags = PendingInputs.collect({ sessions: odd, now: NOW }).map((i) => i.tag);
  assert.deepEqual(tags.slice().sort(), ['1111', '2222']);
});

test('tags: a clash in the 4-character tail lengthens to 6 then 8, and a tmux window or title is extra text on a stable tag', () => {
  const a = { provider: 'Codex', project: 'p', id: 'x-ab1111' };
  const b = { provider: 'Codex', project: 'p', id: 'y-cd1111' };
  assert.deepEqual(CardView.disambiguate([a, b]), ['ab1111', 'cd1111']);
  const c = { provider: 'Codex', project: 'p', id: 'z-ab1111' };
  const d = { provider: 'Codex', project: 'p', id: 'q-ab1111' };
  const [t1, t2] = CardView.disambiguate([{ ...c, id: 'aa-1111ab1111' }, { ...d, id: 'bb-2222ab1111' }]);
  assert.notEqual(t1, t2);
  assert.ok(t1.length >= 6);
  const solo = CardView.disambiguate([{ ...a, id: 'k-aaaa1111', tmux: 'win0' }, { ...b, id: 'k-bbbb2222' }]);
  assert.deepEqual(solo, ['win0 1111', '2222'], 'the other row\'s tag does not change when this one has a window');
  assert.deepEqual(CardView.disambiguate([{ ...a, id: 'k-aaaa1111' }, { ...b, id: 'k-bbbb2222' }, { provider: 'Codex', project: 'p', id: 'k-cccc3333' }]).slice(0, 2), ['1111', '2222'], 'a third session joining does not relabel the first two');
});

// C-R
test('a session that started before the permission hook went in shows "restart this session", no buttons', () => {
  const HOOK_AT = NOW - 60_000;
  const old = codexAsk({ source: undefined, askKind: 'notification', ask: { kind: 'notification', title: 'Claude needs your permission', message: 'Run ls?', type: 'permission_prompt', at: iso(5000) }, startedAt: new Date(NOW - 3_600_000).toISOString() });
  const fresh = codexAsk({ source: undefined, sessionId: 'c2', askKind: 'notification', ask: { kind: 'notification', title: 'Claude needs your permission', message: 'Run ls?', type: 'permission_prompt', at: iso(5000) }, startedAt: new Date(NOW - 10_000).toISOString() });
  const A = require('../src/answerability.js');
  const [o] = PendingInputs.collect({ sessions: [old], now: NOW, askHooksAt: HOOK_AT });
  const [f] = PendingInputs.collect({ sessions: [fresh], now: NOW, askHooksAt: HOOK_AT });
  assert.equal(o.preHook, true);
  const ans = A.answerability({ ...o, answering: true }, { now: NOW });
  assert.deepEqual([ans.answerable, ans.reason, ans.action], [false, 'pre-hook', 'go-to-terminal']);
  assert.equal(A.reasonText('pre-hook'), 'Answer in the terminal (restart this session to answer here).');
  assert.equal(f.preHook, undefined, 'started after the install: not pre-hook');
  assert.equal(PendingInputs.collect({ sessions: [old], now: NOW })[0].preHook, undefined, 'no install time recorded: nothing claimed');
});
