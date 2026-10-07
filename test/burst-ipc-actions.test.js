'use strict';

// WP0 contract: the generic burst-action IPC (consent fixed in main, one POST on confirm),
// burst:view sender checks, and the snapshot file main writes for the MCP server and runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ipc = require('../src/burst-ipc.js');
const { createBurstClient } = require('../src/burst-client.js');
const Snapshot = require('../src/burst-snapshot.js');
const { createFakeBurst, stateV019 } = require('./fixtures/fake-burst.js');

const SID = '0f6e3c1a-2b4d-4e5f-8a9b-0c1d2e3f4a5b';

async function harness({ answer = 1 } = {}) {
  const fake = await createFakeBurst({ '/api/state': { body: stateV019() }, '/api/upgrade-status': { body: {} }, '/api/coordination-act': { body: { ok: 'queued' } }, '/api/requests': { body: [] }, '/api/coordination': { body: {} } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-ipc-'));
  const bin = path.join(home, '.local', 'bin', 'claude-burst');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: `127.0.0.1:${fake.port}` }));
  const client = createBurstClient({ home, platform: 'darwin', inspect: { launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => bin } });
  const handlers = {};
  const dialogs = [];
  const snapshotFile = path.join(home, 'burst-snapshot.json');
  const sessions = (e) => e.from === 'sessions';
  const api = Ipc.register({
    utilityHandle: (c, allowed, f) => { handlers[c] = (e, ...a) => (allowed(e) ? f(e, ...a) : null); },
    settingsOnly: (e) => e.from === 'settings', sessionsAllowed: sessions, optimiserAllowed: (e) => e.from === 'optimiser',
    isMac: true, client, home, snapshotFile, dialog: { showMessageBox: async (o) => { dialogs.push(o); return { response: answer }; } }, shell: {}, scriptDir: '/x',
  });
  await api.refresh(true);
  return { fake, api, handlers, dialogs, snapshotFile, done: async () => { await fake.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}
const posts = (h) => h.fake.requests.filter((r) => r.method === 'POST');

test('burst-action: cancel sends nothing; confirm sends exactly one POST; the wording is main\'s', async () => {
  const h = await harness({ answer: 0 });
  const args = { session: SID, message: 'please commit', title: 'Renderer title', detail: 'renderer text' };
  assert.deepEqual(await h.handlers['burst-action']({ from: 'sessions' }, 'coord-message', args), { ok: false, cancelled: true });
  assert.equal(posts(h).length, 0);
  assert.equal(h.dialogs[0].title, 'Send message');
  assert.match(h.dialogs[0].detail, /^Burst queues this message for session 0f6e3c1a/);
  assert.ok(!JSON.stringify(h.dialogs).includes('renderer text') && !JSON.stringify(h.dialogs).includes('Renderer title'));
  await h.done();

  const y = await harness({ answer: 1 });
  const r = await y.handlers['burst-action']({ from: 'sessions' }, 'coord-message', args);
  assert.deepEqual(r, { ok: true, data: { ok: 'queued' } });
  assert.equal(posts(y).length, 1);
  assert.deepEqual(JSON.parse(posts(y)[0].body), { session: SID, message: 'please commit' });
  await y.done();
});

test('burst-action: bad args and unknown ids never reach a dialog or Burst; other pages are refused', async () => {
  const h = await harness();
  assert.deepEqual(await h.handlers['burst-action']({ from: 'sessions' }, 'coord-message', { session: SID, message: 'x'.repeat(501) }), { ok: false, error: 'Bad request.' });
  assert.deepEqual(await h.handlers['burst-action']({ from: 'sessions' }, 'secondary-key', { api_key: 'k' }), { ok: false, error: 'Unknown action.' });
  assert.equal(await h.handlers['burst-action']({ from: 'widget' }, 'reset', {}), null);
  assert.deepEqual((await h.handlers['burst:view']({ from: 'sessions' }, 'route')).view, null);
  assert.equal(h.dialogs.length, 0);
  assert.equal(posts(h).length, 0);
  await h.done();
});

test('snapshot: written 0600 after a poll and readable until stale', async () => {
  const h = await harness();
  for (let i = 0; i < 50 && !fs.existsSync(h.snapshotFile); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fs.statSync(h.snapshotFile).mode & 0o777, 0o600);
  const s = Snapshot.readSnapshot(h.snapshotFile);
  assert.equal(s.present, true);
  assert.equal(Snapshot.readSnapshot(h.snapshotFile, { now: s.at + Snapshot.STALE_MS + 1 }), null);
  assert.ok(!fs.readdirSync(path.dirname(h.snapshotFile)).some((f) => f.endsWith('.tmp')));
  await h.done();
});

test('main.js routes burst-* health fixes to runAction and passes the snapshot path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /id\.startsWith\('burst-'\)[\s\S]{0,200}BurstIpc\.runAction\(id\.slice\('burst-'\.length\)\)/);
  assert.match(src, /snapshotFile: require\('\.\/src\/burst-snapshot\.js'\)\.snapshotPath\(ROOT_DIR\)/);
  assert.match(src, /burstFacts: BurstIpc\.healthFacts\(\)/);
});
