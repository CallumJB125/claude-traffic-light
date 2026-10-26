'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createOverviewService}=require('../src/overview-service');
const time=Date.parse('2026-10-02T10:00:00Z'),at=n=>new Date(time-n).toISOString();
function fixture(over={}){
 let visible=true,clock=time,sends=0,opens=0;
 const raw={sessionId:'private-session',source:'codex',signal:'tool-use',codexLifecycle:1,codexClosedTurn:false,codexTurnId:'turn',codexHookAt:at(10),updatedAt:at(10),cwd:'/Users/private/project',taskId:'task'};
 const row={board_id:'board',board_name:'Team board',team_id:'team',member_id:'member',card:{id:'card',title:'Human edited task',key:'T-1',fence:3,repo:{id:'repo',short_name:'project'},run:{id:'run',ai:'codex',device_name:'Windows laptop'},run_state:'running',live:{hb_age_ms:10}}};
 const data={ok:true,status:'complete',principal:{user_id:'owner'},cards:[row],agents:[{card_id:'card',board_id:'board',member_id:'member',connection:'accepted',live:{green:true,hb_age_ms:10}}]};
 const source={key:'hub',kind:'team',userId:'owner',current:()=>true,matches:()=>true,read:async()=>data,open:async(r,fresh)=>{assert(fresh());opens++;return true;},send:async(r,text,id,fresh)=>{assert(fresh());sends++;return {ok:true,message:{body:'private reply'}};}};
 const capture=[{provider:'codex',session_id:raw.sessionId,task_id:'task',card_id:'card',destination:{kind:'team',board_id:'board',team_id:'team'}}];
 const svc=createOverviewService({sessions:()=>[raw],work:async()=>({sources:[source],capture}),current:()=>visible,now:()=>clock,...over});
 return{svc,raw,row,data,source,capture,hide:()=>visible=false,tick:n=>clock+=n,get sends(){return sends;},get opens(){return opens;}};
}
test('Overview current card title wins and DTO excludes private identities, paths and receipt bodies',async()=>{const x=fixture();const s=await x.svc.snapshot();assert.equal(s.sessions.length,1);const r=s.sessions[0];assert.equal(r.task.title,'Human edited task');assert.equal(r.capabilities.message.enabled,true);assert.match(r.handle,/^[a-f0-9-]{36}$/);for(const secret of ['private-session','/Users/private','"run"','"member"','"repo"'])assert(!JSON.stringify(s).includes(secret));assert.deepEqual(await x.svc.message({handle:r.handle,text:' Selected message '}),{ok:true,status:'queued',error:''});assert.equal(x.sends,1);});
test('Overview unbound reported provider and opted local model have UUID handles and honest unavailable controls',async()=>{const x=fixture({work:async()=>({sources:[],capture:[]})});x.raw.source='ollama';x.raw.model='qwen3:8b';x.raw.taskTitle='Explicitly reported task';x.raw.updatedAt=at(20);const r=(await x.svc.snapshot()).sessions[0];assert.equal(r.provider.kind,'local');assert.match(r.provider.label,/qwen3:8b/);assert.equal(r.task.title,'Explicitly reported task');assert.equal(r.capabilities.message.enabled,false);assert.equal((await x.svc.message({handle:r.handle,text:'Hi'})).status,'unavailable');});
test('Overview parent Stop preserves a working child; own bound fresh child request reports Waiting',async()=>{const x=fixture();x.raw.codexClosedTurn=true;x.raw.signal='stop';x.raw.codexAgents=[{id:'child',status:'working',since:at(10),turnId:'ct',codexInputRequests:[]}];let r=(await x.svc.snapshot()).sessions[0];assert.equal(r.children[0].status,'Working on it');x.raw.codexAgents[0].codexInputRequests=[{id:'ask',turnId:'ct',kind:'async',askedAt:at(20)}];r=(await x.svc.snapshot()).sessions[0];assert.equal(r.children[0].status,'Needs you');x.raw.codexAgents[0].codexInputRequests[0].askedAt=at(90001);r=(await x.svc.snapshot()).sessions[0];assert.equal(r.children[0].status,'Working on it');});
test('Overview parent and child Waiting agree for actual open current child requests',async()=>{const x=fixture();x.raw.codexAgents=[{id:'child',status:'working',since:at(10),turnId:'ct',codexInputRequests:[{id:'ask',turnId:'ct',kind:'sync',askedAt:at(20)}]}];const r=(await x.svc.snapshot()).sessions[0];assert.equal(r.status,'Needs you');assert.equal(r.children[0].status,'Needs you');});
for(const mutation of ['archive','fence','run','membership','principal','connection','human-title'])test(`Overview refuses changed ${mutation} before explicit message`,async()=>{const x=fixture();const r=(await x.svc.snapshot()).sessions[0];if(mutation==='archive')x.row.card.archived=true;if(mutation==='fence')x.row.card.fence++;if(mutation==='run')x.row.card.run.id='replacement';if(mutation==='membership')x.row.member_id='other';if(mutation==='principal')x.data.principal.user_id='other';if(mutation==='connection')x.data.agents[0].connection='unavailable';if(mutation==='human-title')x.row.card.title='New human-selected task';assert.equal((await x.svc.message({handle:r.handle,text:'Hi'})).ok,false);assert.equal(x.sends,0);});
test('Overview disabled capability cannot be forged using an otherwise valid bound handle',async()=>{const x=fixture();x.raw.codexHookAt=at(90001);const r=(await x.svc.snapshot()).sessions[0];assert.equal(r.capabilities.message.enabled,false);assert.equal((await x.svc.message({handle:r.handle,text:'Hi'})).status,'unavailable');assert.equal(x.sends,0);});
test('Overview consumes message handles once, refresh retires old handles and TTL expires',async()=>{const x=fixture();let r=(await x.svc.snapshot()).sessions[0];const results=await Promise.all([x.svc.message({handle:r.handle,text:'Hi'}),x.svc.message({handle:r.handle,text:'Hi'})]);assert.equal(results.filter(r=>r.ok).length,1);assert.equal(x.sends,1);r=(await x.svc.snapshot()).sessions[0];await x.svc.snapshot();assert.equal((await x.svc.open({handle:r.handle})).status,'stale');r=(await x.svc.snapshot()).sessions[0];x.tick(45001);assert.equal((await x.svc.open({handle:r.handle})).status,'stale');});
test('Overview hidden while source read awaits denies open and message effects',async()=>{const x=fixture();const r=(await x.svc.snapshot()).sessions[0];let release;x.source.read=()=>new Promise(res=>release=res);const p=x.svc.message({handle:r.handle,text:'Hi'});await Promise.resolve();x.hide();release(x.data);assert.equal((await p).ok,false);assert.equal(x.sends,0);});
test('Overview malformed requests, overflow and raw action fields cannot select private targets',async()=>{const x=fixture();const r=(await x.svc.snapshot()).sessions[0];for(const req of [{handle:[r.handle],text:'Hi'},{handle:r.handle,text:new String('Hi')},{handle:r.handle,text:'x'.repeat(4001)},{handle:r.handle,text:'\0Hi'},{handle:r.handle,text:'Hi',card:'foreign'},{handle:r.handle,text:'😀'.repeat(2049)}])assert.equal((await x.svc.message(req)).status,'invalid');assert.equal(x.sends,0);});
test('Overview paired report cannot join this device capture, duplicate parent/child IDs remain bounded unique',async()=>{const x=fixture({sessions:()=>[raw,raw],work:async()=>({sources:[],capture:[]})});const raw=x.raw;raw.remote=true;raw.device='paired';raw.codexAgents=[{id:'c',status:'working',since:at(20)},{id:'c',status:'working',since:at(20)}];const s=await x.svc.snapshot();assert.equal(s.sessions.length,1);assert.equal(s.sessions[0].children.length,1);assert.equal(s.sessions[0].capabilities.open.enabled,false);});
test('Overview unknown/future reports do not claim current freshness or infer task content',async()=>{const x=fixture({work:async()=>({sources:[],capture:[]})});x.raw.codexHookAt=new Date(time+1).toISOString();x.raw.prompt='Private user prompt';const r=(await x.svc.snapshot()).sessions[0];assert.equal(r.freshness,'unknown');assert.equal(r.age_ms,null);assert.equal(r.task.status,'unknown');assert(!JSON.stringify(r).includes(x.raw.prompt));});
test('Overview owned Tasks message is current provider/state/live bound and guarded through transport',async()=>{let task={id:'owned',title:'Managed task',ai:{id:'codex'},state:'running',label:'Working',green:true,actions:['message']},sent=0;const svc=createOverviewService({now:()=>time,managed:()=>({conn:{status:'connected'},tasks:[task]}),messageManaged:async(id,text,fresh)=>{assert(fresh());sent++;return{ok:true};}});let r=(await svc.snapshot()).sessions[0];assert.equal((await svc.message({handle:r.handle,text:'Hi'})).status,'queued');assert.equal(sent,1);r=(await svc.snapshot()).sessions[0];task={...task,state:'paused'};assert.equal((await svc.message({handle:r.handle,text:'Hi'})).status,'stale');assert.equal(sent,1);});
test('Overview owned navigation transfers only after current document check and retains post-await authority',async()=>{let current=true,nav=true;const x=fixture({current:()=>current,navigationCurrent:()=>nav});x.source.open=async(row,fresh,begin)=>{assert(fresh());assert(begin());current=false;assert(fresh());nav=false;assert.equal(fresh(),false);return false;};const r=(await x.svc.snapshot()).sessions[0];assert.equal((await x.svc.open({handle:r.handle})).ok,false);});

