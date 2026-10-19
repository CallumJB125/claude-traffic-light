import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startEngine, makeRepo, waitFor, rm, tmpDir, writePolicy } from './helpers.js';
import { addRelayToken, revokeRelayToken } from '../relay-tokens.js';
import { connect } from '../../tasks-api/client.js';

const absent = (e) => e.code === 'NOT_FOUND';
async function setup() {
  const dir = tmpDir('pxscope-');
  const repo = makeRepo(dir), other = makeRepo(fs.mkdtempSync(path.join(dir, 'other-')));
  const m = await startEngine({ dir, scenario: { steps: [{ tool: 'Read', input: { file_path: 'README.md' }, ms: 60000 }] }, engineOpts: { maxParallel: 8 } });
  const clients = [];
  const relay = async (opts) => { const token = addRelayToken({ dataDir: m.dataDir, ...opts }); const client = await connect({ socketPath: m.eng.socketPath, token }); clients.push(client); return { client, token }; };
  return { ...m, repo, other, relay, async done() { for (const c of clients) c.close(); await m.close(); rm(dir); } };
}

test('MCP relay reads/actions/replay/claims/heartbeat stay on its active parent and children across repos and actors', async () => {
  const m = await setup();
  try {
    const parent = await m.client.createTask({ text: 'Parent A', cwd: m.repo.checkout });
    await waitFor(() => m.eng.tasks.get(parent.id)?.sessionStarted);
    const sameRepo = await m.client.createTask({ text: 'Private actor B', cwd: m.repo.checkout });
    const foreign = await m.client.createTask({ text: 'Unrelated repository secret', cwd: m.other.checkout });
    await waitFor(() => [parent.id, sameRepo.id, foreign.id].every((id) => m.eng.tasks.get(id)?.state === 'running'));
    const { client: relay } = await m.relay({ source: 'mcp', parentSessionId: m.eng.tasks.get(parent.id).sessionId });
    const child = await relay.createTask({ text: 'Child A', cwd: m.repo.checkout });
    const allowed = new Set([parent.id, child.id]);
    assert.deepEqual(new Set((await relay.listTasks()).map((t) => t.id)), allowed);
    for (const id of [sameRepo.id, foreign.id]) {
      await assert.rejects(relay.getTask(id), absent);
      await assert.rejects(relay.listMessages(id), absent);
      await assert.rejects(relay.act(id, 'stop'), absent);
      await assert.rejects(relay.subscribe(id, { fromSeq: 1 }), absent);
    }
    assert.equal((await relay.getTask(parent.id)).title, 'Parent A');
    assert.equal((await relay.getTask(child.id)).title, 'Child A');
    await relay.act(parent.id, 'message', { body: 'AGENT-RELAY-CONTENT' });
    const relayed = (await m.client.listMessages(parent.id)).find((msg) => msg.body === 'AGENT-RELAY-CONTENT');
    assert.deepEqual(relayed.from, { kind: 'task', id: parent.id, label: 'Agent relay' }, 'relay cannot impersonate the local user');
    await assert.rejects(relay.getClaims(m.other.checkout), absent);
    assert.ok((await relay.getClaims(m.repo.checkout)).claims.every((c) => allowed.has(c.taskId)));
    await assert.rejects(relay.setLimits({ maxParallel: 1 }), (e) => e.code === 'POLICY_DENIED');
    assert.ok((await relay.detectAIs()).every((a) => a.bin === null));
    const events = [], heartbeats = [];
    relay.on('hb', (h) => heartbeats.push(h));
    const subscription = await relay.subscribe('*', { fromSeq: 1 }, (e) => events.push(e));
    await m.client.act(sameRepo.id, 'message', { body: 'PRIVATE-B-CONTENT' });
    await m.client.act(parent.id, 'message', { body: 'PARENT-A-CONTENT' });
    await waitFor(() => events.some((e) => e.type === 'message' && e.body === 'PARENT-A-CONTENT'));
    await waitFor(() => heartbeats.length > 0);
    assert.ok(events.every((e) => allowed.has(e.taskId)));
    assert.ok(!JSON.stringify(events).includes('PRIVATE-B-CONTENT'));
    assert.ok(heartbeats.every((h) => h.tasks.every((t) => allowed.has(t.id))));
    assert.equal((await m.client.listTasks()).length, 4, 'full local client remains global');
    assert.equal((await m.client.getTask(foreign.id)).title, 'Unrelated repository secret');
    await subscription.unsubscribe();
    await m.client.act(parent.id, 'stop');
    await waitFor(() => relay.closed, { label: 'inactive parent closes relay' });
    assert.equal(m.eng.tasks.get(sameRepo.id).state === 'failed', false, 'foreign task was not stopped');
  } finally { await m.done(); }
});

