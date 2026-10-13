import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communicationRig} from './communication-helpers.js';
import {remoteRig,grant,spareBoard,business} from './remote-helpers.js';
import {RemoteActions} from '../remote/actions.js';
import {readWorkContext,guardWorkContext,WORK_CONTEXT_BYTES} from '../work-context.js';
import {runHb,until} from './helpers.js';
import {TTL_MS} from '../../shared/liveness.js';
import {OWNERSHIP_TTL_MS} from '../ownership.js';
const denied=e=>['UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','CONFLICT'].includes(e.code);
const raw=value=>JSON.stringify(value);
const credential=f=>({kind:'device',id:f.users.amember.device_id});
function sameSessionGrant(f,g,boardIds){const gesture=f.authority.gesture(g.member,g.identity.cred,{purpose:'create'});return f.authority.create(g.member,g.identity.cred,{gesture_id:gesture.gesture_id,name:'Another synthetic read connection',board_ids:boardIds,mode:'read',expires_days:30});}
async function context(f,g,args={}){const out=await f.actions.call(g.token,'integration','plexiform_get_work_context',{board_id:f.A.board,...args});return f.actions.deliver(out);}
function rows(f,n=23){const row=f.h.hub.card(f.A.card);for(let i=0;i<n;i++)f.db.insert('cards',{...row,id:`zz-context-${String(i).padStart(3,'0')}`,key:`CTX-${i+100}`,title:'Bounded task '+i,body:'PRIVATE-NARRATIVE',active_run_id:null,repo_id:f.A.repo});}

test('real enrolled protocols supply observed Codex ownership and overlap, reported capture and next-action refs without narratives or wakeup',async t=>{
  const f=await communicationRig(t);f.h.hub.config.publicUrl=f.h.base;f.authority=f.h.hub.remoteAuthority;f.actions=new RemoteActions(f.h.hub);
  for(const p of[f.sender,f.recipient]){assert.equal((await p.client.rpc(p.run,'board_declare_plan',{paths:['src/shared/**']})).ok,true);await p.client.hb([runHb(p.run,{child_alive:true,cost_usd:null})]);}
  const data={brief:'PRIVATE-CHAT-BRIEF',decisions:['PRIVATE-CHAT-DECISION'],progress:'PRIVATE-CHAT-PROGRESS',nextAction:'PRIVATE-NEXT-ACTION',reportedChecks:[],artifacts:[]};
  const packet=await f.sender.client.rpc(f.sender.run,'board_write_packet',{request_id:randomUUID(),expected_version:0,data});assert.equal(packet.ok,true);
  const report=await f.as(f.users.amember,'POST',`/api/boards/${f.A.board}/work-capture`,{install_id:randomUUID(),provider:'cursor',session_id:'synthetic-session',repo_id:f.A.repo,title:'Reported Cursor task',summary:'PRIVATE-OBSERVED-SUMMARY',status:'working'});assert.equal(report.status,200,report.text);
  const g=await grant(f,{mode:'read'}),before=business(f),view=await context(f,g),task=view.tasks.find(x=>x.card.id===f.sender.run.card_id),reported=view.tasks.find(x=>x.card.id===report.body.card.id);
  assert.equal(view.source,'current_hub_records');assert.equal(view.grants_execution,false);assert.ok(Buffer.byteLength(raw(view))<=WORK_CONTEXT_BYTES);
  assert.equal(task.run.provider,'codex');assert.equal(task.run.identity_source,'hub_run');assert.equal(task.run.observation_source,'host_heartbeat');assert.equal(task.run.fresh,true);
  assert.equal(task.ownership.state,'editing');assert.deepEqual(task.ownership.paths,['src/shared/**']);assert.equal(task.overlaps.length,1);assert.equal(task.overlaps[0].run_id,f.recipient.run.run_id);
  assert.equal(task.next_action.packet_id,packet.result.packet.id);assert.equal(task.next_action.available,true);
  assert.equal(reported.run,null);assert.equal(reported.reported_activity.provider,'cursor');assert.equal(reported.reported_activity.source,'participant_local_observation');assert.equal(reported.reported_activity.participant.member_id,f.A.member);assert.equal(reported.reported_activity.verified_run_identity,false);assert.equal(reported.reported_activity.fresh,true);
  for(const marker of['PRIVATE-CHAT','PRIVATE-NEXT-ACTION','PRIVATE-OBSERVED-SUMMARY','synthetic-session',g.token,'run_token','device_token','receipt_token'])assert.equal(raw(view).includes(marker),false,marker);
  assert.equal(business(f),before);
  f.h.clock.advance(Math.max(TTL_MS,OWNERSHIP_TTL_MS,60000)+1);const stale=await context(f,g),a=stale.tasks.find(x=>x.card.id===task.card.id),b=stale.tasks.find(x=>x.card.id===reported.card.id);
  assert.equal(a.run.fresh,false);assert.equal(a.ownership.state,'planned');assert.equal(b.reported_activity.status,'unknown');assert.equal(b.reported_activity.fresh,false);
});

