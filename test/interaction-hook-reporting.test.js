'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createInteractionMain,CHANNELS}=require('../src/interaction-main');
test('hook reporting binds native session AND turn, never workspace labels or an old turn',async()=>{
 const ee=new EventEmitter(),time=1800000000000;
 const wc={id:1,mainFrame:{},isDestroyed:()=>false,send(){}};
 const ctx={contents:wc,document:1,generation:1,foreground:true};
 const adapter={label:'Codex',capabilities:{newTurn:true,ack:'turn-id',echo:'client-message-id'},alive:()=>true,open:async()=>({target:'native-session'}),send:async()=>({turnId:'native-turn',mode:'new-turn'}),release:async()=>true,on:f=>{ee.on('e',f);return()=>ee.off('e',f);}};
 const x=createInteractionMain({owned:null,adapters:{codex:adapter},context:()=>ctx,currentBoard:()=> 'local',workspace:()=> '/synthetic/label',now:()=>time,localModels:null});
 const handlers=new Map();x.register({handle:(n,f)=>handlers.set(n,f)});const event={sender:wc,senderFrame:wc.mainFrame};
 const launch=await handlers.get(CHANNELS.launch)(event,{provider:'codex'});const s=launch.state;
 await handlers.get(CHANNELS.send)(event,{session:s.session,generation:s.generation,text:'safe task'});
 const row={source:'codex',codexLifecycle:1,sessionId:'native-session',codexTurnId:'native-turn',codexClosedTurn:false,cwd:'/synthetic/label',codexHookAt:new Date(time).toISOString(),codexInputRequests:[{id:'question',kind:'sync',turnId:'native-turn',askedAt:new Date(time).toISOString()}],codexSelfReports:[{id:'private-child-id',name:'Reviewer',taskTitle:'Check output',status:'working',parentTurnId:'native-turn',observedAt:time,source:'self-reported'}]};
 for(const hostile of [{...row,sessionId:'other'},{...row,codexTurnId:'old-turn',codexInputRequests:[{id:'question',kind:'sync',turnId:'old-turn',askedAt:new Date(time).toISOString()}]},{...row,remote:true},{...row,codexHookAt:new Date(time+1).toISOString()}]){x.reportHooks([hostile]);assert.equal(x.listOwned()[0].state.reporting.children.length,0);assert.equal(x.listOwned()[0].state.input_needed,false);}
 x.reportHooks([row,row]);assert.equal(x.listOwned()[0].state.reporting.children.length,0,'ambiguous reports refused');
 assert.doesNotThrow(()=>x.reportHooks([{...row,codexAgents:[null,1,{}]}]));x.reportHooks([row]);const result=x.listOwned()[0].state;assert.equal(result.reporting.children.length,1);assert.equal(result.reporting.children[0].task_title,'Check output');assert.equal(JSON.stringify(result).includes('private-child-id'),false);
 x.close();
});
test('terminal setup needs the exact foreground Overview document and rechecks the board after the dialog',async()=>{
 const wc={id:1,mainFrame:{},isDestroyed:()=>false,send(){}};let board='team',ctx={contents:wc,document:1,generation:1,foreground:true},calls=0;
 const x=createInteractionMain({owned:null,adapters:{},context:()=>ctx,currentBoard:()=>board,localModels:null,prepareChannel:async({fresh})=>{calls++;board='personal';return {ok:fresh()};}});
 const h=new Map();x.register({handle:(n,f)=>h.set(n,f)});const e={sender:wc,senderFrame:wc.mainFrame};
 assert.equal((await h.get(CHANNELS.channelSetup)({...e,senderFrame:{}})).ok,false);assert.equal(calls,0);
 assert.equal((await h.get(CHANNELS.channelSetup)(e)).ok,false);assert.equal(calls,1);x.close();
});
