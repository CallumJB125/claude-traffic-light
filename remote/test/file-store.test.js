import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fileStorage, loadOrCreateIdentity, jsonlAudit, readAuditHead, WidgetRequestStore } from '../src/node/index.js';
import { DeviceRegistry, generateSigningKey, exportPublicRaw, RemoteApprovals, signDecision, createIdentity, hashToolInput, canonicalize } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const Answer = createRequire(import.meta.url)('../../hooks/answer-file.js');
const SET_STATUS = path.join(HERE, '..', '..', 'hooks', 'set-status.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-remote-'));
const mode = (f) => fs.statSync(f).mode & 0o777;

test('registry file is written 0600 and reloads', async () => {
  const file = path.join(tmp(), 'remote', 'devices.json');
  const reg = new DeviceRegistry({ storage: fileStorage(file) });
  const kp = await generateSigningKey();
  const dev = await reg.add({ publicKey: await exportPublicRaw(kp.publicKey), name: 'p', ownerId: 'alice' });
  assert.equal(mode(file), 0o600);
  const again = new DeviceRegistry({ storage: fileStorage(file) });
  assert.equal((await again.get(dev.deviceId)).ownerId, 'alice');
});

test('a corrupt registry fails loudly instead of looking empty', async () => {
  const file = path.join(tmp(), 'devices.json');
  fs.writeFileSync(file, '{nope');
  await assert.rejects(new DeviceRegistry({ storage: fileStorage(file) }).list(), /unreadable/);
});

test('desktop identity persists with 0600 and keeps its id', async () => {
  const file = path.join(tmp(), 'identity.json');
  const a = await loadOrCreateIdentity(file);
  assert.equal(mode(file), 0o600);
  const b = await loadOrCreateIdentity(file);
  assert.equal(a.desktopId, b.desktopId);
});

test('audit log is JSONL 0600 and its head can be recovered', () => {
  const file = path.join(tmp(), 'audit.jsonl');
  const log = jsonlAudit(file);
  log({ type: 'a', seq: 1, hash: 'h1' }); log({ type: 'b', seq: 2, hash: 'h2' });
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).type), ['a', 'b']);
  assert.equal(mode(file), 0o600);
  assert.deepEqual(readAuditHead(file), { head: 'h2', seq: 2 });
  assert.equal(readAuditHead(path.join(tmp(), 'none')), undefined);
});

function writeReq(dir, id, extra = {}) {
  const toolInput = 'toolInput' in extra ? extra.toolInput : { command: 'ls' };
  const r = { id, sessionId: 's1', host: 'mac', cwd: '/repo', tool: 'Bash', summary: 'ls', createdAt: new Date().toISOString(), toolInput, toolInputHash: toolInput ? Answer.hashToolInput(toolInput) : undefined, ...extra };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(r));
  return r;
}

test('the hook and the desktop hash tool input identically (CJS vs isomorphic canonical JSON)', async () => {
  for (const v of [{}, { command: 'ls', b: [1, 2.5, -0, 1e21, null, true] }, { é: 'ü ', a: { z: 1, y: [{}] } }, { big: 'x'.repeat(5000) }]) {
    assert.equal(Answer.canonicalize(v), canonicalize(v));
    assert.equal(Answer.hashToolInput(v), await hashToolInput(v));
  }
});

test('widget request store: reads hook files; describe() cannot override input or owner', async () => {
  const dir = tmp();
  writeReq(dir, 'mac-1');
  const store = new WidgetRequestStore({ requestsDir: dir, ownerId: 'alice', describe: () => ({ cardId: 'BDL-1', toolInput: { command: 'rm -rf /' }, ownerId: 'mallory', requestId: 'x' }) });
  const p = await store.get('mac-1');
  assert.deepEqual([p.toolName, p.sessionId, p.ownerId, p.toolInput.command, p.cardId, p.requestId], ['Bash', 's1', 'alice', 'ls', 'BDL-1', 'mac-1']);
});

test('widget request store: no input, no hash, a hash that does not match, or a bad date → not answerable', async () => {
  const dir = tmp();
  writeReq(dir, 'no-input', { toolInput: undefined });
  writeReq(dir, 'no-hash', { toolInputHash: undefined });
  writeReq(dir, 'bad-hash', { toolInputHash: 'f'.repeat(64) });
  writeReq(dir, 'no-date', { createdAt: undefined });
  writeReq(dir, 'junk-date', { createdAt: 'yesterday' });
  writeReq(dir, 'future', { createdAt: new Date(Date.now() + 60000).toISOString() });
  writeReq(dir, 'old', { createdAt: new Date(Date.now() - 50000).toISOString() });
  const store = new WidgetRequestStore({ requestsDir: dir, ownerId: 'alice' });
  for (const id of ['no-input', 'no-hash', 'bad-hash', 'no-date', 'junk-date', 'future', 'old']) assert.equal(await store.get(id), null, id);
});

test('widget request store: only permission and plan requests are answerable remotely', async () => {
  const dir = tmp();
  for (const kind of ['permission', 'plan', 'question', 'elicitation', 'blocked']) writeReq(dir, `k-${kind}`, { kind });
  const store = new WidgetRequestStore({ requestsDir: dir, ownerId: 'alice' });
  assert.ok(await store.get('k-permission'));
  assert.ok(await store.get('k-plan'));
  for (const kind of ['question', 'elicitation', 'blocked']) assert.equal(await store.get(`k-${kind}`), null, kind);
});

