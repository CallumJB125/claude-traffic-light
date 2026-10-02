import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {tenancy} from './tenancy/fixture.js';
import {FakeRunner,until,runMsg,runHb,settle} from './helpers.js';
import {WorkflowExecutor} from '../workflow-executor.js';
import {CODEX_PLAN_PERMISSION} from '../../shared/protocol.js';
import {TTL_MS,T_CLAIM_MS,T_PARK_MS} from '../../shared/liveness.js';
import {createGitHub} from '../github.js';
import {HubError} from '../db.js';
const BASE='a'.repeat(40),HEAD='b'.repeat(40),MERGE='c'.repeat(40);
const codex={id:'codex',label:'Codex',installed:true,signedIn:true,startable:true,capabilities:{budget:'none',resume:true}};
async function rig(t,{concurrency=1,dependencies,verified=true,planApproval=false,ai='codex',budget_usd=null,reuse=null}={}){
 const pulls=new Map(),github={enabled:true,async getBaseCommit(){return verified?{sha:BASE}:null;},async getCommit(_repo,sha){return /^[0-9a-f]{40}$/.test(sha)?{sha}:null;},async getPull(_repo,n){return pulls.get(n)??null;}};
 const f=reuse??await tenancy();f.h.hub.github=github;let r=reuse?.r;
 if(!reuse){t.after(()=>f.h.close());
  const enroll=await f.as(f.users.amember,'POST',`/api/teams/${f.A.team}/enrol`,{});assert.equal(enroll.status,200,enroll.text);
  r=new FakeRunner(f.h.base,{device_id:'',device_token:enroll.body.runner_token,team:f.A.team});t.after(()=>r.terminate());await r.open();await r.hello();
 }
 const provider=ai==='codex'?codex:{...codex,id:'claude',label:'Synthetic Claude capability fixture',capabilities:{budget:'native',resume:true}};
 r.send({type:'advertise',repos:[{repo_id:f.A.repo}],ai:[provider]});await until(()=>f.h.hub.runners.get(r.welcome.device_id)?.ai?.some(a=>a.id===ai&&a.signedIn===true));
 const definition={name:'Bounded delivery',description:'Human controlled',steps:[{title:'Implement',body:'PRIVATE-WORKFLOW-BRIEF',acceptance:'Review',plan_approval:planApproval},{title:'Verify',body:'Second task',acceptance:'Review',plan_approval:planApproval}]};
 const recipe=(await f.as(f.users.amember,'POST','/api/workflows',{request_id:randomUUID(),definition})).body.workflow;
 const applied=await f.as(f.users.amember,'POST',`/api/boards/${f.A.board}/workflows/${recipe.id}/apply`,{request_id:randomUUID(),version:recipe.version,content_hash:recipe.content_hash});assert.equal(applied.status,200,applied.text);const instance=applied.body.instance;
 for(const step of instance.steps){const card=f.h.hub.card(step.id);assert.equal((await f.as(f.users.amember,'PATCH',`/api/cards/${card.id}`,{version:card.version,repo_id:f.A.repo})).status,200);}
 const options={request_id:randomUUID(),board_id:f.A.board,repo_id:f.A.repo,recipe_version:recipe.version,content_hash:recipe.content_hash,concurrency,
  steps:instance.steps.map((s,position)=>{const c=f.h.hub.card(s.id);return {position,card_id:c.id,version:c.version,fence:c.fence,ai,target_member_id:f.A.member,budget_usd,plan_approval:planApproval};}),...(dependencies?{dependencies}:{})};
 const p=await f.as(f.users.amember,'POST',`/api/workflow-instances/${instance.id}/preview`,options);assert.equal(p.status,200,p.text);const plan=p.body.plan;
 const paths=options.steps.map(s=>({position:s.position,paths:concurrency===1&&!planApproval?[]:[`src/step${s.position}/**`]}));
 const cp=await f.as(f.users.amember,'POST',`/api/workflow-plans/${plan.id}/execution-preview`,{request_id:randomUUID(),plan_hash:plan.hash,purpose:'start',declared_paths:paths});assert.equal(cp.status,200,cp.text);const preview=cp.body.execution_preview;
 const startInput={request_id:randomUUID(),plan_hash:plan.hash,execution_preview_id:preview.id,execution_preview_hash:preview.hash,path_intent_hash:preview.path_intent_hash,expected_revision:0,confirm:true};
 const call=(method,path,body,user=f.users.amember)=>f.as(user,method,path,body);
 const start=body=>call('POST',`/api/workflow-plans/${plan.id}/start`,body??startInput);
 const claim=async cardId=>{const offer=await r.next('offer',o=>o.card_id===cardId),res=await r.claim(offer);assert.equal(res.ok,true,JSON.stringify(res));const run={...res,card_id:cardId,repo_id:f.A.repo};await r.out({...runMsg(run),kind:'activity',source:'init'});await r.hb([runHb(run)]);return {offer,run};};
 const complete=async(run,{pr=false}={})=>{
  if(pr)pulls.set(1,{number:1,head_ref:run.branch,head_repo_id:100,base_repo_id:100,base_ref:'main',head_sha:HEAD,merged:false,state:'open',html_url:'https://github.com/shared/app/pull/1'});
  const code=await r.rpc(run,'board_attach_evidence',{kind:pr?'pr':'commit',ref:pr?'1':HEAD});assert.equal(code.ok,true,JSON.stringify(code));assert.equal(code.result.verification,'hub_verified');
  const tests=await r.rpc(run,'board_attach_evidence',{kind:'test_run',ref:'synthetic fixture tests',result:'pass'});assert.equal(tests.ok,true,JSON.stringify(tests));
  const result=await r.rpc(run,'board_complete',{evidence_ids:[code.result.evidence_id,tests.result.evidence_id]});assert.equal(result.ok,true,JSON.stringify(result));return {code:code.result.evidence_id,tests:tests.result.evidence_id};
 };
 return {...f,r,plan,preview,options,paths,startInput,start,call,claim,complete,pulls,github};
}
const effects=f=>JSON.stringify(['dispatches','runs','workflow_executions','workflow_execution_steps','workflow_step_bindings','workflow_execution_authorizations','workflow_execution_attempts','workflow_owned_intents','workflow_execution_proofs','workflow_stop_requests','workflow_execution_receipts','journal','cards'].map(t=>f.db.all(`SELECT * FROM ${t} ORDER BY rowid`)));

