'use strict';
// Overview "Share…" on an owned-session card, driven through the real
// preload bridge, the real interaction IPC (interaction-main) and hub, with
// an in-memory provider adapter and a stand-in remote host (the hub side is
// proved in board/hub/test/interaction-shares.test.js).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { createInteractionMain } = require('../src/interaction-main');
const html = fs.readFileSync(path.join(__dirname, '../overview.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../overview.js'), 'utf8');
const shareScript = fs.readFileSync(path.join(__dirname, '../overview-share.js'), 'utf8');
const bridge = fs.readFileSync(path.join(__dirname, '../overview-preload.js'), 'utf8');
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function memAdapter() {
  const ee = new EventEmitter(); const calls = [];
  return {
    label: 'Codex', calls,
    capabilities: { newTurn: true, steer: true, interrupt: true, ack: 'turn-id', echo: 'client-message-id', stream: true, existingSessions: false },
    open: async () => ({ target: 'target-1' }),
    async send(a) { calls.push(a); return { turnId: `turn-${calls.length}`, mode: 'new-turn' }; },
    interrupt: async () => true, release: async () => true, alive: () => true, stop() {},
    on: (fn) => { ee.on('e', fn); return () => ee.off('e', fn); },
  };
}

function fakeHost() {
  const shares = new Map(); const calls = [];
  return {
    calls, shares,
    async listShares() { calls.push(['list']); return { ok: true, teams: [{ id: 'team-1', name: 'Dev team' }], shares: [...shares.values()] }; },
    async shareSession(req) { calls.push(['share', req]); const s = { id: `share-${shares.size + 1}`, session: req.session, team: { id: req.team, name: 'Dev team' }, scope: req.scope, expiresAt: req.expiresInS ? Date.now() + req.expiresInS * 1000 : null, members: [{ id: 'u-bob', name: 'Bob' }] }; shares.set(s.id, s); return { ok: true, share: s }; },
    stopSharing(id) { calls.push(['stop', id]); shares.delete(id); return { ok: true }; },
    shared: () => [...shares.values()],
  };
}

function stack({ host = fakeHost() } = {}) {
  const handlers = new Map(), listeners = new Map();
  const contents = { id: 9, isDestroyed: () => false, mainFrame: {}, send: (ch, s) => { for (const fn of listeners.get(ch) ?? []) fn({}, structuredClone(s)); } };
  const ctx = { contents, generation: 1, document: 1, foreground: true };
  const main = createInteractionMain({ context: () => ctx, adapters: { codex: memAdapter() }, owned: null, localModels: null, workspace: () => null, currentBoard: () => 'local', shares: () => host });
  main.register({ handle: (ch, fn) => handlers.set(ch, fn) });
  let api;
  vm.runInNewContext(bridge, { Buffer, Promise, require: () => ({ contextBridge: { exposeInMainWorld(_n, v) { api = v; } }, ipcRenderer: {
    invoke: (ch, ...args) => (ch === 'overview:state' ? Promise.resolve({ schema: 1, status: 'complete', observed_at: Date.now(), omitted: 0, sessions: [] }) : Promise.resolve(handlers.get(ch)({ sender: contents, senderFrame: contents.mainFrame }, ...structuredClone(args)))),
    on: (ch, fn) => { if (!listeners.has(ch)) listeners.set(ch, new Set()); listeners.get(ch).add(fn); },
    removeListener: () => {},
  } }) });
  let ready;
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.setInterval = () => 0;
  dom.window.overviewApi = { ...api, onReady: (fn) => { ready = fn; return () => {}; } };
  dom.window.eval(shareScript);
  dom.window.eval(script);
  const doc = dom.window.document;
  const card = () => doc.querySelector('.owned-session');
  const btn = (label) => [...(card()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);
  return { dom, doc, main, host, card, btn, api, ready: async () => { ready(); await tick(); }, close: () => { main.close(); dom.window.close(); } };
}

test('Overview Share…: off by default; share with a team, see who has access, stop sharing', async () => {
  const s = stack();
  try {
    await s.ready();
    s.doc.getElementById('start-codex').click(); await tick();
    const share = s.btn('Share…');
    assert.ok(share, 'a Share… control on the card');
    assert.equal(share.getAttribute('aria-expanded'), 'false');
    assert.ok(!s.host.calls.some(([k]) => k === 'share'), 'nothing shared by default');
    share.click(); await tick();
    const selects = [...s.card().querySelectorAll('.share-panel select')];
    assert.deepEqual(selects.map((x) => x.options.length), [1, 2, 5]);
    selects[1].value = 'interact'; selects[2].value = '3600';
    s.btn('Share').click(); await tick(8);
    const [, req] = s.host.calls.find(([k]) => k === 'share');
    const session = s.card().dataset.session;
    assert.deepEqual(req, { session, team: 'team-1', scope: 'interact', expiresInS: 3600 });
    assert.match(s.card().textContent, /Shared with Dev team \(Watch and send\)/);
    assert.match(s.card().textContent, /Bob can watch and send/);
    s.btn('Stop sharing').click(); await tick(8);
    assert.ok(s.host.calls.some(([k]) => k === 'stop'));
    assert.match(s.card().textContent, /Stopped sharing/);
    assert.equal(s.host.shares.size, 0);
  } finally { s.close(); }
});

test('Overview Share…: a teammate\'s message shows "Sent by <name>"; only this page\'s own sessions can be shared', async () => {
  const s = stack();
  try {
    await s.ready();
    s.doc.getElementById('start-codex').click(); await tick();
    const session = s.card().dataset.session;
    const t = s.main.sharedTarget(session);
    assert.ok(t, 'the current document owns it');
    const st = t.hub.state({ session }, t.actor);
    await t.hub.send({ session, generation: st.generation, board: st.board, text: 'from a teammate' }, t.actor, { by: 'Bob' });
    await tick();
    const head = [...s.card().querySelectorAll('.delivery-head strong')].map((x) => x.textContent);
    assert.deepEqual(head, ['Sent by Bob']);
    // Another session id, or a forged request, is refused before reaching the host.
    const other = await s.api.interaction.shareCreate({ session: '10000000-0000-4000-8000-000000000001', team: 'team-1', scope: 'watch', expiresInS: null });
    assert.equal(other.ok, false);
    assert.equal((await s.api.interaction.shareCreate({ session, team: 'team-1', scope: 'admin', expiresInS: null })).ok, false);
    assert.equal(s.main.sharedTarget('10000000-0000-4000-8000-000000000001'), null);
    assert.ok(!s.host.calls.some(([k]) => k === 'share'));
  } finally { s.close(); }
});

test('Overview Share…: with hosting off the card explains how to turn sharing on', async () => {
  const s = stack({ host: null });
  try {
    await s.ready();
    s.doc.getElementById('start-codex').click(); await tick();
    s.btn('Share…').click(); await tick(8);
    assert.match(s.card().textContent, /Let my other devices use sessions/);
  } finally { s.close(); }
});
