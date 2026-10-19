'use strict';
// Actual Tasks renderer + preload + main service + local socket + real Git.
// Provider work is a disposable CLI fixture, and native dialogs are explicit
// controlled answers; this does not establish installed-app/native acceptance.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createTasksService } = require('../src/tasks-service');
const { createTasksWindowAuthority } = require('./helpers/tasks-window-authority');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
let fixture, waitFor;
test.before(async () => {
  ({ startCodexFixture: fixture } = await import('../board/tasks-engine/test/codex-helpers.js'));
  ({ waitFor } = await import('../board/tasks-engine/test/helpers.js'));
});
const local = process.platform === 'win32' ? test.skip : test;
async function setup(t, { confirm = async () => true, renderer = false, loseApplyReply = false } = {}) {
  const h = await fixture({}); let svc, dom;
  const listeners = new Map();
  t.after(async () => { svc?.stop(); listeners.clear(); await h.cleanup(); await new Promise(r => setImmediate(r)); dom?.window.close(); });
  const { id } = await h.client.createTask({ text: 'Reviewed fixture integration', cwd: h.repo.checkout, ai: 'codex' });
  await waitFor(() => h.task(id)?.state === 'in_review');
  const raw = await h.client.getTask(id);
  fs.writeFileSync(path.join(raw.worktree, 'integrated.js'), 'export const message = "<img src=x onerror=globalThis.bad=1>";\n');
  const send = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn({}, ...structuredClone(args)); };
  const authority = createTasksWindowAuthority({ service: () => svc, confirm });
  let loadApi;
  if (loseApplyReply) {
    const [client, P, face] = await Promise.all([import('../board/tasks-api/client.js'), import('../board/tasks-api/protocol.js'), import('../board/tasks-api/face.js')]);
    loadApi = async () => ({ P, taskFace: face.taskFace, client: { connect: async options => {
      const c = await client.connect(options), act = c.act.bind(c);
      c.act = async (...args) => { const result = await act(...args); if (args[1] === 'merge' && args[2]?.phase === 'apply') throw Object.assign(new Error('synthetic lost post-dispatch reply'), { code: 'TIMEOUT' }); return result; };
      return c;
    } } });
  }
  svc = createTasksService({ boardHome: h.dataDir, confirmDialog: authority.confirmDialog,
    ...(loadApi ? { loadApi } : {}),
    onChange: snap => send('tasks:changed', snap), onEvent: (_wc, taskId, event) => send('tasks:event', { id: taskId, event }) });
  svc.start(); await waitFor(() => svc.snapshot().conn.status === 'connected');
  let api;
  vm.runInNewContext(read('tasks-preload.js'), { require: () => ({ contextBridge: { exposeInMainWorld(name, value) { if (name === 'tasksApi') api = value; } }, ipcRenderer: {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    async invoke(name, ...args) { if (name === 'tasks:act') return authority.handlers.get(name)(authority.event(), ...structuredClone(args)); return ({ 'tasks:state': () => svc.snapshot(), 'tasks:open': id => svc.openTask(id, 7), 'tasks:close': () => svc.closeTask(7) })[name](...structuredClone(args)); },
  } }) });
  const f = { h, svc, api, id, raw, authority, dialogs: authority.dialogs, preview: () => api.act({ id, action: 'merge', payload: { phase: 'preview' } }), apply: review => api.act({ id, action: 'merge', payload: { phase: 'apply', review } }) };
  if (renderer) {
    dom = new JSDOM(read('tasks.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://plexiform.invalid/tasks.html?embedded=1' });
    dom.window.tasksApi = api; dom.window.CSS ??= {}; dom.window.CSS.escape ??= value => String(value).replace(/[^\w-]/g, '\\$&');
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.eval(read('src/tasks-view.js')); dom.window.eval(read('tasks.js'));
    await waitFor(() => dom.window.document.querySelector(`[data-id="${id}"]`)); dom.window.document.querySelector(`[data-id="${id}"]`).click();
    await waitFor(() => [...dom.window.document.querySelectorAll('button')].some(b => b.textContent === 'Review integration'));
    f.dom = dom; f.button = text => [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === text);
  } else await api.open(id);
  return f;
}
local('actual Tasks renderer reviews exact diff and only integrates after native confirmation', async t => {
  let allow = false; const f = await setup(t, { renderer: true, confirm: async () => allow });
  f.button('Review integration').click(); await waitFor(() => f.button('Integrate reviewed changes…'));
  assert.equal(f.dialogs.length, 0); assert.equal(fs.existsSync(path.join(f.h.repo.checkout, 'integrated.js')), false);
  assert.match(f.dom.window.document.querySelector('.integration-review pre').textContent, /export const message/);
  assert.equal(f.dom.window.document.querySelector('.integration-review img'), null, 'diff is rendered as text');
  f.button('Integrate reviewed changes…').click(); await waitFor(() => f.dialogs.length === 1 && f.button('Review integration')?.disabled === false);
  assert.equal(fs.existsSync(path.join(f.h.repo.checkout, 'integrated.js')), false, 'native cancel does not apply');
  f.button('Review integration').click(); await waitFor(() => f.button('Integrate reviewed changes…')); allow = true;
  f.button('Integrate reviewed changes…').click(); await waitFor(() => f.h.task(f.id).state === 'done');
  await waitFor(() => f.dom.window.document.body.textContent.includes('Reviewed changes integrated.'));
  assert.equal(f.h.task(f.id).outcome, 'merged'); assert.match(f.dialogs.at(-1).detail, /local merge commit/);
  assert.equal(fs.existsSync(path.join(f.h.repo.checkout, 'integrated.js')), true); assert.equal(fs.existsSync(f.raw.worktree), true);
});
local('page cannot forge helper review IDs, hashes or native confirmation', async t => {
  const f = await setup(t, { confirm: async () => false });
  assert.equal((await f.api.act({ id: f.id, action: 'merge', payload: { phase: 'apply', review: 'forged' }, confirmed: true })).ok, false);
  const r = await f.preview(); assert.equal(r.ok, true); assert.equal(r.integration.canApply, true);
  assert.equal('hash' in r.integration, false); assert.equal('id' in r.integration, false);
  assert.equal((await f.svc.act({ id: f.id, action: 'merge', payload: { phase: 'apply', review: r.integration.review } }, 8)).ok, false);
  const forged = await f.api.act({ id: f.id, action: 'merge', payload: { phase: 'apply', review: r.integration.review, reviewHash: 'a'.repeat(64) } });
  assert.equal(forged.code, 'VALIDATION'); assert.equal(f.dialogs.length, 0);
  const cancelled = await f.api.act({ id: f.id, action: 'merge', payload: { phase: 'apply', review: r.integration.review }, confirmed: true });
  assert.equal(cancelled.cancelled, true); assert.equal(f.dialogs.length, 1); assert.equal(f.h.task(f.id).state, 'in_review');
});
local('source edited during native review refuses application and preserves checkout', async t => {
  let f; f = await setup(t, { confirm: async () => { fs.appendFileSync(path.join(f.raw.worktree, 'integrated.js'), '// newer edit\n'); return true; } });
  const r = await f.preview(), applied = await f.apply(r.integration.review);
  assert.equal(applied.ok, false); assert.equal(applied.code, 'CONFLICT'); assert.match(applied.text, /review changed/);
  assert.equal(fs.existsSync(path.join(f.h.repo.checkout, 'integrated.js')), false); assert.equal(f.h.task(f.id).state, 'in_review');
});
local('closing and reopening the selected task during native confirmation retires the review', async t => {
  let release; const f = await setup(t, { confirm: () => new Promise(r => release = r) });
  const r = await f.preview(), pending = f.apply(r.integration.review); await waitFor(() => release);
  await f.api.close(); await f.api.open(f.id); release(true);
  assert.equal((await pending).ok, false); assert.equal(fs.existsSync(path.join(f.h.repo.checkout, 'integrated.js')), false);
});
local('dirty checkout preview has no Apply control and leaves user files intact', async t => {
  const f = await setup(t, { renderer: true }); fs.writeFileSync(path.join(f.h.repo.checkout, 'personal.txt'), 'preserve this\n');
  f.button('Review integration').click(); await waitFor(() => f.dom.window.document.querySelector('.integration-review'));
  assert.equal(f.button('Integrate reviewed changes…'), undefined); assert.match(f.dom.window.document.querySelector('.integration-review').textContent, /checkout has changes/);
  assert.equal(fs.readFileSync(path.join(f.h.repo.checkout, 'personal.txt'), 'utf8'), 'preserve this\n'); assert.equal(f.dialogs.length, 0);
});
local('double click consumes the main-owned review before one native confirmation and one integration', async t => {
  let release; const f = await setup(t, { renderer: true, confirm: () => new Promise(r => release = r) });
  f.button('Review integration').click(); await waitFor(() => f.button('Integrate reviewed changes…'));
  const button = f.button('Integrate reviewed changes…'); button.click(); button.click(); await waitFor(() => release);
  assert.equal(f.dialogs.length, 1); release(true); await waitFor(() => f.h.task(f.id).state === 'done'); assert.equal(f.dialogs.length, 1);
  await waitFor(() => f.dom.window.document.body.textContent.includes('Reviewed changes integrated.'));
});
for (const change of ['navigate', 'reload', 'blur', 'account', 'workspace', 'close']) local(`production Tasks wiring refuses a native dialog spanning ${change}`, async t => {
  let release; const f = await setup(t, { confirm: () => new Promise(r => release = r) });
  const r = await f.preview(), pending = f.apply(r.integration.review); await waitFor(() => release);
  if (change === 'close') f.authority.state.destroyed = true; else f.authority[change]();
  release(true); assert.equal((await pending).ok, false);
  assert.equal(fs.existsSync(path.join(f.h.repo.checkout, 'integrated.js')), false); assert.equal(f.h.task(f.id).state, 'in_review');
});
local('production prepared review cannot survive blur and refocus before Apply', async t => {
  const f = await setup(t), r = await f.preview(); f.authority.blur(); f.authority.refocus();
  assert.equal((await f.apply(r.integration.review)).ok, false); assert.equal(f.dialogs.length, 0); assert.equal(fs.existsSync(path.join(f.h.repo.checkout, 'integrated.js')), false);
});
local('production registrar refuses cached foreign senders, subframes and extra arguments before review', async t => {
  const f = await setup(t), handler = f.authority.handlers.get('tasks:act'), req = { id: f.id, action: 'merge', payload: { phase: 'preview' } };
  for (const event of [{ sender: {}, senderFrame: f.authority.wc.mainFrame }, { sender: f.authority.wc, senderFrame: {} }]) assert.equal((await handler(event, req)).ok, false);
  assert.equal((await handler(f.authority.event(), req, {})).ok, false); assert.equal(f.dialogs.length, 0); assert.equal(fs.existsSync(path.join(f.h.repo.checkout, 'integrated.js')), false);
});
local('only its own modal ticket permits focus restoration for the exact current Tasks document', async t => {
  let f; f = await setup(t, { confirm: async () => { f.authority.blur(); f.authority.refocus(); return true; } });
  const r = await f.preview(); assert.equal((await f.apply(r.integration.review)).ok, true); assert.equal(f.h.task(f.id).state, 'done');
});
local('lost post-dispatch reply reports uncertainty and cannot repeat an already applied integration', async t => {
  const f = await setup(t, { loseApplyReply: true }), r = await f.preview(), applied = await f.apply(r.integration.review);
  assert.equal(applied.ok, false); assert.match(applied.text, /receipt unconfirmed/);
  assert.equal(f.h.task(f.id).state, 'done'); assert.equal(fs.existsSync(path.join(f.h.repo.checkout, 'integrated.js')), true);
  assert.equal((await f.apply(r.integration.review)).ok, false); assert.equal(f.dialogs.length, 1);
});

