'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {createSetupsService}=require('../src/setups-service');
const schema=require('../src/borrow/payload');
const {createAccountClient}=require('../buddy-window/accounts');
const sample=()=>({schema:1,files:[{id:randomUUID(),source_id:'git',relative_path:'.gitconfig',format:'gitconfig',content:'[alias]\n st = status\n',note:''}],items:[],note:''});
function fixture(t,extra={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'setups-native-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));fs.writeFileSync(path.join(home,'.gitconfig'),'[alias]\n st = status\n[user]\n name = Synthetic Person\n email = synthetic@example.test\n');
  const principal={user_id:'u1',team_id:'t1',member_id:'m1'},sent=[];let current=true,time=1_000_000;
  const source={name:'Synthetic team',userId:'u1',teamId:'t1',memberId:'m1',role:'member',current:()=>current,async call(op,args){sent.push({op,args});if(op==='publish'){const checked=schema.validatePayload(args.body.payload);return {ok:true,principal,version:{id:randomUUID(),number:1,content_hash:checked.content_hash}};}return {ok:true,principal,status:'complete',profiles:[],baseline:null};}};
  const service=createSetupsService({home,sources:async()=>[source],now:()=>time,confirm:async()=>true,...extra});
  return {service,source,principal,home,sent,setCurrent:v=>current=v,advance:n=>time+=n};
}
const draft=async f=>{const state=await f.service.snapshot();return f.service.draft(state.teams[0].handle,{sources:['git'],inventory:false,ssh:false});};
const approve=(f,d)=>{for(const file of d.file_hashes)d=f.service.approve(d.handle,file.file_id,file.hash);return d;};
test('native selected temp HOME scan exposes only full scrubbed relative content, exact approval and fixed publish',async t=>{
  const f=fixture(t),d=await draft(f);assert.equal(d.ok,true,JSON.stringify(d));assert.ok(d.payload.files[0].content.includes('{{NAME}}'));assert.ok(!JSON.stringify(d).includes(f.home));assert.ok(!JSON.stringify(d).includes('Synthetic Person'));
  assert.equal((await f.service.publish(d.handle,d.content_hash)).ok,false);const reviewed=approve(f,d);
  assert.equal((await f.service.publish(reviewed.handle,reviewed.content_hash)).ok,true);const sent=f.sent.find(s=>s.op==='publish');assert.equal(sent.args.body.review.approved,true);assert.equal(sent.args.body.review.content_hash,schema.validatePayload(sent.args.body.payload).content_hash);assert.ok(!JSON.stringify(sent).includes(f.home));
});
test('editing files or profile notes invalidates all approvals and known secrets never publish',async t=>{
  const f=fixture(t);let d=approve(f,await draft(f));d=f.service.edit(d.handle,{profile_note:'Reviewed note'});assert.equal(d.approved_files.length,0);assert.equal((await f.service.publish(d.handle,d.content_hash)).ok,false);
  d=approve(f,d);const file=d.payload.files[0];d=f.service.edit(d.handle,{file_id:file.id,content:file.content+'\n[credential]\n password = filled-secret\n',note:''});assert.equal(d.content_hash,null);assert.equal(d.approved_files.length,0);assert.equal((await f.service.publish(d.handle,'0'.repeat(64))).ok,false);assert.equal(f.sent.filter(s=>s.op==='publish').length,0);
});
for(const boundary of ['account','expiry','generation','wrongHash'])test(`approved native draft rejects ${boundary} change`,async t=>{
  const f=fixture(t),d=approve(f,await draft(f));if(boundary==='account')f.setCurrent(false);if(boundary==='expiry')f.advance(600001);if(boundary==='generation')f.service.invalidate();
  assert.equal((await f.service.publish(d.handle,boundary==='wrongHash'?'a'.repeat(64):d.content_hash)).ok,false);assert.equal(f.sent.filter(s=>s.op==='publish').length,0);
});
test('account changes while the final native dialog is open stop publication',async t=>{
  let resolve;const f=fixture(t,{confirm:()=>new Promise(r=>resolve=r)}),d=approve(f,await draft(f)),pending=f.service.publish(d.handle,d.content_hash);
  for(let n=0;n<30&&!resolve;n++)await new Promise(r=>setImmediate(r));assert.ok(resolve);f.setCurrent(false);resolve(true);assert.equal((await pending).ok,false);assert.equal(f.sent.filter(s=>s.op==='publish').length,0);
});
test('replacing a reviewed draft while its native dialog is open invalidates the old plan',async t=>{
  let resolve;const f=fixture(t,{confirm:()=>new Promise(r=>resolve=r)}),state=await f.service.snapshot();
  const first=approve(f,await f.service.draft(state.teams[0].handle,{sources:['git'],inventory:false,ssh:false})),pending=f.service.publish(first.handle,first.content_hash);
  for(let n=0;n<30&&!resolve;n++)await new Promise(r=>setImmediate(r));assert.ok(resolve);
  const replacement=await f.service.draft(state.teams[0].handle,{sources:['git'],inventory:false,ssh:false});assert.equal(replacement.ok,true);resolve(true);
  assert.equal((await pending).ok,false);assert.equal(f.sent.filter(s=>s.op==='publish').length,0);
});
test('fresh current-role demotion prevents a reviewed native plan from opening confirmation or publishing',async t=>{
  let confirmations=0;const f=fixture(t,{confirm:async()=>{confirmations++;return true;}}),d=approve(f,await draft(f));
  f.principal.role='viewer';assert.equal((await f.service.publish(d.handle,d.content_hash)).ok,false);assert.equal(confirmations,0);assert.equal(f.sent.filter(s=>s.op==='publish').length,0);
});
test('selected actual scanner limits aggregate files before further reads and bytes before allocation',async t=>{
  const f=fixture(t),dir=path.join(f.home,'.codex/prompts');fs.mkdirSync(dir,{recursive:true});
  for(let i=0;i<129;i++)fs.writeFileSync(path.join(dir,`review-${i}.md`),'Review the delivery.\n');
  let state=await f.service.snapshot(),d=await f.service.draft(state.teams[0].handle,{sources:['codex'],inventory:false,ssh:false});assert.equal(d.ok,true,JSON.stringify(d));assert.equal(d.payload.files.length,128);assert.equal(d.scan_summary.limited,true);
  fs.rmSync(dir,{recursive:true});fs.mkdirSync(path.join(f.home,'.codex'),{recursive:true});const fd=fs.openSync(path.join(f.home,'.codex/config.toml'),'w');fs.ftruncateSync(fd,32*1024*1024+1);fs.closeSync(fd);
  state=await f.service.snapshot();d=await f.service.draft(state.teams[0].handle,{sources:['codex'],inventory:false,ssh:false});assert.equal(d.ok,false);
});
test('extracted MCP JSON refuses account/project keys while permitting only the declared reviewed extraction',()=>{
  const p=sample();Object.assign(p.files[0],{source_id:'claude-code',relative_path:'.claude.json#mcpServers',format:'json',content:JSON.stringify({mcpServers:{}},null,2)+'\n'});assert.ok(schema.validatePayload(p));
  p.files[0].content='{"mcpServers":{},"account":"private"}';assert.throws(()=>schema.validatePayload(p));
});
test('unavailable/current-principal mismatch yields empty summaries and no stale full read',async t=>{
  const f=fixture(t);f.source.call=async()=>({ok:true,principal:{...f.principal,user_id:'other'},status:'complete',profiles:[]});const state=await f.service.snapshot();assert.equal(state.status,'partial');assert.equal(state.teams[0].status,'unavailable');assert.deepEqual(state.teams[0].profiles,[]);assert.equal((await f.service.read('https://renderer.example')).ok,false);
});
test('snapshot principal/team/device markers are rechecked after asynchronous summaries',async t=>{
  const f=fixture(t);let release;f.source.call=()=>new Promise(r=>release=r);const pending=f.service.snapshot();for(let n=0;n<30&&!release;n++)await new Promise(r=>setImmediate(r));f.setCurrent(false);release({ok:true,principal:f.principal,status:'complete',profiles:[]});assert.deepEqual((await pending).teams,[]);
});
test('optional saved inventory and SSH stay off until explicit choices; scanner receives no exec capability',async t=>{
  const calls=[];const f=fixture(t,{scanImpl:options=>{calls.push(options);return {sources:[{id:'git',files:[{path:'~/.gitconfig',format:'gitconfig',content:'[alias]\n st = status\n'}],items:[]}]};}});
  const state=await f.service.snapshot();assert.equal((await f.service.draft(state.teams[0].handle,{sources:['ssh-config'],inventory:false,ssh:false})).ok,false);const d=await f.service.draft(state.teams[0].handle,{sources:['git'],inventory:false,ssh:false});assert.equal(d.ok,true);assert.equal(calls[0].exec,null);assert.deepEqual(calls[0].optIn,[]);
  fs.mkdirSync(path.join(f.home,'.claude/plugins'),{recursive:true});const inventory=path.join(f.home,'.claude/plugins/installed_plugins.json');fs.writeFileSync(inventory,'{}');assert.throws(()=>calls[0].fsApi.lstatSync(inventory),/not selected/);
});
test('closed payload blocks raw machine paths, path tricks, unfilled-secret edits, equivalent containers and oversized bytes',()=>{
  const bad=[];
  for(const relative_path of ['/Users/secret/.gitconfig','../.gitconfig','.gitconfig/../x','.ssh/id_rsa','~/.gitconfig','.gitconfig\\x']){const p=sample();p.files[0].relative_path=relative_path;bad.push(p);}
  for(const content of ['[user]\n name = A Person\n','[x]\n home = /Users/private/project\n','[credential]\n password = opaque-password\n','[alias]\n st = {{SECRET:ghp_abcdefghijklmnopqrstuvwxyz0123456789}}\n','[alias]\n st = {{SECRET:unknown\n','[alias]\n st = <redacted:secret>\n']){const p=sample();p.files[0].content=content;bad.push(p);}
  const toml=sample();Object.assign(toml.files[0],{source_id:'codex',relative_path:'.codex/config.toml',format:'toml',content:'["en\\u0076"]\nNAME="opaque-password"\n'});bad.push(toml);
  const over=sample();over.files[0].content='x'.repeat(schema.SETUP_LIMITS.fileBytes+1);bad.push(over);
  const unknown=sample();unknown.filepath='/tmp/other';bad.push(unknown);
  for(const p of bad)assert.throws(()=>schema.validatePayload(p),JSON.stringify(p).slice(0,100));
  const a=sample();const b={note:a.note,items:a.items,files:a.files,schema:1};assert.equal(schema.validatePayload(a).content_hash,schema.validatePayload(b).content_hash);
});
test('own export uses only a native capability and rechecks identity/exact current version after Save dialog',async t=>{
  let commits=0,resolve;const f=fixture(t,{chooseExport:()=>new Promise(r=>resolve=r)}),p=sample(),checked=schema.validatePayload(p),pid=randomUUID(),vid=randomUUID();
  f.source.call=async op=>op==='list'?{ok:true,principal:f.principal,status:'complete',profiles:[{id:pid,owner_user_id:'u1',current_version:{id:vid,number:1,content_hash:checked.content_hash,sources:['git'],file_count:1,item_count:0}}]}:{ok:true,principal:f.principal,profile:{id:pid,owner_user_id:'u1'},version:{id:vid,number:1,content_hash:checked.content_hash},payload:p};
  const state=await f.service.snapshot(),pending=f.service.export(state.teams[0].profiles[0].handle);for(let n=0;n<30&&!resolve;n++)await new Promise(r=>setImmediate(r));assert.ok(resolve);f.setCurrent(false);resolve(()=>commits++);assert.equal((await pending).ok,false);assert.equal(commits,0);
});
test('native account client uses fixed routes, team headers, private credential and closed operation names',async()=>{
  const seen=[];const client=createAccountClient({origin:'https://registered.example',store:{load:()=>({hub:'https://registered.example',token:'synthetic-token',user:{id:'u1'}})},fetchImpl:async(url,init)=>{seen.push({url,init});return {status:200,json:async()=>({principal:{user_id:'u1'}})};}});
  await client.setups('list','t1',{},'u1','m1');await client.setups('read','t1',{profile:'p1',version:'v1'},'u1','m1');assert.equal((await client.setups('https://renderer.example','t1')).ok,false);assert.equal((await client.setups('list','../other')).ok,false);assert.equal(seen.length,2);assert.equal(seen[0].url,'https://registered.example/api/teams/t1/setups');assert.equal(seen[1].url,'https://registered.example/api/setup-profiles/p1/versions/v1');assert.equal(seen[0].init.headers['X-Board-Team'],'t1');assert.equal(seen[0].init.headers.Authorization,'Bearer synthetic-token');assert.equal(seen[0].init.headers['X-Plexiform-Account'],'u1');assert.equal(seen[0].init.headers['X-Plexiform-Member'],'m1');
});
test('production native main IPC accepts only the exact registered top-level Setups page',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8'),body=source.slice(source.indexOf('const SetupsNative ='),source.indexOf('// Settings → Account & team'));
  const handlers=new Map(),frame={},page={mainFrame:frame};const service={snapshot:()=>42,read:()=>43,draft:()=>44,edit:()=>45,approve:()=>46,publish:()=>47,action:()=>48,export:()=>49};
  const context={require:name=>{assert.equal(name,'./src/setups-service.js');return {createSetupsService:()=>service};},buddyWin:{pageWebContents:id=>id==='setups'?page:null},os:{homedir:()=>'/synthetic'},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)}};vm.createContext(context);vm.runInContext(body,context);
  for(const [name,handler] of handlers){assert.notEqual(handler({sender:page,senderFrame:frame}),null,name);assert.equal(handler({sender:page,senderFrame:{}},'x'),null);assert.equal(handler({sender:{mainFrame:frame},senderFrame:frame},'x'),null);}
});
