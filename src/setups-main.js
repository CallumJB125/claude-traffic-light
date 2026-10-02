'use strict';
// Trusted main-process composition. This object and its dependencies never
// cross IPC; only the eight closed renderer methods below are registered.
const fs=require('node:fs'),os=require('node:os');
const {createSetupsRuntime}=require('./setups-runtime');
const {createSetupsPlatform}=require('./setups-platform');
const {safeStorageWrapping}=require('./borrow/transaction-store');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,SHA=/^[0-9a-f]{64}$/;
const uuid=value=>typeof value==='string'&&UUID.test(value),sha=value=>typeof value==='string'&&SHA.test(value);
const unavailable=()=>({ok:false,status:'unavailable',error:'Review the current setup and local access again.'});
const closed=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function choices(input){
 if(!closed(input,['files','values'])||!Array.isArray(input.files)||!input.files.length||input.files.length>128||new Set(input.files.map(f=>f?.id)).size!==input.files.length||!input.values||typeof input.values!=='object'||Array.isArray(input.values))return null;
 if(input.files.some(f=>!closed(f,['id','mode','replace_keys','instructions','code'])||!uuid(f.id)||!['merge','replace'].includes(f.mode)||!Array.isArray(f.replace_keys)||f.replace_keys.length>1000||f.replace_keys.some(k=>typeof k!=='string'||k.length>200)||typeof f.instructions!=='boolean'||typeof f.code!=='boolean'))return null;
 if(Object.keys(input.values).length>128||Object.entries(input.values).some(([k,v])=>!/^(USER|HOSTNAME|NAME|EMAIL(?::\d+)?|IP:\d+|HOST:\d+|PRIVATE:\d+|SSH_USER|SECRET:[\w.-]{1,64})$/.test(k)||typeof v!=='string'||v.includes('\0')||Buffer.byteLength(v)>4096)||Object.values(input.values).reduce((n,v)=>n+Buffer.byteLength(v),0)>16384)return null;
 return JSON.parse(JSON.stringify(input));
}
function createSetupsMain({app,buddy,service,dialog,safeStorage,resourcesPath=process.resourcesPath,platform=process.platform,userInfo=()=>os.userInfo(),realpath=p=>fs.realpathSync(p),runtimeFactory=createSetupsRuntime,platformFactory=createSetupsPlatform}){
 let runtime=null,stopped=false,last=null,epoch=0;
 function owner(){
  const b=buddy(),c=b?.setupsContext?.();
  if(!c?.foreground||!c.window||!c.contents||!c.contents.mainFrame||c.window.isDestroyed()||c.contents.isDestroyed()||!Number.isSafeInteger(c.generation)||c.generation<0){if(last){last=null;epoch++;}return null;}
  if(!last||last.buddy!==b||last.window!==c.window||last.contents!==c.contents||last.frame!==c.contents.mainFrame||last.document!==c.generation){last={buddy:b,window:c.window,contents:c.contents,frame:c.contents.mainFrame,document:c.generation};epoch++;}
  return {...last,generation:epoch};
 }
 function same(before){const after=owner();return !!before&&!!after&&before.buddy===after.buddy&&before.window===after.window&&before.contents===after.contents&&before.frame===after.frame&&before.document===after.document&&before.generation===after.generation;}
 function getRuntime(){
  if(stopped||platform!=='darwin'||app.isPackaged!==true)throw Error('unavailable');
  if(runtime)return runtime;
  const info=userInfo();if(!Number.isSafeInteger(info.uid)||info.uid<0||typeof info.homedir!=='string')throw Error('unavailable');
  const profile=realpath(info.homedir),local=platformFactory({app,resourcesPath,profilePath:profile,uid:info.uid,platform});
  runtime=runtimeFactory({service,roots:()=>local.roots(),launch:opts=>local.launch(opts),wrapping:safeStorageWrapping(safeStorage,platform),
   observe(){const c=owner();if(!c)throw Error('unavailable');return {profilePath:profile,platform,osUser:`uid:${info.uid}`,generation:c.generation,foreground:true};},
   currentActor:actor=>buddy()?.setupsActorCurrent?.(actor)===true,
   currentSource:source=>source?.current?.()===true,
   async confirm(request){
    const before=owner();if(!before)return null;
    const {kind}=request??{};let title,message,detail,approved;
    if(kind==='apply'&&sha(request.plan_hash)){
     title='Apply reviewed setup';message='Apply this exact reviewed local plan?';detail=`Review the complete masked before/after text, conflicts and replacement choices in Setups. Configuration can influence tool behavior. No tools or commands will run.\n\nPlan: ${request.plan_hash}`;approved={approved:true,plan_hash:request.plan_hash};
    }else if(kind==='recovery'&&uuid(request.transaction_id)){
     title='Review local recovery';message='Unlock and inspect this computer’s retained local transaction?';detail=`This inspection does not restore any files. Undo requires a separate confirmation.\n\nTransaction: ${request.transaction_id}`;approved={approved:true,transaction_id:request.transaction_id};
    }else if(kind==='undo'&&uuid(request.transaction_id)&&sha(request.inspection_hash)){
     title='Undo reviewed local changes';message='Conditionally restore this reviewed local transaction?';detail=`Restore only targets that still match this transaction’s verified changes. Changed or uncertain targets are retained for review.\n\nTransaction: ${request.transaction_id}\nInspection: ${request.inspection_hash}`;approved={approved:true,transaction_id:request.transaction_id,inspection_hash:request.inspection_hash};
    }else return null;
    const answer=await before.buddy.setupsConfirm(window=>dialog.showMessageBox(window,{type:'warning',title,message,detail,buttons:['Cancel',title],defaultId:0,cancelId:0,noLink:true}));
    return answer?.response===1&&same(before)?approved:null;
   },
  });return runtime;
 }
 const handlers={
  'setups:local-state':{args:a=>a.length===0,run:r=>r.localState()},
  'setups:plan':{args:a=>a.length===2&&uuid(a[0])&&choices(a[1])!==null,run:(r,a)=>r.plan(a[0],choices(a[1]))},
  'setups:check':{args:a=>a.length===1&&uuid(a[0]),run:(r,a)=>r.check(a[0])},
  'setups:apply':{args:a=>a.length===2&&uuid(a[0])&&sha(a[1]),run:(r,a)=>r.apply(a[0],a[1])},
  'setups:list-locked':{args:a=>a.length===0,run:r=>r.listLocked()},
  'setups:local-status':{args:a=>a.length===1&&uuid(a[0]),run:(r,a)=>r.status(a[0])},
  'setups:recover':{args:a=>a.length===1&&uuid(a[0]),run:(r,a)=>r.recover(a[0])},
  'setups:confirm-undo':{args:a=>a.length===1&&uuid(a[0]),run:(r,a)=>r.confirmUndo(a[0])},
 };
 return Object.freeze({
  register(ipc){for(const [channel,h]of Object.entries(handlers))ipc.handle(channel,async(event,...args)=>{try{const before=owner();if(!before||event.sender!==before.contents||event.senderFrame!==before.frame||!h.args(args))return unavailable();const result=await h.run(getRuntime(),args);return same(before)?result:unavailable();}catch{return unavailable();}});},
  invalidate(){last=null;epoch++;if(runtime)runtime.invalidate();else service.invalidate();},
  close(){stopped=true;last=null;epoch++;if(runtime)runtime.close();else service.invalidate();},
 });
}
module.exports={createSetupsMain};
