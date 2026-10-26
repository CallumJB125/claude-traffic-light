'use strict';
// Home's task box, main's side (src/compose-main.js): authority, handles only, nothing starts without Run,
// main's own preflight, stop for this document's tasks only, and R1's live allowlist.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Compose = require('../src/compose-main.js');

const HOME = path.resolve('/Users/demo');
function harness(over = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => { assert.ok(!handlers.has(ch), ch); handlers.set(ch, fn); } };
  const frame = { url: 'file:///home.html' };
  const wc = { id: 41, mainFrame: frame, isDestroyed: () => false, sent: [], send(ch, m) { this.sent.push([ch, m]); } };
  const win = { isDestroyed: () => false };
  const st = { foreground: true, document: 1, generation: 1, workspace: 'w1', hidden: false, conn: 'connected', rows: [], peers: [], preflightOk: true, preflightPeersAtRun: null, onPreflight: null, onCreate: null, onAct: null };
  const calls = { create: [], act: [], route: [], preflight: [], registerFolder: [], openTask: [], closeTask: [] };
  const buddy = {
    pageWebContents: (id) => (id === 'home' ? wc : null),
    homeContext: () => ({ window: win, contents: wc, generation: st.generation, document: st.document, account: 1, workspace: st.workspace, foreground: st.foreground }),
    homeDocument: () => ({ wcId: wc.id, doc: st.document }),
  };
  const service = {
    start() {},
    snapshot: () => ({ conn: { status: st.conn }, tasks: st.rows }),
    composerInfo: async () => ({ ais: [{ id: 'claude', label: 'Claude', installed: true, loggedIn: true, tasks: true, capabilities: { background: true } }, { id: 'codex', label: 'Codex', installed: true, loggedIn: false, capabilities: { background: true } }], recent: [{ handle: 'r-1', label: '~/recent' }] }),
    registerFolder: (p) => { calls.registerFolder.push(p); return { handle: `h:${p}`, label: p }; },
    route: async (req) => { calls.route.push(req); return { ok: true, route: { decision: 'run', ai: 'codex', reason: 'Codex: you set Codex for this repo', alternatives: [] } }; },
    preflight: async (req) => {
      calls.preflight.push(req);
      if (st.onPreflight) st.onPreflight();
      if (!st.preflightOk) return { ok: false, code: 'CONFLICT', text: 'Could not inspect known local work.' };
      const peers = calls.preflight.length > 1 && st.preflightPeersAtRun ? st.preflightPeersAtRun : st.peers;
      return { ok: true, preflight: { checkedAt: 1, peers, note: 'n' } };
    },
    create: async (draft, extra) => { calls.create.push({ draft, extra }); if (st.onCreate) st.onCreate(); return { ok: true, id: `t${calls.create.length}` }; },
    act: async (req, wcId, current) => { calls.act.push({ req, wcId, current: current() }); if (st.onAct) st.onAct(); return { ok: true }; },
    openTask: async (id, wcId) => { calls.openTask.push([id, wcId]); return { ok: true }; },
    closeTask: (wcId) => { calls.closeTask.push(wcId); },
  };
  const deps = {
    ipcMain, buddy: () => buddy, service: () => service, config: () => ({ homeComposer: st.hidden ? false : undefined }), homeDir: HOME,
    sessions: () => over.sessions ?? [], isDir: async (p) => !(over.missing || []).includes(p), muted: (cwd) => (over.muted || []).includes(cwd),
    pickFolder: async () => over.pick ?? null, openInTasks: (id) => { calls.reveal = id; return true; }, shortcut: () => ({ state: 'off' }),
  };
  const api = Compose.register(deps);
  const ev = (sender = wc) => ({ sender, senderFrame: sender.mainFrame });
  const call = (ch, ...args) => handlers.get(ch)(ev(), ...args);
  return { handlers, wc, st, calls, api, ev, call, buddy };
}
const draft = (over = {}) => ({ text: 'fix the flaky login test', folder: 'h-1', ai: 'auto', permissionLevel: 'auto-edits', expectAi: 'codex', requestId: 'req-12345678', ...over });
async function peersKey(h) { return (await h.call('compose:preflight', { folder: 'h-1' })).preflight.key; }

