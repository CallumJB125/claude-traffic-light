'use strict';
// Production preload/registrar/service/socket and real Tasks engine. The provider
// and native dialog are controlled fixtures; these are not installed-app receipts.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createTasksService } = require('../src/tasks-service');
const { createTasksWindowAuthority } = require('./helpers/tasks-window-authority');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const local = process.platform === 'win32' ? test.skip : test;
let fixture, waitFor;
test.before(async () => {
  ({ startCodexFixture: fixture } = await import('../board/tasks-engine/test/codex-helpers.js'));
  ({ waitFor } = await import('../board/tasks-engine/test/helpers.js'));
});
async function setup(t, { confirm = async () => true, renderer = false, launch } = {}) {
  const h = await fixture({ wait: true, waitFirstOnly: true }); let svc, dom;
  const listeners = new Map(), launched = [];
  t.after(async () => { svc?.stop(); listeners.clear(); await h.cleanup(); dom?.window.close(); });
  const { id } = await h.client.createTask({ text: 'Continue exact task in Terminal', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
  await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
  const authority = createTasksWindowAuthority({ service: () => svc, confirm });
  const send = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn({}, ...structuredClone(args)); };
  svc = createTasksService({ boardHome: h.dataDir, confirmDialog: authority.confirmDialog,
    launchTerminal: async (descriptor, current) => { assert.equal(current(), true); launched.push(structuredClone(descriptor)); return launch ? launch(descriptor) : { status: 'requested' }; },
    onChange: snap => send('tasks:changed', snap), onEvent: (_wc, taskId, event) => send('tasks:event', { id: taskId, event }) });
  svc.start(); await waitFor(() => svc.snapshot().conn.status === 'connected');
  let api;
  vm.runInNewContext(read('tasks-preload.js'), { require: () => ({ contextBridge: { exposeInMainWorld(name, value) { if (name === 'tasksApi') api = value; } }, ipcRenderer: {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    async invoke(name, ...args) { if (authority.handlers.has(name)) return authority.handlers.get(name)(authority.event(), ...structuredClone(args)); return ({ 'tasks:state': () => svc.snapshot(), 'tasks:open': id => svc.openTask(id, 7), 'tasks:close': () => svc.closeTask(7), 'tasks:copy-takeover': id => svc.copyTakeover(id) })[name](...structuredClone(args)); },
  } }) });
  if (renderer) {
    dom = new JSDOM(read('tasks.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://plexiform.invalid/tasks.html?embedded=1' });
    dom.window.tasksApi = api; dom.window.CSS ??= {}; dom.window.CSS.escape ??= String; dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.eval(read('src/tasks-view.js')); dom.window.eval(read('tasks.js'));
    await waitFor(() => dom.window.document.querySelector(`[data-id="${id}"]`)); dom.window.document.querySelector(`[data-id="${id}"]`).click();
    await waitFor(() => dom.window.document.querySelector('.d-actions'));
  } else await api.open(id);
  return { h, id, api, svc, authority, launched, dom, button: text => [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === text) };
}

local('Tasks terminal review can cancel, launches one exact session, and hands back after exit', async t => {
  let allowOpen = false;
  const f = await setup(t, { renderer: true, confirm: async options => options.message !== 'Open in Terminal?' || allowOpen });
  f.button('Take over in terminal').click(); await waitFor(() => f.button('Open in Terminal…'));
  assert.equal(f.h.task(f.id).state, 'handed_over');
  f.button('Open in Terminal…').click(); await waitFor(() => f.authority.dialogs.length === 2 && !f.button('Open in Terminal…').disabled);
  assert.equal(f.launched.length, 0);
  allowOpen = true; f.button('Open in Terminal…').click(); await waitFor(() => f.launched.length === 1);
  const openDialog = f.authority.dialogs.find(d => d.message === 'Open in Terminal?');
  assert.ok(openDialog && openDialog.detail.length <= 800, 'Open in Terminal sheet keeps its detail short enough to fit on screen');
  assert.equal(f.launched[0].sessionId, f.h.task(f.id).sessionId);
  assert.ok(f.launched[0].argv.includes('resume')); assert.ok(f.launched[0].argv.includes('--ignore-user-config'));
  assert.equal((await f.api.openTerminal(f.id)).ok, false); assert.equal(await f.api.copyTakeover(f.id), false);
  assert.equal(f.launched.length, 1);
  const back = await f.api.act({ id: f.id, action: 'handback', payload: {} }); assert.equal(back.ok, true);
  await waitFor(() => f.h.task(f.id)?.state === 'in_review');
});

for (const change of ['account', 'workspace', 'reload', 'navigate']) local(`terminal native review spanning ${change} cannot dispatch`, async t => {
  let release;
  const f = await setup(t, { confirm: options => options.message === 'Open in Terminal?' ? new Promise(resolve => release = resolve) : true });
  assert.equal((await f.api.act({ id: f.id, action: 'takeover', payload: {} })).takeover.canOpen, true);
  const pending = f.api.openTerminal(f.id); await waitFor(() => release); f.authority[change](); release(true);
  assert.equal((await pending).ok, false); assert.equal(f.launched.length, 0);
});

local('terminal launch consumes an uncertain result and rechecks the authoritative session', async t => {
  const f = await setup(t, { launch: () => ({ status: 'unconfirmed' }) });
  await f.api.act({ id: f.id, action: 'takeover', payload: {} });
  const original = f.h.task(f.id).sessionId; f.h.task(f.id).sessionId = 'changed-session';
  assert.equal((await f.api.openTerminal(f.id)).ok, false); assert.equal(f.launched.length, 0);
  f.h.task(f.id).sessionId = original;
  assert.equal((await f.api.openTerminal(f.id)).status, 'unconfirmed');
  assert.equal((await f.api.openTerminal(f.id)).ok, false); assert.equal(f.launched.length, 1);
});

local('Claude terminal takeover retains an unapproved plan restriction', async t => {
  const { startEngine, makeRepo, tmpDir, rm } = await import('../board/tasks-engine/test/helpers.js');
  const root = tmpDir(), repo = makeRepo(root);
  const h = await startEngine({ dir: root, scenario: { steps: [{ tool: 'Read', input: { file_path: 'README.md' }, ms: 60000 }] } });
  t.after(async () => { await h.close(); rm(root); });
  const { id } = await h.client.createTask({ text: 'Plan before changes', cwd: repo.checkout, ai: 'claude', planFirst: true, permissionLevel: 'auto-edits' });
  await waitFor(() => h.eng.tasks.get(id)?.state === 'running');
  const result = await h.client.act(id, 'takeover', { mode: 'print' });
  const mode = result.takeover.argv.indexOf('--permission-mode');
  assert.equal(result.takeover.argv[mode + 1], 'plan');
});
