'use strict';
// Shipped renderer/preload/main/socket with controlled native dialog and CLI.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createTasksService } = require('../src/tasks-service');
const { createTasksWindowAuthority } = require('./helpers/tasks-window-authority');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
let fixture, waitFor;
test.before(async () => {
  ({ providerFixture: fixture } = await import('../board/tasks-engine/test/provider-switch-helpers.js'));
  ({ waitFor } = await import('../board/tasks-engine/test/helpers.js'));
});
const local = process.platform === 'win32' ? test.skip : test;
async function setup(t, { confirm = async () => true, renderer = false, loseApplyReply = false } = {}) {
  const h = await fixture(); let svc, dom;
  const listeners = new Map();
  t.after(async () => { svc?.stop(); listeners.clear(); await h.cleanup(); await new Promise(r => setImmediate(r)); dom?.window.close(); });
  const id = await h.parked(), raw = await h.client.getTask(id);
  const send = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn({}, ...structuredClone(args)); };
  const authority = createTasksWindowAuthority({ service: () => svc, confirm });
  let loadApi;
  if (loseApplyReply) {
    const [client, P, face] = await Promise.all([import('../board/tasks-api/client.js'), import('../board/tasks-api/protocol.js'), import('../board/tasks-api/face.js')]);
    loadApi = async () => ({ P, taskFace: face.taskFace, client: { connect: async options => {
      const c = await client.connect(options), act = c.act.bind(c);
      c.act = async (...args) => { const result = await act(...args); if (args[1] === 'switchAi' && args[2]?.phase === 'apply') throw Object.assign(new Error('synthetic lost post-dispatch reply'), { code: 'TIMEOUT' }); return result; };
      return c;
    } } });
  }
  svc = createTasksService({ boardHome: h.dataDir, confirmDialog: authority.confirmDialog, ...(loadApi ? { loadApi } : {}),
    onChange: snap => send('tasks:changed', snap), onEvent: (_wc, taskId, event) => send('tasks:event', { id: taskId, event }) });
  svc.start(); await waitFor(() => svc.snapshot().conn.status === 'connected');
  let api;
  vm.runInNewContext(read('tasks-preload.js'), { require: () => ({ contextBridge: { exposeInMainWorld(name, value) { if (name === 'tasksApi') api = value; } }, ipcRenderer: {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    async invoke(name, ...args) { if (name === 'tasks:act') return authority.handlers.get(name)(authority.event(), ...structuredClone(args)); return ({ 'tasks:state': () => svc.snapshot(), 'tasks:open': id => svc.openTask(id, 7), 'tasks:close': () => svc.closeTask(7) })[name](...structuredClone(args)); },
  } }) });
  const f = { h, svc, api, id, raw, authority, dialogs: authority.dialogs, preview: () => api.act({ id, action: 'switchAi', payload: { phase: 'preview', ai: 'codex' } }), apply: review => api.act({ id, action: 'switchAi', payload: { phase: 'apply', review } }) };
  if (renderer) {
    dom = new JSDOM(read('tasks.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://plexiform.invalid/tasks.html?embedded=1' });
    dom.window.tasksApi = api; dom.window.CSS ??= {}; dom.window.CSS.escape ??= value => String(value).replace(/[^\w-]/g, '\\$&');
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.eval(read('src/tasks-view.js')); dom.window.eval(read('tasks.js'));
    await waitFor(() => dom.window.document.querySelector(`[data-id="${id}"]`)); dom.window.document.querySelector(`[data-id="${id}"]`).click();
    await waitFor(() => [...dom.window.document.querySelectorAll('button')].some(b => b.textContent === 'Continue with Codex'));
    f.dom = dom; f.button = text => [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === text);
  } else await api.open(id);
  return f;
}
local('actual provider handover review shows source diff, context and target, then requires native confirmation', async t => {
  let allow = false; const f = await setup(t, { renderer: true, confirm: async () => allow });
  f.button('Continue with Codex').click(); await waitFor(() => f.button('Start reviewed Codex session…'));
  assert.equal(f.h.log().length, 0); assert.equal(f.dialogs.length, 0);
  const box = f.dom.window.document.querySelector('.provider-review');
  assert.match(box.textContent, /Claude.*Codex/); assert.match(box.textContent, /original contribution/); assert.match(box.textContent, /Permission: auto-edits/);
  f.button('Start reviewed Codex session…').click(); await waitFor(() => f.dialogs.length === 1 && !f.button('Start reviewed Codex session…') && !f.button('Continue with Codex')?.disabled);
  assert.equal(f.h.log().length, 0); assert.equal(f.h.task(f.id).ai.id, 'claude');
  f.button('Continue with Codex').click(); await waitFor(() => f.button('Start reviewed Codex session…')); allow = true;
  f.button('Start reviewed Codex session…').click(); await waitFor(() => f.h.task(f.id).state === 'in_review');
  assert.match(f.dialogs.at(-1).detail, /new Codex session/); assert.equal(f.h.task(f.id).providerTransitions.length, 1);
  assert.equal(fs.readFileSync(path.join(f.raw.worktree, 'original.txt'), 'utf8'), 'original contribution\n');
});
for (const change of ['files', 'account', 'workspace', 'reload', 'navigate', 'close-task']) local(`native handover spanning ${change} cannot launch the new provider`, async t => {
  let release; const f = await setup(t, { confirm: () => new Promise(r => release = r) }), r = await f.preview();
  assert.equal(r.ok, true); const pending = f.apply(r.providerChange.review); await waitFor(() => release);
  if (change === 'files') fs.appendFileSync(path.join(f.raw.worktree, 'original.txt'), 'later user edit\n');
  else if (change === 'close-task') { await f.api.close(); await f.api.open(f.id); }
  else f.authority[change]();
  release(true); const applied = await pending; assert.equal(applied.ok, false); assert.equal(f.h.log().length, 0); assert.equal(f.h.task(f.id).ai.id, 'claude');
});
local('renderer cannot forge helper review fields or duplicate a consumed handover confirmation', async t => {
  let release; const f = await setup(t, { confirm: () => new Promise(r => release = r) }), r = await f.preview();
  assert.equal('id' in r.providerChange, false); assert.equal('hash' in r.providerChange, false);
  const forged = await f.api.act({ id: f.id, action: 'switchAi', payload: { phase: 'apply', review: r.providerChange.review, ai: 'claude' }, confirmed: true });
  assert.equal(forged.ok, false); assert.equal(f.dialogs.length, 0);
  const pending = f.apply(r.providerChange.review); await waitFor(() => release);
  assert.equal((await f.apply(r.providerChange.review)).ok, false); assert.equal(f.dialogs.length, 1);
  release(true); assert.equal((await pending).ok, true); await waitFor(() => f.h.task(f.id).state === 'in_review');
  assert.equal(f.h.task(f.id).providerTransitions.length, 1);
});
local('lost provider handover acknowledgement reports uncertainty and never reuses its review', async t => {
  const f = await setup(t, { loseApplyReply: true }), r = await f.preview(), applied = await f.apply(r.providerChange.review);
  assert.equal(applied.ok, false); assert.match(applied.text, /receipt unconfirmed/);
  await waitFor(() => f.h.task(f.id).state === 'in_review'); assert.equal(f.h.task(f.id).providerTransitions.length, 1);
  assert.equal((await f.apply(r.providerChange.review)).ok, false); assert.equal(f.dialogs.length, 1);
});
