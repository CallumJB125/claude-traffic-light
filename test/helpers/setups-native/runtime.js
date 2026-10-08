'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID,randomBytes,createCipheriv,createDecipheriv}=require('node:crypto');
const {createNativeSupervisor}=require('../../../src/borrow/native-supervisor');
const {createTransactionController}=require('../../../src/borrow/transaction-controller');
const {validatePayload}=require('../../../src/borrow/payload');
function stamp(p){const s=fs.statSync(p,{bigint:true});return {device:s.dev,inode:s.ino,size:s.size,uid:s.uid,mode:s.mode,links:s.nlink,mtime_seconds:s.mtimeNs/1000000000n,mtime_nanoseconds:s.mtimeNs%1000000000n,ctime_seconds:s.ctimeNs/1000000000n,ctime_nanoseconds:s.ctimeNs%1000000000n};}
function fixture(t,helper,options={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pf-binding-runtime-'))),profile=root+'/profile',app=root+'/app';fs.mkdirSync(profile,{mode:0o700});fs.mkdirSync(app,{mode:0o700});fs.mkdirSync(profile+'/.codex',{mode:0o700});fs.writeFileSync(profile+'/.codex/AGENTS.md',options.before??'Keep synthetic notes.\n',{mode:0o600});
 const file={id:randomUUID(),source_id:'codex',relative_path:'.codex/AGENTS.md',format:'text',content:options.after??'Write synthetic notes.\n',note:''},extra=options.extraFile?{id:randomUUID(),source_id:'gemini-cli',relative_path:'.gemini/settings.json',format:'json',content:'{"theme":"synthetic"}',note:''}:null,payload=validatePayload({schema:1,files:extra?[file,extra]:[file],items:[],note:''}),actor={account:'fixture-account',team:'fixture-team',member:'fixture-member',device:'fixture-device'};
 if(extra){fs.mkdirSync(profile+'/.gemini',{mode:0o700});fs.writeFileSync(profile+'/.gemini/settings.json','{"theme":"before"}',{mode:0o600});}
 const state={foreground:true,generation:1,actor,sourceCurrent:true,confirmHook:null,readHook:null,wrapHook:null,storeHook:null,unwraps:0,children:[]};
 const observe=()=>({profilePath:profile,platform:'darwin',osUser:String(process.getuid()),generation:state.generation,foreground:state.foreground,actor:state.actor});
 const roots=()=>({profile:{path:profile,stamp:stamp(profile)},app:{path:app,stamp:stamp(app)}});
 const source={profileId:randomUUID(),versionId:randomUUID(),contentHash:payload.content_hash,payload:payload.payload,principal:{...actor},current:()=>state.sourceCurrent};
 const key=randomBytes(32),wrapping={available:()=>true,async wrap(b){if(state.wrapHook)await state.wrapHook();const n=randomBytes(12),c=createCipheriv('aes-256-gcm',key,n);return Buffer.concat([n,c.update(b),c.final(),c.getAuthTag()]);},unwrap(b){state.unwraps++;const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));return Buffer.concat([d.update(b.subarray(12,-16)),d.final()]);}};
 const sup=createNativeSupervisor({launch:o=>{const child=spawn(helper,o.args,o);state.children.push(child);return child;},current:()=>state.foreground});
 const baseStore=require('../../../src/borrow/native-store').createNativeStore;const storeFactory=options=>{const io=baseStore(options);return Object.fromEntries(Object.entries(io).map(([method,fn])=>[method,async(...args)=>{if(state.storeHook)await state.storeHook(method,args);return fn(...args);}]))};const controllers=[];const make=()=>{const c=createTransactionController({observe,roots,supervisor:sup,wrapping,storeFactory,readSource:async()=>{if(state.readHook)await state.readHook();return source;},confirm:async d=>state.confirmHook?state.confirmHook(d):d.kind==='apply'?{approved:true,plan_hash:d.plan_hash}:d.kind==='undo'?{approved:true,transaction_id:d.transaction_id,inspection_hash:d.inspection_hash}:{approved:true,transaction_id:d.transaction_id}});controllers.push(c);return c;};
 t.after(()=>{controllers.forEach(c=>c.close());key.fill(0);});
 const request=()=>({files:[{id:file.id,mode:'replace',replace_keys:[],instructions:true,code:true},...(extra?[{id:extra.id,mode:'replace',replace_keys:[],instructions:false,code:true}]:[])],values:{}}),sourceHandle=randomUUID(),core=make();
 return {root,profile,app,file,extra,state,source,wrapping,sup,roots,observe,core,make,request,sourceHandle,filename:profile+'/.codex/AGENTS.md'};
}
module.exports={stamp,fixture};
async function snapshot(f,recipe=1){const C=require('../../../src/borrow/native-codec');const {performance}=require('node:perf_hooks');const s=await f.sup.open({...f.roots(),mode:1,generation:2n,authority_hash:C.hash(Buffer.from('synthetic-only'))},performance.now()+8000);try{const out=await s.request(0x30,new C.Writer().u32(recipe).finish());if(out.result!==0)throw Error('Synthetic snapshot failed');const r=new C.Reader(out.body),raw=Buffer.from(r.blob(C.LIMITS.snapshot));r.done();return raw;}finally{await s.close();}}
module.exports.snapshot=snapshot;
