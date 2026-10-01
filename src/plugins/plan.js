'use strict';
const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {LIMITS,closed,canonical,hash,SHA,keysFromPems,createIndexVerifier,compatible}=require('./index-verify');
const {verifySource,readBounded}=require('./source-verify');
const BUILD=path.resolve(__dirname,'../../build');
const REQUIRED_COMMANDS=['marketplace-add','marketplace-list','marketplace-remove','plugin-add','plugin-list','plugin-remove'];
const unavailable=reason=>({ok:false,status:'unavailable',reason,plan:null});
const ID=/^[A-Za-z0-9_.:-]{1,160}$/;
function productionKeys(){
  const pems=[];for(const name of ['codex-plugin-key.pub.pem','codex-plugin-key-next.pub.pem']){
    try{pems.push(readBounded(path.join(BUILD,name),64*1024).bytes.toString('utf8'));}catch{}
  }
  try{return keysFromPems(pems);}catch{return [];}
}
function normalize(snapshot,fsApi){
  if(!closed(snapshot,['profile_root','config','cache','host','account','current'])||typeof snapshot.current!=='function'||snapshot.current()!==true||typeof snapshot.profile_root!=='string'||!path.isAbsolute(snapshot.profile_root))throw new Error('snapshot');
  const profile=fsApi.realpathSync(snapshot.profile_root);if(!fsApi.lstatSync(profile).isDirectory())throw new Error('profile');
  for(const identity of [snapshot.config,snapshot.cache])if(!closed(identity,['sha256','stat'])||!SHA.test(identity.sha256??'')||typeof identity.stat!=='string'||!identity.stat.length||identity.stat.length>200||/[\p{C}]/u.test(identity.stat))throw new Error('identity');
  const host=snapshot.host;
  if(!closed(host,['kind','version','binary_path','binary_sha256','binary_stat','commands'])||host.kind!=='codex'||!compatible(host.version,'0.0.0')||typeof host.binary_path!=='string'||!path.isAbsolute(host.binary_path)||!SHA.test(host.binary_sha256??'')||typeof host.binary_stat!=='string'||!host.binary_stat.length||host.binary_stat.length>200||!Array.isArray(host.commands)||canonical([...host.commands].sort())!==canonical(REQUIRED_COMMANDS))throw new Error('host');
  const binary=fsApi.realpathSync(host.binary_path);if(!fsApi.lstatSync(binary).isFile())throw new Error('host');
  const account=snapshot.account;
  if(account!==null&&(!closed(account,['user_id','team_id','member_id','device_id','generation'])||![account.user_id,account.team_id,account.member_id,account.device_id].every(id=>typeof id==='string'&&ID.test(id))||!Number.isSafeInteger(account.generation)||account.generation<0))throw new Error('account');
  const binding={profile_root:profile,config:{...snapshot.config},cache:{...snapshot.cache},host:{...host,binary_path:binary,commands:[...host.commands].sort()},account:account?{...account}:null};
  return {binding,fingerprint:hash(binding),current:snapshot.current};
}
function createPluginPlanner({snapshot,bundleRoot=path.join(BUILD,'codex-plugins/packages'),loadIndex=null,loadCatalog=null,verifyIndex=createIndexVerifier({keys:productionKeys()}),fsApi=fs,now=Date.now}={}){
  if(typeof snapshot!=='function'||typeof verifyIndex!=='function'||typeof bundleRoot!=='string'||!path.isAbsolute(bundleRoot))throw new Error('Private main dependencies are required');
  const load=loadIndex??(()=>({bytes:readBounded(path.join(BUILD,'codex-plugins/install-index.json'),LIMITS.indexBytes,fsApi).bytes,signature:readBounded(path.join(BUILD,'codex-plugins/install-index.json.sig'),LIMITS.signatureBytes,fsApi).bytes}));
  const catalog=loadCatalog??(()=>readBounded(path.join(BUILD,'plugin-catalog/catalog.json'),LIMITS.indexBytes,fsApi).bytes);
  let generation=0,pending=0;const plans=new Map();
  const live=(capture,token)=>{try{return token===generation&&capture.current()===true;}catch{return false;}};
  async function capture(){return normalize(await snapshot(),fsApi);}
  async function index(){const raw=await load();return verifyIndex(raw.bytes,raw.signature);}
  const publicPlan=entry=>({ok:true,read_only:true,install_available:false,plan:{id:entry.id,descriptor_id:entry.descriptor.id,name:entry.descriptor.name,version:entry.descriptor.version,source:entry.descriptor.source.attribution,scope:'user',package_hash:entry.source.package_hash,index_hash:entry.indexHash,files:entry.descriptor.files.map(f=>({path:f.path,bytes:f.bytes,sha256:f.sha256})),capabilities:[...entry.descriptor.capabilities],expires_at:entry.expires,limitations:['Installation and Undo are not implemented.','Codex cache is user-level.','Provider connections and tool approval are separate.']}});
  const prune=()=>{for(const [id,p]of plans)if(p.expires<=now()||!live(p.capture,p.generation))plans.delete(id);};
  return {
    invalidate(){generation++;plans.clear();},
    async plan(descriptorId,opts={scope:'user'}){
      if(typeof descriptorId!=='string'||!descriptorId.length||descriptorId.length>80||!closed(opts,['scope'])||opts.scope!=='user')return unavailable('unsupported-selection');
      if(pending>=LIMITS.concurrency)return unavailable('busy');pending++;const token=generation;
      try{
        prune();if(plans.size>=LIMITS.plans)return unavailable('plan-limit');
        const before=await capture();if(!live(before,token))return unavailable('changed');
        if(!compatible(before.binding.host.version,'0.159.2'))return {...unavailable('unsupported-host'),minimum_version:'0.159.2'};
        const verified=await index();if(!live(before,token))return unavailable('changed');if(verified.status!=='verified')return unavailable(verified.reason);
        const catalogBytes=await catalog();if(!live(before,token))return unavailable('changed');if(!Buffer.isBuffer(catalogBytes)||catalogBytes.length>LIMITS.indexBytes||hash(catalogBytes)!==verified.index.catalog_sha256)return unavailable('catalog-changed');
        const descriptor=verified.index.entries.find(d=>d.id===descriptorId);if(!descriptor)return unavailable('unsupported-selection');
        if(!compatible(before.binding.host.version,descriptor.host_min))return {...unavailable('unsupported-host'),minimum_version:descriptor.host_min};
        const source=verifySource(descriptor,{bundleRoot,fsApi});
        const after=await capture();if(!live(before,token)||!live(after,token)||before.fingerprint!==after.fingerprint)return unavailable('changed');
        const fresh=verifySource(descriptor,{bundleRoot,fsApi});if(!live(after,token)||canonical(fresh)!==canonical(source))return unavailable('changed');
        if(plans.size>=LIMITS.plans)return unavailable('plan-limit');
        const entry={id:randomUUID(),generation:token,capture:after,indexHash:verified.index_hash,descriptor:JSON.parse(canonical(descriptor)),source:fresh,expires:now()+LIMITS.ttlMs};
        plans.set(entry.id,entry);return publicPlan(entry);
      }catch(error){return unavailable(error?.message==='host'?'unsupported-host':'unavailable');}finally{pending--;}
    },
    async check(planId){
      const entry=typeof planId==='string'?plans.get(planId):null,token=generation;
      if(!entry||entry.expires<=now()||!live(entry.capture,token))return unavailable('expired-or-changed');
      if(pending>=LIMITS.concurrency)return unavailable('busy');pending++;
      try{
        const before=await capture();if(entry.expires<=now()||!live(entry.capture,token)||!live(before,token)||before.fingerprint!==entry.capture.fingerprint)throw new Error('changed');
        const verified=await index();if(entry.expires<=now()||!live(entry.capture,token)||verified.status!=='verified'||verified.index_hash!==entry.indexHash)throw new Error('changed');
        const catalogBytes=await catalog();if(entry.expires<=now()||!live(entry.capture,token)||!Buffer.isBuffer(catalogBytes)||catalogBytes.length>LIMITS.indexBytes||hash(catalogBytes)!==verified.index.catalog_sha256)throw new Error('changed');
        const descriptor=verified.index.entries.find(d=>d.id===entry.descriptor.id);if(!descriptor||hash(descriptor)!==entry.source.descriptor_hash)throw new Error('changed');
        const source=verifySource(descriptor,{bundleRoot,fsApi});
        const after=await capture();if(entry.expires<=now()||!live(entry.capture,token)||!live(after,token)||before.fingerprint!==after.fingerprint||canonical(source)!==canonical(entry.source)||canonical(verifySource(descriptor,{bundleRoot,fsApi}))!==canonical(source))throw new Error('changed');
        if(entry.expires<=now()||!live(after,token))throw new Error('changed');return publicPlan(entry);
      }catch{plans.delete(planId);return unavailable('expired-or-changed');}finally{pending--;}
    },
  };
}
module.exports={createPluginPlanner,productionKeys,REQUIRED_COMMANDS};
