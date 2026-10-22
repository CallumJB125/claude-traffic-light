// A bus-started run's own bus_handoff (AGENT-BUS.md §2.4.8, review 2 fix 2):
// tier run_capability, hop = parent + 1, visited = parent + this run, neither
// settable by the caller; its child is refused at hop 3; A→B→A is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './helpers.js';
import { startBus, rid } from './bus-helpers.js';

test('a run hands on once at hop 2 (run_capability, inherited visited); its child is refused with LOOP; handing back is LOOP', async () => {
  const b = await startBus({ wait: true });
  try {
    const parent = await b.handoff({ request_id: rid('parent') });
    const a = await waitFor(() => b.taskOf(parent.handoff_id)?.state === 'running' && b.taskOf(parent.handoff_id), { label: 'run A running' });
    const ipcA = await b.ipc(a.id);
    // Hop and visited belong to the run, not the caller: extra fields are refused outright.
    await assert.rejects(ipcA.request('tool', { name: 'bus_handoff', args: { request_id: rid('spoof'), to: { provider: 'codex' }, title: 'x', hop: 0 } }), (e) => e.code === 'VALIDATION');
    await assert.rejects(ipcA.request('tool', { name: 'bus_handoff', args: { request_id: rid('spoof'), to: { provider: 'codex' }, title: 'x', visited: [] } }), (e) => e.code === 'VALIDATION');
    // A→B→A: straight back to the provider that handed this over.
    const back = await ipcA.request('tool', { name: 'bus_handoff', args: { request_id: rid('back'), to: { provider: 'claude' }, title: 'Back to you' } });
    assert.equal(back.reason, 'LOOP');
    const visitedBack = await ipcA.request('tool', { name: 'bus_handoff', args: { request_id: rid('back2'), to: { agent_id: b.engine.agentBus.log.handoff(parent.handoff_id).visited[0] }, title: 'Back to the session' } });
    assert.equal(visitedBack.reason, 'LOOP');

    const child = await ipcA.request('tool', { name: 'bus_handoff', args: { request_id: rid('child'), to: { provider: 'codex' }, title: 'Write the tests', brief: 'Cover the new grammar.' } });
    assert.equal(child.state, 'offered');
    assert.equal(child.hop, 2);
    const log = b.engine.agentBus.log;
    const pEv = log.handoff(parent.handoff_id), cEv = log.handoff(child.handoff_id);
    assert.equal(cEv.source.tier, 'run_capability');
    assert.equal(cEv.source.agent_id, `codex:run:${a.id.slice(4)}`);
    assert.equal(cEv.caused_by, parent.handoff_id);
    assert.deepEqual(cEv.visited, [...pEv.visited, cEv.source.agent_id]);

    const bTask = await waitFor(() => b.taskOf(child.handoff_id)?.state === 'running' && b.taskOf(child.handoff_id), { label: 'run B running' });
    const ipcB = await b.ipc(bTask.id);
    // Gemini has no OS sandbox: never a bus target.
    const gem = await ipcB.request('tool', { name: 'bus_handoff', args: { request_id: rid('gem'), to: { provider: 'gemini' }, title: 'One more' } });
    assert.equal(gem.reason, 'NO_ELIGIBLE_AGENT');
    const grandchild = await ipcB.request('tool', { name: 'bus_handoff', args: { request_id: rid('gc'), to: { provider: 'claude' }, title: 'One more' } });
    assert.equal(grandchild.reason, 'LOOP', 'hop 3 > max_hops 2');
    // Only bus runs have bus tools; a refused handoff starts nothing.
    assert.equal([...b.engine.tasks.values()].filter((t) => t.source === 'bus').length, 2);
  } finally { await b.cleanup(); }
});
