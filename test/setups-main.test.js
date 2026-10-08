'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSetupsMain}=require('../src/setups-main');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ID='12345678-1234-4234-8234-123456789abc',HASH='a'.repeat(64);
const choice=()=>({files:[{id:ID,mode:'replace',replace_keys:[],instructions:true,code:true}],values:{NAME:'Synthetic local value'}});
function fixture(overrides={}){
 const calls=[],handlers=new Map(),frame={},contents={mainFrame:frame,isDestroyed:()=>false},window={isDestroyed:()=>false};let context={window,contents,generation:1,foreground:true},binding,decision={response:1},during=()=>{};
 const service={invalidate:()=>calls.push(['service.invalidate'])},buddy={setupsContext:()=>context,setupsActorCurrent:a=>a.device==='device-current',setupsConfirm:async fn=>fn(context.window)};
 const options={accepted:true,app:{isPackaged:true},buddy:()=>buddy,service,resourcesPath:'/fixed/Plexiform.app/Contents/Resources',platform:'darwin',userInfo:()=>({uid:501,homedir:'/actual/OS/profile'}),realpath:p=>{calls.push(['canonical',p]);return p;},
  safeStorage:{isEncryptionAvailable:()=>{calls.push(['crypto']);return true;},encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},dialog:{showMessageBox:async(...args)=>{calls.push(['dialog',...args]);during();return decision;}},
  platformFactory:args=>{calls.push(['platform',args]);return {roots:()=>({fixed:true}),launch:opts=>({opts})};},
  runtimeFactory:opts=>{binding=opts;return Object.fromEntries(['localState','plan','check','apply','listLocked','status','recover','confirmUndo','invalidate','close'].map(name=>[name,(...args)=>{calls.push([name,...args]);return {ok:true,method:name};}]));},...overrides};
 const main=createSetupsMain(options);main.register({handle:(name,fn)=>handlers.set(name,fn)});
 return {main,handlers,calls,buddy,event:{sender:contents,senderFrame:frame},setContext:c=>{context=c;},context:()=>context,binding:()=>binding,decision:d=>{decision=d;},during:fn=>{during=fn;},invoke:(name,...args)=>handlers.get('setups:'+name)({sender:contents,senderFrame:frame},...args)};
}
test('eight exact channels bind fixed OS roots and no eager credential probe',async()=>{
 const f=fixture();assert.equal(f.handlers.size,8);assert.equal((await f.invoke('local-state')).method,'localState');const b=f.binding();assert.deepEqual(b.observe(),{profilePath:'/actual/OS/profile',platform:'darwin',osUser:'uid:501',generation:1,foreground:true});
 assert.equal(f.calls.some(c=>c[0]==='crypto'),false);const p=f.calls.find(c=>c[0]==='platform')[1];assert.equal(p.profilePath,'/actual/OS/profile');assert.equal(p.uid,501);assert.equal(p.resourcesPath,'/fixed/Plexiform.app/Contents/Resources');assert.equal(b.currentActor({device:'device-current'}),true);assert.equal(b.currentActor({device:'foreign'}),false);assert.equal(b.currentSource({current:()=>true}),true);assert.equal(b.currentSource({current:()=>false}),false);
 for(const [channel,args,method]of [['plan',[ID,choice()],'plan'],['check',[ID],'check'],['apply',[ID,HASH],'apply'],['list-locked',[],'listLocked'],['local-status',[ID],'status'],['recover',[ID],'recover'],['confirm-undo',[ID],'confirmUndo']])assert.equal((await f.invoke(channel,...args)).method,method);
});
test('foreign, child frame, hidden and retired senders fail before platform or runtime access',async()=>{
 for(const mode of ['foreign','child','hidden','destroyed']){const f=fixture(),event={...f.event};if(mode==='foreign')event.sender={};if(mode==='child')event.senderFrame={};if(mode==='hidden')f.setContext({...f.context(),foreground:false});if(mode==='destroyed')f.context().contents.isDestroyed=()=>true;assert.equal((await f.handlers.get('setups:local-state')(event)).ok,false);assert.equal(f.calls.length,0);}
});
test('renderer cannot add authority, roots, executables, crypto or unbounded values',async()=>{
 for(const value of [{...choice(),profile:'/foreign'},{...choice(),values:{HOME:'/foreign'}},{...choice(),values:{NAME:'x'.repeat(4097)}},{...choice(),values:{NAME:'a\0b'}},{...choice(),files:[{...choice().files[0],approved:true}]},{...choice(),files:[...choice().files,...choice().files]},{files:[],values:{}},{...choice(),values:{'SECRET:':'bad'}}]){const f=fixture();assert.equal((await f.invoke('plan',ID,value)).ok,false);assert.equal(f.calls.length,0);}
 for(const [channel,args]of [['local-state',[{crypto:true}]],['apply',[ID,HASH,{approved:true}]],['apply',[ID,'f'.repeat(63)]],['recover',['/foreign']],['check',[ID,'extra']],['confirm-undo',[ID,{}]],['local-status',[ID,null]],['list-locked',['extra']]]){const f=fixture();assert.equal((await f.invoke(channel,...args)).ok,false);assert.equal(f.calls.length,0);}
});
test('opaque strings and hashes refuse structured-clone arrays and boxed values before composition',async()=>{
 for(const bad of [[ID],new String(ID),{id:ID}]){
  for(const channel of ['check','local-status','recover','confirm-undo']){const f=fixture();assert.equal((await f.invoke(channel,bad)).ok,false);assert.equal(f.calls.length,0);}
  const f=fixture();assert.equal((await f.invoke('plan',ID,{...choice(),files:[{...choice().files[0],id:bad}]})).ok,false);assert.equal(f.calls.length,0);
  const g=fixture();assert.equal((await g.invoke('plan',bad,choice())).ok,false);assert.equal(g.calls.length,0);
 }
 for(const bad of [[HASH],new String(HASH),{hash:HASH}]){const f=fixture();assert.equal((await f.invoke('apply',ID,bad)).ok,false);assert.equal(f.calls.length,0);}
});
test('choice values are copied before an async operation sees caller mutation',async()=>{
 let received;const f=fixture({runtimeFactory:opts=>({plan:async(_id,input)=>{received=input;await Promise.resolve();return {ok:true};}})}),input=choice(),pending=f.invoke('plan',ID,input);input.values.NAME='Mutated';input.files[0].mode='merge';await pending;assert.equal(received.values.NAME,'Synthetic local value');assert.equal(received.files[0].mode,'replace');
});
test('post-await document, frame, focus and window replacement refuse a stale result',async()=>{
 for(const mode of ['document','frame','focus','window']){let finish;const f=fixture({runtimeFactory:()=>({check:()=>new Promise(resolve=>{finish=resolve;})})});const pending=f.invoke('check',ID),old=f.context();if(mode==='document')f.setContext({...old,generation:2});if(mode==='frame')old.contents.mainFrame={};if(mode==='focus')f.setContext({...old,foreground:false});if(mode==='window')f.setContext({...old,window:{isDestroyed:()=>false}});finish({ok:true,grant:'old'});assert.equal((await pending).ok,false);}
});
test('same document number in a different owned window changes native observation authority',async()=>{
 const f=fixture();await f.invoke('local-state');const before=f.binding().observe();f.setContext({...f.context(),window:{isDestroyed:()=>false}});const after=f.binding().observe();assert.notEqual(before.generation,after.generation);
});
test('three native confirmations default Cancel and echo only exact controller authority',async()=>{
 const f=fixture();await f.invoke('local-state');const b=f.binding();for(const request of [{kind:'apply',plan_hash:HASH,summary:{}},{kind:'recovery',transaction_id:ID},{kind:'undo',transaction_id:ID,inspection_hash:HASH}]){
  const out=await b.confirm(request);assert.equal(out.approved,true);assert.equal(out.plan_hash,request.plan_hash);assert.equal(out.transaction_id,request.transaction_id);assert.equal(out.inspection_hash,request.inspection_hash);const dialog=f.calls.at(-1);assert.equal(dialog[1],f.context().window);assert.equal(dialog[2].defaultId,0);assert.equal(dialog[2].cancelId,0);assert.equal(dialog[2].buttons[0],'Cancel');
  f.decision({response:0});assert.equal(await b.confirm(request),null);f.decision({response:1});
 }assert.equal(await b.confirm({kind:'unknown',approved:true}),null);
});
test('focus, document or owned window drift during native confirmation never grants',async()=>{
 for(const mode of ['focus','document','window']){const f=fixture();await f.invoke('local-state');f.during(()=>{const c=f.context();f.setContext({...c,...(mode==='focus'?{foreground:false}:mode==='document'?{generation:2}:{window:{isDestroyed:()=>false}})});});assert.equal(await f.binding().confirm({kind:'apply',plan_hash:HASH}),null);}
});
test('identity retirement and close preserve one runtime lifetime and stop renewed access',async()=>{
 const f=fixture();await f.invoke('local-state');f.main.invalidate();assert.equal(f.calls.at(-1)[0],'invalidate');f.main.close();assert.equal(f.calls.at(-1)[0],'close');assert.equal((await f.invoke('local-state')).ok,false);assert.equal(f.calls.filter(c=>c[0]==='platform').length,1);
});
test('unsupported and unpackaged builds cannot use alternate helper or credential paths',async()=>{
 for(const overrides of [{platform:'win32'},{app:{isPackaged:false}}]){const f=fixture(overrides);assert.equal((await f.invoke('local-state')).ok,false);assert.equal(f.calls.length,0);}
});
test('held composition refuses every local operation before runtime or OS credential access',async()=>{
 for(const accepted of [false,undefined,1,'true']){const f=fixture({accepted});for(const [channel,args]of [['local-state',[]],['plan',[ID,choice()]],['check',[ID]],['apply',[ID,HASH]],['list-locked',[]],['local-status',[ID]],['recover',[ID]],['confirm-undo',[ID]]])assert.equal((await f.invoke(channel,...args)).ok,false);assert.equal(f.calls.length,0);}
});
test('production main composition registers the real local adapter and retires it on quit',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),start=source.indexOf('const SetupsLocal='),end=source.indexOf('// Settings → Account & team',start),handlers=new Map(),events=new Map(),frame={},contents={mainFrame:frame,isDestroyed:()=>false},window={isDestroyed:()=>false};let retired=0,crypto=0;
 assert.ok(start>0&&end>start);const service={invalidate:()=>retired++};
 const context={onQuit:(a,fn)=>a.on('will-quit',fn),require:name=>{if(name==='./src/setups-main')return {createSetupsMain};assert.equal(name,'electron');return {safeStorage:{isEncryptionAvailable:()=>{crypto++;return false;}}};},app:{isPackaged:true,on:(event,fn)=>events.set(event,fn)},buddyWin:{setupsContext:()=>({window,contents,generation:1,foreground:true})},SetupsNative:service,dialog:{},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)}};
 vm.runInNewContext(source.slice(start,end),context);assert.equal(handlers.size,8);assert.equal(crypto,0);assert.equal((await handlers.get('setups:local-state')({sender:contents,senderFrame:frame})).ok,false);assert.equal(crypto,0);events.get('will-quit')();assert.equal(retired,1);
});
