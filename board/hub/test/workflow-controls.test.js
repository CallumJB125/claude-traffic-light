import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {tenancy} from './tenancy/fixture.js';
import {until} from './helpers.js';
import {WorkflowExecutor} from '../workflow-executor.js';
import {canonical} from '../../shared/workflow-execution.js';
import {validateExecutionPreview,validateControlPreview,validateCommand,declaredPaths} from '../../shared/workflow-execution-controls.js';
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
async function rig(t,{concurrency=1}={}){
 const f=await tenancy();t.after(()=>f.h.close());
 const definition={name:'Delivery',description:'Bounded',steps:[{title:'Alpha implementation',body:'PRIVATE-EXEC-BRIEF',acceptance:'Human review',plan_approval:true},{title:'Verify',body:'PRIVATE-EXEC-VERIFY',acceptance:'Human review',plan_approval:true}]};
 const recipe=(await f.as(f.users.amember,'POST','/api/workflows',{request_id:randomUUID(),definition})).body.workflow;
 const applied=await f.as(f.users.amember,'POST',`/api/boards/${f.A.board}/workflows/${recipe.id}/apply`,{request_id:randomUUID(),version:recipe.version,content_hash:recipe.content_hash});assert.equal(applied.status,200,applied.text);f.instance=applied.body.instance.id;
 for(const step of applied.body.instance.steps){const c=f.h.hub.card(step.id);assert.equal((await f.as(f.users.amember,'PATCH',`/api/cards/${c.id}`,{request_id:randomUUID(),version:c.version,repo_id:f.A.repo})).status,200);}
 f.options={request_id:randomUUID(),board_id:f.A.board,repo_id:f.A.repo,recipe_version:recipe.version,content_hash:recipe.content_hash,concurrency,
  steps:applied.body.instance.steps.map((s,position)=>{const c=f.h.hub.card(s.id);return {position,card_id:c.id,version:c.version,fence:c.fence,ai:'codex',target_member_id:f.A.member,budget_usd:null,plan_approval:true};})};
 const plan=await f.as(f.users.amember,'POST',`/api/workflow-instances/${f.instance}/preview`,f.options);assert.equal(plan.status,200,plan.text);f.plan=plan.body.plan;
 f.input={request_id:randomUUID(),plan_hash:f.plan.hash,purpose:'start',declared_paths:[{position:0,paths:['src/**']},{position:1,paths:['test/**']}]};
 f.path=`/api/workflow-plans/${f.plan.id}/execution-preview`;
 f.preview=b=>f.as(f.users.amember,'POST',f.path,b??f.input);f.actor=f.h.hub.member(f.A.member);f.cred={kind:'device',id:f.users.amember.device_id};f.service=new WorkflowExecutor(f.h.app.api);return f;
}
const business=f=>JSON.stringify(['cards','runs','dispatches','permission_requests','asks','journal','events','workflow_instances'].map(t=>f.db.all(`SELECT * FROM ${t} ORDER BY rowid`)));
const saved=f=>JSON.stringify(['workflow_control_previews','workflow_control_preview_steps'].map(t=>f.db.all(`SELECT * FROM ${t} ORDER BY rowid`)));
function seedExecution(f,preview){
 const p=f.db.get('SELECT * FROM workflow_execution_plans WHERE id=?',f.plan.id),s=JSON.parse(p.snapshot),snapshot={schema:1,content_hash:s.options.content_hash,repository_hmac:s.repository_hmac,dependencies:s.options.dependencies,card_ids:s.steps.map(c=>c.card_id)},id=randomUUID();
 f.db.insert('workflow_executions',{id,org_id:f.A.team,instance_id:f.instance,board_id:f.A.board,repo_id:f.A.repo,source_plan_id:f.plan.id,source_hash:digest(snapshot),revision:0,state:'planned',created_epoch:f.h.hub.epoch,created_ms:f.h.hub.wallMs(),snapshot:canonical(snapshot)});
 for(const c of s.steps)f.db.insert('workflow_execution_steps',{execution_id:id,position:c.position,card_id:c.card_id,source_hash:digest(c),version:c.version,fence:c.fence,state:'pending'});
 if(preview){const cp=f.db.get('SELECT * FROM workflow_control_previews WHERE id=?',preview.id);f.db.insert('workflow_execution_authorizations',{execution_id:id,revision:0,preview_id:cp.id,issuer_member_id:f.A.member,issuer_user_id:f.users.amember.id,credential_kind:'device',credential_id:f.cred.id,created_epoch:cp.created_epoch,created_ms:cp.created_ms,expires_ms:cp.expires_ms,snapshot:'{}',snapshot_hash:digest({})});}
 return id;
}
function seedMarker(f,executionId){
 const request_id=randomUUID(),card_id=f.options.steps[0].card_id;
 f.db.insert('dispatches',{request_id,card_id,dispatched_by:f.A.member,target_member_id:f.A.member,backend:'codex_cli',ai:'codex',budget_mode:'none',budget_cents:null,needs_confirm:0,seed:'{}',state:'pending',created_at:f.h.hub.iso()});
 f.db.run("UPDATE workflow_executions SET state='authorized' WHERE id=?",executionId); // trusted synthetic future-lineage fixture only
 f.db.insert('workflow_owned_intents',{request_id,execution_id:executionId,card_id,disabled:0});return request_id;
}