test('unverified base preview remains inert; Start refuses all launch and receipt effects',async t=>{
 const f=await rig(t,{verified:false});assert.ok(f.preview.blocked_reasons.includes('BASE_REVIEW_REQUIRED'));const before=effects(f);
 const result=await f.start();assert.equal(result.status,409,result.text);assert.equal(effects(f),before);
});
test('real HTTP Start and enrolled WS share one immutable receipt/intent/run and exact verified base',async t=>{
 const f=await rig(t),result=await f.start();assert.equal(result.status,200,result.text);const execution=result.body.execution;
 assert.equal(execution.authorization_current,true);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,1);assert.equal(f.db.get('SELECT count(*) n FROM permission_requests WHERE card_id=?',f.options.steps[0].card_id).n,0);
 const same=await f.start();assert.equal(same.status,200,same.text);assert.equal(same.body.execution.id,execution.id);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_receipts').n,1);
 const {offer,run}=await f.claim(f.options.steps[0].card_id);assert.equal(offer.base_ref,BASE);assert.equal(f.h.hub.run(run.run_id).base_ref,BASE);
 assert.equal((await f.start({...f.startInput,path_intent_hash:'d'.repeat(64)})).status,409);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,1);
 const stale=await f.call('GET',`/api/workflow-plans/${f.plan.id}`);assert.equal(stale.status,409,'frozen039 source never adopts ordinary lifecycle versions');
});
test('completion captures exact run before pointer release; actual human review admits only its successor',async t=>{
 const f=await rig(t),started=await f.start();assert.equal(started.status,200,started.text);const execution=started.body.execution;
 const {run}=await f.claim(f.options.steps[0].card_id);await f.complete(run);assert.equal(f.h.hub.card(run.card_id).active_run_id,null);
 assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,1);const proof=f.db.get("SELECT * FROM workflow_execution_proofs WHERE kind='complete'");assert.equal(proof.run_id,run.run_id);assert.equal(proof.fence,run.fence);
 const review=await f.call('POST',`/api/cards/${run.card_id}/actions/approve_done`,{});assert.equal(review.status,200,review.text);
 await until(()=>f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n===2);
 const saved=f.db.get("SELECT * FROM workflow_execution_proofs WHERE kind='human_review'");assert.equal(saved.run_id,run.run_id);assert.equal(f.db.get('SELECT card_id FROM dispatches WHERE state=\'pending\'').card_id,f.options.steps[1].card_id);
 const status=await f.call('GET',`/api/workflow-executions/${execution.id}`);assert.equal(status.status,200,status.text);assert.equal(status.body.execution.steps[0].predecessor_released,true);
});

async function control(f,id,purpose,{position,previous_attempt_id}={}){
 const row=f.db.get('SELECT revision FROM workflow_executions WHERE id=?',id),body={request_id:randomUUID(),source_plan_id:f.plan.id,plan_hash:f.plan.hash,expected_revision:row.revision,purpose,declared_paths:f.paths,...(purpose==='retry'?{position,previous_attempt_id}:{})};
 const result=await f.call('POST',`/api/workflow-executions/${id}/preview`,body);assert.equal(result.status,200,result.text);const p=result.body.execution_preview;
 return {request_id:randomUUID(),expected_revision:p.expected_revision,execution_preview_id:p.id,execution_preview_hash:p.hash,path_intent_hash:p.path_intent_hash,confirm:true,...(purpose==='retry'?{previous_attempt_id}:{})};
}
test('Pause withdraws an unclaimed offer; claimed replay cannot mint a token, fresh human Resume may reserve a new unclaimed intent',async t=>{
 const f=await rig(t),s=await f.start();assert.equal(s.status,200,s.text);const id=s.body.execution.id,offer=await f.r.next('offer');
 const paused=await f.call('POST',`/api/workflow-executions/${id}/pause`,{request_id:randomUUID(),expected_revision:0});assert.equal(paused.status,200,paused.text);assert.equal(paused.body.execution.authorization_current,false);
 assert.equal((await f.r.claim(offer)).ok,false);assert.equal(f.db.get('SELECT count(*) n FROM runs WHERE card_id=?',offer.card_id).n,0);
 const old=f.db.get('SELECT * FROM dispatches WHERE request_id=?',offer.request_id);assert.equal(old.state,'cancelled');assert.equal(f.db.get('SELECT disabled FROM workflow_owned_intents WHERE request_id=?',offer.request_id).disabled,1);
 const input=await control(f,id,'resume'),resumed=await f.call('POST',`/api/workflow-executions/${id}/resume`,input);assert.equal(resumed.status,200,resumed.text);
 const replacement=await f.r.next('offer',o=>o.card_id===offer.card_id&&o.request_id!==offer.request_id);assert.equal((await f.r.claim(replacement)).ok,true);
 const replay=await f.r.claim(replacement);assert.equal(replay.ok,true);const rev=f.db.get('SELECT revision FROM workflow_executions WHERE id=?',id).revision;
 assert.equal((await f.call('POST',`/api/workflow-executions/${id}/pause`,{request_id:randomUUID(),expected_revision:rev})).status,200);
 const fenced=await f.r.claim(replacement);assert.equal(fenced.ok,false);assert.equal(fenced.run_token,undefined);assert.equal(f.db.get('SELECT count(*) n FROM runs WHERE card_id=?',offer.card_id).n,1);
});
for(const erase of ['plan','execution','authorization','target-user'])test(`direct ${erase} erasure cancels exact pending intent, retains ownership and refuses ordinary UUID replay`,async t=>{
 const f=await rig(t),s=await f.start();assert.equal(s.status,200,s.text);const id=s.body.execution.id,offer=await f.r.next('offer');
 if(erase==='plan')f.db.run('DELETE FROM workflow_execution_plans WHERE id=?',f.plan.id);
 if(erase==='execution')f.db.run('DELETE FROM workflow_executions WHERE id=?',id);
 if(erase==='authorization')f.db.run('DELETE FROM workflow_execution_authorizations WHERE execution_id=?',id);
 if(erase==='target-user')f.db.run('UPDATE users SET deleted_at=? WHERE id=?',f.h.hub.iso(),f.users.amember.id);
 assert.equal(f.db.get('SELECT disabled FROM workflow_owned_intents WHERE request_id=?',offer.request_id).disabled,1);assert.equal(f.db.get('SELECT state FROM dispatches WHERE request_id=?',offer.request_id).state,'cancelled');
 if(erase==='target-user'){f.r.send({type:'claim',id:'erased-claim',card_id:offer.card_id,request_id:offer.request_id,expected_fence:offer.fence});await f.r.closed();}
 else assert.equal((await f.r.claim(offer)).ok,false);
 f.h.hub.ensurePendingDispatch(offer.card_id);await f.h.hub.followUp(offer.card_id,{type:'redispatch'},{by:f.A.member});
 assert.equal(f.db.get('SELECT count(*) n FROM dispatches WHERE card_id=?',offer.card_id).n,1);
 const replay=f.h.hub.apply(offer.card_id,{type:'dispatch',request_id:offer.request_id},{ctx:{duplicate_request:true,can_write:true}});assert.equal(replay.ok,false);
});
for(const failure of ['prep_failed','release_requeue','run_failed'])test(`owned ${failure} observes cleanup without inventing a paid replacement; explicit Retry is payload bound`,async t=>{
 const f=await rig(t),s=await f.start();assert.equal(s.status,200,s.text);const id=s.body.execution.id,offer=await f.r.next('offer'),claimed=await f.r.claim(offer);assert.equal(claimed.ok,true,JSON.stringify(claimed));
 const run={...claimed,card_id:offer.card_id,repo_id:f.A.repo};
 if(failure==='prep_failed')await f.r.out({...runMsg(run),kind:'prep.failed',cause:'synthetic'});
 else{await f.r.out({...runMsg(run),kind:'activity',source:'init'});if(failure==='release_requeue'){const released=await f.r.rpc(run,'board_release',{requeue:true,reason:'synthetic'});assert.equal(released.ok,true,JSON.stringify(released));}else await f.r.out({...runMsg(run),kind:'run.failed',fail_kind:'error',reason:'synthetic'});}
 await settle();assert.ok(f.h.hub.run(run.run_id).ended_at);assert.equal(f.db.get('SELECT count(*) n FROM dispatches WHERE card_id=?',run.card_id).n,1);assert.equal(f.h.hub.offerFrame(run.card_id),null);
 const attempt=f.db.get('SELECT * FROM workflow_execution_attempts WHERE execution_id=?',id);assert.ok(['failed','uncertain'].includes(attempt.state));
 const resume=await control(f,id,'resume');assert.equal((await f.call('POST',`/api/workflow-executions/${id}/resume`,resume)).status,409);
 const retry=await control(f,id,'retry',{position:0,previous_attempt_id:attempt.id}),path=`/api/workflow-executions/${id}/steps/0/retry`,done=await f.call('POST',path,retry);assert.equal(done.status,200,done.text);
 const same=await f.call('POST',path,retry);assert.equal(same.status,200,same.text);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',id).n,2);
 assert.equal((await f.call('POST',path,{...retry,previous_attempt_id:randomUUID()})).status,409);
});

