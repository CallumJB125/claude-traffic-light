'use strict';
// Main-only production adapter. No app call sites are introduced here.
const path=require('node:path');
const {performance}=require('node:perf_hooks');
const {canonical,closed,SHA}=require('./plugins/index-verify');
const {UUID,validatePayload}=require('./borrow/payload');
const {createNativeSupervisor}=require('./borrow/native-supervisor');
const {createTransactionController}=require('./borrow/transaction-controller');
const RECIPES=Object.freeze(['codex-instructions-v1','claude-settings-v1','gemini-settings-v1']);
const SOURCE_KEYS=['profileId','versionId','contentHash','payload','principal','current'];
const OBSERVE_KEYS=['profilePath','platform','osUser','generation','foreground'];
const ID=/^[A-Za-z0-9_.:-]{1,100}$/;
const unavailable=()=>({ok:false,status:'unavailable',error:'Review the current setup and local access again.'});
const refuse=()=>{throw new Error('Setups local runtime is unavailable');};
const copy=x=>JSON.parse(canonical(x));
const actorValid=a=>closed(a,['account','team','member','device'])&&Object.values(a).every(x=>typeof x==='string'&&ID.test(x));
const sourceIdentity=s=>canonical([s.profileId,s.versionId,s.contentHash,s.principal]);

/* Closed trusted factory contract (never expose this object to preload):
 * service: createSetupsService result, with private readForPlan and invalidate.
 * observe(): {profilePath, platform, osUser, generation, foreground}; ROOT owns
 * canonical OS profile, current exact page/main-frame, foreground/modal ticket.
 * roots(): reviewed native {profile:{path,stamp},app:{path,stamp}}. app.path is
 * the separate fixed .../setups-runtime-v2 parent; ROOT supplies its secure
 * creation, UID/ACL/stamp/inode policy. This adapter never creates/inspects it.
 * launch(opts): ROOT's fixed verified bundled helper; supervisor alone supplies
 * empty argv/env and private descriptors. No production launcher is invented.
 * wrapping: ROOT's actual safeStorageWrapping; no plaintext/default fallback.
 * currentActor(principal): exact sealed account/member/team/device still valid.
 * currentSource(privateSource): exact captured source/revision still valid.
 * Both are synchronous main-only predicates. null actor is used only for own
 * local recovery; remote source/account authority never authorizes that mode.
 * confirm(request): ROOT's current native Apply/recovery/Undo dialog. Apply is
 * followed by another fresh authorized exact source read before approval.
 * Optional now/clock are trusted test/main clocks, not IPC arguments.
 */
