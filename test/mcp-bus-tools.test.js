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

test('bus tools: ten, only bus_handoff, bus_note and bus_card_add act, all through busCall to /bus', async () => {
  const bus = M.TOOLS.filter((t) => t.name.startsWith('bus_'));
  assert.deepEqual(bus.map((t) => t.name), ['bus_peers', 'bus_session', 'bus_hello', 'bus_handoff', 'bus_wait', 'bus_read', 'bus_status', 'bus_note', 'bus_notes', 'bus_card_add']);
  assert.deepEqual(bus.filter((t) => t.readOnly === false).map((t) => t.name), ['bus_handoff', 'bus_note', 'bus_card_add']);
  const calls = [];
  for (const t of bus) await t.run({ handoff_id: 'hof_0123456789abcdef' }, { bus: async (op, args) => { calls.push(op); return {}; } });
  assert.deepEqual(calls, ['peers', 'session', 'hello', 'handoff', 'wait', 'read', 'status', 'note', 'notes', 'card_add']);
  // bus_card_add sends only its own three fields: where the card goes is main's to decide (PR B review point 7).
  const sent = [];
  await bus.find((t) => t.name === 'bus_card_add').run({ title: 'Fix', details: 'd', request_id: 'req-00000001', cwd: '/elsewhere', board: 'x' }, { bus: async (op, args) => { sent.push(args); return {}; } });
  assert.deepEqual(sent, [{ title: 'Fix', details: 'd', request_id: 'req-00000001' }]);
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

test('buddy_health asks the bus for its provider health and shows a row for an AI that cannot take hand-offs', async () => {
  const tool = M.TOOLS.find((t) => t.name === 'buddy_health');
  const asked = [];
  const reset = Date.parse('2026-11-12T17:42:00Z');
  const bus = async (op) => { asked.push(op); return op === 'status' ? { providers: [{ provider: 'claude', state: 'closed' }, { provider: 'codex', state: 'open', reason: 'QUOTA', retry_at: reset }] } : { bound: true }; };
  const root = testTempDir('ctl-mcphealth-');
  const h = await tool.run({}, { bus, root, home: testTempDir('ctl-mcphealth-home-'), live: null, statfs: () => ({ bavail: 1e6, bsize: 1e6 }) });
  assert.deepEqual(asked.sort(), ['peers', 'status']);
  const row = h.checks.find((c) => c.id === 'bus-providers');
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /^Codex is out of its usage quota until 2026-11-12 17:42 UTC\./);
  // A bus that does not answer: the rest of the report still comes back, with no provider row.
  const quiet = await tool.run({}, { bus: async () => { throw new Error('down'); }, root, home: testTempDir('ctl-mcphealth-home-'), live: null, statfs: () => ({ bavail: 1e6, bsize: 1e6 }) });
  assert.equal(quiet.checks.find((c) => c.id === 'bus-providers'), undefined);
});

test('bus_hello\'s description names the field each case carries: repo_why when on, repo_reason when off (contract)', () => {
  const d = M.TOOLS.find((t) => t.name === 'bus_hello').description;
  assert.match(d, /repo_why/);
  assert.match(d, /repo_reason/);
});
