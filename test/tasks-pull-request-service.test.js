'use strict';
// Production Tasks renderer/preload/main authority/service + engine socket and
// real disposable Git. Codex and GitHub are isolated fixtures: no credentials,
// remote Git operations, provider charges or real pull requests.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { JSDOM } = require('jsdom');
const { createTasksService } = require('../src/tasks-service');
const { createTasksWindowAuthority } = require('./helpers/tasks-window-authority');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
const local = process.platform === 'win32' ? test.skip : test;
const TITLE = 'Reviewed <img src=x onerror=globalThis.bad=1> draft';
const BODY = 'Exact reviewed description.\n\n<script>globalThis.bad=1</script>';
let fixture, waitFor;
test.before(async () => {
  ({ startCodexFixture: fixture } = await import('../board/tasks-engine/test/codex-helpers.js'));
  ({ waitFor } = await import('../board/tasks-engine/test/helpers.js'));
});

async function setup(t, { confirm = async () => true, renderer = false, loseApplyReply = false, holdApplyReply = false } = {}) {
  let h, svc, dom, id;
  const calls = [], listeners = new Map(), state = { user: { id: 42, login: 'fixture-user' }, repo: 'fixture/app', pulls: [], failReply: false, postStatus: 201 };
  const persisted = () => fs.readFileSync(path.join(h.dataDir, 'store', 'tasks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.task?.id === id).at(-1).task;
  const apiFixture = async (method, endpoint, body) => {
    calls.push({ method, endpoint, ...(body ? { body: structuredClone(body) } : {}) });
    await state.onCall?.(method, endpoint);
    if (method === 'POST') {
      const saved = persisted();
      assert.equal(saved.prAttempt.status, 'dispatching', 'real task journal is durable before outbound creation');
      assert.equal(saved.prAttempt.head, state.remoteHead);
      assert.equal(Object.hasOwn(saved.prAttempt, 'body'), false, 'attempt retains hashes, not reviewed description');
      assert.equal(Object.hasOwn(saved.prAttempt, 'title'), false);
      const pr = { number: 12, html_url: `https://github.com/${state.repo}/pull/12`, state: 'open', draft: true, title: body.title, body: body.body, user: state.user,
        head: { ref: state.branch, sha: state.remoteHead, repo: { full_name: state.repo } }, base: { ref: state.base, sha: state.remoteBase, repo: { full_name: state.repo } } };
      if (state.postStatus === 201) state.pulls.push(pr);
      if (state.failReply) throw Error('synthetic lost POST reply');
      return { status: state.postStatus, body: pr };
    }
    if (endpoint === 'user') return { status: 200, body: state.user };
    if (endpoint === `repos/${state.repo}`) return { status: 200, body: { id: 91, full_name: state.repo, permissions: { push: true }, archived: false } };
    if (endpoint.includes('/git/ref/heads/')) {
      const ref = decodeURIComponent(endpoint.split('/git/ref/heads/')[1]);
      return { status: 200, body: { ref: `refs/heads/${ref}`, object: { type: 'commit', sha: ref === state.branch ? state.remoteHead : state.remoteBase } } };
    }
    if (endpoint.includes('/pulls?')) return { status: 200, body: state.pulls };
    return { status: 404, body: null };
  };
  h = await fixture({}, { githubConnect: async () => apiFixture });
  t.after(async () => { svc?.stop(); listeners.clear(); await h.cleanup(); await new Promise(r => setImmediate(r)); dom?.window.close(); });
  ({ id } = await h.client.createTask({ text: 'Synthetic Tasks pull request', cwd: h.repo.checkout, ai: 'codex' }));
  await waitFor(() => h.task(id)?.state === 'in_review');
  const raw = await h.client.getTask(id);
  git(h.repo.checkout, 'remote', 'add', 'origin', 'git@github.com:fixture/app.git');
  fs.writeFileSync(path.join(raw.worktree, 'published.js'), 'export const published = "<img src=x onerror=globalThis.bad=1>";\n');
  git(raw.worktree, 'add', '-A'); git(raw.worktree, 'commit', '-qm', 'Synthetic reviewed change');
  Object.assign(state, { branch: raw.branch, base: raw.baseBranch, remoteHead: git(raw.worktree, 'rev-parse', 'HEAD'), remoteBase: git(h.repo.checkout, 'rev-parse', raw.baseBranch) });
  const send = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn({}, ...structuredClone(args)); };
  const authority = createTasksWindowAuthority({ service: () => svc, confirm });
  let loadApi;
  if (loseApplyReply || holdApplyReply) {
    const [client, P, face] = await Promise.all([import('../board/tasks-api/client.js'), import('../board/tasks-api/protocol.js'), import('../board/tasks-api/face.js')]);
    loadApi = async () => ({ P, taskFace: face.taskFace, client: { connect: async options => {
      const c = await client.connect(options), act = c.act.bind(c);
      c.act = async (...args) => {
        const result = await act(...args);
        if (args[1] === 'openPr' && args[2]?.phase === 'apply') {
          if (loseApplyReply) throw Object.assign(Error('synthetic lost socket response'), { code: 'TIMEOUT' });
          await new Promise(resolve => { state.releaseApplyReply = resolve; });
          result.task = { ...result.task, title: 'LATE-CACHE-CANARY' };
        }
        return result;
      };
      return c;
    } } });
  }
  const startService = async () => {
    svc = createTasksService({ boardHome: h.dataDir, confirmDialog: authority.confirmDialog, ...(loadApi ? { loadApi } : {}),
      onChange: snap => send('tasks:changed', snap), onEvent: (_wc, taskId, event) => send('tasks:event', { id: taskId, event }) });
    svc.start(); await waitFor(() => svc.snapshot().conn.status === 'connected');
  };
  await startService();
  let api;
  vm.runInNewContext(read('tasks-preload.js'), { require: () => ({ contextBridge: { exposeInMainWorld(name, value) { if (name === 'tasksApi') api = value; } }, ipcRenderer: {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    async invoke(name, ...args) { if (name === 'tasks:act') return authority.handlers.get(name)(authority.event(), ...structuredClone(args)); return ({ 'tasks:state': () => svc.snapshot(), 'tasks:open': taskId => svc.openTask(taskId, 7), 'tasks:close': () => svc.closeTask(7) })[name](...structuredClone(args)); },
  } }) });
  const f = { h, get svc() { return svc; }, api, id, raw, state, calls, persisted, authority, dialogs: authority.dialogs,
    posts: () => calls.filter(c => c.method === 'POST'),
    preview: () => api.act({ id, action: 'openPr', payload: { phase: 'preview', title: TITLE, body: BODY } }),
    apply: review => api.act({ id, action: 'openPr', payload: { phase: 'apply', review } }),
    receipt: () => api.act({ id, action: 'openPr', payload: { phase: 'receipt' } }),
    restart: async () => { svc.stop(); await h.restart(); await startService(); await api.open(id); },
  };
  if (renderer) {
    dom = new JSDOM(read('tasks.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://plexiform.invalid/tasks.html?embedded=1' });
    dom.window.tasksApi = api; dom.window.CSS ??= {}; dom.window.CSS.escape ??= value => String(value).replace(/[^\w-]/g, '\\$&');
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.eval(read('src/tasks-view.js')); dom.window.eval(read('tasks.js'));
    await waitFor(() => dom.window.document.querySelector(`[data-id="${id}"]`)); dom.window.document.querySelector(`[data-id="${id}"]`).click();
    f.dom = dom; f.button = text => [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === text);
    await waitFor(() => f.button('Prepare draft pull request'));
    f.reviewInRenderer = async () => {
      f.button('Prepare draft pull request').click(); const doc = dom.window.document;
      for (const [name, value] of [['Pull request title', TITLE], ['Pull request description', BODY]]) { const input = doc.querySelector(`[aria-label="${name}"]`); input.value = value; input.dispatchEvent(new dom.window.Event('input')); }
      f.button('Review draft pull request').click(); await waitFor(() => f.button('Create reviewed draft…'));
    };
  } else await api.open(id);
  return f;
}

local('Tasks renderer reviews exact GitHub destination, published diff and literal text before one native confirmation', async t => {
  const f = await setup(t, { renderer: true }); await f.reviewInRenderer();
  const box = f.dom.window.document.querySelector('.pr-review');
  assert.equal(f.dialogs.length, 0); assert.equal(f.posts().length, 0);
  assert.match(box.textContent, /fixture-user · fixture\/app/); assert.ok(box.textContent.includes(`${f.state.branch} → ${f.state.base}`));
  assert.ok(box.textContent.includes(f.state.remoteHead)); assert.ok(box.textContent.includes(f.state.remoteBase));
  assert.equal(box.querySelector('h4').textContent, TITLE); const shownBody = box.querySelector('pre').textContent;
  assert.ok(shownBody.startsWith(BODY)); assert.match(shownBody, /<!-- plexiform-task:/); assert.match(box.querySelector('.diff').textContent, /export const published/);
  assert.equal(box.querySelector('img,script'), null); assert.equal(f.dom.window.bad, undefined);
  f.button('Create reviewed draft…').click(); await waitFor(() => f.h.task(f.id).state === 'done');
  await waitFor(() => f.dom.window.document.querySelector('.pr-review')?.textContent.includes('Pull request #12'));
  assert.equal(f.posts().length, 1); assert.deepEqual(f.posts()[0].body, { title: TITLE, body: shownBody, head: f.state.branch, base: f.state.base, draft: true, maintainer_can_modify: false });
  assert.equal(f.dialogs.length, 1); assert.ok(f.dialogs[0].detail.includes(TITLE)); assert.ok(f.dialogs[0].detail.includes(shownBody)); assert.ok(f.dialogs[0].detail.includes(f.state.remoteHead));
  assert.equal(f.h.task(f.id).outcome, 'pr_opened'); assert.equal(git(f.raw.worktree, 'rev-parse', 'HEAD'), f.state.remoteHead); assert.equal(git(f.raw.worktree, 'status', '--porcelain'), '');
});

local('native cancellation creates nothing, consumes the review and allows a fresh explicit draft', async t => {
  const f = await setup(t, { renderer: true, confirm: async () => false }); await f.reviewInRenderer(); f.button('Create reviewed draft…').click();
  await waitFor(() => f.dialogs.length === 1 && f.button('Create reviewed draft…')?.disabled === false);
  assert.equal(f.posts().length, 0); assert.equal(f.h.task(f.id).state, 'in_review'); assert.equal(f.persisted().prAttempt, undefined);
  f.button('Create reviewed draft…').click(); await waitFor(() => f.button('Create reviewed draft…')?.disabled === false); assert.equal(f.dialogs.length, 1); assert.equal(f.posts().length, 0);
  assert.equal((await f.preview()).pullRequest.status, 'review');
});

local('main-owned review handle hides engine IDs and rejects destination, text, hash and native-approval injection', async t => {
  const f = await setup(t, { confirm: async () => false }), r = await f.preview();
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.pullRequest.status, 'review'); assert.match(r.pullRequest.review, /^[0-9a-f-]{36}$/);
  for (const key of ['id','hash','reviewHash','reviewId','token','socket']) assert.equal(key in r.pullRequest, false);
  for (const extra of [{ repo:'other/repo' }, { title:'Substituted' }, { body:'Substituted' }, { reviewId:'forged' }, { reviewHash:'f'.repeat(64) }, { confirm:true }]) {
    assert.equal((await f.api.act({ id:f.id,action:'openPr',payload:{phase:'apply',review:r.pullRequest.review,...extra} })).ok, false);
  }
  assert.equal((await f.svc.act({id:f.id,action:'openPr',payload:{phase:'apply',review:r.pullRequest.review}},8)).ok,false);
  assert.equal(f.dialogs.length,0);assert.equal(f.posts().length,0);
  assert.equal((await f.api.act({id:f.id,action:'openPr',payload:{phase:'apply',review:r.pullRequest.review},confirmed:true})).cancelled,true);
  assert.equal(f.dialogs.length,1);assert.equal(f.posts().length,0);
});

