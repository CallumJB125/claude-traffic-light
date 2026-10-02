'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), { EventEmitter } = require('node:events');
const { createInteractionHub } = require('../src/session-interaction');
const { createCodexAppServer, APP_SERVER_ARGS } = require('../src/codex-app-server');
const { createInteractionMain, CHANNELS } = require('../src/interaction-main');

const ACTOR = 'overview:1:1';
const CURRENT = (b) => b === null;
const FAKE = path.join(__dirname, 'fixtures', 'fake-codex-app-server.js');
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

function memAdapter() {
  const ee = new EventEmitter(); let n = 0; const calls = [];
  return {
    label: 'Mem', calls, gate: null,
    capabilities: { newTurn: true, steer: true, interrupt: true, ack: 'turn-id', echo: 'client-message-id', stream: true, existingSessions: false },
    emit: (e) => ee.emit('e', e),
    open: async () => ({ target: `target-${++n}` }),
    async send(a) { calls.push(a); if (this.gate) await this.gate; return a.expectedTurnId ? { turnId: a.expectedTurnId, mode: 'steer' } : { turnId: `turn-${calls.length}`, mode: 'new-turn' }; },
    interrupt: async () => true, alive: () => true, stop() {},
    on: (fn) => { ee.on('e', fn); return () => ee.off('e', fn); },
  };
}
async function memHub(over = {}) {
  const adapter = memAdapter(), events = [];
  const hub = createInteractionHub({ adapters: { mem: adapter }, boardCurrent: CURRENT, onEvent: (actor, s) => events.push({ actor, s }), ...over });
  const a = (await hub.launch({ provider: 'mem' }, ACTOR)).state;
  return { hub, adapter, events, a, msg: (extra = {}) => ({ session: a.session, generation: a.generation, text: 'hello', ...extra }) };
}

// ── Integration through the real adapter code against a FAKE app-server process ──
test('FAKE app-server: message reaches the selected owned thread only, with ack, echo and streamed reply', async () => {
  const adapter = createCodexAppServer({ bin: FAKE });
  const events = [];
  const hub = createInteractionHub({ adapters: { codex: adapter }, boardCurrent: CURRENT, onEvent: (_a, s) => events.push(s) });
  try {
    const A = (await hub.launch({ provider: 'codex' }, ACTOR)).state, B = (await hub.launch({ provider: 'codex' }, ACTOR)).state;
    assert.equal(A.ownership, 'plexiform-owned'); assert.match(A.label, /Started by Plexiform/);
    assert.notEqual(hub.targetOf(A.session), hub.targetOf(B.session));
    const sent = await hub.send({ session: A.session, generation: A.generation, text: 'ping-A' }, ACTOR);
    assert.equal(sent.status, 'acknowledged'); assert.equal(sent.delivery.mode, 'new-turn');
    const done = await until(() => hub.state({ session: A.session }, ACTOR).deliveries.find((d) => d.state === 'completed'));
    assert.equal(done.recorded, true); assert.equal(done.response, 'echo:ping-A');
    assert.equal(hub.state({ session: B.session }, ACTOR).deliveries.length, 0);
    assert(!JSON.stringify(events).includes(hub.targetOf(A.session)), 'provider target never leaves main');
  } finally { hub.stopAll(); }
});
test('FAKE app-server: steer needs the current turn, new turn while busy is refused, interrupt ends the turn', async () => {
  const hub = createInteractionHub({ adapters: { codex: createCodexAppServer({ bin: FAKE }) }, boardCurrent: CURRENT });
  try {
    const A = (await hub.launch({ provider: 'codex' }, ACTOR)).state;
    const base = { session: A.session, generation: A.generation };
    await hub.send({ ...base, text: 'HOLD' }, ACTOR);
    const turn = (await until(() => hub.state({ session: A.session }, ACTOR).activeTurn));
    assert.equal((await hub.send({ ...base, text: 'second' }, ACTOR)).status, 'busy');
    const steer = await hub.send({ ...base, text: 'more', expectedTurn: turn }, ACTOR);
    assert.equal(steer.status, 'acknowledged'); assert.equal(steer.delivery.mode, 'steer');
    const done = await until(() => hub.state({ session: A.session }, ACTOR).deliveries.find((d) => d.mode === 'steer' && d.state === 'completed'));
    assert.equal(done.response, 'steered:more'); assert.equal(done.recorded, true);
    await hub.send({ ...base, text: 'HOLD again' }, ACTOR);
    const t2 = await until(() => hub.state({ session: A.session }, ACTOR).activeTurn);
    assert.equal((await hub.interrupt({ ...base, turn: t2 }, ACTOR)).status, 'interrupt-requested');
    await until(() => hub.state({ session: A.session }, ACTOR).deliveries.some((d) => d.state === 'interrupted'));
  } finally { hub.stopAll(); }
});
test('FAKE app-server: provider approval requests are refused, never auto-approved', async () => {
  const adapter = createCodexAppServer({ bin: FAKE }), seen = [];
  adapter.on((e) => seen.push(e));
  try {
    const { target } = await adapter.open({ cwd: '/tmp' });
    await adapter.send({ target, text: 'APPROVAL', clientId: 'c' });
    await until(() => seen.some((e) => e.kind === 'refused-request' && e.target === target));
  } finally { adapter.stop(); }
});
test('Owned Codex app-server disables plugins, MCP, hooks, computer/browser use and daemon auto-start', () => {
  for (const f of ['plugins', 'apps', 'hooks', 'computer_use', 'browser_use', 'memories', 'multi_agent', 'daemon_auto_start']) assert(APP_SERVER_ARGS.join(' ').includes(`--disable ${f}`), f);
  assert(APP_SERVER_ARGS.includes('mcp_servers={}'));
});

