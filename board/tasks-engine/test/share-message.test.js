// T4c (plan-t4c Rev 1, C-M1, C-M2, S1, S3): a teammate's message into a shared chat. Only the full principal
// (Plexiform's own app) relays one; it is accepted only when the engine can deliver it at once, under the task lock,
// and otherwise refused with nothing recorded, so it can never ride the next PostToolUse or the owner's next prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine, makeRepo, waitFor, rm, tmpDir } from './helpers.js';
import { addRelayToken } from '../relay-tokens.js';
import { connect } from '../../tasks-api/client.js';

const LONG = { steps: [{ tool: 'Read', input: { file_path: 'README.md' }, ms: 60000 }] };
const DONE = { steps: [{ assistant: 'Looked.' }, { result: 'success', text: 'Done.' }] };

async function setup(scenario) {
  const dir = tmpDir('pxshare-');
  const repo = makeRepo(dir);
  const m = await startEngine({ dir, scenario, engineOpts: { maxParallel: 4 } });
  const clients = [];
  return {
    ...m, repo,
    async relay(opts) { const token = addRelayToken({ dataDir: m.dataDir, ...opts }); const c = await connect({ socketPath: m.eng.socketPath, token }); clients.push(c); return c; },
    async done() { for (const c of clients) c.close(); await m.close(); rm(dir); },
  };
}
const share = (task, over = {}) => ({ key: 'shr-1', by: { memberId: 'u-alex', name: 'Alex' }, expect: { permissionLevel: task.permissionLevel, ai: task.ai.id }, ...over });
const sendAs = (m, id, body, sh, requestId) => m.client.act(id, 'message', { body, share: sh }, requestId ? { requestId } : {});
const bodies = async (m, id) => (await m.client.listMessages(id)).map((x) => x.body);
const code = (c) => (e) => e.code === c;

async function runningTask(m) {
  const { id } = await m.client.createTask({ text: 'Shared chat', cwd: m.repo.checkout });
  await waitFor(() => m.eng.tasks.get(id)?.state === 'running' && m.eng.engine.runs.get(id)?.backend, { label: 'running' });
  return { id, task: m.eng.tasks.get(id), run: m.eng.engine.runs.get(id) };
}

test('a finished chat takes a teammate message: labelled with their name, the prompt never names them', async () => {
  const m = await setup(DONE);
  try {
    const { id } = await m.client.createTask({ text: 'Shared chat', cwd: m.repo.checkout });
    await waitFor(() => m.eng.tasks.get(id)?.state === 'in_review', { label: 'in_review' });
    const task = m.eng.tasks.get(id);
    const r = await sendAs(m, id, 'TEAMMATE-ASK', share(task));
    assert.ok(r.messageId);
    const msg = (await m.client.listMessages(id)).find((x) => x.body === 'TEAMMATE-ASK');
    assert.deepEqual(msg.from, { kind: 'member', id: 'u-alex', label: 'Alex (teammate)' });
    assert.notEqual(m.eng.tasks.get(id).state, 'in_review', 'the message reopens the finished chat');
    assert.ok(!JSON.stringify(m.eng.tasks.get(id).audit).includes('share:'), 'the audit names the source, not the share key');
  } finally { await m.done(); }
});

test('mid-turn: SESSION_BUSY, nothing recorded or pending (never an invisible steer)', async () => {
  const m = await setup(LONG);
  try {
    const { id, task, run } = await runningTask(m);
    assert.equal(run.backend.turnActive, true);
    const before = await bodies(m, id);
    await assert.rejects(sendAs(m, id, 'MID-TURN', share(task)), code('SESSION_BUSY'));
    assert.deepEqual(await bodies(m, id), before);
    assert.ok(!JSON.stringify(m.eng.tasks.get(id)).includes('MID-TURN'), 'no pending entry anywhere on the task');
  } finally { await m.done(); }
});

test('between turns on a live Claude run: delivered at once on stdin, the text names nobody', async () => {
  const m = await setup(LONG);
  try {
    const { id, task, run } = await runningTask(m);
    run.backend.turnActive = false;
    const sent = [];
    const real = run.backend.send.bind(run.backend);
    run.backend.send = (text) => { sent.push(text); return real(text); };
    await sendAs(m, id, 'IDLE-ASK', share(task));
    assert.equal(sent.length, 1);
    assert.ok(sent[0].includes('IDLE-ASK') && !sent[0].includes('Alex'));
  } finally { await m.done(); }
});

test('Codex exec (no live send): BUSY even when turnActive is false, nothing pending', async () => {
  const m = await setup(LONG);
  try {
    const { id, task, run } = await runningTask(m);
    run.backend.turnActive = false;
    Object.defineProperty(run.backend, 'liveSend', { value: false, configurable: true });
    const before = await bodies(m, id);
    await assert.rejects(sendAs(m, id, 'CODEX-ASK', share(task)), code('SESSION_BUSY'));
    assert.deepEqual(await bodies(m, id), before);
    assert.ok(!JSON.stringify(m.eng.tasks.get(id)).includes('CODEX-ASK'));
  } finally { await m.done(); }
});

test('race: idle when the caller looked, a turn started before the engine took the lock → BUSY, nothing recorded', async () => {
  const m = await setup(LONG);
  try {
    const { id, task, run } = await runningTask(m);
    run.backend.turnActive = false;
    const before = await bodies(m, id);
    const p = sendAs(m, id, 'RACED', share(task));
    run.backend.turnActive = true; // the owner's turn began after the host's own idle check
    await assert.rejects(p, code('SESSION_BUSY'));
    assert.deepEqual(await bodies(m, id), before);
  } finally { await m.done(); }
});

test('work in place is refused; a changed permission level or AI is a conflict', async () => {
  const m = await setup(DONE);
  try {
    const { id } = await m.client.createTask({ text: 'Shared chat', cwd: m.repo.checkout });
    await waitFor(() => m.eng.tasks.get(id)?.state === 'in_review', { label: 'in_review' });
    const task = m.eng.tasks.get(id);
    await assert.rejects(sendAs(m, id, 'X', share(task, { expect: { permissionLevel: 'plan', ai: task.ai.id } })), code('CONFLICT'));
    await assert.rejects(sendAs(m, id, 'X', share(task, { expect: { permissionLevel: task.permissionLevel, ai: 'codex' } })), code('CONFLICT'));
    task.workInPlace = true;
    await assert.rejects(sendAs(m, id, 'X', share(task)), code('POLICY_DENIED'));
    assert.ok(!(await bodies(m, id)).includes('X'));
  } finally { await m.done(); }
});

test('only the full principal relays a share message; no relay can read or act as a share', async () => {
  const m = await setup(DONE);
  try {
    const { id } = await m.client.createTask({ text: 'Shared chat', cwd: m.repo.checkout });
    await waitFor(() => m.eng.tasks.get(id)?.state === 'in_review', { label: 'in_review' });
    const task = m.eng.tasks.get(id);
    const phone = await m.relay({ source: 'phone', userId: 'alice', taskIds: [id] });
    await assert.rejects(phone.act(id, 'message', { body: 'Y', share: share(task) }), code('POLICY_DENIED'));
    assert.throws(() => addRelayToken({ dataDir: m.dataDir, source: 'share', userId: 'alice', taskIds: [id] }), /relay source/);
    assert.equal(m.eng.engine.canAccess(id, { kind: 'relay', source: 'share', userId: 'alice', taskIds: [id] }), false, 'a share principal reads nothing');
    await assert.rejects(m.client.act(id, 'message', { body: 'Z', share: { ...share(task), extra: 1 } }), code('VALIDATION'));
  } finally { await m.done(); }
});
