'use strict';
// Main-only fixed Darwin resources and OS roots. Never expose this factory,
// paths, descriptors, verifier or launcher to a renderer or provider source.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {createHash}=require('node:crypto');
const fail=()=>{throw new Error('Setups local platform is unavailable');};
const identity=s=>[s.dev,s.ino,s.uid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
function stamp(s){return {device:s.dev,inode:s.ino,size:s.size,uid:s.uid,mode:s.mode,links:s.nlink,mtime_seconds:s.mtimeNs/1000000000n,mtime_nanoseconds:s.mtimeNs%1000000000n,ctime_seconds:s.ctimeNs/1000000000n,ctime_nanoseconds:s.ctimeNs%1000000000n};}
function createSetupsPlatform({app,resourcesPath,profilePath,uid=process.getuid?.(),platform=process.platform,fsApi=fs,spawn=cp.spawn,verify=(p)=>cp.execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',p],{timeout:2500,maxBuffer:64*1024,stdio:['ignore','ignore','pipe']})}){
 if(platform!=='darwin'||!app?.isPackaged||!Number.isSafeInteger(uid)||uid<0||typeof resourcesPath!=='string'||typeof profilePath!=='string'||!path.isAbsolute(resourcesPath)||!path.isAbsolute(profilePath))fail();
 const resources=path.resolve(resourcesPath),contents=path.dirname(resources),bundle=path.dirname(contents),profile=path.resolve(profilePath),userData=path.resolve(app.getPath('userData'));
 if(path.basename(resources)!=='Resources'||path.basename(contents)!=='Contents'||path.extname(bundle)!=='.app'||app.getAppPath()!==path.join(resources,'app.asar')||profile==='/'||userData===profile||!userData.startsWith(profile+path.sep))fail();
 const helper=path.join(resources,'setups','buddy-setups'),manifest=path.join(resources,'setups','helper-manifest.json'),parent=path.join(userData,'setups-runtime-v2');
 const anchors=[[path.join(contents,'_CodeSignature','CodeResources'),16*1024*1024],[path.join(resources,'app.asar'),64*1024*1024],[helper,4*1024*1024],[manifest,128*1024]];
 let trusted=null;
 function canonical(p){if(fsApi.realpathSync(p)!==p)fail();}
 function directory(p,create=false){
  if(create){try{fsApi.mkdirSync(p,{mode:0o700});}catch(error){if(error.code!=='EEXIST')fail();}}
  canonical(p);let fd;
  try{fd=fsApi.openSync(p,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const held=fsApi.fstatSync(fd,{bigint:true}),named=fsApi.lstatSync(p,{bigint:true});
   if(!held.isDirectory()||held.uid!==BigInt(uid)||(held.mode&0o022n)!==0n||held.dev!==named.dev||held.ino!==named.ino||!named.isDirectory())fail();return {path:p,stamp:stamp(held)};
  }finally{if(fd!==undefined)fsApi.closeSync(fd);}
 }
 function anchor(p,limit){
  canonical(p);let fd,bytes;
  try{fd=fsApi.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const before=fsApi.fstatSync(fd,{bigint:true});
   if(!before.isFile()||before.nlink!==1n||(before.uid!==BigInt(uid)&&before.uid!==0n)||(before.mode&0o022n)!==0n||before.size<1n||before.size>BigInt(limit)||(p===helper&&(before.mode&0o111n)===0n))fail();
   bytes=Buffer.alloc(Number(before.size));let at=0;while(at<bytes.length){const n=fsApi.readSync(fd,bytes,at,bytes.length-at,at);if(n<1)fail();at+=n;}
   const tail=Buffer.alloc(1);if(fsApi.readSync(fd,tail,0,1,at)!==0)fail();const after=fsApi.fstatSync(fd,{bigint:true}),named=fsApi.lstatSync(p,{bigint:true});
   if(identity(before)!==identity(after)||identity(after)!==identity(named))fail();return {identity:identity(after),hash:createHash('sha256').update(bytes).digest('hex')};
  }finally{bytes?.fill(0);if(fd!==undefined)fsApi.closeSync(fd);}
 }
 function integrity(){
  canonical(bundle);canonical(resources);
  const before=anchors.map(([p,n])=>anchor(p,n));
  if(!trusted){verify(bundle);verify(helper);const after=anchors.map(([p,n])=>anchor(p,n));if(JSON.stringify(before)!==JSON.stringify(after))fail();trusted=after;}
  if(JSON.stringify(before)!==JSON.stringify(trusted))fail();
 }
 return Object.freeze({
  profilePath:profile,
  roots(){const checkedProfile=directory(profile);directory(userData);const checkedParent=directory(parent,true);return {profile:checkedProfile,app:checkedParent};},
  launch(options){
   // Supervisor's closed fixed descriptor contract. No caller-supplied binary,
   // environment, command, cwd or extra inherited descriptor is accepted.
   if(!options||Object.keys(options).sort().join('|')!=='args|env|shell|stdio'||!Array.isArray(options.args)||options.args.length||!options.env||Object.keys(options.env).length||options.shell!==false||!Array.isArray(options.stdio)||options.stdio.join('|')!=='pipe|pipe|pipe|pipe')fail();
   integrity();return spawn(helper,[],{env:{},shell:false,stdio:['pipe','pipe','pipe','pipe'],cwd:'/'});
  },
 });
}
module.exports={createSetupsPlatform};