function createSetupsRuntime(options){
 if(!closed(options,['service','observe','roots','launch','wrapping','confirm','currentActor','currentSource'],['now','clock']))refuse();
 const {service,observe,roots,launch,wrapping,confirm,currentActor,currentSource,now=Date.now,clock=()=>performance.now()}=options;
 if(!service||typeof service.readForPlan!=='function'||typeof service.invalidate!=='function'||![observe,roots,launch,confirm,currentActor,currentSource,now,clock].every(x=>typeof x==='function')||!wrapping||!['available','wrap','unwrap'].every(k=>typeof wrapping[k]==='function'))refuse();
 let generation=0,closedRuntime=false,busy=null,context=null;
 const plans=new Map(),recoveries=new Map();
 function observed(){
  const o=observe();
  if(!closed(o,OBSERVE_KEYS)||typeof o.profilePath!=='string'||!path.isAbsolute(o.profilePath)||o.profilePath.includes('\0')||o.platform!=='darwin'||typeof o.osUser!=='string'||!/^[A-Za-z0-9._:-]{1,200}$/.test(o.osUser)||!Number.isSafeInteger(o.generation)||o.generation<0||o.foreground!==true)refuse();
  return copy(o);
 }
 function sourceCurrent(s){try{return s.current()===true&&currentActor(s.principal)===true&&currentSource(s)===true;}catch{return false;}}
 function authority(c){try{return !closedRuntime&&context===c&&c.generation===generation&&canonical(observed())===c.observation&&(c.source?sourceCurrent(c.source):c.actor===null);}catch{return false;}}
 function observation(){if(!context||!authority(context))refuse();return {...observed(),actor:context.actor};}
 function nativeRoots(){
  if(!context||!authority(context))refuse();const r=roots();
  if(!closed(r,['profile','app'])||!closed(r.profile,['path','stamp'])||!closed(r.app,['path','stamp'])||r.profile.path!==context.profilePath||typeof r.app.path!=='string'||!path.isAbsolute(r.app.path)||path.basename(r.app.path)!=='setups-runtime-v2'||r.app.path.includes('\0')||path.resolve(r.app.path)===path.resolve(r.profile.path))refuse();
  return r; // Native bootstrap/reader owns stamp and descriptor validation.
 }
 const supervisor=createNativeSupervisor({launch,current:()=>context!==null&&authority(context),now:clock});
 let controller;
 function retire(sharing=false){generation++;context=null;plans.clear();recoveries.clear();controller?.invalidate();if(sharing)service.invalidate();}
 function checkedSource(s){
  if(!closed(s,SOURCE_KEYS)||!UUID.test(s.profileId??'')||!UUID.test(s.versionId??'')||!SHA.test(s.contentHash??'')||!actorValid(s.principal)||typeof s.current!=='function'||!sourceCurrent(s))refuse();
  const checked=validatePayload(s.payload);if(checked.content_hash!==s.contentHash)refuse();
  return {profileId:s.profileId,versionId:s.versionId,contentHash:s.contentHash,payload:copy(checked.payload),principal:Object.freeze({...s.principal}),current:s.current};
 }
 async function readFor(c){
  if(!authority(c)||!c.sourceHandle)refuse();
  let fresh;
  try{fresh=checkedSource(await service.readForPlan(c.sourceHandle));if(!authority(c)||sourceIdentity(fresh)!==sourceIdentity(c.source))refuse();}
  catch{if(context===c)retire();refuse();}
  // Controller's synchronous fences include adapter generation and ROOT's
  // current source/actor/page predicates after every subsequent local await.
  return {...fresh,current:()=>authority(c)&&sourceCurrent(fresh)};
 }
 async function confirmation(request){
  const c=context;if(!c||!authority(c))refuse();
  const answer=await confirm(copy(request));
  if(!authority(c))refuse();
  if(request.kind==='apply'){
   if(!closed(answer,['approved','plan_hash'])||answer.approved!==true||answer.plan_hash!==request.plan_hash)refuse();
   await readFor(c);if(!authority(c))refuse();
  }
  return answer;
 }
 controller=createTransactionController({observe:observation,roots:nativeRoots,readSource:async()=>readFor(context),confirm:confirmation,supervisor,wrapping,now,clock});
 function result(c,value){if(!authority(c))return unavailable();return copy(value);}
 function start(){if(closedRuntime||busy||controller.reapPending||supervisor.blocked)refuse();busy={};return busy;}
 function release(lease){if(lease&&busy===lease)busy=null;}
 async function locked(run){
  let lease;try{lease=start();if(!context||!authority(context)){retire();const o=observed();context={generation,observation:canonical(o),profilePath:o.profilePath,actor:null,source:null};}
   const c=context;return result(c,await run(c));
  }catch{return unavailable();}finally{release(lease);}
 }
 const api={
  localState(){let allowed=false,wrapped=false;try{wrapped=wrapping.available()===true;observed();allowed=!closedRuntime&&wrapped;}catch{}
   const pending=controller.reapPending||supervisor.blocked;
   return {ok:true,status:pending?'reap_pending':allowed?'available':'unavailable',generation,busy:busy!==null,platform:'darwin',supported_recipes:[...RECIPES],wrapped_storage_available:wrapped};
  },
  invalidate(){retire(true);},
  close(){closedRuntime=true;retire(true);controller.close();},
  async plan(sourceHandle,request){
   let c,lease;
   try{
    if(!UUID.test(sourceHandle??'')||!closed(request,['files','values'])||!Array.isArray(request.files)||!request.files.length||request.files.length>128||!request.values||typeof request.values!=='object'||Array.isArray(request.values))refuse();
    if(request.files.some(c=>!closed(c,['id','mode','replace_keys','instructions','code'])||!UUID.test(c.id??'')||!['merge','replace'].includes(c.mode)||!Array.isArray(c.replace_keys)||c.replace_keys.length>1000||c.replace_keys.some(k=>typeof k!=='string'||k.length>200)||typeof c.instructions!=='boolean'||typeof c.code!=='boolean'))refuse();
    if(Object.keys(request.values).length>128||Object.entries(request.values).some(([key,value])=>key.length>100||typeof value!=='string'||value.includes('\0')||Buffer.byteLength(value)>4096)||Object.values(request.values).reduce((n,value)=>n+Buffer.byteLength(value),0)>16*1024)refuse();
    const immutable=copy(request);lease=start();retire();const token=generation,o=observed();
    const source=checkedSource(await service.readForPlan(sourceHandle));
    if(closedRuntime||token!==generation||canonical(observed())!==canonical(o))refuse();
    c={generation,observation:canonical(o),profilePath:o.profilePath,actor:source.principal,source,sourceHandle};context=c;
    const value=await controller.plan(sourceHandle,immutable);
    if(!authority(c))return unavailable();
    if(value.ok===true)plans.set(value.handle,{c,hash:value.plan_hash});
    return result(c,value);
   }catch{return unavailable();}finally{release(lease);}
  },
  async check(handle){
   let lease;try{const e=plans.get(handle);if(!e||!authority(e.c))refuse();lease=start();return result(e.c,await controller.check(handle));}
   catch{return unavailable();}finally{release(lease);}
  },
  async apply(handle,expectedHash){
   let lease;const e=plans.get(handle);if(e)plans.delete(handle); // one-use before awaits
   try{if(!e||!SHA.test(expectedHash??'')||expectedHash!==e.hash||!authority(e.c))refuse();lease=start();return result(e.c,await controller.apply(handle,expectedHash));}
   catch{return unavailable();}finally{release(lease);}
  },
  listLocked(){return locked(()=>controller.listLocked());},
  status(id){if(!UUID.test(id??''))return Promise.resolve(unavailable());return locked(()=>controller.status(id));},
  async recover(id){
   let lease;try{if(!UUID.test(id??''))refuse();lease=start();retire();const o=observed();const c={generation,observation:canonical(o),profilePath:o.profilePath,actor:null,source:null};context=c;
    const value=await controller.recover(id);if(!authority(c))return unavailable();
    if(value.ok===true)recoveries.set(value.handle,{c});return result(c,value);
   }catch{return unavailable();}finally{release(lease);}
  },
  async confirmUndo(handle){
   let lease;const e=recoveries.get(handle);if(e)recoveries.delete(handle);
   try{if(!e||!authority(e.c))refuse();lease=start();return result(e.c,await controller.confirmUndo(handle));}
   catch{return unavailable();}finally{release(lease);}
  },
 };
 return Object.freeze(api);
}
module.exports={createSetupsRuntime,RECIPES};