for (const change of ['navigate','reload','blur','account','workspace','close','reopen']) local(`production PR confirmation cannot span ${change}`, async t => {
  let release; const f = await setup(t,{confirm:()=>new Promise(r=>release=r)}),r=await f.preview(),pending=f.apply(r.pullRequest.review);
  await waitFor(()=>release);
  if(change==='close')f.authority.state.destroyed=true;
  else if(change==='reopen'){await f.api.close();await f.api.open(f.id);}
  else f.authority[change]();
  release(true);assert.equal((await pending).ok,false);assert.equal(f.posts().length,0);assert.equal(f.h.task(f.id).state,'in_review');assert.equal(f.persisted().prAttempt,undefined);
});
local('only its own native modal permits blur and refocus, while a prepared review is retired by an unrelated blur',async t=>{
  let f;f=await setup(t,{confirm:async()=>{f.authority.blur();f.authority.refocus();return true;}});
  let r=await f.preview();f.authority.blur();f.authority.refocus();assert.equal((await f.apply(r.pullRequest.review)).ok,false);assert.equal(f.dialogs.length,0);
  r=await f.preview();assert.equal((await f.apply(r.pullRequest.review)).pullRequest.status,'created');assert.equal(f.posts().length,1);
});

for(const change of ['remoteHead','remoteBase','account','localEdit','origin'])local(`changed ${change} during native confirmation prevents a GitHub POST`,async t=>{
  let f;f=await setup(t,{confirm:async()=>{if(change==='account')f.state.user={id:43,login:'replacement-user'};else if(change==='localEdit')fs.appendFileSync(path.join(f.raw.worktree,'published.js'),'// later local edit\n');else if(change==='origin')git(f.raw.worktree,'remote','set-url','origin','git@github.com:other/repo.git');else f.state[change]='a'.repeat(40);return true;}});
  const r=await f.preview(),out=await f.apply(r.pullRequest.review);assert.equal(f.posts().length,0);assert.equal(f.h.task(f.id).state,'in_review');assert.equal(out.ok,false);assert.equal(out.pullRequest,undefined,'known pre-dispatch conflict does not claim uncertain creation');assert.equal(f.persisted().prAttempt,undefined);
});

