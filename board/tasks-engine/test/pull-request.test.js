// Real disposable Git repositories and an isolated GitHub API fixture.
// No credentials, network, pushes, live pull requests or provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTaskPullRequest } from '../pull-request.js';
import { makeRepo, tmpDir, rm } from './helpers.js';
const git = (cwd,...args) => execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const posix = process.platform === 'win32' ? test.skip : test;
function fixture(t) {
  const dir=fs.realpathSync(tmpDir('btp-'));t.after(()=>rm(dir));const {checkout}=makeRepo(dir),base=git(checkout,'rev-parse','HEAD'),wt=path.join(dir,'task');
  git(checkout,'remote','add','origin','git@github.com:fixture/app.git');git(checkout,'worktree','add','-qb','task',wt);
  fs.writeFileSync(path.join(wt,'task.js'),'export const ready = true;\n');git(wt,'add','.');git(wt,'commit','-qm','task');
  const head=git(wt,'rev-parse','HEAD'),task={id:'tsk_0123456789ab',state:'in_review',stateSince:1,sessionId:'s',repo:{root:checkout},worktree:wt,gitDir:git(wt,'rev-parse','--absolute-git-dir'),gitRef:'refs/heads/task',branch:'task',baseBranch:'main',baseSha:base,worktreeCreated:true,workInPlace:false};
  const calls=[],state={now:1000,user:{id:42,login:'fixture-user'},remoteHead:head,remoteBase:base,postStatus:201,failReply:false,pulls:[],saved:[],current:true};
  const api=async(method,endpoint,body)=>{
    calls.push({method,endpoint,...(body?{body}:{})});state.onCall?.(method,endpoint);
    if(method==='POST'){
      assert.equal(state.saved.at(-1)?.status,'dispatching','attempt persisted before the request');
      const p={number:8,html_url:'https://github.com/fixture/app/pull/8',state:'open',draft:true,title:body.title,body:body.body,user:state.user,head:{ref:'task',sha:state.remoteHead,repo:{full_name:'fixture/app'}},base:{ref:'main',sha:state.remoteBase,repo:{full_name:'fixture/app'}}};
      if(state.postStatus===201)state.pulls.push(p);
      if(state.failReply)throw Error('synthetic lost response');return{status:state.postStatus,body:p};
    }
    if(endpoint==='user')return{status:200,body:state.user};
    if(endpoint==='repos/fixture/app')return{status:200,body:{id:99,full_name:'fixture/app',permissions:{push:true},archived:false}};
    if(endpoint.includes('/git/ref/heads/')){const branch=endpoint.split('/').at(-1);return{status:200,body:{ref:`refs/heads/${branch}`,object:{type:'commit',sha:branch==='task'?state.remoteHead:state.remoteBase}}};}
    if(endpoint.includes('/pulls?'))return{status:200,body:state.pulls};
    return{status:404};
  };
  const options={gitBin:execFileSync('which',['git'],{encoding:'utf8'}).trim(),env:{PATH:process.env.PATH,HOME:dir},dataDir:dir,now:()=>state.now,connect:async()=>api};
  const helper=createTaskPullRequest(options),current=()=>state.current,save=()=>state.saved.push(structuredClone(task.prAttempt));
  return{dir,wt,checkout,task,state,calls,options,helper,save,current,
    preview:()=>helper.preview(task,{title:'Review task change',body:'This is the explicitly reviewed draft description.'},current),
    apply:r=>helper.apply(task,r.id,r.hash,current,save)};
}
posix('review then create one exact draft PR for the published branch without touching Git',async t=>{
  const f=fixture(t),before=git(f.wt,'rev-parse','HEAD'),index=fs.readFileSync(path.join(f.task.gitDir,'index'));
  const r=await f.preview();assert.equal(r.status,'review');assert.match(r.patch,/export const ready/);assert.equal(r.repo,'fixture/app');assert.equal(r.account,'fixture-user');assert.equal(f.calls.some(x=>x.method==='POST'),false);
  const out=await f.apply(r);assert.equal(out.status,'created');assert.equal(out.draft,true);assert.equal(out.changed,false);assert.equal(out.url,'https://github.com/fixture/app/pull/8');
  const posts=f.calls.filter(x=>x.method==='POST');assert.equal(posts.length,1);assert.deepEqual(posts[0].body,{title:r.title,body:r.body,head:'task',base:'main',draft:true,maintainer_can_modify:false});
  assert.equal(git(f.wt,'rev-parse','HEAD'),before);assert.equal(git(f.wt,'status','--porcelain'),'');assert.ok(fs.readFileSync(path.join(f.task.gitDir,'index')).equals(index));
  assert.doesNotMatch(JSON.stringify(f.task.prAttempt),/explicitly reviewed draft description/);
  await assert.rejects(f.apply(r),e=>e.code==='CONFLICT');assert.equal((await f.preview()).status,'unconfirmed');assert.equal(posts.length,1);
});
for(const change of ['dirty','untracked','source-commit','branch','remote-url','remote-head','remote-base','account','task-context','expiry','document'])posix(`${change} change refuses the reviewed PR before any outbound creation`,async t=>{
  const f=fixture(t),r=await f.preview();
  if(change==='dirty')fs.writeFileSync(path.join(f.wt,'task.js'),'later edit\n');
  if(change==='untracked')fs.writeFileSync(path.join(f.wt,'mine.txt'),'preserve\n');
  if(change==='source-commit'){fs.writeFileSync(path.join(f.wt,'task.js'),'later edit\n');git(f.wt,'add','.');git(f.wt,'commit','-qm','later');}
  if(change==='branch')git(f.wt,'switch','-qc','other');
  if(change==='remote-url')git(f.wt,'remote','set-url','origin','git@github.com:fixture/other.git');
  if(change==='remote-head')f.state.remoteHead='a'.repeat(40);
  if(change==='remote-base')f.state.remoteBase=f.state.remoteHead;
  if(change==='account')f.state.user={id:43,login:'another-user'};
  if(change==='task-context')f.task.checkpoint={version:2,decisions:['changed']};
  if(change==='expiry')f.state.now+=300001;
  if(change==='document')f.state.current=false;
  await assert.rejects(f.apply(r));assert.equal(f.calls.some(c=>c.method==='POST'),false);assert.equal(f.state.saved.length,0);
});
for(const url of ['https://token@github.com/fixture/app.git','https://evil.invalid/fixture/app','https://github.com/fixture/app?token=private','git@github.com:fixture/app.git\nhttps://github.com/fixture/other'])posix('nonstandard or credential-bearing origin is never forwarded to a service',async t=>{
  const f=fixture(t);git(f.wt,'remote','set-url','origin',url);await assert.rejects(f.preview(),e=>e.code==='POLICY_DENIED');assert.equal(f.calls.length,0);
});
posix('lost POST reply survives restart and only reads its exact receipt without sending again',async t=>{
  const f=fixture(t),r=await f.preview();f.state.failReply=true;
  assert.equal((await f.apply(r)).status,'unconfirmed');assert.equal(f.task.prAttempt.status,'dispatching');
  const restarted=createTaskPullRequest(f.options);assert.equal((await restarted.preview(f.task,{title:'another',body:''})).status,'unconfirmed');
  const recovered=await restarted.recover(f.task,f.current,f.save);assert.equal(recovered.status,'created');assert.equal(f.task.prAttempt.status,'created');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
posix('an absent or unrelated receipt remains uncertain without automatic retry',async t=>{
  const f=fixture(t),r=await f.preview();f.state.postStatus=503;assert.equal((await f.apply(r)).status,'unconfirmed');
  f.state.pulls=[{title:'other',body:'other'}];assert.equal((await f.helper.recover(f.task,f.current,f.save)).status,'unconfirmed');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
posix('a definitive GitHub refusal permits a new review but never automatically retries',async t=>{
  const f=fixture(t),r=await f.preview();f.state.postStatus=422;assert.equal((await f.apply(r)).status,'refused');assert.equal(f.task.prAttempt.status,'refused');
  assert.equal((await f.preview()).status,'review');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
posix('authority lost during remote lookup causes no mutation',async t=>{
  const f=fixture(t),r=await f.preview();f.state.onCall=(method,endpoint)=>{if(endpoint.endsWith('/heads/task'))f.state.current=false;};
  await assert.rejects(f.apply(r));assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
posix('persist failure blocks POST and later source changes are preserved',async t=>{
  const f=fixture(t),r=await f.preview();await assert.rejects(f.helper.apply(f.task,r.id,r.hash,f.current,()=>{throw Error('disk full');}));assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
