import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {tenancy} from './tenancy/fixture.js';
import {until} from './helpers.js';
import {WorkflowExecutions} from '../workflow-executions.js';
import {validatePreview,WORKFLOW_PLAN_LIMITS} from '../../shared/workflow-execution.js';
import {PLAN_APPROVAL_LABEL} from '../../shared/states.js';
import {communicationRig} from './communication-helpers.js';

async function rig(t,base=null){
 const f=base??await tenancy();if(!base)t.after(()=>f.h.close());
 const definition={name:'Delivery',description:'A bounded reviewed plan',steps:[
  {title:'PRIVATE-PREVIEW-TASK',body:'PRIVATE-PREVIEW-BRIEF',acceptance:'Human reviews',plan_approval:true},
  {title:'Verify',body:'Report actual checks',acceptance:'Human approves',plan_approval:false}]};
 const created=await f.as(f.users.amember,'POST','/api/workflows',{request_id:randomUUID(),definition});assert.equal(created.status,200,created.text);
 const recipe=created.body.workflow;
 const applied=await f.as(f.users.amember,'POST',`/api/boards/${f.A.board}/workflows/${recipe.id}/apply`,{request_id:randomUUID(),version:recipe.version,content_hash:recipe.content_hash});assert.equal(applied.status,200,applied.text);
 f.instance=applied.body.instance.id;
 for(const step of applied.body.instance.steps){const row=f.h.hub.card(step.id);const patched=await f.as(f.users.amember,'PATCH',`/api/cards/${step.id}`,{request_id:randomUUID(),version:row.version,repo_id:f.A.repo});assert.equal(patched.status,200,patched.text);}
 f.input={request_id:randomUUID(),board_id:f.A.board,repo_id:f.A.repo,recipe_version:recipe.version,content_hash:recipe.content_hash,concurrency:1,
  steps:applied.body.instance.steps.map((step,position)=>{const row=f.h.hub.card(step.id);return {position,card_id:row.id,version:row.version,fence:row.fence,ai:'codex',target_member_id:f.A.member,budget_usd:null,plan_approval:f.h.hub.labels(row).includes(PLAN_APPROVAL_LABEL)};})};
 f.path=`/api/workflow-instances/${f.instance}/preview`;
 f.service=new WorkflowExecutions(f.h.app.api);f.actor=f.h.hub.member(f.A.member);f.cred={kind:'device',id:f.users.amember.device_id};
 f.preview=body=>f.as(f.users.amember,'POST',f.path,body??f.input);
 return f;
}
const business=f=>JSON.stringify(['cards','dispatches','runs','permission_requests','asks','journal','events','workflow_recipes','workflow_versions','workflow_instances','workflow_step_cards'].map(table=>f.db.all(`SELECT * FROM ${table} ORDER BY rowid`)));
const plans=f=>JSON.stringify(['workflow_execution_plans','workflow_execution_plan_steps'].map(table=>f.db.all(`SELECT * FROM ${table} ORDER BY rowid`)));
async function queue(f,call,change){
 const original=f.h.hub.withBoard.bind(f.h.hub);let release,entered=false;
 const held=original(f.A.board,()=>new Promise(resolve=>release=resolve));await new Promise(resolve=>setImmediate(resolve));
 f.h.hub.withBoard=(id,fn)=>{if(id===f.A.board)entered=true;return original(id,fn);};
 try{const pending=call();await until(()=>entered);change();const before=business(f),saved=plans(f);release();await held;const result=await pending;
  assert.equal(business(f),before);assert.equal(plans(f),saved);return result;
 }finally{release?.();await held;f.h.hub.withBoard=original;}
}