test('reserved plan approval is a separate actual human answer; changed paths invalidate its proof without resetting or answering permission',async t=>{
 const f=await rig(t,{planApproval:true}),s=await f.start();assert.equal(s.status,200,s.text);const {run}=await f.claim(f.options.steps[0].card_id);
 const declaration=await f.r.rpc(run,'board_declare_plan',{paths:['src/step0/main.js'],summary:'Synthetic plan'});assert.equal(declaration.ok,true,JSON.stringify(declaration));const permission=f.db.get('SELECT * FROM permission_requests WHERE run_id=?',run.run_id);assert.equal(permission.tool,CODEX_PLAN_PERMISSION);assert.equal(permission.state,'open');
 const pending=await f.r.rpc(run,'runner_plan_status');assert.equal(pending.result.decision,'pending');assert.equal(f.db.get("SELECT count(*) n FROM workflow_execution_proofs WHERE kind='plan_review'").n,0);
 const answer=await f.call('POST',`/api/permission-requests/${permission.id}/answer`,{decision:'allow',scope:'run'});assert.equal(answer.status,200,answer.text);
 assert.equal((await f.r.rpc(run,'runner_plan_status')).result.decision,'allow');assert.equal(f.db.get("SELECT count(*) n FROM workflow_execution_proofs WHERE kind='plan_review'").n,1);
 const changed=await f.r.rpc(run,'board_declare_plan',{paths:['src/step0/changed.js'],ownership_generation:f.db.get('SELECT generation FROM task_ownership WHERE run_id=?',run.run_id).generation});assert.equal(changed.ok,true,JSON.stringify(changed));
 assert.equal((await f.r.rpc(run,'runner_plan_status')).result.decision,'pending');assert.equal(f.db.get('SELECT state FROM permission_requests WHERE id=?',permission.id).state,'allowed');
 assert.equal(f.db.get('SELECT state FROM workflow_executions WHERE id=?',s.body.execution.id).state,'blocked');assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,1);
});

for(const dimension of ['issuer-revoke','both-owner','role','repo','board-link','enrollment','provider'])test(`a sent owned offer loses launch authority after ${dimension}, including the claimed-replay boundary`,async t=>{
 const f=await rig(t),s=await f.start();assert.equal(s.status,200,s.text);const offer=await f.r.next('offer'),conn=f.h.hub.runners.get(f.r.welcome.device_id);
 if(dimension==='issuer-revoke')f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',f.h.hub.iso(),f.users.amember.device_id);
 if(dimension==='both-owner'){f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',f.users.n.id,f.users.amember.device_id);f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);}
 if(dimension==='role')f.db.run("UPDATE members SET role='viewer' WHERE id=?",f.A.member);
 if(dimension==='repo')f.db.run("UPDATE repos SET canonical_url='github.com/shared/changed' WHERE id=?",f.A.repo);
 if(dimension==='board-link')f.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?',f.A.board,f.A.repo);
 if(dimension==='enrollment')f.db.run('UPDATE runner_enrollments SET revoked_at=?,token_hash=NULL WHERE id=?',f.h.hub.iso(),conn.enrollmentId);
 if(dimension==='provider')conn.ai[0].signedIn='unknown';
 assert.equal(f.h.hub.workflowGuard.claim(offer.request_id,conn),false);assert.equal(f.h.hub.offerFrame(offer.card_id),null);
 if(['issuer-revoke','role','both-owner','enrollment'].includes(dimension)){f.r.send({type:'claim',id:'stale-offer',card_id:offer.card_id,request_id:offer.request_id,expected_fence:offer.fence});await f.r.closed();}
 else assert.equal((await f.r.claim(offer)).ok,false);
 assert.equal(f.db.get('SELECT count(*) n FROM runs WHERE card_id=?',offer.card_id).n,0);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,1);
});

for(const dimension of ['credential','both-owner','source','repo','selection'])test(`queued Start rechecks ${dimension} before any ordinary effect or receipt`,async t=>{
 const f=await rig(t),original=f.h.hub.withBoard.bind(f.h.hub);let release,queued=false;
 const held=original(f.A.board,()=>new Promise(r=>release=r));await new Promise(r=>setImmediate(r));f.h.hub.withBoard=(id,fn)=>{if(id===f.A.board)queued=true;return original(id,fn);};t.after(()=>f.h.hub.withBoard=original);t.after(()=>release());
 const pending=f.start();await until(()=>queued);
 if(dimension==='credential')f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',f.h.hub.iso(),f.users.amember.device_id);
 if(dimension==='both-owner'){f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',f.users.n.id,f.users.amember.device_id);f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);}
 if(dimension==='source')f.db.run('UPDATE cards SET body=? WHERE id=?','UNVERSIONED-CHANGED',f.options.steps[0].card_id);
 if(dimension==='repo')f.db.run("UPDATE repos SET canonical_url='github.com/shared/changed' WHERE id=?",f.A.repo);
 if(dimension==='selection')f.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?',f.A.board,f.A.repo);
 const before=effects(f);release();await held;const result=await pending;assert.ok([401,403,404,409].includes(result.status),result.text);assert.equal(effects(f),before);
});
test('actual synchronous delivery guard withholds private success after revocation; committed intent is retained honestly',async t=>{
 const f=await rig(t),original=WorkflowExecutor.prototype.start;WorkflowExecutor.prototype.start=async function(...args){const result=await original.apply(this,args);f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',f.h.hub.iso(),f.users.amember.device_id);return result;};t.after(()=>WorkflowExecutor.prototype.start=original);
 const result=await f.start();assert.equal(result.status,401,result.text);assert.equal(result.body.execution,undefined);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,1);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_receipts').n,1);assert.equal(f.h.hub.offerFrame(f.options.steps[0].card_id),null);
});
test('requested concurrency two admits only two explicit nonoverlapping ready reservations; duplicate Start and wakes never exceed capacity',async t=>{
 const f=await rig(t,{concurrency:2,dependencies:[]}),[a,b]=await Promise.all([f.start(),f.start()]);assert.equal(a.status,200,a.text);assert.equal(b.status,200,b.text);assert.equal(a.body.execution.id,b.body.execution.id);
 assert.equal(a.body.execution.concurrency,2);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,2);
 f.h.app.api.workflowExecutor.wake(a.body.execution.id);f.h.app.api.workflowExecutor.wake(a.body.execution.id);await settle();assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,2);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_receipts').n,1);
});

