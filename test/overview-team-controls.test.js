'use strict';
// Actual preload -> IPC -> overview service -> team client -> interaction hub.
// The network and provider are deterministic substitutes, not external-account
// acceptance. Every routing, generation and receipt check is product code.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createInteractionHub } = require('../src/session-interaction');
const { createTeamHubClient } = require('../src/team-hub-client');
const { createOverviewMain } = require('../src/overview-main');
const tick = () => new Promise(r => setImmediate(r));
async function rig() {
  const ee = new EventEmitter(), calls = [], actor = 'owner-document', share = crypto.randomUUID();
  const adapter = { label: 'Codex', capabilities: { newTurn: true, steer: true, interrupt: true, ack: true, echo: true, stream: true },
    open: async () => ({ target: 'private-native-thread' }), alive: () => true, on: fn => { ee.on('event', fn); return () => ee.off('event', fn); },
    send: async req => { calls.push(req); return { turnId: req.expectedTurnId ?? `private-native-turn-${calls.length}`, mode: req.expectedTurnId ? 'steer' : 'new-turn' }; },
    interrupt: async req => { calls.push({ interrupt: req }); return true; },
  };
  const hub = createInteractionHub({ adapters: { codex: adapter }, boardCurrent: () => true });
  const launched = await hub.launch({ provider: 'codex', board: 'private-board' }, actor), session = launched.state.session;
  let shared = true, scope = 'interact', focused = true, visible = true, generation = 1, document = 1, account = true, hold = null;
  const json = body => ({ status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body) });
  const client = createTeamHubClient({ baseUrl: 'https://synthetic.invalid', token: () => 'test-only-token', viewer: { id: 'viewer', name: 'Viewer' }, fetch: async (url, init) => {
    if (url.endsWith('/shared')) return json({ shared: shared ? [{ id: share, session, scope, team: { id: 'team', name: 'Team' }, owner: { id: 'owner', name: 'Owner' }, online: true, expires_at: null }] : [] });
    const req = JSON.parse(init.body);
    if (hold) await hold(req);
    if (!shared) return { ...json({}), status: 404 };
    let result;
    if (req.op === 'state') result = { ok: true, state: { ...hub.state({ session }, actor), observed_at: Date.now() } };
    else if (req.op === 'send') result = await hub.send({ ...req.args, board: 'private-board' }, actor, { by: 'Viewer' });
    else if (req.op === 'interrupt') result = await hub.interrupt(req.args, actor);
    return json({ result });
  } });
  const win = { isDestroyed: () => false, isVisible: () => visible, isFocused: () => focused, isMinimized: () => false };
  const wc = { mainFrame: {}, isDestroyed: () => false }, ctx = () => visible ? { window: win, contents: wc, foreground: focused, generation, document } : null;
  const buddy = { overviewContext: () => focused ? ctx() : null, overviewReadContext: ctx };
  const main = createOverviewMain({ buddy: () => buddy, sessions: () => [], teamHub: () => account ? client : null });
  const handlers = new Map(); main.register({ handle: (name, fn) => handlers.set(name, fn) });
  const event = { sender: wc, senderFrame: wc.mainFrame };
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../overview-preload.js'), 'utf8'), { Buffer, Promise, require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => api = value }, ipcRenderer: { invoke: (name, ...args) => handlers.get(name)(event, ...args) } }) });
  const list = async () => api.directory({ view: 'team', team: null });
  const first = await list(), id = first.entries[0].id;
  return { api, hub, main, calls, handlers, event, session, actor, id, list, adapter,
    inspect: () => api.teamInspect({ id }),
    emit: event => ee.emit('event', { target: 'private-native-thread', ...event }),
    revoke: () => shared = false, watch: () => scope = 'watch', blur: () => focused = false, hide: () => visible = false,
    reload: () => { document++; generation++; }, signOut: () => { account = false; main.invalidate(); },
    hold: fn => hold = fn, close: () => { main.close(); hub.stopAll(); },
  };
}
test('full IPC send -> exact echo -> streamed response -> completion remains in the selected shared session', async () => {
  const x = await rig();
  try {
    const inspected = await x.inspect(); assert.equal(inspected.capabilities.send.available, true);
    const result = await x.api.teamAction({ selection: inspected.selection, operation: 'send', text: 'Reply with the task status' });
    assert.equal(result.status, 'acknowledged'); assert.equal(x.calls.length, 1);
    const sent = x.calls[0], turnId = 'private-native-turn-1';
    x.emit({ kind: 'input-recorded', turnId, clientId: sent.clientId, text: sent.text });
    x.emit({ kind: 'delta', turnId, text: 'The selected task is ready.' });
    let current = await x.inspect();
    assert.equal(current.state.deliveries[0].recorded, true); assert.equal(current.state.deliveries[0].state, 'responding');
    assert.equal(current.state.deliveries[0].response, 'The selected task is ready.');
    x.emit({ kind: 'turn-completed', turnId, status: 'completed' });
    current = await x.inspect(); assert.equal(current.state.deliveries[0].state, 'completed');
    const wire = JSON.stringify([inspected, result, current]);
    for (const forbidden of ['private-native-thread', 'private-native-turn', 'private-board', 'test-only-token', x.session]) assert.equal(wire.includes(forbidden), false, forbidden);
  } finally { x.close(); }
});
test('full IPC steers and interrupts the reviewed current turn while stale turn reviews refuse', async () => {
  const x = await rig();
  try {
    let read = await x.inspect(); await x.api.teamAction({ selection: read.selection, operation: 'send', text: 'Start this task' });
    read = await x.inspect();
    assert.equal((await x.api.teamAction({ selection: read.selection, operation: 'steer', text: 'Check the new decision first' })).status, 'acknowledged');
    assert.equal(x.calls[1].expectedTurnId, 'private-native-turn-1');
    read = await x.inspect();
    assert.equal((await x.api.teamAction({ selection: read.selection, operation: 'interrupt', text: '' })).status, 'interrupt-requested');
    const old = await x.inspect();
    x.emit({ kind: 'turn-completed', turnId: 'private-native-turn-1', status: 'completed' });
    assert.equal((await x.api.teamAction({ selection: old.selection, operation: 'steer', text: 'Late correction' })).ok, false);
    assert.equal(x.calls.length, 3);
  } finally { x.close(); }
});
for (const change of ['revoke', 'watch', 'signOut', 'reload', 'blur', 'hide']) test(`full IPC ${change} retires a prepared shared-session action`, async () => {
  const x = await rig();
  try {
    const read = await x.inspect(); x[change]();
    if (change === 'reload') { await x.list(); await x.inspect(); }
    assert.equal((await x.api.teamAction({ selection: read.selection, operation: 'send', text: 'Never dispatch stale work' })).ok, false);
    assert.equal(x.calls.length, 0);
  } finally { x.close(); }
});
test('actual preload and IPC refuse injected routing and sibling/subframe calls', async () => {
  const x = await rig();
  try {
    const read = await x.inspect();
    assert.equal((await x.api.teamAction({ selection: read.selection, operation: 'send', text: 'hi', session: x.session })).status, 'invalid');
    for (const event of [{ sender: {}, senderFrame: x.event.senderFrame }, { sender: x.event.sender, senderFrame: {} }]) {
      assert.equal((await x.handlers.get('overview:team-action')(event, { selection: read.selection, operation: 'send', text: 'hi' })).ok, false);
      assert.equal((await x.handlers.get('overview:team-inspect')(event, { id: x.id })).ok, false);
    }
    assert.equal(x.calls.length, 0);
  } finally { x.close(); }
});
test('switching directory view during a state await prevents any eventual provider dispatch', async () => {
  const x = await rig();
  try {
    const read = await x.inspect(); let release;
    x.hold(req => req.op === 'state' ? new Promise(r => release = r) : null);
    const pending = x.api.teamAction({ selection: read.selection, operation: 'send', text: 'Do not dispatch after leaving team view' });
    await tick(); await x.api.directory({ view: 'mine' }); release();
    assert.equal((await pending).ok, false); assert.equal(x.calls.length, 0);
  } finally { x.close(); }
});