test('selected boards exclude cross-board overlaps, dependency blockers and foreign-team tasks even for a shared account',async t=>{
  const f=await communicationRig(t);f.h.hub.config.publicUrl=f.h.base;f.authority=f.h.hub.remoteAuthority;f.actions=new RemoteActions(f.h.hub);
  const other=await spareBoard(f),hidden=await f.participant(f.users.s,f.A,{board:other,title:'PRIVATE-UNSELECTED-TITLE'});
  for(const p of[f.sender,hidden])assert.equal((await p.client.rpc(p.run,'board_declare_plan',{paths:['src/shared/**']})).ok,true);
  f.db.insert('card_dependencies',{card_id:f.sender.run.card_id,depends_on_card_id:hidden.run.card_id,created_by:f.A.member,created_at:f.h.hub.iso()});
  const g=await grant(f),view=await context(f,g);for(const marker of[hidden.run.card_id,hidden.run.run_id,'PRIVATE-UNSELECTED-TITLE',f.B.board,f.B.repo])assert.equal(raw(view).includes(marker),false,marker);
  const broad=sameSessionGrant(f,g,[f.A.board,other]),seen=(await context(f,broad)).tasks.find(x=>x.card.id===f.sender.run.card_id);assert.equal(seen.overlaps[0].run_id,hidden.run.run_id);assert.equal(seen.blockers[0].card_id,hidden.run.card_id);
  await assert.rejects(context(f,g,{board_id:other}),denied);await assert.rejects(context(f,g,{repo_id:f.B.repo}),denied);
});

test('current repository changes suppress former run, ownership, observations and sealed next-action context',async t=>{
  const f=await communicationRig(t);f.h.hub.config.publicUrl=f.h.base;f.authority=f.h.hub.remoteAuthority;f.actions=new RemoteActions(f.h.hub);
  assert.equal((await f.sender.client.rpc(f.sender.run,'board_declare_plan',{paths:['src/old-repository.js']})).ok,true);
  assert.equal((await f.sender.client.rpc(f.sender.run,'board_write_packet',{request_id:randomUUID(),expected_version:0,data:{brief:'OLD-CONTEXT',decisions:[],progress:'',nextAction:'OLD-NEXT',artifacts:[],reportedChecks:[]}})).ok,true);
  const repo=randomUUID();f.db.insert('repos',{id:repo,org_id:f.A.team,canonical_url:'github.com/synthetic/new',short_name:'Current repo'});f.db.run('INSERT INTO board_repos(board_id,repo_id) VALUES(?,?)',f.A.board,repo);f.db.run('UPDATE cards SET repo_id=? WHERE id=?',repo,f.sender.run.card_id);
  const g=await grant(f),out=await context(f,g),task=out.tasks.find(x=>x.card.id===f.sender.run.card_id);
  assert.equal(task.repository.id,repo);assert.equal(task.run,null);assert.equal(task.ownership,null);assert.equal(task.next_action,null);assert.equal(raw(task).includes(f.sender.run.run_id),false);assert.equal(raw(task).includes('OLD-'),false);
});

