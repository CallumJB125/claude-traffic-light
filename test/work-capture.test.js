const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWorkCapture,observation,routeFor,repoFor,clean,routeKey}=require('../src/work-capture');
const {execFileSync}=require('node:child_process');
const R={hub:'https://hub.example.test',user_id:'user-a',team_id:'team-a',board_id:'board-a',repo_id:'repo-a',canonical_url:'github.com/org/app',role:'member'};
const event=(extra={})=>({source:'codex',sessionId:'thread-1',host:'mac',cwd:'/working/app',signal:'tool-use',...extra});
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
test('private state refuses public or symlink file and persisted planned mapping survives ambiguous later catalog',async t=>{
 const r=rig(t);await r.router.observe([event()]);fs.chmodSync(r.setup.file,0o644);assert.throws(()=>createWorkCapture(r.setup),/private capture state/);fs.chmodSync(r.setup.file,0o600);
 const link=path.join(r.dir,'link.json');fs.symlinkSync(r.setup.file,link);assert.throws(()=>createWorkCapture({...r.setup,file:link}),/private capture state/);
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
