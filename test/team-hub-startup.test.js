'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createLiveTeamHub}=require('../src/team-hub-live');

test('desktop team-directory startup waits for Electron readiness before loading persisted credentials',async t=>{
  const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
  const declaration=source.split('\n').find(line=>line.startsWith('const liveTeamHub='));
  const subscription=source.split('\n').find(line=>line.includes('if(!overviewTeamHub)liveTeamHub.onChange('));
  assert.ok(declaration&&subscription);
  let ready=false,releaseReady,accountReads=0,fetches=0;
  const readyPromise=new Promise(resolve=>{releaseReady=resolve;});
  const context={
    app:{isReady:()=>ready,whenReady:()=>readyPromise},devMockReady:true,
    getBuddy:()=>{assert.equal(ready,true,'account vault must not be constructed before Electron is ready');accountReads++;return {interactionHostIdentity:()=>({origin:'https://hub.example',userId:'u',token:()=> 'synthetic'})};},
    require:name=>{assert.equal(name,'./src/team-hub-live');return {createLiveTeamHub};},
    net:{fetch:async()=>{fetches++;return {status:200,headers:{get:()=>null},text:async()=>'{"shared":[]}',body:null};}},
    overviewTeamHub:null,OverviewMain:{directoryChanged:()=>{}},
  };
  vm.createContext(context);
  vm.runInContext(`${declaration}\n${subscription}\nthis.live=liveTeamHub;`,context);
  t.after(()=>context.live.close());
  assert.equal(context.live.current(),null,'even an early directory lookup remains signed out without touching the vault');
  assert.equal(accountReads,0);assert.equal(fetches,0);
  ready=true;releaseReady();
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(accountReads>0,'ready startup loads the existing account');
  assert.ok(context.live.current(),'the saved team identity becomes available without signing in again');
  assert.ok(fetches>0,'the directory resumes its normal authenticated poll');
});