test('review attack: a request with no createdAt is not answerable however late it is', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ id: 'a', sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, toolInputHash: Answer.hashToolInput({ command: 'ls' }) }));
  const st = new WidgetRequestStore({ requestsDir: dir, ownerId: 'o', clock: () => Date.now() + 1e9 });
  assert.equal(await st.get('a'), null);
});

test('widget request store: path tricks are refused', async () => {
  const store = new WidgetRequestStore({ requestsDir: tmp(), ownerId: 'alice' });
  for (const id of ['../x', '..', 'a/b', '', '.hidden']) {
    assert.equal(await store.get(id), null, id);
    assert.equal(await store.settle(id, 'allow'), 'already-answered', id);
  }
});

test('widget request store: first answer wins; without a hook ack it is "unconfirmed", never applied', async () => {
  const dir = tmp();
  writeReq(dir, 'mac-2');
  const store = new WidgetRequestStore({ requestsDir: dir, ownerId: 'alice', ackTimeoutMs: 100 });
  const [a, b] = await Promise.all([store.settle('mac-2', 'allow'), store.settle('mac-2', 'deny')]);
  assert.deepEqual([a, b].sort(), ['already-answered', 'unconfirmed']);
  assert.equal(await store.get('mac-2'), null, 'answered requests are no longer pending');
});

const listening = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => res(s)); });

async function withHook(input, askMs, fn) {
  const home = tmp();
  const srv = await listening();
  const dir = path.join(home, 'requests');
  const child = spawn(process.execPath, [SET_STATUS, 'permission-request'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_ASK_MS: String(askMs), CLAUDE_TRAFFIC_LIGHT_PORT: String(srv.address().port) } });
  child.stdin.end(JSON.stringify({ session_id: 's1', cwd: '/repo', tool_name: 'Bash', tool_input: input }));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((res) => child.on('exit', () => res(out)));
  try {
    let req = null;
    const deadline = Date.now() + 4000;
    while (!req && Date.now() < deadline) {
      const f = fs.existsSync(dir) && fs.readdirSync(dir).find((x) => x.endsWith('.json'));
      if (f) req = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      else await new Promise((r) => setTimeout(r, 20));
    }
    return await fn({ dir, req, exited });
  } finally { srv.close(); }
}

async function approvalsOver(dir, opts = {}) {
  const identity = await createIdentity();
  const registry = new DeviceRegistry();
  const kp = await generateSigningKey();
  const dev = await registry.add({ publicKey: await exportPublicRaw(kp.publicKey), name: 'p', ownerId: 'alice' });
  const pending = new WidgetRequestStore({ requestsDir: dir, ownerId: 'alice', describe: () => ({ cwd: '/repo' }), ...opts });
  const approvals = new RemoteApprovals({ identity, registry, pending });
  const sign = (req, decision = 'allow') => signDecision({ device: { deviceId: dev.deviceId, privateKey: kp.privateKey }, desktopId: identity.desktopId, request: req, decision });
  return { approvals, pending, sign };
}

test('end to end with the real hook: a phone allow is applied only after the hook confirms it took it', async () => {
  await withHook({ command: 'git status' }, 5000, async ({ dir, req, exited }) => {
    const { approvals, pending, sign } = await approvalsOver(dir);
    const p = await pending.get(req.id);
    const out = await approvals.handleDecision((await sign(p)).envelope);
    assert.equal(out.status, 'applied', out.reason);
    assert.deepEqual(JSON.parse(await exited).hookSpecificOutput.decision, { behavior: 'allow' });
    assert.deepEqual(fs.readdirSync(dir), [], 'the desktop cleaned up its .taken ack');
  });
});

test('end to end: the hook times out first → the phone is told "not applied", not success', async () => {
  await withHook({ command: 'git status' }, 300, async ({ dir, req, exited }) => {
    const { approvals, pending, sign } = await approvalsOver(dir, { maxAgeMs: 60000 });
    const p = await pending.get(req.id);
    const { envelope } = await sign(p);
    assert.equal(await exited, '', 'hook gave up with no decision');
    const out = await approvals.handleDecision(envelope);
    assert.notEqual(out.status, 'applied');
    assert.ok(['no-such-request', 'already-answered', 'not-confirmed'].includes(out.reason), out.reason);
  });
});

test('end to end: the desk answered first → the phone is told already answered', async () => {
  await withHook({ command: 'git status' }, 5000, async ({ dir, req, exited }) => {
    const { approvals, pending, sign } = await approvalsOver(dir);
    const p = await pending.get(req.id);
    const { envelope } = await sign(p, 'allow');
    assert.equal(Answer.writeAnswer(dir, req.id, 'deny', { by: 'desk' }).ok, true);
    const out = await approvals.handleDecision(envelope);
    assert.equal(out.status, 'rejected');
    assert.ok(['already-answered', 'no-such-request'].includes(out.reason), out.reason);
    assert.equal(JSON.parse(await exited).hookSpecificOutput.decision.behavior, 'deny');
  });
});
