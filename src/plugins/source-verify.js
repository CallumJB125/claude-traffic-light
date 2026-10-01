'use strict';
const fs=require('node:fs'),path=require('node:path');
const {findSecrets}=require('../../board/shared/secret-patterns.mjs');
const {LIMITS,closed,canonical,hash,strictJSON,safePath,descriptorValid}=require('./index-verify');
const fail=()=>{throw new Error('Plugin source is unavailable or differs from its verified descriptor');};
const identity=s=>[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
function readBounded(file,max,fsApi=fs){
  const before=fsApi.lstatSync(file,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size<1n||before.size>BigInt(max))fail();
  const fd=fsApi.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{
    const opened=fsApi.fstatSync(fd,{bigint:true});if(identity(opened)!==identity(before)||!opened.isFile()||opened.nlink!==1n)fail();
    const bytes=Buffer.alloc(Number(opened.size)+1);let count=0,n;
    do{n=fsApi.readSync(fd,bytes,count,bytes.length-count,null);count+=n;}while(n&&count<bytes.length);
    if(count!==Number(opened.size)||identity(fsApi.fstatSync(fd,{bigint:true}))!==identity(before)||identity(fsApi.lstatSync(file,{bigint:true}))!==identity(before))fail();
    return {bytes:bytes.subarray(0,count),identity:identity(before)};
  }finally{fsApi.closeSync(fd);}
}
function remoteURL(value){
  if(typeof value!=='string'||value.length>2048)return false;let url;try{url=new URL(value);}catch{return false;}
  const labels=url.hostname.split('.');
  // URL normalizes numeric IPv4 aliases before this check. IPv6, empty labels,
  // trailing dots and non-DNS spellings fail the label grammar. No DNS lookup.
  return url.href===value&&url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&url.hostname.length<=253&&!/^\d+(?:\.\d+)*$/.test(url.hostname)&&labels.length>1&&labels.every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))&&!/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname);
}
function verifySource(descriptor,{bundleRoot,fsApi=fs,clock=()=>performance.now()}={}){
  if(!descriptorValid(descriptor)||typeof bundleRoot!=='string'||!path.isAbsolute(bundleRoot))fail();
  const started=clock();let nodes=0,total=0;
  const budget=()=>{if(++nodes>LIMITS.nodes||clock()-started>LIMITS.timeoutMs)fail();};
  const canonicalRoot=fsApi.realpathSync(bundleRoot);let root=canonicalRoot;const parents=[];
  const rememberParent=target=>{const s=fsApi.lstatSync(target,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())fail();parents.push({path:target,identity:identity(s)});};
  rememberParent(root);
  for(const part of descriptor.source.path.split('/')){root=path.join(root,part);rememberParent(root);}
  if(fsApi.realpathSync(root)!==root)fail();
  const expected=new Map(descriptor.files.map(f=>[f.path,f])),contents=new Map(),files=[],dirs=[],folded=new Set(),allowedDirs=new Set();
  for(const name of expected.keys()){const parts=name.split('/');for(let i=1;i<parts.length;i++)allowedDirs.add(parts.slice(0,i).join('/'));}
  function walk(dir,relative='',depth=0){
    budget();if(depth>LIMITS.depth)fail();const before=fsApi.lstatSync(dir,{bigint:true});if(!before.isDirectory()||before.isSymbolicLink())fail();
    const iterator=fsApi.opendirSync(dir);try{let item;while((item=iterator.readSync())){
      budget();const name=relative?relative+'/'+item.name:item.name;if(!safePath(name)||folded.has(name.toLowerCase()))fail();folded.add(name.toLowerCase());
      const target=path.join(dir,item.name),s=fsApi.lstatSync(target,{bigint:true});
      if(s.isDirectory()){if(!allowedDirs.has(name))fail();walk(target,name,depth+1);continue;}
      if(!s.isFile()||s.nlink!==1n||!expected.has(name)||files.length>=LIMITS.files)fail();
      const wanted=expected.get(name);if(s.size!==BigInt(wanted.bytes)||total+wanted.bytes>LIMITS.packageBytes)fail();total+=wanted.bytes;
      const read=readBounded(target,LIMITS.fileBytes,fsApi);if(hash(read.bytes)!==wanted.sha256)fail();
      const text=new TextDecoder('utf-8',{fatal:true}).decode(read.bytes);
      if(findSecrets(text,{docExamples:false}).length)fail();
      if(name!==descriptor.components.manifest&&name!=='mcp.json'&&!name.endsWith('.md'))fail();
      contents.set(name,read.bytes);files.push({path:name,identity:read.identity,sha256:wanted.sha256,bytes:wanted.bytes});
    }}finally{iterator.closeSync();}
    if(identity(fsApi.lstatSync(dir,{bigint:true}))!==identity(before))fail();dirs.push({path:relative,identity:identity(before)});
  }
  walk(root);if(files.length!==expected.size)fail();
  const manifest=strictJSON(contents.get(descriptor.components.manifest),64*1024);
  if(!closed(manifest,['$schema','name','version','description'])||manifest.$schema!=='https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'||manifest.name!==descriptor.name||manifest.version!==descriptor.version||typeof manifest.description!=='string'||manifest.description.length<1||manifest.description.length>2000)fail();
  const skills=files.filter(f=>/^skills\/[^/]+\/SKILL\.md$/.test(f.path)).map(f=>f.path).sort();
  if(canonical(skills)!==canonical([...descriptor.components.skills].sort()))fail();
  // Every extra Markdown file is inside a declared skill directory. Hidden
  // agents/hooks/executables or unrelated profile/config files are refused.
  if(files.some(f=>f.path!==descriptor.components.manifest&&f.path!=='mcp.json'&&!descriptor.components.skills.some(skill=>f.path.startsWith(skill.slice(0,-'SKILL.md'.length)))))fail();
  if(contents.has('mcp.json')!==!!descriptor.components.mcp.length)fail();
  const servers=[];
  if(descriptor.components.mcp.length){
    const config=strictJSON(contents.get('mcp.json'),64*1024);
    if(!closed(config,['mcpServers'])||!config.mcpServers||typeof config.mcpServers!=='object'||Array.isArray(config.mcpServers)||!Object.keys(config.mcpServers).length||Object.keys(config.mcpServers).length>16)fail();
    for(const [name,value]of Object.entries(config.mcpServers)){
      if(!/^[a-z][a-z0-9-]{0,79}$/.test(name)||!closed(value,['url'])||!remoteURL(value.url))fail();servers.push({name,url:value.url});
    }
  }
  if(clock()-started>LIMITS.timeoutMs||fsApi.realpathSync(root)!==root||parents.some(parent=>identity(fsApi.lstatSync(parent.path,{bigint:true}))!==parent.identity))fail();
  return {root,package_hash:descriptor.package_sha256,descriptor_hash:hash(descriptor),bytes:total,files:files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),directories:dirs,servers};
}
module.exports={verifySource,readBounded,remoteURL};
