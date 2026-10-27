'use strict';
// Focused main/preload/service test; helper responses are controlled local fixtures.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createTasksService } = require('../src/tasks-service');
const { createTasksWindowAuthority } = require('./helpers/tasks-window-authority');

test('local preflight is fresh, bounded, advisory, and bound with create to the current Tasks owner', async t => {
  const [P, face] = await Promise.all([import('../board/tasks-api/protocol.js'), import('../board/tasks-api/face.js')]);
  const root = path.resolve('/local/repo'), plain = path.resolve('/local/plain');
  let rows = [], claims = [], failClaims = false, reads = 0, writes = 0, pauseList = null, pauseDir = null, held = null, nativeAnswer = async () => true, svc;
  const channel = new EventEmitter(); Object.assign(channel, {
    listTasks: async () => { reads++; await pauseList?.(); return rows; },
    getClaims: async repo => { if (failClaims) throw Error('unavailable'); return { repo, claims: repo === root ? claims : [] }; },
    getTask: async id => ({ id, worktree: plain }),
    createTask: async spec => { writes++; assert.equal(spec.workInPlace, undefined); return { id: 'created' }; },
    subscribe: async () => {}, listMessages: async () => [], isGreen: () => true, close() {},
  });
  let authority = createTasksWindowAuthority({ service: () => svc, confirm: () => nativeAnswer() });
  svc = createTasksService({ boardHome: '/synthetic', homeDir: path.dirname(root), now: () => 123456,
    isDir: async () => { await pauseDir?.(); return true; }, startGuard: async () => held,
    confirmDialog: (...args) => authority.confirmDialog(...args),
    loadApi: async () => ({ P, taskFace: face.taskFace, client: { connect: async () => channel } }),
  });
  t.after(() => svc.stop()); svc.start();
  for (let i = 0; svc.snapshot().conn.status !== 'connected' && i < 20; i++) await new Promise(r => setImmediate(r));
  assert.equal(svc.snapshot().conn.status, 'connected');
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../tasks-preload.js'), 'utf8'), { require: () => ({
    contextBridge: { exposeInMainWorld(name, value) { if (name === 'tasksApi') api = value; } },
    ipcRenderer: { on() {}, invoke: (name, ...args) => authority.handlers.get(name)(authority.event(), ...structuredClone(args)) },
  }) });
  assert.equal(/ipcMain\.handle\('tasks:create'/.test(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')), false);
  const folder = svc.registerFolder(root), sub = svc.registerFolder(path.join(root, 'src'));
  const row = (id, state = 'running', extras = {}) => ({ id, title: id, state, repo: { root, name: 'repo' }, branch: 'task/branch', source: 'local', ...extras });
  rows = [row('running'), row('in-place', 'running', { workInPlace: true }), row('handover', 'handed_over'), row('unconfirmed', 'failed'), row('finished', 'done'), row('reviewed', 'in_review'), row('other', 'running', { repo: { root: root + '-other' } }), row('remote', 'running', { hub: { cardKey: 'x' } }), row('board-local', 'running', { source: 'board' })];
  claims = ['in-place', 'handover', 'unconfirmed', 'board-local'].map(taskId => ({ taskId, paths: ['src/a.js'] }));
  assert.equal(svc.snapshot().tasks.length, 0, 'cached task list has not received these fresh rows');
  const inspected = await api.preflight({ folder: sub.handle });
  assert.equal(inspected.ok, true, JSON.stringify(inspected)); assert.equal(inspected.preflight.checkedAt, 123456);
  assert.deepEqual(inspected.preflight.peers.map(p => p.id), ['running', 'in-place', 'handover', 'unconfirmed', 'board-local']);
  assert.ok(inspected.preflight.peers.slice(0, 4).every(p => p.uncertain));
  assert.equal(inspected.preflight.peers.at(-1).uncertain, false);
  assert.match(inspected.preflight.note, /Known local Tasks only/); assert.match(inspected.preflight.note, /isolated worktree/);
  assert.equal(writes, 0);
  const beforeInvalid = reads;
  for (const req of [{ folder: root }, { folder: folder.label }, { folder: folder.handle, repo: root }]) assert.equal((await api.preflight(req)).ok, false);
  assert.equal(reads, beforeInvalid, 'paths, labels and forged fields never reach inspection');
  failClaims = true; const failed = await api.preflight({ folder: folder.handle }); failClaims = false;
  assert.equal(failed.ok, false); assert.match(failed.text, /Could not inspect/); assert.equal(failed.preflight, undefined);
  rows = [row('plain', 'running', { repo: null, workInPlace: true })];
  assert.ok((await api.preflight({ folder: folder.handle })).preflight.peers.every(p => p.uncertain && p.state === 'unknown'), 'claims appearing between reads remain visible');
  claims = [];
  assert.equal((await api.preflight({ folder: svc.registerFolder(plain).handle })).preflight.peers[0].id, 'plain');
  assert.equal((await api.preflight({ folder: folder.handle })).preflight.peers.length, 0);
  rows = Array.from({ length: 45 }, (_, i) => row(`task-${i}`, 'running', { title: '\u0000' + 'x'.repeat(250) }));
  claims = rows.map(r => ({ taskId: r.id, paths: ['../escape', '/absolute', ...Array.from({ length: 25 }, (_, i) => `src/${i}.js`)] }));
  const bounded = (await api.preflight({ folder: folder.handle })).preflight;
  assert.equal(bounded.peers.length, 40); assert.ok(bounded.peers[0].title.length <= 200); assert.ok(!bounded.peers[0].title.includes('\u0000')); assert.equal(bounded.peers[0].paths.length, 20);
  assert.equal(bounded.peers[0].uncertain, true); assert.match(bounded.note, /first 40/); assert.ok(!JSON.stringify(bounded).includes('escape'));

  const draft = { folder: folder.handle, text: 'Start the local task', ai: 'codex' };
  for (const name of ['preflight', 'create']) {
    const handler = authority.handlers.get(`tasks:${name}`), req = name === 'preflight' ? { folder: folder.handle } : draft;
    for (const event of [{ sender: {}, senderFrame: authority.wc.mainFrame }, { sender: authority.wc, senderFrame: {} }]) assert.equal((await handler(event, req)).ok, false);
    assert.equal((await handler(authority.event(), req, {})).ok, false);
    for (const change of ['reload', 'navigate', 'blur', 'account', 'workspace']) {
      authority = createTasksWindowAuthority({ service: () => svc, confirm: () => nativeAnswer() });
      const pause = async () => authority[change]();
      if (name === 'preflight') pauseList = pause; else pauseDir = pause;
      const result = await authority.handlers.get(`tasks:${name}`)(authority.event(), req);
      assert.equal(result.ok, false, `${name} after ${change}`); assert.equal(writes, 0, `${change} cannot create`);
      pauseList = null; pauseDir = null;
    }
  }
  authority = createTasksWindowAuthority({ service: () => svc, confirm: () => nativeAnswer() });
  held = { text: 'Budget limit reached.' };
  nativeAnswer = async () => { authority.account(); return true; };
  assert.equal((await api.create({ ...draft, overrideBudget: true })).ok, false); assert.equal(writes, 0, 'retired native confirmation never creates');
  nativeAnswer = async () => true; held = null;
  authority = createTasksWindowAuthority({ service: () => svc, confirm: () => nativeAnswer() });
  assert.equal((await api.create(draft)).ok, true); assert.equal(writes, 1);
  assert.equal((await svc.create(draft)).ok, true, 'non-UI main callers remain compatible'); assert.equal(writes, 2);
});

test('the native confirmation refuses a sender that is not the Tasks page, with no dialog', async () => {
  const authority = createTasksWindowAuthority({ service: () => ({}), confirm: async () => true });
  assert.equal(await authority.confirmDialog({ action: 'merge', label: 'Integrate', title: 't' }, authority.wc.id), true, 'the Tasks page still gets its dialog');
  const shown = authority.dialogs.length;
  for (const wcId of [authority.wc.id + 1, 0, undefined]) assert.equal(await authority.confirmDialog({ action: 'merge', label: 'Integrate', title: 't' }, wcId), false);
  assert.equal(authority.dialogs.length, shown);
});