test('Overview actual managed run states use closed UI status labels; only eligible current decisions claim Waiting on you',async()=>{
 const x=fixture({sessions:()=>[]});let r=(await x.svc.snapshot()).sessions[0];assert.equal(r.status,'Working');
 x.row.card.run_state='blocked';x.row.card.blocked_kind='conflict';r=(await x.svc.snapshot()).sessions[0];assert.equal(r.status,'Blocked');
 x.data.decisions=[{card_id:'card',board_id:'board',member_id:'other',kind:'permission'}];r=(await x.svc.snapshot()).sessions[0];assert.equal(r.status,'Blocked');
 x.data.decisions[0].member_id='member';r=(await x.svc.snapshot()).sessions[0];assert.equal(r.status,'Waiting on you');
 x.data.agents[0].connection='unavailable';r=(await x.svc.snapshot()).sessions[0];assert.equal(r.status,'Connection unavailable');
 x.data.agents[0].connection='accepted';x.row.card.run_state='running';x.data.agents[0].live.green=false;r=(await x.svc.snapshot()).sessions[0];assert.equal(r.status,'No recent activity');
 x.row.card.run_state='invented';r=(await x.svc.snapshot()).sessions[0];assert.equal(r.status,'Unknown');
});

test('Overview actor/principal changes retire bound reported and managed row identity without leaking authority IDs',async()=>{
 for(const reported of [true,false]){
  const x=fixture(reported?{}:{sessions:()=>[]}),before=(await x.svc.snapshot()).sessions[0];
  x.data.principal.user_id='replacement-principal';x.source.userId='replacement-principal';x.row.member_id='replacement-member';x.data.agents[0].member_id='replacement-member';
  const after=(await x.svc.snapshot()).sessions[0];assert.notEqual(after.id,before.id);assert.equal(after.task.title,before.task.title);assert.equal(after.capabilities.message.enabled,true);
  assert.equal((await x.svc.message({handle:before.handle,text:'Old actor draft'})).ok,false);assert(!JSON.stringify(after).includes('replacement-principal'));assert(!JSON.stringify(after).includes('replacement-member'));
 }
});