test('explicit human preview saves one immutable inert plan atomically, exact replay keeps hash/expiry and creates no business effects',async t=>{
 const f=await rig(t),before=business(f);const first=await f.preview();assert.equal(first.status,200,first.text);
 const plan=first.body.plan;assert.equal(plan.grants_execution,false);assert.equal(plan.execution_enabled,false);assert.equal(plan.authorization,null);
 assert.equal(plan.requires_fresh_human_start,true);assert.equal(plan.steps.length,2);assert.deepEqual(plan.dependencies,[[0,1]]);
 assert.equal(plan.state,'blocked');assert.ok(plan.steps.every(step=>step.blocked_reasons.includes('RUNNER_READINESS_UNCONFIRMED')));
 assert.equal(plan.steps[0].monetary_telemetry,'unavailable');assert.equal(plan.steps[0].plan_approval,true);
 assert.equal(first.headers.get('board-replayed'),null);assert.equal(business(f),before);
 const saved=plans(f);f.h.clock.advance(2000);const replay=await f.preview();assert.equal(replay.status,200,replay.text);
 assert.equal(replay.body.plan.id,plan.id);assert.equal(replay.body.plan.hash,plan.hash);assert.equal(replay.body.plan.valid_until,plan.valid_until);assert.ok(replay.body.plan.remaining_ms<plan.remaining_ms);
 assert.equal(plans(f),saved);assert.equal(business(f),before);
 const read=await f.as(f.users.aviewer,'GET',`/api/workflow-plans/${plan.id}`);assert.equal(read.status,200,read.text);
 const raw=f.db.get('SELECT * FROM workflow_execution_plans WHERE id=?',plan.id);
 for(const value of [f.cred.id,f.users.amember.token,'PRIVATE-PREVIEW-BRIEF',raw.snapshot])assert.equal(read.text.includes(value),false);
 assert.equal(f.service.start,undefined);assert.equal(f.service.cancel,undefined);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_plans').n,1);
 assert.equal((await f.as(f.users.amember,'POST',`/api/workflow-plans/${plan.id}/start`,{})).status,404);
});

test('new preview request body is closed, acyclic, same-instance and explicitly provider/budget/plan bound before persistence',async t=>{
 const f=await rig(t),saved=plans(f),before=business(f);
 const copy=()=>structuredClone(f.input);
 const bodies=[{...copy(),start:true},{...copy(),issuer_member_id:f.A.owner},{...copy(),credential:f.cred},{...copy(),dependencies:[[0,0]]},
  {...copy(),dependencies:[[0,1],[1,0]]},{...copy(),dependencies:[[0,2]]},{...copy(),dependencies:[[0,1],[0,1]]},{...copy(),concurrency:3},
  {...copy(),steps:[]},{...copy(),dependencies:null},{...copy(),steps:copy().steps.map(step=>({...step,command:'run'}))}];
 for(const body of bodies){const result=await f.preview(body);assert.equal(result.status,400,result.text);}
 const foreign=copy();foreign.steps[0].card_id=f.B.card;assert.equal((await f.preview(foreign)).status,409);
 const moved=copy();moved.repo_id=f.B.repo;assert.equal((await f.preview(moved)).status,404);
 const cap=copy();cap.steps[0].budget_usd=1;assert.equal((await f.preview(cap)).status,403);
 const uncapped=copy();uncapped.steps[0].target_member_id=f.A.admin;assert.equal((await f.preview(uncapped)).status,403);
 const removePlan=copy();removePlan.steps[0].plan_approval=false;assert.equal((await f.preview(removePlan)).status,409);
 assert.equal(plans(f),saved);assert.equal(business(f),before);
});

test('closed schema supports eight steps and28 DAG edges without accepting a cycle, duplicate card, numeric overflow or foreign metadata',()=>{
 const make=()=>({request_id:randomUUID(),board_id:randomUUID(),repo_id:randomUUID(),recipe_version:1,content_hash:'a'.repeat(64),concurrency:2,
  steps:Array.from({length:8},(_,position)=>({position,card_id:randomUUID(),version:0,fence:0,ai:'claude',target_member_id:randomUUID(),budget_usd:1,plan_approval:true})),dependencies:Array.from({length:8},(_,from)=>Array.from({length:7-from},(_,index)=>[from,from+index+1])).flat()});
 const body=make();assert.equal(validatePreview(body).dependencies.length,28);
 for(const change of [b=>b.steps.push({...b.steps[0],position:8,card_id:randomUUID()}),b=>b.steps[1].card_id=b.steps[0].card_id,b=>b.steps[0].fence=Number.MAX_SAFE_INTEGER+1,
  b=>b.dependencies.push([7,0]),b=>b.steps[0].budget_usd=Infinity,b=>b.content_hash='A'.repeat(64)]){const b=make();change(b);assert.throws(()=>validatePreview(b),error=>error.code==='VALIDATION');}
});

