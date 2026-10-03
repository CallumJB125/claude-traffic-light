const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWorkCapture,observation,routeFor,repoFor,clean,routeKey}=require('../src/work-capture');
const {execFileSync}=require('node:child_process');
const crypto=require('node:crypto');
const R={hub:'https://hub.example.test',user_id:'user-a',team_id:'team-a',board_id:'board-a',repo_id:'repo-a',canonical_url:'github.com/org/app',role:'member'};
const event=(extra={})=>({source:'codex',sessionId:'thread-1',host:'mac',cwd:'/working/app',signal:'tool-use',updatedAt:new Date(100000).toISOString(),...extra});
function rig(t,opts={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'work-capture-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const calls=[];let time=100000;
 const setup={file:path.join(dir,'capture.json'),host:'mac',getRoutes:async()=>({routes:[R],complete:true}),resolveRepo:async()=>R.canonical_url,
   sendLocal:async body=>{calls.push({kind:'local',body});return {ok:true,card:{id:'local-card'}};},sendTeam:async(destination,body)=>{calls.push({kind:'team',destination,body});return {ok:true,card:{id:'team-card'}};},now:()=>time,...opts};
 const router=createWorkCapture(setup);t.after(()=>router.stop());return {dir,calls,router,setup,advance:n=>time+=n};}
test('known exact team repo routes to its team, unmatched work to personal, no source paths or summaries shared',async t=>{
 const r=rig(t);await r.router.observe([event({taskTitle:'Fix route',taskSummary:'PRIVATE TEXT'})]);assert.equal(r.calls[0].kind,'team');assert.equal(r.calls[0].body.title,'Fix route');assert.equal(r.calls[0].body.summary,undefined);assert.equal(r.calls[0].body.repo_id,R.repo_id);
 assert.ok(!JSON.stringify(r.calls).includes('/working'));r.setup.resolveRepo=async()=>null;
 const other=createWorkCapture({...r.setup,resolveRepo:async()=>null,file:path.join(r.dir,'other.json')});t.after(()=>other.stop());await other.observe([event({sessionId:'unmatched'})]);assert.equal(r.calls.at(-1).kind,'local');assert.equal(r.calls.at(-1).body.repo_id,null);
});
test('ambiguous teams/boards/accounts stay personal needing routing; only current exact remembered choice resolves',()=>{
 const B={...R,team_id:'team-b',board_id:'board-b',repo_id:'repo-b'};
 assert.deepEqual(routeFor(R.canonical_url,[R,B]),{kind:'local',needs_routing:true});assert.equal(routeFor(R.canonical_url,[R,B],B).board_id,'board-b');
 assert.equal(routeFor(R.canonical_url,[R,B],{...B,user_id:'different'}).kind,'local');assert.equal(routeFor(R.canonical_url,[{...R,role:'viewer'}]).reason,'team_read_only');
});
test('stable identity retries and restart keep destination and card, summary changes send again without duplicate tasks',async t=>{
 const r=rig(t);await r.router.observe([event()]);await r.router.observe([event()]);assert.equal(r.calls.length,1);
 await r.router.stop();const again=createWorkCapture({...r.setup,getRoutes:async()=>({routes:[],complete:true})});t.after(()=>again.stop());
 await again.observe([event({signal:'stop'})]);assert.equal(r.calls.length,2);assert.equal(r.calls.at(-1).kind,'team');assert.equal(r.calls.at(-1).body.status,'review');assert.equal(again.snapshot().length,1);
 const stored=JSON.parse(fs.readFileSync(r.setup.file));assert.equal(Object.keys(stored.tasks).length,1);assert.equal(stored.tasks[Object.keys(stored.tasks)[0]].card_id,'team-card');
});
test('offline incomplete catalog does not guess personal or publish to a random team; failed send keeps planned destination',async t=>{
 const r=rig(t,{getRoutes:async()=>({routes:[],complete:false})});await r.router.observe([event()]);assert.equal(r.calls.length,0);assert.equal(r.router.snapshot().length,0);
 const later=createWorkCapture({...r.setup,file:path.join(r.dir,'later.json'),getRoutes:async()=>({routes:[R],complete:true}),sendTeam:async()=>({ok:false})});t.after(()=>later.stop());
 await later.observe([event()]);assert.equal(later.snapshot().length,1);assert.equal(later.snapshot()[0].destination.kind,'team');assert.equal(later.snapshot()[0].card_id,null);
});
test('a partial catalog with a known team does not hide a second matching team; explicit personal stays local while offline',async t=>{
 const r=rig(t,{getRoutes:async()=>({routes:[R],complete:false})});await r.router.observe([event()]);assert.equal(r.calls.length,0);
 await r.router.observe([event({scope:{state:'personal'}})]);assert.equal(r.calls.length,1);assert.equal(r.calls[0].kind,'local');
});
test('user personal override stops team updates, and reported stop is review never Done',async t=>{
 const r=rig(t);await r.router.observe([event()]);await r.router.observe([event({scope:{state:'personal'},taskTitle:'private new title'})]);assert.equal(r.calls.length,1);
 await r.router.observe([event({signal:'stop'})]);assert.equal(r.calls.length,1);assert.equal(r.router.snapshot()[0].reason,'personal_override');
 await r.router.observe([event({sessionId:'new-thread',signal:'stop'})]);assert.equal(r.calls.at(-1).body.status,'review');assert.ok(!JSON.stringify(r.calls).includes('done'));
});
test('ended/missing observation becomes idle after grace; no synthetic runner heartbeat or execution fields',async t=>{
 const r=rig(t);await r.router.observe([event()]);r.advance(31000);await r.router.observe([]);assert.equal(r.calls.at(-1).body.status,'idle');
 assert.ok(!JSON.stringify(r.calls).match(/run_id|dispatch|evidence|for_agent|cwd/));
});
test('remote/demo/board-backed/owned source and malformed identity ignored; spoofed provider not authority',()=>{
 for(const extra of [{remote:true},{demo:true},{boardRunId:'run'},{owned:{launcher:'board'}},{source:'admin'},{sessionId:'../escape'},{host:'foreign'}])assert.equal(observation(event(extra),{host:'mac'}),null);
 assert.equal(observation(event(),{ownedRoots:['/working']}),null);assert.equal(observation(event({taskId:'../escape'})),null);
});
test('reported text scrubs credentials, source paths, URL secrets and controls',()=>{
 const token='pfi_'+'a'.repeat(43),s=clean(`hello\u202e ${token} password=abcdef /Users/real/private https://user:secret@example.test/path?token=abcdef#secret`,2000);
 assert.ok(!s.includes(token)&&!s.includes('abcdef')&&!s.includes('/Users')&&!s.includes('user:secret')&&!s.includes('\u202e'));
 const url=clean('Read https://example.test/path?token=abcdef#secret',2000);assert.match(url,/https:\/\/example.test\/path/);assert.ok(!url.includes('abcdef')&&!url.includes('#secret'));
 const privateText=clean('Read /etc/private/config file:///opt/private/config brt1.session.secret bmr1.receipt.secret',2000);
 assert.ok(!privateText.includes('/etc')&&!privateText.includes('/opt')&&!privateText.includes('receipt.secret')&&!privateText.includes('session.secret'));
});
test('actual git canonical origin lookup handles worktree local common config without executing project commands',async t=>{
 const r=rig(t),dir=path.join(r.dir,'repo');fs.mkdirSync(dir);execFileSync('git',['init','-q',dir]);execFileSync('git',['-C',dir,'remote','add','origin','https://user:secret@github.com/Org/App.git']);
 assert.equal(await repoFor(dir),'github.com/org/app');assert.equal(await repoFor('relative'),null);
});
test('actual Git userinfo/SCP and linked worktrees keep a safe identity, while query/fragment/encoded delimiters fail closed',async t=>{
 const r=rig(t),dir=path.join(r.dir,'repo');execFileSync('git',['init','-q',dir]);
 execFileSync('git',['-C',dir,'-c','user.name=Synthetic','-c','user.email=synthetic@example.test','commit','--allow-empty','-qm','fixture']);
 const linked=path.join(r.dir,'linked');execFileSync('git',['-C',dir,'worktree','add','--detach','-q',linked]);
 for(const [origin,expected]of [
   ['https://user:synthetic-secret@github.com/Org/App.git','github.com/org/app'],
   ['git@github.com:Org/App.git','github.com/org/app'],
   ['ssh://git@github.com:22/Org/App.git','github.com/org/app'],
   ['https://github.com/Org/App.git?token=synthetic-secret',null],
   ['https://github.com/Org/App.git#synthetic-secret',null],
   ['https://github.com/Org/App.git%3Ftoken=synthetic-secret',null],
   ['https://github.com/Org/App@synthetic-secret.git',null],
   ['https://user:synthetic-secret/github.com/Org/App.git',null],
   ['https://user:synthetic-secret@github.com:synthetic-secret/Org/App.git',null],
   ['file:///tmp/synthetic-secret',null],
 ]) {
   execFileSync('git',['-C',dir,'config','--local','remote.origin.url',origin]);
   assert.equal(await repoFor(dir),expected);assert.equal(await repoFor(linked),expected);
 }
});
test('private state refuses public or symlink file and persisted planned mapping survives ambiguous later catalog',async t=>{
 const r=rig(t);await r.router.observe([event()]);const bytes=fs.readFileSync(r.setup.file);fs.chmodSync(r.setup.file,0o644);
 const unavailable=createWorkCapture(r.setup);t.after(()=>unavailable.stop());assert.equal(unavailable.enabled(),false);assert.equal(unavailable.setEnabled(true),false);await unavailable.observe([event()]);assert.equal(r.calls.length,1);assert.deepEqual(fs.readFileSync(r.setup.file),bytes);fs.chmodSync(r.setup.file,0o600);
 const link=path.join(r.dir,'link.json');fs.symlinkSync(r.setup.file,link);const linked=createWorkCapture({...r.setup,file:link});t.after(()=>linked.stop());assert.equal(linked.enabled(),false);assert.match(linked.notice(),/paused/);assert.equal(fs.lstatSync(link).isSymbolicLink(),true);
});
test('remembered defaults require a fresh exact writable route and apply to future identities without moving an existing card',async t=>{
 const B={...R,team_id:'team-b',board_id:'board-b',repo_id:'repo-b'};let catalog={routes:[R,B],complete:true};
 const r=rig(t,{getRoutes:async()=>catalog});await r.router.observe([event()]);assert.equal(r.calls[0].kind,'local');
 assert.equal(await r.router.choose(R.canonical_url,routeKey(B)),true);
 r.advance(16000);await r.router.observe([event(),event({sessionId:'next'})]);assert.equal(r.calls.find(c=>c.body.session_id==='next').destination.board_id,'board-b');
 assert.equal(r.calls.filter(c=>c.body.session_id==='thread-1').at(-1).kind,'local');
 catalog={routes:[{...B,user_id:'another-user'}],complete:true};assert.equal(await r.router.choose(R.canonical_url,routeKey(B)),false);
 catalog={routes:[{...B,role:'viewer'}],complete:true};assert.equal(await r.router.choose(R.canonical_url,routeKey(B)),false);
 catalog={routes:[B],complete:false};assert.equal(await r.router.choose(R.canonical_url,routeKey(B)),false);
});
test('automatic cards can be paused privately across restart without issuing another report',async t=>{
 const r=rig(t);await r.router.observe([event()]);r.router.setEnabled(false);r.advance(20000);await r.router.observe([event({signal:'stop'})]);assert.equal(r.calls.length,1);
 await r.router.stop();const again=createWorkCapture(r.setup);t.after(()=>again.stop());assert.equal(again.enabled(),false);await again.observe([event()]);assert.equal(r.calls.length,1);
 again.setEnabled(true);await again.observe([event({signal:'stop'})]);assert.equal(r.calls.at(-1).body.status,'review');assert.equal(again.snapshot().length,1);
});
test('repeated polling does not renew reported freshness; a real hook change does and stale startup files create no cards',async t=>{
 const r=rig(t);await r.router.observe([event({updatedAt:new Date(100000).toISOString()})]);r.advance(61000);
 await r.router.observe([event({updatedAt:new Date(100000).toISOString()})]);assert.equal(r.calls.length,1);
 await r.router.observe([event({updatedAt:new Date(161000).toISOString()})]);assert.equal(r.calls.length,2);
 await r.router.observe([event({sessionId:'old-file',updatedAt:new Date(0).toISOString()})]);assert.equal(r.router.snapshot().length,1);
});
test('failed unchanged reports back off while keeping their pinned identity',async t=>{
 let attempts=0;const r=rig(t,{sendTeam:async()=>{attempts++;return {ok:false};}});await r.router.observe([event()]);await r.router.observe([event()]);assert.equal(attempts,1);
 r.advance(15001);await r.router.observe([event()]);assert.equal(attempts,2);assert.equal(r.router.snapshot().length,1);
});
test('summary sharing follows the current route preference and an explicit empty brief can clear only a managed brief',async t=>{
 let share=false;const r=rig(t,{getRoutes:async()=>({routes:[{...R,share_summaries:share}],complete:true})});
 await r.router.observe([event({taskSummary:'private'})]);assert.equal(r.calls.at(-1).body.summary,undefined);
 share=true;r.advance(16000);await r.router.observe([event({taskSummary:'new brief'})]);assert.equal(r.calls.at(-1).body.summary,'new brief');
 await r.router.observe([event({taskSummary:''})]);assert.equal(r.calls.at(-1).body.summary,'');
 share=false;r.advance(16000);await r.router.observe([event({taskSummary:'now private',signal:'stop'})]);assert.equal(r.calls.at(-1).body.summary,undefined);
});
test('an acknowledged server tombstone stops further reports and updates the local destination display',async t=>{
 let updates=0,attempts=0;const r=rig(t,{onChange:()=>updates++,sendTeam:async()=>{attempts++;return {ok:true,card:{id:'card'},capture:{tracking:'archived'}};}});
 await r.router.observe([event()]);assert.equal(r.router.snapshot()[0].untracked,true);assert.equal(r.router.snapshot()[0].reason,'archived');assert.ok(updates>0);
 await r.router.observe([event({signal:'stop'})]);assert.equal(attempts,1);
});
test('all activity sends require a recent finite source marker, including changed status and summaries',async t=>{
 const r=rig(t);await r.router.observe([event()]);r.advance(61001);
 for(const updatedAt of [new Date(100000).toISOString(),new Date(300000).toISOString(),'invalid',null,undefined]) {
   await r.router.observe([event({updatedAt,signal:'stop',taskSummary:'changed'})]);
 }
 assert.equal(r.calls.length,1);
 await r.router.observe([event({updatedAt:new Date(161001).toISOString(),signal:'stop'})]);assert.equal(r.calls.length,2);
 assert.equal(r.calls.at(-1).body.status,'review');
});
test('an observation that expires during repository lookup is not pinned or sent',async t=>{
 const r=rig(t,{resolveRepo:async()=>{r.advance(61001);return R.canonical_url;}});
 await r.router.observe([event()]);assert.equal(r.calls.length,0);assert.equal(r.router.snapshot().length,0);
});
test('a failed source cooldown survives restart and cannot be bypassed by a new title or phase',async t=>{
 let attempts=0;const r=rig(t,{sendTeam:async()=>{attempts++;return {ok:false};}});
 await r.router.observe([event()]);const planned=JSON.parse(fs.readFileSync(r.setup.file));await r.router.stop();
 const again=createWorkCapture(r.setup);t.after(()=>again.stop());
 await again.observe([event({signal:'stop',taskTitle:'new title'})]);assert.equal(attempts,1);
 r.advance(15001);await again.observe([event({signal:'stop',updatedAt:new Date(115001).toISOString()})]);assert.equal(attempts,2);
 assert.equal(JSON.parse(fs.readFileSync(r.setup.file)).install_id,planned.install_id);assert.equal(again.snapshot().length,1);
});
test('failed idle cooldown survives restart and an idle acknowledgement accepts permanent server tracking stop',async t=>{
 let idleAttempts=0;const r=rig(t,{sendTeam:async(_,body)=>body.status==='idle'? (++idleAttempts,idleAttempts===1?{ok:false}:{ok:true,capture:{tracking:'deleted'}}):{ok:true,card:{id:'card'}}});
 await r.router.observe([event()]);r.advance(31000);await r.router.observe([]);assert.equal(idleAttempts,1);await r.router.stop();
 const again=createWorkCapture(r.setup);t.after(()=>again.stop());await again.observe([]);assert.equal(idleAttempts,1);
 r.advance(15001);await again.observe([]);assert.equal(idleAttempts,2);assert.equal(again.snapshot()[0].untracked,true);
 await again.observe([event({updatedAt:new Date(146001).toISOString()})]);assert.equal(idleAttempts,2);assert.equal(again.snapshot()[0].reason,'deleted');
});
test('legacy private metadata is scrubbed and compacted without changing source, card or destination identities',async t=>{
 const r=rig(t);await r.router.observe([event()]);await r.router.stop();
 const v=JSON.parse(fs.readFileSync(r.setup.file)),[key]=Object.keys(v.tasks),e=v.tasks[key];
 e.repo='github.com/org/app?access_token=synthetic-query-secret';e.destination.canonical_url=e.repo;
 e.destination.unknown='synthetic-query-secret';e.extra='synthetic-query-secret';
 fs.writeFileSync(r.setup.file,JSON.stringify(v),{mode:0o600});
 const again=createWorkCapture(r.setup);t.after(()=>again.stop());const stored=JSON.parse(fs.readFileSync(r.setup.file));
 assert.equal(stored.install_id,v.install_id);assert.deepEqual(Object.keys(stored.tasks),[key]);
 for(const k of ['user_id','team_id','board_id','repo_id','hub'])assert.equal(stored.tasks[key].destination[k],e.destination[k]);
 assert.equal(stored.tasks[key].card_id,e.card_id);assert.equal(stored.tasks[key].repo,null);
 assert.ok(!JSON.stringify(again.snapshot()).includes('synthetic-query-secret'));assert.ok(!fs.readFileSync(r.setup.file,'utf8').includes('synthetic-query-secret'));
});
test('byte quota refuses new pinned work before sending and preserves a readable complete identity set',async t=>{
 const r=rig(t);await r.router.stop();const ceiling=2*1024*1024;
 const v={v:1,install_id:crypto.randomUUID(),tasks:{},choices:{}};
 let i=0;
 for(;;) {
   const entry={destination:{kind:'local'},repo:null,provider:'codex',session_id:'s'.repeat(114)+String(i++).padStart(6,'0'),task_id:'t'.repeat(120),
     title:'界'.repeat(200),status:'working',card_id:crypto.randomUUID(),untracked:true,reason:'stopped'};
   const key=crypto.createHash('sha256').update(JSON.stringify([entry.provider,entry.session_id,entry.task_id])).digest('hex');
   v.tasks[key]=entry;
   if(Buffer.byteLength(JSON.stringify(v),'utf8')>ceiling-400){delete v.tasks[key];break;}
   assert.ok(i<2000);
 }
 fs.writeFileSync(r.setup.file,JSON.stringify(v),{mode:0o600});const original=fs.readFileSync(r.setup.file);
 const again=createWorkCapture({...r.setup,resolveRepo:async()=>null});t.after(()=>again.stop());
 await again.observe([event({sessionId:'quota-new'})]);assert.equal(r.calls.length,0);
 assert.equal(again.snapshot().length,Object.keys(v.tasks).length);assert.match(again.notice(),/storage is full/);
 assert.deepEqual(fs.readFileSync(r.setup.file),original);assert.ok(fs.statSync(r.setup.file).size<=ceiling);
 await again.stop();const restarted=createWorkCapture(r.setup);t.after(()=>restarted.stop());
 assert.equal(restarted.enabled(),true);assert.equal(restarted.snapshot().length,Object.keys(v.tasks).length);
 assert.equal(JSON.parse(fs.readFileSync(r.setup.file)).install_id,v.install_id);
});
test('a failed private rename keeps memory and disk pinned and removes temporary bytes before any HTTP',async t=>{
 const r=rig(t),prior=fs.readFileSync(r.setup.file),rename=fs.renameSync;
 fs.renameSync=()=>{const e=new Error('synthetic disk failure');e.code='EIO';throw e;};
 try {await r.router.observe([event()]);assert.equal(r.calls.length,0);assert.equal(r.router.snapshot().length,0);
   assert.deepEqual(fs.readFileSync(r.setup.file),prior);assert.deepEqual(fs.readdirSync(r.dir),['capture.json']);assert.match(r.router.notice(),/could not save/);
 }finally{fs.renameSync=rename;}
 await r.router.observe([event()]);assert.equal(r.calls.length,1);assert.equal(r.router.notice(),null);
 assert.equal(JSON.parse(fs.readFileSync(r.setup.file)).install_id,JSON.parse(prior).install_id);
});
test('invalid or oversized private capture storage pauses safely without resetting or rewriting identities',async t=>{
 const r=rig(t);await r.router.stop();
 for(const bytes of [Buffer.from('{bad json'),Buffer.alloc(2*1024*1024+1,'x')]) {
   fs.writeFileSync(r.setup.file,bytes,{mode:0o600});const paused=createWorkCapture(r.setup);t.after(()=>paused.stop());
   assert.equal(paused.enabled(),false);assert.equal(paused.setEnabled(true),false);await paused.observe([event()]);assert.equal(r.calls.length,0);
   assert.equal(await paused.choose(R.canonical_url,routeKey(R)),false);assert.deepEqual(fs.readFileSync(r.setup.file),bytes);assert.match(paused.notice(),/identities have been kept/);
 }
});
test('a subagent finishing keeps the card working; only the main stop or session end leaves working',()=>{
 const {phase}=require('../src/work-capture');
 assert.equal(phase('subagent-done'),'working');assert.equal(phase('stop'),'review');assert.equal(phase('session-end'),'ended');
});
