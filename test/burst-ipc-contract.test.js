'use strict';

// D1: every registered burst:* (and burst-action) channel resolves to {ok:boolean, ...}
// and never rejects into the renderer, even with a client whose every method throws.
const test = require('node:test');
const assert = require('node:assert/strict');
const Ipc = require('../src/burst-ipc.js');

// Every property is a function that throws; `detect` included.
const throwingClient = () => new Proxy({}, { get: (_t, name) => (name === 'then' ? undefined : () => { throw Object.assign(new Error(`${String(name)} exploded`), { code: 'boom' }); }) });
// `detect` answers present (0.20.36 capabilities), everything else throws: the data channels must fail closed.
const presentThenThrowing = () => new Proxy({}, { get: (_t, name) => {
  if (name === 'then') return undefined;
  if (name === 'detect') return async () => ({ kind: 'present', installed: true, pid: 1, upgrade: null, capabilities: { state: true, usage: true, upgradeStatus: true, handoverAudit: true, handoverFile: true, testConnection: true, looseEnds: true, keepAwake: true, mods: true, finder: true, handoffTaken: true, consoleRepair: true, intelligentCompaction: true, codex: true }, state: { version: '0.20.36', mode: 'base-url', active: true, route: 'PRIMARY', rejected: [], primaryFailures: 0, compaction: { pauseless: { enabled: false, mode: 'fixed' }, sessions: [], active: false }, contextFill: [], secondaryReady: true } });
  if (name === 'adminUrl') return () => 'http://127.0.0.1:7788';
  return () => { throw Object.assign(new Error(`${String(name)} exploded`), { code: 'timeout' }); };
} });

function harness(client, { answer = 1 } = {}) {
  const handlers = {};
  const yes = () => true;
  const api = Ipc.register({
    utilityHandle: (c, allowed, f) => { handlers[c] = (e, ...a) => (allowed(e) ? f(e, ...a) : null); },
    settingsOnly: yes, chipAllowed: yes, usageAllowed: yes, sessionsAllowed: yes, accountAllowed: yes, optimiserAllowed: yes, aitoolsAllowed: yes,
    isMac: true, client, home: '/nonexistent/home', scriptDir: '/nonexistent/scripts', dialog: { showMessageBox: async () => ({ response: answer }) }, shell: { openExternal: async () => {} }, launch: async () => { throw new Error('no terminal'); },
    stateFile: null, snapshotFile: null, log: () => {},
  });
  return { handlers, api };
}

// Arguments that get each channel past its input checks, so the client is actually reached.
const CALLS = {
  'burst:status': [],
  'burst:consent-text': ['enable'],
  'burst:action': [{ kind: 'enable' }],
  'burst:test': [],
  'burst:setup-progress': [{ step: 'check', start: true }],
  'burst:set-compaction': [{ enabled: false }],
  'burst:tools': [],
  'burst:chip': [],
  'burst:usage': ['7d'],
  'burst-action': ['reset', {}],
  'burst:codex-routing': [],
  'burst:view': ['requests', {}],
  'burst:context-breakdown': ['0f6e3c1a-2b4d-4e5f-8a9b-0c1d2e3f4a5b'],
  'burst:handover-share': ['0123456789abcdef', true],
};

test('every registered channel is covered by this test and answers {ok:boolean} with a throwing client, without rejecting', async () => {
  const h = harness(throwingClient());
  await h.api.refresh(true);
  const channels = Object.keys(h.handlers);
  assert.ok(channels.length >= 14, channels.join());
  for (const c of channels) assert.ok(Object.hasOwn(CALLS, c), `add ${c} to CALLS`);
  for (const c of channels) {
    const r = await h.handlers[c]({}, ...CALLS[c]);
    assert.ok(r && typeof r === 'object', `${c} resolved to ${JSON.stringify(r)}`);
    assert.equal(typeof r.ok, 'boolean', `${c}: ${JSON.stringify(r)}`);
    if (!r.ok) assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `${c} failed without a reason: ${JSON.stringify(r)}`);
  }
});

test('with Burst present and every other call throwing, each data channel fails closed with ok:false and a reason', async () => {
  const h = harness(presentThenThrowing());
  await h.api.refresh(true);
  const mustFail = ['burst:action', 'burst:test', 'burst:set-compaction', 'burst:usage', 'burst-action', 'burst:codex-routing', 'burst:view'];
  for (const c of mustFail) {
    const r = await h.handlers[c]({}, ...CALLS[c]);
    assert.equal(r.ok, false, `${c}: ${JSON.stringify(r)}`);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `${c}: ${JSON.stringify(r)}`);
  }
  // The read-only views still answer (never an empty card), with ok:true and the cached state.
  const status = await h.handlers['burst:status']({});
  assert.equal(status.ok, true); assert.equal(status.kind, 'on'); assert.ok(status.detail.length > 0);
  const tools = await h.handlers['burst:tools']({});
  assert.equal(tools.ok, true); assert.equal(tools.kind, 'on'); assert.equal(tools.band, null);
  const setup = await h.handlers['burst:setup-progress']({}, { step: 'check', start: true });
  assert.equal(setup.ok, true); assert.equal(setup.steps.length, 4); assert.equal(setup.steps.find((s) => s.id === 'check').status, 'running');
  const chip = await h.handlers['burst:chip']({});
  assert.equal(chip.ok, true); assert.equal(chip.chip.label, 'Primary');
});

test('contract(): a handler result keeps its shape and gains ok; error becomes reason; null/undefined fail closed', () => {
  assert.deepEqual(Ipc.contract({ view: null }), { ok: true, view: null });
  assert.deepEqual(Ipc.contract({ ok: false, cancelled: true }), { ok: false, cancelled: true });
  assert.deepEqual(Ipc.contract({ view: null, error: 'Not available.' }), { ok: false, view: null, error: 'Not available.', reason: 'Not available.' });
  assert.deepEqual(Ipc.contract({ error: 'x', reason: 'why' }), { ok: false, error: 'x', reason: 'why' });
  assert.deepEqual(Ipc.contract(null), { ok: false, reason: 'Not available.' });
  assert.deepEqual(Ipc.contract(undefined), { ok: false, reason: 'Not available.' });
  assert.deepEqual(Ipc.contract([1]), { ok: false, reason: 'Not available.' });
  assert.deepEqual(Ipc.contract('text'), { ok: false, reason: 'Not available.' });
});

test('guarded(): a handler that throws (sync or async) answers ok:false with a reason mapped from the error code', async () => {
  const logs = [];
  const handlers = {};
  const handle = Ipc.guarded((c, allowed, f) => { handlers[c] = (e, ...a) => (allowed(e) ? f(e, ...a) : null); }, (...a) => logs.push(a));
  handle('burst:sync', () => true, () => { throw Object.assign(new Error('x'), { code: 'timeout' }); });
  handle('burst:async', () => true, async () => { throw new Error('plain'); });
  handle('burst:ok', () => true, async () => ({ data: 1 }));
  handle('burst:denied', () => false, async () => ({ data: 1 }));
  assert.deepEqual(await handlers['burst:sync']({}), { ok: false, reason: 'Burst did not answer in time.' });
  assert.deepEqual(await handlers['burst:async']({}), { ok: false, reason: 'Burst did not do that. Nothing was changed.' });
  assert.deepEqual(await handlers['burst:ok']({}), { ok: true, data: 1 });
  assert.equal(await handlers['burst:denied']({}), null, 'the sender check stays outside the contract: main answers null to the wrong page');
  assert.deepEqual(logs.map((l) => l[1]), ['burst:sync', 'burst:async']);
});
