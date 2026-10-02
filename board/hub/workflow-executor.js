// Human controls use separate immutable execution previews and private fresh
// authority. Imported recipes and the frozen039 preview remain inert.
import { createHash,randomUUID } from 'node:crypto';
import { WorkflowExecutions } from './workflow-executions.js';
import { canonical } from '../shared/workflow-execution.js';
import { validateExecutionPreview,validateControlPreview,validateCommand,declaredPaths,EXECUTION_LIMITS as LIMITS,pathOverlap } from '../shared/workflow-execution-controls.js';
import { AI_BACKENDS } from '../shared/ai.js';
import { branchName } from '../shared/fence.js';
import { redactSecrets } from '../shared/secret-patterns.mjs';
import { PLAN_APPROVAL_LABEL } from '../shared/states.js';
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
 constructor(api){this.api=api;this.hub=api.hub;this.db=api.db;this.plans=new WorkflowExecutions(api);this.core=this.hub.workflowGuard;this.core.attach(this);this.pending=new Set();this.draining=false;}
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
  const lifecycle=executionId&&this.db.get('SELECT snapshot FROM workflow_executions WHERE id=?',executionId);
  if(lifecycle&&json(lifecycle.snapshot,{}).schema===2)return this.prepareCurrent(bound,planId,input,executionId);
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
  const input=parse(()=>validateExecutionPreview(body)),bound=this.bound(member,cred,options,true),prepared=this.prepare(bound,planId,input);
  const bases=await this.resolveBases(prepared.source);
  return this.persist(bound,planId,input,null,{hash:prepared.hash,bases});
 }
 async controlPreview(member,executionId,body,cred,options={}){
  const input=parse(()=>validateControlPreview(body)),bound=this.bound(member,cred,options,true),prepared=this.prepare(bound,input.source_plan_id,input,executionId);
  const bases=await this.resolveBases(prepared.source);
  return this.persist(bound,input.source_plan_id,input,executionId,{hash:prepared.hash,bases});
 }
 async persist(bound,planId,input,executionId,resolved=null){
  const prepared=this.prepare(bound,planId,input,executionId),boardId=prepared.source.row.board_id;
  if(resolved&&resolved.hash!==prepared.hash)throw changed();
  return this.hub.withBoard(boardId,()=>this.db.tx(()=>{
   const current=this.prepare(bound,planId,input,executionId),clock=this.plans.time();
   if(current.source.row.board_id!==boardId||current.hash!==prepared.hash)throw changed();
   const requestHash=hash({planId,executionId,input}),issuer=current.source.scope.member;
   const prior=this.db.get('SELECT * FROM workflow_control_previews WHERE issuer_member_id=? AND request_id=?',issuer.id,input.request_id);
   if(prior){if(prior.request_hash!==requestHash||prior.issuer_user_id!==issuer.user_id||prior.credential_kind!==bound.credential.kind||prior.credential_id!==bound.credential.id)throw changed();return this.result(bound,prior.id);}
   const lifecycle=current.execution?.fixed?.schema===2;
   const sourceRemaining=lifecycle?LIMITS.lifetimeMs:remaining(current.source.row,current.source.snapshot,clock,this.hub.epoch);
   if(clock.unsafe||!lifecycle&&current.source.row.created_epoch!==this.hub.epoch||!sourceRemaining)throw changed();
   if(this.db.get('SELECT count(*) n FROM workflow_control_previews WHERE org_id=?',issuer.org_id).n>=1000)throw new HubError('QUOTA_EXCEEDED','Execution preview history is full.');
   limitOrThrow(this.hub,'workflow_member',issuer.id);
   const id=randomUUID(),snapshot={schema:1,grants_execution:false,input,source_plan_id:planId,source_plan_hash:current.source.row.plan_hash,
    source_snapshot_hash:hash(current.source.row.snapshot),source_steps:current.source.source.steps,repository_hmac:current.source.snapshot.repository_hmac,
    issuer:{...bound.actor,credential:bound.credential},execution_id:executionId,execution_hash:current.execution?.hash??null,created_mono:clock.mono,
    ...(resolved?.bases?{base_commits:resolved.bases,lifecycle:lifecycle?2:1,selection:bound.selection}:{} )};
   const bytes=canonical(snapshot);if(Buffer.byteLength(bytes)>LIMITS.bytes)throw new HubError('PAYLOAD_TOO_LARGE','Execution preview exceeds 32 KiB. Shorten declared paths.');
   this.db.insert('workflow_control_previews',{id,org_id:issuer.org_id,instance_id:current.source.row.instance_id,board_id:boardId,repo_id:current.source.row.repo_id,
    source_plan_id:planId,execution_id:executionId,purpose:input.purpose,expected_revision:input.expected_revision??0,issuer_member_id:issuer.id,issuer_user_id:issuer.user_id,
    credential_kind:bound.credential.kind,credential_id:bound.credential.id,request_id:input.request_id,request_hash:requestHash,preview_hash:hash(snapshot),path_hash:hash(input.declared_paths),snapshot:bytes,
    created_ms:clock.wall,expires_ms:Math.min(lifecycle?clock.wall+LIMITS.lifetimeMs:current.source.row.expires_ms,clock.wall+sourceRemaining,clock.wall+LIMITS.lifetimeMs),created_epoch:this.hub.epoch,session_epoch:this.hub.accounts.epoch()});
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
  const current=snapshot.lifecycle===2?this.prepareCurrent(bound,row.source_plan_id,input,row.execution_id):null;
  const source=current?.source??this.source(bound,row.source_plan_id);
  if(source.row.org_id!==row.org_id||source.row.board_id!==row.board_id||source.row.repo_id!==row.repo_id||source.row.instance_id!==row.instance_id
   ||source.row.plan_hash!==snapshot.source_plan_hash||hash(source.row.snapshot)!==snapshot.source_snapshot_hash
   ||canonical(source.source.steps)!==canonical(snapshot.source_steps)||source.snapshot.repository_hmac!==snapshot.repository_hmac||snapshot.lifecycle!==2&&row.expires_ms>source.row.expires_ms)throw changed();
  const stored=this.db.all('SELECT * FROM workflow_control_preview_steps WHERE preview_id=? ORDER BY position',row.id);
  if(stored.length!==source.source.steps.length||stored.some((s,i)=>['position','card_id','target_member_id','target_user_id'].some(k=>s[k]!==source.source.steps[i][k])))throw changed();
  if(row.execution_id&&(current?.execution??this.fixed(source,row.execution_id,row.expected_revision)).hash!==snapshot.execution_hash)throw changed();
  if(snapshot.base_commits&&(!Array.isArray(snapshot.base_commits)||snapshot.base_commits.length!==source.source.steps.length
   ||snapshot.base_commits.some((b,i)=>b!==null&&(b.position!==i||b.base_ref!==source.source.steps[i].base_ref||!/^[0-9a-f]{40}$/.test(b.sha??'')))))throw changed();
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
  const remainingMs=Math.min(remaining(row,snapshot,clock,this.hub.epoch),snapshot.lifecycle===2?LIMITS.lifetimeMs:remaining(source.row,source.snapshot,clock,this.hub.epoch));
  const original=snapshot.lifecycle===2?this.currentPlan(source):this.plans.projection({...bound,write:false},row.source_plan_id).plan;
  const verified=snapshot.base_commits?.every(Boolean)===true;
  const blocked=[...new Set([...original.steps.flatMap(s=>s.blocked_reasons),...this.parallel(source,snapshot.input.declared_paths),...(verified?[]:['BASE_REVIEW_REQUIRED'])])];
  const state=!remainingMs?'expired':row.created_epoch!==this.hub.epoch?'paused_reboot':clock.unsafe?'paused_clock':'inert';
  const out={execution_preview:{id:row.id,hash:row.preview_hash,path_intent_hash:row.path_hash,source_plan_id:row.source_plan_id,source_plan_hash:source.row.plan_hash,
   purpose:row.purpose,execution_id:row.execution_id,expected_revision:row.expected_revision,instance_id:row.instance_id,board_id:row.board_id,repository:original.repository,
   concurrency:original.concurrency,declared_paths:snapshot.input.declared_paths,path_source:'human_declared',advisory:true,global_filesystem_lock:false,
   state,valid_until:new Date(row.expires_ms).toISOString(),remaining_ms:remainingMs,blocked_reasons:blocked,steps:original.steps,
   base_review:{status:verified?'hub_verified_commit':'unverified_reference',commits:verified?snapshot.base_commits:[],requires_human:true,automatic_merge:false,automatic_source_transfer:false},
   execution_enabled:false,grants_execution:false,authorization:null,requires_fresh_human_start:true}};
  if(Buffer.byteLength(JSON.stringify(out))>LIMITS.bytes)throw new HubError('PAYLOAD_TOO_LARGE','Execution preview exceeds 32 KiB. Shorten task titles and paths.');return out;
 }
 result(bound,id){const out=this.projection(bound,id);proofs.set(out,{service:this,bound,id});return out;}
 guard(out){const proof=proofs.get(out);if(!proof||proof.service!==this)throw new HubError('FORBIDDEN','Execution preview needs a fresh read.');proofs.delete(out);
  const fresh=proof.context?this.contextProjection(proof.bound,proof.id):proof.execution?this.executionProjection(proof.bound,proof.id):this.projection(proof.bound,proof.id);for(const key of Object.keys(out))delete out[key];Object.assign(out,fresh);}
 contextProjection(bound,instanceId){
  const scope=this.plans.scope(bound,instanceId,false),clean=(value,max=200)=>redactSecrets(String(value??'')).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max);
  const selected=this.db.all('SELECT position,card_id FROM workflow_step_cards WHERE instance_id=? ORDER BY position',instanceId);
  if(!selected.length||selected.length>8||selected.length!==scope.version.definition.steps.length)throw changed();
  const cards=selected.map((step,position)=>{const card=this.hub.card(step.card_id);
   if(step.position!==position||!card||card.board_id!==scope.board.id||card.archived_at)throw changed();
   if(card.repo_id&&!this.db.get('SELECT 1 x FROM repos r JOIN board_repos b ON b.repo_id=r.id WHERE r.id=? AND r.org_id=? AND b.board_id=?',card.repo_id,scope.member.org_id,scope.board.id))throw missing();
   return {position,id:card.id,key:card.key,title:clean(card.title),version:card.version,fence:card.fence,repo_id:card.repo_id,base_ref:clean(card.base_ref),
    plan_approval:this.hub.labels(card).includes(PLAN_APPROVAL_LABEL),plan_required:scope.version.definition.steps[position].plan_approval};
  });
  const repos=this.db.all('SELECT r.* FROM repos r JOIN board_repos b ON b.repo_id=r.id WHERE b.board_id=? AND r.org_id=? ORDER BY r.id LIMIT 101',scope.board.id,scope.member.org_id);
  const members=this.db.all('SELECT m.id FROM members m JOIN users u ON u.id=m.user_id WHERE m.org_id=? AND m.removed_at IS NULL AND u.deleted_at IS NULL ORDER BY m.id LIMIT 101',scope.member.org_id).map(row=>this.hub.activeMember(row.id));
  if(repos.length>100||members.length>100)throw new HubError('PAYLOAD_TOO_LARGE','Workflow choices exceed the bounded view. Narrow this board or team.');
  const executions=[];
  for(const row of this.db.all('SELECT id FROM workflow_executions WHERE instance_id=? AND org_id=? ORDER BY created_ms DESC,id LIMIT 11',instanceId,scope.member.org_id).slice(0,10)){
   try{const current=this.executionProjection(bound,row.id).execution;executions.push({id:current.id,state:current.state,revision:current.revision});}catch{/* Unavailable lineage never exports former repository or participant data. */}
  }
  const out={execution_context:{instance_id:instanceId,board_id:scope.board.id,recipe:{id:scope.instance.recipe_id,version:scope.instance.recipe_version,content_hash:scope.version.content_hash},
   cards,repos:repos.map(repo=>({id:repo.id,name:clean(repo.short_name,80),default_branch:clean(repo.default_branch)})),
   members:members.map(member=>({id:member.id,name:clean(member.display_name,80),can_run:this.hub.canWrite(member)})),can_write:this.hub.canWrite(scope.member),executions,execution_history_limited:true}};
  if(Buffer.byteLength(JSON.stringify(out))>LIMITS.bytes)throw new HubError('PAYLOAD_TOO_LARGE','Workflow choices exceed 32 KiB. Shorten task titles.');return out;
 }
 async instanceContext(member,id,cred,options={}){const bound=this.bound(member,cred,options,false),scope=this.plans.scope(bound,id,false);
  return this.hub.withBoard(scope.board.id,()=>{const out=this.contextProjection(bound,id);proofs.set(out,{service:this,bound,id,context:true});return out;});
 }
 async read(member,id,cred,options={}){
  const bound=this.bound(member,cred,options,false),row=this.db.get('SELECT source_plan_id FROM workflow_control_previews WHERE id=?',id);if(!row)throw missing();
  const preview=this.db.get('SELECT snapshot,execution_id FROM workflow_control_previews WHERE id=?',id),current=json(preview.snapshot,{}).lifecycle===2;
  const source=current?this.executionSource(bound,preview.execution_id,{reviewPending:true}).source:this.source(bound,row.source_plan_id);
  return this.hub.withBoard(source.row.board_id,()=>this.result(bound,id));
 }

 // Resolve only the bounded server-captured base references. A provider await
 // is outside the board queue and never supplies a command or actor. Its own
 // deadline also bounds injected clients that do not honor AbortSignal.
 async resolveBases(source){
  if(typeof this.hub.github.getBaseCommit!=='function')return null;
  let timer;const deadline=performance.now()+10_000;
  try{const bases=await Promise.race([Promise.all(source.source.steps.map(async step=>{
   try{const commit=await this.hub.github.getBaseCommit(source.source.repo.canonical_url,step.base_ref);return commit&&/^[0-9a-f]{40}$/.test(commit.sha??'')?{position:step.position,base_ref:step.base_ref,sha:commit.sha}:null;}catch{return null;}
  })),new Promise(resolve=>{timer=setTimeout(()=>resolve(source.source.steps.map(()=>null)),10_000);})]);
   return performance.now()>=deadline?source.source.steps.map(()=>null):bases;}
  finally{clearTimeout(timer);}
 }
 executionSource(bound,id,{reviewPending=false}={}){
  const row=this.db.get('SELECT * FROM workflow_executions WHERE id=?',id);if(!row)throw missing();
  const fixed=json(row.snapshot,null);if(!fixed||fixed.schema!==2||hash(fixed)!==row.source_hash)throw changed();
  const scope=this.plans.scope(bound,row.instance_id,bound.write),plan=this.db.get('SELECT * FROM workflow_execution_plans WHERE id=?',row.source_plan_id);
  if(!plan||plan.org_id!==scope.member.org_id||plan.board_id!==scope.board.id||row.org_id!==scope.member.org_id||row.board_id!==scope.board.id
   ||hash(json(plan.snapshot,null))!==plan.plan_hash||fixed.source_plan_hash!==plan.plan_hash||fixed.content_hash!==scope.version.content_hash
   ||scope.instance.recipe_version!==fixed.options.recipe_version||fixed.repository_hmac!==this.hub.refHash(this.hub.repo(row.repo_id)?.canonical_url))throw changed();
  const repo=this.hub.repo(row.repo_id);if(!repo||!this.db.get('SELECT 1 x FROM board_repos WHERE board_id=? AND repo_id=?',row.board_id,row.repo_id))throw missing();
  const selected=this.db.all('SELECT position,card_id FROM workflow_step_cards WHERE instance_id=? ORDER BY position',row.instance_id),progress=this.db.all('SELECT * FROM workflow_execution_steps WHERE execution_id=? ORDER BY position',id);
  if(selected.length!==fixed.steps.length||progress.length!==fixed.steps.length)throw changed();
  const steps=fixed.steps.map((original,position)=>{
   const card=this.hub.card(original.card_id),stored=progress[position],binding=this.core.binding(id,position);
   if(!card||card.archived_at||card.board_id!==row.board_id||card.repo_id!==row.repo_id||selected[position]?.card_id!==card.id||stored?.card_id!==card.id
    ||stored.position!==position||stored.source_hash!==hash(original)||!binding||binding.version!==stored.version||binding.fence!==stored.fence)throw changed();
   const editable=reviewPending&&!card.active_run_id&&['pending','failed','blocked'].includes(stored.state);
   if(card.version<stored.version||card.fence<stored.fence||!editable&&(card.version!==stored.version||card.fence!==stored.fence
    ||binding.source_hmac!==this.core.sourceHmac(card)||binding.state_hmac!==this.core.stateHmac(card)))throw changed();
   const target=bound.write?this.plans.choicePolicy(scope.member,card,original):this.hub.activeMember(original.target_member_id);
   if(!target||target.org_id!==scope.member.org_id||target.user_id!==original.target_user_id||!this.hub.accounts.liveUser(target.user_id))throw changed();
   const policy=this.hub.labels(card).includes(PLAN_APPROVAL_LABEL);if(policy!==original.plan_approval)throw changed();
   return {...original,version:card.version,fence:card.fence,base_ref:card.base_ref??repo.default_branch,fields_hmac:this.core.sourceHmac(card)};
  });
  const attempts=this.db.all('SELECT * FROM workflow_execution_attempts WHERE execution_id=? ORDER BY position,attempt',id),proofs=this.db.all('SELECT * FROM workflow_execution_proofs WHERE attempt_id IN (SELECT id FROM workflow_execution_attempts WHERE execution_id=?) ORDER BY rowid',id);
  const ordinary=[];
  for(const a of attempts){const d=this.db.get('SELECT * FROM dispatches WHERE request_id=?',a.dispatch_id),m=this.core.marker(a.dispatch_id),r=a.run_id&&this.hub.run(a.run_id),auth=this.db.get('SELECT * FROM workflow_execution_authorizations WHERE execution_id=? AND revision=?',id,a.authorization_revision),saved=auth&&json(auth.snapshot,null);
   if(!d||!m||m.execution_id!==id||m.card_id!==fixed.steps[a.position].card_id||d.card_id!==m.card_id||d.ai!==a.provider||d.target_member_id!==a.target_member_id
    ||d.budget_mode!==(a.budget_cents===null?'none':'cap')||d.budget_cents!==a.budget_cents
    ||m.run_id!==a.run_id||m.fence!==a.fence||!saved||hash(saved)!==auth.snapshot_hash||r&&(r.card_id!==m.card_id||r.dispatch_request_id!==a.dispatch_id||r.repo_id!==row.repo_id||r.fence!==a.fence||r.on_behalf_of!==a.target_member_id
    ||r.ai!==a.provider||r.backend!==AI_BACKENDS[a.provider]||r.base_ref!==saved.base_commits?.[a.position]?.sha||r.branch!==branchName(this.hub.card(m.card_id).key,a.fence)||r.dispatched_by!==auth.issuer_member_id))throw changed();
   ordinary.push({dispatch:d,marker:m,run:r||null});
  }
  const snapshot={...json(plan.snapshot,null),repository_hmac:fixed.repository_hmac,options:fixed.options};
  const source={row:plan,scope,snapshot,source:{repo,steps}},execution={row,fixed,steps:progress,attempts,hash:hash({row,progress,steps,attempts,proofs,ordinary,bindings:this.db.all('SELECT * FROM workflow_step_bindings WHERE execution_id=? ORDER BY position',id)})};
  return {source,execution};
 }
 prepareCurrent(bound,planId,input,executionId){
  const result=this.executionSource(bound,executionId,{reviewPending:true}),{source,execution}=result;
  if(source.row.id!==planId||source.row.plan_hash!==input.plan_hash||execution.row.revision!==input.expected_revision
   ||['cancelled','completed'].includes(execution.row.state)||input.declared_paths.length!==source.source.steps.length)throw changed();
  if(input.purpose==='retry'){
   const a=execution.attempts.find(a=>a.id===input.previous_attempt_id&&a.position===input.position),card=a&&this.hub.card(source.source.steps[a.position].card_id);
   if(!a||a.attempt>=LIMITS.attempts||!['failed','uncertain'].includes(a.state)||card.active_run_id)throw changed();
  }
  return {...result,hash:hash({source:source.row.snapshot,steps:source.source.steps,execution:execution.hash})};
 }
 currentPlan(source){
  const clean=(value,max=200)=>redactSecrets(String(value??'')).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max);
  return {repository:{id:source.row.repo_id,name:clean(source.source.repo.short_name,80),canonical_url:clean(source.source.repo.canonical_url)},concurrency:source.snapshot.options.concurrency,
   steps:source.source.steps.map(step=>{const card=this.hub.card(step.card_id),stored=this.db.get('SELECT state FROM workflow_execution_steps WHERE card_id=? AND execution_id IN (SELECT id FROM workflow_executions WHERE source_plan_id=? AND state NOT IN (\'cancelled\',\'completed\'))',card.id,source.row.id);
    return {position:step.position,card_id:card.id,key:card.key,title:clean(card.title),version:card.version,fence:card.fence,base_ref:clean(step.base_ref),provider:step.ai,budget_usd:step.budget_usd,plan_approval:step.plan_approval,
     target:{member_id:step.target_member_id,name:clean(this.hub.memberName(step.target_member_id),80)},depends_on:source.snapshot.options.dependencies.filter(e=>e[1]===step.position).map(e=>e[0]),
     blocked_reasons:stored?.state==='completed'?[]:this.capabilities(card,step),grants_execution:false};})};
 }
 capabilities(card,step){
  const reasons=[];
  if(this.hub.labels(card).includes('never_auto'))reasons.push('AUTOMATION_DISABLED');
  if(step.budget_usd!==null&&step.budget_usd*100-this.hub.cardSpentCents(card.id)<50)reasons.push('BUDGET_EXHAUSTED');
  if(![...this.hub.runners.values()].some(conn=>this.core.ready(conn,step,card.repo_id)))reasons.push('RUNNER_READINESS_UNCONFIRMED');
  return reasons;
 }
 authority(id,revision=null){
  if(this.closed)throw changed();
  const row=this.db.get('SELECT * FROM workflow_executions WHERE id=?',id),auth=row&&this.db.get('SELECT * FROM workflow_execution_authorizations WHERE execution_id=? AND revision=?',id,row.revision);
  if(!row||row.state!=='authorized'||revision!==null&&row.revision!==revision||!auth)throw changed();
  const authorization=json(auth.snapshot,null),clock=this.plans.time();
  if(!authorization||hash(authorization)!==auth.snapshot_hash||authorization.schema!==1||clock.unsafe||auth.created_epoch!==this.hub.epoch
   ||auth.expires_ms<=Math.max(clock.wall,auth.created_ms+Math.max(0,clock.mono-authorization.created_mono))||authorization.session_epoch!==this.hub.accounts.epoch())throw changed();
  const bound=this.bound({id:auth.issuer_member_id,user_id:auth.issuer_user_id,org_id:row.org_id},{kind:auth.credential_kind,id:auth.credential_id},{boardIds:authorization.selection},true),current=this.executionSource(bound,id);
  if(authorization.source_hash!==row.source_hash||authorization.declared_paths?.length!==current.source.source.steps.length||authorization.base_commits?.length!==current.source.source.steps.length
   ||authorization.base_commits.some((b,i)=>!b||b.position!==i||b.base_ref!==current.source.source.steps[i].base_ref||!/^[0-9a-f]{40}$/.test(b.sha)))throw changed();
  for(const step of current.source.source.steps){const progress=current.execution.steps[step.position];if(progress.state!=='completed'&&this.capabilities(this.hub.card(step.card_id),step).length)throw changed();
   if(['queued','running','awaiting_review'].includes(progress.state)&&current.execution.fixed.options.dependencies.some(([from,to])=>to===step.position&&!this.predecessor(id,from)))throw changed();}
  return {row,snapshot:{...current.execution.fixed,steps:current.source.source.steps},authorization,source:current.source,member:current.source.scope.member};
 }
 predecessor(id,position){
  const step=this.db.get('SELECT * FROM workflow_execution_steps WHERE execution_id=? AND position=?',id,position),a=step&&this.db.get('SELECT * FROM workflow_execution_attempts WHERE execution_id=? AND position=? ORDER BY attempt DESC LIMIT 1',id,position);
  if(!step||step.state!=='completed'||!a||a.state!=='completed'||!a.run_id)return false;
  const card=this.hub.card(step.card_id),binding=this.core.binding(id,position),complete=this.db.get("SELECT * FROM workflow_execution_proofs WHERE attempt_id=? AND kind='complete'",a.id),review=this.db.get("SELECT * FROM workflow_execution_proofs WHERE attempt_id=? AND kind IN ('human_review','verified_merge') ORDER BY rowid DESC LIMIT 1",a.id);
  if(review?.kind==='human_review'){const saved=json(review.snapshot,null),reviewer=saved?.reviewer;
   try{this.plans.principal({id:reviewer?.member_id,user_id:reviewer?.user_id,org_id:this.hub.board(card?.board_id)?.org_id},reviewer?.credential,true);}catch{return false;}}
  return !!(card?.column_name==='done'&&card.fence===a.fence&&card.version===step.version&&binding?.state_hmac===this.core.stateHmac(card)&&binding.source_hmac===this.core.sourceHmac(card)
   &&complete&&review&&review.run_id===a.run_id&&review.fence===a.fence&&review.card_version===card.version&&hash(json(complete.snapshot,null))===complete.snapshot_hash&&this.core.evidenceCurrent(json(complete.snapshot,null),a)&&hash(json(review.snapshot,null))===review.snapshot_hash);
 }
 admit(id,onlyPosition=null){
  const current=this.authority(id),fixed=current.snapshot,steps=this.db.all('SELECT * FROM workflow_execution_steps WHERE execution_id=? ORDER BY position',id);
  let active=this.db.get("SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=? AND state IN ('pending','claimed')",id).n;
  for(const stored of steps){
   if(active>=fixed.options.concurrency)break;
   if(onlyPosition!==null&&stored.position!==onlyPosition)continue;
   if(stored.state!=='pending')continue;
   if(fixed.options.dependencies.some(([from,to])=>to===stored.position&&!this.predecessor(id,from)))continue;
   const choice=fixed.steps[stored.position],card=this.hub.card(choice.card_id);
   if(stored.attempt_count>=LIMITS.attempts)throw new HubError('QUOTA_EXCEEDED','This workflow step has reached eight attempts.');
   if(this.parallel(current.source,current.authorization.declared_paths).length)throw new HubError('POLICY_DENIED','Parallel declarations are missing, overlapping or currently unknown.');
   if(card.active_run_id||!['todo','failed','queued','parked','handed_over'].includes(card.run_state??'todo'))throw changed();
   const requestId=randomUUID(),attemptId=randomUUID();
   this.core.owned(id,current.row.revision,()=>{
    // A failed preparation may leave an observed queued card but cannot pay
    // for a replacement. Only this explicit reviewed admission resets it.
    if(card.run_state==='queued')this.api.actionLocked(current.member,card.id,'cancel','cancel',{});
    // A parked run has already ended. The explicit reviewed Retry uses the
    // ordinary involved-actor stop policy before authorizing a new attempt.
    // A handed-over card uses the ordinary redispatch transition; no automatic
    // handoff/follow-up is allowed to choose a new UUID or provider.
    if(this.hub.card(card.id).run_state==='parked')this.api.actionLocked(current.member,card.id,'stop','stop',{});
    const state=this.hub.card(card.id).run_state??'todo';
    const action=state==='failed'?'retry':state==='handed_over'?'take_over_with_claude':'dispatch',type=state==='handed_over'?'redispatch':action;
    this.api.actionLocked(current.member,card.id,action,type,{request_id:requestId,ai:choice.ai,backend:AI_BACKENDS[choice.ai],target_member_id:choice.target_member_id,budget_usd:choice.budget_usd,confirm:true});
    this.db.insert('workflow_execution_attempts',{id:attemptId,execution_id:id,position:stored.position,attempt:stored.attempt_count+1,authorization_revision:current.row.revision,dispatch_id:requestId,provider:choice.ai,target_member_id:choice.target_member_id,target_user_id:choice.target_user_id,budget_cents:choice.budget_usd===null?null:Math.round(choice.budget_usd*100),state:'pending'});
    this.db.insert('workflow_owned_intents',{request_id:requestId,execution_id:id,card_id:card.id,disabled:0});
    this.db.run("UPDATE workflow_execution_steps SET attempt_count=attempt_count+1,state='queued' WHERE execution_id=? AND position=?",id,stored.position);
    this.core.bind(id,stored.position,this.hub.card(card.id));
   },{card_id:card.id,request_id:requestId});active++;
  }
  if(steps.every(s=>s.state==='completed'))this.db.run("UPDATE workflow_executions SET state='completed',revision=revision+1 WHERE id=?",id);
 }
 authorize(bound,preview,verified,id,revision){
  const clock=this.plans.time(),snapshot={schema:1,source_hash:this.db.get('SELECT source_hash FROM workflow_executions WHERE id=?',id).source_hash,
   declared_paths:verified.snapshot.input.declared_paths,base_commits:verified.snapshot.base_commits,selection:bound.selection,created_mono:clock.mono,session_epoch:this.hub.accounts.epoch()};
  if(clock.unsafe||preview.created_epoch!==this.hub.epoch||!remaining(preview,verified.snapshot,clock,this.hub.epoch)||!snapshot.base_commits?.every(Boolean))throw changed();
  for(const step of verified.source.source.steps){const progress=this.db.get('SELECT state FROM workflow_execution_steps WHERE execution_id=? AND position=?',id,step.position);
   if(progress?.state!=='completed'&&this.capabilities(this.hub.card(step.card_id),step).length)throw changed();this.core.bind(id,step.position,this.hub.card(step.card_id));}
  if(this.parallel(verified.source,snapshot.declared_paths).length)throw new HubError('POLICY_DENIED','Parallel declarations are missing, overlapping or currently unknown.');
  this.db.insert('workflow_execution_authorizations',{execution_id:id,revision,preview_id:preview.id,issuer_member_id:bound.actor.id,issuer_user_id:bound.actor.user_id,credential_kind:bound.credential.kind,credential_id:bound.credential.id,
   created_epoch:this.hub.epoch,created_ms:clock.wall,expires_ms:preview.expires_ms,snapshot:canonical(snapshot),snapshot_hash:hash(snapshot)});
  this.db.run("UPDATE workflow_executions SET state='authorized',revision=? WHERE id=?",revision,id);
 }
 receipt(id,bound,kind,input){
  const prior=this.db.get('SELECT * FROM workflow_execution_receipts WHERE execution_id=? AND request_id=?',id,input.request_id);
  if(prior){const captured=json(prior.result_ref,null);if(prior.issuer_user_id!==bound.actor.user_id||prior.kind!==kind||prior.request_hash!==hash({kind,input})
   ||!captured||captured.execution_id!==id||captured.member_id!==bound.actor.id||captured.user_id!==bound.actor.user_id||canonical(captured.credential)!==canonical(bound.credential))throw changed();}
  return prior;
 }
 saveReceipt(id,bound,kind,input){const row=this.db.get('SELECT revision FROM workflow_executions WHERE id=?',id);
  if(this.db.get('SELECT count(*) n FROM workflow_execution_receipts WHERE execution_id=?',id).n>=LIMITS.receipts)throw new HubError('QUOTA_EXCEEDED','Workflow control history has reached 128 receipts.');
  this.db.insert('workflow_execution_receipts',{execution_id:id,request_id:input.request_id,issuer_user_id:bound.actor.user_id,kind,request_hash:hash({kind,input}),revision:row.revision,result_ref:canonical({execution_id:id,member_id:bound.actor.id,user_id:bound.actor.user_id,credential:bound.credential})});}
 async start(member,planId,body,cred,options={}){
  const input=parse(()=>validateCommand('start',body)),bound=this.bound(member,cred,options,true),plan=this.db.get('SELECT * FROM workflow_execution_plans WHERE id=?',planId);if(!plan)throw missing();
  this.plans.scope(bound,plan.instance_id,true);
  return this.hub.withBoard(plan.board_id,()=>this.hub.txn(()=>{
   const prior=this.db.get(`SELECT r.* FROM workflow_execution_receipts r JOIN workflow_executions e ON e.id=r.execution_id WHERE e.source_plan_id=? AND r.request_id=?`,planId,input.request_id);
   if(prior){this.receipt(prior.execution_id,bound,'start',input);return this.executionResult(bound,prior.execution_id);}
   const preview=this.db.get('SELECT * FROM workflow_control_previews WHERE id=?',input.execution_preview_id);if(!preview||preview.source_plan_id!==planId||preview.purpose!=='start')throw missing();
   const verified=this.confirm(bound,preview,input,'start'),source=verified.source;
   if(input.plan_hash!==source.row.plan_hash||this.db.get("SELECT 1 x FROM workflow_executions WHERE instance_id=? AND state NOT IN ('cancelled','completed')",source.row.instance_id))throw changed();
   if(this.db.get('SELECT count(*) n FROM workflow_executions WHERE org_id=?',bound.actor.org_id).n>=1000)throw new HubError('QUOTA_EXCEEDED','Workflow execution history is full.');
   const id=randomUUID(),snapshot={schema:2,source_plan_hash:source.row.plan_hash,content_hash:source.snapshot.options.content_hash,repository_hmac:source.snapshot.repository_hmac,options:source.snapshot.options,steps:source.source.steps};
   this.db.insert('workflow_executions',{id,org_id:bound.actor.org_id,instance_id:source.row.instance_id,board_id:source.row.board_id,repo_id:source.row.repo_id,source_plan_id:planId,source_hash:hash(snapshot),revision:0,state:'planned',created_epoch:this.hub.epoch,created_ms:this.hub.wallMs(),snapshot:canonical(snapshot)});
   for(const step of snapshot.steps)this.db.insert('workflow_execution_steps',{execution_id:id,position:step.position,card_id:step.card_id,source_hash:hash(step),version:step.version,fence:step.fence,state:'pending'});
   this.authorize(bound,preview,verified,id,0);this.admit(id);const out=this.executionResult(bound,id);this.saveReceipt(id,bound,'start',input);return out;
  }));
 }
 confirm(bound,preview,input,purpose){
  if(preview.purpose!==purpose||preview.preview_hash!==input.execution_preview_hash||preview.path_hash!==input.path_intent_hash||preview.expected_revision!==input.expected_revision
   ||preview.issuer_member_id!==bound.actor.id||preview.issuer_user_id!==bound.actor.user_id||preview.credential_kind!==bound.credential?.kind||preview.credential_id!==bound.credential?.id)throw changed();
  return this.verify(bound,preview);
 }
 async command(kind,member,id,body,cred,options={},position=null){
  const input=parse(()=>validateCommand(kind,body)),bound=this.bound(member,cred,options,true),initial=this.executionSource(bound,id,{reviewPending:true});
  return this.hub.withBoard(initial.execution.row.board_id,()=>this.hub.txn(()=>{
   const current=this.executionSource(bound,id,{reviewPending:true}),row=current.execution.row,actor=current.source.scope.member;
   if(this.receipt(id,bound,kind,input))return this.executionResult(bound,id);
   if(row.revision!==input.expected_revision||['cancelled','completed'].includes(row.state))throw changed();
   if(kind==='pause'||kind==='cancel'){
    const old=this.db.get('SELECT issuer_member_id,issuer_user_id FROM workflow_execution_authorizations WHERE execution_id=? ORDER BY revision DESC LIMIT 1',id);
    if(!this.hub.isAdmin(actor)&&(old?.issuer_member_id!==actor.id||old.issuer_user_id!==actor.user_id))throw new HubError('FORBIDDEN','Only the current issuer or an owner/admin may stop scheduling.');
    if(kind==='cancel')this.cancelRuns(bound,current);
    this.core.pause(id,kind==='cancel'?'cancelled':'paused');
    if(kind==='cancel')this.db.run("UPDATE workflow_executions SET state='cancelled',revision=revision+1 WHERE id=?",id);
   }else{
    const preview=this.db.get('SELECT * FROM workflow_control_previews WHERE id=?',input.execution_preview_id);if(!preview||preview.execution_id!==id)throw missing();
    const verified=this.confirm(bound,preview,input,kind);
    // A new human revision cannot inherit an old paid launch authority. Only
    // unclaimed intents are disabled here; already committed runs stay observed.
    this.core.pause(id,'paused');
    if(kind==='retry'){
     if(verified.snapshot.input.position!==position||verified.snapshot.input.previous_attempt_id!==input.previous_attempt_id)throw changed();
     this.db.run("UPDATE workflow_execution_steps SET state='pending' WHERE execution_id=? AND position=?",id,position);
    }else if(current.execution.attempts.some(a=>['failed','uncertain'].includes(a.state)&&a.run_id&&current.execution.steps[a.position].state!=='completed'))throw new HubError('CONFLICT','A failed or uncertain attempt needs an explicit reviewed Retry.');
    this.authorize(bound,preview,verified,id,row.revision+1);this.admit(id,kind==='retry'?position:null);
   }
   const out=this.executionResult(bound,id);this.saveReceipt(id,bound,kind,input);return out;
  }));
 }
 cancelRuns(bound,current){
  this.core.human(current.source.scope.member,bound.credential,()=>{
   for(const attempt of current.execution.attempts){
    const card=this.hub.card(current.execution.fixed.steps[attempt.position].card_id),d=this.db.get('SELECT * FROM dispatches WHERE request_id=?',attempt.dispatch_id);
    if(d?.state==='pending'&&this.hub.pendingDispatch(card.id)?.request_id===attempt.dispatch_id)this.api.actionLocked(current.source.scope.member,card.id,'cancel','cancel',{});
    else if(attempt.run_id&&card.active_run_id===attempt.run_id&&card.fence===attempt.fence&&!this.hub.run(attempt.run_id)?.ended_at){
     this.api.actionLocked(current.source.scope.member,card.id,'stop','stop',{});
     this.db.insert('workflow_stop_requests',{execution_id:current.execution.row.id,run_id:attempt.run_id,fence:attempt.fence,requested_ms:this.hub.wallMs()});
    }
   }
  });
 }
 executionProjection(bound,id){
  const {source,execution}=this.executionSource(bound,id,{reviewPending:true}),row=execution.row,plan=this.currentPlan(source),auth=this.db.get('SELECT * FROM workflow_execution_authorizations WHERE execution_id=? ORDER BY revision DESC LIMIT 1',id),clock=this.plans.time();
  let authorized=false;try{this.authority(id);authorized=true;}catch{}
  const stops=this.db.all('SELECT run_id,fence,requested_ms FROM workflow_stop_requests WHERE execution_id=?',id);
  const reviewed=auth&&json(auth.snapshot,null);
  if(auth){try{if(!reviewed||hash(reviewed)!==auth.snapshot_hash||canonical(declaredPaths(reviewed.declared_paths))!==canonical(reviewed.declared_paths))throw changed();}catch{throw changed();}}
  const out={execution:{id,source_plan_id:row.source_plan_id,source_plan_hash:source.row.plan_hash,declared_paths:reviewed?.declared_paths??[],instance_id:row.instance_id,board_id:row.board_id,repository:plan.repository,revision:row.revision,
   state:row.state==='authorized'&&!authorized?'paused_authority':row.state,authorization_current:authorized,controls_allowed:this.hub.canWrite(source.scope.member),concurrency:source.snapshot.options.concurrency,
   valid_until:auth?new Date(auth.expires_ms).toISOString():null,remaining_ms:auth?Math.max(0,auth.expires_ms-clock.wall):0,
   path_source:'human_declared',advisory:true,global_filesystem_lock:false,automatic_source_transfer:false,
   steps:plan.steps.map((step,i)=>({...step,blocked_reasons:[...step.blocked_reasons,...(source.snapshot.options.dependencies.some(([from,to])=>to===i&&!this.predecessor(id,from))?['PREDECESSOR_REVIEW_REQUIRED']:[])],state:execution.steps[i].state,attempt_count:execution.steps[i].attempt_count,
    attempts:execution.attempts.filter(a=>a.position===i).map(a=>({id:a.id,attempt:a.attempt,state:a.state,request_id:a.dispatch_id,run_id:a.run_id,fence:a.fence})),
    predecessor_released:this.predecessor(id,i)})),stop_requests:stops.map(s=>({run_id:s.run_id,fence:s.fence,state:'requested',confirmed:false}))}};
  if(Buffer.byteLength(JSON.stringify(out))>LIMITS.bytes)throw new HubError('PAYLOAD_TOO_LARGE','Execution status exceeds 32 KiB. Shorten task titles.');return out;
 }
 executionResult(bound,id){const out=this.executionProjection(bound,id);proofs.set(out,{service:this,bound,id,execution:true});return out;}
 async status(member,id,cred,options={}){const bound=this.bound(member,cred,options,false),initial=this.executionSource(bound,id,{reviewPending:true});return this.hub.withBoard(initial.execution.row.board_id,()=>this.executionResult(bound,id));}
 wake(id){
  if(this.closed)return;
  this.pending.add(id);if(this.draining)return;this.draining=true;
  queueMicrotask(()=>this.drain());
 }
 async drain(){
  try{while(!this.closed&&this.pending.size){
   const batch=[...this.pending].slice(0,16);for(const id of batch)this.pending.delete(id);
   for(const id of batch){if(this.closed)break;let row;
    try{row=this.db.get('SELECT board_id FROM workflow_executions WHERE id=? AND state=\'authorized\'',id);if(!row)continue;
     await this.hub.withBoard(row.board_id,()=>{if(this.closed)return;return this.hub.txn(()=>{
      const authority=this.authority(id),auth=this.db.get('SELECT * FROM workflow_execution_authorizations WHERE execution_id=? AND revision=?',id,authority.row.revision);
      const bound=this.bound(authority.member,{kind:auth.credential_kind,id:auth.credential_id},{boardIds:authority.authorization.selection},false);this.admit(id);this.executionProjection(bound,id);
     });});
    }catch{if(!this.closed&&row)try{await this.hub.withBoard(row.board_id,()=>{if(!this.closed)return this.hub.txn(()=>this.core.pause(id,'blocked'));});}catch{}}
   }
   // Only already observed wakes are drained. Yield after each finite batch,
   // so more than16 or a wake received during a queue await cannot be lost.
   if(!this.closed&&this.pending.size)await new Promise(resolve=>setImmediate(resolve));
  }}finally{this.draining=false;if(this.closed)this.pending.clear();}
 }
 close(){this.closed=true;this.pending.clear();}
}