test('payload-bound preview retry refuses changed graph, concurrency and choice without another row',async t=>{
 const f=await rig(t);assert.equal((await f.preview()).status,200);const saved=plans(f),before=business(f);
 for(const change of [body=>body.dependencies=[],body=>body.concurrency=2,body=>body.steps[0].ai='claude']){const body=structuredClone(f.input);change(body);assert.equal((await f.preview(body)).status,409);}
 assert.equal(plans(f),saved);assert.equal(business(f),before);
});

test('queued explicit target identity cannot inherit a replacement member owner while waiting',async t=>{
 const f=await rig(t);for(const choice of f.input.steps){choice.ai='claude';choice.budget_usd=1;choice.target_member_id=f.A.admin;}
 const result=await queue(f,()=>f.preview(),()=>f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.admin));
 assert.equal(result.status,409,result.text);assert.equal(result.body.plan,undefined);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_plans').n,0);
});

test('same repository ID cannot retarget a saved source plan without fresh preview',async t=>{
 const f=await rig(t),made=await f.preview();assert.equal(made.status,200,made.text);const saved=plans(f);
 f.db.run('UPDATE repos SET canonical_url=? WHERE id=?','github.com/shared/changed-project',f.A.repo);
 const result=await f.as(f.users.amember,'GET',`/api/workflow-plans/${made.body.plan.id}`);assert.equal(result.status,409,result.text);assert.equal(result.body.plan,undefined);
 assert.equal(plans(f),saved);
});

for(const dimension of ['credential-revoke','member-remove','member-owner','credential-owner','both-owner','role','team-delete','repo-unlink','card-move','card-version','card-fence','recipe-archive','plan-label'])test(`queued preview refuses current ${dimension} change without a plan or business effect`,async t=>{
 const f=await rig(t);
 if(dimension==='card-move'){const made=await f.as(f.users.ua,'POST',`/api/teams/${f.A.team}/boards`,{name:'Moved task'});assert.equal(made.status,200,made.text);f.moveBoard=made.body.board.id;}
 const result=await queue(f,()=>f.preview(),()=>{
  const now=f.h.hub.iso(),card=f.input.steps[0].card_id;
  if(dimension==='credential-revoke')f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',now,f.cred.id);
  if(dimension==='member-remove')f.db.run('UPDATE members SET removed_at=? WHERE id=?',now,f.A.member);
  if(['member-owner','both-owner'].includes(dimension))f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);
  if(['credential-owner','both-owner'].includes(dimension))f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',f.users.n.id,f.cred.id);
  if(dimension==='role')f.db.run("UPDATE members SET role='viewer' WHERE id=?",f.A.member);
  if(dimension==='team-delete')f.db.run('UPDATE orgs SET deleted_at=? WHERE id=?',now,f.A.team);
  if(dimension==='repo-unlink')f.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?',f.A.board,f.A.repo);
  if(dimension==='card-move')f.db.run('UPDATE cards SET board_id=? WHERE id=?',f.moveBoard,card);
  if(dimension==='card-version')f.db.run('UPDATE cards SET version=version+1 WHERE id=?',card);
  if(dimension==='card-fence')f.db.run('UPDATE cards SET fence=fence+1 WHERE id=?',card);
  if(dimension==='recipe-archive')f.db.run('UPDATE workflow_recipes SET archived_at=? WHERE id=?',now,f.db.get('SELECT recipe_id FROM workflow_instances WHERE id=?',f.instance).recipe_id);
  if(dimension==='plan-label')f.db.run("UPDATE cards SET labels='[]' WHERE id=?",card);
 });
 assert.ok([401,403,404,409].includes(result.status),result.text);assert.equal(result.text.includes('PRIVATE-PREVIEW'),false);
 assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_plans').n,0);
});

