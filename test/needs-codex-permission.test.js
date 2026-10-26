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
  assert.deepEqual(CardView.disambiguate(tmux).slice(0, 2), ['win0', 'win1']);
  const same = rows.map((r) => ({ ...r, tmux: 'w' }));
  assert.deepEqual(CardView.disambiguate(same).slice(0, 2), ['1111', '2222']);
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
