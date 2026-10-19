'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
async function setup(t) {
  const row = { id:'task-a',title:'Authentication',state:'in_review',label:'Needs review',tone:'purple',green:false,actions:['message'],confirm:[],ai:{id:'codex'},cost:{usd:0,budgetUsd:null},where:'project',branch:'task/a',workInPlace:false,createdAtMs:Date.now(),stateSinceMs:Date.now(),text:'Fix the sign-in form',messages:[],openApprovals:[],openAsk:null,
    checkpoint:{version:2,brief:'Fix sign-in',decisions:['Preserve Google sign-in'],progress:'Form updated',nextAction:'Review the redirect',artifacts:[],reportedChecks:['Sign-in smoke reported passing'],observed:{tests:'pass'},author:{kind:'human'}},evidence:{tests:'pass',summary:'Ready for review',diffStat:{files:1,added:4,removed:2}} };
  const state = { peers:[],checks:0,created:[],sent:[],folder:'folder-a',read:null,event:null,changed:null };
  const dom = new JSDOM(read('tasks.html'), {runScripts:'outside-only',pretendToBeVisual:true,url:'https://plexiform.invalid/tasks.html?embedded=1'});
  t.after(() => dom.window.close()); const w=dom.window,d=w.document;
  w.CSS ??= {}; w.CSS.escape ??= value => value; w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.tasksApi = {state:async()=>({conn:{status:'connected'},tasks:[row]}),open:async()=>({ok:true,detail:row,replay:[{type:'transcript',role:'assistant',text:'<img src=x onerror=bad()> Ready',turn:1,seq:1,partial:false},{type:'diff',files:[{path:'auth.js',status:'modified'}],stat:{files:1,added:4,removed:2}}]}),close:async()=>{},
    act:async req=>{state.sent.push(req);return {ok:true};},onChanged:fn=>state.changed=fn,onEvent:fn=>state.event=fn,
    composer:async()=>({ais:[],recent:[],canSchedule:false}),pickFolder:async()=>({handle:state.folder,label:'project'}),
    preflight:async req=>{state.checks++;return state.read?state.read(req):{ok:true,preflight:{checkedAt:Date.now(),peers:structuredClone(state.peers),note:'Known local Tasks only.'}};},
    create:async draft=>{state.created.push(draft);return {ok:true,id:'new-task'};}};
  w.eval(read('src/tasks-view.js'));w.eval(read('tasks.js'));await tick();
  const button = text=>[...d.querySelectorAll('button')].find(b=>b.textContent===text);
  return {state,w,d,button,row};
}
test('task overview connects reported result, changes and context to the exact task conversation',async t=>{
  const h=await setup(t);h.d.querySelector('[data-id="task-a"]').click();await tick();
  const pane=h.d.getElementById('pane-overview');assert.equal(pane.hidden,false);
  assert.match(pane.textContent,/auth\.js|Review the redirect/);assert.equal(pane.querySelector('img'),null);
  assert.match(pane.textContent,/not an independent verification/);
  h.button('Send a follow-up').click();const ta=h.d.getElementById('send-text');ta.value='Please check the redirect';ta.dispatchEvent(new h.w.Event('input'));h.d.getElementById('send-btn').click();await tick();
  assert.equal(h.state.sent[0].id,'task-a');assert.equal(h.state.sent[0].payload.body,'Please check the redirect');
});
test('composer keeps a waiting draft and requires review again if project work changes',async t=>{
  const h=await setup(t);h.state.peers=[{id:'peer',title:'Another task',state:'running',branch:'task/b',paths:['auth.js'],uncertain:false}];
  h.d.getElementById('new-task').click();await tick();h.button('Choose folder…').click();await tick();
  h.d.getElementById('c-text').value='Only change error copy';h.button('Keep draft and wait').click();
  assert.equal(h.d.getElementById('c-text').value,'Only change error copy');assert.equal(h.d.getElementById('c-go').disabled,true);assert.equal(h.state.created.length,0);
  h.button('Recheck project work').click();await tick();h.d.getElementById('c-work-reviewed').click();
  h.state.peers[0].paths.push('redirect.js');h.d.getElementById('c-go').click();await tick();
  assert.equal(h.state.created.length,0);assert.match(h.d.getElementById('c-err').textContent,/Project work changed/);
  h.d.getElementById('c-work-reviewed').click();h.d.getElementById('c-go').click();await tick();
  assert.equal(h.state.created.length,1);assert.equal(h.state.created[0].text,'Only change error copy');assert.equal(h.state.created[0].folder,'folder-a');
});
test('late folder inspection cannot reopen the composer after selecting a task',async t=>{
  const h=await setup(t);let resolve;h.state.read=()=>new Promise(r=>resolve=r);
  h.d.getElementById('new-task').click();await tick();h.button('Choose folder…').click();await tick();
  h.d.querySelector('[data-id="task-a"]').click();await tick();resolve({ok:true,preflight:{checkedAt:Date.now(),peers:[],note:'Known local Tasks only.'}});await tick();
  assert.ok(h.d.getElementById('pane-overview'));assert.equal(h.d.getElementById('c-go'),null);assert.equal(h.state.created.length,0);
});