test('Overview board and managed rows name their bucket; the directory files them without guessing from labels',async()=>{
 const {createSessionDirectory}=require('../src/session-directory');
 const filed=row=>createSessionDirectory({now:()=>time}).mine({work:[row]})[0];
 const x=fixture({sessions:()=>[]});
 const board=async(state,decision=false)=>{x.row.card.run_state=state;x.data.decisions=decision?[{card_id:'card',board_id:'board',member_id:'member',kind:'question'}]:[];return (await x.svc.snapshot()).sessions[0];};
 for(const [state,status,bucket,detail] of [['running','Working','working',undefined],['claimed','Starting','working','Starting'],['handing_over','Moving to another AI','working','Moving to another AI'],['unresponsive','No recent signal','idle','No recent signal'],['failed','Stopped','stuck','Stopped'],['in_review','In review','check','In review'],['blocked','Blocked','stuck','Blocked']]){
  const r=await board(state);assert.equal(r.status,status,state);assert.equal(r.bucket,bucket,state);assert.equal(r.detail,detail,state);
 }
 let r=await board('blocked');const e=filed(r);assert.equal(e.state,'Stuck or failed');assert.equal(e.input,false,'a Blocked card with no decision for this person is not waiting on them');
 r=await board('blocked',true);assert.equal(r.bucket,'needs');assert.equal(filed(r).input,true);
 r=await board('unresponsive');assert.equal(filed(r).state,'Idle');assert.equal(filed(r).detail,'No recent signal');
 const managed=(state,label)=>createOverviewService({now:()=>time,managed:()=>({conn:{status:'connected'},tasks:[{id:'t1',title:'Managed task',ai:{id:'codex'},state,label,green:false,actions:[]}]})}).snapshot().then(s=>s.sessions[0]);
 for(const [state,label,bucket] of [['in_review','Ready to review','check'],['failed','Stopped at cap','stuck'],['claimed','Starting','working'],['handing_over','Moving to another AI','working'],['unresponsive','No signal','idle']]){
  const m=await managed(state,label);assert.equal(m.status,label);assert.equal(m.bucket,bucket,label);assert.equal(m.detail,label);assert.equal(filed(m).state,{check:'Finished — check it',stuck:'Stuck or failed',working:'Working on it',idle:'Idle'}[bucket],label);
 }
});

