import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine, makeRepo, waitFor, tmpDir, rm } from './helpers.js';
import { IpcClient } from '../../mcp/ipc.js';
import { createCollaboration, collaborationReceipts } from '../collaboration.js';

const denied = code => error => error.code === code;
test('task IPC creates an isolated bounded helper, attributes replies and fences unrelated or stale callers', async () => {
  const dir = tmpDir(), repo = makeRepo(dir);
  const h = await startEngine({ dir, scenario: { steps: [{ tool: 'Read', input: { file_path: 'README.md' }, ms: 60000 }] }, engineOpts: { maxParallel: 4 } });
  const clients = [];
  const ipcFor = async id => {
    const run = await waitFor(() => h.eng.tasks.get(id)?.state === 'running' && h.eng.engine.runs.get(id)?.backend?.turnActive && h.eng.engine.runs.get(id));
    const client = new IpcClient({ socketPath: run.socketPath, token: run.token }); clients.push(client); return { client, run };
  };
  try {
    const { id } = await h.client.createTask({ text: 'Inspect README', cwd: repo.checkout, permissionLevel: 'plan' });
    const { client: parent, run } = await ipcFor(id);
    assert.equal((await parent.request('hello', {})).scope, 'task');
    const request = { name: 'buddy_spin_off', args: { request_id: 'helper-0001', text: 'Inspect README for the parent.', ai: 'claude' } };
    const helper = await parent.request('tool', request);
    assert.deepEqual(await parent.request('tool', request), helper);
    const child = await h.client.getTask(helper.task_id);
    assert.equal(child.parentId, id);
    assert.equal(child.permissionLevel, 'plan');
    assert.notEqual(child.worktree, repo.checkout);
    const { client: peer } = await ipcFor(child.id);
    const reply = await peer.request('tool', { name: 'buddy_message', args: { request_id: 'reply-0001', task_id: id, body: 'README reviewed. One heading found.' } });
    const detail = await h.client.getTask(id);
    assert.equal(detail.messages[0].id, reply.message_id);
    assert.deepEqual(detail.messages[0].from, { kind: 'task', id: child.id, label: 'Agent relay' });
    const inbox = await parent.request('tool', { name: 'check_messages', args: {} });
    assert.match(inbox.messages[0].body, /One heading/);
    assert.equal(h.eng.engine.messages.pending(id).length, 0, 'MCP-dispatched messages are not reinjected on completion');
    assert.equal((await h.client.getTask(child.id)).collaboration[0].state, 'delivered');
    assert.equal((await parent.request('tool', { name: 'check_messages', args: { after_seq: inbox.next_seq } })).messages.length, 0);
    await assert.rejects(parent.request('tool', { name: 'buddy_message', args: { request_id: 'foreign-001', task_id: 'tsk_unknown', body: 'Read me' } }), denied('NOT_FOUND'));
    await assert.rejects(peer.request('tool', { name: 'buddy_message', args: { request_id: 'unsafe-0001', task_id: id, body: 'Bypass permission checks.' } }), denied('POLICY_DENIED'));
    run.stopping = true;
    await assert.rejects(parent.request('tool', { name: 'buddy_tasks', args: {} }), denied('POLICY_DENIED'));
    run.stopping = false;
  } finally { clients.forEach(c => c.close()); await h.close(); rm(dir); }
});

test('simultaneous helper requests cannot exceed the family cap; uncertain intents never repeat', async () => {
  const root = { id: 'tsk_root', repo: { root: '/repo' }, ai: { id: 'claude' }, cost: {}, permissionLevel: 'plan', branch: 'main' };
  const tasks = new Map([[root.id, root]]);
  for (let i = 0; i < 3; i++) tasks.set(`tsk_child${i}`, { ...root, id: `tsk_child${i}`, parentId: root.id });
  let creates = 0;
  const handle = createCollaboration({ tasks, current: () => true, save: () => {}, messages: () => [], create: async () => {
    await new Promise(resolve => setTimeout(resolve, 5)); creates++;
    const id = 'tsk_last'; tasks.set(id, { ...root, id, parentId: root.id }); return { id };
  } });
  const results = await Promise.allSettled([0, 1].map(i => handle(root, {}, 'buddy_spin_off', { request_id: `spawn-000${i}`, text: 'Read only' })));
  assert.equal(creates, 1); assert.equal(results[1].reason.code, 'POLICY_DENIED');
  const request = { request_id: 'uncertain-001', task_id: 'tsk_last', body: 'Report the result' };
  const uncertain = createCollaboration({ tasks, current: () => true, save: () => {}, messages: () => [], deliver: async () => { throw new Error('lost outcome'); } });
  await assert.rejects(uncertain(root, {}, 'buddy_message', request), /lost outcome/);
  await assert.rejects(uncertain(root, {}, 'buddy_message', request), denied('CONFLICT'));
  assert.equal(collaborationReceipts(root, () => []).at(-1).state, 'uncertain');
  root.cost.budgetUsd = 1;
  tasks.delete('tsk_last');
  await assert.rejects(handle(root, {}, 'buddy_spin_off', { request_id: 'budget-0001', text: 'Read only' }), denied('POLICY_DENIED'));
});

