'use strict';
// Overview owned-session UI driven through the real preload bridge, the real
// interaction IPC (interaction-main) and the real hub, with an in-memory
// provider adapter standing in for Codex.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { createInteractionMain, CHANNELS } = require('../src/interaction-main');
const { createOverviewService } = require('../src/overview-service');
const html = fs.readFileSync(path.join(__dirname, '../overview.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../overview.js'), 'utf8');
const bridge = fs.readFileSync(path.join(__dirname, '../overview-preload.js'), 'utf8');
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const ALLOWED = new Set(['overview:state', 'overview:open', 'overview:message', ...Object.values(CHANNELS).filter((c) => c !== CHANNELS.event)]);
const U = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function memAdapter() {
  const ee = new EventEmitter(); const calls = [];
  return {
    label: 'Codex', calls,
    capabilities: { newTurn: true, steer: true, interrupt: true, ack: 'turn-id', echo: 'client-message-id', stream: true, existingSessions: false },
    emit: (e) => ee.emit('e', e),
    open: async () => ({ target: 'target-1' }),
    async send(a) { calls.push(a); return a.expectedTurnId ? { turnId: a.expectedTurnId, mode: 'steer' } : { turnId: `turn-${calls.length}`, mode: 'new-turn' }; },
    interrupt: async () => true, release: async () => true, alive: () => true, stop() {},
    on: (fn) => { ee.on('e', fn); return () => ee.off('e', fn); },
  };
}
function loadBridge(ipcRenderer) {
  let api, exposed = 0;
  vm.runInNewContext(bridge, { Buffer, Promise, require: (name) => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(name, value) { exposed++; assert.equal(name, 'overviewApi'); api = value; } }, ipcRenderer }; } });
  assert.equal(exposed, 1, 'one narrow global only');
  return api;
}
function stack({ snapshot = { schema: 1, status: 'complete', observed_at: Date.now(), omitted: 0, sessions: [] } } = {}) {
  const handlers = new Map(), listeners = new Map(), invoked = [];
  const contents = { id: 9, isDestroyed: () => false, mainFrame: {}, send: (ch, s) => { for (const fn of listeners.get(ch) ?? []) fn({ sender: 'private-event' }, structuredClone(s)); } };
  const ctx = { contents, generation: 1, document: 1, foreground: true };
  let board = 'local', readable = true;
  const adapter = memAdapter();
  const main = createInteractionMain({ context: () => (ctx.foreground ? ctx : null), readContext: () => (readable ? ctx : null), adapters: { codex: adapter }, workspace: () => null, currentBoard: () => board });
  main.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  const api = loadBridge({
    invoke: (ch, ...args) => { invoked.push(ch); if (ch === 'overview:state') return Promise.resolve(snapshot); return Promise.resolve(handlers.get(ch)({ sender: contents, senderFrame: contents.mainFrame }, ...structuredClone(args))); },
    on: (ch, fn) => { if (!listeners.has(ch)) listeners.set(ch, new Set()); listeners.get(ch).add(fn); },
    removeListener: (ch, fn) => listeners.get(ch)?.delete(fn),
  });
  let ready;
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const intervals = [];
  dom.window.setInterval = (fn) => intervals.push(fn);
  dom.window.overviewApi = { ...api, onReady: (fn) => { ready = fn; return () => {}; } };
  dom.window.eval(script);
  const doc = dom.window.document;
  const card = () => doc.querySelector('.owned-session');
  const btn = (label) => [...(card()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);
  return {
    dom, doc, adapter, ctx, main, invoked, card, btn,
    ready: async () => { ready(); await tick(); },
    poll: async () => { for (const fn of intervals) fn(); await tick(); },
    type: (value) => { const t = card().querySelector('textarea'); t.value = value; t.dispatchEvent(new dom.window.Event('input')); return t; },
    setBoard: (b) => { board = b; }, setReadable: (v) => { readable = v; },
    close: () => { main.close(); dom.window.close(); },
  };
}

test('Owned UI: start, send a literal message and see ack → recorded → responding → completed live', async () => {
  const s = stack();
  try {
    await s.ready();
    const start = s.doc.getElementById('start-codex');
    assert.equal(s.doc.getElementById('owned-section').hidden, false);
    assert.equal(start.disabled, false);
    start.click(); await tick();
    assert.match(s.card().textContent, /Started by Plexiform · Codex/);
    assert.equal(s.doc.activeElement, s.card().querySelector('textarea'), 'new session is selected for typing');
    s.type('  ping <b>nonce</b>  ');
    s.btn('Send').click(); await tick();
    assert.equal(s.adapter.calls.length, 1); assert.equal(s.adapter.calls[0].text, 'ping <b>nonce</b>', 'literal text, trimmed');
    assert.match(s.card().textContent, /Acknowledged by Codex/);
    assert.match(s.card().textContent, /Delivered: Codex acknowledged this message/);
    assert.equal(s.card().querySelector('.delivery-text b'), null, 'user text is not markup');

    // Draft and focus survive pushes.
    const box = s.type('draft in progress'); box.focus();
    s.adapter.emit({ kind: 'turn-started', target: 'target-1', turnId: 'turn-1' }); await tick();
    assert.match(s.card().querySelector('.tag').textContent, /Working/);
    assert.equal(s.btn('Send').disabled, true); assert.equal(s.btn('Steer current turn').disabled, false); assert.equal(s.btn('Interrupt').disabled, false);
    s.adapter.emit({ kind: 'input-recorded', target: 'target-1', turnId: 'turn-1', clientId: s.adapter.calls[0].clientId, text: 'ping <b>nonce</b>' }); await tick();
    assert.match(s.card().textContent, /Recorded by Codex/);
    s.adapter.emit({ kind: 'delta', target: 'target-1', turnId: 'turn-1', text: '<img src=x onerror="globalThis.pwned=1">PONG' }); await tick();
    assert.match(s.card().textContent, /Responding…/);
    assert.equal(s.card().querySelector('.delivery-response').textContent, '<img src=x onerror="globalThis.pwned=1">PONG');
    assert.equal(s.doc.querySelector('img'), null, 'response is text, never markup');
    s.adapter.emit({ kind: 'refused-request', target: 'target-1', turnId: 'turn-1' }); await tick();
    assert.match(s.card().textContent, /asked for an approval; Plexiform refused it/);
    s.adapter.emit({ kind: 'turn-completed', target: 'target-1', turnId: 'turn-1', status: 'completed' }); await tick();
    assert.match(s.card().textContent, /Completed/);
    assert.equal(s.btn('Send').disabled, false);
    assert.equal(s.doc.activeElement, box); assert.equal(box.value, 'draft in progress');
    for (const ch of s.invoked) assert(ALLOWED.has(ch), ch);
  } finally { s.close(); }
});

test('Owned UI: focus changes keep the session; a stale board refusal is shown with its reason', async () => {
  const s = stack();
  try {
    await s.ready();
    s.doc.getElementById('start-codex').click(); await tick();
    // Window blur/refocus bumps Buddy's generation; ownership follows the document.
    s.ctx.generation += 5;
    s.type('one'); s.btn('Send').click(); await tick();
    assert.equal(s.adapter.calls.length, 1, 'refocused page can still send');
    s.adapter.emit({ kind: 'turn-completed', target: 'target-1', turnId: 'turn-1', status: 'completed' }); await tick();
    s.setBoard('team:example:t1');
    s.type('two'); s.btn('Send').click(); await tick();
    assert.equal(s.adapter.calls.length, 1, 'no provider effect for a stale board');
    assert.match(s.card().textContent, /Refused: stale\. This session belongs to another board/);
    assert.equal(s.card().querySelector('textarea').value, 'two', 'refused draft is kept');
    s.setBoard('local');
    s.btn('Send').click(); await tick();
    assert.equal(s.adapter.calls.length, 2);
  } finally { s.close(); }
});

test('Owned UI: rows never vanish — unreadable state keeps the card; a reloaded document reaps it and the card shows Ended', async () => {
  const s = stack();
  try {
    await s.ready();
    s.doc.getElementById('start-codex').click(); await tick();
    s.type('hello'); s.btn('Send').click(); await tick();
    s.setReadable(false); await s.poll();
    assert.ok(s.card(), 'card kept when state cannot be read');
    assert.match(s.doc.getElementById('owned-status').textContent, /Showing the last known state/);
    s.setReadable(true);
    s.ctx.document = 2; // a new document of the same contents: the old actor is reaped
    await s.poll();
    assert.ok(s.card(), 'card kept after its session is gone');
    assert.match(s.card().querySelector('.tag').textContent, /Ended/);
    assert.match(s.card().textContent, /hello/, 'last known messages stay readable');
    assert.equal(s.btn('Send').disabled, true);
    assert.equal(s.card().querySelector('textarea').disabled, true);
    s.btn('Dismiss').click();
    assert.equal(s.card(), null);
    assert.match(s.doc.getElementById('owned').textContent, /No Plexiform sessions/);
  } finally { s.close(); }
});

test('Owned UI: close removes the card; unavailable Codex disables Start with its reason', async () => {
  const s = stack();
  try {
    await s.ready();
    s.doc.getElementById('start-codex').click(); await tick();
    s.btn('Close session').click(); await tick();
    assert.equal(s.card(), null);
    assert.match(s.doc.getElementById('owned-status').textContent, /Session closed/);
  } finally { s.close(); }
  const u = stack();
  try {
    u.adapter.available = false; u.adapter.reason = 'Codex CLI not found';
    await u.ready();
    const start = u.doc.getElementById('start-codex');
    assert.equal(start.disabled, true); assert.equal(start.title, 'Codex CLI not found');
    assert.match(u.doc.getElementById('owned-status').textContent, /Codex unavailable: Codex CLI not found/);
  } finally { u.close(); }
});

test('Bridge: interaction calls are closed primitive projections; forged board/actor/provider never reach IPC', async () => {
  const calls = [], subscriptions = [];
  const api = loadBridge({ invoke: (...a) => { calls.push(a); return Promise.resolve({ ok: true }); }, on: (ch, fn) => subscriptions.push([ch, fn]), removeListener: () => {} });
  const ix = api.interaction;
  await ix.list(); await ix.capabilities(); await ix.state({ session: U(1) });
  await ix.launch({ provider: 'codex' });
  await ix.send({ session: U(1), generation: 1, text: ' hi ' });
  await ix.send({ session: U(1), generation: 1, text: 'steer', expectedTurn: U(2) });
  await ix.interrupt({ session: U(1), generation: 1, turn: U(2) });
  await ix.close({ session: U(1), generation: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['interaction:list'], ['interaction:capabilities'], ['interaction:state', { session: U(1) }], ['interaction:launch', { provider: 'codex' }],
    ['interaction:send', { session: U(1), generation: 1, text: 'hi' }], ['interaction:send', { session: U(1), generation: 1, text: 'steer', expectedTurn: U(2) }],
    ['interaction:interrupt', { session: U(1), generation: 1, turn: U(2) }], ['interaction:close', { session: U(1), generation: 1 }]]);
  const before = calls.length;
  for (const r of [{ provider: 'codex', board: 'b' }, { provider: 'claude' }, { provider: 'codex', actor: 'x' }, null]) assert.equal((await ix.launch(r)).status, 'invalid');
  for (const r of [{ session: U(1), generation: 1, text: 'x', board: 'b' }, { session: U(1), generation: 1, text: 'x', actor: 'overview:1:1' }, { session: 'x', generation: 1, text: 'x' }, { session: U(1), generation: '1', text: 'x' }, { session: U(1), generation: 1, text: 'x', expectedTurn: 'turn-1' }, { session: U(1), generation: 1, text: ' ' }, { session: U(1), generation: 1, text: 'a\0b' }, { session: U(1), generation: 1, text: 'a'.repeat(4001) }]) assert.equal((await ix.send(r)).status, 'invalid');
  assert.equal((await ix.interrupt({ session: U(1), generation: 1 })).status, 'invalid');
  assert.equal((await ix.close({ session: U(1), generation: 1, target: 't' })).status, 'invalid');
  assert.equal(await ix.state({ session: U(1), actor: 'x' }), null);
  assert.equal(calls.length, before, 'nothing forged reached IPC');
  let got = []; const off = ix.onEvent((...a) => got.push(a));
  assert.equal(subscriptions.length, 1); assert.equal(subscriptions[0][0], 'interaction:event');
  subscriptions[0][1]({ sender: 'private' }, { session: U(1) }, 'extra'); subscriptions[0][1]({ sender: 'private' }, 'string');
  subscriptions[0][1]({ sender: 'private' }, { session: U(1) });
  assert.deepEqual(got, [[{ session: U(1) }]], 'only the single state object, never the IPC event');
  assert.equal(typeof off, 'function'); assert.equal(typeof ix.onEvent(null), 'function'); assert.equal(subscriptions.length, 1);
  assert.equal(api.interaction.adopt, undefined);
});

test('Unmanaged Codex parent keeps Message disabled with the exact reason, even when stale', async () => {
  const time = Date.parse('2026-10-02T10:00:00Z');
  const raw = { sessionId: 'private-session', source: 'codex', signal: 'tool-use', codexLifecycle: 1, codexClosedTurn: false, codexTurnId: 'turn', codexHookAt: new Date(time - 10).toISOString(), updatedAt: new Date(time - 10).toISOString(), cwd: '/Users/private/project' };
  const svc = createOverviewService({ sessions: () => [raw], work: async () => ({ sources: [], capture: [] }), current: () => true, now: () => time });
  const snap = await svc.snapshot();
  const msg = snap.sessions[0].capabilities.message;
  assert.equal(msg.enabled, false);
  assert.match(msg.reason, /Not started by Plexiform\. Codex offers no supported message channel.*opt-in.*shared Codex daemon/);
  snap.observed_at = Date.now() - 200_000; // stale on the page
  const s = stack({ snapshot: snap });
  try {
    await s.ready();
    const button = [...s.doc.querySelectorAll('#content button')].find((b) => b.textContent === 'Message');
    assert.equal(button.disabled, true);
    assert.match(s.doc.getElementById('content').textContent, /shared Codex daemon/);
  } finally { s.close(); }
});