test('fresh trusted exact PR head and merge commit release a predecessor; successor keeps its reviewed base with no automatic source transfer',async t=>{
 const f=await rig(t),s=await f.start();assert.equal(s.status,200,s.text);const {run}=await f.claim(f.options.steps[0].card_id);await f.complete(run,{pr:true});
 f.pulls.set(1,{...f.pulls.get(1),merged:true,state:'closed',merge_commit_sha:MERGE});await f.h.hub.pollMerges();await until(()=>f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n===2);
 const p=f.db.get("SELECT snapshot,run_id FROM workflow_execution_proofs WHERE kind='verified_merge'");assert.equal(p.run_id,run.run_id);assert.equal(JSON.parse(p.snapshot).head_sha,HEAD);assert.equal(JSON.parse(p.snapshot).merge_commit_sha,MERGE);
 assert.equal(f.h.hub.offerFrame(f.options.steps[1].card_id).base_ref,BASE);
});
for(const bad of ['branch-prefix','head-sha','base','fork','missing-merge','deleted-head'])test(`owned merged PR ${bad} cannot release an exact completed predecessor`,async t=>{
 const f=await rig(t),s=await f.start();assert.equal(s.status,200,s.text);const {run}=await f.claim(f.options.steps[0].card_id);await f.complete(run,{pr:true});
 const pull={...f.pulls.get(1),merged:true,state:'closed',merge_commit_sha:MERGE};
 if(bad==='branch-prefix')pull.head_ref=run.branch+'-other';if(bad==='head-sha')pull.head_sha='d'.repeat(40);if(bad==='base')pull.base_ref='other';if(bad==='fork')pull.head_repo_id=101;if(bad==='missing-merge')delete pull.merge_commit_sha;if(bad==='deleted-head')pull.head_repo_id=null;
 f.pulls.set(1,pull);await f.h.hub.pollMerges();await settle();assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,1);assert.equal(f.db.get("SELECT count(*) n FROM workflow_execution_proofs WHERE kind='verified_merge'").n,0);assert.equal(f.h.hub.card(run.card_id).column_name,'in_review');
});
test('same-card evidence from an older/foreign run cannot complete an owned attempt',async t=>{
 const f=await rig(t),s=await f.start();assert.equal(s.status,200,s.text);const {run}=await f.claim(f.options.steps[0].card_id),foreign=randomUUID(),tests=randomUUID();
 f.db.insert('evidence',{id:foreign,card_id:run.card_id,run_id:f.B.run,kind:'commit',ref:HEAD,verification:'hub_verified',created_at:f.h.hub.iso()});
 f.db.insert('evidence',{id:tests,card_id:run.card_id,run_id:run.run_id,kind:'test_run',ref:'synthetic',result:'pass',verification:'self_reported',created_at:f.h.hub.iso()});
 const before=effects(f),result=await f.r.rpc(run,'board_complete',{evidence_ids:[foreign,tests]});assert.equal(result.ok,false);assert.equal(effects(f),before);assert.equal(f.db.get("SELECT count(*) n FROM workflow_execution_proofs WHERE kind='complete'").n,0);
});
test('a source edit during the real provider await cannot write a verified merge proof or successor intent',async t=>{
 const f=await rig(t),s=await f.start();assert.equal(s.status,200,s.text);const {run}=await f.claim(f.options.steps[0].card_id);await f.complete(run,{pr:true});
 let release,entered=false;f.github.getPull=async()=>{entered=true;return new Promise(r=>release=r);};const poll=f.h.hub.pollMerges();await until(()=>entered);
 f.db.run('UPDATE cards SET body=? WHERE id=?','UNVERSIONED-PROVIDER-RACE',run.card_id);const before=effects(f);release({...f.pulls.get(1),merged:true,state:'closed',merge_commit_sha:MERGE});await poll;assert.equal(effects(f),before);assert.equal(f.db.get("SELECT count(*) n FROM workflow_execution_proofs WHERE kind='verified_merge'").n,0);
});
for(const stale of ['expired','boot','clock'])test(`old ${stale} authorization and success receipt never revive a launch`,async t=>{
 const f=await rig(t),s=await f.start();assert.equal(s.status,200,s.text);const id=s.body.execution.id,offer=await f.r.next('offer');
 if(stale==='expired')f.h.clock.advance(24*60*60*1000+1);if(stale==='boot')f.h.hub.boot();if(stale==='clock')f.h.clock.advanceWallOnly(-1);
 assert.equal(f.h.hub.offerFrame(offer.card_id),null);assert.equal(f.h.hub.workflowGuard.claim(offer.request_id,f.h.hub.runners.get(f.r.welcome.device_id)),false);
 const result=await f.start();assert.equal(result.status,200,result.text);assert.equal(result.body.execution.authorization_current,false);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,1);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_receipts').n,1);
 if(stale!=='clock'){const input=await control(f,id,'resume'),resumed=await f.call('POST',`/api/workflow-executions/${id}/resume`,input);assert.equal(resumed.status,200,resumed.text);assert.equal(resumed.body.execution.authorization_current,true);
  const replacement=await f.r.next('offer',o=>o.card_id===offer.card_id&&o.request_id!==offer.request_id);assert.equal((await f.r.claim(replacement)).ok,true);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,2);}
});

