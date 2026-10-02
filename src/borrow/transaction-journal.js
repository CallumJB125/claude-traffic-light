'use strict';
const {createCipheriv,createDecipheriv,randomBytes,randomUUID}=require('node:crypto');
const {canonical,strictJSON}=require('../plugins/index-verify');
const C=require('./native-codec');
const JOURNAL_LIMITS=Object.freeze({transaction:64*1024*1024,total:128*1024*1024,namespaces:16,events:64,children:512,targets:128});
const PHASES=Object.freeze(['prepared','preparation','apply_intent','observed','verified','conflict','unknown','undo_intent','undone']);
const fail=()=>{throw new Error('Setups encrypted recovery is unavailable');};
const hashText=b=>C.hash(b).toString('hex');
const SHA=/^[0-9a-f]{64}$/;
const json=v=>Buffer.from(canonical(v));
function contextValid(c){if(!C.closed(c,['id','profile','owner','plan','source'])||![c.profile,c.owner,c.plan].every(v=>typeof v==='string'&&SHA.test(v))||!C.closed(c.source,['profile','version','hash'])||!SHA.test(c.source.hash))fail();C.uuid(c.id);C.uuid(c.source.profile);C.uuid(c.source.version);return c;}
function aad(context,header){contextValid(context);return Buffer.concat([Buffer.from('PF-JOURNAL-V2\0'),header,json(context)]);}
function seal(key,context,role,index,sequence,plain){C.bytes(key,32);if(!Buffer.isBuffer(plain)||plain.length>C.LIMITS.receipt-72)fail();const header=C.sealedHeader(context.id,role,index,sequence,plain.length+28),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad(context,header));return Buffer.concat([header,nonce,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);}
function open(key,context,role,index,sequence,sealed){C.bytes(key,32);if(!Buffer.isBuffer(sealed)||sealed.length<72||sealed.length>C.LIMITS.receipt)fail();const header=C.sealedHeader(context.id,role,index,sequence,sealed.length-44);if(!C.same(sealed.subarray(0,44),header))fail();const cipher=createDecipheriv('aes-256-gcm',key,sealed.subarray(44,56));cipher.setAAD(aad(context,header));cipher.setAuthTag(sealed.subarray(-16));try{return Buffer.concat([cipher.update(sealed.subarray(56,-16)),cipher.final()]);}catch{fail();}}
// Manifest outer body contains only the wrapped key + authenticated context
// locator. They confer no authority until unwrap, AEAD and full validation.
function manifestSeal(key,context,wrapped,manifest){if(!Buffer.isBuffer(wrapped)||!wrapped.length||wrapped.length>64*1024||C.same(key,wrapped))fail();const locator=json(context),encrypted=seal(key,context,0,0,0,json({...manifest,wrapped_key_hash:hashText(wrapped)})),body=new C.Writer(C.LIMITS.receipt-44).blob(locator,4096).blob(wrapped,64*1024).blob(encrypted,C.LIMITS.receipt).finish();return Buffer.concat([C.sealedHeader(context.id,0,0,0,body.length),body]);}
function manifestOuter(sealed,id){if(!Buffer.isBuffer(sealed)||sealed.length>C.LIMITS.receipt||sealed.length<48)fail();if(!C.same(sealed.subarray(0,44),C.sealedHeader(id,0,0,0,sealed.length-44)))fail();const r=new C.Reader(sealed.subarray(44));const context=strictJSON(r.blob(4096),4096),wrapped=Buffer.from(r.blob(64*1024)),encrypted=Buffer.from(r.blob(C.LIMITS.receipt));r.done();contextValid(context);if(context.id!==id||!wrapped.length)fail();return {context,wrapped,encrypted};}
function validateManifest(m,c){
 if(!C.closed(m,['schema','context','created_at','phase','targets','maximum_events','admitted_bytes','wrapped_key_hash'])||m.schema!==2||!SHA.test(m.wrapped_key_hash)||canonical(m.context)!==canonical(c)||m.phase!=='prepared'||!Number.isSafeInteger(m.created_at)||m.created_at<0||!Array.isArray(m.targets)||!m.targets.length||m.targets.length>128||!Number.isSafeInteger(m.maximum_events)||m.maximum_events>64||m.maximum_events<1||!Number.isSafeInteger(m.admitted_bytes)||m.admitted_bytes<1||m.admitted_bytes>JOURNAL_LIMITS.transaction)fail();
 const files=new Set(),recipes=new Set();m.targets.forEach((t,index)=>{if(!C.closed(t,['index','file','recipe','before_hash','after_hash','metadata_hash','base_hash','snapshot_hash','binding_hash','sizes'])||t.index!==index||!['codex-instructions-v1','claude-settings-v1','gemini-settings-v1'].includes(t.recipe)||files.has(t.file)||recipes.has(t.recipe)||![t.before_hash,t.after_hash,t.metadata_hash,t.base_hash,t.snapshot_hash,t.binding_hash].every(x=>SHA.test(x))||!C.closed(t.sizes,['before','base','after','metadata'])||Object.values(t.sizes).some(x=>!Number.isInteger(x)||x<0||x>C.LIMITS.snapshot))fail();C.uuid(t.file);files.add(t.file);recipes.add(t.recipe);});return m;
}
// io accepts fixed roles only; implementations must use reviewed native store.
// All whole-selection ciphertext is admitted before exclusive namespace create.
async function prepareJournal({io,wrapping,context,targets,now=Date.now,current=()=>false}){
 contextValid(context);if(!Array.isArray(targets)||!targets.length||targets.length>128||current()!==true||wrapping.available()!==true)fail();
 const key=randomBytes(32),records=[];let wrapped;
 try{
  const forWrap=Buffer.from(key);try{wrapped=await wrapping.wrap(forWrap);}finally{forWrap.fill(0);}if(current()!==true||wrapping.available()!==true)fail();
  const maximum_events=2+targets.length*8;if(maximum_events>64||targets.length*4+1+maximum_events>512)fail();
  const summaries=targets.map((target,index)=>{
   const before=C.snapshot(target.metadata);let snapshotHash,bindingHash;try{if(!C.same(before.content,target.before)||before.recipe!==['codex-instructions-v1','claude-settings-v1','gemini-settings-v1'].indexOf(target.recipe)+1)fail();snapshotHash=before.digest.toString('hex');bindingHash=before.binding_hash.toString('hex');}finally{C.wipe(before);}
   const sizes={};for(const [role,name]of [[1,'before'],[2,'base'],[3,'after'],[4,'metadata']]){const plain=target[name];if(!Buffer.isBuffer(plain)||plain.length>(name==='metadata'?C.LIMITS.snapshot:C.LIMITS.content))fail();sizes[name]=plain.length;records.push({role,index,sequence:0,bytes:seal(key,context,role,index,0,plain)});}
   return {index,file:target.file,recipe:target.recipe,before_hash:hashText(target.before),after_hash:hashText(target.after),metadata_hash:hashText(target.metadata),base_hash:hashText(target.base),snapshot_hash:snapshotHash,binding_hash:bindingHash,sizes};
  });
  // Admit worst complete binary receipt/intent lifecycle, not nominal targets.
  const admitted=records.reduce((n,r)=>n+r.bytes.length,0)+C.LIMITS.receipt+maximum_events*(C.LIMITS.receipt+72);
  if(admitted>JOURNAL_LIMITS.transaction)fail();
  const manifest=validateManifest({schema:2,context,created_at:now(),phase:'prepared',targets:summaries,maximum_events,admitted_bytes:admitted,wrapped_key_hash:hashText(wrapped)},context),header=manifestSeal(key,context,wrapped,manifest);
  if(current()!==true)fail();await io.admit(admitted,records.length+1+maximum_events);if(current()!==true)fail();await io.create(context.id);
  for(const record of records){if(current()!==true)fail();await io.write(record.role,record.index,record.sequence,record.bytes);if(current()!==true)fail();}
  await io.sync();if(current()!==true)fail();await io.write(0,0,0,header);await io.sync();if(current()!==true)fail();
  return journalHandle({io,key,context,manifest,preparedHash:hashText(header),sequence:0,previous:hashText(header),current,events:[]});
 }catch(error){key.fill(0);throw error;}finally{records.forEach(r=>r.bytes.fill(0));wrapped?.fill(0);}
}
function eventPlain(event){const meta=json({schema:2,kind:event.kind,target:event.target,previous:event.previous,payload_hash:hashText(event.payload)});return new C.Writer(C.LIMITS.receipt-72).blob(meta,4096).blob(event.payload,C.LIMITS.receipt-8192).finish();}
function eventOpen(plain){const r=new C.Reader(plain),meta=strictJSON(r.blob(4096),4096),payload=Buffer.from(r.blob(C.LIMITS.receipt-8192));r.done();if(!C.closed(meta,['schema','kind','target','previous','payload_hash'])||meta.schema!==2||!PHASES.includes(meta.kind)||!Number.isInteger(meta.target)||meta.target<0||meta.target>=128||!SHA.test(meta.previous)||hashText(payload)!==meta.payload_hash)fail();return {...meta,payload};}
function validateEvent(kind,target,payload,events,manifest,context){
 if(!Number.isInteger(target)||target<0||target>=manifest.targets.length||!Buffer.isBuffer(payload))fail();
 const previous=events.filter(e=>e.target===target).at(-1)?.kind??'prepared';
 const allowed={prepared:['preparation','conflict','unknown'],preparation:['apply_intent','conflict','unknown'],apply_intent:['observed','conflict','unknown'],observed:['verified','conflict','unknown','undo_intent'],verified:['undo_intent','conflict','unknown'],undo_intent:['undone','conflict','unknown']};
 if(!allowed[previous]?.includes(kind))fail();
 if(kind==='preparation'&&manifest.targets.some((_,i)=>i<target&&events.filter(e=>e.target===i).at(-1)?.kind!=='verified'))fail();
 let decoded;
 try{
  if(['preparation','observed','verified','undone'].includes(kind)){
   decoded=C.receipt(payload);const t=manifest.targets[target];
   if(!C.same(decoded.transaction,C.uuid(context.id))||decoded.target_index!==target||!C.same(decoded.plan_hash,Buffer.from(context.plan,'hex'))||decoded.native.recipe!==['codex-instructions-v1','claude-settings-v1','gemini-settings-v1'].indexOf(t.recipe)+1)fail();
   if(['verified','undone'].includes(kind)&&decoded.result!==0)fail();const intended=events.filter(e=>e.target===target&&['apply_intent','undo_intent'].includes(e.kind)).at(-1);if(intended&&!C.same(decoded.record_hash,Buffer.from(intended.hash,'hex')))fail();
   if(kind==='verified'){const object=decoded.objects[0].snapshot;if(!object?.exists||hashText(object.content)!==t.after_hash)fail();}
   if(kind==='undone'){const object=decoded.objects[0].snapshot;if(object?hashText(object.content)!==t.before_hash:decoded.objects[0].tag!==1)fail();}
  }else if(kind==='apply_intent'||kind==='undo_intent'){
   let pair;try{if(kind==='undo_intent')pair=intentPair(payload);decoded=C.intent(pair?pair.intent:payload);}finally{C.wipe(pair);}
   if(!C.same(decoded.transaction,C.uuid(context.id))||decoded.target_index!==target||!C.same(decoded.plan_hash,Buffer.from(context.plan,'hex'))||decoded.action!==(kind==='apply_intent'?1:2)||decoded.recipe!==['codex-instructions-v1','claude-settings-v1','gemini-settings-v1'].indexOf(manifest.targets[target].recipe)+1||!C.same(decoded.before_hash,Buffer.from(manifest.targets[target].snapshot_hash,'hex'))||!C.same(decoded.binding_hash,Buffer.from(manifest.targets[target].binding_hash,'hex')))fail();
  }else if(!['conflict','unknown'].includes(kind)||payload.length!==0)fail();
 }finally{C.wipe(decoded);}
}
function intentPair(payload){const r=new C.Reader(payload,C.LIMITS.receipt-8192),receipt=Buffer.from(r.blob(C.LIMITS.receipt)),intent=Buffer.from(r.blob(16384));r.done();const check=C.receipt(receipt);C.wipe(check);return {receipt,intent};}
function journalHandle({io,key,context,manifest,preparedHash,sequence,previous,current,events=[]}){
 let closed=false,busy=false;
 const valid=()=>{if(closed||current()!==true)fail();};
 return {context,manifest,preparedHash,get previous(){return previous;},get events(){return events.map(e=>({...e,payload:Buffer.from(e.payload)}));},
  async append(kind,target,payload){valid();if(busy||!PHASES.includes(kind)||!Number.isInteger(target)||target<0||target>=manifest.targets.length||sequence>=manifest.maximum_events||!Buffer.isBuffer(payload))fail();validateEvent(kind,target,payload,events,manifest,context);busy=true;let plain,sealed;
   try{plain=eventPlain({kind,target,previous,payload});sealed=seal(key,context,5,0,sequence,plain);await io.write(5,0,sequence,sealed);await io.sync();valid();const out={kind,target,sequence,previous,hash:hashText(sealed),payload:Buffer.from(payload)};events.push(out);previous=out.hash;sequence++;return {hash:out.hash,previous:out.previous,sequence:out.sequence};}finally{plain?.fill(0);sealed?.fill(0);busy=false;}
  },
  async readTarget(index){valid();const t=manifest.targets[index];if(!t)fail();const out={recipe:t.recipe,file:t.file};try{for(const [role,name]of [[1,'before'],[2,'base'],[3,'after'],[4,'metadata']]){const sealed=await io.read(role,index,0);valid();out[name]=open(key,context,role,index,0,sealed);sealed.fill(0);if(out[name].length!==t.sizes[name]||hashText(out[name])!==t[name==='metadata'?'metadata_hash':name+'_hash'])fail();}const checked=C.snapshot(out.metadata);try{if(checked.recipe!==['codex-instructions-v1','claude-settings-v1','gemini-settings-v1'].indexOf(t.recipe)+1||!C.same(checked.content,out.before))fail();}finally{C.wipe(checked);}return out;}catch(error){C.wipe(out);throw error;}},
  close(){if(closed)return;closed=true;key.fill(0);C.wipe(events);},
 };
}
async function recoverJournal({io,wrapping,id,profile,current=()=>false}){
 // Caller must obtain fresh local foreground confirmation before invoking this.
 if(current()!==true||wrapping.available()!==true)fail();let key,plain;
 try{const sealed=await io.read(0,0,0);if(current()!==true)fail();const outer=manifestOuter(sealed,id);if(outer.context.profile!==profile)fail();const wrappedHash=hashText(outer.wrapped);key=await wrapping.unwrap(outer.wrapped);outer.wrapped.fill(0);C.bytes(key,32);if(current()!==true||wrapping.available()!==true)fail();plain=open(key,outer.context,0,0,0,outer.encrypted);outer.encrypted.fill(0);const manifest=validateManifest(strictJSON(plain,256*1024),outer.context);if(manifest.wrapped_key_hash!==wrappedHash)fail();let previous=hashText(sealed),sequence=0;const events=[];const listing=(await io.inventory()).entries.map(e=>e.role===0?'manifest.sealed':e.role===5?`event${String(e.sequence).padStart(6,'0')}.sealed`:`target${String(e.index).padStart(3,'0')}-${['manifest','before','base','after','metadata'][e.role]}.sealed`);if(current()!==true)fail();
  const expected=new Set(['manifest.sealed',...manifest.targets.flatMap((t,i)=>['before','base','after','metadata'].map(role=>`target${String(i).padStart(3,'0')}-${role}.sealed`))]);
  for(let i=0;i<64;i++){const name=`event${String(i).padStart(6,'0')}.sealed`;if(!listing.includes(name))break;const bytes=await io.read(5,0,i);if(current()!==true)fail();const raw=open(key,outer.context,5,0,i,bytes);let event;try{event=eventOpen(raw);}finally{raw.fill(0);}if(event.previous!==previous||event.target>=manifest.targets.length||i>=manifest.maximum_events)fail();validateEvent(event.kind,event.target,event.payload,events,manifest,outer.context);previous=hashText(bytes);bytes.fill(0);events.push({...event,sequence:i,hash:previous});expected.add(name);sequence++;}
  if(listing.length!==expected.size||listing.some(name=>!expected.has(name))||new Set(listing).size!==listing.length)fail();
  const handle=journalHandle({io,key,context:outer.context,manifest,preparedHash:hashText(sealed),sequence,previous,current,events});for(let index=0;index<manifest.targets.length;index++){const target=await handle.readTarget(index);C.wipe(target);}key=null;return handle;
 }finally{key?.fill(0);plain?.fill(0);}
}
module.exports={JOURNAL_LIMITS,PHASES,seal,open,manifestOuter,manifestSeal,validateManifest,prepareJournal,recoverJournal,validateEvent,intentPair,randomUUID,hashText};
