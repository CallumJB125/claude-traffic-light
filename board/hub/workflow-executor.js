// Phase2A only: immutable inert execution/control previews and private fresh
// delivery proof. There are NO launch/control/dispatch/run/approval methods.
import { createHash,randomUUID } from 'node:crypto';
import { WorkflowExecutions } from './workflow-executions.js';
import { canonical } from '../shared/workflow-execution.js';
import { validateExecutionPreview,validateControlPreview,EXECUTION_LIMITS as LIMITS,pathOverlap } from '../shared/workflow-execution-controls.js';
import { HubError,json } from './db.js';
import { limitOrThrow } from './ratelimit.js';
const proofs=new WeakMap();
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const changed=()=>new HubError('CONFLICT','Workflow source or reviewed choices changed. Create a fresh preview.');
const missing=()=>new HubError('NOT_FOUND','Execution preview is unavailable.');
const parse=fn=>{try{return fn();}catch(error){throw new HubError('VALIDATION',error.message);}};
const capture=(member,cred,options,write)=>({actor:Object.freeze({id:member?.id,user_id:member?.user_id,org_id:member?.org_id}),
 credential:cred&&Object.freeze({kind:cred.kind,id:cred.id}),selection:options.boardIds==null?null:Object.freeze([...options.boardIds]),write});
const remaining=(row,snapshot,clock,epoch)=>{
 const elapsed=row.created_epoch===epoch?Math.max(0,clock.mono-snapshot.created_mono):0;
 return Math.max(0,row.expires_ms-Math.max(clock.wall,row.created_ms+elapsed));
};

