'use strict';
const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const {closed,canonical,hash}=require('../plugins/index-verify');
const {validatePayload,UUID,SHA}=require('./payload');
const {LOCAL_VALUE_BYTES,localValues,fill,maskedPreview}=require('./transaction-plan');
const {recipeFor,recipeById,profile,sameProfile,observeTarget,observationEqual,jsonObject,mergeJSON,FILE_BYTES}=require('./transaction-targets');

const CORE_LIMITS=Object.freeze({ttlMs:10*60*1000,handles:32,concurrency:4,filledBytes:8*1024*1024,valuesBytes:LOCAL_VALUE_BYTES});
const ID=/^[A-Za-z0-9_.:-]{1,100}$/;
const unavailable=()=>({ok:false,status:'unavailable',error:'This setup plan or local recovery is unavailable. Review the current profile and access again.'});
const refuse=()=>{throw new Error('Setups transaction is unavailable');};
const actorValid=actor=>closed(actor,['account','team','member','device'])&&Object.values(actor).every(value=>typeof value==='string'&&ID.test(value));
const textOf=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
const clone=value=>JSON.parse(canonical(value));
// Private main-process construction only. observe/readSource/confirm are fixed
// registered callbacks, never renderer-supplied identity, URLs or file paths.
// There is no target mutation or tool execution method in this checkpoint.
function createTransactionCore({observe,readSource,store,confirm=async()=>null,fsApi=fs,now=Date.now}) {
  if(typeof observe!=='function'||typeof readSource!=='function'||typeof confirm!=='function'||!store)refuse();
  const plans=new Map(),recoveries=new Map(),queues=new Map();let generation=0,active=0;
  function capture(offline=false) {
    const value=observe();
    if(!closed(value,['profilePath','platform','osUser','generation','foreground','actor'])||value.platform!==process.platform||value.foreground!==true||!Number.isSafeInteger(value.generation)||value.generation<0||(!actorValid(value.actor)&&!(offline&&value.actor===null)))refuse();
    const captured={profile:profile(value.profilePath,value.platform,value.osUser,fsApi),identity:canonical({generation:value.generation,actor:value.actor}),actor:value.actor?clone(value.actor):null,generation};
    return captured;
  }
  function valid(captured,expires=Infinity,offline=false) {
    try {const current=capture(offline);return captured.generation===generation&&expires>now()&&captured.identity===current.identity&&sameProfile(captured.profile,current.profile,fsApi);}catch{return false;}
  }
  const currentSource=data=>{try{return data?.current?.()===true;}catch{return false;}};
  function checkedSource(data,captured) {
    if(!data||!closed(data,['profileId','versionId','contentHash','payload','principal','current'])||!UUID.test(data.profileId??'')||!UUID.test(data.versionId??'')||!SHA.test(data.contentHash??'')||canonical(data.principal)!==canonical(captured.actor)||!currentSource(data))refuse();
    const checked=validatePayload(data.payload);if(checked.content_hash!==data.contentHash)refuse();return {...data,payload:checked.payload};
  }
  const sourceIdentity=data=>canonical([data.profileId,data.versionId,data.contentHash]);
  function wipe(entry) {if(entry?.targets)for(const target of entry.targets)for(const role of ['before','base','after'])target[role]?.bytes?.fill(0);}
  function expire() {
    for(const map of [plans,recoveries])for(const [id,entry]of map)if(entry.expires<=now()||!valid(entry.captured,entry.expires,map===recoveries)){wipe(entry);map.delete(id);}
  }
  function summary(entry) {
    return {ok:true,handle:entry.handle,kind:'read_only_plan',ready:entry.targets.length>0&&entry.targets.length===entry.rows.length,source_hash:entry.source.contentHash,plan_hash:entry.hash,expires_at:entry.expires,targets:clone(entry.rows)};
  }
  async function queued(key,run) {
    const prior=queues.get(key)??Promise.resolve();let release;const latch=new Promise(resolve=>{release=resolve;});const tail=prior.catch(()=>{}).then(()=>latch);queues.set(key,tail);
    try {await prior.catch(()=>{});return await run();}finally{release();if(queues.get(key)===tail)queues.delete(key);}
  }
  const targetView=(target,values,captured)=>{
    const recipe=recipeById(target.recipe);
    return {recipe:target.recipe,before:maskedPreview(target.before.bytes,recipe,values,captured),shared:{status:'reviewable',content:textOf(target.base.bytes)},after:maskedPreview(target.after.bytes,recipe,values,captured)};
  };
  return {
    invalidate() {generation++;for(const map of [plans,recoveries]){for(const entry of map.values())wipe(entry);map.clear();}},
    async plan(sourceHandle,request) {
      expire();if(active>=CORE_LIMITS.concurrency||plans.size>=CORE_LIMITS.handles||typeof sourceHandle!=='string'||!UUID.test(sourceHandle)||!closed(request,['files','values'])||!Array.isArray(request.files)||!request.files.length||request.files.length>128)return unavailable();
      active++;let entry;
      try {
        // Snapshot the dialog's request before the source await. Later edits to
        // its values/selection cannot change this operation's proposed bytes.
        request=clone(request);
        const captured=capture(),expires=now()+CORE_LIMITS.ttlMs,source=checkedSource(await readSource(sourceHandle),captured);
        if(!valid(captured,expires)||!currentSource(source))refuse();
        const ids=new Set();for(const choice of request.files){if(!closed(choice,['id','mode','replace_keys','instructions','code'])||!UUID.test(choice.id??'')||ids.has(choice.id)||!['merge','replace'].includes(choice.mode)||!Array.isArray(choice.replace_keys)||choice.replace_keys.length>1000||choice.replace_keys.some(key=>typeof key!=='string'||key.length>200)||typeof choice.instructions!=='boolean'||typeof choice.code!=='boolean')refuse();ids.add(choice.id);}
        const selected=request.files.map(choice=>{const file=source.payload.files.find(file=>file.id===choice.id);if(!file)refuse();return file;});
        const values=localValues(selected,request.values,captured),targets=[],rows=[];let filledBytes=0;
        entry={handle:randomUUID(),captured,sourceHandle,source,expires,targets,rows,values};
        for(let index=0;index<selected.length;index++) {
          const file=selected[index],choice=request.files[index],recipe=recipeFor(file,captured.profile.platform);
          if(!recipe||!recipe.adapter){rows.push({file_id:file.id,recipe:recipe?.id??null,status:'adapter_unavailable'});continue;}
          if((recipe.instructions&&!choice.instructions)||(recipe.code&&!choice.code)||(!recipe.instructions&&choice.instructions)||(!recipe.code&&choice.code)||(recipe.adapter==='text'&&choice.mode!=='replace')||(choice.mode==='replace'&&choice.replace_keys.length))refuse();
          const before=observeTarget(captured.profile,recipe,fsApi),base=Buffer.from(file.content),proposed=fill(file.content,file.format,values);let after=proposed,conflicts=[];
          if(recipe.adapter==='json') {
            jsonObject(proposed);
            if(before.exists)jsonObject(textOf(before.bytes));
            if(choice.mode==='merge'&&before.exists){const merge=mergeJSON(textOf(before.bytes),proposed,choice.replace_keys);after=merge.content;conflicts=merge.conflicts;}
            else if(choice.replace_keys.length)refuse();
          }
          const target={recipe:recipe.id,file:file.id,mode:choice.mode,before,base:{exists:true,bytes:base,identity:null,mode:null},after:{exists:true,bytes:Buffer.from(after),identity:null,mode:before.mode??0o600}};
          filledBytes+=target.after.bytes.length;if(filledBytes>CORE_LIMITS.filledBytes)refuse();
          const view=targetView(target,values,captured);
          if(view.before.status==='withheld'||view.after.status==='withheld'){wipe({targets:[target]});rows.push({file_id:file.id,recipe:recipe.id,status:'local_review_unavailable'});continue;}
          targets.push(target);rows.push({file_id:file.id,recipe:recipe.id,status:'reviewable',mode:choice.mode,exists:before.exists,before_hash:before.hash,after_hash:hash(target.after.bytes),before_bytes:before.bytes.length,after_bytes:target.after.bytes.length,conflicts,changed:!before.exists||before.hash!==hash(target.after.bytes)});
        }
        if(!valid(captured,expires)||!currentSource(source))refuse();
        entry.hash=hash({schema:1,owner:captured.identity,profile:captured.profile.id,source:sourceIdentity(source),rows,choices:request.files});
        plans.set(entry.handle,entry);return summary(entry);
      } catch {wipe(entry);return unavailable();} finally {active--;}
    },
    async prepare(handle,expectedHash) {
      expire();const entry=plans.get(handle);
      if(!entry||entry.hash!==expectedHash||!entry.targets.length||entry.targets.length!==entry.rows.length||active>=CORE_LIMITS.concurrency)return unavailable();
      // Consume before any queue or dialog await. Retries cannot copy sensitive
      // snapshots twice, and a stale failure never resurrects this plan.
      plans.delete(handle);active++;
      try {return await queued(entry.captured.profile.id,async()=>{
        if(!valid(entry.captured,entry.expires)||!currentSource(entry.source))refuse();
        const source=checkedSource(await readSource(entry.sourceHandle),entry.captured);
        if(!valid(entry.captured,entry.expires)||sourceIdentity(source)!==sourceIdentity(entry.source)||!currentSource(entry.source)||!currentSource(source))refuse();
        const decision=await confirm({kind:'prepare',plan_hash:entry.hash,summary:summary(entry),previews:entry.targets.map(target=>targetView(target,entry.values,entry.captured)),meaning:'Encrypted local snapshots only; no tool files will change.'});
        if(!valid(entry.captured,entry.expires)||!currentSource(entry.source)||!currentSource(source)||!closed(decision,['approved','plan_hash'])||decision.approved!==true||decision.plan_hash!==entry.hash)refuse();
        for(const target of entry.targets){const fresh=observeTarget(entry.captured.profile,recipeById(target.recipe),fsApi);try{if(!observationEqual(target.before,fresh))refuse();}finally{fresh.bytes.fill(0);}}
        if(!valid(entry.captured,entry.expires)||!currentSource(entry.source)||!currentSource(source))refuse();
        const receipt=store.prepare({profileId:entry.captured.profile.id,owner:hash(entry.captured.actor),planHash:entry.hash,source:{profile:source.profileId,version:source.versionId,hash:source.contentHash},targets:entry.targets});
        if(!valid(entry.captured,entry.expires)||!currentSource(entry.source)||!currentSource(source))refuse();
        return {ok:true,transaction_id:receipt.id,phase:'prepared',targets:receipt.targets,target_files_changed:false};
      });}catch{return unavailable();}finally{wipe(entry);active--;}
    },
    listRecovery() {
      try {const captured=capture(true),rows=store.list();if(!valid(captured,Infinity,true))refuse();return {ok:true,status:'locked',transactions:rows};}catch{return unavailable();}
    },
    async recover(id) {
      expire();if(active>=CORE_LIMITS.concurrency||recoveries.size>=CORE_LIMITS.handles||!UUID.test(id??''))return unavailable();active++;let data;
      try {
        const captured=capture(true),expires=now()+CORE_LIMITS.ttlMs;data=store.read(id,captured.profile.id);
        if(!valid(captured,expires,true))refuse();
        // No old source, actor, profile text, file contents or preview reaches
        // the dialog before this separate fresh foreground local confirmation.
        const decision=await confirm({kind:'recovery',transaction_id:id,meaning:'Review encrypted local recovery for this OS profile. This does not restore team access or change tool files.'});
        if(!valid(captured,expires,true)||!closed(decision,['approved','transaction_id'])||decision.approved!==true||decision.transaction_id!==id)refuse();
        const rows=data.targets.map(target=>{
          const current=observeTarget(captured.profile,recipeById(target.recipe),fsApi);
          try {
            const before=current.exists===target.before.exists&&current.hash===target.before.hash;
            const after=current.exists===target.after.exists&&current.hash===target.after.hash;
            return {recipe:target.recipe,status:before?'content_matches_before':after?'content_matches_after':'changed',identity_matches_before:current.identity===target.before.identity,mode_matches_before:current.mode===target.before.mode,mode_matches_after:current.mode===target.after.mode};
          } finally {current.bytes.fill(0);}
        });
        if(!valid(captured,expires,true))refuse();const handle=randomUUID();recoveries.set(handle,{handle,id,captured,expires});
        return {ok:true,handle,transaction_id:id,phase:data.manifest.phase,targets:rows,target_files_changed:false,recovery_authority:'own_local_review_only'};
      }catch{return unavailable();}finally{data?.close();active--;}
    },
    reviewRecovery(handle) {
      expire();const entry=recoveries.get(handle);if(!entry||!valid(entry.captured,entry.expires,true))return unavailable();let data;
      try {
        data=store.read(entry.id,entry.captured.profile.id);
        const previews=data.targets.map(target=>{
          const recipe=recipeById(target.recipe);
          return {recipe:target.recipe,before:{status:'withheld',content:null},shared:{status:'reviewable',content:textOf(target.base.bytes)},after:{status:'withheld',content:null}};
        });
        // Filled values are not reconstructed from secrets in encrypted bytes.
        // This first core withholds local previews on restart until a later
        // reviewed local-value masking adapter can safely reconstruct them.
        if(!valid(entry.captured,entry.expires,true))refuse();return {ok:true,transaction_id:entry.id,previews,local_previews:'withheld_local_values'};
      }catch{return unavailable();}finally{data?.close();}
    },
  };
}
module.exports={CORE_LIMITS,createTransactionCore};
