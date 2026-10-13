// Checkpoint1 saves inert previews only. No dispatch/action/permission/run API
// is imported here. Future execution needs a fresh human confirmation and its
// separately reviewed owned-intent/claim/requeue/completion guards.
import { createHash, randomUUID } from 'node:crypto';
import { HubError } from './db.js';
import { Workflows } from './workflows.js';
import { runnerConnectionProblem } from './runner-authority.js';
import { AI_LABELS, readiness } from '../shared/ai.js';
import { PLAN_APPROVAL_LABEL } from '../shared/states.js';
import { redactSecrets, hasCredential } from '../shared/secret-patterns.mjs';
import { canonical, validatePreview, WORKFLOW_PLAN_LIMITS as LIMITS, UUID } from '../shared/workflow-execution.js';
import { limitOrThrow } from './ratelimit.js';

const bindings=new WeakMap(),clocks=new WeakMap();
const missing=()=>new HubError('NOT_FOUND','Workflow preview is unavailable.');
const changed=()=>new HubError('CONFLICT','Workflow tasks or choices changed. Create a fresh preview.');
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const text=(value,max=200)=>redactSecrets(String(value??'')).replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,max);
const capture=(member,cred,options)=>({actor:Object.freeze({id:member?.id,user_id:member?.user_id,org_id:member?.org_id}),
 credential:cred&&Object.freeze({kind:cred.kind,id:cred.id}),
 selection:options.boardIds==null?null:Object.freeze([...options.boardIds])});

