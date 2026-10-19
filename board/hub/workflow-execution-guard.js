// One server-only owned lineage gate. JSON, ordinary API credentials, runner
// reports and a missing private parent cannot create an execution capability.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash,randomUUID } from 'node:crypto';
import { HubError,json } from './db.js';
import { canonical } from '../shared/workflow-execution.js';
import { pathOverlap } from '../shared/workflow-execution-controls.js';
import { runnerConnectionProblem } from './runner-authority.js';
import { readiness } from '../shared/ai.js';

export const executionHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
export const sourceFields=card=>({title:card.title,body:card.body,acceptance:card.acceptance,labels:card.labels,repo_id:card.repo_id,base_ref:card.base_ref,budget_cents:card.budget_cents});
const stateFields=card=>({version:card.version,fence:card.fence,run_state:card.run_state,column_name:card.column_name,active_run_id:card.active_run_id,archived_at:card.archived_at});
const launch=new Set(['dispatch','retry','redispatch','request_changes','take_myself']);
const manual=new Set([...launch,'take_over','hand_over','stop','cancel']);
const blocked=()=>new HubError('POLICY_DENIED','Workflow launch requires a fresh reviewed human control. No new attempt was authorized.');

export class WorkflowExecutionGuard {
 #scope=new AsyncLocalStorage();
 #mergeCaptures=new WeakMap();
 constructor(hub){this.hub=hub;this.db=hub.db;this.service=null;}
 attach(service){if(!this.service)this.service=service;}
 marker(requestId){return requestId?this.db.get('SELECT * FROM workflow_owned_intents WHERE request_id=?',requestId):null;}
 runMarker(runId){return runId?this.db.get('SELECT * FROM workflow_owned_intents WHERE run_id=?',runId):null;}
 lastMarker(cardId){return this.marker(this.hub.lastDispatch(cardId)?.request_id);}
 executionFor(cardId){return this.db.get(`SELECT e.*,s.position FROM workflow_executions e JOIN workflow_execution_steps s ON s.execution_id=e.id
  WHERE s.card_id=? AND e.state NOT IN ('cancelled','completed')`,cardId);}
 sourceHmac(card){return this.hub.refHash(canonical(sourceFields(card)));}
 stateHmac(card){return this.hub.refHash(canonical(stateFields(card)));}
 binding(executionId,position){return this.db.get('SELECT * FROM workflow_step_bindings WHERE execution_id=? AND position=?',executionId,position);}
 bind(executionId,position,card){
  this.db.run('UPDATE workflow_execution_steps SET version=?,fence=? WHERE execution_id=? AND position=?',card.version,card.fence,executionId,position);
  const row={execution_id:executionId,position,version:card.version,fence:card.fence,source_hmac:this.sourceHmac(card),state_hmac:this.stateHmac(card)};
  if(this.binding(executionId,position))this.db.run('UPDATE workflow_step_bindings SET version=?,fence=?,source_hmac=?,state_hmac=? WHERE execution_id=? AND position=?',row.version,row.fence,row.source_hmac,row.state_hmac,executionId,position);
  else this.db.insert('workflow_step_bindings',row);
 }
 currentHuman(){const context=this.#scope.getStore();if(!context?.human||!this.service||this.hub.viaScope.getStore())throw blocked();
  return {...context,member:this.service.plans.principal(context.actor,context.cred,true)};}
 human(member,cred,fn){return this.#scope.run({human:true,actor:{id:member.id,user_id:member.user_id,org_id:member.org_id},cred:cred&&{kind:cred.kind,id:cred.id}},fn);}
 owned(executionId,revision,fn,intent){if(!this.service||!intent)throw blocked();this.service.authority(executionId,revision);
  return this.#scope.run({owned:true,executionId,revision,intent:Object.freeze({...intent})},fn);}
 completion(run,evidenceIds,fn){return this.#scope.run({completion:{run_id:run.id,fence:run.fence,evidence_ids:[...evidenceIds]}},fn);}
 merge(record,fn){return this.#scope.run({merge:record},fn);}
 pause(id,state='paused_authority'){
  const row=this.db.get('SELECT * FROM workflow_executions WHERE id=?',id);if(!row||['cancelled','completed'].includes(row.state))return;
  if(row.state==='authorized')this.db.run('UPDATE workflow_executions SET state=?,revision=revision+1 WHERE id=?',state,id);
  else this.db.run('UPDATE workflow_executions SET state=? WHERE id=?',state,id);
  this.db.run('UPDATE workflow_owned_intents SET disabled=1 WHERE execution_id=? AND run_id IS NULL',id);
  this.db.run("UPDATE workflow_execution_attempts SET state='failed' WHERE execution_id=? AND state='pending' AND run_id IS NULL",id);
  this.db.run("UPDATE workflow_execution_steps SET state='pending' WHERE execution_id=? AND state='queued' AND card_id IN (SELECT card_id FROM workflow_owned_intents WHERE execution_id=? AND run_id IS NULL AND disabled=1)",id,id);
  this.hub.later(()=>{for(const {card_id} of this.db.all('SELECT card_id FROM workflow_owned_intents WHERE execution_id=? AND disabled=1',id))this.hub.withdrawOffers(card_id,null,'workflow paused');});
 }
 edit(cardId){const e=this.executionFor(cardId);if(e)this.pause(e.id,'blocked');}
 authority(marker,conn=null){
  if(!marker||marker.disabled||!this.service)throw blocked();
  const current=this.service.authority(marker.execution_id),attempt=this.db.get('SELECT * FROM workflow_execution_attempts WHERE dispatch_id=?',marker.request_id);
  if(!attempt||attempt.execution_id!==current.row.id||attempt.authorization_revision!==current.row.revision||attempt.state!==(marker.run_id?'claimed':'pending'))throw blocked();
  const step=current.snapshot.steps[attempt.position];
  if(!step||step.card_id!==marker.card_id||step.target_member_id!==attempt.target_member_id||step.target_user_id!==attempt.target_user_id||step.ai!==attempt.provider)throw blocked();
  if(current.snapshot.options.dependencies.some(([from,to])=>to===attempt.position&&!this.service.predecessor(current.row.id,from)))throw blocked();
  if(conn&&!this.ready(conn,step,current.row.repo_id))throw blocked();
  return {current,attempt,step};
 }
 ready(conn,step,repoId){
  if(runnerConnectionProblem(this.hub,conn)||conn.member_id!==step.target_member_id||!conn.repos.has(repoId))return false;
  const enrollment=this.db.get('SELECT * FROM runner_enrollments WHERE id=?',conn.enrollmentId),owner=enrollment&&this.db.get('SELECT user_id FROM user_devices WHERE id=?',enrollment.user_device_id),provider=conn.ai?.find(a=>a.id===step.ai);
  return !!(enrollment?.user_id===step.target_user_id&&owner?.user_id===step.target_user_id&&provider&&!provider.legacy&&provider.startable===true&&provider.installed===true&&provider.signedIn===true&&readiness(provider)===null
   &&['native','metered','none'].includes(provider.capabilities?.budget)&&typeof provider.capabilities?.resume==='boolean'
   &&(step.budget_usd===null||provider.capabilities.budget!=='none'));
 }
 offer(cardId,conn=null){const d=this.hub.pendingDispatch(cardId),marker=this.marker(d?.request_id);if(!marker)return true;
  try{this.authority(marker,conn);return true;}catch{return false;}}
 claim(requestId,conn){const marker=this.marker(requestId);if(!marker)return true;try{this.authority(marker,conn);return true;}catch{return false;}}
 base(requestId){const marker=this.marker(requestId);if(!marker)return null;const {current,attempt}=this.authority(marker);return current.authorization.base_commits[attempt.position].sha;}
 canRequeue(cardId){return !this.lastMarker(cardId);}
 cleanupCancel(member,card){
  const context=this.#scope.getStore(),d=this.hub.lastDispatch(card.id),marker=this.marker(d?.request_id),run=d?.run_id&&this.hub.run(d.run_id);
  // Ordinary queued cleanup normally has a pending dispatch. Owned failure
  // deliberately creates none; a fresh reviewed control may clean only its
  // exact ended/unclaimed old intent using the ordinary involved actor rule.
  return !!(context?.owned&&marker?.execution_id===context.executionId&&(!run||run.ended_at)&&!card.active_run_id
   &&(this.hub.isAdmin(member)||d.dispatched_by===member.id||this.hub.assignees(card.id).includes(member.id)));
 }
 before(row,event,{device=null}={},commit=false){
  const context=this.#scope.getStore(),requested=this.marker(event.request_id),pending=this.marker(this.hub.pendingDispatch(row.id)?.request_id),runMarker=this.runMarker(row.active_run_id);
  const e=this.executionFor(row.id),owned=pending??runMarker??this.lastMarker(row.id);
  // This happens before state-machine duplicate_request and claimed replay.
  if(requested&&(!context?.owned||requested.execution_id!==context.executionId))throw blocked();
  if(launch.has(event.type)){
   if(context?.owned){const current=this.service.authority(context.executionId,context.revision),choice=current.snapshot.steps.find(s=>s.card_id===row.id);
    if(!choice||context.intent.card_id!==row.id||context.intent.request_id!==event.request_id||event.ai!==choice.ai||event.target_member_id!==choice.target_member_id
     ||event.budget_mode!==(choice.budget_usd===null?'none':'cap')||event.budget_cents!==(choice.budget_usd===null?null:Math.round(choice.budget_usd*100)))throw blocked();}
   else if(owned||e){this.currentHuman();if(commit&&e)this.pause(e.id,'blocked');}
  }
  let claim=null;
  if(event.type==='claim'&&pending){const conn=device&&this.hub.runners.get(device.id);claim=this.authority(pending,conn);}
  if(manual.has(event.type)&&!context?.owned&&(owned||e)){this.currentHuman();if(commit&&e)this.pause(e.id,'blocked');}
  if(event.type==='answer'&&owned){this.currentHuman();}
  if(event.type==='complete'&&runMarker){const c=context?.completion;if(!c||c.run_id!==row.active_run_id||c.fence!==row.fence)throw blocked();}
  if(event.type==='approve_done'&&owned){this.currentHuman();this.reviewable(owned);}
  if(event.type==='pr_merged'&&owned&&!context?.merge)throw blocked();
  return claim?{attempt:claim.attempt,marker:pending,base_sha:claim.current.authorization.base_commits[claim.attempt.position].sha}:null;
 }
 effectAllowed(effect,env){
  const marker=this.runMarker(env.runId)??this.lastMarker(env.row.id);
  if(!marker)return true;
  if(['offer_to_runners','seed','follow_up'].includes(effect.type)&&!this.#scope.getStore()?.owned)return false;
  return true;
 }
 created(env,d,runId){const marker=this.marker(d.request_id);if(!marker)return;
  const attempt=env.workflow?.attempt;if(!attempt||env.workflow.marker.request_id!==d.request_id)throw blocked();
  this.db.run("UPDATE workflow_execution_attempts SET run_id=?,fence=?,state='claimed' WHERE id=?",runId,env.res.card.fence,attempt.id);
  this.db.run('UPDATE workflow_owned_intents SET run_id=?,fence=? WHERE request_id=?',runId,env.res.card.fence,d.request_id);
  this.db.run("UPDATE workflow_execution_steps SET state='running' WHERE execution_id=? AND position=?",attempt.execution_id,attempt.position);
 }
 proof(attempt,kind,snapshot,card){const bytes=canonical(snapshot);if(Buffer.byteLength(bytes)>32768)throw new HubError('PAYLOAD_TOO_LARGE','Workflow proof exceeds 32 KiB.');
  this.db.insert('workflow_execution_proofs',{id:randomUUID(),attempt_id:attempt.id,kind,run_id:attempt.run_id,fence:attempt.fence,card_version:card.version,source_epoch:this.hub.epoch,snapshot:bytes,snapshot_hash:executionHash(snapshot)});}
 reviewable(marker){
  const a=this.db.get('SELECT * FROM workflow_execution_attempts WHERE dispatch_id=?',marker.request_id),card=this.hub.card(marker.card_id),p=a&&this.db.get("SELECT * FROM workflow_execution_proofs WHERE attempt_id=? AND kind='complete' ORDER BY rowid DESC LIMIT 1",a.id);
  if(!a||a.state!=='completed'||!p||p.run_id!==a.run_id||p.fence!==card.fence||p.card_version!==card.version||card.run_state!=='in_review')throw blocked();
  const saved=json(p.snapshot,null);if(!saved||executionHash(saved)!==p.snapshot_hash||saved.repo_hmac!==this.hub.refHash(this.hub.repo(card.repo_id)?.canonical_url))throw blocked();
  if(!this.evidenceCurrent(saved,a))throw blocked();
  const binding=this.binding(a.execution_id,a.position);if(!binding||binding.source_hmac!==this.sourceHmac(card)||binding.state_hmac!==this.stateHmac(card))throw blocked();
  return a;
 }
 after(env){
  const context=this.#scope.getStore(),marker=this.runMarker(env.newRunId??env.runId)??this.marker(env.event.request_id)??this.lastMarker(env.row.id);
  if(!marker)return;
  const a=this.db.get('SELECT * FROM workflow_execution_attempts WHERE dispatch_id=?',marker.request_id);if(!a)return; // erased private history stays fenced
  const card=this.hub.card(env.row.id),binding=this.binding(a.execution_id,a.position);
  // A manual source edit or replacement run is never silently adopted.
  if(binding&&binding.source_hmac!==this.sourceHmac(env.row)&&!context?.owned){this.pause(a.execution_id,'blocked');return;}
  if(context?.human&&manual.has(env.event.type)){
   // Exact current-run cleanup remains observed, but detached replacement
   // choices never become the workflow's reviewed source.
   if(['stop','cancel'].includes(env.event.type)){this.bind(a.execution_id,a.position,card);this.db.run("UPDATE workflow_execution_attempts SET state='failed' WHERE id=?",a.id);this.db.run("UPDATE workflow_execution_steps SET state='failed' WHERE execution_id=? AND position=?",a.execution_id,a.position);}
   return;
  }
  this.bind(a.execution_id,a.position,card);
  if(context?.owned&&['cancel','stop','dispatch','retry','redispatch'].includes(env.event.type))return;
  if(env.event.type==='complete'){
   const ids=context.completion.evidence_ids;
   this.db.run("UPDATE workflow_execution_attempts SET state='completed' WHERE id=?",a.id);
   this.db.run("UPDATE workflow_execution_steps SET state='awaiting_review' WHERE execution_id=? AND position=?",a.execution_id,a.position);
   const run=this.hub.run(a.run_id);
   this.proof({...a,state:'completed'},'complete',{evidence_ids:ids,evidence_bindings:ids.map(id=>({id,hmac:this.hub.refHash(canonical(this.db.get('SELECT * FROM evidence WHERE id=?',id)))})),
    repo_hmac:this.hub.refHash(this.hub.repo(card.repo_id)?.canonical_url),base_sha:run.base_ref,branch:run.branch,device_id:run.device_id,before_version:env.row.version,dispatch_id:a.dispatch_id},card);
  }else if(env.event.type==='approve_done'){
   const human=this.currentHuman();this.proof(a,'human_review',{reviewer:{member_id:human.member.id,user_id:human.member.user_id,credential:human.cred},dispatch_id:a.dispatch_id},card);
   this.db.run("UPDATE workflow_execution_steps SET state='completed' WHERE execution_id=? AND position=?",a.execution_id,a.position);
  }else if(env.event.type==='pr_merged'){
   this.proof(a,'verified_merge',context.merge,card);this.db.run("UPDATE workflow_execution_steps SET state='completed' WHERE execution_id=? AND position=?",a.execution_id,a.position);
  }else if(env.event.type==='pr_closed'){
   this.db.run("UPDATE workflow_execution_attempts SET state='failed' WHERE id=?",a.id);this.db.run("UPDATE workflow_execution_steps SET state='failed' WHERE execution_id=? AND position=?",a.execution_id,a.position);this.pause(a.execution_id,'blocked');
  }else if(this.hub.run(a.run_id)?.ended_at&&a.state==='claimed'){
   const uncertain=['prep_failed','claim_timeout','park_timeout','handover_complete','handover_timeout','hub_boot'].includes(env.event.type);
   this.db.run('UPDATE workflow_execution_attempts SET state=? WHERE id=?',uncertain?'uncertain':'failed',a.id);
   this.db.run("UPDATE workflow_execution_steps SET state='failed' WHERE execution_id=? AND position=?",a.execution_id,a.position);
   this.pause(a.execution_id,'blocked');
  }else if(env.event.type==='decline'||env.event.type==='cancel'){
   this.db.run("UPDATE workflow_execution_attempts SET state='failed' WHERE id=? AND state='pending'",a.id);
   this.db.run("UPDATE workflow_execution_steps SET state='failed' WHERE execution_id=? AND position=?",a.execution_id,a.position);
   this.pause(a.execution_id,'blocked');
  }
  this.hub.later(()=>this.service?.wake(a.execution_id));
 }
 selectedEvidence(run,ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>32||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'))throw blocked();
  const records=this.db.all(`SELECT * FROM evidence WHERE card_id=? AND run_id=? AND id IN (${ids.map(()=>'?').join(',')})`,run.card_id,run.id,...ids);
  if(records.length!==ids.length||run.repo_id!==this.hub.card(run.card_id)?.repo_id)throw blocked();
  const code=records.some(e=>e.verification==='hub_verified'&&(e.kind==='commit'||e.kind==='pr'&&this.db.get('SELECT 1 x FROM workflow_verified_pr WHERE evidence_id=? AND run_id=?',e.id,run.id)));
  if(!code||!records.some(e=>e.kind==='test_run'&&e.result==='pass'||e.kind==='no_tests_reason'))throw blocked();
 }
 evidenceCurrent(saved,attempt){
  const run=this.hub.run(attempt.run_id),auth=this.db.get('SELECT * FROM workflow_execution_authorizations WHERE execution_id=? AND revision=?',attempt.execution_id,attempt.authorization_revision),authorization=auth&&json(auth.snapshot,null);
  if(!run||!authorization||executionHash(authorization)!==auth.snapshot_hash||run.base_ref!==authorization.base_commits?.[attempt.position]?.sha||run.base_ref!==saved.base_sha||run.branch!==saved.branch||run.device_id!==saved.device_id||saved.dispatch_id!==attempt.dispatch_id
   ||!Array.isArray(saved.evidence_bindings)||saved.evidence_bindings.length!==saved.evidence_ids?.length)return false;
  return saved.evidence_bindings.every(binding=>{const e=this.db.get('SELECT * FROM evidence WHERE id=?',binding.id);return e&&e.run_id===attempt.run_id&&e.card_id===run.card_id&&this.hub.refHash(canonical(e))===binding.hmac;});
 }
 declared(run,paths){const marker=this.runMarker(run.id),a=marker&&this.db.get('SELECT * FROM workflow_execution_attempts WHERE dispatch_id=?',marker.request_id);if(!a)return;
  const auth=this.db.get('SELECT snapshot FROM workflow_execution_authorizations WHERE execution_id=? AND revision=?',a.execution_id,a.authorization_revision),snapshot=json(auth?.snapshot,null),envelope=snapshot?.declared_paths?.[a.position]?.paths;
  if(!envelope||paths.length>16||paths.some(p=>!envelope.some(q=>q===p||q.endsWith('/**')&&pathOverlap(q,p))))this.pause(a.execution_id,'blocked');
  const reviewed=this.db.get("SELECT snapshot FROM workflow_execution_proofs WHERE attempt_id=? AND kind='plan_review' ORDER BY rowid DESC LIMIT 1",a.id);
  if(reviewed&&canonical(json(reviewed.snapshot,{}).paths)!==canonical(paths))this.pause(a.execution_id,'blocked');
 }
 planAnswer(runId,permission,decision){const marker=this.runMarker(runId),a=marker&&this.db.get('SELECT * FROM workflow_execution_attempts WHERE dispatch_id=?',marker.request_id);if(!a)return;
  const human=this.currentHuman(),run=this.hub.run(runId),card=this.hub.card(run.card_id);
  if(decision!=='allow'){this.pause(a.execution_id,'blocked');return;}
  this.proof(a,'plan_review',{permission_id:permission.id,paths:json(run.planned_paths,[]),reviewer:{member_id:human.member.id,user_id:human.member.user_id,credential:human.cred}},card);
 }
 planAllowed(run,permission){
  const marker=this.runMarker(run.id);if(!marker)return true;
  const a=this.db.get('SELECT id FROM workflow_execution_attempts WHERE dispatch_id=?',marker.request_id),p=a&&this.db.get("SELECT * FROM workflow_execution_proofs WHERE attempt_id=? AND kind='plan_review' ORDER BY rowid DESC LIMIT 1",a.id),saved=p&&json(p.snapshot,null);
  if(!saved||executionHash(saved)!==p.snapshot_hash||p.run_id!==run.id||p.fence!==run.fence||saved.permission_id!==permission?.id||permission.answered_by!==saved.reviewer?.member_id||canonical(saved.paths)!==canonical(json(run.planned_paths,[])))return false;
  try{this.service.plans.principal({id:saved.reviewer.member_id,user_id:saved.reviewer.user_id,org_id:this.hub.board(this.hub.card(run.card_id).board_id).org_id},saved.reviewer.credential,true);return true;}catch{return false;}
 }
 resourceOwned(params){const permission=params.id&&this.db.get('SELECT run_id,card_id FROM permission_requests WHERE id=?',params.id),cardId=params.card_id??permission?.card_id;
  return !!(cardId&&(this.executionFor(cardId)||this.lastMarker(cardId)));
 }
 exactPull(run,pull,stored=null){const marker=this.runMarker(run.id),a=marker&&this.db.get('SELECT * FROM workflow_execution_attempts WHERE dispatch_id=?',marker.request_id);
  if(!a)return false;
  const storedAuth=this.db.get('SELECT * FROM workflow_execution_authorizations WHERE execution_id=? AND revision=?',a.execution_id,a.authorization_revision),auth=storedAuth&&json(storedAuth.snapshot,null),base=auth?.base_commits?.[a.position];
  return !!(base&&executionHash(auth)===storedAuth.snapshot_hash&&run.base_ref===base.sha&&pull?.head_ref===run.branch&&Number.isSafeInteger(pull.head_repo_id)&&pull.head_repo_id===pull.base_repo_id
   &&pull.base_ref===base.base_ref&&/^[0-9a-f]{40}$/.test(pull.head_sha??'')&&(!stored||stored.head_sha===pull.head_sha&&stored.head_repo_id===pull.head_repo_id&&stored.base_ref===pull.base_ref)
   &&(!pull.merged||/^[0-9a-f]{40}$/.test(pull.merge_commit_sha??'')));
 }
 captureMerge(row,evidence){
  const marker=this.runMarker(evidence.run_id),a=marker&&this.reviewable(marker);if(!a||!this.service)throw blocked();
  const execution=this.db.get('SELECT * FROM workflow_executions WHERE id=?',a.execution_id),auth=this.db.get('SELECT * FROM workflow_execution_authorizations WHERE execution_id=? ORDER BY revision DESC LIMIT 1',a.execution_id),saved=auth&&json(auth.snapshot,null);
  if(!execution||!saved||executionHash(saved)!==auth.snapshot_hash)throw blocked();
  const bound=this.service.bound({id:auth.issuer_member_id,user_id:auth.issuer_user_id,org_id:execution.org_id},{kind:auth.credential_kind,id:auth.credential_id},{boardIds:saved.selection},true),current=this.service.executionSource(bound,a.execution_id),token=Object.freeze({});
  this.#mergeCaptures.set(token,{bound,execution_id:a.execution_id,hash:current.execution.hash,epoch:this.hub.epoch,card_id:row.id,evidence_hmac:this.hub.refHash(canonical(evidence)),canonical_repo:this.hub.repo(row.repo_id)?.canonical_url});return token;
 }
 mergeCurrent(token,row,evidence){
  const captured=this.#mergeCaptures.get(token);if(!captured)throw blocked();this.#mergeCaptures.delete(token);
  const now=this.db.get('SELECT * FROM evidence WHERE id=?',evidence.id);
  if(captured.epoch!==this.hub.epoch||captured.card_id!==row.id||captured.canonical_repo!==this.hub.repo(row.repo_id)?.canonical_url
   ||captured.evidence_hmac!==this.hub.refHash(canonical(now))||this.service.executionSource(captured.bound,captured.execution_id).execution.hash!==captured.hash)throw blocked();
 }
 verifiedMerge(row,evidence,pull,canonicalRepo){
  const marker=this.runMarker(evidence.run_id);if(!marker)return null;
  const a=this.reviewable(marker),run=this.hub.run(a.run_id),stored=this.db.get('SELECT * FROM workflow_verified_pr WHERE evidence_id=?',evidence.id);
  const complete=this.db.get("SELECT snapshot FROM workflow_execution_proofs WHERE attempt_id=? AND kind='complete' ORDER BY rowid DESC LIMIT 1",a.id);
  if(!json(complete?.snapshot,{}).evidence_ids?.includes(evidence.id)||!stored||canonicalRepo!==this.hub.repo(row.repo_id)?.canonical_url||stored.repo_hmac!==this.hub.refHash(canonicalRepo)||!pull.merged||!this.exactPull(run,pull,stored))throw blocked();
  return {evidence_id:evidence.id,run_id:run.id,dispatch_id:a.dispatch_id,head_sha:pull.head_sha,merge_commit_sha:pull.merge_commit_sha,repo_hmac:stored.repo_hmac};
 }
}
