'use strict';
// Real engine, local socket, Codex adapter and main-side service. No mock server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTasksService } = require('../src/tasks-service.js');

const packetData = () => ({ brief: 'Resume the handler', decisions: ['Use its existing API'], progress: 'Ready for another person', nextAction: 'Run the route test', artifacts: [{ kind: 'path', path: 'README.md' }], reportedChecks: ['Checks pending'] });
let setup, waitFor;
test.before(async () => {
  ({ startCodexFixture: setup } = await import('../board/tasks-engine/test/codex-helpers.js'));
  ({ waitFor } = await import('../board/tasks-engine/test/helpers.js'));
});

test('desktop checkpoint editor uses its open task, exact version and real engine; live updates refresh details', async () => {
  const h = await setup({ error: 'Fixture failure' }); let svc;
  try {
    const { id } = await h.client.createTask({ text: 'Service packet', cwd: h.repo.checkout, ai: 'codex' });
    await waitFor(() => h.task(id)?.state === 'failed');
    const events = [];
    svc = createTasksService({ boardHome: h.dataDir, onEvent: (wc, taskId, e) => events.push([wc, taskId, e]) }); svc.start();
    await waitFor(() => svc.snapshot().conn.status === 'connected');
    const opened = await svc.openTask(id, 7); assert.equal(opened.ok, true);
    const req = { id, expectedVersion: opened.detail.checkpoint.version, data: packetData() };
    assert.equal((await svc.saveCheckpoint(req, 8)).code, 'NOT_FOUND');
    assert.equal((await svc.saveCheckpoint({ ...req, author: 'owner' }, 7)).code, 'VALIDATION');
    const r = await svc.saveCheckpoint(req, 7); assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.checkpoint.version, req.expectedVersion + 1); assert.deepEqual(r.checkpoint.author, { kind: 'human', source: 'local' });
    assert.equal(h.task(id).checkpoint.author.id, 'local-owner');
    assert.equal((await svc.saveCheckpoint(req, 7)).code, 'CONFLICT');
    const latest = (await h.client.saveCheckpoint(id, r.checkpoint.version, { ...packetData(), nextAction: 'NEW-PARTICIPANT-NEXT' })).checkpoint;
    await waitFor(() => events.some(([wc, taskId, e]) => wc === 7 && taskId === id && e.type === 'detail' && e.detail.checkpoint.version === latest.version));
    const detail = events.filter(([, , e]) => e.type === 'detail').at(-1)[2].detail;
    assert.equal(detail.checkpoint.nextAction, 'NEW-PARTICIPANT-NEXT'); assert.equal(detail.checkpoint.observed.state, 'failed');
    await svc.closeTask(7); assert.equal((await svc.saveCheckpoint({ ...req, expectedVersion: latest.version }, 7)).code, 'NOT_FOUND');
  } finally { svc?.stop(); await h.cleanup(); }
});

test('closing a page while its authorized save is pending cannot deliver its packet into a new page slot', async () => {
  const h = await setup({ error: 'Fixture failure' }); let svc, release;
  try {
    const { id } = await h.client.createTask({ text: 'Pending service packet', cwd: h.repo.checkout, ai: 'codex' });
    await waitFor(() => h.task(id)?.state === 'failed');
    const gate = new Promise((r) => { release = r; }); let saved = false;
    const [client, P, face] = await Promise.all([import('../board/tasks-api/client.js'), import('../board/tasks-api/protocol.js'), import('../board/tasks-api/face.js')]);
    svc = createTasksService({ boardHome: h.dataDir, loadApi: async () => ({ P, taskFace: face.taskFace, client: { connect: async (opts) => {
      const c = await client.connect(opts), save = c.saveCheckpoint.bind(c);
      c.saveCheckpoint = async (...args) => { const result = await save(...args); saved = true; await gate; return result; };
      return c;
    } } }) }); svc.start();
    await waitFor(() => svc.snapshot().conn.status === 'connected');
    const opened = await svc.openTask(id, 9);
    const pending = svc.saveCheckpoint({ id, expectedVersion: opened.detail.checkpoint.version, data: packetData() }, 9);
    await waitFor(() => saved); await svc.closeTask(9); release();
    assert.equal((await pending).code, 'NOT_FOUND');
    assert.equal(h.task(id).checkpoint.nextAction, 'Run the route test', 'the write was authorized when issued; only its stale page response is refused');
  } finally { release?.(); svc?.stop(); await h.cleanup(); }
});
