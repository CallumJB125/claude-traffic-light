// Shared driver for the per-adapter fixture tests: every recorded payload in
// fixtures/<id>.json goes through normalize(), through `emit.js --adapter`,
// and through the app's POST /hook/:adapter route, and all three must agree.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const EMIT = path.join(__dirname, '..', '..', 'hooks', 'emit.js');
const HOST = os.hostname().split('.')[0];
const CAPABILITIES = ['working', 'yourTurn', 'blocked', 'answer', 'subagents', 'limits', 'cost'];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-adapter-'));
const fixtures = (id) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${id}.json`), 'utf8'));
const sessionFiles = (home) => { try { return fs.readdirSync(path.join(home, 'sessions')).filter((f) => f.endsWith('.json')); } catch { return []; } };
const readSession = (home, f) => JSON.parse(fs.readFileSync(path.join(home, 'sessions', f), 'utf8'));

// Partial match: every key the fixture names must equal; `extra` only for
// the keys it lists.
function matches(actual, expected) {
  assert.equal(actual.length, expected.length, JSON.stringify(actual));
  expected.forEach((e, i) => {
    const a = actual[i];
    for (const k of ['signal', 'sessionId', 'cwd', 'tool']) assert.equal(a[k], e[k], `${k} of ${JSON.stringify(a)}`);
    for (const [k, v] of Object.entries(e.extra || {})) assert.equal(a.extra[k], v, `extra.${k}`);
  });
}

function emitArgs(adapter, fx) {
  return adapter.id === 'codex' ? ['--adapter', 'codex', JSON.stringify(fx.payload)] : ['--adapter', adapter.id, fx.event];
}

// A fake electron `app` and port 0, so the real signal server runs under node.
let server = null;
function startServer(home) {
  if (server) return server;
  process.env.CLAUDE_TRAFFIC_LIGHT_PORT = '0';
  require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: { app: { on() {} } } };
  const sessionsDir = path.join(home, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  let broadcasts = 0;
  const factory = require('../../src/signal-server.js');
  const s = factory({ rootDir: home, sessionsDir, requestsDir: path.join(home, 'requests'), aggregateState: () => ({ look: {}, sessions: [] }), broadcastStatus: () => { broadcasts += 1; } });
  const http = s.startSignalServer();
  after(() => { http.closeAllConnections(); http.close(); });
  server = { home, broadcasts: () => broadcasts };
  return server;
}

async function post(home, urlPath, body, token) {
  const deadline = Date.now() + 5000;
  let port = null;
  while (!port && Date.now() < deadline) {
    try { port = Number(fs.readFileSync(path.join(home, 'port'), 'utf8')); } catch { await new Promise((r) => setTimeout(r, 20)); }
  }
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? { 'x-buddy-token': fs.readFileSync(path.join(home, 'token'), 'utf8') } : token ? { 'x-buddy-token': token } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

function suite(adapter) {
  const id = adapter.id;

  test(`${id}: exposes the adapter contract`, () => {
    for (const k of ['id', 'label', 'transport']) assert.equal(typeof adapter[k], 'string', k);
    assert.ok(['command', 'http', 'poll'].includes(adapter.transport));
    assert.deepEqual(Object.keys(adapter.capabilities).sort(), [...CAPABILITIES].sort());
    for (const k of ['detect', 'install', 'uninstall', 'isInstalled', 'commandFor', 'normalize']) assert.equal(typeof adapter[k], 'function', k);
    const home = tmp();
    assert.equal(adapter.detect({ home, exists: fs.existsSync }), false);
  });

  for (const fx of fixtures(id)) {
    test(`${id}: normalize — ${fx.name}`, () => {
      matches(adapter.normalize(fx.event, fx.payload), fx.expect);
      if ('reply' in fx) assert.deepEqual(adapter.reply ? adapter.reply(fx.event, fx.payload) : null, fx.reply);
    });
  }

  test(`${id}: emit.js --adapter writes what normalize says`, () => {
    for (const fx of fixtures(id)) {
      const home = tmp();
      const r = spawnSync(process.execPath, [EMIT, ...emitArgs(adapter, fx)], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home }, input: adapter.id === 'codex' ? '' : JSON.stringify(fx.payload) });
      assert.equal(r.status, 0, r.stderr.toString());
      if ('reply' in fx) assert.equal(r.stdout.toString(), fx.reply ? JSON.stringify(fx.reply) : '', fx.name);
      const expect = fx.expect.filter((e) => e.signal !== 'session-end');
      const files = sessionFiles(home);
      assert.equal(files.length, expect.length ? 1 : 0, `${fx.name}: ${files}`);
      if (!expect.length) continue;
      const want = expect[expect.length - 1];
      const d = readSession(home, files[0]);
      assert.equal(files[0], id === 'claude' ? `${HOST}-${want.sessionId}.json` : `${HOST}-${id}-${want.sessionId}.json`);
      assert.deepEqual([d.source, d.sessionId, d.cwd, d.tool], [id, want.sessionId, want.cwd, want.tool], fx.name);
    }
  });

  test(`${id}: POST /hook/${id} applies the same signals, token-protected`, async () => {
    const { home } = startServer(tmp());
    for (const fx of fixtures(id)) {
      const url = `/hook/${id}${fx.event ? `?event=${fx.event}` : ''}`;
      const r = await post(home, url, fx.payload);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.signals, fx.expect.map((e) => e.signal), fx.name);
      const last = fx.expect[fx.expect.length - 1];
      if (!last) continue;
      const file = id === 'claude' ? `${HOST}-${last.sessionId}.json` : `${HOST}-${id}-${last.sessionId}.json`;
      if (last.signal === 'session-end') assert.equal(fs.existsSync(path.join(home, 'sessions', file)), false);
      else assert.equal(readSession(home, file).signal, last.signal, fx.name);
    }
    assert.equal((await post(home, `/hook/${id}`, {}, 'wrong')).status, 401);
    assert.equal((await post(home, `/hook/${id}`, {}, null)).status, 401);
    assert.equal((await post(home, '/hook/nope', {})).status, 404);
  });
}

module.exports = { suite, tmp, fixtures };