test('actual claimed timeout ends the observed run without a replacement; a fresh explicit Retry may claim once',async t=>{
 const f=await rig(t),s=await f.start(),id=s.body.execution.id,offer=await f.r.next('offer'),result=await f.r.claim(offer);assert.equal(result.ok,true);
 f.h.clock.advance(TTL_MS+1);await f.h.hub.tick();assert.equal(f.h.hub.card(offer.card_id).run_state,'unresponsive');
 f.h.clock.advance(T_CLAIM_MS);await f.h.hub.tick();await settle();assert.equal(f.h.hub.run(result.run_id).end_reason,'claim_timeout');assert.ok(f.h.hub.run(result.run_id).ended_at);
 assert.equal(f.db.get('SELECT count(*) n FROM dispatches WHERE card_id=?',offer.card_id).n,1);assert.equal(f.h.hub.offerFrame(offer.card_id),null);
 const a=f.db.get('SELECT * FROM workflow_execution_attempts WHERE execution_id=?',id);assert.equal(a.state,'uncertain');
 const retry=await control(f,id,'retry',{position:0,previous_attempt_id:a.id});assert.equal((await f.call('POST',`/api/workflow-executions/${id}/steps/0/retry`,retry)).status,200);
 const next=await f.r.next('offer',o=>o.card_id===offer.card_id&&o.request_id!==offer.request_id);assert.equal((await f.r.claim(next)).ok,true);
});
for(const answered of [false,true])test(`parked owned permission ${answered?'answer':'pending'} never seeds paid work; explicit Retry uses involved-actor cleanup`,async t=>{
 const f=await rig(t),s=await f.start(),id=s.body.execution.id,{run}=await f.claim(f.options.steps[0].card_id);
 const ask=await f.r.rpc(run,'approval',{tool_name:'Bash',input_summary:'Synthetic operation'});assert.equal(ask.ok,true,JSON.stringify(ask));
 f.h.clock.advance(T_PARK_MS);await f.r.hb([runHb(run,{gate:'blocked'})]);await f.h.hub.tick();assert.equal(f.h.hub.card(run.card_id).run_state,'parked');
 if(answered){const response=await f.call('POST',`/api/permission-requests/${ask.result.permission_request_id}/answer`,{decision:'allow',scope:'run'});assert.equal(response.status,200,response.text);assert.equal(f.h.hub.card(run.card_id).run_state,'queued');}
 await settle();assert.equal(f.db.get('SELECT count(*) n FROM dispatches WHERE card_id=?',run.card_id).n,1);assert.equal(f.h.hub.offerFrame(run.card_id),null);
 const a=f.db.get('SELECT * FROM workflow_execution_attempts WHERE execution_id=?',id);assert.equal(a.state,'uncertain');
 const retry=await control(f,id,'retry',{position:0,previous_attempt_id:a.id}),res=await f.call('POST',`/api/workflow-executions/${id}/steps/0/retry`,retry);assert.equal(res.status,200,res.text);
 const next=await f.r.next('offer',o=>o.card_id===run.card_id&&o.request_id!==a.dispatch_id);assert.equal((await f.r.claim(next)).ok,true);
 assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',id).n,2);
});
test('human handoff and observed checkpoint never redispatch automatically; exact explicit Retry retains reviewed provider and base',async t=>{
 const f=await rig(t),s=await f.start(),id=s.body.execution.id,{run}=await f.claim(f.options.steps[0].card_id);
 const h=await f.call('POST',`/api/cards/${run.card_id}/actions/hand_over`,{target:{kind:'queue'}});assert.equal(h.status,200,h.text);
 await f.r.out({...runMsg(run),kind:'handover.complete'});await settle();assert.equal(f.h.hub.card(run.card_id).run_state,'handed_over');
 assert.equal(f.db.get('SELECT count(*) n FROM dispatches WHERE card_id=?',run.card_id).n,1);assert.equal(f.h.hub.offerFrame(run.card_id),null);
 const a=f.db.get('SELECT * FROM workflow_execution_attempts WHERE execution_id=?',id);assert.equal(a.state,'uncertain');
 const retry=await control(f,id,'retry',{position:0,previous_attempt_id:a.id}),res=await f.call('POST',`/api/workflow-executions/${id}/steps/0/retry`,retry);assert.equal(res.status,200,res.text);
 const next=await f.r.next('offer',o=>o.card_id===run.card_id&&o.request_id!==a.dispatch_id);assert.equal(next.ai,'codex');assert.equal(next.base_ref,BASE);assert.equal((await f.r.claim(next)).ok,true);
});
test('Cancel uses only the exact current ordinary stop policy and reports requested rather than process-confirmed',async t=>{
 const f=await rig(t),s=await f.start(),id=s.body.execution.id,{run}=await f.claim(f.options.steps[0].card_id);
 const body={request_id:randomUUID(),expected_revision:0},res=await f.call('POST',`/api/workflow-executions/${id}/cancel`,body);assert.equal(res.status,200,res.text);
 assert.equal(res.body.execution.state,'cancelled');assert.deepEqual(res.body.execution.stop_requests,[{run_id:run.run_id,fence:run.fence,state:'requested',confirmed:false}]);
 assert.equal((await f.r.next('cmd',m=>m.cmd==='stop')).run_id,run.run_id);assert.equal(f.h.hub.run(run.run_id).end_reason,'stopped');assert.ok(f.h.hub.run(run.run_id).ended_at);
 const same=await f.call('POST',`/api/workflow-executions/${id}/cancel`,body);assert.equal(same.status,200,same.text);assert.equal(f.db.get('SELECT count(*) n FROM workflow_stop_requests').n,1);
});
test('ordinary replacement detaches workflow authority; Cancel cannot stop or adopt the newer run',async t=>{
 const f=await rig(t),s=await f.start(),id=s.body.execution.id,{run}=await f.claim(f.options.steps[0].card_id);
 await f.r.out({...runMsg(run),kind:'run.failed',fail_kind:'error',reason:'Synthetic'});await settle();
 const manual=await f.call('POST',`/api/cards/${run.card_id}/actions/retry`,{request_id:randomUUID(),ai:'codex',target_member_id:f.A.member,budget_usd:null,confirm:true});assert.equal(manual.status,200,manual.text);
 const offer=await f.r.next('offer',o=>o.card_id===run.card_id&&o.request_id!==f.db.get('SELECT dispatch_id FROM workflow_execution_attempts').dispatch_id),newer=await f.r.claim(offer);assert.equal(newer.ok,true);
 const before=effects(f),rev=f.db.get('SELECT revision FROM workflow_executions WHERE id=?',id).revision;
 const cancel=await f.call('POST',`/api/workflow-executions/${id}/cancel`,{request_id:randomUUID(),expected_revision:rev});assert.equal(cancel.status,409,cancel.text);assert.equal(effects(f),before);assert.equal(f.h.hub.run(newer.run_id).ended_at,null);
});
test('execution status is current selected staff/viewer data, with private one-use proof and foreign scope refusal',async t=>{
 const f=await rig(t),s=await f.start(),id=s.body.execution.id,service=f.h.app.api.workflowExecutor;
 const view=await f.call('GET',`/api/workflow-executions/${id}`,undefined,f.users.aviewer);assert.equal(view.status,200,view.text);assert.equal(view.body.execution.steps.length,2);assert.ok(!view.text.includes('PRIVATE-WORKFLOW-BRIEF'));assert.ok(!view.text.includes('credential_id'));
 assert.equal((await f.call('GET',`/api/workflow-executions/${id}`,undefined,f.users.ub)).status,404);
 const actor=f.h.hub.activeMember(f.A.member),cred={kind:'device',id:f.users.amember.device_id};await assert.rejects(service.status(actor,id,cred,{boardIds:[f.B.board]}));
 const out=await service.status(actor,id,cred,{boardIds:[f.A.board]});assert.throws(()=>service.guard(structuredClone(out)));service.guard(out);assert.throws(()=>service.guard(out));
 const stale=await service.status(actor,id,cred);f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',f.users.n.id,cred.id);assert.throws(()=>service.guard(stale));
});
test('base resolution await cannot adopt edited current source or ordinary dispatch observations',async t=>{
 const f=await rig(t),s=await f.start(),id=s.body.execution.id;await f.call('POST',`/api/workflow-executions/${id}/pause`,{request_id:randomUUID(),expected_revision:0});
 const releases=[];f.github.getBaseCommit=()=>new Promise(r=>releases.push(r));
 const row=f.db.get('SELECT revision FROM workflow_executions WHERE id=?',id),body={request_id:randomUUID(),source_plan_id:f.plan.id,plan_hash:f.plan.hash,purpose:'resume',expected_revision:row.revision,declared_paths:f.paths};
 const pending=f.call('POST',`/api/workflow-executions/${id}/preview`,body);await until(()=>releases.length===2);
 f.db.run("UPDATE dispatches SET created_at='2026-01-01T00:00:00.000Z' WHERE request_id=(SELECT dispatch_id FROM workflow_execution_attempts WHERE execution_id=?)",id);
 for(const release of releases)release({sha:BASE});
 const result=await pending;assert.equal(result.status,409,result.text);
});

