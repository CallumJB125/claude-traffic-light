'use strict';
// main's /bus relay (src/signal-server.js): allow-listed, token-checked, no
// browser origin, async only; agents get only the agent ops (never halt,
// resume or busSetContext); a Tasks helper that cannot start, or exits
// mid-bus_wait, is answered at once with tasks_helper_unavailable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testTempDir } = require('./helpers/tmp');
const { createTasksService } = require('../src/tasks-service.js');
const { startAppBus, until } = require('./helpers/agent-bus');

async function serve(agentBus) {
  const rootDir = testTempDir('ctl-bus-');
  const S = require('../src/signal-server.js')({ rootDir, sessionsDir: rootDir, requestsDir: rootDir, aggregateState: () => ({ sessions: [] }), broadcastStatus: () => {}, port: 0, app: { on: () => {} }, agentBus });
  const server = S.startSignalServer();
  await new Promise((resolve) => server.once('listening', resolve));
  await until(() => fs.existsSync(path.join(rootDir, 'token')));
  const port = server.address().port;
  const token = fs.readFileSync(path.join(rootDir, 'token'), 'utf8');
  const post = (body, headers = { 'x-buddy-token': token }) => fetch(`http://127.0.0.1:${port}/bus`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { rootDir, port, post, close: () => { server.close(); fs.rmSync(rootDir, { recursive: true, force: true }); } };
}

test('/bus: token required, browser origins refused, only agent ops forwarded, cwd moved to the caller, handoff text scrubbed', async () => {
  const seen = [];
  const s = await serve(async (op, args, caller) => { seen.push({ op, args, caller }); return { ok: true, op }; });
  try {
    assert.equal((await s.post({ op: 'hello', args: {} }, {})).status, 401);
    assert.equal((await s.post({ op: 'hello', args: {} }, { origin: 'https://evil.example', 'x-buddy-token': 'x' })).status, 403);
    for (const op of ['halt', 'resume', 'busSetContext', 'list', 'notes_pending', 'notified']) assert.equal((await (await s.post({ op })).json()).reason, 'VALIDATION', `${op} is not an agent op`);
    const r = await (await s.post({ op: 'handoff', args: { cwd: '/repo/here', provider: 'claude', title: 'Use AKIAZ7Q4M2LXWB3K9RTD', brief: 'x'.repeat(5000) } })).json();
    assert.deepEqual(r, { ok: true, op: 'handoff' });
    assert.deepEqual(seen.map((x) => x.op), ['handoff']);
    assert.deepEqual(seen[0].caller, { provider: 'claude', cwd: '/repo/here' });
    assert.ok(!('cwd' in seen[0].args));
    assert.ok(!seen[0].args.title.includes('AKIA'));
    assert.equal(seen[0].args.brief.length, 3200, 'cut to the limit after scrubbing');
    // A note's text is scrubbed the same way (home as ~, secrets out) and cut to 800.
    await s.post({ op: 'note', args: { to: 'claude-app-a1e0', text: `see ${require('node:os').homedir()}/x AKIAZ7Q4M2LXWB3K9RTD ${'y'.repeat(2000)}`, request_id: 'req-00000001' } });
    const note = seen.find((x) => x.op === 'note');
    assert.ok(note.args.text.startsWith('see ~/x ') && !note.args.text.includes('AKIA'), note.args.text.slice(0, 40));
    assert.equal(note.args.text.length, 800);
    // The MCP side: busCall goes to /bus with a timeout above bus_wait's 120 s.
    const M = require('../mcp-server.js');
    assert.ok(M.BUS_TIMEOUT_MS >= 130_000);
    assert.deepEqual(await M.busCall('status', {}, { root: s.rootDir, port: s.port }), { ok: true, op: 'status' });
  } finally { s.close(); }
});

test('/bus: a helper that cannot start answers tasks_helper_unavailable at once', async () => {
  const dir = testTempDir('ctl-bus-svc-');
  const svc = createTasksService({ boardHome: dir, homeDir: '/Users/nobody', ensureSupervisor: () => Promise.reject(new Error('Tasks helper keeps stopping')) });
  const s = await serve((op, args, caller) => svc.bus(op, args, caller));
  try {
    const t0 = Date.now();
    const r = await (await s.post({ op: 'wait', args: { handoff_id: 'hof_0123456789abcdef', timeout_s: 120 } })).json();
    assert.equal(r.reason, 'tasks_helper_unavailable');
    assert.equal(r.available, false);
    assert.ok(Date.now() - t0 < 2000, 'no hang');
  } finally { svc.stop(); s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/bus: the helper exiting mid-bus_wait answers tasks_helper_unavailable at once, not after the wait', async () => {
  const a = await startAppBus({ wait: true });
  let closed = false;
  try {
    const offer = await a.tool('bus_handoff', { request_id: 'mid-wait-0001', to: { provider: 'codex' }, repo: a.b.h.repo.checkout, provider: 'claude', title: 'Hang' });
    assert.equal(offer.state, 'offered', JSON.stringify(offer));
    const t0 = Date.now();
    const waiting = a.tool('bus_wait', { handoff_id: offer.handoff_id, timeout_s: 120, provider: 'claude' });
    await new Promise((r) => setTimeout(r, 400));
    await a.b.h.eng.close();
    closed = true;
    const r = await waiting;
    assert.equal(r.reason, 'tasks_helper_unavailable', JSON.stringify(r));
    assert.ok(Date.now() - t0 < 10_000, 'answered when the helper went, not after 120 s');
  } finally {
    if (closed) { a.svc.stop(); a.server.close(); fs.rmSync(a.rootDir, { recursive: true, force: true }); fs.rmSync(a.b.h.dir, { recursive: true, force: true }); }
    else await a.cleanup();
  }
});

test('/bus: a handoff that times out, or loses its helper mid-call, says the outcome is unknown and to retry with the same request_id', async () => {
  const errs = { hang: () => new Promise(() => {}), gone: () => Promise.reject(Object.assign(new Error('closed'), { code: 'INTERNAL' })), never: () => Promise.reject(Object.assign(new Error('x'), { code: 'SUPERVISOR_UNREACHABLE' })) };
  let mode = 'hang';
  const rootDir = testTempDir('ctl-bus-dl-');
  const S = require('../src/signal-server.js')({ rootDir, sessionsDir: rootDir, requestsDir: rootDir, aggregateState: () => ({ sessions: [] }), broadcastStatus: () => {}, port: 0, app: { on: () => {} }, busDeadlineMs: 200, agentBus: () => errs[mode]() });
  const server = S.startSignalServer();
  await new Promise((resolve) => server.once('listening', resolve));
  await until(() => fs.existsSync(path.join(rootDir, 'token')));
  const token = fs.readFileSync(path.join(rootDir, 'token'), 'utf8');
  const post = (op) => fetch(`http://127.0.0.1:${server.address().port}/bus`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-buddy-token': token }, body: JSON.stringify({ op, args: {} }) }).then((r) => r.json());
  try {
    for (const m of ['hang', 'gone']) {
      mode = m;
      const r = await post('handoff');
      assert.equal(r.outcome, 'unknown', m);
      assert.match(r.message, /same request_id/);
      assert.doesNotMatch(r.message, /Nothing was handed off/);
    }
    mode = 'never';
    assert.match((await post('handoff')).message, /Nothing was handed off/, 'a helper never reached posted nothing');
    mode = 'hang';
    assert.equal((await post('status')).outcome, undefined, 'only a handoff can be half-done');
  } finally { server.close(); fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test('every helper connection gets the bus context at once, with no bus call, and the tray hears the helper is up', async () => {
  let ready = 0;
  const a = await startAppBus({ wait: true }, { busContext: () => ({ settings: { wall_clock_min: 7 }, repos: ['/prefs/repo'], folders: [] }), onBusReady: () => { ready++; } });
  try {
    a.svc.start();
    await until(() => a.b.engine.agentBus.context.settings?.wall_clock_min === 7 && ready === 1);
    assert.deepEqual(a.b.engine.agentBus.context.repos, ['/prefs/repo']);
  } finally { await a.cleanup(); }
});