local('lost GitHub response persists an uncertain receipt across engine restart and recovers without another creation',async t=>{
 const f=await setup(t);f.state.failReply=true;const r=await f.preview(),out=await f.apply(r.pullRequest.review);
 assert.equal(out.pullRequest.status,'unconfirmed');assert.equal(f.posts().length,1);assert.equal(f.persisted().prAttempt.status,'dispatching');assert.equal(f.h.task(f.id).state,'in_review');
 await f.restart();assert.equal((await f.preview()).pullRequest.status,'unconfirmed');assert.equal(f.posts().length,1);
 const recovered=await f.receipt();assert.equal(recovered.pullRequest.status,'created');assert.equal(recovered.pullRequest.url,'https://github.com/fixture/app/pull/12');assert.equal(f.persisted().prAttempt.status,'created');assert.equal(f.h.task(f.id).outcome,'pr_opened');assert.equal(f.posts().length,1);
 assert.equal((await f.apply(r.pullRequest.review)).ok,false);assert.equal(f.posts().length,1);
});
local('lost socket response after a durable created receipt cannot duplicate the PR',async t=>{
 const f=await setup(t,{loseApplyReply:true}),r=await f.preview(),out=await f.apply(r.pullRequest.review);assert.equal(out.pullRequest.status,'unconfirmed');assert.equal(f.persisted().prAttempt.status,'created');assert.equal(f.h.task(f.id).state,'done');assert.equal(f.posts().length,1);
 assert.equal((await f.apply(r.pullRequest.review)).ok,false);assert.equal((await f.preview()).ok,false);assert.equal(f.posts().length,1);assert.equal(f.dialogs.length,1);
});
local('foreign sender, subframe and extra IPC arguments cannot reach PR review',async t=>{
 const f=await setup(t),handler=f.authority.handlers.get('tasks:act'),request={id:f.id,action:'openPr',payload:{phase:'preview',title:TITLE,body:BODY}};
 for(const event of [{sender:{},senderFrame:f.authority.wc.mainFrame},{sender:f.authority.wc,senderFrame:{}}])assert.equal((await handler(event,request)).ok,false);
 assert.equal((await handler(f.authority.event(),request,{})).ok,false);assert.equal(f.calls.length,0);assert.equal(f.dialogs.length,0);
});
local('double-clicked reviewed draft opens one native dialog and creates one PR',async t=>{
 let release;const f=await setup(t,{renderer:true,confirm:()=>new Promise(r=>release=r)});await f.reviewInRenderer();const b=f.button('Create reviewed draft…');b.click();b.click();await waitFor(()=>release);assert.equal(f.dialogs.length,1);release(true);await waitFor(()=>f.h.task(f.id).state==='done');assert.equal(f.posts().length,1);
});
local('the actual task journal directory barrier completes before outbound PR creation',async t=>{
 const f=await setup(t),r=await f.preview(),fsp=require('node:fs/promises'),original=fsp.open,synced=[];
 fsp.open=async(...args)=>{const handle=await original(...args),sync=handle.sync.bind(handle);handle.sync=async()=>{const out=await sync();synced.push(String(args[0]));return out;};return handle;};
 let beforePost;
 f.state.onCall=(method)=>{if(method==='POST')beforePost=[...synced];};
 try{const out=await f.apply(r.pullRequest.review);assert.equal(out.pullRequest.status,'created');assert.ok(beforePost?.includes(path.join(f.h.dataDir,'store')),'fsync of dataDir alone does not make store/tasks.jsonl creation or compaction durable');}
 finally{fsp.open=original;}
});
local('late socket success after navigation cannot publish its receipt or overwrite the main cache',async t=>{
 const f=await setup(t,{holdApplyReply:true}),r=await f.preview(),pending=f.apply(r.pullRequest.review);
 await waitFor(()=>f.state.releaseApplyReply);await waitFor(()=>f.svc.snapshot().tasks.find(row=>row.id===f.id)?.state==='done');
 f.authority.navigate();f.state.releaseApplyReply();const out=await pending;
 assert.equal(out.ok,false);assert.equal(out.pullRequest,undefined);assert.equal(f.posts().length,1);assert.equal(f.persisted().prAttempt.status,'created');
 assert.notEqual(f.svc.snapshot().tasks.find(row=>row.id===f.id).title,'LATE-CACHE-CANARY');
});