async function peerTask(f, paths = []) {
  f.h.setScenario({ wait: true });
  const { id } = await f.h.client.createTask({ text: 'Parallel task to inspect', cwd: f.h.repo.checkout, ai: 'codex' });
  await waitFor(() => f.h.task(id)?.state === 'running');
  await waitFor(() => f.h.eng.engine.runs.get(id)?.toolInFlight);
  const task = f.h.task(id);
  // Controlled provider observation; the real temporary peer worktree holds
  // this independent writer's data. No real provider or teammate is contacted.
  for (const p of paths) { fs.mkdirSync(path.dirname(path.join(task.worktree, p)), { recursive: true }); fs.writeFileSync(path.join(task.worktree, p), 'peer work must survive\n'); }
  task.touched = [...paths];
  return task;
}
local('production renderer names overlapping local task claims and can open the exact task', async t => {
  const f = await setup(t, { renderer: true }), peer = await peerTask(f, ['integrated.js']);
  const claims = await f.h.client.getClaims(f.h.repo.checkout); assert.ok(claims.claims.some(c => c.taskId === peer.id));
  f.button('Review integration').click(); await waitFor(() => f.dom.window.document.querySelector('.integration-review'));
  const box = f.dom.window.document.querySelector('.integration-review');
  assert.match(box.textContent, /Other local tasks may still change/); assert.match(box.textContent, /Overlapping paths: integrated.js/);
  assert.equal(f.button('Integrate reviewed changes…'), undefined); assert.equal(f.dialogs.length, 0);
  f.button('Inspect task').click(); await waitFor(() => f.dom.window.document.body.textContent.includes('Parallel task to inspect'));
  assert.equal(fs.readFileSync(path.join(peer.worktree, 'integrated.js'), 'utf8'), 'peer work must survive\n');
  assert.equal(fs.existsSync(path.join(f.h.repo.checkout, 'integrated.js')), false);
});
local('native confirmation spanning a saved task decision requires a new exact review', async t => {
  let f; f = await setup(t, { confirm: async () => {
    const packet = f.h.task(f.id).checkpoint;
    await f.h.client.saveCheckpoint(f.id, packet.version, { brief: packet.brief, decisions: ['Use revised scope before integration'], progress: packet.progress, nextAction: packet.nextAction, artifacts: packet.artifacts, reportedChecks: packet.reportedChecks });
    return true;
  } });
  const r = await f.preview(), version = r.integration.coordination.decisionVersion;
  const applied = await f.apply(r.integration.review); assert.equal(applied.ok, false); assert.equal(applied.code, 'CONFLICT');
  assert.equal(f.h.task(f.id).checkpoint.version, version + 1); assert.equal(fs.existsSync(path.join(f.h.repo.checkout, 'integrated.js')), false);
  const renewed = await f.preview(); assert.equal(renewed.integration.coordination.decisionVersion, version + 1); assert.equal(renewed.integration.canApply, true);
});
local('a peer starting during the native confirmation retires review and exposes its unknown paths', async t => {
  let f, peer; f = await setup(t, { confirm: async () => { peer = await peerTask(f); return true; } });
  const r = await f.preview(), applied = await f.apply(r.integration.review);
  assert.equal(applied.ok, false); assert.equal(applied.code, 'CONFLICT'); assert.equal(fs.existsSync(path.join(f.h.repo.checkout, 'integrated.js')), false);
  const blocked = await f.preview(); assert.equal(blocked.integration.status, 'ownership'); assert.equal(blocked.integration.coordination.conflicts[0].taskId, peer.id);
  assert.equal(blocked.integration.coordination.conflicts[0].reason, 'paths-unconfirmed');
});
for (const state of ['handed_over', 'orphaned', 'unresponsive', 'failed']) local(`unconfirmed ${state} writer retains its claim until resolved`, async t => {
  const f = await setup(t), peer = await peerTask(f, ['integrated.js']);
  peer.state = state; peer.lastGreen = false; if (state === 'failed') peer.windowsStopUnconfirmed = true;
  const r = await f.preview(); assert.equal(r.integration.status, 'ownership'); assert.equal(r.integration.canApply, false);
  assert.ok((await f.h.client.getClaims(f.h.repo.checkout)).claims.some(c => c.taskId === peer.id));
  assert.equal(fs.readFileSync(path.join(peer.worktree, 'integrated.js'), 'utf8'), 'peer work must survive\n');
});
local('a peer that starts and finishes during native confirmation still retires the old ownership review', async t => {
  let f; f = await setup(t, { confirm: async () => {
    f.h.setScenario({});
    const { id } = await f.h.client.createTask({ text: 'Short independent peer', cwd: f.h.repo.checkout, ai: 'codex' });
    await waitFor(() => f.h.task(id)?.state === 'in_review');
    return true;
  } });
  const r = await f.preview(), applied = await f.apply(r.integration.review);
  assert.equal(applied.ok, false); assert.equal(applied.code, 'CONFLICT');
  assert.equal(fs.existsSync(path.join(f.h.repo.checkout, 'integrated.js')), false);
  const renewed = await f.preview(); assert.equal(renewed.integration.canApply, true);
});