test('every channel answers the Home page only; another page or a subframe gets nothing', async () => {
  const h = harness();
  const other = { id: 9, mainFrame: {}, isDestroyed: () => false };
  for (const [ch, args] of [['compose:info', []], ['compose:route', [{}]], ['compose:preflight', [{}]], ['compose:pick-folder', []], ['compose:run', [draft()]], ['compose:stop', [{ id: 't1', confirmed: true }]], ['compose:open-in-tasks', ['t1']]]) {
    const r = await h.handlers.get(ch)({ sender: other, senderFrame: other.mainFrame }, ...args);
    assert.ok(r === null || r === false || r?.ok === false, ch);
    const sub = await h.handlers.get(ch)({ sender: h.wc, senderFrame: {} }, ...args);
    assert.ok(sub === null || sub === false || sub?.ok === false, `${ch} from a subframe`);
  }
  assert.equal(h.calls.create.length, 0);
  assert.equal(h.calls.act.length, 0);
});

test('finding 6: nothing starts without Run — info, route, preflight, folder picks, a tie, refusals and stop never create', async () => {
  const h = harness({ sessions: [{ cwd: '/Users/demo/acme', updatedAt: 2 }], pick: '/Users/demo/other' });
  await h.call('compose:info');
  for (const decision of ['run', 'ask', 'refuse']) await h.call('compose:route', { text: `t ${decision}`, folder: 'h-1', ai: 'auto', permissionLevel: 'plan' });
  await h.call('compose:preflight', { folder: 'h-1' });
  await h.call('compose:pick-folder');
  await h.call('compose:stop', { id: 'nope', confirmed: true });
  await h.call('compose:open-in-tasks', 'nope');
  // The menu bar's New task… and the shortcut: they only open a page and focus a box.
  const opened = [];
  for (const homeComposer of [undefined, false]) {
    Compose.openCompose({ ready: () => true, config: () => ({ homeComposer }), openPage: (id) => opened.push(id), buddy: () => ({ focusComposer: () => true, tasksCompose: () => true }) });
  }
  assert.deepEqual(opened, ['home', 'tasks'], 'box hidden: the Tasks composer instead');
  assert.equal(Compose.openCompose({ ready: () => false, config: () => ({}), openPage: () => opened.push('x'), buddy: () => null }), false, 'no window yet: a no-op');
  assert.equal(h.calls.create.length, 0);
  // Run: exactly one create.
  h.st.peers = [];
  const r = await h.call('compose:run', draft());
  assert.equal(r.ok, true);
  assert.equal(h.calls.create.length, 1);
});

test('finding 1: the spec reaching create carries expectAi, a folder handle and no path from the page', async () => {
  const h = harness();
  await h.call('compose:run', draft());
  const { draft: d, extra } = h.calls.create[0];
  assert.equal(d.expectAi, 'codex');
  assert.equal(d.folder, 'h-1');
  assert.equal(d.ai, 'auto');
  assert.equal(d.surface, 'background');
  assert.equal(extra.wcId, h.wc.id);
  assert.equal(extra.current(), true);
  assert.equal(h.calls.openTask[0][1], h.wc.id, 'the started task streams to Home’s own slot');
  // Extra keys are refused before anything is checked.
  const bad = await h.call('compose:run', { ...draft(), cwd: '/etc' });
  assert.equal(bad.code, 'VALIDATION');
  assert.equal(h.calls.create.length, 1);
});

test('finding 10 and R4: main re-runs preflight; changed peers or a failed check refuse with 0 creates', async () => {
  const h = harness();
  h.st.peers = [{ id: 'p1', state: 'running', paths: ['a.js'] }];
  const key = await peersKey(h);
  h.st.preflightPeersAtRun = [{ id: 'p1', state: 'running', paths: ['a.js'] }, { id: 'p2', state: 'running', paths: ['b.js'] }];
  const changed = await h.call('compose:run', draft({ peersKey: key }));
  assert.equal(changed.code, 'PEERS_CHANGED');
  assert.equal(changed.preflight.peers.length, 2);
  assert.equal(h.calls.create.length, 0);
  // A claimed key that matches nothing is only a claim.
  const h2 = harness(); h2.st.peers = [{ id: 'p1', state: 'running', paths: [] }];
  assert.equal((await h2.call('compose:run', draft({ peersKey: 'made-up' }))).code, 'PEERS_CHANGED');
  assert.equal(h2.calls.create.length, 0);
  // R4: the check failing is never "no peers".
  const h3 = harness(); h3.st.preflightOk = false;
  const failed = await h3.call('compose:run', draft());
  assert.equal(failed.code, 'CONFLICT');
  assert.equal(h3.calls.create.length, 0);
  // Same peers, acknowledged: starts.
  const h4 = harness(); h4.st.peers = [{ id: 'p1', state: 'running', paths: ['a.js'] }];
  assert.equal((await h4.call('compose:run', draft({ peersKey: await peersKey(h4) }))).ok, true);
});