test('actual HTTP path review saves a separate immutable inert snapshot; exact retry and viewer read retain hashes/expiry without business effects',async t=>{
 const f=await rig(t),before=business(f),made=await f.preview();assert.equal(made.status,200,made.text);const p=made.body.execution_preview;
 assert.equal(p.grants_execution,false);assert.equal(p.execution_enabled,false);assert.equal(p.authorization,null);assert.equal(p.path_intent_hash,digest(f.input.declared_paths));assert.equal(p.source_plan_hash,f.plan.hash);
 assert.equal(p.state,'inert');assert.ok(p.blocked_reasons.includes('BASE_REVIEW_REQUIRED'));assert.equal(p.base_review.automatic_source_transfer,false);
 const rows=saved(f);f.h.clock.advance(100);const retry=await f.preview();assert.equal(retry.status,200,retry.text);assert.equal(retry.body.execution_preview.id,p.id);assert.equal(retry.body.execution_preview.hash,p.hash);assert.equal(retry.body.execution_preview.valid_until,p.valid_until);assert.equal(saved(f),rows);assert.equal(business(f),before);
 const read=await f.as(f.users.aviewer,'GET',`/api/workflow-execution-previews/${p.id}`);assert.equal(read.status,200,read.text);
 for(const text of [f.cred.id,f.users.amember.token,'PRIVATE-EXEC-BRIEF','PRIVATE-EXEC-VERIFY'])assert.equal(read.text.includes(text),false);
 assert.equal((await f.as(f.users.amember,'POST',`/api/workflow-plans/${f.plan.id}/start`,{})).status,400,'an inert preview cannot supply the closed triple-hash confirmation');
 for(const path of [`/api/workflow-executions/${randomUUID()}/resume`,`/api/workflow-executions/${randomUUID()}/cancel`])assert.equal((await f.as(f.users.amember,'POST',path,{})).status,404);
 assert.equal(business(f),before,'preview reads and refused commands never grant or launch');
});

