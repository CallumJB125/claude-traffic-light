'use strict';
// Hostile tests for interaction:fanout ("Ask all"): each target goes through
// the same per-session send path, so every guard still applies per target.
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInteractionMain, CHANNELS } = require('../src/interaction-main');

function memAdapter(label) {
  const ee = new EventEmitter(); let n = 0; const calls = [];
  return {
    label, calls, capabilities: { newTurn: true, steer: false, interrupt: true },
    emit: (e) => ee.emit('e', e),
    open: async () => ({ target: `${label}-${++n}` }),
    async send(a) { calls.push(a); return { turnId: `turn-${calls.length}`, mode: 'new-turn' }; },
    interrupt: async () => true, release: async () => true, alive: () => true, stop() {},
    on: (fn) => { ee.on('e', fn); return () => ee.off('e', fn); },
  };
}
function harness() {
  const handlers = new Map();
  const contents = { id: 7, isDestroyed: () => false, send: () => {}, mainFrame: {} };
  let ctx = { contents, generation: 1, document: 1, foreground: true }, board = 'local';
  const a = memAdapter('A'), b = memAdapter('B');
  const main = createInteractionMain({ context: () => (ctx?.foreground ? ctx : null), readContext: () => ctx, adapters: { a, b }, owned: null, localModels: null, workspace: () => null, currentBoard: () => board });
  main.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  const own = { sender: contents, senderFrame: contents.mainFrame };
  const call = (ch, e, ...args) => handlers.get(ch)(e, ...args);
  const launch = async (p) => (await call(CHANNELS.launch, own, { provider: p })).state;
  const ref = (s) => ({ session: s.session, generation: s.generation });
  return { main, a, b, own, call, launch, ref, ctx: () => ctx, setCtx: (v) => { ctx = v; }, setBoard: (v) => { board = v; } };
}

test('Fan-out: one message reaches each chosen session through its own guarded send', async () => {
  const h = harness();
  try {
    const x = await h.launch('a'), y = await h.launch('b');
    const r = await h.call(CHANNELS.fanout, h.own, { sessions: [h.ref(x), h.ref(y)], text: '  nonce  ' });
    assert.equal(r.status, 'fanned-out'); assert.equal(r.ok, true);
    assert.deepEqual(r.results.map((t) => [t.session, t.status]), [[x.session, 'acknowledged'], [y.session, 'acknowledged']]);
    assert.equal(h.a.calls[0].text, 'nonce'); assert.equal(h.b.calls[0].text, 'nonce');
    assert.equal(h.a.calls[0].target, 'A-1'); assert.equal(h.b.calls[0].target, 'B-1');
    assert.equal(JSON.stringify(r).includes('A-1'), false, 'provider targets never cross IPC');
  } finally { h.main.close(); }
});

test('Fan-out hostile: wrong actor (other frame, unfocused, reloaded document) is refused without provider effect', async () => {
  const h = harness();
  try {
    const x = await h.launch('a');
    const req = { sessions: [h.ref(x)], text: 'hi' };
    assert.equal((await h.call(CHANNELS.fanout, { sender: {}, senderFrame: {} }, req)).status, 'forbidden');
    assert.equal((await h.call(CHANNELS.fanout, { sender: h.own.sender, senderFrame: {} }, req)).status, 'forbidden');
    h.setCtx({ ...h.ctx(), foreground: false });
    assert.equal((await h.call(CHANNELS.fanout, h.own, req)).status, 'forbidden');
    h.setCtx({ ...h.ctx(), foreground: true, document: 2 });
    const r = await h.call(CHANNELS.fanout, h.own, req);
    assert.equal(r.results[0].status, 'stale', 'old document\'s session was reaped');
    assert.equal(r.ok, false);
    assert.equal(h.a.calls.length, 0);
  } finally { h.main.close(); }
});

test('Fan-out hostile: duplicate sessions, empty, more than 6 targets, forged keys and malformed entries are invalid as a whole', async () => {
  const h = harness();
  try {
    const s = [];
    for (let i = 0; i < 7; i++) s.push(await h.launch(i % 2 ? 'b' : 'a'));
    const bad = [
      { sessions: [h.ref(s[0]), h.ref(s[0])], text: 'x' },
      { sessions: [h.ref(s[0]), { ...h.ref(s[0]), generation: 2 }], text: 'x' },
      { sessions: s.map(h.ref), text: 'x' },
      { sessions: [], text: 'x' },
      { sessions: [h.ref(s[0])], text: 'x', board: 'team:other' },
      { sessions: [h.ref(s[0])], text: 'x', actor: 'overview:7:1' },
      { sessions: [{ ...h.ref(s[0]), board: 'x' }], text: 'x' },
      { sessions: [{ ...h.ref(s[0]), expectedTurn: '10000000-0000-4000-8000-000000000001' }], text: 'x' },
      { sessions: [{ session: s[0].session, generation: '1' }], text: 'x' },
      { sessions: h.ref(s[0]), text: 'x' },
      { sessions: [h.ref(s[0])], text: 7 },
      null, 'x',
    ];
    for (const req of bad) assert.equal((await h.call(CHANNELS.fanout, h.own, req)).status, 'invalid', JSON.stringify(req));
    assert.equal(h.a.calls.length + h.b.calls.length, 0);
    const six = await h.call(CHANNELS.fanout, h.own, { sessions: s.slice(0, 6).map(h.ref), text: 'six' });
    assert.equal(six.results.filter((r) => r.status === 'acknowledged').length, 6, 'the cap is 6');
  } finally { h.main.close(); }
});

test('Fan-out hostile: one stale, busy, closed or forged target never blocks the others; text limits are unchanged', async () => {
  const h = harness();
  try {
    const x = await h.launch('a'), y = await h.launch('b'), z = await h.launch('a'), w = await h.launch('b');
    await h.call(CHANNELS.close, h.own, h.ref(z));
    await h.call(CHANNELS.send, h.own, { ...h.ref(w), text: 'first' }); // w now has an active turn: busy
    const r = await h.call(CHANNELS.fanout, h.own, { sessions: [{ ...h.ref(x), generation: 9 }, h.ref(y), h.ref(z), h.ref(w), { session: '10000000-0000-4000-8000-000000000099', generation: 1 }], text: 'go' });
    assert.deepEqual(r.results.map((t) => t.status), ['stale', 'acknowledged', 'stale', 'busy', 'stale']);
    assert.equal(r.ok, true);
    assert.equal(h.b.calls.filter((c) => c.text === 'go').length, 1);
    assert.equal(h.a.calls.length, 0);
    const big = await h.call(CHANNELS.fanout, h.own, { sessions: [h.ref(y)], text: 'a'.repeat(4001) });
    assert.equal(big.results[0].status, 'invalid');
    const nul = await h.call(CHANNELS.fanout, h.own, { sessions: [h.ref(y)], text: 'a\0b' });
    assert.equal(nul.results[0].status, 'invalid');
    // A board switch refuses every target with the board reason, without a provider effect.
    h.setBoard('team:x');
    const stale = await h.call(CHANNELS.fanout, h.own, { sessions: [h.ref(y)], text: 'later' });
    assert.equal(stale.results[0].status, 'stale'); assert.match(stale.results[0].error, /another board/);
    assert.equal(h.b.calls.filter((c) => c.text === 'later').length, 0);
  } finally { h.main.close(); }
});
