'use strict';
const {Worker,isMainThread,parentPort}=require('node:worker_threads');
const {performance}=require('node:perf_hooks');
const C=require('./native-codec');
const J=require('./transaction-journal');
const {localValues,fill,maskedPreview}=require('./transaction-plan');
const {recipeFor,recipeById,jsonObject,mergeJSON}=require('./transaction-targets');
const {validatePayload}=require('./payload');
function buffers(v){if(v instanceof Uint8Array)return Buffer.from(v);if(Array.isArray(v))return v.map(buffers);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,buffers(x)]));return v;}
function post(port,value){const transfers=[];const copied=(v)=>{if(Buffer.isBuffer(v)||v instanceof Uint8Array){const b=new Uint8Array(v.length);b.set(v);transfers.push(b.buffer);return b;}if(Array.isArray(v))return v.map(copied);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,copied(x)]));return v;};port.postMessage(copied(value),transfers);}
const fail=()=>{throw new Error('Setups private worker is unavailable');};
function format(input){
 if(!C.closed(input,['payload','choices','values','profile','snapshots'])||!Array.isArray(input.choices)||!input.choices.length||input.choices.length>128||!Array.isArray(input.snapshots)||input.snapshots.length!==input.choices.length||typeof input.profile?.root!=='string'||input.profile.platform!=='darwin')fail();
 const payload=validatePayload(input.payload).payload,selected=input.choices.map(choice=>payload.files.find(f=>f.id===choice.id));if(selected.some(f=>!f)||new Set(input.choices.map(c=>c.id)).size!==selected.length)fail();
 const captured={profile:input.profile},values=localValues(selected,input.values,captured),targets=[],rows=[];
 try{selected.forEach((file,index)=>{
  const choice=input.choices[index],recipe=recipeFor(file,'darwin');
  if(!C.closed(choice,['id','mode','replace_keys','instructions','code'])||!['merge','replace'].includes(choice.mode)||!Array.isArray(choice.replace_keys)||choice.replace_keys.length>1000||choice.replace_keys.some(k=>typeof k!=='string'||k.length>200)||typeof choice.instructions!=='boolean'||typeof choice.code!=='boolean')fail();
  if(!recipe?.adapter||!['codex-instructions-v1','claude-settings-v1','gemini-settings-v1'].includes(recipe.id)){rows.push({file_id:file.id,recipe:recipe?.id??null,status:'adapter_unavailable'});return;}
  if(choice.instructions!==recipe.instructions||choice.code!==recipe.code||(recipe.adapter==='text'&&choice.mode!=='replace')||(choice.mode==='replace'&&choice.replace_keys.length))fail();
  const before=C.snapshot(input.snapshots[index]);try{if(before.recipe!==indexFor(recipe.id))fail();const proposed=fill(file.content,file.format,values);let after=proposed,conflicts=[];
   if(recipe.adapter==='json'){jsonObject(proposed);if(before.exists)jsonObject(new TextDecoder('utf-8',{fatal:true}).decode(before.content));if(choice.mode==='merge'&&before.exists){const merged=mergeJSON(before.content.toString('utf8'),proposed,choice.replace_keys);after=merged.content;conflicts=merged.conflicts;}else if(choice.replace_keys.length)fail();}
   const bytes=Buffer.from(after),old=maskedPreview(before.content,recipe,values,captured),next=maskedPreview(bytes,recipe,values,captured);if(old.status!=='reviewable'||next.status!=='reviewable'){bytes.fill(0);rows.push({file_id:file.id,recipe:recipe.id,status:'local_review_unavailable'});return;}
   targets.push({file:file.id,recipe:recipe.id,before:Buffer.from(before.content),base:Buffer.from(file.content),after:bytes,metadata:Buffer.from(input.snapshots[index])});rows.push({file_id:file.id,recipe:recipe.id,status:'reviewable',mode:choice.mode,exists:before.exists,before_hash:J.hashText(before.content),after_hash:J.hashText(bytes),conflicts,before:old,shared:{status:'reviewable',content:file.content},after:next});
  }finally{C.wipe(before);}
 });return {targets,rows};}catch(error){C.wipe(targets);throw error;}
}
function indexFor(recipe){return ['codex-instructions-v1','claude-settings-v1','gemini-settings-v1'].indexOf(recipe)+1;}
if(!isMainThread){
 const journals=new Map(),pending=new Map();let active=null,rpcSeq=0;
 const remote=(method,args)=>new Promise((resolve,reject)=>{if(!active)fail();const id=++rpcSeq;pending.set(id,{resolve,reject});post(parentPort,{rpc:id,job:active.id,method,args});});
 const io=()=>Object.fromEntries(['admit','create','write','sync','read','inventory'].map(method=>[method,(...args)=>remote('io:'+method,args)]));
 const wrapping={available:()=>true,wrap:key=>remote('wrap',[key]),unwrap:key=>remote('unwrap',[key])};
 parentPort.on('message',async raw=>{const m=buffers(raw);
  if(m?.rpcReply){const p=pending.get(m.rpcReply);if(!p)return;pending.delete(m.rpcReply);m.ok?p.resolve(m.result):p.reject(new Error('Unavailable'));return;}
  if(active||!C.closed(m,['id','kind','input'])||!Number.isSafeInteger(m.id)){post(parentPort,{id:m?.id,ok:false});return;}
  active=m;rpcSeq=0;let result;
  try{
   if(m.kind==='format')result=format(m.input);
   else if(m.kind==='prepare'){if(journals.size>=16)fail();const handle=await J.prepareJournal({...m.input,io:io(),wrapping,current:()=>active!==null});journals.set(handle.context.id,handle);result={id:handle.context.id,prepared_hash:handle.preparedHash,manifest:handle.manifest};}
   else if(m.kind==='recover'){if(journals.size>=16||journals.has(m.input.id))fail();const handle=await J.recoverJournal({...m.input,io:io(),wrapping,current:()=>active!==null});journals.set(handle.context.id,handle);result={id:handle.context.id,prepared_hash:handle.preparedHash,manifest:handle.manifest,events:handle.events};}
   else {const handle=journals.get(m.input.id);if(!handle)fail();
    if(m.kind==='append')result=await handle.append(m.input.kind,m.input.target,m.input.payload);
    else if(m.kind==='target')result=await handle.readTarget(m.input.index);
    else if(m.kind==='close'){handle.close();journals.delete(m.input.id);result={closed:true};}
    else fail();
   }
   post(parentPort,{id:m.id,ok:true,result});
  }catch{post(parentPort,{id:m.id,ok:false});}finally{C.wipe(m.input);if(m.kind==='format'||m.kind==='target'||m.kind==='recover')C.wipe(result);active=null;}
 });
} else {
 function createTransactionWorker({now=()=>performance.now(),create=()=>new Worker(__filename,{env:{},execArgv:[]})}={}){ // privacy-flow: setups-private-worker
  const worker=create();let seq=0,active=null,retired=false,exited=false,termination=null;const validJob=job=>{try{return job&&!retired&&now()<job.cutoff&&job.current()===true;}catch{return false;}};
  worker.once('exit',()=>{exited=true;retired=true;active?.reject(new Error('Setups private worker is unavailable'));active=null;});
  worker.once('error',()=>{retired=true;active?.reject(new Error('Setups private worker is unavailable'));active=null;});
  worker.on('message',async raw=>{const m=buffers(raw),job=active;if(!validJob(job)){C.wipe(m);return;}
   if(m.rpc){if(!C.closed(m,['rpc','job','method','args'])||!Number.isSafeInteger(m.rpc)||m.rpc!==job.rpc+1||m.job!==job.id||!Array.isArray(m.args)){void close();return;}job.rpc=m.rpc;let result;
    try{if(m.method==='wrap'||m.method==='unwrap'){if(m.method!==(job.kind==='prepare'?'wrap':job.kind==='recover'?'unwrap':null)||m.args.length!==1)fail();if(job.wrapping.available()!==true)fail();result=await job.wrapping[m.method](m.args[0]);if(job.wrapping.available()!==true)fail();}else {const method=m.method?.startsWith('io:')?m.method.slice(3):'';const allow={prepare:['admit','create','write','sync'],recover:['read','inventory'],append:['write','sync'],target:['read']};if(!allow[job.kind]?.includes(method)||typeof job.io?.[method]!=='function')fail();result=await job.io[method](...m.args);}if(active!==job||!validJob(job)){C.wipe(result);return;}post(worker,{rpcReply:m.rpc,ok:true,result});C.wipe(result);}catch{if(active===job&&!retired)post(worker,{rpcReply:m.rpc,ok:false});}finally{C.wipe(m.args);}return;}
   if(!C.closed(m,m.ok?['id','ok','result']:['id','ok'])||m.id!==job.id||typeof m.ok!=='boolean'){void close();return;}clearTimeout(job.timer);active=null;m.ok?job.resolve(m.result):job.reject(new Error('Setups private worker is unavailable'));
  });
  function close(){retired=true;active?.reject(new Error('Setups private worker is unavailable'));if(active)clearTimeout(active.timer);active=null;termination??=worker.terminate();return {exited,promise:termination};}
  return {run(kind,input,{io,wrapping,current,cutoff}){if(retired||active||!['format','prepare','recover','append','target','close'].includes(kind)||typeof current!=='function'||!Number.isFinite(cutoff)||cutoff<=now()||current()!==true)return Promise.reject(new Error('Setups private worker is unavailable'));
    return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{void close();reject(new Error('Setups private worker is unavailable'));},Math.max(1,cutoff-now()));active={id,kind,rpc:0,resolve,reject,io,wrapping,current,cutoff,timer};post(worker,{id,kind,input});});},close,get unavailable(){return retired;},get reapPending(){return retired&&!exited;}};
 }
 module.exports={createTransactionWorker,format,indexFor};
}
