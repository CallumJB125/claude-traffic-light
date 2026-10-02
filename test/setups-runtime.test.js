'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {fixture,stamp}=require('./helpers/setups-native/runtime');
const {createSetupsService}=require('../src/setups-service');
const {createSetupsRuntime}=require('../src/setups-runtime');
const {validatePayload,canonical}=require('../src/borrow/payload');
const helper=process.env.PLEXIFORM_TEST_HELPER;
const tick=()=>new Promise(r=>setImmediate(r));
async function setup(t,options={}){
 const f=fixture(t,helper,options),parent=f.app+'/setups-runtime-v2';fs.mkdirSync(parent,{mode:0o700});
 const originalActor={...f.state.actor},checked=validatePayload(f.source.payload),calls=[];
 const control={dialog:null,read:null,provider:null,sourcePredicate:true,principal:null};
 const principal=()=>control.principal??{user_id:originalActor.account,team_id:originalActor.team,member_id:originalActor.member,role:'member'};
 const response=()=>({ok:true,principal:principal(),profile:{id:f.source.profileId,owner_user_id:originalActor.account,current_version:{id:f.source.versionId,content_hash:checked.content_hash}},version:{id:f.source.versionId,content_hash:checked.content_hash,number:1},payload:f.source.payload});
 const source={userId:originalActor.account,teamId:originalActor.team,memberId:originalActor.member,deviceId:originalActor.device,role:'member',name:'Synthetic team',current:()=>f.state.sourceCurrent,async call(op){calls.push(op);if(op==='read'&&control.read)await control.read();if(op==='read'&&control.provider)return control.provider();return op==='list'?{ok:true,principal:principal(),status:'complete',profiles:[{id:f.source.profileId,owner_user_id:originalActor.account,current_version:{id:f.source.versionId,number:1,content_hash:checked.content_hash,file_count:f.source.payload.files.length,item_count:0,sources:['codex']}}]}:response();}};
 const service=createSetupsService({sources:async()=>[source],home:f.profile});
 const optionsFor=()=>({service,observe:()=>{const {actor,...o}=f.observe();return o;},roots:()=>({profile:{path:f.profile,stamp:stamp(f.profile)},app:{path:parent,stamp:stamp(parent)}}),launch:o=>{const child=spawn(helper,o.args,o);f.state.children.push(child);return child;},wrapping:f.wrapping,currentActor:a=>canonical(a)===canonical(f.state.actor),currentSource:()=>control.sourcePredicate,confirm:async d=>control.dialog?control.dialog(d):d.kind==='apply'?{approved:true,plan_hash:d.plan_hash}:d.kind==='undo'?{approved:true,transaction_id:d.transaction_id,inspection_hash:d.inspection_hash}:{approved:true,transaction_id:d.transaction_id}});
 const runtimes=[];const make=()=>{const r=createSetupsRuntime(optionsFor());runtimes.push(r);return r;};t.after(()=>runtimes.forEach(r=>r.close()));
 const sharing=await service.snapshot(),handle=sharing.teams[0].profiles[0].handle,runtime=make();
 return {...f,parent,source,service,control,calls,handle,runtime,make,optionsFor,response};
}
async function apply(f){const p=await f.runtime.plan(f.handle,f.request());assert.equal(p.ok,true,JSON.stringify(p));assert.equal(p.ready,true);const a=await f.runtime.apply(p.handle,p.plan_hash);assert.equal(a.ok,true,JSON.stringify(a));return {p,a};}
test('main-only adapter actual native two-target Apply Verify restart locked recovery Undo preserves schema1 and bytes',async t=>{
 const f=await setup(t,{extraFile:true,before:'Original synthetic CRLF\r\n'}),legacy=f.app+'/setups-transactions';fs.mkdirSync(legacy,{mode:0o700});fs.writeFileSync(legacy+'/legacy-schema1-evidence','preserved original envelope',{mode:0o600});
 const {p,a}=await apply(f);assert.equal(a.phase,'verified');assert.equal(fs.readFileSync(f.filename,'utf8'),f.file.content);assert.equal((await f.runtime.apply(p.handle,p.plan_hash)).ok,false);
 const fresh=f.make(),locked=await fresh.listLocked();assert.deepEqual(locked,{ok:true,status:'locked',transactions:[{id:a.transaction_id,locked:true}]});assert.ok(!JSON.stringify(locked).includes(f.profile));
 f.state.actor=null;const r=await fresh.recover(a.transaction_id);assert.equal(r.ok,true);assert.equal(r.local_previews,'withheld_local_values');assert.equal((await fresh.confirmUndo(r.handle)).ok,true);assert.equal(fs.readFileSync(f.filename,'utf8'),'Original synthetic CRLF\r\n');assert.deepEqual(JSON.parse(fs.readFileSync(f.profile+'/.gemini/settings.json','utf8')),{theme:'before'});assert.equal(fs.readFileSync(legacy+'/legacy-schema1-evidence','utf8'),'preserved original envelope');assert.equal((await fresh.confirmUndo(r.handle)).ok,false);
});
test('adapter rereads exact source after native Apply dialog before encrypted storage or target staging',async t=>{
 const f=await setup(t),p=await f.runtime.plan(f.handle,f.request()),reads=f.calls.filter(x=>x==='read').length;
 f.control.dialog=d=>{assert.equal(d.kind,'apply');f.control.provider=()=>({...f.response(),version:{...f.response().version,content_hash:'f'.repeat(64)}});return {approved:true,plan_hash:d.plan_hash};};
 assert.equal((await f.runtime.apply(p.handle,p.plan_hash)).ok,false);assert.equal(f.calls.filter(x=>x==='read').length,reads+2);assert.equal(fs.readFileSync(f.filename,'utf8'),'Keep synthetic notes.\n');assert.equal(fs.existsSync(f.parent+'/setups-transactions'),false);assert.equal((await f.service.read(f.handle)).ok,false);
});
test('adapter fences current device/member/source/profile generation and foreground after native confirmation',async t=>{
 for(const change of [f=>{f.source.deviceId='other';},f=>{f.state.actor={...f.state.actor,member:'other'};},f=>{f.control.sourcePredicate=false;},f=>{f.state.foreground=false;},f=>{f.state.generation++;}]){
  const f=await setup(t),p=await f.runtime.plan(f.handle,f.request());f.control.dialog=d=>{change(f);return {approved:true,plan_hash:d.plan_hash};};assert.equal((await f.runtime.apply(p.handle,p.plan_hash)).ok,false);assert.equal(fs.readFileSync(f.filename,'utf8'),'Keep synthetic notes.\n');assert.equal(fs.existsSync(f.parent+'/setups-transactions'),false);
 }
});
test('adapter late initial read, rejected parallel request and third request cannot replace active owner',async t=>{
 const f=await setup(t);let release;f.control.read=()=>new Promise(r=>release=r);const pending=f.runtime.plan(f.handle,f.request());await tick();assert.equal(f.runtime.localState().busy,true);assert.equal((await f.runtime.listLocked()).ok,false);assert.equal(f.runtime.localState().busy,true);assert.equal((await f.runtime.plan(f.handle,f.request())).ok,false);f.control.read=null;release();const p=await pending;assert.equal(p.ok,true);assert.equal(f.runtime.localState().busy,false);assert.equal((await f.runtime.check(p.handle)).ok,true);
});
test('adapter clones local choices before first source await and local values remain masked/unshared',async t=>{
 const f=await setup(t,{after:'Name {{NAME}}.\n'});let release;f.control.read=()=>new Promise(r=>release=r);const request=f.request();request.values={NAME:'Private Synthetic Name'};const pending=f.runtime.plan(f.handle,request);await tick();request.files[0].instructions=false;request.values.NAME='Mutated after dispatch';f.control.read=null;release();const p=await pending;assert.equal(p.ready,true);assert.ok(!JSON.stringify(p).includes('Private Synthetic Name'));assert.equal((await f.runtime.apply(p.handle,p.plan_hash)).ok,true);assert.equal(fs.readFileSync(f.filename,'utf8'),'Name Private Synthetic Name.\n');assert.ok(!JSON.stringify(f.calls).includes('Private Synthetic Name'));
});
test('adapter retains unknown effects and actual foreign edit refuses conditional Undo',async t=>{
 const f=await setup(t),{a}=await apply(f),fresh=f.make(),r=await fresh.recover(a.transaction_id);assert.equal(r.ok,true);fs.writeFileSync(f.filename,'New human notes after inspection.\n');const u=await fresh.confirmUndo(r.handle);assert.equal(u.ok,false);assert.equal(u.phase,'unknown');assert.equal(u.retained,true);assert.equal(fs.readFileSync(f.filename,'utf8'),'New human notes after inspection.\n');assert.ok(fs.existsSync(f.parent+'/setups-transactions/'+a.transaction_id));
});
test('adapter refuses legacy app parent, unavailable OS wrapping and untrusted factory/request additions',async t=>{
 const f=await setup(t),opts=f.optionsFor();assert.throws(()=>createSetupsRuntime({...opts,executable:'/tmp/renderer'}));assert.equal((await f.runtime.plan(f.handle,{...f.request(),profilePath:'/renderer'})).ok,false);assert.equal(f.state.children.length,0);
 const bad=createSetupsRuntime({...opts,roots:()=>({profile:{path:f.profile,stamp:stamp(f.profile)},app:{path:f.app,stamp:stamp(f.app)}})});t.after(()=>bad.close());assert.equal((await bad.plan(f.handle,f.request())).ok,false);assert.equal(f.state.children.length,0);
 const unavailable=createSetupsRuntime({...opts,wrapping:{available:()=>false,wrap(){throw Error('must not wrap');},unwrap(){throw Error('must not unwrap');}}});t.after(()=>unavailable.close());assert.equal(unavailable.localState().wrapped_storage_available,null);const p=await unavailable.plan(f.handle,f.request());assert.equal(p.ok,true);assert.equal((await unavailable.apply(p.handle,p.plan_hash)).ok,false);assert.equal(fs.readFileSync(f.filename,'utf8'),'Keep synthetic notes.\n');
});
test('adapter denied source after pending confirmation retires plan and withholds newly rebound account data',async t=>{
 const f=await setup(t),p=await f.runtime.plan(f.handle,f.request());let release;f.control.dialog=()=>new Promise(r=>release=r);const pending=f.runtime.apply(p.handle,p.plan_hash);await tick();f.runtime.invalidate();release({approved:true,plan_hash:p.plan_hash});assert.equal((await pending).ok,false);assert.equal((await f.runtime.check(p.handle)).ok,false);assert.equal((await f.service.read(f.handle)).ok,false);assert.equal(fs.readFileSync(f.filename,'utf8'),'Keep synthetic notes.\n');
});
test('adapter actual native snapshot observation cannot survive authority generation change',async t=>{
 const f=await setup(t),opts=f.optionsFor();let replies=0;const r=createSetupsRuntime({...opts,launch:o=>{const child=opts.launch(o);child.stdout.on('data',()=>{if(++replies===2)f.state.generation++;});return child;}});t.after(()=>r.close());assert.equal((await r.plan(f.handle,f.request())).ok,false);assert.ok(replies>=2);assert.equal(fs.readFileSync(f.filename,'utf8'),'Keep synthetic notes.\n');assert.equal(fs.existsSync(f.parent+'/setups-transactions'),false);
});
test('adapter source denial after dialog retires all plans, and offline restart never restores remote authority',async t=>{
 const f=await setup(t),p=await f.runtime.plan(f.handle,f.request());f.control.dialog=d=>{f.control.provider=()=>({ok:false,code:'FORBIDDEN'});return {approved:true,plan_hash:d.plan_hash};};assert.equal((await f.runtime.apply(p.handle,p.plan_hash)).ok,false);assert.equal((await f.runtime.check(p.handle)).ok,false);assert.equal((await f.service.read(f.handle)).ok,false);f.state.actor=null;assert.equal((await f.runtime.plan(f.handle,f.request())).ok,false);assert.equal(fs.readFileSync(f.filename,'utf8'),'Keep synthetic notes.\n');
});
test('adapter validates bounded closed selection/local values before any authorized source read',async t=>{
 const f=await setup(t),before=f.calls.length;for(const request of [{...f.request(),values:{NAME:'x'.repeat(4097)}},{files:[{...f.request().files[0],principal:{account:'renderer'}}],values:{}},{...f.request(),values:{bad:{nested:'provider-login'}}}])assert.equal((await f.runtime.plan(f.handle,request)).ok,false);assert.equal(f.calls.length,before);assert.equal(f.state.children.length,0);
});
test('ordinary metadata plan locked listing and status never probe OS wrapping, while explicit Apply refuses unavailable encryption',async t=>{
 const f=await setup(t),opts=f.optionsFor();let probes=0;const r=createSetupsRuntime({...opts,wrapping:{available(){probes++;return false;},wrap(){throw Error('must not wrap');},unwrap(){throw Error('must not unwrap');}}});t.after(()=>r.close());
 const state=r.localState();assert.equal(state.status,'review_available');assert.equal(state.wrapped_storage_available,null);const p=await r.plan(f.handle,f.request());assert.equal(p.ok,true);assert.equal((await r.listLocked()).ok,true);assert.equal((await r.status(require('node:crypto').randomUUID())).ok,false);assert.equal(r.localState().wrapped_storage_available,null);assert.equal(probes,0);assert.equal((await r.apply(p.handle,p.plan_hash)).ok,false);assert.ok(probes>0);assert.equal(fs.readFileSync(f.filename,'utf8'),'Keep synthetic notes.\n');
});
