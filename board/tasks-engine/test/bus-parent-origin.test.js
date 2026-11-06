// G5 in the app's real path: who asked (caller.origin, the session main bound) reaches the dispatcher only over the
// helper's parentPort, which only main holds. Through tasks.sock, which any same-user process holding tasks.token can
// reach, an origin is dropped, so no such process can aim a hand-off's result note at a session (PR B's note rule).
// unbound and a trace id pass either way: one only narrows, the other only joins log lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBus, rid } from './bus-helpers.js';

const ORIGIN = { key: 'claude|sess-origin-1', handle: 'claude-site-0a1b' };

test('a hand-off\'s origin is kept over parentPort and dropped over the socket; a refusal keeps its wording over parentPort', async () => {
  const b = await startBus({ wait: true });
  try {
    const log = b.engine.agentBus.log;
    const caller = { ...b.caller, origin: ORIGIN, trace: { trace_id: 'tr_0123456789abcdef', from_handle: ORIGIN.handle } };
    const viaMain = await b.viaParent('handoff', { request_id: rid('po'), to: { provider: 'codex' }, title: 'From main' }, caller);
    assert.equal(viaMain.state, 'offered', JSON.stringify(viaMain));
    assert.deepEqual(log.handoff(viaMain.handoff_id).data.origin, ORIGIN);
    const viaSocket = await b.socketBus('handoff', { request_id: rid('ps'), to: { provider: 'codex' }, title: 'Forged' }, caller);
    assert.equal(viaSocket.state, 'offered');
    assert.equal(log.handoff(viaSocket.handoff_id).data.origin, undefined, 'the socket never carries an origin');
    // The note ops still refuse a caller, and only a hand-off takes one over parentPort.
    await assert.rejects(b.viaParent('hello', {}, caller), (e) => e.code === 'VALIDATION');
    // A bad request over parentPort says what is wrong, as the socket does.
    await assert.rejects(b.viaParent('handoff', { request_id: 'x', title: 'Bad' }, caller), (e) => e.code === 'VALIDATION' && e.message !== 'VALIDATION' && e.message.length > 0);
  } finally { await b.cleanup(); }
});
