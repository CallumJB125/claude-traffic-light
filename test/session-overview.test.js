'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Overview = require('../src/session-overview');
const now = Date.parse('2026-10-02T06:00:00Z');
const at = age => new Date(now - age).toISOString();
const codex = extra => ({ source: 'codex', sessionId: 'local', cwd: '/private/work/project', signal: 'tool-use', codexLifecycle: 1, codexHookAt: at(1000), updatedAt: at(1000), ...extra });

test('projection carries only fixed metadata, never IDs, paths, tools, task titles or private payloads', () => {
  const secret = 'do-not-expose';
  const row = codex({ sessionId: secret, host: secret, tool: secret, taskTitle: secret, prompt: secret, provider: secret,
    codexAgents: [{ id: secret, name: secret, turnId: secret, status: 'working', prompt: secret }] });
  const result = Overview.snapshot({ sessions: [row], activity: { configured: true, private: secret }, now });
  assert.deepEqual(result.sessions, [{ provider: 'Codex', project: 'project', status: 'Working', freshness: 'recent', age_ms: 1000, lifecycle: true,
    children: [{ label: 'Codex subagent 1', status: 'Working' }] }]);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes('/private'), false);
  assert.deepEqual(result.activity, { configured: true, observed: true, latest_age_ms: 1000 });
});
test('remote flags, device metadata and remote IDs never enter local Sessions', () => {
  const result = Overview.snapshot({ sessions: [codex({ remote: true }), codex({ device: {} }), codex({ sessionId: 'remote:abc' }), codex({})], now });
  assert.equal(result.sessions.length, 1);
});
test('Codex lifecycle freshness uses accepted hook time, not a newly rewritten file or child start time', () => {
  const row = codex({ codexHookAt: at(100_000), updatedAt: at(0), agentsAt: at(0), codexAgents: [{ status: 'working', since: at(0) }] });
  const result = Overview.snapshot({ sessions: [row], now });
  assert.equal(result.sessions[0].freshness, 'stale');
  assert.equal(result.sessions[0].age_ms, 100_000);
  assert.equal(result.activity.latest_age_ms, 100_000);
});
test('missing, malformed or future stamps remain unknown, and cannot establish lifecycle observation', () => {
  for (const stamp of [null, 123, 'invalid', at(-1)]) {
    const result = Overview.snapshot({ sessions: [codex({ codexHookAt: stamp })], now });
    assert.equal(result.sessions[0].freshness, 'unknown');
    assert.equal(result.sessions[0].age_ms, null);
    assert.equal(result.activity.observed, false);
  }
});
test('configured hooks and legacy notify reports do not prove lifecycle delivery', () => {
  const result = Overview.snapshot({ sessions: [codex({ codexLifecycle: undefined })], activity: { configured: true }, now });
  assert.equal(result.activity.observed, false);
  assert.equal(result.sessions[0].lifecycle, false);
  assert.equal(result.sessions[0].freshness, 'recent');
});
test('closed turns cannot be labeled working by later child activity', () => {
  const result = Overview.snapshot({ sessions: [codex({ codexClosedTurn: true, signal: 'subagent-start', codexAgents: [{ status: 'working' }, { status: 'done' }] })], now });
  assert.equal(result.sessions[0].status, 'Turn stopped');
  assert.deepEqual(result.sessions[0].children.map(child => child.status), ['Working', 'Stopped']);
});
test('Windows and POSIX paths expose a bounded leaf without controls or bidi overrides', () => {
  const result = Overview.snapshot({ sessions: [codex({ cwd: 'C:\\private\\project\u202e\n\\' }), codex({ cwd: '/private/' + 'x'.repeat(200) }), codex({ cwd: '..' })], now });
  assert.equal(result.sessions[0].project, 'project');
  assert.equal(result.sessions[1].project.length, 100);
  assert.equal(result.sessions[2].project, 'Local project');
});
test('display caps are explicit, child states closed and source projection does not mutate inputs', () => {
  const row = codex({ codexAgents: [...Array.from({ length: 70 }, () => ({ status: 'working' })), { status: 'secret' }] });
  const input = Array.from({ length: 103 }, () => structuredClone(row)), before = JSON.stringify(input);
  const result = Overview.snapshot({ sessions: input, now });
  assert.equal(result.sessions.length, 100); assert.equal(result.omitted, 3); assert.equal(result.status, 'partial');
  assert.equal(result.sessions[0].children.length, 64); assert.equal(JSON.stringify(input), before);
});
test('malformed provider/signal values cannot be forwarded or prevent the rest of the projection', () => {
  const result = Overview.snapshot({ sessions: [null, [], codex({ source: { toString: null }, signal: { toString: null }, agents: [{ status: 'secret' }] })], now });
  assert.equal(result.sessions.length, 1); assert.equal(result.sessions[0].provider, 'Local AI'); assert.equal(result.sessions[0].status, 'Unknown');
});
test('unavailable local activity and unreadable hook configuration remain distinct', () => {
  const result = Overview.snapshot({ sessions: [], available: false, activity: { available: false }, now });
  assert.equal(result.status, 'unavailable'); assert.equal(result.activity.configured, null); assert.deepEqual(result.sessions, []);
});
test('malformed child statuses cannot make the current valid local session unavailable', () => {
  const result = Overview.snapshot({ sessions: [codex({ codexAgents: [{ status: { toString: null } }, { status: { toString: [] } }, { status: Object.create(null) }, { status: 'working' }] })], now });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.sessions[0].children, [{ label: 'Codex subagent 1', status: 'Working' }]);
});

test('Claude overview preserves working turn, compaction and honest child uncertainty', () => {
  const row = extra => ({ signal: 'tool-use', updatedAt: at(1000), ...extra });
  const result = Overview.snapshot({ sessions: [row({ signal: 'subagent-done' }), row({ signal: 'compact' }), row({ signal: 'stop', agents: [{ source: 'hook', status: 'working' }, { status: 'stopped' }] })], now });
  assert.deepEqual(result.sessions.map(r => r.status), ['Working', 'Compacting', 'Turn stopped']);
  assert.deepEqual(result.sessions[2].children.map(c => c.status), ['Status unknown', 'Stopped']);
  const offline = Overview.snapshot({ sessions: [row({})], available: false, now });
  assert.equal(offline.sessions[0].freshness, 'unknown');
});
