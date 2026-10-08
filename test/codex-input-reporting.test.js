'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const Codex = require('../adapters/codex');
const State = require('../hooks/session-state');
const Machine = require('../hooks/session-machine');
const Overview = require('../src/session-overview');
const Providers = require('../src/provider-status');
const NOW = Date.parse('2026-10-02T07:00:00.000Z');
const SECRET = 'PRIVATE_QUESTION_ANSWER_COMMAND_PATH';
const payload = (event, fields = {}) => ({ hook_event_name: event, session_id: 'session-1', cwd: '/synthetic/project', turn_id: 'turn-1', source: 'startup', ...fields });
const iso = delta => new Date(NOW + delta).toISOString();
const event = (name, fields = {}) => Codex.normalize(name, payload(name, fields))[0];
const reduce = (prev, name, fields = {}, delta = 0) => State.reduceCodexLifecycle(prev, event(name, fields), iso(delta));
const start = () => reduce(undefined, 'UserPromptSubmit');
const ask = (prev = start(), kind = 'async', id = 'call-1', delta = 1, fields = {}) => reduce(prev, 'PreToolUse', { tool_name: kind === 'async' ? 'functions.request_user_input_async' : 'functions.request_user_input', tool_use_id: id, ...fields }, delta);
function shows(s, now = NOW + 10) {
  const classification = Machine.classify(s, { now, workingStaleMs: 120000, waitingStaleMs: 240000 });
  const row = Overview.snapshot({ sessions: [s], now }).sessions[0];
  return { widget: classification.presented, waiting: classification.waiting, sessions: row.status, help: Providers.snapshot({ sessions: [s], now }).headline };
}
for (const name of ['request_user_input', 'functions.request_user_input', 'request_user_input_async', 'functions.request_user_input_async']) test(`received exact ${name} PreToolUse presents input consistently without reading contents`, () => {
  const e = event('PreToolUse', { tool_name: name, tool_use_id: 'call-1', tool_input: { questions: SECRET }, tool_response: { accepted: true, answer: SECRET }, transcript_path: SECRET });
  assert.equal(JSON.stringify(e).includes(SECRET), false);
  const s = State.reduceCodexLifecycle(start(), e, iso(1));
  assert.equal(s.signal, 'tool-use', 'raw activity remains working');
  assert.deepEqual(shows(s), { widget: 'permission-ask', waiting: true, sessions: 'Waiting on you', help: 'Codex: needs input' });
  const publicDTO = JSON.stringify(Overview.snapshot({ sessions: [s], now: NOW + 10 }));
  assert.doesNotMatch(publicDTO, /call-1|turn-1|session-1|codexInputRequests/);
});
test('async accepted delivery and unrelated AI work retain original request age without claiming an answer', () => {
  let s = ask();
  const request = s.codexInputRequests[0];
  s = reduce(s, 'PostToolUse', { tool_name: 'request_user_input_async', tool_use_id: 'call-1', tool_response: { accepted: true, answer: SECRET } }, 1000);
  s = reduce(s, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'other-call', tool_input: { command: SECRET } }, 60000);
  assert.deepEqual(s.codexInputRequests, [request]); assert.equal(s.signal, 'tool-use'); assert.equal(s.codexHookAt, iso(60000));
  assert.equal(shows(s, NOW + 89999).sessions, 'Waiting on you');
  assert.deepEqual(shows(s, NOW + 90002), { widget: 'tool-use', waiting: false, sessions: 'Working', help: 'Codex: working' });
  assert.equal(JSON.stringify(s).includes(SECRET), false);
});
test('duplicate Pre cannot refresh original askedAt, and stale matching requests cannot reappear', () => {
  let s = ask(); s = ask(s, 'async', 'call-1', 85000);
  assert.equal(s.codexInputRequests[0].askedAt, iso(1));
  assert.equal(Machine.codexInputPending(s, NOW + 90001), true);
  assert.equal(Machine.codexInputPending(s, NOW + 90002), false);
});
test('synchronous Post clears only matching synchronous call, retaining parallel async ask', () => {
  let s = ask(start(), 'sync', 'sync-1'); s = ask(s, 'async', 'async-1', 2);
  s = reduce(s, 'PostToolUse', { tool_name: 'request_user_input', tool_use_id: 'wrong-id' }, 3);
  assert.equal(s.codexInputRequests.length, 2);
  s = reduce(s, 'PostToolUse', { tool_name: 'request_user_input_async', tool_use_id: 'sync-1' }, 4);
  assert.equal(s.codexInputRequests.length, 2);
  s = reduce(s, 'PostToolUse', { tool_name: 'functions.request_user_input', tool_use_id: 'sync-1', tool_response: SECRET }, 5);
  assert.deepEqual(s.codexInputRequests.map(r => r.id), ['async-1']);
  assert.equal(shows(s).widget, 'permission-ask');
  s = reduce(start(), 'PostToolUse', { tool_name: 'request_user_input', tool_use_id: 'missing-pre' });
  assert.equal(Machine.codexInputPending(s, NOW + 10), false);
});
for (const name of ['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionStart']) test(`actual parent ${name} clears reported pending state without calling it a verified answer`, () => {
  const s = reduce(ask(), name, {}, 100);
  assert.deepEqual(s.codexInputRequests, []); assert.equal(Machine.codexInputPending(s, NOW + 110), false);
});
test('SessionEnd removes session while compact and child tool/prompt/stop cannot clear parent ask', () => {
  const s = ask(); assert.equal(reduce(s, 'SessionEnd'), null);
  assert.equal(reduce(s, 'SessionStart', { source: 'compact' }, 100).codexInputRequests.length, 1);
  let next = s;
  for (const name of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SubagentStop']) {
    next = reduce(next, name, { agent_id: 'child-1', turn_id: 'child-turn', tool_name: 'request_user_input', tool_use_id: 'call-1' }, 100);
    assert.deepEqual(next.codexInputRequests, s.codexInputRequests); assert.equal(shows(next, NOW + 110).widget, 'permission-ask');
  }
});
test('absent, closed, noncurrent and retired turn asks cannot manufacture pending requests', () => {
  const fields = { tool_name: 'request_user_input_async', tool_use_id: 'call-1' };
  assert.equal(reduce(undefined, 'PreToolUse', fields), undefined);
  assert.equal(reduce(reduce(start(), 'Stop'), 'PreToolUse', fields), undefined);
  assert.equal(reduce(start(), 'PreToolUse', { ...fields, turn_id: 'wrong-turn' }), undefined);
  const next = reduce(start(), 'UserPromptSubmit', { turn_id: 'turn-2' });
  assert.equal(reduce(next, 'PreToolUse', fields), undefined);
});
test('suffix lookalikes, MCP tools and unbounded or missing call identity remain ordinary tools', () => {
  for (const fields of [
    ...['mcp__host__request_user_input', 'mcp__host__request_user_input_async', 'other.request_user_input', 'functions.request_user_input_async_extra', 'requestUserInput', 'REQUEST_USER_INPUT', SECRET].map(tool_name => ({ tool_name, tool_use_id: 'call-1' })),
    ...[undefined, null, '', [], '../secret', 'a'.repeat(121), 'call\nsecret'].map(tool_use_id => ({ tool_name: 'request_user_input_async', tool_use_id })),
  ]) {
    const s = reduce(start(), 'PreToolUse', fields);
    assert.deepEqual(s.codexInputRequests, []); assert.equal(shows(s).widget, 'tool-use');
    assert.equal(JSON.stringify(s).includes(SECRET), false);
  }
});
test('future/unknown/malformed pending metadata never presents waiting or leaks through DTO', () => {
  const s = ask();
  for (const change of [r => r.askedAt = iso(10000), r => r.askedAt = 'invalid', r => r.kind = '__proto__', r => r.id = [], r => r.turnId = 'foreign', r => r.prompt = SECRET]) {
    const bad = structuredClone(s); change(bad.codexInputRequests[0]);
    assert.equal(Machine.codexInputPending(bad, NOW + 10), false); assert.equal(shows(bad).sessions, 'Working');
    assert.equal(JSON.stringify(Overview.snapshot({ sessions: [bad], now: NOW + 10 })).includes(SECRET), false);
  }
  for (const change of [x => x.source = 'claude', x => x.codexLifecycle = 0, x => x.codexClosedTurn = true, x => x.codexInputRequests = Array(17).fill(s.codexInputRequests[0])]) {
    const bad = structuredClone(s); change(bad); assert.equal(Machine.codexInputPending(bad, NOW + 10), false);
  }
});
test('bounded concurrent calls do not evict earlier asks or refresh their clocks', () => {
  let s = start();
  for (let i = 0; i < 20; i++) s = ask(s, 'async', `call-${i}`, i + 1);
  assert.equal(s.codexInputRequests.length, 16); assert.equal(s.codexInputRequests[0].id, 'call-0');
  assert.equal(s.codexInputRequests[0].askedAt, iso(1));
  s = reduce(s, 'UserPromptSubmit', { turn_id: 'turn-2' }, 40);
  assert.deepEqual(s.codexInputRequests, []);
});
test('actual emitter receives synthetic async metadata and never stores questions/answers/transcript paths', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-input-emitter-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const emit = (name, fields = {}) => {
    const r = spawnSync(process.execPath, [path.resolve(__dirname, '../hooks/emit.js'), '--adapter', 'codex', '--lifecycle', name], { input: JSON.stringify(payload(name, fields)), encoding: 'utf8', timeout: 4000, env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home } });
    assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stderr); return r;
  };
  emit('UserPromptSubmit');
  emit('PreToolUse', { tool_name: 'functions.request_user_input_async', tool_use_id: 'call-real-shaped', tool_input: { questions: SECRET }, transcript_path: SECRET });
  emit('PostToolUse', { tool_name: 'functions.request_user_input_async', tool_use_id: 'call-real-shaped', tool_response: { accepted: true, answer: SECRET } });
  const file = State.sessionFileFor(path.join(home, 'sessions'), os.hostname().split('.')[0], 'codex', 'session-1');
  const text = fs.readFileSync(file, 'utf8'), s = JSON.parse(text);
  assert.equal(text.includes(SECRET), false); assert.equal(s.codexInputRequests.length, 1);
  assert.equal(s.signal, 'tool-done'); assert.equal(Machine.presentSignal(s), 'permission-ask');
  assert.equal(Overview.snapshot({ sessions: [s] }).sessions[0].status, 'Waiting on you');
  assert.equal(emit('Stop').stdout, '{}'); assert.deepEqual(JSON.parse(fs.readFileSync(file)).codexInputRequests, []);
});
test('actual bound child input presents waiting without changing parent work, then expires and stops', () => {
  let s = ask(start(), 'async', 'child-call', 1, { agent_id: 'child-1', turn_id: 'child-turn' });
  assert.equal(shows(s).widget, 'permission-ask'); assert.equal(s.signal, 'subagent-start');
  assert.equal(Overview.snapshot({ sessions: [s], now: NOW + 10 }).sessions[0].children[0].status, 'Waiting on you');
  s = reduce(s, 'PostToolUse', { agent_id: 'child-1', turn_id: 'child-turn', tool_name: 'request_user_input_async', tool_use_id: 'child-call', tool_response: { accepted: true } }, 60000);
  assert.equal(shows(s, NOW + 89999).sessions, 'Waiting on you');
  assert.equal(shows(s, NOW + 90002).sessions, 'Working');
  const closed = reduce(s, 'Stop', {}, 60001);
  assert.equal(closed.codexAgents[0].codexInputRequests.length, 0); assert.equal(Machine.codexInputPending(closed, NOW + 60002), false);
  s = reduce(s, 'SubagentStop', { agent_id: 'child-1', turn_id: 'child-turn' }, 60001);
  assert.equal(Machine.codexInputPending(s, NOW + 60002), false);
});
