'use strict';
// The new-chat screen, main's side (src/newchat-main.js on src/compose-main.js createCompose): its channel set, its
// one push, one create at a time, the S3 handoff to the thread, and review S1 — after the handoff the new-chat
// document holds nothing, and it is kept alive only while a create is in flight.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Compose = require('../src/compose-main.js');
const NewChat = require('../src/newchat-main.js');

const HOME = path.resolve('/Users/demo');
const ROW = 'a'.repeat(64);

function harness(over = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => { assert.ok(!handlers.has(ch), ch); handlers.set(ch, fn); } };
  const wc = { id: 51, mainFrame: { url: 'file:///newchat.html' }, isDestroyed: () => false, sent: [], send(ch, m) { this.sent.push([ch, m]); } };
  const win = { isDestroyed: () => false };
  const st = { foreground: true, document: 1, generation: 1, workspace: 'w1', conn: 'connected', rows: [], listed: new Set(), onCreate: null, onRefresh: null, createGate: null, openThread: true };
  const calls = { create: [], openTask: [], closeTask: [], openThread: [], refresh: 0, reveal: [] };
  const slots = new Map(); // wcId → task id: the Tasks service's per-document subscriptions
  const buddy = {
    newChatWebContents: () => wc,
    newChatContext: () => ({ window: win, contents: wc, generation: st.generation, document: st.document, account: 1, workspace: st.workspace, foreground: st.foreground }),
    newChatDocument: () => ({ wcId: wc.id, doc: st.document }),
    openThread: (row) => { calls.openThread.push(row); return st.openThread; },
  };
  const service = {
    start() {},
    snapshot: () => ({ conn: { status: st.conn }, tasks: st.rows }),
    composerInfo: async () => ({ ais: [{ id: 'claude', label: 'Claude', installed: true, loggedIn: true, tasks: true, capabilities: { background: true } }], recent: [] }),
    registerFolder: (p) => ({ handle: `h:${p}`, label: p }),
    route: async () => ({ ok: true, route: { decision: 'run', ai: 'claude', reason: 'Claude', alternatives: [] } }),
    preflight: async () => ({ ok: true, preflight: { checkedAt: 1, peers: [], note: 'n' } }),
    create: async (draft, extra) => {
      calls.create.push({ draft, extra });
      if (st.createGate) await st.createGate;
      if (st.onCreate) st.onCreate();
      return { ok: true, id: `t${calls.create.length}` };
    },
    openTask: async (id, wcId) => { calls.openTask.push([id, wcId]); slots.set(wcId, id); return { ok: true }; },
    closeTask: (wcId) => { calls.closeTask.push(wcId); slots.delete(wcId); },
    act: async () => { throw Error('the new chat never acts'); },
  };
  const deps = {
    ipcMain, buddy: () => buddy, service: () => service, config: () => ({}), homeDir: HOME,
    sessions: () => [], isDir: async () => true, muted: () => false, pickFolder: async () => null,
    openInTasks: (id) => { calls.reveal.push(id); return true; },
  };
  const glue = {
    rowForTask: (id) => (st.listed.has(id) ? ROW : null),
    refreshTasks: async () => { calls.refresh++; if (st.onRefresh) st.onRefresh(); },
  };
  const api = NewChat.createNewChat(deps, glue);
  const ev = (sender = wc) => ({ sender, senderFrame: sender.mainFrame });
  const call = (ch, ...args) => handlers.get(ch)(ev(), ...args);
  return { handlers, wc, st, calls, api, call, slots, buddy, service };
}
const draft = (over = {}) => ({ text: 'add a dark mode toggle', folder: 'h-1', ai: 'auto', permissionLevel: 'auto-edits', expectAi: 'claude', requestId: 'req-12345678', peersKey: '', ...over });

test('the new chat registers exactly its six channels: newchat:create is the run, and there is no stop', () => {
  const h = harness();
  assert.deepEqual([...h.handlers.keys()].sort(), ['newchat:create', 'newchat:info', 'newchat:open-in-tasks', 'newchat:pick-folder', 'newchat:preflight', 'newchat:route']);
  assert.ok(![...h.handlers.keys()].some((k) => k.startsWith('compose:') || /stop/.test(k)));
});