test('two concurrent exact previews commit one plan and immutable step table, injected second-step failure rolls back both tables',async t=>{
 const f=await rig(t);const both=await Promise.all([f.preview(),f.preview()]);assert.ok(both.every(result=>result.status===200));assert.equal(both[0].body.plan.id,both[1].body.plan.id);
 const saved=plans(f),before=business(f),insert=f.db.insert.bind(f.db);let steps=0;
 f.db.insert=(table,row)=>{if(table==='workflow_execution_plan_steps' && ++steps===2)throw Error('synthetic failed plan storage');return insert(table,row);};
 t.after(()=>f.db.insert=insert);const result=await f.preview({...f.input,request_id:randomUUID()});assert.equal(result.status,500,result.text);
 assert.equal(plans(f),saved);assert.equal(business(f),before);
 const row=f.db.get('SELECT * FROM workflow_execution_plans');assert.throws(()=>f.db.run('UPDATE workflow_execution_plans SET expires_ms=expires_ms+1 WHERE id=?',row.id),/immutable/);
 assert.throws(()=>f.db.run('UPDATE workflow_execution_plan_steps SET target_member_id=? WHERE plan_id=?',f.A.owner,row.id),/immutable/);
});

test('expiry and new hub epoch are inert states; exact replay never revives validity or creates a dispatch',async t=>{
 const f=await rig(t),made=await f.preview();assert.equal(made.status,200,made.text);const saved=plans(f),id=made.body.plan.id;
 f.h.hub.boot();const restarted=await f.as(f.users.amember,'GET',`/api/workflow-plans/${id}`);assert.equal(restarted.status,200,restarted.text);assert.equal(restarted.body.plan.state,'paused_reboot');
 f.h.clock.advance(WORKFLOW_PLAN_LIMITS.lifetimeMs+1);const expired=await f.preview();assert.equal(expired.status,200,expired.text);assert.equal(expired.body.plan.state,'expired');assert.equal(expired.body.plan.remaining_ms,0);
 assert.equal(expired.body.plan.valid_until,made.body.plan.valid_until);assert.equal(plans(f),saved);assert.equal(f.db.get('SELECT count(*) n FROM dispatches WHERE card_id IN (?,?)',...f.input.steps.map(step=>step.card_id)).n,0);
});

test('wall-clock rollback is sticky and cannot refresh preview expiry even after clock catches up',async t=>{
 const f=await rig(t),made=await f.preview();assert.equal(made.status,200,made.text);const saved=plans(f);
 f.h.clock.advanceWallOnly(-1);const read=await f.as(f.users.amember,'GET',`/api/workflow-plans/${made.body.plan.id}`);assert.equal(read.status,200,read.text);assert.equal(read.body.plan.state,'paused_clock');
 f.h.clock.advanceWallOnly(1000);assert.equal((await f.preview({...f.input,request_id:randomUUID()})).status,409);
 assert.equal(plans(f),saved);
});