test('source relays require verified owner and explicit scope; same owner tokens cannot read each other without grants', async () => {
  const m = await setup();
  try {
    assert.throws(() => addRelayToken({ dataDir: m.dataDir, source: 'phone' }), /verified owner/);
    assert.throws(() => addRelayToken({ dataDir: m.dataDir, source: 'phone', userId: 'alice', allowCreate: true }), /explicit task/);
    writePolicy(m.dataDir, { accept_from: ['alice', 'bob'], repos: { [m.repo.checkout]: { remote_tasks: true }, [m.other.checkout]: { remote_tasks: true } } });
    const A = await m.relay({ source: 'phone', userId: 'alice', allowCreate: true, repoRoots: [m.repo.checkout] });
    const B = await m.relay({ source: 'phone', userId: 'bob', allowCreate: true, repoRoots: [m.other.checkout] });
    const A2 = await m.relay({ source: 'phone', userId: 'alice', allowCreate: true, repoRoots: [m.repo.checkout] });
    const a = await A.client.createTask({ text: 'Alice task', cwd: m.repo.checkout, sourceMeta: { userId: 'bob' } });
    const b = await B.client.createTask({ text: 'Bob task', cwd: m.other.checkout });
    await waitFor(() => [a.id, b.id].every((id) => m.eng.tasks.get(id)?.state === 'running'));
    assert.equal((await m.client.getTask(a.id)).spec.sourceMeta.userId, 'alice');
    assert.deepEqual((await A.client.listTasks()).map((t) => t.id), [a.id]);
    assert.deepEqual((await B.client.listTasks()).map((t) => t.id), [b.id]);
    assert.deepEqual(await A2.client.listTasks(), []);
    await assert.rejects(A.client.getTask(b.id), absent);
    await assert.rejects(A2.client.getTask(a.id), absent);
    A2.client.token = B.token;
    await assert.rejects(A2.client.getTask(b.id), (e) => e.code === 'UNAUTHENTICATED', 'connection cannot swap principal under existing subscriptions');
    await assert.rejects(A.client.act(b.id, 'stop'), absent);
    await assert.rejects(A.client.createTask({ text: 'Forbidden repo', cwd: m.other.checkout }), (e) => e.code === 'POLICY_DENIED');
    const grant = await m.relay({ source: 'board', userId: 'reviewer', taskIds: [a.id] });
    assert.equal((await grant.client.getTask(a.id)).id, a.id);
    await assert.rejects(grant.client.getTask(b.id), absent);
    await assert.rejects(grant.client.createTask({ text: 'No creation grant', cwd: m.repo.checkout }), (e) => e.code === 'POLICY_DENIED');
    const events = [], hbs = [];
    grant.client.on('hb', (h) => hbs.push(h));
    await grant.client.subscribe('*', { fromSeq: 1 }, (e) => events.push(e));
    await waitFor(() => hbs.length > 0);
    const before = events.length, hbBefore = hbs.length;
    revokeRelayToken({ dataDir: m.dataDir, token: grant.token });
    await m.client.act(a.id, 'message', { body: 'AFTER-REVOKE' });
    await waitFor(() => grant.client.closed, { label: 'revoked relay closes' });
    assert.equal(events.length, before);
    assert.equal(hbs.length, hbBefore);
    assert.ok(!JSON.stringify(events).includes('AFTER-REVOKE'));
    assert.equal((await B.client.getTask(b.id)).id, b.id, 'revocation affects only one grant');
  } finally { await m.done(); }
});

test('queued relay action rechecks revocation and cannot return a cached action for a different task', async () => {
  const m = await setup();
  try {
    const a = await m.client.createTask({ text: 'A', cwd: m.repo.checkout });
    const b = await m.client.createTask({ text: 'B', cwd: m.repo.checkout });
    await waitFor(() => m.eng.tasks.get(a.id)?.state === 'running' && m.eng.tasks.get(b.id)?.state === 'running');
    const grant = await m.relay({ source: 'phone', userId: 'reviewer', taskIds: [a.id, b.id] });
    const requestId = 'shared-action-request';
    await grant.client.act(a.id, 'message', { body: 'First' }, { requestId });
    await assert.rejects(grant.client.act(b.id, 'message', { body: 'Second' }, { requestId }), (e) => e.code === 'CONFLICT');
    let release;
    m.eng.engine.locks.set(a.id, new Promise((r) => { release = r; }));
    const waiting = grant.client.act(a.id, 'message', { body: 'DO-NOT-DELIVER' });
    const result = waiting.then(() => null, (e) => e);
    await waitFor(() => m.eng.engine.actCache.size >= 2, { label: 'queued action admitted' });
    revokeRelayToken({ dataDir: m.dataDir, token: grant.token });
    release();
    assert.equal((await result).code, 'UNAUTHENTICATED');
    assert.ok(!(await m.client.listMessages(a.id)).some((msg) => msg.body === 'DO-NOT-DELIVER'));
  } finally { await m.done(); }
});

test('relay expiry closes live subscriptions without exposing later messages or heartbeat data', async () => {
  const m = await setup();
  try {
    const { id } = await m.client.createTask({ text: 'Expiry fixture', cwd: m.repo.checkout });
    await waitFor(() => m.eng.tasks.get(id)?.state === 'running');
    const grant = await m.relay({ source: 'phone', userId: 'reviewer', taskIds: [id] });
    const events = []; await grant.client.subscribe('*', {}, (e) => events.push(e));
    const file = path.join(m.dataDir, 'relay-tokens.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.tokens[0].expiresAt = Date.now() - 1;
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file);
    await m.client.act(id, 'message', { body: 'AFTER-EXPIRY' });
    await waitFor(() => grant.client.closed);
    assert.ok(!JSON.stringify(events).includes('AFTER-EXPIRY'));
  } finally { await m.done(); }
});