export class WorkflowExecutions {
 constructor(api){this.api=api;this.hub=api.hub;this.db=api.db;this.workflows=new Workflows(this.hub);this.time();}
 time(){
  const wall=this.hub.wallMs(),mono=this.hub.mono();
  if(!Number.isSafeInteger(wall)||!Number.isFinite(mono))throw changed();
  let clock=clocks.get(this.hub);if(!clock){clock={wall,mono,unsafe:false};clocks.set(this.hub,clock);}
  if(wall<clock.wall || mono<clock.mono)clock.unsafe=true;
  clock.wall=Math.max(clock.wall,wall);clock.mono=Math.max(clock.mono,mono);return {...clock};
 }
 principal(actor,cred,write=false){
  if(!this.hub.accounts || !cred || this.hub.viaScope.getStore())throw new HubError('UNAUTHENTICATED','Sign in with a current team account.');
  const member=this.workflows.staff(actor,cred,write);
  return member;
 }
 scope(bound,instanceId,write=false){
  const member=this.principal(bound.actor,bound.credential,write);
  const instance=this.db.get('SELECT i.* FROM workflow_instances i JOIN workflow_recipes w ON w.id=i.recipe_id WHERE i.id=? AND w.org_id=?',instanceId,member.org_id);
  if(!instance)throw missing();
  const board=this.api.boardFor(member,instance.board_id),recipe=this.db.get('SELECT * FROM workflow_recipes WHERE id=?',instance.recipe_id);
  if(board.archived_at || recipe.archived_at)throw changed();
  if(bound.selection!==null){
   if(!bound.selection.length || bound.selection.length>100 || new Set(bound.selection).size!==bound.selection.length
    || !bound.selection.includes(board.id))throw missing();
   for(const id of bound.selection)if(!UUID.test(id) || this.api.boardFor(member,id).archived_at)throw missing();
  }
  return {member,instance,board,version:this.workflows.version(instance.recipe_id,instance.recipe_version)};
 }
 choicePolicy(member,card,choice){
  const target=this.hub.activeMember(choice.target_member_id);
  if(!target || target.org_id!==member.org_id || !target.user_id || !this.hub.canWrite(target)
   || !this.hub.accounts.liveUser(target.user_id))throw missing();
  const max=this.hub.boardSettings(card.board_id).max_budget_usd;
  if(choice.ai==='codex' && choice.budget_usd!==null)throw new HubError('POLICY_DENIED','Codex has no native spend cap. Explicitly choose no budget.');
  if(choice.budget_usd===null && target.id!==member.id && !this.hub.isAdmin(member))throw new HubError('POLICY_DENIED','An uncapped teammate task requires its owner or an admin.');
  if(choice.budget_usd!==null && !this.hub.isAdmin(member) && Number.isFinite(max) && choice.budget_usd>max)throw new HubError('POLICY_DENIED','The chosen budget exceeds the current board maximum.');
  return target;
 }
 source(scope,body){
  if(scope.instance.board_id!==body.board_id || scope.instance.recipe_version!==body.recipe_version
   || scope.version.content_hash!==body.content_hash)throw changed();
  const repo=this.hub.repo(body.repo_id);
  if(!repo || repo.org_id!==scope.member.org_id || !this.db.get('SELECT 1 x FROM board_repos WHERE board_id=? AND repo_id=?',body.board_id,repo.id))throw missing();
  const rows=this.db.all('SELECT position,card_id FROM workflow_step_cards WHERE instance_id=? ORDER BY position',scope.instance.id);
  if(rows.length!==body.steps.length || rows.length!==scope.version.definition.steps.length)throw changed();
  const steps=body.steps.map((choice,index)=>{
   if(rows[index].position!==index || rows[index].card_id!==choice.card_id)throw changed();
   const card=this.hub.card(choice.card_id);
   if(!card || card.archived_at || card.board_id!==body.board_id || card.repo_id!==repo.id
    || card.version!==choice.version || card.fence!==choice.fence)throw changed();
   const planRequired=this.hub.labels(card).includes(PLAN_APPROVAL_LABEL);
   if(planRequired!==choice.plan_approval || scope.version.definition.steps[index].plan_approval && !planRequired)throw changed();
   const target=this.choicePolicy(scope.member,card,choice);
   const baseRef=card.base_ref??repo.default_branch;
   if(typeof baseRef!=='string' || baseRef.length>200 || hasCredential(baseRef))throw new HubError('VALIDATION','Choose a bounded repository base without credential material.');
   return {...choice,target_user_id:target.user_id,base_ref:baseRef,
    fields_hmac:this.hub.refHash(canonical({title:card.title,body:card.body,acceptance:card.acceptance,labels:card.labels,repo_id:card.repo_id,base_ref:card.base_ref,budget_cents:card.budget_cents}))};
  });
  return {repo,steps};
 }
 verify(scope,row){
  let snapshot;try{snapshot=JSON.parse(row.snapshot);}catch{throw changed();}
  if(digest(snapshot)!==row.plan_hash || snapshot?.schema!==1 || snapshot.grants_execution!==false || snapshot.instance_id!==scope.instance.id
   || snapshot.issuer?.user_id!==row.issuer_user_id || snapshot.issuer?.member_id!==row.issuer_member_id
   || snapshot.issuer?.credential?.kind!==row.credential_kind || snapshot.issuer?.credential?.id!==row.credential_id
   || !Array.isArray(snapshot.steps))throw changed();
  try{if(canonical(validatePreview(snapshot.options))!==canonical(snapshot.options))throw changed();}catch{throw changed();}
  const issuer=this.hub.activeMember(row.issuer_member_id);
  if(!issuer || issuer.user_id!==row.issuer_user_id || issuer.org_id!==row.org_id)throw changed();
  // Preview history never inherits a replacement credential/member's authority.
  this.principal({id:issuer.id,user_id:row.issuer_user_id,org_id:row.org_id},{kind:row.credential_kind,id:row.credential_id},true);
  if(snapshot.options.repo_id!==row.repo_id || !Number.isFinite(snapshot.created_mono))throw changed();
  const source=this.source({...scope,member:issuer},snapshot.options);
  if(snapshot.repository_hmac!==this.hub.refHash(source.repo.canonical_url))throw changed();
  if(source.steps.some((step,index)=>canonical(step)!==canonical(snapshot.steps[index])))throw changed();
  const stored=this.db.all('SELECT * FROM workflow_execution_plan_steps WHERE plan_id=? ORDER BY position',row.id);
  if(stored.length!==source.steps.length || stored.some((step,index)=>['position','card_id','target_member_id','target_user_id','version','fence']
   .some(key=>step[key]!==source.steps[index][key])))throw changed();
  return {snapshot,source};
 }
 readiness(card,step){
  const reasons=[];
  if(card.active_run_id || (card.run_state??'todo')!=='todo' || card.column_name!=='todo')reasons.push('TASK_NOT_TODO');
  if(this.hub.labels(card).includes('never_auto'))reasons.push('AUTOMATION_DISABLED');
  if(step.budget_usd!==null && step.budget_usd*100-this.hub.cardSpentCents(card.id)<50)reasons.push('BUDGET_EXHAUSTED');
  const candidates=[...this.hub.runners.values()].filter(conn=>conn.member_id===step.target_member_id && conn.repos.has(card.repo_id)
   && !runnerConnectionProblem(this.hub,conn));
  let eligible=false;
  for(const conn of candidates){
   const enrollment=this.db.get('SELECT * FROM runner_enrollments WHERE id=?',conn.enrollmentId);
   const deviceOwner=enrollment&&this.db.get('SELECT user_id FROM user_devices WHERE id=?',enrollment.user_device_id);
   const provider=conn.ai?.find(ai=>ai.id===step.ai);
   if(enrollment?.user_id===step.target_user_id && deviceOwner?.user_id===step.target_user_id && provider
    && readiness(provider)===null && !provider.legacy && (step.budget_usd===null || provider.capabilities.budget!=='none'))eligible=true;
  }
  if(!eligible)reasons.push('RUNNER_READINESS_UNCONFIRMED');
  return reasons;
 }
 projection(bound,planId){
  const row=this.db.get('SELECT * FROM workflow_execution_plans WHERE id=?',planId);if(!row)throw missing();
  const scope=this.scope(bound,row.instance_id,bound.write);
  if(row.org_id!==scope.member.org_id || row.board_id!==scope.board.id)throw missing();
  const {snapshot,source}=this.verify(scope,row),clock=this.time();
  const elapsed=row.created_epoch===this.hub.epoch?Math.max(0,clock.mono-snapshot.created_mono):0;
  const remaining=Math.max(0,row.expires_ms-Math.max(clock.wall,row.created_ms+elapsed));
  const steps=source.steps.map(step=>{
   const card=this.hub.card(step.card_id),target=this.hub.activeMember(step.target_member_id);
   return {position:step.position,card_id:card.id,key:card.key,title:text(card.title),version:step.version,fence:step.fence,
    base_ref:text(step.base_ref),provider:step.ai,provider_label:AI_LABELS[step.ai],budget_usd:step.budget_usd,
    monetary_telemetry:step.ai==='codex'?'unavailable':'provider_reported',plan_approval:step.plan_approval,
    target:{member_id:target.id,name:text(target.display_name,80)},depends_on:snapshot.options.dependencies.filter(edge=>edge[1]===step.position).map(edge=>edge[0]),
    predecessor_review:'Requires human approval or verified merge of the exact execution attempt.',
    readiness_source:'current_runner_report',blocked_reasons:this.readiness(card,step),grants_execution:false};
  });
  const state=remaining===0?'expired':row.created_epoch!==this.hub.epoch?'paused_reboot':clock.unsafe?'paused_clock':steps.some(step=>step.blocked_reasons.length)?'blocked':'preview';
  const out={plan:{id:row.id,hash:row.plan_hash,source:'human_preview',state,instance_id:row.instance_id,board_id:row.board_id,
   repository:{id:source.repo.id,name:text(source.repo.short_name,80),canonical_url:text(source.repo.canonical_url)},recipe:{id:scope.instance.recipe_id,version:scope.instance.recipe_version,content_hash:scope.version.content_hash},
   issuer:{member_id:row.issuer_member_id,name:text(this.hub.memberName(row.issuer_member_id),80)},concurrency:snapshot.options.concurrency,
   valid_until:new Date(row.expires_ms).toISOString(),remaining_ms:remaining,dependencies:snapshot.options.dependencies,steps,
   execution_enabled:false,grants_execution:false,authorization:null,requires_fresh_human_start:true,
   integration_policy:'Unreviewed merge, rebase or base changes require a fresh preview.',
   concurrency_policy:'Advisory declarations do not guarantee all edits are known.'}};
  if(Buffer.byteLength(JSON.stringify(out))>LIMITS.bytes)throw new HubError('PAYLOAD_TOO_LARGE','Workflow preview exceeds 32 KiB. Shorten task titles.');
  return out;
 }
 guard(out){
  const bound=bindings.get(out);if(!bound || bound.service!==this)throw new HubError('FORBIDDEN','Workflow preview needs a current read.');
  bindings.delete(out);
  const fresh=this.projection(bound,bound.planId);for(const key of Object.keys(out))delete out[key];Object.assign(out,fresh);
 }
 bound(member,cred,options,write){
  if(options.boardIds!=null && !Array.isArray(options.boardIds))throw new HubError('VALIDATION','Invalid board selection.');
  return {...capture(member,cred,options),write};
 }
 async preview(member,instanceId,body,cred,options={}){
  let input;try{input=validatePreview(body);}catch(error){throw new HubError('VALIDATION',error.message);}
  const bound=this.bound(member,cred,options,true),initial=this.scope(bound,instanceId,true),requestHash=digest({instance_id:instanceId,options:input});
  if(initial.board.id!==input.board_id)throw missing();
  const prepared=this.source(initial,input),repositoryHash=this.hub.refHash(prepared.repo.canonical_url),choiceHash=digest(prepared.steps);
  return this.hub.withBoard(initial.board.id,()=>this.db.tx(()=>{
   const scope=this.scope(bound,instanceId,true);if(scope.board.id!==initial.board.id)throw changed();
   const source=this.source(scope,input),clock=this.time();if(clock.unsafe)throw new HubError('CONFLICT','The hub clock changed. Create a fresh preview after the hub clock is corrected.');
   if(repositoryHash!==this.hub.refHash(source.repo.canonical_url) || choiceHash!==digest(source.steps))throw changed();
   const prior=this.db.get('SELECT * FROM workflow_execution_plans WHERE issuer_member_id=? AND request_id=?',scope.member.id,input.request_id);
   if(prior){if(prior.request_hash!==requestHash || prior.issuer_user_id!==scope.member.user_id)throw changed();return this.result(bound,prior.id);}
   if(this.db.get('SELECT count(*) n FROM workflow_execution_plans WHERE org_id=?',scope.member.org_id).n>=LIMITS.plans)throw new HubError('QUOTA_EXCEEDED','Workflow preview history is full.');
   limitOrThrow(this.hub,'workflow_member',scope.member.id);
   const id=randomUUID(),snapshot={schema:1,instance_id:instanceId,options:input,steps:source.steps,repository_hmac:repositoryHash,
    issuer:{member_id:scope.member.id,user_id:scope.member.user_id,org_id:scope.member.org_id,credential:bound.credential},
    created_mono:clock.mono,grants_execution:false};
   const bytes=canonical(snapshot);if(Buffer.byteLength(bytes)>LIMITS.bytes)throw new HubError('PAYLOAD_TOO_LARGE','Workflow preview exceeds 32 KiB.');
   this.db.insert('workflow_execution_plans',{id,org_id:scope.member.org_id,instance_id:instanceId,board_id:scope.board.id,repo_id:source.repo.id,
    issuer_member_id:scope.member.id,issuer_user_id:scope.member.user_id,credential_kind:bound.credential.kind,credential_id:bound.credential.id,
    request_id:input.request_id,request_hash:requestHash,plan_hash:digest(snapshot),snapshot:bytes,created_ms:clock.wall,expires_ms:clock.wall+LIMITS.lifetimeMs,
    created_epoch:this.hub.epoch,session_epoch:this.hub.accounts.epoch()});
   for(const step of source.steps)this.db.insert('workflow_execution_plan_steps',{plan_id:id,position:step.position,card_id:step.card_id,
    target_member_id:step.target_member_id,target_user_id:step.target_user_id,version:step.version,fence:step.fence});
   return this.result(bound,id);
  }));
 }
 result(bound,planId){const out=this.projection(bound,planId);bindings.set(out,{...bound,service:this,planId});return out;}
 async read(member,planId,cred,options={}){
  const bound=this.bound(member,cred,options,false),row=this.db.get('SELECT instance_id FROM workflow_execution_plans WHERE id=?',planId);if(!row)throw missing();
  const initial=this.scope(bound,row.instance_id);
  return this.hub.withBoard(initial.board.id,()=>this.result(bound,planId));
 }
}