test('final HTTP delivery withholds a committed preview after issuer revocation, without pretending cross-await rollback',async t=>{
 const f=await rig(t),original=WorkflowExecutions.prototype.preview;let changed=false;
 WorkflowExecutions.prototype.preview=async function(...args){const out=await original.apply(this,args);if(!changed){changed=true;f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',f.h.hub.iso(),f.cred.id);}return out;};
 t.after(()=>WorkflowExecutions.prototype.preview=original);
 const before=business(f),result=await f.preview();assert.equal(result.status,401,result.text);assert.equal(result.body.plan,undefined);assert.equal(result.text.includes('PRIVATE-PREVIEW'),false);
 assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_plans').n,1);assert.equal(business(f),before);
});

test('fresh reads and synchronous delivery reject replaced source/reader identity and cannot be forged or reused',async t=>{
 const f=await rig(t),made=await f.preview();assert.equal(made.status,200,made.text);const id=made.body.plan.id;
 const out=await f.service.read(f.actor,id,f.cred);assert.throws(()=>f.service.guard(structuredClone(out)),error=>error.code==='FORBIDDEN');f.service.guard(out);assert.throws(()=>f.service.guard(out),error=>error.code==='FORBIDDEN');
 const pending=await f.service.read(f.actor,id,f.cred);f.db.run('UPDATE cards SET body=? WHERE id=?','UNVERSIONED-PRIVATE-EDIT',f.input.steps[0].card_id);
 assert.throws(()=>f.service.guard(pending),error=>error.code==='CONFLICT');const stale=await f.as(f.users.amember,'GET',`/api/workflow-plans/${id}`);assert.equal(stale.status,409,stale.text);assert.equal(stale.text.includes('UNVERSIONED'),false);
});

for(const dimension of ['reader-removed','reader-both-owner','repository-unlinked','issuer-rebound'])test(`actual final GET withholds preview after ${dimension} change`,async t=>{
 const f=await rig(t),made=await f.preview();assert.equal(made.status,200,made.text);
 const original=WorkflowExecutions.prototype.read;let changed=false;
 WorkflowExecutions.prototype.read=async function(...args){const out=await original.apply(this,args);if(!changed){changed=true;
  if(dimension==='reader-removed')f.db.run('UPDATE members SET removed_at=? WHERE id=?',f.h.hub.iso(),f.A.viewer);
  if(dimension==='reader-both-owner'){f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.viewer);f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',f.users.n.id,f.users.aviewer.device_id);}
  if(dimension==='repository-unlinked')f.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?',f.A.board,f.A.repo);
  if(dimension==='issuer-rebound')f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);
 }return out;};t.after(()=>WorkflowExecutions.prototype.read=original);
 const result=await f.as(f.users.aviewer,'GET',`/api/workflow-plans/${made.body.plan.id}`);
 assert.ok([401,403,404,409].includes(result.status),result.text);assert.equal(result.body.plan,undefined);assert.equal(result.text.includes('PRIVATE-PREVIEW'),false);
});

test('selected-board and foreign team routes refuse private plan/task refs; viewers cannot persist a preview',async t=>{
 const f=await rig(t),made=await f.preview();assert.equal(made.status,200,made.text);const id=made.body.plan.id;
 for(const path of [`/api/workflow-plans/${id}?board_id=${f.B.board}`,`/api/workflow-plans/${id}?board_id=${f.A.board}&board_id=${f.B.board}`,`/api/workflow-plans/${id}?board_id=${f.A.board}&board_id=${f.A.board}`]){const read=await f.as(f.users.amember,'GET',path);assert.equal(read.status,404,read.text);assert.equal(read.text.includes('PRIVATE-PREVIEW'),false);}
 assert.equal((await f.as(f.users.ub,'GET',`/api/workflow-plans/${id}`)).status,404);
 assert.equal((await f.as(f.users.bguest,'GET',`/api/workflow-plans/${id}`)).status,404);
 assert.equal((await f.as(f.users.aviewer,'POST',f.path,{...f.input,request_id:randomUUID()})).status,403);
 assert.equal((await f.as(f.users.amember,'GET',`/api/workflow-plans/${id}?credential=other`)).status,400);
});

test('SQL snapshot bounds/provenance and actual account/team erasure remove inert refs without deleting task history',async t=>{
 const f=await rig(t),made=await f.preview();assert.equal(made.status,200,made.text);const row=f.db.get('SELECT * FROM workflow_execution_plans'),newRow=()=>({...row,id:randomUUID(),request_id:randomUUID()});
 for(const change of [r=>r.snapshot='{}',r=>r.snapshot=JSON.stringify({grants_execution:true}),r=>r.snapshot='x'.repeat(32769),r=>r.expires_ms=r.created_ms+86400001,r=>r.issuer_user_id=f.users.ub.id,r=>r.board_id=f.B.board]){const next=newRow();change(next);assert.throws(()=>f.db.insert('workflow_execution_plans',next));}
 const cards=f.db.all('SELECT * FROM cards ORDER BY rowid');f.h.hub.accounts.eraseUser(f.h.hub.accounts.liveUser(f.users.amember.id));
 assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_plans').n,0);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_plan_steps').n,0);assert.deepEqual(f.db.all('SELECT * FROM cards ORDER BY rowid'),cards);
 const other=await rig(t);assert.equal((await other.preview()).status,200);other.h.hub.teams.deleteTeam(other.db.get('SELECT * FROM orgs WHERE id=?',other.A.team));
 assert.equal(other.db.get('SELECT count(*) n FROM workflow_execution_plans').n,0);assert.equal(other.db.get('SELECT count(*) n FROM workflow_execution_plan_steps').n,0);
});

