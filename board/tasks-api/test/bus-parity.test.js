// The `bus` method (AGENT-BUS.md) is in the protocol, the schema, the client and
// the mock, and the mock answers its ops in the same shapes as the engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { METHODS, BUS_OPS, BUS_AGENT_OPS, SOURCES, REMOTE_SOURCES } from '../protocol.js';
import { validate } from '../validate.js';
import { SCHEMA, startMock } from './helpers.js';

test('bus is a method, a source and a remote source; its ops are schema-checked', () => {
  assert.ok(METHODS.includes('bus'));
  assert.ok(SOURCES.includes('bus') && REMOTE_SOURCES.includes('bus'));
  assert.ok(BUS_AGENT_OPS.every((op) => BUS_OPS.includes(op)));
  assert.ok(!BUS_AGENT_OPS.includes('halt') && !BUS_AGENT_OPS.includes('resume') && !BUS_AGENT_OPS.includes('busSetContext'), 'control is never an agent op');
  assert.equal(validate(SCHEMA, 'BusParams', { op: 'handoff', args: {} }), null);
  assert.ok(validate(SCHEMA, 'BusParams', { op: 'approve' }));
  assert.equal(validate(SCHEMA, 'TaskSpec', { text: 'x', cwd: '/r', source: 'bus', wallClockMs: 60000, sourceMeta: { handoffId: 'hof_1', fence: 1, originTier: 'local_attested', scope: 'local' } }), null);
  assert.ok(validate(SCHEMA, 'TaskSpec', { text: 'x', cwd: '/r', wallClockMs: 1000 }));
});

test('mock parity: hello, handoff, status, wait, halt and resume', async () => {
  const m = await startMock();
  try {
    assert.equal((await m.client.bus('hello', { provider: 'claude' })).tier, 'local_attested');
    const h = await m.client.bus('handoff', { request_id: 'req-00000001', to: { provider: 'codex' }, title: 'x' });
    assert.match(h.handoff_id, /^hof_/);
    assert.equal((await m.client.bus('status', { handoff_id: h.handoff_id })).state, 'offered');
    assert.equal((await m.client.bus('wait', { handoff_id: h.handoff_id, timeout_s: 0 })).state, 'pending');
    assert.equal((await m.client.bus('halt')).halted, true);
    assert.equal((await m.client.bus('handoff', { request_id: 'req-00000002', to: { provider: 'codex' }, title: 'y' })).reason, 'HALTED');
    assert.equal((await m.client.bus('resume')).halted, false);
    await assert.rejects(m.client.bus('nope'), (e) => e.code === 'VALIDATION');
  } finally { await m.close(); }
});