test('Home and the new chat share RUN_KEYS and peersKeyOf by identity; Home keeps its own channel set', () => {
  assert.equal(NewChat.CHANNELS.run, 'newchat:create');
  const handlers = new Map();
  Compose.register({ ipcMain: { handle: (ch) => handlers.set(ch, true) }, buddy: () => null, service: () => ({}), config: () => ({}) });
  assert.deepEqual([...handlers.keys()].sort(), ['compose:info', 'compose:open-in-tasks', 'compose:pick-folder', 'compose:preflight', 'compose:route', 'compose:run', 'compose:stop']);
  assert.deepEqual({ ...Compose.HOME_PUSH }, { changed: 'compose:changed', event: 'compose:event', task: 'compose:task' });
  const src = require('node:fs').readFileSync(path.join(__dirname, '../src/newchat-main.js'), 'utf8');
  assert.ok(!/RUN_KEYS\s*=|function peersKeyOf/.test(src), 'no second copy of the run keys or the peers key');
  assert.equal(Compose.createCompose, require('../src/compose-main.js').createCompose);
});

test('S1 + S3: a create with the row listed opens that thread, then the instance retires and the new-chat document holds no Tasks slot', async () => {
  const h = harness();
  h.st.onCreate = () => h.st.listed.add('t1');
  const r = await h.call('newchat:create', draft());
  assert.deepEqual(r, { ok: true, id: 't1', opened: true });
  assert.deepEqual(h.calls.openThread, [ROW], 'main opened the thread; the page never named it');
  assert.equal(h.calls.openTask.length, 0, 'no card, so no subscription was ever opened for the new chat');
  assert.deepEqual(h.calls.closeTask, [51], 'retired once, for the new-chat document');
  assert.equal(h.slots.has(51), false);
  assert.equal(h.api._started(), null);
  assert.equal(h.api.busy(), false, 'nothing keeps the hidden document alive');
  // A forged id in the page's next call is ignored: the started set went with the handoff.
  assert.equal(await h.call('newchat:open-in-tasks', 't1'), false);
  assert.deepEqual(h.calls.reveal, []);
});

test('S1: newChatBusy is true only until create returns, never because the task is live', async () => {
  const h = harness();
  let release;
  h.st.createGate = new Promise((r) => { release = r; });
  h.st.rows = [{ id: 't1', state: 'running' }];
  const pending = h.call('newchat:create', draft());
  await new Promise((r) => setImmediate(r));
  assert.equal(h.api.busy(), true, 'the create is in flight');
  release();
  const r = await pending;
  assert.equal(r.ok, true);
  assert.equal(h.api.busy(), false, 'create returned; the live task does not keep the document');
});

test('S1: the "Started." fallback keeps only the started id, and busy is false once create has returned', async () => {
  const h = harness();
  h.st.rows = [{ id: 't1', state: 'running' }];
  const r = await h.call('newchat:create', draft());
  assert.deepEqual(r, { ok: true, id: 't1' });
  assert.equal(h.calls.refresh, 1, 'the lagging row model got one refresh');
  assert.deepEqual(h.calls.openThread, [], 'never Board, never a guess');
  assert.equal(h.api.busy(), false);
  assert.equal(h.calls.openTask.length, 0, 'still no subscription for the page on screen');
  assert.equal(await h.call('newchat:open-in-tasks', 't1'), true);
  assert.equal(await h.call('newchat:open-in-tasks', 't9'), false, 'that id only');
  assert.deepEqual(h.calls.reveal, ['t1']);
  // Leaving the screen retires it like any other document.
  h.api.retire(51);
  assert.equal(h.api._started(), null);
  assert.deepEqual(h.calls.closeTask, [51]);
});

test('S3: a row that appears with the one refresh is opened', async () => {
  const h = harness();
  h.st.onRefresh = () => h.st.listed.add('t1');
  const r = await h.call('newchat:create', draft());
  assert.deepEqual(r, { ok: true, id: 't1', opened: true });
  assert.equal(h.calls.refresh, 1);
  assert.deepEqual(h.calls.openThread, [ROW]);
});