// ── Hostile boundaries ──
test('Hostile: wrong or unknown session id is refused without provider effect', async () => {
  const x = await memHub();
  assert.equal((await x.hub.send(x.msg({ session: '00000000-0000-4000-8000-000000000000' }), ACTOR)).status, 'stale');
  assert.equal((await x.hub.send(x.msg({ session: 'not-a-uuid' }), ACTOR)).status, 'invalid');
  assert.equal((await x.hub.send(x.msg({ target: 'target-1' }), ACTOR)).status, 'invalid');
  assert.equal(x.adapter.calls.length, 0);
});
test('Hostile: forged actor cannot send, read, steer, interrupt or close another document\'s session', async () => {
  const x = await memHub();
  assert.equal((await x.hub.send(x.msg(), 'overview:2:1')).status, 'forbidden');
  assert.equal((await x.hub.send(x.msg(), undefined)).status, 'forbidden');
  assert.equal(x.hub.state({ session: x.a.session }, 'overview:1:2'), null);
  assert.deepEqual(x.hub.list('overview:9:9'), []);
  assert.equal((await x.hub.close({ session: x.a.session, generation: 1 }, 'overview:2:1')).status, 'forbidden');
  assert.equal(x.adapter.calls.length, 0);
});
test('Hostile: target replacement retires the old generation, including an ack that lands after it', async () => {
  const x = await memHub();
  let release; x.adapter.gate = new Promise((r) => { release = r; });
  const pending = x.hub.send(x.msg(), ACTOR);
  await new Promise((r) => setImmediate(r));
  await x.hub.replaceTarget(x.a.session);
  release();
  assert.equal((await pending).status, 'stale');
  assert.equal(x.hub.state({ session: x.a.session }, ACTOR).deliveries.length, 0, 'replacement clears the old deliveries');
  x.adapter.gate = null;
  assert.equal((await x.hub.send(x.msg(), ACTOR)).status, 'stale');
  assert.equal((await x.hub.send(x.msg({ generation: 2 }), ACTOR)).status, 'acknowledged');
  assert.equal(x.adapter.calls.at(-1).target, 'target-2');
});
test('Hostile: replaced turn cannot be steered or interrupted', async () => {
  const x = await memHub();
  await x.hub.send(x.msg(), ACTOR);
  x.adapter.emit({ kind: 'turn-started', target: 'target-1', turnId: 'turn-1' });
  const old = x.hub.state({ session: x.a.session }, ACTOR).activeTurn;
  x.adapter.emit({ kind: 'turn-completed', target: 'target-1', turnId: 'turn-1', status: 'completed' });
  x.adapter.emit({ kind: 'turn-started', target: 'target-1', turnId: 'foreign-turn' });
  const calls = x.adapter.calls.length;
  assert.equal((await x.hub.send(x.msg({ expectedTurn: old }), ACTOR)).status, 'stale');
  assert.equal((await x.hub.interrupt({ session: x.a.session, generation: 1, turn: old }, ACTOR)).status, 'stale');
  assert.equal((await x.hub.send(x.msg({ expectedTurn: '00000000-0000-4000-8000-000000000000' }), ACTOR)).status, 'stale');
  assert.equal((await x.hub.send(x.msg(), ACTOR)).status, 'busy');
  assert.equal(x.adapter.calls.length, calls);
});
test('Hostile: steer ack for a different turn than expected is refused', async () => {
  const x = await memHub();
  await x.hub.send(x.msg(), ACTOR);
  x.adapter.emit({ kind: 'turn-started', target: 'target-1', turnId: 'turn-1' });
  const turn = x.hub.state({ session: x.a.session }, ACTOR).activeTurn;
  x.adapter.send = async () => ({ turnId: 'turn-other', mode: 'steer' });
  assert.equal((await x.hub.send(x.msg({ expectedTurn: turn }), ACTOR)).status, 'stale');
});
test('Hostile: board replacement or a board that is no longer current is refused', async () => {
  let current = true;
  const adapter = memAdapter(), hub = createInteractionHub({ adapters: { mem: adapter }, boardCurrent: (b) => current && b === 'board-1' });
  const a = (await hub.launch({ provider: 'mem', board: 'board-1' }, ACTOR)).state;
  const base = { session: a.session, generation: a.generation, text: 'hi' };
  assert.equal((await hub.send({ ...base, board: 'board-2' }, ACTOR)).status, 'stale');
  assert.equal((await hub.send(base, ACTOR)).status, 'stale');
  current = false;
  assert.equal((await hub.send({ ...base, board: 'board-1' }, ACTOR)).status, 'stale');
  assert.equal(adapter.calls.length, 0);
  current = true;
  assert.equal((await hub.send({ ...base, board: 'board-1' }, ACTOR)).status, 'acknowledged');
});
test('Hostile: read-only status, foreign turns and other targets never masquerade as delivery', async () => {
  const x = await memHub();
  const b = (await x.hub.launch({ provider: 'mem' }, ACTOR)).state;
  x.adapter.send = async () => { throw new Error('provider refused'); };
  assert.equal((await x.hub.send(x.msg(), ACTOR)).status, 'unavailable');
  for (const e of [{ kind: 'status', target: 'target-1', status: 'active' }, { kind: 'turn-started', target: 'target-1', turnId: 'turn-x' },
    { kind: 'message', target: 'target-1', turnId: 'turn-x', text: 'not ours' }, { kind: 'turn-completed', target: 'target-1', turnId: 'turn-x', status: 'completed' },
    { kind: 'input-recorded', target: 'target-1', turnId: 'turn-x', clientId: 'forged', text: 'hello' }]) x.adapter.emit(e);
  const d = x.hub.state({ session: x.a.session }, ACTOR).deliveries[0];
  assert.equal(d.state, 'refused'); assert.equal(d.recorded, false); assert.equal(d.response, '');
  // B's acknowledged turn is not advanced by A-target events carrying B's turn id.
  x.adapter.send = memAdapter().send.bind({ calls: [], gate: null });
  await x.hub.send({ session: b.session, generation: b.generation, text: 'to B' }, ACTOR);
  x.adapter.emit({ kind: 'message', target: 'target-1', turnId: 'turn-1', text: 'spoofed reply' });
  x.adapter.emit({ kind: 'turn-completed', target: 'target-1', turnId: 'turn-1', status: 'completed' });
  const bd = x.hub.state({ session: b.session }, ACTOR).deliveries[0];
  assert.equal(bd.state, 'acknowledged'); assert.equal(bd.response, '');
  // Echo with the wrong client id is not "recorded".
  x.adapter.emit({ kind: 'input-recorded', target: 'target-2', turnId: 'turn-1', clientId: 'forged', text: 'to B' });
  assert.equal(x.hub.state({ session: b.session }, ACTOR).deliveries[0].recorded, false);
});
test('Hostile: provider exit ends the session and fails unfinished deliveries', async () => {
  const x = await memHub();
  await x.hub.send(x.msg(), ACTOR);
  x.adapter.emit({ kind: 'exit' });
  const s = x.hub.state({ session: x.a.session }, ACTOR);
  assert.equal(s.status, 'ended'); assert.equal(s.deliveries[0].state, 'failed');
  assert.equal((await x.hub.send(x.msg(), ACTOR)).status, 'stale');
});
test('Hostile: malformed text and launch requests are invalid', async () => {
  const x = await memHub();
  for (const text of ['', '   ', 'a\0b', 'x'.repeat(4001), '😀'.repeat(2049)]) assert.equal((await x.hub.send(x.msg({ text }), ACTOR)).status, 'invalid');
  assert.equal((await x.hub.send(x.msg({ text: new String('hi') }), ACTOR)).status, 'invalid');
  assert.equal((await x.hub.launch({ provider: 'mem', cwd: '/etc' }, ACTOR)).status, 'invalid');
  assert.equal((await x.hub.launch({ provider: 'toString' }, ACTOR)).status, 'invalid');
  assert.equal(x.adapter.calls.length, 0);
});