test('Run is bound to the foreground Home document across every await', async () => {
  for (const change of [(st) => { st.foreground = false; }, (st) => { st.document++; }, (st) => { st.generation++; }, (st) => { st.workspace = 'w2'; }]) {
    const h = harness();
    h.st.onPreflight = () => change(h.st);
    const r = await h.call('compose:run', draft());
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONFLICT');
    assert.equal(h.calls.create.length, 0);
  }
  const h = harness(); h.st.foreground = false;
  assert.equal((await h.call('compose:run', draft())).code, 'ILLEGAL_TRANSITION');
  assert.equal(h.calls.create.length, 0);
});

test('finding 1: Home changing during create returns STARTED_ELSEWHERE with the id, never a retryable CONFLICT', async () => {
  const h = harness();
  h.st.onCreate = () => { h.st.document++; };
  const r = await h.call('compose:run', draft());
  assert.deepEqual(r, { ok: false, code: 'STARTED_ELSEWHERE', id: 't1', text: "Started. It's in Tasks." });
  assert.equal(h.calls.create.length, 1);
  assert.equal((await h.call('compose:stop', { id: 't1', confirmed: true })).code, 'NOT_FOUND', 'the new document does not own it');
});

test('R6: stop from a subframe after a successful Run does nothing; a document change during act is a CONFLICT', async () => {
  const h = harness();
  await h.call('compose:run', draft());
  const sub = await h.handlers.get('compose:stop')({ sender: h.wc, senderFrame: {} }, { id: 't1', confirmed: true });
  assert.equal(sub.ok, false);
  assert.equal(h.calls.act.length, 0);
  h.st.onAct = () => { h.st.document++; };
  const r = await h.call('compose:stop', { id: 't1', confirmed: true });
  assert.equal(h.calls.act.length, 1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONFLICT');
});

test('hidden box: info says hidden and every other channel refuses', async () => {
  const h = harness(); h.st.hidden = true;
  assert.deepEqual(await h.call('compose:info'), { hidden: true });
  for (const [ch, args] of [['compose:route', [{}]], ['compose:preflight', [{}]], ['compose:run', [draft()]]]) assert.equal((await h.call(ch, ...args)).ok, false, ch);
  assert.equal(await h.call('compose:pick-folder'), null);
  assert.equal(h.calls.create.length + h.calls.route.length + h.calls.preflight.length, 0);
});

test('R6: stop takes exactly {id, confirmed} for a task this Home document started; never another action', async () => {
  const h = harness();
  await h.call('compose:run', draft());
  for (const req of [{ id: 't1', action: 'approve' }, { id: 't1', confirmed: true, payload: {} }, { id: 't1', confirmed: true, action: 'stop' }, { id: 't1' }, { id: 't1', confirmed: 'yes' }, null]) {
    assert.equal((await h.call('compose:stop', req)).ok, false, JSON.stringify(req));
  }
  assert.equal((await h.call('compose:stop', { id: 'someone-else', confirmed: true })).code, 'NOT_FOUND');
  assert.equal(h.calls.act.length, 0);
  assert.equal((await h.call('compose:stop', { id: 't1', confirmed: true })).ok, true);
  assert.deepEqual(h.calls.act[0].req, { id: 't1', action: 'stop', confirmed: true });
  assert.equal(h.calls.act[0].current, true);
  // Another sender with the same frame shape is not the starter.
  const other = { id: 99, mainFrame: h.wc.mainFrame, isDestroyed: () => false };
  assert.equal((await h.handlers.get('compose:stop')({ sender: other, senderFrame: other.mainFrame }, { id: 't1', confirmed: true })).ok, false);
});

test('finding 3: a reload retires the started set: stop is refused and no event reaches the new document', async () => {
  const h = harness();
  await h.call('compose:run', draft());
  assert.equal(h.api.onEvent(h.wc.id, 't1', { type: 'tool', phase: 'start', name: 'Bash', summary: 'npm test' }), true);
  assert.deepEqual(h.wc.sent.at(-1), ['compose:event', { id: 't1', line: '▸ Bash npm test' }]);
  h.st.document++; // did-start-navigation bumps homeDocument, then buddy-window calls onHomeRetired(wcId)
  const data = () => h.wc.sent.filter(([ch]) => ch !== 'compose:changed').length; // compose:changed carries nothing
  const sent = data();
  h.api.onEvent(h.wc.id, 't1', { type: 'tool', phase: 'start', name: 'Bash', summary: 'x' });
  h.api.onChange({ conn: { status: 'connected' }, tasks: [{ id: 't1', state: 'running' }] });
  assert.equal(data(), sent, 'nothing to the new document even before retire runs');
  assert.equal((await h.call('compose:stop', { id: 't1', confirmed: true })).code, 'NOT_FOUND');
  h.api.retire(h.wc.id);
  assert.deepEqual(h.calls.closeTask, [h.wc.id]);
  assert.equal((await h.call('compose:info')).task, null);
  assert.equal(h.calls.act.length, 0);
});

test('R1: Home is busy only while a started task is known and in a live state', async () => {
  const h = harness();
  assert.equal(h.api.busy(), false, 'nothing started');
  await h.call('compose:run', draft());
  for (const [state, busy] of [['running', true], ['blocked', true], ['queued', true], ['parked', false], ['handed_over', false], ['suspended', false], ['in_review', false], ['brand_new_state', false]]) {
    h.st.rows = [{ id: 't1', state }];
    assert.equal(h.api.busy(), busy, state);
  }
  h.st.rows = [{ id: 't1', state: 'running' }];
  h.st.conn = 'offline';
  assert.equal(h.api.busy(), false, 'helper disconnected');
  h.st.conn = 'connected'; h.st.rows = [];
  assert.equal(h.api.busy(), false, 'row missing');
  h.st.rows = [{ id: 't1', state: 'running' }]; h.st.document++;
  assert.equal(h.api.busy(), false, 'another document');
});

test('finding 9: the default folder skips tasks, worktrees, ~, muted and missing folders; one registerFolder call', async () => {
  const h = harness({
    sessions: [
      { cwd: '/Users/demo/task', taskId: 't', updatedAt: 9 },
      { cwd: '/Users/demo/acme-buddy-0123456789ab', updatedAt: 8 },
      { cwd: '/Users/demo/acme-buddy-0123456789ab/sub', updatedAt: 8 },
      { cwd: HOME, updatedAt: 7 },
      { cwd: '/Users/demo/muted', updatedAt: 6 },
      { cwd: '/Users/demo/gone', updatedAt: 5 },
      { cwd: 'relative/x', updatedAt: 5 },
      { cwd: '/Users/demo/acme', updatedAt: 4 },
      { cwd: '/Users/demo/older', updatedAt: 1 },
    ],
    muted: ['/Users/demo/muted'], missing: ['/Users/demo/gone'],
  });
  const info = await h.call('compose:info');
  assert.deepEqual(h.calls.registerFolder, ['/Users/demo/acme']);
  assert.equal(info.folder.handle, 'h:/Users/demo/acme');
  assert.deepEqual(info.ais.map((a) => [a.id, a.usable]), [['claude', true], ['codex', false]]);
  const none = harness();
  assert.equal((await none.call('compose:info')).folder.handle, 'r-1', 'no session: Tasks’ most recent folder');
  assert.equal(none.calls.registerFolder.length, 0);
});

test('peers key is main’s own and stable for the same peers', () => {
  const a = Compose.peersKeyOf({ peers: [{ id: 'p', state: 'running', paths: ['x'] }] });
  assert.equal(a, Compose.peersKeyOf({ peers: [{ id: 'p', state: 'running', paths: ['x'] }] }));
  assert.notEqual(a, Compose.peersKeyOf({ peers: [{ id: 'p', state: 'running', paths: ['y'] }] }));
  assert.deepEqual(Object.keys(Compose.cardRow({ id: 't', state: 'running', label: 'x', reason: 'y', ai: { id: 'claude' }, actions: [], stateSinceMs: 1, where: '~/secret', branch: 'b' })).sort(), ['actions', 'ai', 'label', 'reason', 'state', 'stateSinceMs']);
});
