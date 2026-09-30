import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileStorage, loadOrCreateIdentity, jsonlAudit, WidgetRequestStore } from '../src/node/index.js';
import { DeviceRegistry, generateSigningKey, exportPublicRaw, RemoteApprovals, signDecision } from '../src/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-remote-'));
const mode = (f) => fs.statSync(f).mode & 0o777;

test('registry file is written 0600 and reloads', async () => {
  const dir = tmp();
  const file = path.join(dir, 'remote', 'devices.json');
  const reg = new DeviceRegistry({ storage: fileStorage(file) });
  const kp = await generateSigningKey();
  const dev = await reg.add({ publicKey: await exportPublicRaw(kp.publicKey), name: 'p', ownerId: 'alice' });
  assert.equal(mode(file), 0o600);
  const again = new DeviceRegistry({ storage: fileStorage(file) });
  assert.equal((await again.get(dev.deviceId)).ownerId, 'alice');
});

test('a corrupt registry fails loudly instead of looking empty', async () => {
  const dir = tmp();
  const file = path.join(dir, 'devices.json');
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

test('audit log is JSONL 0600', () => {
  const file = path.join(tmp(), 'audit.jsonl');
  const log = jsonlAudit(file);
  log({ type: 'a' }); log({ type: 'b' });
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).type), ['a', 'b']);
  assert.equal(mode(file), 0o600);
});

function writeReq(dir, id, extra = {}) {
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, sessionId: 's1', host: 'mac', cwd: '/repo', tool: 'Bash', summary: 'ls', createdAt: new Date().toISOString(), toolInput: { command: 'ls' }, ...extra }));
}

test('widget request store: reads hook files, first answer wins (O_EXCL)', async () => {
  const dir = tmp();
  writeReq(dir, 'mac-s1-1');
  const store = new WidgetRequestStore({ requestsDir: dir, ownerId: 'alice' });
  const p = await store.get('mac-s1-1');
  assert.deepEqual([p.toolName, p.sessionId, p.ownerId, p.toolInput.command], ['Bash', 's1', 'alice', 'ls']);
  const results = await Promise.all([store.settle('mac-s1-1', 'allow'), store.settle('mac-s1-1', 'deny')]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(await store.get('mac-s1-1'), null, 'answered requests are no longer pending');
});

test('widget request store: requests without the full tool input are never remotely answerable', async () => {
  const dir = tmp();
  writeReq(dir, 'mac-s1-2', { toolInput: undefined });
  const store = new WidgetRequestStore({ requestsDir: dir, ownerId: 'alice' });
  assert.equal(await store.get('mac-s1-2'), null);
});

test('widget request store: stale requests and path tricks are refused', async () => {
  const dir = tmp();
  writeReq(dir, 'old', { createdAt: new Date(Date.now() - 50000).toISOString() });
  const store = new WidgetRequestStore({ requestsDir: dir, ownerId: 'alice' });
  assert.equal(await store.get('old'), null);
  for (const id of ['../x', '..', 'a/b', '', '.hidden']) {
    assert.equal(await store.get(id), null, id);
    assert.equal(await store.settle(id, 'allow'), false, id);
  }
});

test('end to end over the widget request files: a phone allow writes the .answer file', async () => {
  const dir = tmp();
  writeReq(dir, 'mac-s1-3', { toolInput: { command: 'npm test' } });
  const { createIdentity } = await import('../src/index.js');
  const identity = await createIdentity();
  const registry = new DeviceRegistry();
  const kp = await generateSigningKey();
  const dev = await registry.add({ publicKey: await exportPublicRaw(kp.publicKey), name: 'p', ownerId: 'alice' });
  const pending = new WidgetRequestStore({ requestsDir: dir, ownerId: 'alice' });
  const approvals = new RemoteApprovals({ identity, registry, pending });
  const req = await pending.get('mac-s1-3');
  const { envelope } = await signDecision({ device: { deviceId: dev.deviceId, privateKey: kp.privateKey }, desktopId: identity.desktopId, request: req, decision: 'allow' });
  const out = await approvals.handleDecision(envelope);
  assert.equal(out.status, 'applied', out.reason);
  assert.equal(fs.readFileSync(path.join(dir, 'mac-s1-3.answer'), 'utf8'), 'allow');
});