test('a failure after ordinary dispatch creation rolls back card, journal, marker, attempt and receipt together',async t=>{
 const f=await rig(t),original=f.db.insert.bind(f.db),before=effects(f);f.db.insert=(table,row)=>{if(table==='workflow_execution_attempts')throw new Error('Synthetic post-dispatch failure');return original(table,row);};
 t.after(()=>f.db.insert=original);const result=await f.start();assert.equal(result.status,500,result.text);assert.equal(effects(f),before);assert.equal(f.h.hub.offerFrame(f.options.steps[0].card_id),null);
 f.db.insert=original;assert.equal((await f.start()).status,200);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,1);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_receipts').n,1);
});
for(const bad of ['evidence-edit','manual-done','reviewer-revoke'])test(`predecessor ${bad} cannot become successor authority`,async t=>{
 const f=await rig(t),s=await f.start(),id=s.body.execution.id,{run}=await f.claim(f.options.steps[0].card_id),evidence=await f.complete(run);
 if(bad==='evidence-edit'){f.db.run("UPDATE evidence SET ref='CHANGED-AFTER-COMPLETE' WHERE id=?",evidence.code);const before=effects(f),r=await f.call('POST',`/api/cards/${run.card_id}/actions/approve_done`,{});assert.equal(r.status,403,r.text);assert.equal(effects(f),before);}
 if(bad==='manual-done'){f.db.run("UPDATE cards SET column_name='done',run_state='done' WHERE id=?",run.card_id);f.h.app.api.workflowExecutor.wake(id);}
 if(bad==='reviewer-revoke'){
  // Hold the board queue until after the human proof commits. The delayed
  // coordinator must inspect the reviewer credential again before admission.
  const service=f.h.app.api.workflowExecutor,wake=service.wake.bind(service);service.wake=()=>{};t.after(()=>service.wake=wake);
  const review=await f.call('POST',`/api/cards/${run.card_id}/actions/approve_done`,{},f.users.aadmin);assert.equal(review.status,200,review.text);
  f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',f.h.hub.iso(),f.users.aadmin.device_id);service.wake=wake;wake(id);
 }
 await settle();assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,1);assert.equal(f.h.hub.offerFrame(f.options.steps[1].card_id),null);
});
test('browser Start requires current session-specific triple hashes and CSRF; a device preview cannot grant the browser authority',async t=>{
 const f=await rig(t),web=await f.h.webSignIn(f.users.amember.email),path=`/api/workflow-plans/${f.plan.id}/start`,before=effects(f);
 const call=(method,url,body,csrf)=>f.h.call(method,url,{cookie:web.cookie,body,headers:{origin:f.h.base,...(csrf?{'x-csrf-token':csrf}:{})}});
 assert.equal((await call('POST',path,f.startInput)).status,403);assert.equal((await call('POST',path,f.startInput,web.csrf)).status,409);assert.equal(effects(f),before);
 const preview=await call('POST',`/api/workflow-plans/${f.plan.id}/execution-preview`,{request_id:randomUUID(),plan_hash:f.plan.hash,purpose:'start',declared_paths:f.paths},web.csrf);assert.equal(preview.status,200,preview.text);const p=preview.body.execution_preview;
 const result=await call('POST',path,{...f.startInput,request_id:randomUUID(),execution_preview_id:p.id,execution_preview_hash:p.hash,path_intent_hash:p.path_intent_hash},web.csrf);assert.equal(result.status,200,result.text);
});
test('fixed verified base lookup encodes only a bounded captured ref; malformed refs make no outbound request',async()=>{
 const paths=[],client=createGitHub({fetchImpl:async url=>{paths.push(url);return {status:200,ok:true,json:async()=>({sha:BASE})};}});
 assert.deepEqual(await client.getBaseCommit('github.com/shared/app','feature/review'),{sha:BASE});assert.match(paths[0],/\/commits\/feature%2Freview$/);
 for(const ref of ['../main','main..next','main//next','main.lock','main@{1}','refs/*','x'.repeat(201)])assert.equal(await client.getBaseCommit('github.com/shared/app',ref),null);
 assert.equal(await client.getBaseCommit('github.com/shared/app/other','main'),null);assert.equal(paths.length,1);
});

test('eight paid attempts is a hard bound; no ninth preview, launch, receipt or ordinary side effect',async t=>{
 const f=await rig(t),s=await f.start(),id=s.body.execution.id;let request=f.db.get('SELECT dispatch_id FROM workflow_execution_attempts').dispatch_id;
 for(let attempt=1;attempt<=8;attempt++){
  const offer=await f.r.next('offer',o=>o.request_id===request),claimed=await f.r.claim(offer);assert.equal(claimed.ok,true);const run={...claimed,card_id:offer.card_id,repo_id:f.A.repo};
  await f.r.out({...runMsg(run),kind:'prep.failed',cause:'Synthetic bounded attempt'});await settle();const a=f.db.get('SELECT * FROM workflow_execution_attempts WHERE execution_id=? ORDER BY attempt DESC LIMIT 1',id);assert.equal(a.attempt,attempt);
  if(attempt<8){const retry=await control(f,id,'retry',{position:0,previous_attempt_id:a.id}),result=await f.call('POST',`/api/workflow-executions/${id}/steps/0/retry`,retry);assert.equal(result.status,200,result.text);request=f.db.get('SELECT dispatch_id FROM workflow_execution_attempts WHERE execution_id=? ORDER BY attempt DESC LIMIT 1',id).dispatch_id;}
 }
 const a=f.db.get('SELECT * FROM workflow_execution_attempts WHERE execution_id=? ORDER BY attempt DESC LIMIT 1',id),row=f.db.get('SELECT revision FROM workflow_executions WHERE id=?',id),before=effects(f);
 const refused=await f.call('POST',`/api/workflow-executions/${id}/preview`,{request_id:randomUUID(),source_plan_id:f.plan.id,plan_hash:f.plan.hash,purpose:'retry',expected_revision:row.revision,declared_paths:f.paths,position:0,previous_attempt_id:a.id});assert.equal(refused.status,409,refused.text);assert.equal(effects(f),before);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',id).n,8);
});
test('128 durable receipt cap rolls a new Pause back atomically while current existing receipt remains replayable',async t=>{
 const f=await rig(t),s=await f.start(),id=s.body.execution.id,first=f.db.get('SELECT * FROM workflow_execution_receipts WHERE execution_id=?',id);
 f.db.tx(()=>{for(let i=1;i<128;i++)f.db.insert('workflow_execution_receipts',{...first,request_id:randomUUID()});});const before=effects(f);
 const result=await f.call('POST',`/api/workflow-executions/${id}/pause`,{request_id:randomUUID(),expected_revision:0});assert.equal(result.status,403,result.text);assert.equal(result.body.error.code,'QUOTA_EXCEEDED');assert.equal(effects(f),before);assert.ok(f.h.hub.offerFrame(f.options.steps[0].card_id));assert.equal((await f.start()).status,200);
});
test('closed Start and control HTTP schema rejects extra or oversized JSON with zero effects',async t=>{
 const f=await rig(t),before=effects(f);assert.equal((await f.start({...f.startInput,authorization:{owned:true}})).status,400);assert.equal((await f.start({...f.startInput,unknown:'x'.repeat(33000)})).status,413);assert.equal(effects(f),before);
 const s=await f.start(),id=s.body.execution.id,after=effects(f);assert.equal((await f.call('POST',`/api/workflow-executions/${id}/pause`,{request_id:randomUUID(),expected_revision:0,dispatch:true})).status,400);assert.equal(effects(f),after);
});