test('actual maximum-length declarations force a bounded partial page and cursor without silently dropping tasks',async t=>{
  const f=await communicationRig(t);f.h.hub.config.publicUrl=f.h.base;f.authority=f.h.hub.remoteAuthority;f.actions=new RemoteActions(f.h.hub);
  const peers=[f.sender,f.recipient,await f.participant(f.users.ua),await f.participant(f.users.s)],paths=Array.from({length:4},(_,i)=>`src/${'a'.repeat(480)}${i}.js`);
  for(const peer of peers)assert.equal((await peer.client.rpc(peer.run,'board_declare_plan',{paths})).ok,true);
  const g=await grant(f,{mode:'read'}),ids=[];let cursor;do{const page=await context(f,g,{limit:20,...(cursor?{cursor}:{})});assert.ok(Buffer.byteLength(raw(page))<=WORK_CONTEXT_BYTES);ids.push(...page.tasks.map(task=>task.card.id));
    if(!cursor){assert.equal(page.status,'partial');assert.ok(page.tasks.length<5);}cursor=page.next_cursor;
  }while(cursor);
  assert.equal(ids.length,5);assert.equal(new Set(ids).size,5);
});

test('current bounded pages cover each card once; cursor is signed, actor/scope/repo/epoch bound, expires, and summaries redact before shortening',async t=>{
  const f=await remoteRig(t),g=await grant(f,{mode:'read'});rows(f);
  f.db.run('UPDATE cards SET title=?,body=? WHERE id=?','x'.repeat(180)+' pfi_'+'a'.repeat(43),'PRIVATE-RAW-BODY',f.A.card);
  const ids=[],pages=[];let after;do{const page=await context(f,g,{limit:3,...(after?{cursor:after}:{})});assert.ok(Buffer.byteLength(raw(page))<=WORK_CONTEXT_BYTES);assert.equal(page.tasks.length<=3,true);pages.push(page);ids.push(...page.tasks.map(x=>x.card.id));after=page.next_cursor;}while(after);
  assert.equal(ids.length,24);assert.equal(new Set(ids).size,24);assert.equal(pages.at(-1).status,'complete');assert.equal(raw(pages).includes('PRIVATE-RAW-BODY'),false);assert.equal(raw(pages).includes('pfi_'+'a'.repeat(43)),false);
  const cursor=pages[0].next_cursor;
  for(const value of[cursor.slice(0,-1)+(cursor.endsWith('a')?'b':'a'),'../outside','x'.repeat(1201)])await assert.rejects(context(f,g,{limit:3,cursor:value}),e=>['CONFLICT','VALIDATION'].includes(e.code));
  await assert.rejects(context(f,g,{repo_id:f.A.repo,cursor}),e=>e.code==='CONFLICT');
  const other=sameSessionGrant(f,g,[f.A.board]);await assert.rejects(context(f,other,{cursor}),e=>e.code==='CONFLICT');
  const spare=await spareBoard(f),wide=sameSessionGrant(f,g,[f.A.board,spare]),first=await context(f,wide,{limit:1});f.db.run('UPDATE remote_grants SET board_ids=? WHERE id=?',JSON.stringify([f.A.board]),wide.grant.id);
  await assert.rejects(context(f,wide,{cursor:first.next_cursor}),e=>e.code==='CONFLICT');
  f.h.clock.advance(600001);await assert.rejects(context(f,g,{cursor}),e=>e.code==='CONFLICT');
});

