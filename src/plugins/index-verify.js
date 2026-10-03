'use strict';
const crypto=require('node:crypto');
// The legacy catalogue dev signing key's id. Never trusted.
const DEV_KEY_IDS=new Set(['28c56176d52e3aad']);
const keyId=publicKey=>crypto.createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex').slice(0,16);
function keysFromPems(pems){
  const out=[];
  for(const pem of pems){
    const key=crypto.createPublicKey(pem);
    if(key.asymmetricKeyType!=='ed25519')throw new Error(`key is ${key.asymmetricKeyType}, not ed25519`);
    const id=keyId(key);if(!DEV_KEY_IDS.has(id))out.push({keyId:id,key});
  }
  return out;
}
const LIMITS=Object.freeze({indexBytes:8*1024*1024,signatureBytes:1024,entries:1000,files:1000,fileBytes:4*1024*1024,packageBytes:128*1024*1024,depth:32,nodes:4000,timeoutMs:5000,plans:32,concurrency:4,ttlMs:10*60*1000});
const SHA=/^[0-9a-f]{64}$/,NAME=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FLOOR='2026-10-01T00:00:00.000Z';
const closed=(value,required,optional=[])=>value&&typeof value==='object'&&!Array.isArray(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>[...required,...optional].includes(k));
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
const hash=value=>crypto.createHash('sha256').update(Buffer.isBuffer(value)||typeof value==='string'?value:canonical(value)).digest('hex');
const refuse=reason=>({status:'unverified',reason,index:null});
function strictJSON(bytes,max=LIMITS.indexBytes){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>max)throw new Error('bounds');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);let at=0,nodes=0;
  const ws=()=>{while(/[\t\n\r ]/.test(text[at]??'!'))at++;};
  const string=()=>{const start=at++;while(at<text.length){const c=text[at++];if(c==='"')return JSON.parse(text.slice(start,at));if(c==='\\')at++;}throw new Error('string');};
  function value(depth){
    ws();if(depth>LIMITS.depth||++nodes>100000)throw new Error('bounds');const c=text[at];
    if(c==='"'){string();return;}
    if(c==='{'||c==='['){at++;ws();const object=c==='{',end=object?'}':']',keys=new Set();if(text[at]===end){at++;return;}
      while(at<text.length){if(object){if(text[at]!=='"')throw new Error('key');const key=string();if(keys.has(key))throw new Error('duplicate');keys.add(key);ws();if(text[at++]!==':')throw new Error('colon');}value(depth+1);ws();if(text[at]===end){at++;return;}if(text[at++]!==',')throw new Error('comma');ws();}throw new Error('end');
    }
    const token=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));if(!token)throw new Error('value');at+=token[0].length;
  }
  value(0);ws();if(at!==text.length)throw new Error('tail');return JSON.parse(text);
}
function safePath(value){
  if(typeof value!=='string'||!value.length||Buffer.byteLength(value)>1024||value.includes('%')||value.normalize('NFKC')!==value)return false;
  const parts=value.split('/');return parts.length<=LIMITS.depth&&parts.every(p=>/^[A-Za-z0-9._-]+$/.test(p)&&p!=='.'&&p!=='..'&&!p.endsWith('.')&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}
const semver=value=>typeof value==='string'&&value.length<=40&&VERSION.test(value);
function compatible(actual,floor){if(!semver(actual)||!semver(floor))return false;const a=actual.split('.').map(BigInt),b=floor.split('.').map(BigInt);for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return true;}
const packageHash=files=>hash([...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(({path,bytes,sha256})=>({path,bytes,sha256})));
function descriptorValid(d){
  if(!closed(d,['id','catalog_id','name','version','host_min','source','files','package_sha256','components','capabilities'])||![d.id,d.name].every(v=>typeof v==='string'&&v.length<=80&&NAME.test(v))||typeof d.catalog_id!=='string'||!d.catalog_id.length||d.catalog_id.length>160||/[\p{C}]/u.test(d.catalog_id)||!semver(d.version)||!semver(d.host_min)||!compatible(d.host_min,'0.159.2'))return false;
  // Only bounded bundled directories are supported in this slice. Archives,
  // remote URLs and package managers are refused rather than partially parsed.
  if(!closed(d.source,['type','path','attribution'])||d.source.type!=='bundled-directory'||!safePath(d.source.path)||typeof d.source.attribution!=='string'||d.source.attribution.length<1||d.source.attribution.length>200||/[\p{C}]/u.test(d.source.attribution))return false;
  if(!Array.isArray(d.files)||!d.files.length||d.files.length>LIMITS.files||!SHA.test(d.package_sha256??''))return false;
  const paths=new Set();let bytes=0;
  for(const f of d.files){if(!closed(f,['path','bytes','sha256'])||!safePath(f.path)||paths.has(f.path.toLowerCase())||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>LIMITS.fileBytes||!SHA.test(f.sha256??''))return false;paths.add(f.path.toLowerCase());bytes+=f.bytes;}
  if(bytes>LIMITS.packageBytes||packageHash(d.files)!==d.package_sha256||!closed(d.components,['manifest','skills','mcp'])||!['plugin.json','.codex-plugin/plugin.json'].includes(d.components.manifest)||!paths.has(d.components.manifest)||!Array.isArray(d.components.skills)||!Array.isArray(d.components.mcp)||d.components.skills.length+d.components.mcp.length<1)return false;
  if(d.components.skills.some(p=>!safePath(p)||!/^skills\/[a-z][a-z0-9-]*\/SKILL\.md$/.test(p)||!paths.has(p.toLowerCase()))||new Set(d.components.skills).size!==d.components.skills.length||d.components.mcp.some(p=>p!=='mcp.json'||!paths.has(p))||d.components.mcp.length>1)return false;
  const capabilities=[...(d.components.skills.length?['instructions']:[]),...(d.components.mcp.length?['network','oauth','remote-mcp']:[])].sort();
  return canonical(d.capabilities)===canonical(capabilities);
}
function createIndexVerifier({keys=[],now=Date.now,floor=FLOOR}={}){
  // Injection is private module construction for tests/release wiring. No
  // renderer, descriptor, remote URL or unsigned catalog supplies these keys.
  const trusted=keys.filter(k=>k?.key?.asymmetricKeyType==='ed25519'&&keyId(k.key)===k.keyId&&!DEV_KEY_IDS.has(k.keyId));
  return function verify(bytes,signature){
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>LIMITS.indexBytes)return refuse('index-bounds');
    if(!trusted.length)return refuse('no-production-key');
    let s;try{s=strictJSON(Buffer.isBuffer(signature)?signature:Buffer.from(typeof signature==='string'?signature:''),LIMITS.signatureBytes);}catch{return refuse('signature');}
    if(!closed(s,['alg','keyId','sig'])||s.alg!=='ed25519'||DEV_KEY_IDS.has(s.keyId)||typeof s.sig!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(s.sig))return refuse('signature');
    if(Buffer.from(s.sig,'base64').toString('base64')!==s.sig)return refuse('signature');
    const key=trusted.find(k=>k.keyId===s.keyId);if(!key)return refuse('unknown-key');
    try{if(!crypto.verify(null,bytes,key.key,Buffer.from(s.sig,'base64')))return refuse('signature');}catch{return refuse('signature');}
    let index;try{index=strictJSON(bytes);}catch{return refuse('index-json');}
    if(!closed(index,['schemaVersion','generatedAt','catalog_sha256','entries'])||index.schemaVersion!==1||!SHA.test(index.catalog_sha256??'')||!Array.isArray(index.entries)||index.entries.length>LIMITS.entries)return refuse('index-schema');
    const at=Date.parse(index.generatedAt),min=Date.parse(floor),current=now();
    if(typeof index.generatedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(index.generatedAt)||!Number.isFinite(at)||new Date(at).toISOString()!==index.generatedAt||!Number.isFinite(min)||!Number.isFinite(current)||at<min||at>current+86400000)return refuse('index-time');
    const ids=new Set(),names=new Set();for(const d of index.entries){if(!descriptorValid(d)||ids.has(d.id)||names.has(d.name))return refuse('descriptor');ids.add(d.id);names.add(d.name);}
    return {status:'verified',reason:null,index,index_hash:hash(bytes)};
  };
}
module.exports={LIMITS,FLOOR,SHA,closed,canonical,hash,keyId,keysFromPems,strictJSON,safePath,compatible,packageHash,descriptorValid,createIndexVerifier};