test('revoking the predecessor reviewer after a successor offer also fences its actual claim and token replay',async t=>{
 const f=await rig(t),s=await f.start(),{run}=await f.claim(f.options.steps[0].card_id);await f.complete(run);
 assert.equal((await f.call('POST',`/api/cards/${run.card_id}/actions/approve_done`,{},f.users.aadmin)).status,200);
 const offer=await f.r.next('offer',o=>o.card_id===f.options.steps[1].card_id);f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',f.h.hub.iso(),f.users.aadmin.device_id);
 assert.equal(f.h.hub.offerFrame(offer.card_id),null);const denied=await f.r.claim(offer);assert.equal(denied.ok,false);assert.equal(denied.run_token,undefined);assert.equal(f.db.get('SELECT count(*) n FROM runs WHERE card_id=?',offer.card_id).n,0);
 const status=await f.call('GET',`/api/workflow-executions/${s.body.execution.id}`);assert.equal(status.status,200,status.text);assert.equal(status.body.execution.authorization_current,false);assert.ok(status.body.execution.steps[1].blocked_reasons.includes('PREDECESSOR_REVIEW_REQUIRED'));
 assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',s.body.execution.id).n,2,'already committed offer remains observed, never an invented rollback');
});
test('owned open PR status remains visible; closing it requires human Retry and cannot release a successor',async t=>{
 const f=await rig(t),s=await f.start(),{run}=await f.claim(f.options.steps[0].card_id);await f.complete(run,{pr:true});
 await f.h.hub.pollMerges();assert.equal(f.h.hub.prStatus.get(run.card_id).state,'open');
 f.pulls.set(1,{...f.pulls.get(1),state:'closed',merged:false});await f.h.hub.pollMerges();await settle();assert.equal(f.h.hub.card(run.card_id).run_state,null);assert.equal(f.h.hub.card(run.card_id).column_name,'todo');assert.equal(f.db.get('SELECT state FROM workflow_execution_attempts WHERE execution_id=?',s.body.execution.id).state,'failed');assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts').n,1);
 const a=f.db.get('SELECT * FROM workflow_execution_attempts WHERE execution_id=?',s.body.execution.id),retry=await control(f,s.body.execution.id,'retry',{position:0,previous_attempt_id:a.id});assert.equal((await f.call('POST',`/api/workflow-executions/${s.body.execution.id}/steps/0/retry`,retry)).status,200);
});

test('the whole captured base lookup set owns its ten-second deadline even when injected clients never settle',async t=>{
 const f=await rig(t);let calls=0;f.github.getBaseCommit=()=>{calls++;return new Promise(()=>{});};const before=effects(f),start=performance.now();
 const result=await f.call('POST',`/api/workflow-plans/${f.plan.id}/execution-preview`,{request_id:randomUUID(),plan_hash:f.plan.hash,purpose:'start',declared_paths:f.paths});
 assert.equal(result.status,200,result.text);assert.ok(performance.now()-start<12_000);assert.equal(calls,2);assert.ok(result.body.execution_preview.blocked_reasons.includes('BASE_REVIEW_REQUIRED'));assert.equal(effects(f),before);
});

test('a merged PR omitted from the exact completion evidence cannot substitute for the selected predecessor proof',async t=>{
 const f=await rig(t),s=await f.start(),{run}=await f.claim(f.options.steps[0].card_id);
 f.pulls.set(1,{number:1,head_ref:run.branch,head_repo_id:100,base_repo_id:100,base_ref:'main',head_sha:HEAD,merged:false,state:'open',html_url:'https://github.com/shared/app/pull/1'});
 assert.equal((await f.r.rpc(run,'board_attach_evidence',{kind:'pr',ref:'1'})).result.verification,'hub_verified');await f.complete(run);
 f.pulls.set(1,{...f.pulls.get(1),merged:true,state:'closed',merge_commit_sha:MERGE});await f.h.hub.pollMerges();await settle();assert.equal(f.db.get("SELECT count(*) n FROM workflow_execution_proofs WHERE kind='verified_merge'").n,0);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',s.body.execution.id).n,1);
});

test('synthetic capped-provider metadata preserves the exact ordinary budget choice and current capability gate without invoking any provider',async t=>{
 const f=await rig(t,{ai:'claude',budget_usd:3}),s=await f.start();assert.equal(s.status,200,s.text);const id=s.body.execution.id,offer=await f.r.next('offer');assert.equal(offer.budget_usd,3);
 const d=f.db.get('SELECT * FROM dispatches WHERE request_id=?',offer.request_id),a=f.db.get('SELECT * FROM workflow_execution_attempts WHERE execution_id=?',id);assert.equal(d.ai,'claude');assert.equal(d.budget_mode,'cap');assert.equal(d.budget_cents,300);assert.equal(a.budget_cents,300);
 const conn=f.h.hub.runners.get(f.r.welcome.device_id);conn.ai[0].capabilities.budget='none';assert.equal(f.h.hub.offerFrame(offer.card_id),null);assert.equal((await f.r.claim(offer)).ok,false);assert.equal(f.db.get('SELECT count(*) n FROM runs WHERE card_id=?',offer.card_id).n,0);
 conn.ai[0].capabilities.budget='native';const claimed=await f.r.claim(offer);assert.equal(claimed.ok,true);assert.equal(f.h.hub.run(claimed.run_id).budget_cents,300);assert.equal(f.h.hub.run(claimed.run_id).base_ref,BASE);
 assert.equal((await f.call('GET',`/api/workflow-executions/${id}`)).body.execution.authorization_current,true);
});