// ── IPC boundary ──
function ipcHarness() {
  const handlers = new Map(), sent = [];
  const contents = { id: 7, isDestroyed: () => false, send: (ch, s) => sent.push({ ch, s }) };
  contents.mainFrame = {};
  let ctx = { contents, generation: 3, foreground: true };
  const main = createInteractionMain({ context: () => (ctx?.foreground ? ctx : null), readContext: () => ctx, adapters: { mem: memAdapter() }, workspace: () => null, boardCurrent: CURRENT });
  main.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  const call = (ch, e, ...a) => handlers.get(ch)(e, ...a);
  return { main, call, sent, contents, own: { sender: contents, senderFrame: contents.mainFrame }, setCtx: (v) => { ctx = v; } };
}
test('IPC: only the exact foreground Overview frame may launch/send; pushes go only to the owner', async () => {
  const h = ipcHarness();
  assert.equal((await h.call(CHANNELS.launch, { sender: {}, senderFrame: {} }, { provider: 'mem' })).status, 'forbidden');
  assert.equal((await h.call(CHANNELS.launch, { sender: h.contents, senderFrame: {} }, { provider: 'mem' })).status, 'forbidden');
  const a = (await h.call(CHANNELS.launch, h.own, { provider: 'mem' })).state;
  assert.equal((await h.call(CHANNELS.send, h.own, { session: a.session, generation: a.generation, text: 'hi' })).status, 'acknowledged');
  assert(h.sent.every((m) => m.ch === CHANNELS.event) && h.sent.length > 0);
  h.setCtx({ contents: h.contents, generation: 3, foreground: false });
  assert.equal((await h.call(CHANNELS.send, h.own, { session: a.session, generation: a.generation, text: 'hi' })).status, 'forbidden');
  assert.equal((await h.call(CHANNELS.list, h.own)).length, 1, 'passive read still works while unfocused');
  h.setCtx({ contents: h.contents, generation: 4, foreground: true });
  assert.equal((await h.call(CHANNELS.send, h.own, { session: a.session, generation: a.generation, text: 'hi' })).status, 'stale', 'reloaded document: the old actor\'s session is reaped');
  assert.equal(h.main.documents(), 1);
  assert.equal((await h.call(CHANNELS.list, h.own)).length, 0);
  h.main.close();
});

