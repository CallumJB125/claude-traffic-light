'use strict';
const fs=require('node:fs'), path=require('node:path');
const {randomBytes,randomUUID,createCipheriv,createDecipheriv}=require('node:crypto');
const {closed,canonical,hash,strictJSON,SHA}=require('../plugins/index-verify');
const {UUID}=require('./payload');
const {identity,readRegular,recipeById,FILE_BYTES}=require('./transaction-targets');

const STORE_LIMITS=Object.freeze({targets:128, transactionBytes:64*1024*1024, storeBytes:128*1024*1024, incomplete:16, manifestBytes:256*1024, wrappedBytes:64*1024});
const refuse=()=>{throw new Error('Setups encrypted recovery storage is unavailable');};
const bytesOf=value=>Buffer.from(canonical(value));
const base64=(value,max)=>{if(typeof value!=='string'||value.length>Math.ceil(max/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))refuse();const bytes=Buffer.from(value,'base64');if(bytes.length>max||bytes.toString('base64')!==value)refuse();return bytes;};
function seal(key,bytes,aad) {
  const nonce=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(bytesOf(aad));
  return {nonce:nonce.toString('base64'),data:Buffer.concat([cipher.update(bytes),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
function open(key,envelope,aad,max) {
  if(!closed(envelope,['nonce','data','tag']))refuse();
  const nonce=base64(envelope.nonce,12),tag=base64(envelope.tag,16),data=base64(envelope.data,max);
  if(nonce.length!==12||tag.length!==16)refuse();
  const cipher=createDecipheriv('aes-256-gcm',key,nonce);cipher.setAAD(bytesOf(aad));cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data),cipher.final()]);
}
function manifestValid(value,id,profileId) {
  if(!closed(value,['schema','id','profile','owner','source','plan_hash','created_at','phase','targets'])||value.schema!==1||value.id!==id||value.profile!==profileId||!SHA.test(value.owner??'')||!SHA.test(value.plan_hash??'')||!closed(value.source,['profile','version','hash'])||![value.source.profile,value.source.version].every(v=>UUID.test(v??''))||!SHA.test(value.source.hash??'')||!Number.isSafeInteger(value.created_at)||value.created_at<0||value.phase!=='prepared'||!Array.isArray(value.targets)||!value.targets.length||value.targets.length>STORE_LIMITS.targets)refuse();
  const recipes=new Set(),files=new Set();let total=0;
  value.targets.forEach((target,index)=>{
    if(!closed(target,['recipe','file','mode','before','base','after'])||!recipeById(target.recipe)?.adapter||recipes.has(target.recipe)||files.has(target.file)||!UUID.test(target.file??'')||!['merge','replace'].includes(target.mode))refuse();recipes.add(target.recipe);files.add(target.file);
    for(const role of ['before','base','after']) {
      const blob=target[role];
      if(!closed(blob,['name','hash','bytes','exists','identity','mode'])||blob.name!==`${index}-${role}.sealed`||!SHA.test(blob.hash??'')||!Number.isSafeInteger(blob.bytes)||blob.bytes<0||blob.bytes>FILE_BYTES||typeof blob.exists!=='boolean'||(role!=='before'&&!blob.exists)||(!blob.exists&&(blob.bytes!==0||blob.identity!==null||blob.mode!==null))||(blob.identity!==null&&(typeof blob.identity!=='string'||blob.identity.length>300||!/^[0-9:-]+$/.test(blob.identity)))||(blob.mode!==null&&(!Number.isInteger(blob.mode)||blob.mode<0||blob.mode>0o777)))refuse();
      total+=blob.bytes;
    }
    if((target.before.exists&&target.before.identity===null)||target.base.identity!==null||target.base.mode!==null||target.after.identity!==null||target.after.mode===null)refuse();
  });
  if(total>STORE_LIMITS.transactionBytes)refuse();return value;
}

// App-owned recovery storage only. There is deliberately no user-target write,
// lifecycle-advance, execute or Undo method. Prepared means encrypted snapshots
// were durably recorded, never that a tool's files were changed.
function createTransactionStore({root,wrapping,fsApi=fs,now=Date.now}) {
  if(typeof root!=='string'||!path.isAbsolute(root)||!wrapping||typeof wrapping.available!=='function'||typeof wrapping.wrap!=='function'||typeof wrapping.unwrap!=='function')refuse();
  const lexical=path.resolve(root),parent=fsApi.realpathSync(path.dirname(lexical));
  if(path.basename(lexical)!=='setups-transactions')refuse();
  const rootPath=path.join(parent,'setups-transactions');let rootIdentity=null;
  const available=()=>{try{return wrapping.available()===true;}catch{return false;}};
  function privateDirectory(directory) {
    const stat=fsApi.lstatSync(directory,{bigint:true});
    // A Windows DACL adapter must be reviewed separately; POSIX chmod is not a
    // Windows privacy boundary. No loose permission or basic_text fallback.
    if(process.platform==='win32'||!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077n)!==0n||stat.uid!==BigInt(process.getuid()))refuse();
    return identity(stat);
  }
  const rootStable=()=>{
    if(fsApi.realpathSync(path.dirname(lexical))!==parent||fsApi.realpathSync(rootPath)!==rootPath)refuse();
    const current=privateDirectory(rootPath),stat=fsApi.lstatSync(rootPath,{bigint:true});
    // Directory contents legitimately alter mtime/size. Bind its opened owner,
    // mode and inode; child records are checked separately with complete stats.
    const stable=[stat.dev,stat.ino,stat.mode,stat.uid].map(String).join(':');
    if(rootIdentity!==null&&rootIdentity!==stable)refuse();rootIdentity=stable;return current;
  };
  function initialize() {
    if(!available())refuse();
    if(process.platform==='win32'||typeof process.getuid!=='function'||![fs.constants.O_NOFOLLOW,fs.constants.O_NONBLOCK,fs.constants.O_DIRECTORY].every(flag=>Number.isInteger(flag)&&flag>0))refuse();
    const parentBefore=fsApi.lstatSync(parent,{bigint:true});
    if(!parentBefore.isDirectory()||parentBefore.isSymbolicLink()||(parentBefore.mode&0o022n)!==0n||parentBefore.uid!==BigInt(process.getuid()))refuse();
    try {fsApi.mkdirSync(rootPath,{mode:0o700});syncDirectory(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
    rootStable();
  }
  function syncDirectory(directory) {
    const flags=fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW;
    if(!Number.isInteger(fs.constants.O_NOFOLLOW)||fs.constants.O_NOFOLLOW<=0||!Number.isInteger(fs.constants.O_DIRECTORY)||fs.constants.O_DIRECTORY<=0)refuse();
    const fd=fsApi.openSync(directory,flags);
    try {const stat=fsApi.fstatSync(fd,{bigint:true});if(!stat.isDirectory())refuse();fsApi.fsyncSync(fd);}finally{fsApi.closeSync(fd);}
  }
  function scan() {
    rootStable();const entries=fsApi.readdirSync(rootPath);if(entries.length>STORE_LIMITS.incomplete)refuse();let bytes=0;
    const rows=entries.map(name=>{
      const id=name.replace(/^\.pending\./,'');if(!UUID.test(id)||(name!==id&&name!=='.pending.'+id))refuse();
      const directory=path.join(rootPath,name);privateDirectory(directory);
      const children=fsApi.readdirSync(directory);if(children.length>STORE_LIMITS.targets*3+1)refuse();let ownBytes=0;
      for(const child of children) {
        if(child!=='manifest.sealed'&&!/^\d{1,3}-(before|base|after)\.sealed$/.test(child))refuse();
        const stat=fsApi.lstatSync(path.join(directory,child),{bigint:true});
        if(!stat.isFile()||stat.nlink!==1n||(stat.mode&0o077n)!==0n||stat.uid!==BigInt(process.getuid())||stat.size<0n||stat.size>BigInt(FILE_BYTES*2+STORE_LIMITS.manifestBytes))refuse();ownBytes+=Number(stat.size);
      }
      if(ownBytes>STORE_LIMITS.transactionBytes)refuse();bytes+=ownBytes;
      return {id,locked:true,status:name===id?'confirmation_required':'incomplete',bytes:ownBytes};
    });
    if(bytes>STORE_LIMITS.storeBytes)refuse();rootStable();return {rows,bytes};
  }
  function writeExclusive(filename,bytes) {
    const fd=fsApi.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try {const stat=fsApi.fstatSync(fd,{bigint:true});if(!stat.isFile()||stat.nlink!==1n||(stat.mode&0o077n)!==0n||stat.uid!==BigInt(process.getuid()))refuse();let at=0;while(at<bytes.length){const count=fsApi.writeSync(fd,bytes,at,bytes.length-at);if(count<=0)refuse();at+=count;}fsApi.fsyncSync(fd);}finally{fsApi.closeSync(fd);}
  }
  function checkDirectory(directory,expected) {
    if(privateDirectory(directory)!==expected||fsApi.realpathSync(directory)!==directory)refuse();rootStable();
  }
  function readOwned(directory,name,max) {
    const before=privateDirectory(directory),file=path.join(directory,name),stat=fsApi.lstatSync(file,{bigint:true});
    if((stat.mode&0o077n)!==0n||stat.uid!==BigInt(process.getuid()))refuse();
    const read=readRegular(file,max,fsApi);checkDirectory(directory,before);return read.bytes;
  }
  return {
    list() { initialize();return scan().rows; },
    prepare({profileId,owner,source,planHash,targets}) {
      initialize();if(!SHA.test(profileId??'')||!SHA.test(owner??'')||!Array.isArray(targets)||!targets.length||targets.length>STORE_LIMITS.targets)refuse();
      const existing=scan();if(existing.rows.length>=STORE_LIMITS.incomplete)refuse();
      const id=randomUUID(), key=randomBytes(32), records=[];let bytes=0;
      try {
        const plainWrap=Buffer.from(key);let wrapped;
        try{wrapped=wrapping.wrap(plainWrap);}finally{plainWrap.fill(0);}
        if(!available()||!Buffer.isBuffer(wrapped)||!wrapped.length||wrapped.length>STORE_LIMITS.wrappedBytes||wrapped.equals(key)||wrapped.equals(Buffer.from(key.toString('base64'))))refuse();
        const manifest={schema:1,id,profile:profileId,owner,source,plan_hash:planHash,created_at:now(),phase:'prepared',targets:targets.map((target,index)=>{
          const out={recipe:target.recipe,file:target.file,mode:target.mode};
          for(const role of ['before','base','after']) {
            const blob=target[role];if(!blob||!Buffer.isBuffer(blob.bytes)||blob.bytes.length>FILE_BYTES)refuse();
            const descriptor={name:`${index}-${role}.sealed`,hash:hash(blob.bytes),bytes:blob.bytes.length,exists:blob.exists,identity:blob.identity??null,mode:blob.mode??null};out[role]=descriptor;
            const aad={schema:1,id,profile:profileId,recipe:target.recipe,role,hash:descriptor.hash,bytes:descriptor.bytes};
            const encrypted=bytesOf({schema:1,envelope:seal(key,blob.bytes,aad)});records.push({name:descriptor.name,bytes:encrypted});bytes+=encrypted.length;
          }
          return out;
        })};
        manifestValid(manifest,id,profileId);
        const header=bytesOf({schema:1,id,wrapped:wrapped.toString('base64'),envelope:seal(key,bytesOf(manifest),{schema:1,id,profile:profileId,role:'manifest'})});
        if(header.length>STORE_LIMITS.manifestBytes*2||bytes+header.length>STORE_LIMITS.transactionBytes||existing.bytes+bytes+header.length>STORE_LIMITS.storeBytes)refuse();
        const pending=path.join(rootPath,'.pending.'+id);fsApi.mkdirSync(pending,{mode:0o700});privateDirectory(pending);
        // Snapshot durability precedes the manifest's prepared declaration.
        for(const record of records){rootStable();writeExclusive(path.join(pending,record.name),record.bytes);}
        syncDirectory(pending);writeExclusive(path.join(pending,'manifest.sealed'),header);syncDirectory(pending);rootStable();
        // App-owned random transaction namespaces only. This is deliberately
        // distinct from the still-held user-target mutation primitive.
        if(fsApi.existsSync(path.join(rootPath,id)))refuse();fsApi.renameSync(pending,path.join(rootPath,id));syncDirectory(rootPath);rootStable();
        return {id,phase:'prepared',targets:manifest.targets.length};
      } finally { key.fill(0); }
    },
    read(id,profileId) {
      initialize();if(!UUID.test(id??'')||!SHA.test(profileId??''))refuse();scan();
      const directory=path.join(rootPath,id),directoryBefore=privateDirectory(directory);
      const header=strictJSON(readOwned(directory,'manifest.sealed',STORE_LIMITS.manifestBytes*2),STORE_LIMITS.manifestBytes*2);
      if(!closed(header,['schema','id','wrapped','envelope'])||header.schema!==1||header.id!==id)refuse();
      const wrapped=base64(header.wrapped,STORE_LIMITS.wrappedBytes);if(!wrapped.length||!available())refuse();
      const key=wrapping.unwrap(wrapped);if(!Buffer.isBuffer(key)||key.length!==32||!available()){if(Buffer.isBuffer(key))key.fill(0);refuse();}
      const buffers=[];
      try {
        const plain=open(key,header.envelope,{schema:1,id,profile:profileId,role:'manifest'},STORE_LIMITS.manifestBytes);buffers.push(plain);
        const manifest=manifestValid(strictJSON(plain,STORE_LIMITS.manifestBytes),id,profileId);
        const names=['manifest.sealed',...manifest.targets.flatMap(target=>['before','base','after'].map(role=>target[role].name))].sort();
        if(canonical(fsApi.readdirSync(directory).sort())!==canonical(names))refuse();
        const targets=manifest.targets.map(target=>{
          const out={recipe:target.recipe,file:target.file,mode:target.mode};
          for(const role of ['before','base','after']) {
            const descriptor=target[role],sealed=strictJSON(readOwned(directory,descriptor.name,FILE_BYTES*2),FILE_BYTES*2);
            if(!closed(sealed,['schema','envelope'])||sealed.schema!==1)refuse();
            const bytes=open(key,sealed.envelope,{schema:1,id,profile:profileId,recipe:target.recipe,role,hash:descriptor.hash,bytes:descriptor.bytes},FILE_BYTES);buffers.push(bytes);
            if(bytes.length!==descriptor.bytes||hash(bytes)!==descriptor.hash)refuse();out[role]={...descriptor,bytes};
          }
          return out;
        });
        checkDirectory(directory,directoryBefore);
        return {manifest,targets,close(){for(const buffer of buffers)buffer.fill(0);}};
      } catch(error) { for(const buffer of buffers)buffer.fill(0);throw error; }
      finally {key.fill(0);}
    },
  };
}
function safeStorageWrapping(safeStorage,platform=process.platform) {
  const available=()=>{
    try {
      return safeStorage?.isEncryptionAvailable()===true && typeof safeStorage.encryptString==='function' && typeof safeStorage.decryptString==='function' &&
        (platform!=='linux'||['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(safeStorage.getSelectedStorageBackend?.()));
    }catch{return false;}
  };
  return {
    available,
    wrap(key){if(!available()||!Buffer.isBuffer(key)||key.length!==32)refuse();const wrapped=safeStorage.encryptString(key.toString('base64'));if(!available())refuse();return wrapped;},
    unwrap(wrapped){if(!available())refuse();const result=safeStorage.decryptString(wrapped),key=base64(result,32);if(key.length!==32||!available()){key.fill(0);refuse();}return key;},
  };
}
module.exports={STORE_LIMITS,createTransactionStore,safeStorageWrapping};
