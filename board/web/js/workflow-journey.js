// Human browser controls only. A displayed hash is never execution authority.
import {requestId,errorText} from './api.js';
import {validatePreview} from '../../shared/workflow-execution.js';
import {validateExecutionPreview,validateControlPreview,validateCommand} from '../../shared/workflow-execution-controls.js';
import {PLAN_APPROVAL_LABEL} from '../../shared/states.js';
const sameScope=(a,b)=>['boardId','generation','org','member','user','role','auth','accounts','connected','readOnly','epoch'].every(key=>a[key]===b[key]);
const failure=message=>Object.assign(new Error(message),{code:'CONFLICT'});
export const workflowBlocker=reason=>({BASE_REVIEW_REQUIRED:'The hub could not verify the base commit. Connect the repository integration and review again.',RUNNER_READINESS_UNCONFIRMED:'The selected member needs a connected, enrolled, signed-in runner for this repository.',PARALLEL_PLAN_REQUIRED:'Declare relative paths for every parallel step.',DECLARED_PATH_OVERLAP:'The declared paths overlap. Edit them or choose sequential execution.',PARALLEL_SCOPE_UNKNOWN:'Current editing paths are unknown. Parallel execution is blocked.',PREDECESSOR_REVIEW_REQUIRED:'Review the exact predecessor attempt or its verified merge first.',BUDGET_EXHAUSTED:'This task has no remaining budget.',AUTOMATION_DISABLED:'This task disables automatic scheduling.'}[reason]??String(reason).replaceAll('_',' ').toLowerCase());
export function workflowChoices(context,member){
 const repo=context.cards.every(card=>card.repo_id===context.cards[0].repo_id)?context.cards[0].repo_id:null;
 return {repo_id:repo??'',base_ref:context.cards.every(card=>card.base_ref===context.cards[0].base_ref)?context.cards[0].base_ref:'',concurrency:1,dependencies:context.cards.slice(1).map((_card,index)=>[index,index+1]),
  steps:context.cards.map(card=>({ai:'codex',target_member_id:member,budget_usd:'',budget_mode:'none',plan_approval:card.plan_approval||card.plan_required}))};
}
export function workflowForm(context,fd){
 return {repo_id:String(fd.get('repo_id')??''),base_ref:String(fd.get('base_ref')??'').trim(),concurrency:Number(fd.get('concurrency')),dependencies:context.cards.flatMap((card,to)=>context.cards.slice(0,to).flatMap((_prior,from)=>fd.get(`depends-${to}-${from}`)==='on'?[[from,to]]:[])),
  steps:context.cards.map(card=>({ai:String(fd.get(`ai-${card.position}`)),target_member_id:String(fd.get(`target-${card.position}`)),
   budget_mode:String(fd.get(`budget-mode-${card.position}`)??'none'),budget_usd:String(fd.get(`budget-${card.position}`)??''),plan_approval:card.plan_required||fd.get(`plan-${card.position}`)==='on'}))};
}
export function pathForm(steps,fd){return steps.map((step,position)=>({position,paths:String(fd.get(`paths-${position}`)??'').split(/\r?\n/).map(path=>path.trim()).filter(Boolean)}));}
export function reviewCommand(kind,plan,review,request_id=requestId(),previous=null){
 return validateCommand(kind,{request_id,expected_revision:review.expected_revision,execution_preview_id:review.id,execution_preview_hash:review.hash,path_intent_hash:review.path_intent_hash,confirm:true,
  ...(kind==='start'?{plan_hash:plan.hash}:{}),...(kind==='retry'?{previous_attempt_id:previous}:{})});
}
export class WorkflowJourney{
 constructor({api,getScope,getDialog,setDialog,update,now=Date.now}){Object.assign(this,{api,getScope,getDialog,setDialog,update,now});}
 current(d,write=false){const scope=this.getScope();return this.getDialog()?.instance===d.instance&&sameScope(d.scope,scope)&&scope.auth==='ok'&&scope.accounts&&scope.connected&&(!write||!scope.readOnly&&d.context?.can_write!==false&&d.execution?.controls_allowed!==false);}
 put(d){this.setDialog(d);this.update();}
 create(extra){return {kind:'workflows',instance:{},scope:{...this.getScope()},busy:false,error:null,...extra};}
 invalidate(message='The board changed. Reload this task set before reviewing or controlling it.'){
  const d=this.getDialog();if(!d?.journey)return;
  // No cached source/path/status survives an outage, account or epoch change.
  this.put(this.create({journey:true,mode:'execution-unavailable',instanceId:d.instanceId,selected:d.selected,executionId:d.execution?.id??d.executionId,error:message}));
 }
 async run(d,work,accept,{pending=null,write=false,failureHint=null}={}){
  if(d.busy||!this.current(d,write))return;this.put({...d,busy:true,error:null});
  try{const result=await work();if(this.current(d,write))this.put({...this.getDialog(),busy:false,pending:null,uncertain:false,...accept(result)});}
  catch(error){if(this.current(d)){this.put({...this.create({journey:true,instanceId:d.instanceId,selected:d.selected,executionId:d.execution?.id??d.executionId}),mode:'execution-unavailable',error:[failureHint,error.code==='CONFLICT'?error.message:errorText(error)].filter(Boolean).join(' '),pending:error.code==='NETWORK'?pending:null,uncertain:!!pending&&error.code==='NETWORK'});}}
 }
 async open(instanceId,selected){
  const scope=this.getScope();if(!scope.accounts||!scope.connected||scope.auth!=='ok')return;
  const d=this.create({journey:true,mode:'execution-configure',instanceId,selected});this.put(d);
  return this.run(d,()=>this.api.workflowExecutionContext(instanceId,d.scope.boardId),out=>{const context=out.execution_context;
   if(context.board_id!==d.scope.boardId||context.instance_id!==instanceId)throw failure('This task set changed board.');
   return {context,choices:workflowChoices(context,d.scope.member),loadedAt:this.now()};});
 }
 async configure(choices){
  const d=this.getDialog();if(!d?.context||!this.current(d,true))return;
  const repo=d.context.repos.find(repo=>repo.id===choices.repo_id);if(!repo){this.put({...d,error:'Choose a repository linked to this board.'});return;}
  const base=choices.base_ref||repo.default_branch;
  if(!base||base.length>200){this.put({...d,error:'Choose a base branch (up to 200 characters).'});return;}
  const input={request_id:requestId(),board_id:d.scope.boardId,repo_id:repo.id,recipe_version:d.context.recipe.version,content_hash:d.context.recipe.content_hash,concurrency:choices.concurrency,dependencies:choices.dependencies,
   steps:d.context.cards.map((card,position)=>({...{position,card_id:card.id,version:card.version,fence:card.fence},ai:choices.steps[position].ai,target_member_id:choices.steps[position].target_member_id,
    budget_usd:choices.steps[position].budget_mode==='none'?null:Number(choices.steps[position].budget_usd),plan_approval:choices.steps[position].plan_approval}))};
  try{validatePreview(input);}catch(error){this.put({...d,choices,error:error.message});return;}
  this.put({...d,choices});
  return this.run(d,async()=>{
   for(const [position,card] of d.context.cards.entries()){
    if(!this.current(d,true))throw failure('The board changed.');
    const choice=choices.steps[position],patch={request_id:requestId(),version:card.version,repo_id:repo.id,base_ref:base};
    if(card.plan_approval!==choice.plan_approval){const {card:fresh}=await this.api.card(card.id);
     if(!this.current(d,true)||fresh.version!==card.version)throw failure('A task changed. Reload and review its current choices.');
     patch.labels=choice.plan_approval?[...new Set([...fresh.labels,PLAN_APPROVAL_LABEL])]:fresh.labels.filter(label=>label!==PLAN_APPROVAL_LABEL);
    }
    if(card.repo_id!==repo.id||card.base_ref!==base||patch.labels){
     const {card:saved}=await this.api.patchCard(card.id,patch);if(!this.current(d,true))throw failure('The board changed.');
     input.steps[position].version=saved.version;input.steps[position].fence=saved.fence;
    }
   }
   if(!this.current(d,true))throw failure('The board changed.');return this.api.previewWorkflowPlan(d.instanceId,d.scope.boardId,validatePreview(input));
  },out=>({mode:'execution-plan',plan:out.plan,context:null,paths:out.plan.steps.map(step=>({position:step.position,paths:[]})),loadedAt:this.now()}),{write:true,failureHint:'Task choices may have been saved. Reload the current task set before reviewing again.'});
 }
 async review(paths){
  const d=this.getDialog();if(!d?.plan||!this.current(d,true))return;
  const body=d.purpose&&d.purpose!=='start'?{request_id:requestId(),source_plan_id:d.execution.source_plan_id,plan_hash:d.execution.source_plan_hash,expected_revision:d.execution.revision,purpose:d.purpose,declared_paths:paths,
   ...(d.purpose==='retry'?{position:d.position,previous_attempt_id:d.previousAttempt}:{})}:{request_id:requestId(),plan_hash:d.plan.hash,purpose:'start',declared_paths:paths};
  try{(body.purpose==='start'?validateExecutionPreview:validateControlPreview)(body);}catch(error){this.put({...d,paths,error:error.message});return;}
  return this.run(d,()=>body.purpose==='start'?this.api.previewWorkflowExecution(d.plan.id,d.scope.boardId,body):this.api.previewWorkflowControl(d.execution.id,d.scope.boardId,body),
   out=>({mode:'execution-review',review:out.execution_preview,paths,confirmed:false,loadedAt:this.now()}),{write:true});
 }
 fresh(d){return currentWorkflowReview(d,this.now());}
 async confirm(){
  const d=this.getDialog();if(!d?.review||!d.confirmed||!this.current(d,true))return;
  if(!this.fresh(d)||d.review.state!=='inert'||d.review.blocked_reasons.length){this.put({...d,confirmed:false,error:'This review needs to be refreshed before confirmation.'});return;}
  const kind=d.review.purpose,body=reviewCommand(kind,d.plan,d.review,requestId(),d.previousAttempt),pending={kind,body,planId:d.plan?.id,executionId:d.execution?.id,position:d.position};
  return this.perform(d,pending);
 }
 async perform(d,pending){
  return this.run(d,()=>pending.kind==='start'?this.api.startWorkflow(pending.planId,d.scope.boardId,pending.body):this.api.controlWorkflow(pending.executionId,d.scope.boardId,pending.kind,pending.body,pending.position),
   out=>({mode:'execution-status',execution:out.execution,executionId:out.execution.id,plan:null,review:null,context:null,purpose:null,loadedAt:this.now()}),{pending,write:true});
 }
 async retryPending(){const d=this.getDialog();if(d?.pending&&this.current(d,true))return this.perform(d,d.pending);}
 async status(id){
  let d=this.getDialog();if(!d?.journey)return;
  // Recovery is a new scoped read, never a replay of cached control authority.
  if(d.mode==='execution-unavailable'){const scope=this.getScope();if(scope.auth!=='ok'||!scope.accounts||!scope.connected)return;d=this.create({journey:true,mode:'execution-unavailable',instanceId:d.instanceId,selected:d.selected,executionId:id});this.put(d);}
  if(!this.current(d))return;
  return this.run(d,()=>this.api.workflowExecution(id,d.scope.boardId),out=>({mode:'execution-status',execution:out.execution,executionId:id,plan:null,review:null,context:null,purpose:null,loadedAt:this.now()}));
 }
 async control(purpose,position=null){
  const d=this.getDialog();if(!d?.execution||!this.current(d,true))return;
  // Controls are chosen only from a freshly fetched current revision.
  return this.run(d,()=>this.api.workflowExecution(d.execution.id,d.scope.boardId),out=>{
   const execution=out.execution;if(['cancelled','completed'].includes(execution.state))throw failure('This execution has already finished. Reload status.');
   if(purpose==='pause'||purpose==='cancel')return {mode:'execution-stop',purpose,execution,confirmed:false,loadedAt:this.now()};
   const step=execution.steps[position],attempt=step?.attempts.at(-1);
   if(purpose==='retry'&&(!attempt||!['failed','uncertain'].includes(attempt.state)||attempt.attempt>=8))throw failure('This step has no failed attempt available for a reviewed Retry.');
   return {mode:'execution-paths',purpose,execution,position,previousAttempt:attempt?.id,plan:{id:execution.source_plan_id,hash:execution.source_plan_hash,steps:execution.steps},paths:execution.declared_paths,review:null,loadedAt:this.now()};
  },{write:true});
 }
 async stop(){
  const d=this.getDialog();if(!d?.execution||!d.confirmed||!['pause','cancel'].includes(d.purpose)||!this.current(d,true))return;
  if(!this.fresh(d)){this.put({...d,confirmed:false,error:'Refresh current status before confirming this control.'});return;}
  const pending={kind:d.purpose,executionId:d.execution.id,body:validateCommand(d.purpose,{request_id:requestId(),expected_revision:d.execution.revision})};return this.perform(d,pending);
 }
}
export function currentWorkflowReview(d,now){const age=now-d.loadedAt;return Number.isFinite(age)&&age>=0&&age<30000;}
export function workflowExecutionAction(journey,action,el,selected){
 const d=journey.getDialog();
 switch(action){
  case 'workflow-execution-open':return journey.open(el.dataset.instance,selected??d?.selected);
  case 'workflow-execution-status':return journey.status(el.dataset.execution);
  case 'workflow-execution-confirm':return journey.confirm();
  case 'workflow-execution-stop':return journey.stop();
  case 'workflow-execution-review-again':return journey.review(d.paths);
  case 'workflow-execution-request-retry':return journey.retryPending();
  case 'workflow-execution-pause':return journey.control('pause');
  case 'workflow-execution-cancel':return journey.control('cancel');
  case 'workflow-execution-resume':return journey.control('resume');
  case 'workflow-execution-retry':return journey.control('retry',Number(el.dataset.position));
 }
}

export function workflowExecutionSubmit(journey,form,FormDataCtor=FormData){
 const d=journey.getDialog();
 if(form.dataset.form==='workflow-execution-configure'&&d?.context)return journey.configure(workflowForm(d.context,new FormDataCtor(form)));
 if(form.dataset.form==='workflow-execution-paths'&&d?.plan)return journey.review(pathForm(d.plan.steps,new FormDataCtor(form)));
}
export function workflowExecutionChange(journey,el,FormDataCtor=FormData){
 const d=journey.getDialog();if(!d?.journey||d.busy||!journey.current(d,true))return;
 if(el.dataset.change==='workflow-execution-confirm'){journey.put({...d,confirmed:el.checked===true});return;}
 if(el.dataset.change==='workflow-choice'&&d.context){
  const choices=workflowForm(d.context,new FormDataCtor(el.form));
  for(const choice of choices.steps)if(choice.ai==='codex')choice.budget_mode='none';
  journey.put({...d,choices,error:null});
 }
}