test('Overview managed tasks waiting on the person are Needs you whatever their run state',async()=>{
 const {createSessionDirectory}=require('../src/session-directory');
 const managed=t=>createOverviewService({now:()=>time,managed:()=>({conn:{status:'connected'},tasks:[{id:'t1',title:'Managed task',ai:{id:'codex'},green:false,actions:[],...t}]})}).snapshot().then(s=>s.sessions[0]);
 for(const t of [{state:'parked',label:'Paused',actions:['answer','resume']},{state:'parked',label:'Paused',parkReason:'limit'},{state:'parked',label:'Paused',parkReason:'auth'},{state:'queued',label:'Queued',awaitingConfirm:true,actions:['approve','deny','stop']},{state:'queued',label:'Queued',awaitingConfirm:true}]){
  const m=await managed(t);assert.equal(m.bucket,'needs',JSON.stringify(t));
  const e=createSessionDirectory({now:()=>time}).mine({work:[m]})[0];assert.equal(e.state,'Needs you');assert.equal(e.input,true);
 }
 assert.equal((await managed({state:'parked',label:'Paused',parkReason:'user'})).bucket,'idle');
 assert.equal((await managed({state:'queued',label:'Queued'})).bucket,'working');
});

test('Overview a run stopped at a usage limit or its budget is Needs you, other failures stay Stuck or failed',async()=>{
 const managed=t=>createOverviewService({now:()=>time,managed:()=>({conn:{status:'connected'},tasks:[{id:'t1',title:'Managed task',ai:{id:'codex'},green:false,actions:[],state:'failed',...t}]})}).snapshot().then(s=>s.sessions[0]);
 for(const [failKind,label,bucket] of [['budget','Stopped at cap','needs'],['limit','Plan limit reached','needs'],['crash','Failed','stuck'],[undefined,'Stopped','stuck']]){
  const m=await managed({failKind,label});assert.equal(m.bucket,bucket,label);assert.equal(m.status,label);
 }
 const x=fixture({sessions:()=>[]});x.row.card.run_state='failed';
 for(const [fail_kind,bucket] of [['limit','needs'],['budget','needs'],['network','stuck'],[undefined,'stuck']]){x.row.card.fail_kind=fail_kind;assert.equal((await x.svc.snapshot()).sessions[0].bucket,bucket,String(fail_kind));}
});

test('Overview the share of a failed run carries its kind, never the reason text (C9)',async()=>{
 const REASON='API Error: 400 No connected db. TOPSECRETDETAIL';
 const snap=await createOverviewService({now:()=>time,managed:()=>({conn:{status:'connected'},tasks:[{id:'t1',title:'Managed task',ai:{id:'claude'},green:false,actions:[],state:'failed',failKind:'provider',failReason:REASON,reason:REASON,label:'Stopped'}]})}).snapshot();
 assert.equal(snap.sessions[0].status,'Stopped');
 assert.ok(!JSON.stringify(snap).includes('TOPSECRETDETAIL'));
});