test('actual enrolled runner readiness is current observation only and final projection removes a revoked or replaced provider report',async t=>{
 const f=await rig(t,await communicationRig(t)),made=await f.preview();assert.equal(made.status,200,made.text);assert.equal(made.body.plan.state,'preview');
 assert.ok(made.body.plan.steps.every(step=>step.blocked_reasons.length===0));assert.equal(made.body.plan.grants_execution,false);
 const bound=await f.service.read(f.actor,made.body.plan.id,f.cred),connection=f.sender.connection();
 f.db.run('UPDATE runner_enrollments SET revoked_at=? WHERE id=?',f.h.hub.iso(),f.sender.enrollment);f.service.guard(bound);
 assert.ok(bound.plan.steps.every(step=>step.blocked_reasons.includes('RUNNER_READINESS_UNCONFIRMED')));
 assert.equal(JSON.stringify(bound).includes(connection.device_id),false);assert.equal(JSON.stringify(bound).includes(connection.enrollmentId),false);
 assert.equal(bound.plan.grants_execution,false);
});

test('preview snapshots exclude task narratives and refuse secret-shaped base metadata; durable team quota is enforced without side effects',async t=>{
 const f=await rig(t),made=await f.preview();assert.equal(made.status,200,made.text);
 const row=f.db.get('SELECT * FROM workflow_execution_plans');assert.equal(row.snapshot.includes('PRIVATE-PREVIEW'),false);
 const card=f.input.steps[0].card_id;f.db.run('UPDATE cards SET base_ref=? WHERE id=?','ghp_'+('aB9cD0'.repeat(7)),card);
 assert.equal((await f.preview({...f.input,request_id:randomUUID()})).status,400);f.db.run('UPDATE cards SET base_ref=NULL WHERE id=?',card);
 f.db.tx(()=>{for(let index=1;index<WORKFLOW_PLAN_LIMITS.plans;index++)f.db.insert('workflow_execution_plans',{...row,id:randomUUID(),request_id:randomUUID()});});
 const before=business(f),count=f.db.get('SELECT count(*) n FROM workflow_execution_plans').n;
 const full=await f.preview({...f.input,request_id:randomUUID()});assert.equal(full.status,403,full.text);assert.equal(full.body.error.code,'QUOTA_EXCEEDED');
 assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_plans').n,count);assert.equal(business(f),before);
});

test('actual browser session preview requires current CSRF and strict JSON before storing a plan',async t=>{
 const f=await rig(t),web=await f.h.webSignIn(f.users.amember.email);assert.equal(web.res.status,200,web.res.text);
 const headers={origin:f.h.base};const missingCsrf=await f.h.call('POST',f.path,{cookie:web.cookie,body:f.input,headers});assert.equal(missingCsrf.status,403,missingCsrf.text);
 const correct=await f.h.call('POST',f.path,{cookie:web.cookie,body:f.input,headers:{...headers,'x-csrf-token':web.csrf}});assert.equal(correct.status,200,correct.text);
 const raw=JSON.stringify({...f.input,request_id:randomUUID()}).replace('"concurrency":1','"concurrency":1,"concurrency":2');
 const result=await fetch(f.h.base+f.path,{method:'POST',headers:{'content-type':'application/json',origin:f.h.base,cookie:web.cookie,'x-csrf-token':web.csrf},body:raw});assert.equal(result.status,400);
 assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_plans').n,1);
 assert.throws(()=>f.service.principal(f.actor,null,true),error=>error.code==='UNAUTHENTICATED');
 assert.throws(()=>f.h.hub.viaScope.run({member_id:f.A.member,connection_id:randomUUID()},()=>f.service.principal(f.actor,f.cred,true)),error=>error.code==='UNAUTHENTICATED');
});
