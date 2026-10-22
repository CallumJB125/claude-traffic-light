// Agent bus shapes (board/shared/bus-schema.js): the v1 envelope never grants
// execution or approval, kinds belong to their topic, and op arguments are
// bounded and closed (no hop, visited or identity from a caller).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Envelope, HandoffArgs, RunHandoffArgs, ResultArgs, ReadArgs, WaitArgs, KINDS, TOPICS, LIMITS, issue } from '../bus-schema.js';

const env = (extra = {}) => ({ v: 1, id: 'evt_0123456789abcdef', request_id: null, topic: 'handoff', offset: 1, scope: 'local', card_id: null, repo: { root: '/r' },
  source: { device_id: 'd', agent_id: 'claude:local:x', provider: 'claude', tier: 'local_attested', identity_source: 'local_token' }, to: { provider: 'codex' },
  kind: 'handoff.offer', handoff_id: 'hof_0123456789ab', body: 'b', data: { title: 't' }, hop: 1, visited: ['claude:local:x'], caused_by: null,
  created_at: 1, expires_at: 2, grants_execution: false, approval: false, ...extra });

test('envelope v1: grants_execution and approval are always false; kinds belong to their topic', () => {
  assert.equal(Envelope.safeParse(env()).success, true);
  assert.equal(Envelope.safeParse(env({ grants_execution: true })).success, false);
  assert.equal(Envelope.safeParse(env({ approval: true })).success, false);
  assert.equal(Envelope.safeParse(env({ kind: 'result.done' })).success, false);
  assert.equal(Envelope.safeParse(env({ body: 'x'.repeat(LIMITS.brief + 1) })).success, false);
  assert.equal(Envelope.safeParse(env({ extra: 1 })).success, false);
  assert.deepEqual(Object.keys(KINDS), [...TOPICS]);
});

test('handoff args: closed, bounded, card_id required for team, a target needed', () => {
  const ok = { request_id: 'req-00000001', to: { provider: 'codex' }, title: 'Fix it' };
  assert.equal(HandoffArgs.safeParse(ok).success, true);
  assert.match(issue(HandoffArgs.safeParse({ ...ok, scope: 'team' })), /card_id/);
  assert.equal(HandoffArgs.safeParse({ ...ok, scope: 'team', card_id: 'c-1' }).success, true);
  assert.equal(HandoffArgs.safeParse({ ...ok, to: {} }).success, false);
  assert.equal(HandoffArgs.safeParse({ ...ok, brief: 'x'.repeat(3201) }).success, false);
  assert.equal(HandoffArgs.safeParse({ ...ok, hop: 0 }).success, false);
  assert.equal(RunHandoffArgs.safeParse({ ...ok, repo: '/elsewhere' }).success, false, 'a run hands off in its own repo only');
  assert.equal(RunHandoffArgs.safeParse({ ...ok, visited: [] }).success, false);
  assert.equal(ResultArgs.safeParse({ request_id: 'req-00000001', outcome: 'done', summary: 'x'.repeat(2001) }).success, false);
  assert.equal(ReadArgs.safeParse({ topic: 'claim' }).success, false, 'agents read handoffs and results only');
  assert.equal(WaitArgs.safeParse({ handoff_id: 'hof_0123456789ab', timeout_s: 121 }).success, false);
});
