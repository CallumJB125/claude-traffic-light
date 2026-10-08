'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build, createForHelp, onboardingView, firstSession } = require('../src/setup-checklist');

const okReport = { checks: [{ id: 'hooks', status: 'ok', detail: 'Installed.' }] };

test('a fresh install shows four steps, each with a fix that Help may open', () => {
  const c = build({ report: { checks: [{ id: 'hooks', status: 'fail', detail: 'No hooks.', next: 'Reinstall.' }] }, account: { signedIn: false }, tasks: [] });
  assert.deepEqual(c.rows.map((r) => r.id), ['hooks', 'signin', 'team', 'tackle']);
  assert.deepEqual(c.rows.map((r) => r.state), ['todo', 'todo', 'todo', 'todo']);
  assert.equal(c.done, 0);
  assert.ok(c.rows.every((r) => ['board', 'join', 'settings'].includes(r.fix.destination)));
  assert.deepEqual(c.rows[3].fix, { label: 'Open the board', destination: 'board' }, 'the card step opens the board, not Overview');
  assert.equal(c.prompt, null);
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

const tool = (id, label, extra = {}) => ({ id, label, installed: true, connected: false, state: 'ready', detail: 'Found on this Mac, not connected yet.', lastEvent: { at: null, text: 'no events yet' }, ...extra });

test('one row per detected tool, each Fix opening its own AI tools row, plus a single Connect all prompt', () => {
  const c = build({ report: okReport, account: { signedIn: false }, tasks: [], tools: [
    tool('claude', 'Claude Code', { connected: true, state: 'connected', lastEvent: { at: 1, text: '2 min ago' } }),
    tool('codex', 'Codex CLI'),
    tool('gemini', 'Gemini CLI', { state: 'fix', detail: 'settings.json is not valid JSON.' }),
    tool('cursor', 'Cursor', { installed: false, state: 'missing' }),
  ] });
  assert.deepEqual(c.rows.map((r) => r.id), ['tool:claude', 'tool:codex', 'tool:gemini', 'signin', 'team', 'tackle']);
  assert.match(c.rows[0].detail, /Connected\. Last event 2 min ago\./);
  assert.equal(c.rows[0].fix, null);
  assert.deepEqual(c.rows[1].fix, { label: 'Connect', destination: 'aitools:codex' });
  assert.deepEqual(c.rows[2].fix, { label: 'Fix', destination: 'aitools:gemini' });
  assert.match(c.rows[2].detail, /not valid JSON/);
  assert.deepEqual(c.prompt, { text: 'We found Codex CLI on this Mac. Connect it?', ids: ['codex'], fix: { label: 'Connect all', destination: 'aitools:all' } });
});

test('the prompt names every unconnected tool and disappears once all are connected', () => {
  const two = build({ tools: [tool('claude', 'Claude Code'), tool('codex', 'Codex CLI')] });
  assert.equal(two.prompt.text, 'We found Claude Code and Codex CLI on this Mac. Connect them?');
  const none = build({ tools: [tool('claude', 'Claude Code', { connected: true, state: 'connected' })] });
  assert.equal(none.prompt, null);
});

test('with no tool detected the Claude hooks row stays as before', () => {
  const c = build({ report: okReport, tools: [tool('cursor', 'Cursor', { installed: false })] });
  assert.equal(c.rows[0].id, 'hooks');
});

test('createForHelp passes the live tool list through', () => {
  const get = createForHelp({ report: () => okReport, account: () => null, tasks: () => null, tools: () => [tool('codex', 'Codex CLI')] });
  assert.equal(get().rows[0].id, 'tool:codex');
  const broken = createForHelp({ report: () => okReport, account: () => null, tasks: () => null, tools: () => { throw new Error('x'); } });
  assert.equal(broken().rows[0].id, 'hooks');
});

// ── First-run setup window ─────────────────────────────────────────────────
test('setup lists detected tools first, pre-selects the unconnected ones and collapses the rest', () => {
  const v = onboardingView({ claudeAuto: true, loginItem: true, tools: [
    tool('claude', 'Claude Code', { connected: true, state: 'connected' }),
    tool('codex', 'Codex'),
    tool('gemini', 'Gemini CLI', { state: 'fix', detail: 'settings.json is not valid JSON.' }),
    tool('cursor', 'Cursor', { installed: false, state: 'missing' }),
    tool('hermes', 'Hermes Agent', { installed: false, state: 'missing' }),
  ] });
  assert.deepEqual(v.rows.map((r) => r.id), ['claude', 'codex', 'gemini']);
  assert.deepEqual(v.pending, ['codex'], 'a tool that needs a fix is not ticked for one-click connect');
  assert.deepEqual(v.missing.map((m) => m.id), ['cursor', 'hermes']);
  const claude = v.rows[0];
  assert.equal(claude.auto, true);
  assert.equal(claude.canUndo, true, 'the automatic Claude connection is disclosed with an Undo');
  assert.equal(claude.status, 'Connected automatically');
  assert.match(v.rows[2].detail, /not valid JSON/);
  assert.equal(v.loginItem, true);
  assert.equal(v.session, null);
});

test('a Claude connection the person made is not called automatic, and Undo needs a saved backup', () => {
  const v = onboardingView({ claudeAuto: false, tools: [tool('claude', 'Claude Code', { connected: true, state: 'connected', canUndo: false }), tool('codex', 'Codex', { connected: true, state: 'connected', canUndo: true })] });
  assert.deepEqual(v.rows.map((r) => [r.id, r.auto, r.canUndo, r.status]), [['claude', false, false, 'Connected'], ['codex', false, true, 'Connected']]);
  assert.deepEqual(v.pending, []);
});

test('zero tools found gives no rows and every tool under not installed', () => {
  const v = onboardingView({ tools: [tool('claude', 'Claude Code', { installed: false }), tool('codex', 'Codex', { installed: false })] });
  assert.deepEqual(v.rows, []);
  assert.equal(v.missing.length, 2);
});

test('the first session signal reads as "<Tool> is working in <folder>"', () => {
  const tools = [tool('claude', 'Claude Code'), tool('codex', 'Codex')];
  assert.equal(firstSession([], tools), null);
  assert.equal(firstSession([{ sessionId: 'r', remote: true, deviceName: 'box', cwd: '/x/y', updatedAt: '2026-10-07T10:00:00Z' }], tools), null, 'another machine\'s session is not this Mac connecting');
  const s = firstSession([
    { sessionId: 'a', cwd: '/Users/me/plexiform-release', updatedAt: '2026-10-07T10:00:00Z' },
    { sessionId: 'b', source: 'codex', cwd: '/Users/me/api/', updatedAt: '2026-10-07T10:05:00Z' },
  ], tools);
  assert.deepEqual(s, { tool: 'codex', label: 'Codex', folder: 'api', text: 'Codex is working in api.' });
  assert.equal(firstSession([{ sessionId: 'a', cwd: '/Users/me/plexiform-release' }], tools).text, 'Claude Code is working in plexiform-release.');
  assert.equal(firstSession([{ sessionId: 'a', source: 'opencode' }], tools).text, 'Opencode is working.');
  const v = onboardingView({ tools, sessions: [{ sessionId: 'a', source: 'claude-code', cwd: 'C:\\work\\site' }] });
  assert.equal(v.session.text, 'Claude Code is working in site.');
});