test('new control shapes enforce triple Start hashes, canonical bounded paths and fixed closed command names',()=>{
 const start={request_id:randomUUID(),plan_hash:'a'.repeat(64),execution_preview_id:randomUUID(),execution_preview_hash:'b'.repeat(64),path_intent_hash:'c'.repeat(64),expected_revision:0,confirm:true};assert.deepEqual(validateCommand('start',start),start);
 for(const edit of [b=>delete b.path_intent_hash,b=>b.execution_preview_hash='A'.repeat(64),b=>b.confirm=false,b=>b.expected_revision=1,b=>b.credential='pwn',b=>b.ai='claude']){const b={...start};edit(b);assert.throws(()=>validateCommand('start',b));}
 assert.throws(()=>validateCommand('shell',{request_id:randomUUID(),expected_revision:0}));
 const resume={...start};delete resume.plan_hash;assert.equal(validateCommand('resume',resume).confirm,true);
 assert.equal(validateCommand('retry',{...resume,previous_attempt_id:randomUUID()}).confirm,true);assert.throws(()=>validateCommand('retry',resume));
 assert.deepEqual(declaredPaths([{position:0,paths:['test/z','src\\a']}]),[{position:0,paths:['src/a','test/z']}]);
 for(const path of ['/tmp/a','../a','~/.config','.env','a/.git/config','a/*/b','a?b','a//b','a/.','a;command','x'.repeat(201)])assert.throws(()=>declaredPaths([{position:0,paths:[path]}]));
 assert.throws(()=>declaredPaths([{position:0,paths:['src/a','src\\a']} ]));assert.throws(()=>declaredPaths([{position:0,paths:Array.from({length:17},(_,i)=>`src/${i}`)}]));
 assert.equal(validateExecutionPreview({request_id:randomUUID(),plan_hash:'a'.repeat(64),purpose:'start',declared_paths:[{position:0,paths:[]}]}).purpose,'start');
 assert.throws(()=>validateControlPreview({request_id:randomUUID(),source_plan_id:randomUUID(),plan_hash:'a'.repeat(64),purpose:'retry',expected_revision:0,declared_paths:[{position:0,paths:[]}]}));
});

test('requested two has visible missing-path/overlap blockers; current unknown scope stays unknown and unrelated board data is absent',async t=>{
 const f=await rig(t,{concurrency:2}),empty={...f.input,declared_paths:f.input.declared_paths.map(s=>({...s,paths:[]}))};
 const made=await f.preview(empty);assert.equal(made.status,200,made.text);assert.equal(made.body.execution_preview.concurrency,2);assert.ok(made.body.execution_preview.blocked_reasons.includes('PARALLEL_PLAN_REQUIRED'));
 const overlap=await f.preview({...f.input,request_id:randomUUID(),declared_paths:[{position:0,paths:['src/**']},{position:1,paths:['src/a']}]});assert.equal(overlap.status,200);assert.ok(overlap.body.execution_preview.blocked_reasons.includes('DECLARED_PATH_OVERLAP'));
 assert.equal(overlap.text.includes('B-SECRET'),false);assert.equal(overlap.body.execution_preview.blocked_reasons.includes('PARALLEL_SCOPE_UNKNOWN'),false,'the other board active run is excluded before bounds');
 f.db.run('UPDATE cards SET active_run_id=? WHERE id=?',f.B.run,f.options.steps[0].card_id);
 const current=await f.as(f.users.amember,'GET',`/api/workflow-execution-previews/${overlap.body.execution_preview.id}`);assert.equal(current.status,200,current.text);assert.ok(current.body.execution_preview.blocked_reasons.includes('PARALLEL_SCOPE_UNKNOWN'));assert.equal(current.text.includes(f.B.run),false);
});

test('payload changes, malformed paths, wrong source hash/step count and huge encoded bodies refuse without new snapshots or business effects',async t=>{
 const f=await rig(t);assert.equal((await f.preview()).status,200);const before=business(f),rows=saved(f);
 const wrong=await f.preview({...f.input,declared_paths:[{position:0,paths:['other/**']},{position:1,paths:[]}]});assert.equal(wrong.status,409);
 for(const body of [{...f.input,request_id:randomUUID(),plan_hash:'a'.repeat(64)},{...f.input,request_id:randomUUID(),declared_paths:[f.input.declared_paths[0]]}])assert.equal((await f.preview(body)).status,409);
 const huge={...f.input,request_id:randomUUID(),declared_paths:Array.from({length:8},(_,position)=>({position,paths:Array.from({length:16},(_,i)=>`src/${i}/`+'界'.repeat(190))}))};assert.equal((await f.preview(huge)).status,413);
 assert.equal(saved(f),rows);assert.equal(business(f),before);
});