test('S3: a document change before create returns: no navigation, STARTED_ELSEWHERE', async () => {
  const h = harness();
  h.st.onCreate = () => { h.st.listed.add('t1'); h.st.document++; };
  const r = await h.call('newchat:create', draft());
  assert.equal(r.code, 'STARTED_ELSEWHERE');
  assert.equal(r.text, "Started. It's in Tasks.");
  assert.deepEqual(h.calls.openThread, []);
});

test('note 2: a document change during the one refresh: STARTED_ELSEWHERE, no navigation', async () => {
  const h = harness();
  h.st.onRefresh = () => { h.st.listed.add('t1'); h.st.foreground = false; };
  const r = await h.call('newchat:create', draft());
  assert.equal(r.code, 'STARTED_ELSEWHERE');
  assert.deepEqual(h.calls.openThread, []);
  assert.equal(h.api.busy(), false);
});

test("review nit: a record left by an earlier document never stops a later document's retire from closing its slot", async () => {
  const h = harness();
  // The document moves during the one refresh, after the record was made: STARTED_ELSEWHERE leaves the record for 51.
  h.st.onRefresh = () => { h.st.listed.add('t1'); h.st.document++; };
  assert.equal((await h.call('newchat:create', draft())).code, 'STARTED_ELSEWHERE');
  assert.equal(h.api._started()?.wcId, 51, 'the earlier document (51) still has its record');
  h.api.retire(77); // the next new-chat document, a different webContents
  assert.deepEqual(h.calls.closeTask, [77], 'closed for the document that retired');
  assert.equal(h.api._started()?.wcId, 51, "only that document's own record is cleared");
  h.api.retire(51);
  assert.deepEqual(h.calls.closeTask, [77, 51]);
  assert.equal(h.api._started(), null);
});

test('S3: a second newchat:create while one is in flight is refused in main, and nothing extra is created', async () => {
  const h = harness();
  let release;
  h.st.createGate = new Promise((r) => { release = r; });
  const first = h.call('newchat:create', draft());
  await new Promise((r) => setImmediate(r));
  // Raced against a tick: without main's refusal the second create would wait on the first, so it must answer at once.
  const second = await Promise.race([h.call('newchat:create', draft({ requestId: 'req-87654321' })), new Promise((r) => setTimeout(() => r({ code: 'STILL_WAITING' }), 50))]);
  assert.equal(second.code, 'BUSY');
  release();
  await first;
  assert.equal(h.calls.create.length, 1);
  const third = await h.call('newchat:create', draft({ requestId: 'req-11112222' }));
  assert.equal(third.ok, true, 'free again once the first returned');
});

test('S3: the new chat pushes only newchat:changed — no event lines, no task card', async () => {
  const h = harness();
  h.st.rows = [{ id: 't1', state: 'running' }];
  await h.call('newchat:create', draft());
  h.api.onChange({ conn: { status: 'offline' }, tasks: h.st.rows });
  h.api.onChange({ conn: { status: 'connected' }, tasks: [{ id: 't1', state: 'blocked' }] });
  assert.equal(h.api.onEvent(51, 't1', { type: 'output', text: 'hi' }), true, 'its own event is consumed, not forwarded');
  const names = new Set(h.wc.sent.map(([ch]) => ch));
  assert.deepEqual([...names], ['newchat:changed']);
  assert.ok(!names.has('newchat:event') && !names.has('newchat:task'));
});

test('create refuses with the new chat\'s own copy: unfocused, moved mid-check, extra keys', async () => {
  const h = harness();
  h.st.foreground = false;
  assert.equal((await h.call('newchat:create', draft())).text, 'Focus the new chat and press Send again.');
  h.st.foreground = true;
  assert.equal((await h.call('newchat:create', { ...draft(), confirmed: true })).code, 'VALIDATION');
  h.service.preflight = async () => { h.st.document++; return { ok: true, preflight: { peers: [] } }; };
  assert.equal((await h.call('newchat:create', draft())).text, NewChat.COPY.moved);
  assert.equal(h.calls.create.length, 0);
});
