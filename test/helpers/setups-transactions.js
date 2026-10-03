'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto');
const {validatePayload}=require('../../src/borrow/payload');
const {createTransactionStore}=require('../../src/borrow/transaction-store');
const {createTransactionCore}=require('../../src/borrow/transaction-core');
const {hash}=require('../../src/plugins/index-verify');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(t,options={}) {
  // This masking fixture needs a known non-secret HOME. macOS TMPDIR ancestry
  // and mixed-case mkdtemp suffixes can legitimately trip the entropy guard.
  // Keep that guard unchanged; exclusively create a private lowercase UUID
  // directory under the canonical POSIX temporary root for this one fixture.
  const temp=options.lowEntropyPath
    ?path.join(fs.realpathSync(process.platform==='win32'?os.tmpdir():'/tmp'),'pf-'+crypto.randomUUID())
    :fs.mkdtempSync(path.join(os.tmpdir(),'plexiform-setups-transaction-'));
  if(options.lowEntropyPath)fs.mkdirSync(temp,{mode:0o700});t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const home=path.join(temp,'profile'),appData=path.join(temp,'app-data');fs.mkdirSync(home,{mode:0o700});fs.mkdirSync(appData,{mode:0o700});
  const root=path.join(appData,'setups-transactions');
  const file={id:crypto.randomUUID(),source_id:options.source??'codex',relative_path:options.relative??'.codex/AGENTS.md',format:options.format??'text',content:options.content??'Write useful notes.\n',note:''};
  const filename=path.join(home,...file.relative_path.split('/'));
  if(options.before!==null){fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});fs.writeFileSync(filename,options.before??'Keep existing notes.\n',{mode:0o600});}
  const actor={account:'account-a',team:'team-a',member:'member-a',device:'device-a'},originalActor={...actor};
  const state={profilePath:home,platform:process.platform,osUser:String(process.getuid?.()??'windows-fixture'),generation:1,foreground:true,actor,sourceCurrent:true,time:1000,calls:0,dialogs:[],readHook:null,confirmHook:null};
  let checked=validatePayload({schema:1,files:[file],items:[],note:''});
  const source={profileId:crypto.randomUUID(),versionId:crypto.randomUUID(),contentHash:checked.content_hash,payload:checked.payload,principal:originalActor,current:()=>state.sourceCurrent&&JSON.stringify(state.actor)===JSON.stringify(originalActor)};
  const wrappingKey=crypto.randomBytes(32);t.after(()=>wrappingKey.fill(0));
  const wrapping={available:()=>true,wrap(plain){const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',wrappingKey,nonce);return Buffer.concat([nonce,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);},unwrap(bytes){const cipher=crypto.createDecipheriv('aes-256-gcm',wrappingKey,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]);}};
  const observe=()=>({profilePath:state.profilePath,platform:state.platform,osUser:state.osUser,generation:state.generation,foreground:state.foreground,actor:state.actor});
  const readSource=async()=>{state.calls++;if(state.readHook)return state.readHook(source,state.calls);return source;};
  const confirm=async request=>{state.dialogs.push(request);if(state.confirmHook)return state.confirmHook(request);return request.kind==='prepare'?{approved:true,plan_hash:request.plan_hash}:{approved:true,transaction_id:request.transaction_id};};
  const makeStore=(overrides={})=>createTransactionStore({root,wrapping,now:()=>state.time,...overrides});
  const store=makeStore(options.store??{}),makeCore=(overrides={})=>createTransactionCore({observe,readSource,store,confirm,now:()=>state.time,...overrides}),core=makeCore(options.core??{});
  const choice={id:file.id,mode:options.mode??'replace',replace_keys:options.replaceKeys??[],instructions:file.source_id==='codex'&&file.format==='text',code:['codex','claude-code','gemini-cli'].includes(file.source_id)};
  const request=()=>({files:[{...choice,replace_keys:[...choice.replace_keys]}],values:{...(options.values??{})}});
  const sourceHandle=crypto.randomUUID();
  const plan=()=>core.plan(sourceHandle,request());
  const prepare=async()=>{const result=await plan();if(!result.ok)return result;return core.prepare(result.handle,result.plan_hash);};
  const disk=()=>fs.existsSync(root)?fs.readdirSync(root).flatMap(dir=>fs.readdirSync(path.join(root,dir)).map(name=>({name:dir+'/'+name,bytes:fs.readFileSync(path.join(root,dir,name))}))):[];
  return {temp,home,appData,root,file,filename,source,state,observe,readSource,confirm,wrapping,store,core,makeStore,makeCore,request,sourceHandle,plan,prepare,disk,hash,checked};
}
module.exports={fixture,deferred};