for(const dimension of ['credential','both-owner','target-owner','role','repo','source','selection'])test(`queued inert execution preview refuses ${dimension} change without effects`,async t=>{
 const f=await rig(t),original=f.h.hub.withBoard.bind(f.h.hub);let release,entered=false;
 const held=original(f.A.board,()=>new Promise(r=>release=r));await new Promise(r=>setImmediate(r));f.h.hub.withBoard=(id,fn)=>{if(id===f.A.board)entered=true;return original(id,fn);};t.after(()=>f.h.hub.withBoard=original);
 const pending=f.preview();await until(()=>entered);
 if(dimension==='credential')f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',f.h.hub.iso(),f.cred.id);
 if(dimension==='both-owner'){f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',f.users.n.id,f.cred.id);f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);}
 if(dimension==='target-owner')f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);
 if(dimension==='role')f.db.run("UPDATE members SET role='viewer' WHERE id=?",f.A.member);
 if(dimension==='repo')f.db.run('UPDATE repos SET canonical_url=? WHERE id=?','github.com/shared/changed',f.A.repo);
 if(dimension==='source')f.db.run('UPDATE cards SET body=? WHERE id=?','UNVERSIONED-CHANGED',f.options.steps[0].card_id);
 if(dimension==='selection')f.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?',f.A.board,f.A.repo);
 const before=business(f),rows=saved(f);release();await held;const result=await pending;assert.ok([401,403,404,409].includes(result.status),result.text);assert.equal(saved(f),rows);assert.equal(business(f),before);
});

