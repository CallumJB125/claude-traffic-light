'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {createSetupsPlatform}=require('../../src/setups-platform');
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pf-platform-'))),profile=path.join(root,'profile'),userData=path.join(profile,'Library','Application Support','Plexiform'),bundle=path.join(root,'Plexiform.app'),contents=path.join(bundle,'Contents'),resources=path.join(contents,'Resources');
 fs.mkdirSync(userData,{recursive:true,mode:0o700});fs.mkdirSync(path.join(resources,'setups'),{recursive:true,mode:0o700});fs.mkdirSync(path.join(contents,'_CodeSignature'),{mode:0o700});
 const files={seal:path.join(contents,'_CodeSignature','CodeResources'),asar:path.join(resources,'app.asar'),helper:path.join(resources,'setups','buddy-setups'),manifest:path.join(resources,'setups','helper-manifest.json')};
 for(const [role,p]of Object.entries(files))fs.writeFileSync(p,'synthetic '+role,{mode:role==='helper'?0o700:0o600});
 const calls=[],app={isPackaged:true,getPath:n=>{assert.equal(n,'userData');return userData;},getAppPath:()=>files.asar},base={app,resourcesPath:resources,profilePath:profile,uid:process.getuid(),platform:'darwin',verify:p=>calls.push(['verify',p]),spawn:(...args)=>{calls.push(['spawn',...args]);return {pid:123};}};
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,profile,userData,bundle,contents,resources,files,calls,base,platform:createSetupsPlatform(base)};
}
const options=()=>({args:[],env:{},shell:false,stdio:['pipe','pipe','pipe','pipe']});
test('platform only creates dedicated private schema2 parent and preserves old recovery evidence',t=>{
 const f=fixture(t),old=path.join(f.userData,'setups-transactions');fs.mkdirSync(old,{mode:0o700});fs.writeFileSync(path.join(old,'original-failure'),'original evidence');
 const roots=f.platform.roots();assert.equal(roots.profile.path,f.profile);assert.equal(roots.app.path,path.join(f.userData,'setups-runtime-v2'));assert.equal(roots.app.stamp.mode&0o777n,0o700n);assert.equal(roots.app.stamp.uid,BigInt(process.getuid()));assert.equal(fs.readFileSync(path.join(old,'original-failure'),'utf8'),'original evidence');assert.equal(f.calls.length,0);
});
test('insecure or symlinked existing app root is refused without permission changes',t=>{
 for(const unsafe of ['mode','symlink']){const f=fixture(t),parent=path.join(f.userData,'setups-runtime-v2');if(unsafe==='mode')fs.mkdirSync(parent,{mode:0o777});else fs.symlinkSync(f.profile,parent);if(unsafe==='mode')fs.chmodSync(parent,0o777);assert.throws(()=>f.platform.roots());assert.equal(fs.lstatSync(parent).isSymbolicLink(),unsafe==='symlink');if(unsafe==='mode')assert.equal(fs.statSync(parent).mode&0o777,0o777);}
});
test('launch verifies fixed signed resources and rejects extra commands/environment/descriptors',t=>{
 const f=fixture(t);assert.equal(f.platform.launch(options()).pid,123);const call=f.calls.at(-1);assert.equal(call[1],f.files.helper);assert.deepEqual(call[2],[]);assert.deepEqual(call[3],{env:{},shell:false,stdio:['pipe','pipe','pipe','pipe'],cwd:'/'});assert.equal(f.calls.filter(x=>x[0]==='verify').length,2);
 for(const bad of [{...options(),args:['--command']},{...options(),env:{DYLD_INSERT_LIBRARIES:'foreign'}},{...options(),stdio:['pipe','pipe','pipe','pipe','pipe']},{...options(),executable:'/foreign'},{...options(),shell:true}])assert.throws(()=>f.platform.launch(bad));assert.equal(f.calls.filter(x=>x[0]==='spawn').length,1);
});
test('signed-resource byte changes, same-byte inode replacement and signature failure prevent launch',t=>{
 for(const change of ['helper','manifest','asar','seal']){const f=fixture(t);f.platform.launch(options());fs.writeFileSync(f.files[change],'different sealed bytes');assert.throws(()=>f.platform.launch(options()));assert.equal(f.calls.filter(x=>x[0]==='spawn').length,1);}
 const f=fixture(t);f.platform.launch(options());const p=f.files.helper,bytes=fs.readFileSync(p);fs.renameSync(p,p+'.original');fs.writeFileSync(p,bytes,{mode:0o700});assert.throws(()=>f.platform.launch(options()));
 const g=fixture(t),p2=createSetupsPlatform({...g.base,verify:()=>{throw Error('signature refused');}});assert.throws(()=>p2.launch(options()));assert.equal(g.calls.length,0);
});
test('unsupported/unpackaged/misbound roots fail before any credential or helper access',t=>{
 const f=fixture(t);for(const opts of [{...f.base,platform:'win32'},{...f.base,app:{...f.base.app,isPackaged:false}},{...f.base,profilePath:'/'},{...f.base,resourcesPath:f.root}])assert.throws(()=>createSetupsPlatform(opts));assert.equal(f.calls.length,0);
});
test('actual sealed minimal app launches native snapshot and refuses changed manifest without a new child',async t=>{
 const f=fixture(t),helper=process.env.PLEXIFORM_TEST_HELPER;assert.ok(helper);
 const executable=path.join(f.contents,'MacOS','Plexiform');fs.mkdirSync(path.dirname(executable),{mode:0o700});fs.copyFileSync(helper,executable);fs.copyFileSync(helper,f.files.helper);fs.chmodSync(executable,0o700);fs.chmodSync(f.files.helper,0o700);
 fs.writeFileSync(path.join(f.contents,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.plexiform.synthetic.setups</string><key>CFBundleExecutable</key><string>Plexiform</string><key>CFBundleVersion</key><string>1</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
 const entitlements=path.resolve(__dirname,'../../build/entitlements.setups-helper.plist');assert.ok(fs.existsSync(entitlements));
 for(const p of [f.files.helper,f.bundle])cp.execFileSync('/usr/bin/codesign',['--force','--sign','-','--options','runtime','--entitlements',entitlements,p],{stdio:'pipe',timeout:5000});
 const children=[],platform=createSetupsPlatform({...f.base,verify:undefined,spawn:(...args)=>{const child=cp.spawn(...args);children.push(child);return child;}}),{createNativeSupervisor}=require('../../src/borrow/native-supervisor'),C=require('../../src/borrow/native-codec'),{performance}=require('node:perf_hooks');
 fs.mkdirSync(path.join(f.profile,'.codex'),{mode:0o700});fs.writeFileSync(path.join(f.profile,'.codex','AGENTS.md'),'Synthetic local notes.\n',{mode:0o600});
 const supervisor=createNativeSupervisor({launch:platform.launch,current:()=>true}),session=await supervisor.open({...platform.roots(),generation:1n,mode:1,authority_hash:C.hash(Buffer.from('synthetic-main-authority'))},performance.now()+8000);
 try{const out=await session.request(0x30,new C.Writer().u32(1).finish());assert.equal(out.result,0);const r=new C.Reader(out.body),snap=C.snapshot(Buffer.from(r.blob(C.LIMITS.snapshot)));r.done();assert.equal(snap.content.toString(),'Synthetic local notes.\n');C.wipe([snap,out]);}finally{assert.equal((await session.close()).status,'closed');}
 assert.equal(children.length,1);fs.writeFileSync(f.files.manifest,'Changed manifest after acceptance');assert.throws(()=>platform.launch(options()));assert.equal(children.length,1);
});