for(const changed of ['boot','revision','credential','evidence'])test(`a pending trusted merge lookup cannot inherit changed ${changed} authority after its await`,async t=>{
 const f=await rig(t),s=await f.start(),id=s.body.execution.id,{run}=await f.claim(f.options.steps[0].card_id),e=await f.complete(run,{pr:true});let release,entered=false;
 f.github.getPull=()=>{entered=true;return new Promise(r=>release=r);};const pending=f.h.hub.pollMerges();await until(()=>entered);
 if(changed==='boot')f.h.hub.boot();if(changed==='revision')await f.call('POST',`/api/workflow-executions/${id}/pause`,{request_id:randomUUID(),expected_revision:0});
 if(changed==='credential')f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',f.h.hub.iso(),f.users.amember.device_id);if(changed==='evidence')f.db.run("UPDATE evidence SET summary='CHANGED' WHERE id=?",e.code);
 const before=effects(f);release({...f.pulls.get(1),merged:true,state:'closed',merge_commit_sha:MERGE});await pending;assert.equal(effects(f),before);assert.equal(f.db.get("SELECT count(*) n FROM workflow_execution_proofs WHERE kind='verified_merge'").n,0);
});

test('a failure after actual owned run binding rolls the claim back without an alternate run or token, then exact intent can retry',async t=>{
 const f=await rig(t),s=await f.start(),offer=await f.r.next('offer'),core=f.h.hub.workflowGuard,created=core.created.bind(core),before=effects(f);
 core.created=(...args)=>{created(...args);throw new HubError('CONFLICT','Synthetic binding failure');};t.after(()=>core.created=created);
 const failed=await f.r.claim(offer);assert.equal(failed.ok,false);assert.equal(failed.run_token,undefined);assert.equal(effects(f),before);assert.equal(f.db.get('SELECT count(*) n FROM runs WHERE card_id=?',offer.card_id).n,0);
 core.created=created;const retry=await f.r.claim(offer);assert.equal(retry.ok,true);assert.equal(f.db.get('SELECT count(*) n FROM runs WHERE card_id=?',offer.card_id).n,1);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',s.body.execution.id).n,1);
});
test('actual restore bump and runner reconnect retain observed lineage without a new paid intent or claimed replay token',async t=>{
 const f=await rig(t),s=await f.start(),{offer,run}=await f.claim(f.options.steps[0].card_id),count=f.db.get('SELECT count(*) n FROM dispatches').n;
 f.h.hub.config.restore=true;f.h.hub.boot();assert.equal(f.db.get('SELECT state FROM workflow_executions WHERE id=?',s.body.execution.id).state,'paused_boot');assert.ok(f.h.hub.card(run.card_id).fence>run.fence);
 f.r.send({type:'claim',id:'restore-fenced',card_id:offer.card_id,request_id:offer.request_id,expected_fence:offer.fence});await f.r.closed();assert.equal(f.r.all('claim.result').filter(m=>m.re==='restore-fenced'&&m.run_token).length,0);assert.equal(f.db.get('SELECT count(*) n FROM dispatches').n,count);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',s.body.execution.id).n,1);
 // A real WS replacement reports its still-existing child. Accounts restore
 // invalidates the old enrollment epoch, so this hello is refused before a
 // welcome, token or offer; it never adopts or restarts the observed child.
 const r=new FakeRunner(f.h.base,{device_id:f.r.welcome.device_id,device_token:f.r.dev.device_token,team:f.A.team});t.after(()=>r.terminate());await r.open();r.send({type:'hello',protocol:1,device_id:r.dev.device_id,runner_version:'test',outbox_head_seq:0,runs:[{run_id:run.run_id,card_id:run.card_id,fence:run.fence}]});
 assert.equal(await r.closed(),4401);assert.equal(r.all('welcome').length,0);assert.equal(r.all('offer').length,0);assert.equal(f.h.hub.offerFrame(run.card_id),null);assert.equal(f.db.get('SELECT count(*) n FROM dispatches').n,count);
});

async function reviewedSuccessors(t,count=1){
 const first=await rig(t),fixtures=[first],service=first.h.app.api.workflowExecutor,wake=service.wake.bind(service);
 for(let i=1;i<count;i++)fixtures.push(await rig(t,{reuse:first}));
 const ids=[];for(const f of fixtures){const started=await f.start();assert.equal(started.status,200,started.text);ids.push(started.body.execution.id);}
 await until(()=>!service.draining);service.wake=()=>{};t.after(()=>service.wake=wake);
 for(const f of fixtures){const {run}=await f.claim(f.options.steps[0].card_id);await f.complete(run);
  const reviewed=await f.call('POST',`/api/cards/${run.card_id}/actions/approve_done`,{});assert.equal(reviewed.status,200,reviewed.text);
 }
 service.wake=wake;return {fixtures,first,service,ids};
}
async function heldCoordinator(t,f,id){
 let release;const held=f.h.hub.withBoard(f.A.board,()=>new Promise(resolve=>release=resolve));
 await new Promise(resolve=>setImmediate(resolve));t.after(()=>release());f.h.app.api.workflowExecutor.wake(id);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.h.app.api.workflowExecutor.draining,true);
 return async()=>{release();await held;await until(()=>!f.h.app.api.workflowExecutor.draining);};
}
test('two actual reviewed workflows retain a wake received during a held queue and both admit their exact successor once',async t=>{
 const {first,service,ids}=await reviewedSuccessors(t,2),release=await heldCoordinator(t,first,ids[0]);
 service.wake(ids[1]);service.wake(ids[1]);await release();
 assert.deepEqual(ids.map(id=>first.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',id).n),[2,2]);
 assert.equal(service.pending.size,0);assert.equal(first.db.get('SELECT count(*) n FROM workflow_execution_receipts').n,2);
 for(const id of ids)assert.equal(first.db.get('SELECT count(*) n FROM workflow_owned_intents WHERE execution_id=? AND disabled=0 AND run_id IS NULL',id).n,1);
});
test('closing an actual coordinator while its board queue is held performs no later launch or pause effects',async t=>{
 const {first,service,ids}=await reviewedSuccessors(t),release=await heldCoordinator(t,first,ids[0]),before=effects(first);
 service.close();await release();service.wake(ids[0]);await settle();
 assert.equal(effects(first),before);assert.equal(service.pending.size,0);assert.equal(service.draining,false);
});
test('a queued observed wake rechecks the original current credential before successor admission',async t=>{
 const {first,service,ids}=await reviewedSuccessors(t),release=await heldCoordinator(t,first,ids[0]);
 const dispatches=first.db.get('SELECT count(*) n FROM dispatches').n;
 first.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',first.h.hub.iso(),first.users.amember.device_id);
 await release();assert.equal(first.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',ids[0]).n,1);
 assert.equal(first.db.get('SELECT count(*) n FROM dispatches').n,dispatches);assert.equal(first.db.get('SELECT state FROM workflow_executions WHERE id=?',ids[0]).state,'blocked');
 assert.equal(service.pending.size,0);
});