test('private delivery proof is single-use and unforgeable; final HTTP response withholds a committed snapshot after owner revocation',async t=>{
 const f=await rig(t),made=await f.preview(),id=made.body.execution_preview.id;assert.equal(made.status,200);
 const out=await f.service.read(f.actor,id,f.cred);assert.throws(()=>f.service.guard(structuredClone(out)));assert.throws(()=>new WorkflowExecutor(f.h.app.api).guard(out));f.service.guard(out);assert.throws(()=>f.service.guard(out));
 const original=WorkflowExecutor.prototype.preview;let once=false;WorkflowExecutor.prototype.preview=async function(...args){const out=await original.apply(this,args);if(!once){once=true;f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',f.h.hub.iso(),f.cred.id);}return out;};t.after(()=>WorkflowExecutor.prototype.preview=original);
 const before=business(f),result=await f.preview({...f.input,request_id:randomUUID()});assert.equal(result.status,401,result.text);assert.equal(result.body.execution_preview,undefined);assert.equal(f.db.get('SELECT count(*) n FROM workflow_control_previews').n,2);assert.equal(business(f),before);
});

test('actual final viewer GET revalidates selected scope and captured owner after await',async t=>{
 const f=await rig(t),made=await f.preview();const original=WorkflowExecutor.prototype.read;
 WorkflowExecutor.prototype.read=async function(...args){const out=await original.apply(this,args);f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',f.users.n.id,f.users.aviewer.device_id);f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.viewer);return out;};t.after(()=>WorkflowExecutor.prototype.read=original);
 const result=await f.as(f.users.aviewer,'GET',`/api/workflow-execution-previews/${made.body.execution_preview.id}`);assert.ok([401,403,404].includes(result.status),result.text);assert.equal(result.body.execution_preview,undefined);
});

test('boot/expiry/rollback never revive snapshots, disabled marker cannot be restored or converted to ordinary missing-parent work',async t=>{
 const f=await rig(t),made=await f.preview();assert.equal(made.status,200);const execution=seedExecution(f,made.body.execution_preview),intent=seedMarker(f,execution),rows=saved(f);
 f.h.hub.boot();assert.equal(f.db.get('SELECT state FROM workflow_executions WHERE id=?',execution).state,'paused_boot');assert.equal(f.db.get('SELECT revision FROM workflow_executions WHERE id=?',execution).revision,1);
 const read=await f.as(f.users.amember,'GET',`/api/workflow-execution-previews/${made.body.execution_preview.id}`);assert.equal(read.status,200);assert.equal(read.body.execution_preview.state,'paused_reboot');assert.equal(saved(f),rows);
 f.db.run('DELETE FROM workflow_execution_plans WHERE id=?',f.plan.id);assert.equal(f.db.get('SELECT * FROM workflow_executions WHERE id=?',execution),null);assert.equal(f.db.get('SELECT disabled FROM workflow_owned_intents WHERE request_id=?',intent).disabled,1);
 assert.throws(()=>f.db.run('UPDATE workflow_owned_intents SET disabled=0 WHERE request_id=?',intent),/revived/);assert.throws(()=>f.db.run('DELETE FROM workflow_owned_intents WHERE request_id=?',intent),/retained/);assert.equal(f.db.get('SELECT state FROM dispatches WHERE request_id=?',intent).state,'cancelled','045 invalidates only the exact still-unclaimed ordinary intent');
});

for(const kind of ['issuer','target','team','authorization','control-preview'])test(`actual/direct ${kind} erasure disables owned UUID while private history disappears`,async t=>{
 const f=await rig(t),made=await f.preview(),execution=seedExecution(f,made.body.execution_preview),intent=seedMarker(f,execution),card=f.options.steps[0].card_id;
 if(kind==='issuer')f.h.hub.accounts.eraseUser(f.db.get('SELECT * FROM users WHERE id=?',f.users.amember.id));
 if(kind==='target')f.db.run('UPDATE users SET deleted_at=? WHERE id=?',f.h.hub.iso(),f.users.amember.id);
 if(kind==='team')f.h.hub.teams.deleteTeam(f.db.get('SELECT * FROM orgs WHERE id=?',f.A.team));
 if(kind==='authorization')f.db.run('DELETE FROM workflow_execution_authorizations WHERE execution_id=?',execution);
 if(kind==='control-preview')f.db.run('DELETE FROM workflow_control_previews WHERE id=?',made.body.execution_preview.id);
 assert.equal(f.db.get('SELECT disabled FROM workflow_owned_intents WHERE request_id=?',intent).disabled,1);assert.ok(f.h.hub.card(card));
 assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_authorizations WHERE execution_id=?',execution).n,0);
 if(kind!=='authorization')assert.equal(f.db.get('SELECT * FROM workflow_executions WHERE id=?',execution),null);
});

test('inert Resume preview checks exact immutable graph/progress/revision and SQL rejects foreign selection/authority/proof identities',async t=>{
 const f=await rig(t),made=await f.preview(),execution=seedExecution(f,made.body.execution_preview),body={request_id:randomUUID(),source_plan_id:f.plan.id,plan_hash:f.plan.hash,expected_revision:0,purpose:'resume',declared_paths:f.input.declared_paths},before=business(f);
 const path=`/api/workflow-executions/${execution}/preview`,res=await f.as(f.users.amember,'POST',path,body);assert.equal(res.status,200,res.text);assert.equal(res.body.execution_preview.execution_id,execution);assert.equal(res.body.execution_preview.grants_execution,false);assert.equal(business(f),before);
 assert.equal((await f.as(f.users.amember,'POST',path,{...body,expected_revision:1})).status,409);
 assert.throws(()=>f.db.run('UPDATE workflow_execution_steps SET card_id=? WHERE execution_id=?',f.B.card,execution),/immutable/);
 const e=f.db.get('SELECT * FROM workflow_executions WHERE id=?',execution);assert.throws(()=>f.db.insert('workflow_executions',{...e,id:randomUUID(),instance_id:randomUUID()}),/source changed/);
 assert.throws(()=>f.db.run('UPDATE workflow_control_previews SET expires_ms=expires_ms+1 WHERE id=?',made.body.execution_preview.id),/immutable/);
 const auth=f.db.get('SELECT * FROM workflow_execution_authorizations WHERE execution_id=?',execution);assert.throws(()=>f.db.insert('workflow_execution_authorizations',{...auth,revision:1,issuer_member_id:f.B.owner,issuer_user_id:f.users.ub.id}),/source changed/);
});

test('current scope refuses foreign team, viewer writes, unknown query and selected-board mismatch without leaking refs',async t=>{
 const f=await rig(t),made=await f.preview(),path=`/api/workflow-execution-previews/${made.body.execution_preview.id}`;
 assert.equal((await f.as(f.users.ub,'GET',path)).status,404);assert.equal((await f.as(f.users.aviewer,'POST',f.path,f.input)).status,403);
 assert.equal((await f.as(f.users.amember,'GET',path+`?board_id=${f.B.board}`)).status,404);assert.equal((await f.as(f.users.amember,'GET',path+'?unknown=x')).status,400);
 assert.throws(()=>f.service.plans.principal(f.actor,null,true));assert.throws(()=>f.h.hub.actVia({connection_id:'synthetic',member_id:f.A.member},()=>f.service.plans.principal(f.actor,f.cred,true)));
});

test('wall/monotonic expiry and sticky rollback retain all hashes/expiry without renewed authority',async t=>{
 const f=await rig(t),made=await f.preview(),id=made.body.execution_preview.id,rows=saved(f);
 f.h.clock.advance(24*60*60*1000+1);const expired=await f.preview();assert.equal(expired.status,200,expired.text);assert.equal(expired.body.execution_preview.state,'expired');assert.equal(expired.body.execution_preview.remaining_ms,0);assert.equal(expired.body.execution_preview.hash,made.body.execution_preview.hash);assert.equal(saved(f),rows);
 assert.equal((await f.preview({...f.input,request_id:randomUUID()})).status,409);
 const g=await rig(t),fresh=await g.preview();g.h.clock.advanceWallOnly(-1);
 const paused=await g.as(g.users.amember,'GET',`/api/workflow-execution-previews/${fresh.body.execution_preview.id}`);assert.equal(paused.status,200);assert.equal(paused.body.execution_preview.state,'paused_clock');
 g.h.clock.advanceWallOnly(1000);assert.equal((await g.preview({...g.input,request_id:randomUUID()})).status,409);assert.ok(id);
});

test('delayed path review cannot reset original plan lifetime when only monotonic time advances',async t=>{
 const hour=60*60*1000,monoOnly=(f,ms)=>{f.h.clock.advance(ms);f.h.clock.advanceWallOnly(-ms);};
 const expired=await rig(t);monoOnly(expired,24*hour+1);const before=business(expired),rows=saved(expired);
 assert.equal((await expired.preview()).status,409,'expired original plan must not issue a new inert review');assert.equal(saved(expired),rows);assert.equal(business(expired),before);
 const delayed=await rig(t);monoOnly(delayed,23*hour);const result=await delayed.preview();assert.equal(result.status,200,result.text);
 assert.ok(result.body.execution_preview.remaining_ms<=hour,'path review retains only original remaining lifetime');const stored=saved(delayed);
 monoOnly(delayed,hour+1);const replay=await delayed.preview();assert.equal(replay.status,200,replay.text);assert.equal(replay.body.execution_preview.state,'expired');assert.equal(replay.body.execution_preview.remaining_ms,0);assert.equal(saved(delayed),stored);
});

test('concurrent exact previews are atomic and row/snapshot quota cannot reset through retries',async t=>{
 const f=await rig(t),both=await Promise.all([f.preview(),f.preview()]);assert.ok(both.every(r=>r.status===200));assert.equal(both[0].body.execution_preview.id,both[1].body.execution_preview.id);
 const rows=saved(f),before=business(f),insert=f.db.insert.bind(f.db);let n=0;
 f.db.insert=(table,row)=>{if(table==='workflow_control_preview_steps'&&++n===2)throw Error('synthetic second row failure');return insert(table,row);};
 const failure=await f.preview({...f.input,request_id:randomUUID()});f.db.insert=insert;assert.equal(failure.status,500);assert.equal(saved(f),rows);assert.equal(business(f),before);
 const prototype=f.db.get('SELECT * FROM workflow_control_previews');f.db.tx(()=>{for(let i=1;i<1000;i++)f.db.insert('workflow_control_previews',{...prototype,id:randomUUID(),request_id:randomUUID()});});
 const full=await f.preview({...f.input,request_id:randomUUID()});assert.equal(full.status,403,full.text);assert.equal(full.body.error.code,'QUOTA_EXCEEDED');assert.equal(f.db.get('SELECT count(*) n FROM workflow_control_previews').n,1000);assert.equal(business(f),before);
});

test('new private SQL markers require an exact current recorded authority, retained progress cannot rewind or bind a foreign run',async t=>{
 const f=await rig(t),made=await f.preview(),execution=seedExecution(f),request_id=randomUUID(),card_id=f.options.steps[0].card_id;
 f.db.insert('dispatches',{request_id,card_id,dispatched_by:f.A.member,target_member_id:f.A.member,backend:'codex_cli',ai:'codex',budget_mode:'none',budget_cents:null,needs_confirm:0,seed:'{}',state:'pending',created_at:f.h.hub.iso()});
 assert.throws(()=>f.db.insert('workflow_owned_intents',{request_id,execution_id:execution,card_id,disabled:0}),/source changed/);
 f.db.insert('workflow_owned_intents',{request_id,execution_id:execution,card_id,disabled:1});assert.throws(()=>f.db.run('UPDATE workflow_owned_intents SET run_id=?,fence=? WHERE request_id=?',f.B.run,0,request_id),/source changed/);
 assert.throws(()=>f.db.run('UPDATE workflow_execution_steps SET version=1.5 WHERE execution_id=?',execution),/CHECK/);
 f.db.run('UPDATE workflow_execution_steps SET attempt_count=1 WHERE execution_id=?',execution);assert.throws(()=>f.db.run('UPDATE workflow_execution_steps SET attempt_count=0 WHERE execution_id=?',execution),/rewind/);
 f.db.run('UPDATE workflow_executions SET revision=1 WHERE id=?',execution);assert.throws(()=>f.db.run('UPDATE workflow_executions SET revision=0 WHERE id=?',execution),/rewind/);
 const body={request_id:randomUUID(),source_plan_id:f.plan.id,plan_hash:f.plan.hash,expected_revision:1,purpose:'resume',declared_paths:f.input.declared_paths};
 f.db.run('UPDATE workflow_execution_steps SET version=version+1 WHERE execution_id=?',execution);assert.equal((await f.as(f.users.amember,'POST',`/api/workflow-executions/${execution}/preview`,body)).status,409,'unobserved progress cannot be authorized by a source hash');assert.ok(made);
});

for(const kind of ['attempt','marker'])test(`initial private ${kind} insertion rejects foreign run lineage as well as later rebinding`,async t=>{
 const f=await rig(t),made=await f.preview(),execution=seedExecution(f,made.body.execution_preview),request_id=seedMarker(f,execution),card_id=f.options.steps[0].card_id;
 if(kind==='marker')f.db.run('DELETE FROM workflow_execution_authorizations WHERE execution_id=?',execution); // leaves a disabled retained marker
 if(kind==='attempt'){
  const row={id:randomUUID(),execution_id:execution,position:0,attempt:1,authorization_revision:0,dispatch_id:request_id,provider:'codex',target_member_id:f.A.member,target_user_id:f.users.amember.id,budget_cents:null,run_id:f.B.run,fence:1,state:'claimed'};
  assert.throws(()=>f.db.insert('workflow_execution_attempts',row),/source changed/);
  const device_id=randomUUID(),run_id=randomUUID();f.db.insert('devices',{id:device_id,member_id:f.A.member,name:'synthetic',kind:'runner',token_hash:'a'.repeat(64),created_at:f.h.hub.iso()});
  f.db.insert('runs',{id:run_id,card_id,fence:0,device_id,on_behalf_of:f.A.member,dispatched_by:f.A.member,dispatch_request_id:request_id,backend:'codex_cli',repo_id:f.A.repo,base_ref:'main',started_at:f.h.hub.iso()});
  f.db.insert('workflow_execution_attempts',{...row,run_id,fence:0});const proof={id:randomUUID(),attempt_id:row.id,kind:'complete',run_id,fence:0,card_version:f.h.hub.card(card_id).version,source_epoch:f.h.hub.epoch,snapshot:'{}',snapshot_hash:digest({})};
  f.db.insert('workflow_execution_proofs',proof);assert.throws(()=>f.db.insert('workflow_execution_proofs',{...proof,id:randomUUID(),run_id:f.B.run}),/source changed/);assert.throws(()=>f.db.run('UPDATE workflow_execution_proofs SET fence=1 WHERE id=?',proof.id),/immutable/);
 }else{
  f.db.run("UPDATE dispatches SET state='claimed' WHERE request_id=?",request_id);
  const other=randomUUID();f.db.insert('dispatches',{request_id:other,card_id,dispatched_by:f.A.member,target_member_id:f.A.member,backend:'codex_cli',ai:'codex',budget_mode:'none',seed:'{}',state:'pending',created_at:f.h.hub.iso()});
  assert.throws(()=>f.db.insert('workflow_owned_intents',{request_id:other,execution_id:execution,card_id,run_id:f.B.run,fence:1,disabled:1}),/source changed/);
 }
});

test('actual distinct target account erasure drops private selections while retaining disabled former-owned request fences',async t=>{
 const f=await rig(t);f.options={...f.options,request_id:randomUUID(),steps:f.options.steps.map(s=>({...s,ai:'claude',budget_usd:1,target_member_id:f.A.admin}))};
 const p=await f.as(f.users.amember,'POST',`/api/workflow-instances/${f.instance}/preview`,f.options);assert.equal(p.status,200,p.text);f.plan=p.body.plan;f.input={...f.input,plan_hash:f.plan.hash};f.path=`/api/workflow-plans/${f.plan.id}/execution-preview`;
 const made=await f.preview();assert.equal(made.status,200,made.text);const execution=seedExecution(f,made.body.execution_preview),intent=seedMarker(f,execution);
 f.h.hub.accounts.eraseUser(f.db.get('SELECT * FROM users WHERE id=?',f.users.aadmin.id));assert.equal(f.db.get('SELECT * FROM workflow_executions WHERE id=?',execution),null);assert.equal(f.db.get('SELECT * FROM workflow_control_previews WHERE id=?',made.body.execution_preview.id),null);assert.equal(f.db.get('SELECT disabled FROM workflow_owned_intents WHERE request_id=?',intent).disabled,1);assert.equal(f.db.get('SELECT deleted_at FROM users WHERE id=?',f.users.amember.id).deleted_at,null);
});

test('actual browser session execution preview requires CSRF/strict body and reuses a same-owner session row without bearer storage',async t=>{
 const f=await rig(t),web=await f.h.webSignIn(f.users.amember.email);assert.equal(web.res.status,200,web.res.text);
 const call=(body,headers={})=>f.h.call('POST',f.path,{body,cookie:web.cookie,headers:{origin:f.h.base,...headers}});
 assert.equal((await call(f.input)).status,403);
 const result=await call(f.input,{'x-csrf-token':web.csrf});assert.equal(result.status,200,result.text);assert.equal(result.text.includes(web.cookie),false);
 const bad=await fetch(f.h.base+f.path,{method:'POST',body:`{"request_id":"${randomUUID()}","request_id":"${randomUUID()}"}`,headers:{origin:f.h.base,cookie:web.cookie,'x-csrf-token':web.csrf,'content-type':'application/json'}});assert.equal(bad.status,400);
});
