'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const V=require('../src/plugins/index-verify'),{verifySource,readBounded,remoteURL}=require('../src/plugins/source-verify'),{createPluginPlanner,productionKeys,REQUIRED_COMMANDS}=require('../src/plugins/plan');
const NOW=Date.parse('2026-10-01T12:00:00.000Z');
const pair=crypto.generateKeyPairSync('ed25519'),keys=[{keyId:V.keyId(pair.publicKey),key:pair.publicKey}];
const sign=bytes=>JSON.stringify({alg:'ed25519',keyId:keys[0].keyId,sig:crypto.sign(null,bytes,pair.privateKey).toString('base64')});
const seal=index=>{const bytes=Buffer.from(JSON.stringify(index));return {bytes,signature:sign(bytes)};};
const verifier=()=>V.createIndexVerifier({keys,now:()=>NOW});
function fixture(t,{mcp=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plugins-verifier-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const bundle=path.join(dir,'packages'),root=path.join(bundle,'delivery-review'),profile=path.join(dir,'profile'),binary=path.join(dir,'codex');fs.mkdirSync(path.join(root,'skills/delivery-review'),{recursive:true});fs.mkdirSync(profile);fs.writeFileSync(binary,'Synthetic binary. Never executed.');fs.writeFileSync(path.join(profile,'config.toml'),'# Synthetic private configuration\n');
  const content=new Map([
    ['plugin.json',Buffer.from(JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',name:'delivery-review',version:'1.0.0',description:'Synthetic reviewed skill.'},null,2))],
    ['skills/delivery-review/SKILL.md',Buffer.from('---\nname: delivery-review\ndescription: Review observed evidence.\n---\nInspect the reported result and relevant tests.\n')],
  ]);
  if(mcp)content.set('mcp.json',Buffer.from(JSON.stringify({mcpServers:{docs:{url:'https://docs.example.com/mcp'}}})));
  for(const [name,bytes]of content)fs.writeFileSync(path.join(root,name),bytes);
  const files=[...content].map(([name,bytes])=>({path:name,bytes:bytes.length,sha256:V.hash(bytes)}));
  const descriptor={id:'delivery-review',catalog_id:'skill:delivery-review',name:'delivery-review',version:'1.0.0',host_min:'0.159.2',source:{type:'bundled-directory',path:'delivery-review',attribution:'Synthetic curated source'},files,package_sha256:V.packageHash(files),components:{manifest:'plugin.json',skills:['skills/delivery-review/SKILL.md'],mcp:mcp?['mcp.json']:[]},capabilities:mcp?['instructions','network','oauth','remote-mcp']:['instructions']};
  const catalog=Buffer.from('{"entries":[{"id":"skill:delivery-review"}]}'),index={schemaVersion:1,generatedAt:'2026-10-01T11:00:00.000Z',catalog_sha256:V.hash(catalog),entries:[descriptor]};
  let time=NOW,live=true,accountGeneration=1,config='synthetic config',cache='synthetic cache',version='0.159.2';
  const snapshot=()=>({profile_root:profile,config:{sha256:V.hash(config),stat:'config:1'},cache:{sha256:V.hash(cache),stat:'cache:1'},host:{kind:'codex',version,binary_path:binary,binary_sha256:V.hash(fs.readFileSync(binary)),binary_stat:'binary:1',commands:[...REQUIRED_COMMANDS]},account:{user_id:'u1',team_id:'t1',member_id:'m1',device_id:'d1',generation:accountGeneration},current:()=>live});
  const options={snapshot,bundleRoot:bundle,loadIndex:async()=>seal(index),loadCatalog:async()=>catalog,verifyIndex:verifier(),now:()=>time};
  return {dir,bundle,root,profile,binary,content,descriptor,index,catalog,snapshot,options,setLive:value=>live=value,changeAccount:()=>accountGeneration++,changeConfig:()=>config+=' changed',changeCache:()=>cache+=' changed',setVersion:value=>version=value,advance:n=>time+=n};
}
test('production trust fails closed; fixture verifier trust is injected only and raw bytes precede schema parsing',t=>{
  const f=fixture(t),raw=seal(f.index);assert.deepEqual(productionKeys(),[]);assert.equal(V.createIndexVerifier()(raw.bytes,raw.signature).reason,'no-production-key');assert.equal(verifier()(raw.bytes,raw.signature).status,'verified');
  const changed=Buffer.from(raw.bytes);changed[20]^=1;assert.equal(verifier()(changed,raw.signature).reason,'signature');assert.equal(verifier()(Buffer.from('{broken JSON'),raw.signature).reason,'signature');
  assert.equal(verifier()(raw.bytes,JSON.stringify({...JSON.parse(raw.signature),extra:'unsigned fallback'})).reason,'signature');
  assert.equal(verifier()(raw.bytes,JSON.stringify({...JSON.parse(raw.signature),keyId:'28c56176d52e3aad'})).reason,'signature');
});
test('strict signed JSON rejects decoded duplicate keys, depth, malformed dates, future/replayed indexes',t=>{
  const f=fixture(t),raw=seal(f.index),duplicate=Buffer.from(raw.bytes.toString().replace('"schemaVersion":1','"schemaVersion":1,"schema\\u0056ersion":1'));
  assert.equal(verifier()(duplicate,sign(duplicate)).reason,'index-json');assert.throws(()=>V.strictJSON(Buffer.from('['.repeat(34)+'0'+']'.repeat(34))));
  for(const generatedAt of ['2026-09-30T11:00:00.000Z','2026-10-03T11:00:00.000Z','2026-02-29T11:00:00.000Z','2026-10-01T11:00:00Z'])assert.equal(verifier()(...Object.values(seal({...f.index,generatedAt}))).reason,'index-time');
});
test('detached signature refuses alternate noncanonical base64 of the same signed bytes',t=>{
  const f=fixture(t),raw=seal(f.index),signature=JSON.parse(raw.signature),alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const at=signature.sig.length-3;signature.sig=signature.sig.slice(0,at)+alphabet[alphabet.indexOf(signature.sig[at])+1]+signature.sig.slice(at+1);
  assert.ok(Buffer.from(signature.sig,'base64').equals(Buffer.from(JSON.parse(raw.signature).sig,'base64')));assert.equal(verifier()(raw.bytes,JSON.stringify(signature)).reason,'signature');
});
test('closed index refuses unsupported archive/remote/stdio/hook/command descriptors and unsafe decoded paths',t=>{
  const f=fixture(t);
  for(const value of ['../outside','%2e%2e/outside','%252e%252e/outside','/absolute','C:/outside','a\\b','a/../b','a//b','a/con.txt','a/\uFF0E\uFF0E/b','a\0b','a/'.repeat(33)+'x'])assert.equal(V.safePath(value),false,value);
  const candidates=[{...f.descriptor,source:{...f.descriptor.source,type:'zip'}},{...f.descriptor,source:{...f.descriptor.source,type:'remote-https'}},{...f.descriptor,command:'npx malicious'},{...f.descriptor,capabilities:['hooks']},{...f.descriptor,components:{...f.descriptor.components,stdio:[]}}];
  for(const d of candidates){const raw=seal({...f.index,entries:[d]});assert.equal(verifier()(raw.bytes,raw.signature).reason,'descriptor');assert.throws(()=>verifySource(d,{bundleRoot:f.bundle}));}
});
test('descriptor enforces all byte/file/entry bounds before filesystem reads',t=>{
  const f=fixture(t);assert.equal(V.descriptorValid({...f.descriptor,files:[{...f.descriptor.files[0],bytes:V.LIMITS.fileBytes+1}]}),false);
  const files=Array.from({length:33},(_,i)=>({path:`skills/x/file-${i}.md`,bytes:V.LIMITS.fileBytes,sha256:'a'.repeat(64)}));assert.equal(V.descriptorValid({...f.descriptor,files,package_sha256:V.packageHash(files)}),false);
  assert.equal(V.descriptorValid({...f.descriptor,files:Array.from({length:1001},(_,i)=>({...f.descriptor.files[0],path:`x${i}.md`}))}),false);
  const raw=seal({...f.index,entries:Array(1001).fill(f.descriptor)});assert.equal(verifier()(raw.bytes,raw.signature).reason,'index-schema');assert.equal(verifier()(Buffer.alloc(V.LIMITS.indexBytes+1),raw.signature).reason,'index-bounds');
});
test('actual bounded local source matches full manifest/components/file bytes without writes',t=>{
  const f=fixture(t,{mcp:true}),before=fs.readFileSync(path.join(f.profile,'config.toml')),source=verifySource(f.descriptor,{bundleRoot:f.bundle});assert.equal(source.files.length,3);assert.equal(source.package_hash,f.descriptor.package_sha256);assert.deepEqual(source.servers,[{name:'docs',url:'https://docs.example.com/mcp'}]);assert.ok(fs.readFileSync(path.join(f.profile,'config.toml')).equals(before));
});
test('supplied bundle-root leaf links including trailing aliases are refused before any source content read',t=>{
  const f=fixture(t),alias=path.join(f.dir,'bundle-alias');fs.symlinkSync(f.bundle,alias);let reads=0;
  const fsApi=new Proxy(fs,{get(object,key){if(key==='readSync')return (...args)=>{reads++;return object.readSync(...args);};return object[key];}});
  for(const bundleRoot of [alias,alias+'/',alias+'/.'])assert.throws(()=>verifySource(f.descriptor,{bundleRoot,fsApi}));assert.equal(reads,0);
  assert.equal(verifySource(f.descriptor,{bundleRoot:f.bundle}).files.length,2);
});
for(const boundary of ['file-link','root-link','hardlink','extra-file','extra-directory','bytes','case-collision'])test(`actual source refuses ${boundary} without accepting foreign source bytes`,t=>{
  const f=fixture(t),target=path.join(f.root,'skills/delivery-review/SKILL.md'),outside=path.join(f.dir,'outside.md');fs.writeFileSync(outside,f.content.get('skills/delivery-review/SKILL.md'));
  if(boundary==='file-link'){fs.unlinkSync(target);fs.symlinkSync(outside,target);}
  if(boundary==='root-link'){fs.renameSync(f.root,f.root+'-old');fs.symlinkSync(f.root+'-old',f.root);}
  if(boundary==='hardlink'){fs.unlinkSync(target);fs.linkSync(outside,target);}
  if(boundary==='extra-file')fs.writeFileSync(path.join(f.root,'unlisted.md'),'Unknown instructions');
  if(boundary==='extra-directory')fs.mkdirSync(path.join(f.root,'unlisted'));
  if(boundary==='bytes')fs.writeFileSync(target,'Changed source bytes');
  if(boundary==='case-collision')fs.writeFileSync(path.join(f.root,'PLUGIN.JSON'),'{}');
  assert.throws(()=>verifySource(f.descriptor,{bundleRoot:f.bundle}));assert.ok(fs.readFileSync(outside).equals(f.content.get('skills/delivery-review/SKILL.md')));
});
test('actual source refuses opened-file race and finite deadline',t=>{
  const f=fixture(t),target=fs.realpathSync(path.join(f.root,'skills/delivery-review/SKILL.md'));
  const fsApi=new Proxy(fs,{get(object,key){if(key==='openSync')return (...args)=>{const fd=object.openSync(...args);if(args[0]===target)object.writeFileSync(target,'Changed after no-follow open');return fd;};return object[key];}});
  assert.throws(()=>verifySource(f.descriptor,{bundleRoot:f.bundle,fsApi}));assert.throws(()=>verifySource(f.descriptor,{bundleRoot:f.bundle,clock:(()=>{let n=0;return ()=>n++*10000;})()}));assert.throws(()=>readBounded(target,1));
});
for(const boundary of ['read-fifo','read-directory','read-symlink','walk-fifo','walk-file','walk-symlink'])test(`actual bounded child refuses ${boundary} replacement without any content read`,t=>{
  const f=fixture(t),reading=boundary.startsWith('read-'),target=reading?path.join(f.root,'skills/delivery-review/SKILL.md'):f.root,replacement=path.join(f.dir,'replacement');
  if(boundary.endsWith('fifo')){const made=spawnSync('/usr/bin/mkfifo',[replacement],{shell:false,timeout:1000});assert.equal(made.status,0);}
  if(boundary.endsWith('directory'))fs.mkdirSync(replacement);
  if(boundary.endsWith('file'))fs.writeFileSync(replacement,'Synthetic replacement.');
  if(boundary.endsWith('symlink'))fs.symlinkSync(reading?path.join(f.root,'plugin.json'):path.join(f.dir,'profile'),replacement);
  const code=String.raw`const fs=require('node:fs');const {readBounded,verifySource}=require(process.argv[1]);const [target,replacement,boundary,bundle,raw]=process.argv.slice(2);let moved=false,reads=0;const f=new Proxy(fs,{get(object,key){if(key===(boundary.startsWith('read-')?'openSync':'opendirSync'))return(...args)=>{if(!moved){moved=true;fs.renameSync(target,target+'.preserved');fs.renameSync(replacement,target);}return object[key](...args);};if(key==='readSync')return(...args)=>{reads++;return object.readSync(...args);};return object[key];}});let refused=false;try{if(boundary.startsWith('read-'))readBounded(target,1024,f);else verifySource(JSON.parse(raw),{bundleRoot:bundle,fsApi:f});}catch{refused=true;}process.stdout.write(JSON.stringify({refused,reads,moved}));process.exitCode=refused&&reads===0&&moved?0:2;`;
  const child=spawnSync(process.execPath,['-e',code,require.resolve('../src/plugins/source-verify'),target,replacement,boundary,f.bundle,JSON.stringify(f.descriptor)],{shell:false,encoding:'utf8',timeout:1000,maxBuffer:4096});
  assert.equal(child.status,0,JSON.stringify({boundary,status:child.status,signal:child.signal,error:child.error?.code,stdout:child.stdout,stderr:child.stderr}));assert.deepEqual(JSON.parse(child.stdout),{refused:true,reads:0,moved:true});
  const preserved=path.join(target+'.preserved',reading?'':'plugin.json');assert.ok(fs.existsSync(preserved));
});
test('remote MCP descriptions accept canonical public DNS only, without network lookup',()=>{
  assert.equal(remoteURL('https://docs.example.com/mcp'),true);
  for(const url of ['https://127.0.0.1/mcp','https://2130706433/mcp','https://0x7f000001/mcp','https://0177.0.0.1/mcp','https://[::1]/mcp','https://docs..example.com/mcp','https://docs.example.com./mcp','https://-docs.example.com/mcp','https://docs.local/mcp','https://docs.internal/mcp','https://docs.example.com:443/mcp','https://docs.example.com/mcp#fragment','https://docs.example.com/mcp?auth=opaque'])assert.equal(remoteURL(url),false,url);
});
test('source directory replacement during file reads cannot produce a verified result',t=>{
  const f=fixture(t),target=fs.realpathSync(path.join(f.root,'skills/delivery-review/SKILL.md'));let replaced=false;
  const fsApi=new Proxy(fs,{get(object,key){if(key==='readSync')return (...args)=>{const count=object.readSync(...args);if(!replaced){replaced=true;fs.renameSync(f.root,f.root+'-old');fs.symlinkSync(f.root+'-old',f.root);}return count;};return object[key];}});
  assert.throws(()=>verifySource(f.descriptor,{bundleRoot:f.bundle,fsApi}));assert.ok(fs.readFileSync(path.join(f.root+'-old','skills/delivery-review/SKILL.md')).equals(f.content.get('skills/delivery-review/SKILL.md')));assert.ok(target);
});
test('signed package refuses hidden executable components, filled MCP credentials, unsupported URLs and known embedded secrets',t=>{
  const f=fixture(t,{mcp:true});
  function replace(name,text){fs.writeFileSync(path.join(f.root,name),text);const file=f.descriptor.files.find(x=>x.path===name);file.bytes=Buffer.byteLength(text);file.sha256=V.hash(text);f.descriptor.package_sha256=V.packageHash(f.descriptor.files);}
  for(const value of [{url:'https://docs.example.com/mcp',headers:{Authorization:'opaque-password'}},{command:'node',args:['server.js']},{url:'http://docs.example.com/mcp'},{url:'https://user:password@docs.example.com/mcp'},{url:'https://docs.example.com/mcp?token=opaque-password'},{url:'https://127.0.0.1/mcp'}]){replace('mcp.json',JSON.stringify({mcpServers:{docs:value}}));assert.throws(()=>verifySource(f.descriptor,{bundleRoot:f.bundle}));}
  replace('mcp.json',JSON.stringify({mcpServers:{docs:{url:'https://docs.example.com/mcp'}}}));replace('plugin.json',JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',name:'delivery-review',version:'1.0.0',description:'Synthetic',hooks:'hooks/command.sh'}));assert.throws(()=>verifySource(f.descriptor,{bundleRoot:f.bundle}));
  replace('plugin.json',f.content.get('plugin.json').toString());replace('skills/delivery-review/SKILL.md','Synthetic key ghp_abcdefghijklmnopqrstuvwxyz0123456789');assert.throws(()=>verifySource(f.descriptor,{bundleRoot:f.bundle}));
});
test('main read-only plan returns opaque ID/relative hashes with no credentials, paths, argv or mutation capability',async t=>{
  const f=fixture(t),planner=createPluginPlanner(f.options),before=fs.readFileSync(path.join(f.profile,'config.toml')),p=await planner.plan('delivery-review');assert.equal(p.ok,true,JSON.stringify(p));assert.equal(p.read_only,true);assert.equal(p.install_available,false);assert.equal(p.plan.scope,'user');assert.ok(!JSON.stringify(p).includes(f.dir));assert.ok(!JSON.stringify(p).includes('synthetic config'));assert.ok(!JSON.stringify(p).includes('u1'));assert.equal(typeof planner.apply,'undefined');assert.equal((await planner.check(p.plan.id)).ok,true);assert.ok(fs.readFileSync(path.join(f.profile,'config.toml')).equals(before));
  assert.equal((await planner.plan('delivery-review',{scope:'project'})).reason,'unsupported-selection');assert.equal((await planner.plan('delivery-review',{scope:'user',url:'https://renderer.invalid'})).ok,false);
});
for(const boundary of ['account','config','cache','binary','source','index','expiry','generation'])test(`existing private plan refuses current ${boundary} change`,async t=>{
  const f=fixture(t),planner=createPluginPlanner(f.options),p=await planner.plan('delivery-review');assert.equal(p.ok,true,JSON.stringify(p));
  if(boundary==='account')f.changeAccount();if(boundary==='config')f.changeConfig();if(boundary==='cache')f.changeCache();if(boundary==='binary')fs.writeFileSync(f.binary,'Different observed binary');if(boundary==='source')fs.chmodSync(path.join(f.root,'plugin.json'),0o600);if(boundary==='index')f.index.generatedAt='2026-10-01T11:01:00.000Z';if(boundary==='expiry')f.advance(V.LIMITS.ttlMs+1);if(boundary==='generation')planner.invalidate();
  assert.equal((await planner.check(p.plan.id)).ok,false);
});
test('canonical profile alias binds one root and current account changes while index is pending withhold a plan',async t=>{
  const f=fixture(t),alias=path.join(f.dir,'profile-alias');fs.symlinkSync(f.profile,alias);let root=f.profile;const planner=createPluginPlanner({...f.options,snapshot:()=>({...f.snapshot(),profile_root:root})}),p=await planner.plan('delivery-review');assert.equal(p.ok,true);root=alias;assert.equal((await planner.check(p.plan.id)).ok,true);
  let release;const pendingPlanner=createPluginPlanner({...f.options,loadIndex:()=>new Promise(r=>release=r)}),pending=pendingPlanner.plan('delivery-review');for(let i=0;i<20&&!release;i++)await new Promise(r=>setImmediate(r));f.setLive(false);release(seal(f.index));assert.equal((await pending).ok,false);
});
test('read-only plans cap count/concurrency, require matching catalog bytes and give concrete unsupported-host reason',async t=>{
  const f=fixture(t),planner=createPluginPlanner(f.options);for(let i=0;i<V.LIMITS.plans;i++)assert.equal((await planner.plan('delivery-review')).ok,true);assert.equal((await planner.plan('delivery-review')).reason,'plan-limit');
  const releases=[],held=createPluginPlanner({...f.options,loadIndex:()=>new Promise(r=>releases.push(r))}),pending=Array.from({length:4},()=>held.plan('delivery-review'));for(let i=0;i<20&&releases.length<4;i++)await new Promise(r=>setImmediate(r));assert.equal(releases.length,4);assert.equal((await held.plan('delivery-review')).reason,'busy');for(const release of releases)release(seal(f.index));assert.equal((await Promise.all(pending)).filter(p=>p.ok).length,4);
  assert.equal((await createPluginPlanner({...f.options,loadCatalog:async()=>Buffer.from('Changed catalog')}).plan('delivery-review')).reason,'catalog-changed');f.setVersion('0.158.0');const old=await createPluginPlanner(f.options).plan('delivery-review');assert.equal(old.reason,'unsupported-host');assert.equal(old.minimum_version,'0.159.2');
});
test('current captured owner change while catalog is pending withholds both plan and existing-plan replies',async t=>{
  const f=fixture(t);let release,hold=false;
  const planner=createPluginPlanner({...f.options,loadCatalog:()=>hold?new Promise(resolve=>release=resolve):f.catalog}),p=await planner.plan('delivery-review');assert.equal(p.ok,true);
  hold=true;const checking=planner.check(p.plan.id);for(let i=0;i<20&&!release;i++)await new Promise(r=>setImmediate(r));assert.ok(release);f.setLive(false);release(f.catalog);assert.equal((await checking).ok,false);
  f.setLive(true);release=null;const planning=planner.plan('delivery-review');for(let i=0;i<20&&!release;i++)await new Promise(r=>setImmediate(r));assert.ok(release);planner.invalidate();release(f.catalog);assert.equal((await planning).ok,false);
});
test('fresh private snapshot after source validation refuses an account switch and a changed cache identity',async t=>{
  const f=fixture(t);let calls=0;
  const planner=createPluginPlanner({...f.options,snapshot:()=>{if(++calls===2){f.changeAccount();f.changeCache();}return f.snapshot();}});
  const result=await planner.plan('delivery-review');assert.equal(result.ok,false);assert.equal(result.reason,'changed');assert.equal(JSON.stringify(result).includes(f.dir),false);
});
test('default fixed bundled index remains unavailable without production keys or index files',async t=>{
  const f=fixture(t),planner=createPluginPlanner({snapshot:f.snapshot,bundleRoot:f.bundle});const result=await planner.plan('delivery-review');assert.equal(result.ok,false);assert.equal(result.status,'unavailable');assert.equal(result.plan,null);
});
for(const phase of ['snapshot','index','catalog','final-snapshot'])test(`existing plan expiry during awaited ${phase} withholds the reply and retires its handle`,async t=>{
  const f=fixture(t);let hold=false,release,captures=0;
  const options={...f.options,snapshot:()=>{captures++;return hold&&(phase==='snapshot'||phase==='final-snapshot'&&captures===4)?new Promise(r=>release=r):f.snapshot();},loadIndex:()=>hold&&phase==='index'?new Promise(r=>release=r):seal(f.index),loadCatalog:()=>hold&&phase==='catalog'?new Promise(r=>release=r):f.catalog};
  const planner=createPluginPlanner(options),p=await planner.plan('delivery-review');assert.equal(p.ok,true);hold=true;const checking=planner.check(p.plan.id);
  for(let i=0;i<30&&!release;i++)await new Promise(r=>setImmediate(r));assert.ok(release);f.advance(V.LIMITS.ttlMs+1);hold=false;release(phase.includes('snapshot')?f.snapshot():phase==='index'?seal(f.index):f.catalog);
  const result=await checking;assert.equal(result.ok,false);assert.equal(result.plan,null);hold=false;assert.equal((await planner.check(p.plan.id)).ok,false);
});