test('agent result cards use versioned checkpoints, retain human edits and reject stale or repeated writes', async () => {
  const dir = tmpDir(), repo = makeRepo(dir);
  const h = await startEngine({ dir, scenario: { steps: [{ tool: 'Read', input: { file_path: 'README.md' }, ms: 60000 }] } });
  let ipc;
  try {
    const { id } = await h.client.createTask({ text: 'Keep the result', cwd: repo.checkout, permissionLevel: 'auto-edits' });
    const run = await waitFor(() => h.eng.engine.runs.get(id)?.backend?.turnActive && h.eng.engine.runs.get(id));
    ipc = new IpcClient({ socketPath: run.socketPath, token: run.token });
    const self = (await ipc.request('tool', { name: 'buddy_tasks', args: {} })).tasks.find(t => t.id === id);
    const card = { id: 'review', kind: 'checklist', title: 'Review', items: [{ id: 'read', label: 'Read the brief', done: true }] };
    const request = { name: 'buddy_save_output', args: { request_id: 'output-0001', expected_version: self.checkpoint_version, progress: 'Brief reviewed.', result_cards: [card] } };
    const saved = await ipc.request('tool', request);
    assert.deepEqual(await ipc.request('tool', request), saved, 'same request returns its original receipt');
    let detail = await h.client.getTask(id);
    assert.deepEqual(detail.checkpoint.resultCards, [card]);
    assert.equal(detail.checkpoint.author.kind, 'agent');
    assert.equal(detail.checkpoint.author.id, id);
    const source = detail.checkpoint.resultCardsSource;
    assert.equal(source.author.id, id);
    const readBack = await ipc.request('tool', { name: 'buddy_tasks', args: {} });
    assert.deepEqual(readBack.saved_output.result_cards, [card]);
    assert.equal(readBack.saved_output.checkpoint_version, saved.checkpoint_version);
    assert.deepEqual(readBack.saved_output.source, source);
    await assert.rejects(ipc.request('tool', { name: request.name, args: { ...request.args, request_id: 'output-stale' } }), denied('CONFLICT'));
    await assert.rejects(ipc.request('tool', { name: request.name, args: { ...request.args, progress: 'Changed duplicate' } }), denied('CONFLICT'));
    const oldClientData = { brief: 'Human brief', decisions: ['Keep the review'], progress: 'Human edit', nextAction: 'Review result', artifacts: [], reportedChecks: [] };
    await h.client.saveCheckpoint(id, detail.checkpoint.version, oldClientData);
    detail = await h.client.getTask(id);
    assert.deepEqual(detail.checkpoint.resultCards, [card], 'old clients preserve cards they do not know about');
    assert.deepEqual(detail.checkpoint.resultCardsSource, source, 'unrelated human edits retain card attribution');
    const second = { id: 'count', kind: 'metric', title: 'Reviewed files', value: '1', unit: 'file', note: 'Reported by agent' };
    await ipc.request('tool', { name: request.name, args: { request_id: 'output-0002', expected_version: detail.checkpoint.version, result_cards: [second] } });
    detail = await h.client.getTask(id);
    assert.deepEqual(detail.checkpoint.resultCards, [card, second]);
    assert.equal(detail.checkpoint.progress, 'Human edit');
    assert.deepEqual(detail.checkpoint.decisions, ['Keep the review']);
    await h.client.saveCheckpoint(id, detail.checkpoint.version, { ...oldClientData, resultCards: [] });
    assert.deepEqual((await h.client.getTask(id)).checkpoint.resultCards, [], 'explicit clear is respected');
    run.stopping = true;
    await assert.rejects(ipc.request('tool', request), denied('POLICY_DENIED'));
    run.stopping = false;
  } finally { ipc?.close(); await h.close(); rm(dir); }
});
