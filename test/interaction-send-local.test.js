'use strict';
// Hostile tests for sendLocal (Sessions page "Message" on a Plexiform-owned
// session): it resolves the owning document and generation in main and then
// goes through the same guarded send as the Overview card.
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInteractionMain, CHANNELS } = require('../src/interaction-main');

function memAdapter(label, extra = {}) {
  const ee = new EventEmitter(); let n = 0; const calls = [];
  return {
    label, calls, capabilities: { newTurn: true, steer: false, interrupt: true },
    open: async () => ({ target: `${label}-${++n}` }),
    async send(a) { calls.push(a); return { turnId: `turn-${calls.length}`, mode: 'new-turn' }; },
    interrupt: async () => true, release: async () => true, alive: () => true, stop() {},
    on: (fn) => { ee.on('e', fn); return () => ee.off('e', fn); },
    ...extra,
  };
}
function harness(extra = {}) {
  const handlers = new Map();
  const contents = { id: 7, isDestroyed: () => false, send: () => {}, mainFrame: {} };
  let ctx = { contents, generation: 1, document: 1, foreground: true }, board = 'local';
  const a = memAdapter('A');
  const main = createInteractionMain({ context: () => (ctx?.foreground ? ctx : null), readContext: () => ctx, adapters: { a, ...extra }, owned: null, localModels: null, workspace: () => null, currentBoard: () => board });
  main.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  const own = { sender: contents, senderFrame: contents.mainFrame };
  const call = (ch, ...args) => handlers.get(ch)(own, ...args);
  const launch = async () => (await call(CHANNELS.launch, { provider: 'a' })).state;
  return { main, a, call, launch, ctx: () => ctx, setCtx: (v) => { ctx = v; }, setBoard: (v) => { board = v; } };
}

test('sendLocal: an owned session gets the message through the guarded send at its current generation', async () => {
  const h = harness();
  try {
    const s = await h.launch();
    // The Sessions page may be focused: the Overview window does not have to be foreground.
    h.setCtx({ ...h.ctx(), foreground: false });
    const r = await h.main.sendLocal(s.session, 'hello');
    assert.deepEqual(r, { ok: true, status: 'acknowledged', error: null });
    assert.equal(h.a.calls.length, 1); assert.equal(h.a.calls[0].text, 'hello'); assert.equal(h.a.calls[0].target, 'A-1');
    assert.equal(JSON.stringify(r).includes('A-1'), false, 'provider targets never cross IPC');
  } finally { h.main.close(); }
});

test('sendLocal hostile: busy turn is refused, not steered', async () => {
  const h = harness();
  try {
    const s = await h.launch();
    assert.equal((await h.main.sendLocal(s.session, 'first')).ok, true);
    const r = await h.main.sendLocal(s.session, 'second');
    assert.equal(r.ok, false); assert.equal(r.status, 'busy'); assert.ok(r.error);
    assert.equal(h.a.calls.length, 1);
  } finally { h.main.close(); }
});

test('sendLocal hostile: board switch, closed session and unknown or reaped session are stale without provider effect', async () => {
  const h = harness();
  try {
    const s = await h.launch(), t = await h.launch();
    h.setBoard('team:x');
    const board = await h.main.sendLocal(s.session, 'x');
    assert.equal(board.status, 'stale'); assert.match(board.error, /another board/);
    h.setBoard('local');
    await h.call(CHANNELS.close, { session: t.session, generation: t.generation });
    assert.equal((await h.main.sendLocal(t.session, 'x')).status, 'stale');
    assert.equal((await h.main.sendLocal('10000000-0000-4000-8000-000000000099', 'x')).status, 'stale');
    await h.main.retireDocuments();
    assert.equal((await h.main.sendLocal(s.session, 'x')).status, 'stale');
    assert.equal(h.a.calls.length, 0);
  } finally { h.main.close(); }
});

test('sendLocal hostile: malformed session or text is invalid', async () => {
  const h = harness();
  try {
    const s = await h.launch();
    for (const [session, text] of [[null, 'x'], [7, 'x'], ['not-a-uuid', 'x'], [s.session, ''], [s.session, '   '], [s.session, 'a'.repeat(501)], [s.session, 7], [s.session, undefined]]) {
      assert.equal((await h.main.sendLocal(session, text)).status, 'invalid', JSON.stringify([session, text]));
    }
    assert.equal((await h.main.sendLocal(s.session, 'a\0b')).status, 'invalid');
    assert.equal(h.a.calls.length, 0);
  } finally { h.main.close(); }
});

test('sendLocal hostile: a session started outside Plexiform (attached) is never messaged from here', async () => {
  const ee = new EventEmitter(), sent = [];
  const daemon = {
    label: 'Codex CLI', capabilities: { newTurn: true, steer: true, interrupt: true, existingSessions: true, startSessions: false },
    discover: async () => [{ id: 'thread-x', title: 'mine', project: '/tmp/p', status: 'idle' }],
    attach: async ({ target }) => ({ target, status: 'idle', permissions: { approvalPolicy: 'never', sandbox: 'dangerFullAccess' } }),
    send: async (m) => { sent.push(m); return { turnId: 't1', mode: 'new-turn' }; }, interrupt: async () => true, release: async () => true, alive: () => true, stop() {},
    on: (fn) => { ee.on('e', fn); return () => ee.off('e', fn); },
  };
  const h = harness({ 'codex-daemon': daemon });
  try {
    const found = await h.call(CHANNELS.discover, { provider: 'codex-daemon' });
    const attached = await h.call(CHANNELS.attach, { provider: 'codex-daemon', handle: found.threads[0].handle });
    assert.equal(attached.state.ownership, 'existing-unmanaged');
    const r = await h.main.sendLocal(attached.state.session, 'x');
    assert.equal(r.ok, false); assert.equal(r.status, 'stale');
    assert.equal(sent.length, 0);
  } finally { h.main.close(); }
});
