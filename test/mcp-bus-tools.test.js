'use strict';
// mcp-server.js bus_* tools: they reach /bus (never the hub) with an HTTP
// timeout above bus_wait's 120 s, where teamCall's default would cut at 6 s.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { testTempDir } = require('./helpers/tmp');
const M = require('../mcp-server.js');

test('bus tools: seven, only bus_handoff acts, all through busCall to /bus', async () => {
  const bus = M.TOOLS.filter((t) => t.name.startsWith('bus_'));
  assert.deepEqual(bus.map((t) => t.name), ['bus_peers', 'bus_session', 'bus_hello', 'bus_handoff', 'bus_wait', 'bus_read', 'bus_status']);
  assert.deepEqual(bus.filter((t) => t.readOnly === false).map((t) => t.name), ['bus_handoff']);
  const calls = [];
  for (const t of bus) await t.run({ handoff_id: 'hof_0123456789abcdef' }, { bus: async (op, args) => { calls.push(op); return {}; } });
  assert.deepEqual(calls, ['peers', 'session', 'hello', 'handoff', 'wait', 'read', 'status']);
  assert.ok(M.BUS_TIMEOUT_MS >= 130_000);
});

test('busCall waits past teamCall\'s 6 s default (a held bus_wait is not cut off)', async () => {
  const root = testTempDir('ctl-mcpbus-');
  fs.writeFileSync(path.join(root, 'token'), 'tok');
  let seen;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen = { url: req.url, token: req.headers['x-buddy-token'], body: JSON.parse(body) }; setTimeout(() => { res.end(JSON.stringify({ state: 'done' })); }, 6500); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await M.busCall('wait', { handoff_id: 'hof_0123456789abcdef', timeout_s: 10 }, { root, port: server.address().port });
    assert.deepEqual(r, { state: 'done' });
    assert.equal(seen.url, '/bus');
    assert.equal(seen.token, 'tok');
    assert.equal(seen.body.op, 'wait');
    assert.equal(seen.body.args.cwd, process.cwd(), 'the caller folder goes along; the relay moves it out of args');
  } finally { server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
