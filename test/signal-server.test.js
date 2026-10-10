// The signal server's bind, against a port another listener holds (as the old
// app does while it quits). Never the real port: the env var points the module
// at a throwaway listener before it is loaded, and the port is passed in too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { testTempDir } = require('./helpers/tmp');

const hold = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => resolve(s)); });

test('signal server: a port still held by the quitting old app is tried again, and port and token are written once it binds', async () => {
  const holder = await hold();
  const port = holder.address().port;
  process.env.CLAUDE_TRAFFIC_LIGHT_PORT = String(port);
  const rootDir = testTempDir('ctl-signal-');
  const quits = [];
  const S = require('../src/signal-server.js')({ rootDir, sessionsDir: rootDir, requestsDir: rootDir, aggregateState: () => ({ sessions: [] }), broadcastStatus: () => {}, port, retries: 20, retryMs: 20, app: { on: (e, fn) => quits.push([e, fn]) } });
  const server = S.startSignalServer();
  setTimeout(() => holder.close(), 80);
  await new Promise((resolve, reject) => { server.once('listening', resolve); setTimeout(() => reject(new Error('never bound')), 3000); });
  assert.equal(server.address().port, port);
  assert.equal(fs.readFileSync(path.join(rootDir, 'port'), 'utf8'), String(port));
  assert.match(fs.readFileSync(path.join(rootDir, 'token'), 'utf8'), /^[0-9a-f]{64}$/);
  assert.deepEqual(quits.map(([e]) => e), ['will-quit']);
  server.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('signal server: gives up after its tries when the port stays taken, writing no port file', async () => {
  const holder = await hold();
  const port = holder.address().port;
  process.env.CLAUDE_TRAFFIC_LIGHT_PORT ||= String(port);
  const rootDir = testTempDir('ctl-signal-');
  const S = require('../src/signal-server.js')({ rootDir, sessionsDir: rootDir, requestsDir: rootDir, aggregateState: () => ({ sessions: [] }), broadcastStatus: () => {}, port, retries: 3, retryMs: 10, app: { on: () => {} } });
  const errors = [];
  const server = S.startSignalServer();
  server.on('error', (e) => errors.push(e.code));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(errors, ['EADDRINUSE', 'EADDRINUSE', 'EADDRINUSE', 'EADDRINUSE'], 'the first bind and three more');
  assert.equal(server.listening, false);
  assert.equal(fs.existsSync(path.join(rootDir, 'port')), false);
  holder.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('signal server: /team/mail needs the token, forwards only op and args to agent mail, and is 404 without it', async () => {
  const rootDir = testTempDir('ctl-signal-');
  const seen = [];
  const S = require('../src/signal-server.js')({ rootDir, sessionsDir: rootDir, requestsDir: rootDir, aggregateState: () => ({ sessions: [] }), broadcastStatus: () => {}, port: 0, app: { on: () => {} },
    agentMail: async (op, args) => { seen.push([op, args]); return { available: true, op }; } });
  const server = S.startSignalServer();
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const post = (headers, body) => fetch(`http://127.0.0.1:${port}/team/mail`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({}, { op: 'ask' })).status, 401);
  const M = require('../mcp-server.js');
  const r = await M.mailCall('ask', { to: 'bob', question: 'q' }, { root: rootDir, port });
  assert.deepEqual(r, { available: true, op: 'ask' });
  assert.equal(seen[0][0], 'ask');
  assert.deepEqual(Object.keys(seen[0][1]).sort(), ['cwd', 'question', 'to']);
  server.close();
  const S2 = require('../src/signal-server.js')({ rootDir, sessionsDir: rootDir, requestsDir: rootDir, aggregateState: () => ({ sessions: [] }), broadcastStatus: () => {}, port: 0, app: { on: () => {} } });
  const s2 = S2.startSignalServer();
  await new Promise((resolve) => s2.once('listening', resolve));
  const token = fs.readFileSync(path.join(rootDir, 'token'), 'utf8');
  const res = await fetch(`http://127.0.0.1:${s2.address().port}/team/mail`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-buddy-token': token }, body: '{"op":"ask"}' });
  assert.equal(res.status, 404);
  s2.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});