export class WorkflowExecutor {
 constructor(api){this.api=api;this.hub=api.hub;this.db=api.db;this.plans=new WorkflowExecutions(api);}
 bound(member,cred,options,write){if(options.boardIds!=null&&!Array.isArray(options.boardIds))throw changed();return capture(member,cred,options,write);}
 source(bound,planId){
  const row=this.db.get('SELECT * FROM workflow_execution_plans WHERE id=?',planId);if(!row)throw missing();
  const scope=this.plans.scope(bound,row.instance_id,bound.write);if(row.org_id!==scope.member.org_id||row.board_id!==scope.board.id)throw missing();
  const verified=this.plans.verify(scope,row);return {row,scope,...verified};
 }
 fixed(source,executionId,revision){
  const row=this.db.get('SELECT * FROM workflow_executions WHERE id=?',executionId);if(!row||row.org_id!==source.scope.member.org_id)throw missing();
  let fixed;try{fixed=JSON.parse(row.snapshot);}catch{throw changed();}
  if(hash(fixed)!==row.source_hash||fixed.schema!==1||row.instance_id!==source.row.instance_id||row.board_id!==source.row.board_id
   ||row.repo_id!==source.row.repo_id||row.revision!==revision||['cancelled','completed'].includes(row.state)
   ||fixed.content_hash!==source.snapshot.options.content_hash||fixed.repository_hmac!==source.snapshot.repository_hmac
   ||canonical(fixed.dependencies)!==canonical(source.snapshot.options.dependencies)
   ||canonical(fixed.card_ids)!==canonical(source.snapshot.options.steps.map(step=>step.card_id)))throw changed();
  const steps=this.db.all('SELECT * FROM workflow_execution_steps WHERE execution_id=? ORDER BY position',row.id);
  if(steps.length!==fixed.card_ids.length||steps.some((s,i)=>s.position!==i||s.card_id!==fixed.card_ids[i]
   ||s.version!==source.source.steps[i].version||s.fence!==source.source.steps[i].fence))throw changed();
  const attempts=this.db.all('SELECT * FROM workflow_execution_attempts WHERE execution_id=? ORDER BY position,attempt',row.id);
  return {row,fixed,steps,attempts,hash:hash({row,steps,attempts})};
 }
 prepare(bound,planId,input,executionId=null){
  const source=this.source(bound,planId),member=source.scope.member;
  // Initial path review is bound to the original human, never a shared hash.
  if(input.purpose==='start'&&(source.row.issuer_member_id!==member.id||source.row.issuer_user_id!==member.user_id))throw missing();
  if(source.row.plan_hash!==input.plan_hash||input.declared_paths.length!==source.source.steps.length)throw changed();
  const execution=executionId?this.fixed(source,executionId,input.expected_revision):null;
  if(input.purpose!=='start'&&!execution)throw missing();
  if(input.purpose==='retry'){
   const prior=execution.attempts.find(a=>a.id===input.previous_attempt_id&&a.position===input.position);
   if(!prior||prior.attempt>=8||!['failed','uncertain'].includes(prior.state))throw changed();
  }
  return {source,execution,hash:hash({source:source.row.snapshot,steps:source.source.steps,execution:execution?.hash??null})};
 }
 async preview(member,planId,body,cred,options={}){
  const input=parse(()=>validateExecutionPreview(body));return this.persist(this.bound(member,cred,options,true),planId,input,null);
 }
 async controlPreview(member,executionId,body,cred,options={}){
  const input=parse(()=>validateControlPreview(body));return this.persist(this.bound(member,cred,options,true),input.source_plan_id,input,executionId);
 }
 async persist(bound,planId,input,executionId){
  const prepared=this.prepare(bound,planId,input,executionId),boardId=prepared.source.row.board_id;
  return this.hub.withBoard(boardId,()=>this.db.tx(()=>{
   const current=this.prepare(bound,planId,input,executionId),clock=this.plans.time();
   if(current.source.row.board_id!==boardId||current.hash!==prepared.hash)throw changed();
   const requestHash=hash({planId,executionId,input}),issuer=current.source.scope.member;
   const prior=this.db.get('SELECT * FROM workflow_control_previews WHERE issuer_member_id=? AND request_id=?',issuer.id,input.request_id);
   if(prior){if(prior.request_hash!==requestHash||prior.issuer_user_id!==issuer.user_id||prior.credential_kind!==bound.credential.kind||prior.credential_id!==bound.credential.id)throw changed();return this.result(bound,prior.id);}
   const sourceRemaining=remaining(current.source.row,current.source.snapshot,clock,this.hub.epoch);
   if(clock.unsafe||current.source.row.created_epoch!==this.hub.epoch||!sourceRemaining)throw changed();
   if(this.db.get('SELECT count(*) n FROM workflow_control_previews WHERE org_id=?',issuer.org_id).n>=1000)throw new HubError('QUOTA_EXCEEDED','Execution preview history is full.');
   limitOrThrow(this.hub,'workflow_member',issuer.id);
   const id=randomUUID(),snapshot={schema:1,grants_execution:false,input,source_plan_id:planId,source_plan_hash:current.source.row.plan_hash,
    source_snapshot_hash:hash(current.source.row.snapshot),source_steps:current.source.source.steps,repository_hmac:current.source.snapshot.repository_hmac,
    issuer:{...bound.actor,credential:bound.credential},execution_id:executionId,execution_hash:current.execution?.hash??null,created_mono:clock.mono};
   const bytes=canonical(snapshot);if(Buffer.byteLength(bytes)>LIMITS.bytes)throw new HubError('PAYLOAD_TOO_LARGE','Execution preview exceeds 32 KiB. Shorten declared paths.');
   this.db.insert('workflow_control_previews',{id,org_id:issuer.org_id,instance_id:current.source.row.instance_id,board_id:boardId,repo_id:current.source.row.repo_id,
    source_plan_id:planId,execution_id:executionId,purpose:input.purpose,expected_revision:input.expected_revision??0,issuer_member_id:issuer.id,issuer_user_id:issuer.user_id,
    credential_kind:bound.credential.kind,credential_id:bound.credential.id,request_id:input.request_id,request_hash:requestHash,preview_hash:hash(snapshot),path_hash:hash(input.declared_paths),snapshot:bytes,
    created_ms:clock.wall,expires_ms:Math.min(current.source.row.expires_ms,clock.wall+sourceRemaining,clock.wall+LIMITS.lifetimeMs),created_epoch:this.hub.epoch,session_epoch:this.hub.accounts.epoch()});
   for(const step of current.source.source.steps)this.db.insert('workflow_control_preview_steps',{preview_id:id,position:step.position,card_id:step.card_id,target_member_id:step.target_member_id,target_user_id:step.target_user_id});
   return this.result(bound,id);
  }));
 }
 verify(bound,row){
  let snapshot;try{snapshot=JSON.parse(row.snapshot);}catch{throw changed();}
  if(hash(snapshot)!==row.preview_hash||snapshot.schema!==1||snapshot.grants_execution!==false||snapshot.source_plan_id!==row.source_plan_id
   ||snapshot.execution_id!==row.execution_id||snapshot.issuer?.id!==row.issuer_member_id||snapshot.issuer?.user_id!==row.issuer_user_id||snapshot.issuer?.org_id!==row.org_id
   ||snapshot.issuer?.credential?.kind!==row.credential_kind||snapshot.issuer?.credential?.id!==row.credential_id||!Number.isFinite(snapshot.created_mono))throw changed();
  const input=parse(()=>row.purpose==='start'?validateExecutionPreview(snapshot.input):validateControlPreview(snapshot.input));
  if(canonical(input)!==canonical(snapshot.input)||input.purpose!==row.purpose||input.request_id!==row.request_id||(input.expected_revision??0)!==row.expected_revision||hash(input.declared_paths)!==row.path_hash
   ||input.purpose!=='start'&&input.source_plan_id!==row.source_plan_id
   ||row.request_hash!==hash({planId:row.source_plan_id,executionId:row.execution_id,input}))throw changed();
  // Retained history never inherits replacement credential/member ownership.
  this.plans.principal({id:row.issuer_member_id,user_id:row.issuer_user_id,org_id:row.org_id},{kind:row.credential_kind,id:row.credential_id},true);
  const source=this.source(bound,row.source_plan_id);
  if(source.row.org_id!==row.org_id||source.row.board_id!==row.board_id||source.row.repo_id!==row.repo_id||source.row.instance_id!==row.instance_id
   ||source.row.plan_hash!==snapshot.source_plan_hash||hash(source.row.snapshot)!==snapshot.source_snapshot_hash
   ||canonical(source.source.steps)!==canonical(snapshot.source_steps)||source.snapshot.repository_hmac!==snapshot.repository_hmac||row.expires_ms>source.row.expires_ms)throw changed();
  const stored=this.db.all('SELECT * FROM workflow_control_preview_steps WHERE preview_id=? ORDER BY position',row.id);
  if(stored.length!==source.source.steps.length||stored.some((s,i)=>['position','card_id','target_member_id','target_user_id'].some(k=>s[k]!==source.source.steps[i][k])))throw changed();
  if(row.execution_id&&this.fixed(source,row.execution_id,row.expected_revision).hash!==snapshot.execution_hash)throw changed();
  return {snapshot,source};
 }
 parallel(source,paths){
  if(source.snapshot.options.concurrency!==2)return [];
  const reasons=[];if(paths.some(s=>!s.paths.length))reasons.push('PARALLEL_PLAN_REQUIRED');
  for(let a=0;a<paths.length;a++)for(let b=a+1;b<paths.length;b++)if(paths[a].paths.some(p=>paths[b].paths.some(q=>pathOverlap(p,q))))reasons.push('DECLARED_PATH_OVERLAP');
  // Exact selected board/repo only. Unknown active intent is reported as
  // unknown, never interpreted as proof of non-overlap or a global lock.
  const active=this.db.all(`SELECT c.id,c.active_run_id,o.* FROM cards c LEFT JOIN task_ownership o ON o.run_id=c.active_run_id
   WHERE c.board_id=? AND c.repo_id=? AND c.archived_at IS NULL AND c.active_run_id IS NOT NULL LIMIT 51`,source.row.board_id,source.row.repo_id);
  if(active.length>50)reasons.push('PARALLEL_SCOPE_UNKNOWN');
  for(const record of active.slice(0,50)){
   const projection=record.run_id&&this.hub.ownership.project(record);
   if(!projection||projection.state!=='editing'||!projection.paths.length){reasons.push('PARALLEL_SCOPE_UNKNOWN');continue;}
   if(paths.some(s=>s.paths.some(p=>json(record.paths,[]).some(q=>pathOverlap(p,q)))))reasons.push('DECLARED_PATH_OVERLAP');
  }
  return [...new Set(reasons)];
 }
 projection(bound,id){
  const row=this.db.get('SELECT * FROM workflow_control_previews WHERE id=?',id);if(!row)throw missing();
  const {snapshot,source}=this.verify(bound,row),clock=this.plans.time();
  const remainingMs=Math.min(remaining(row,snapshot,clock,this.hub.epoch),remaining(source.row,source.snapshot,clock,this.hub.epoch));
  const original=this.plans.projection({...bound,write:false},row.source_plan_id).plan;
  const blocked=[...new Set([...original.steps.flatMap(s=>s.blocked_reasons),...this.parallel(source,snapshot.input.declared_paths),'BASE_REVIEW_REQUIRED'])];
  const state=!remainingMs?'expired':row.created_epoch!==this.hub.epoch?'paused_reboot':clock.unsafe?'paused_clock':'inert';
  const out={execution_preview:{id:row.id,hash:row.preview_hash,path_intent_hash:row.path_hash,source_plan_id:row.source_plan_id,source_plan_hash:source.row.plan_hash,
   purpose:row.purpose,execution_id:row.execution_id,expected_revision:row.expected_revision,instance_id:row.instance_id,board_id:row.board_id,repository:original.repository,
   concurrency:original.concurrency,declared_paths:snapshot.input.declared_paths,path_source:'human_declared',advisory:true,global_filesystem_lock:false,
   state,valid_until:new Date(row.expires_ms).toISOString(),remaining_ms:remainingMs,blocked_reasons:blocked,steps:original.steps,
   base_review:{status:'unverified_reference',requires_human:true,automatic_merge:false,automatic_source_transfer:false},
   execution_enabled:false,grants_execution:false,authorization:null,requires_fresh_human_start:true}};
  if(Buffer.byteLength(JSON.stringify(out))>LIMITS.bytes)throw new HubError('PAYLOAD_TOO_LARGE','Execution preview exceeds 32 KiB. Shorten task titles and paths.');return out;
 }
 result(bound,id){const out=this.projection(bound,id);proofs.set(out,{service:this,bound,id});return out;}
 guard(out){const proof=proofs.get(out);if(!proof||proof.service!==this)throw new HubError('FORBIDDEN','Execution preview needs a fresh read.');proofs.delete(out);
  const fresh=this.projection(proof.bound,proof.id);for(const key of Object.keys(out))delete out[key];Object.assign(out,fresh);}
 async read(member,id,cred,options={}){
  const bound=this.bound(member,cred,options,false),row=this.db.get('SELECT source_plan_id FROM workflow_control_previews WHERE id=?',id);if(!row)throw missing();
  const source=this.source(bound,row.source_plan_id);return this.hub.withBoard(source.row.board_id,()=>this.result(bound,id));
 }
}