test('closed context arguments refuse limits, duplicate queries and fabricated delivery capabilities',async t=>{
  const f=await remoteRig(t),g=await grant(f,{mode:'read'}),before=business(f);
  for(const choice of[{limit:0},{limit:21},{limit:1.5},{all_teams:true},{include_chat:true},{run_id:randomUUID()}])await assert.rejects(context(f,g,choice),e=>e.code==='VALIDATION');
  const duplicate=await f.as(f.users.amember,'GET',`/api/boards/${f.A.board}/work-context?limit=1&limit=2`);assert.equal(duplicate.status,400);
  for(const value of[{},JSON.parse('{}')])assert.throws(()=>guardWorkContext(f.h.hub,value),denied);
  assert.equal(business(f),before);
});

for(const change of ['credential','owner-both','member','team','board'])test(`actual queued staff work picture refuses ${change} without leaking earlier tasks`,async t=>{
  const f=await remoteRig(t),hub=f.h.hub,original=hub.withBoard.bind(hub);let release,entered=false;
  const held=original(f.A.board,()=>new Promise(r=>{release=r;}));await new Promise(r=>setImmediate(r));hub.withBoard=(id,fn)=>{if(id===f.A.board)entered=true;return original(id,fn);};
  try{const pending=f.as(f.users.amember,'GET',`/api/boards/${f.A.board}/work-context`);await until(()=>entered);
    if(change==='credential')f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',hub.iso(),f.users.amember.device_id);
    if(change==='owner-both'){f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',f.users.n.id,f.users.amember.device_id);f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);}
    if(change==='member')f.db.run('UPDATE members SET removed_at=? WHERE id=?',hub.iso(),f.A.member);
    if(change==='team')f.db.run('UPDATE orgs SET deleted_at=? WHERE id=?',hub.iso(),f.A.team);
    if(change==='board')f.db.run('UPDATE boards SET archived_at=? WHERE id=?',hub.iso(),f.A.board);
    const before=business(f);release();await held;const r=await pending;assert.ok([401,403,404,409].includes(r.status),r.text);assert.equal(r.body.tasks,undefined);assert.equal(business(f),before);
  }finally{release?.();await held;hub.withBoard=original;}
});

test('staff final delivery is privately single-use and reprojects card/repository/participant changes after await',async t=>{
  const f=await remoteRig(t),member=f.h.hub.member(f.A.member),args={board_id:f.A.board},view=await readWorkContext(f.h.hub,member,credential(f),[f.A.board],args);
  f.db.run('UPDATE cards SET title=? WHERE id=?','Current delivery title',f.A.card);view.old_extra='OLD-PRIVATE-DATA';guardWorkContext(f.h.hub,view);assert.equal(view.tasks[0].card.title,'Current delivery title');assert.equal(view.old_extra,undefined);assert.throws(()=>guardWorkContext(f.h.hub,view),denied);
  const second=await readWorkContext(f.h.hub,member,credential(f),[f.A.board],args);f.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?',f.A.board,f.A.repo);guardWorkContext(f.h.hub,second);assert.equal(second.tasks.length,0);
  const third=await readWorkContext(f.h.hub,member,credential(f),[f.A.board],args);f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',f.h.hub.iso(),f.users.amember.device_id);assert.throws(()=>guardWorkContext(f.h.hub,third),denied);
});

test('actual staff HTTP final response refuses a credential revoked after its queued result resolves',async t=>{
  const f=await remoteRig(t),hub=f.h.hub,original=hub.withBoard.bind(hub);let changed=false;
  hub.withBoard=(id,fn)=>original(id,fn).then(result=>{if(id===f.A.board&&!changed){changed=true;f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',hub.iso(),f.users.amember.device_id);}return result;});t.after(()=>{hub.withBoard=original;});
  const r=await f.as(f.users.amember,'GET',`/api/boards/${f.A.board}/work-context`);assert.equal(changed,true);assert.equal(r.status,401);assert.equal(r.body.tasks,undefined);
});