// ── Review fixes: default refusal, in-flight lock, close, reaping, sandbox ──
test('Review: without a real board check every launch and send is refused', async () => {
  const adapter = memAdapter(), hub = createInteractionHub({ adapters: { mem: adapter } });
  assert.equal((await hub.launch({ provider: 'mem' }, ACTOR)).status, 'stale');
  assert.equal((await hub.launch({ provider: 'mem', board: 'anything' }, ACTOR)).status, 'stale');
  assert.equal(hub.list(ACTOR).length, 0);
  const throwing = createInteractionHub({ adapters: { mem: adapter }, boardCurrent: () => { throw new Error('x'); } });
  assert.equal((await throwing.launch({ provider: 'mem' }, ACTOR)).status, 'stale');
});
test('Review: two concurrent new-turn sends — the second is busy and reaches no provider', async () => {
  const x = await memHub();
  let release; x.adapter.gate = new Promise((r) => { release = r; });
  const first = x.hub.send(x.msg({ text: 'one' }), ACTOR);
  await new Promise((r) => setImmediate(r));
  assert.equal((await x.hub.send(x.msg({ text: 'two' }), ACTOR)).status, 'busy');
  release();
  assert.equal((await first).status, 'acknowledged');
  assert.equal(x.adapter.calls.length, 1);
});
test('Review: close interrupts the active turn and releases the provider thread', async () => {
  const x = await memHub();
  const interrupted = [], released = [];
  x.adapter.interrupt = async (a) => { interrupted.push(a); return true; };
  x.adapter.release = async (a) => { released.push(a); return true; };
  await x.hub.send(x.msg(), ACTOR);
  x.adapter.emit({ kind: 'turn-started', target: 'target-1', turnId: 'turn-1' });
  assert.equal((await x.hub.close({ session: x.a.session, generation: 1 }, ACTOR)).status, 'closed');
  assert.deepEqual(interrupted, [{ target: 'target-1', turnId: 'turn-1' }]);
  assert.deepEqual(released, [{ target: 'target-1' }]);
  assert.equal(x.hub.list(ACTOR).length, 0);
});
test('Review: close during a send never reports the old ack as delivered and stops the turn it started', async () => {
  const x = await memHub();
  const interrupted = [];
  x.adapter.interrupt = async (a) => { interrupted.push(a); return true; };
  let release; x.adapter.gate = new Promise((r) => { release = r; });
  const pending = x.hub.send(x.msg(), ACTOR);
  await new Promise((r) => setImmediate(r));
  await x.hub.close({ session: x.a.session, generation: 1 }, ACTOR);
  release();
  const res = await pending;
  assert.equal(res.status, 'stale');
  assert.deepEqual(interrupted, [{ target: 'target-1', turnId: 'turn-1' }]);
});
test('Review: a new Overview document reaps the old one\'s sessions and frees their slots', async () => {
  const h = ipcHarness();
  const stopped = [];
  for (let i = 0; i < 8; i++) assert.equal((await h.call(CHANNELS.launch, h.own, { provider: 'mem' })).status, 'launched');
  assert.equal((await h.call(CHANNELS.launch, h.own, { provider: 'mem' })).status, 'unavailable', 'slots full');
  h.setCtx({ contents: h.contents, generation: 4, foreground: true });
  assert.equal((await h.call(CHANNELS.launch, h.own, { provider: 'mem' })).status, 'launched', 'old document reaped, slot free');
  assert.equal(h.main.documents(), 1);
  assert.equal((await h.call(CHANNELS.list, h.own)).length, 1);
  h.main.close(); void stopped;
});
test('Review: refused provider approvals are shown to the user as a notice', async () => {
  const x = await memHub();
  await x.hub.send(x.msg(), ACTOR);
  x.adapter.emit({ kind: 'turn-started', target: 'target-1', turnId: 'turn-1' });
  x.adapter.emit({ kind: 'refused-request', target: 'target-1', turnId: 'turn-1' });
  const d = x.hub.state({ session: x.a.session }, ACTOR).deliveries[0];
  assert.equal(d.notices.length, 1); assert.match(d.notices[0], /refused/i);
});
test('Review: owned Codex has no shell, exec, file-viewing or user-config reach', () => {
  const args = APP_SERVER_ARGS.join(' ');
  for (const f of ['shell_tool', 'unified_exec', 'view_image', 'skill_search', 'shell_snapshot']) assert(args.includes(`--disable ${f}`), f);
  for (const c of ['model_provider="openai"', 'shell_environment_policy.inherit="none"', 'projects={}', 'plugins={}']) assert(APP_SERVER_ARGS.includes(c), c);
});
