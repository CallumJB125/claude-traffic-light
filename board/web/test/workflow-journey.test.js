import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {render,textOf} from '../js/h.js';
import {workflowDialog} from '../js/render-workflows.js';
import {WorkflowJourney,workflowExecutionSubmit,workflowExecutionChange,workflowExecutionAction} from '../js/workflow-journey.js';
const id=()=>randomUUID(),hash='a'.repeat(64);
function rig(t,overrides={}){
 const board=id(),instance=id(),repo=id(),member=id(),card=id(),user=id();let dialog,now=1000;
 const scope={boardId:board,generation:1,org:id(),member,user,role:'member',auth:'ok',accounts:true,connected:true,readOnly:false,epoch:'one'};
 const context={instance_id:instance,board_id:board,recipe:{id:id(),version:1,content_hash:hash},cards:[{position:0,id:card,key:'PF-1',title:'<img onerror=unsafe> task',version:1,fence:0,repo_id:repo,base_ref:'main',plan_required:true,plan_approval:true}],repos:[{id:repo,name:'Repo',default_branch:'main'}],members:[{id:member,name:'Owner',can_run:true}],can_write:true,executions:[]};
 const plan={id:id(),hash,repository:{id:repo,name:'Repo'},concurrency:1,steps:[{position:0,card_id:card,key:'PF-1',title:context.cards[0].title,provider:'codex',target:{member_id:member,name:'Owner'},base_ref:'main',budget_usd:null,plan_approval:true,blocked_reasons:[]}]};
 const review={id:id(),hash,path_intent_hash:'b'.repeat(64),purpose:'start',expected_revision:0,concurrency:1,state:'inert',valid_until:'later',blocked_reasons:[],steps:plan.steps,declared_paths:[{position:0,paths:['src/**']}],base_review:{commits:[{position:0,base_ref:'main',sha:'c'.repeat(40)}]}};
 const execution={id:id(),source_plan_id:plan.id,source_plan_hash:hash,board_id:board,repository:plan.repository,revision:0,state:'authorized',authorization_current:true,controls_allowed:true,concurrency:1,declared_paths:review.declared_paths,steps:[{...plan.steps[0],state:'queued',attempt_count:1,attempts:[]}],stop_requests:[]};
 const calls=[];const api={workflowExecutionContext:async()=>({execution_context:context}),previewWorkflowPlan:async(...args)=>{calls.push(['plan',args]);return {plan};},previewWorkflowExecution:async(...args)=>{calls.push(['review',args]);return {execution_preview:review};},startWorkflow:async(...args)=>{calls.push(['start',args]);return {execution};},workflowExecution:async()=>({execution}),controlWorkflow:async(...args)=>{calls.push(['control',args]);return {execution};},...overrides};
 const dom=new JSDOM('<main></main>'),prior=globalThis.document;globalThis.document=dom.window.document;
 t.after(()=>{globalThis.document=prior;dom.window.close();});const root=document.querySelector('main');
 const draw=()=>dialog&&render(root,workflowDialog(dialog,{board:{id:board},accounts:true,readOnly:scope.readOnly,conn:{status:scope.connected?'open':'lost'},nowMs:now}));
 const journey=new WorkflowJourney({api,getScope:()=>scope,getDialog:()=>dialog,setDialog:d=>{dialog=d;},update:draw,now:()=>now});
 const submit=()=>workflowExecutionSubmit(journey,root.querySelector('form'),dom.window.FormData);
 const check=()=>{const el=root.querySelector('[data-change="workflow-execution-confirm"]');assert.ok(el);el.checked=true;workflowExecutionChange(journey,el,dom.window.FormData);};
 return {journey,scope,context,instance,plan,review,execution,calls,root,dom,submit,check,get dialog(){return dialog;},draw,setNow(value){now=value;}};
}
test('real DOM selects and forms preserve mandatory plan review and explicit triple-hash Start',async t=>{
 const f=rig(t);await f.journey.open(f.instance);assert.equal(f.root.querySelector('select[name="repo_id"]').value,f.context.repos[0].id);
 assert.equal(f.root.querySelector('[name="plan-0"]').disabled,true);assert.equal(f.root.querySelector('img'),null);
 await f.submit();assert.equal(f.dialog.mode,'execution-plan');assert.equal(f.calls[0][1][2].steps[0].plan_approval,true);assert.equal(f.calls[0][1][2].steps[0].budget_usd,null);
 f.root.querySelector('[name="paths-0"]').value='src/**';await f.submit();assert.equal(f.dialog.mode,'execution-review');assert.equal(f.calls.filter(c=>c[0]==='start').length,0);
 await f.journey.confirm();assert.equal(f.calls.filter(c=>c[0]==='start').length,0);f.check();
 await workflowExecutionAction(f.journey,'workflow-execution-confirm',{});const body=f.calls.at(-1)[1][2];
 assert.equal(body.execution_preview_id,f.review.id);assert.equal(body.execution_preview_hash,f.review.hash);assert.equal(body.path_intent_hash,f.review.path_intent_hash);assert.equal(body.plan_hash,f.plan.hash);assert.equal(body.confirm,true);
 assert.equal(f.dialog.mode,'execution-status');assert.match(f.root.textContent,/Current human scheduling authority/);
});
for(const field of ['boardId','generation','org','member','user','role','auth','accounts','connected','readOnly','epoch'])test(`pending browser context is withheld after current ${field} changes`,async t=>{
 let release;const f=rig(t,{workflowExecutionContext:()=>new Promise(r=>release=r)}),pending=f.journey.open(f.instance);
 f.scope[field]=typeof f.scope[field]==='boolean'?!f.scope[field]:typeof f.scope[field]==='number'?2:'changed';release({execution_context:f.context});await pending;
 assert.equal(f.dialog.context,undefined);assert.equal(f.calls.length,0);
});
test('blocked, old, clock-reversed and read-only reviews cannot Start or expose reviewed paths',async t=>{
 const f=rig(t);await f.journey.open(f.instance);await f.submit();await f.journey.review(f.review.declared_paths);f.check();
 f.setNow(31000);await f.journey.confirm();assert.equal(f.calls.filter(c=>c[0]==='start').length,0);assert.equal(f.root.querySelector('[data-action="workflow-execution-confirm"]').disabled,true);
 f.setNow(999);f.journey.put({...f.dialog,confirmed:true});await f.journey.confirm();assert.equal(f.calls.filter(c=>c[0]==='start').length,0);
 f.setNow(1001);f.review.blocked_reasons=['BASE_REVIEW_REQUIRED'];f.journey.put({...f.dialog,confirmed:true});await f.journey.confirm();assert.equal(f.calls.filter(c=>c[0]==='start').length,0);
 f.scope.readOnly=true;f.draw();assert.equal(f.root.textContent.includes('src/**'),false);assert.equal(f.root.querySelector('[data-action="workflow-execution-confirm"]'),null);
});
test('malformed path and dollar choices refuse before HTTP; Codex form cannot silently select a cap',async t=>{
 const f=rig(t);await f.journey.open(f.instance);const el=f.root.querySelector('[name="ai-0"]');el.value='claude';workflowExecutionChange(f.journey,el,f.dom.window.FormData);
 assert.ok(f.root.querySelector('[name="budget-mode-0"] option[value="cap"]'));el.value='codex';workflowExecutionChange(f.journey,el,f.dom.window.FormData);assert.equal(f.dialog.choices.steps[0].budget_mode,'none');
 await f.submit();const before=f.calls.length;await f.journey.review([{position:0,paths:['../private']}]);assert.equal(f.calls.length,before);assert.match(f.dialog.error,/closed workflow/);
});
test('an interrupted Start needs an explicit same-request retry and does not claim rollback',async t=>{
 let reject=true;const f=rig(t,{startWorkflow:async(...args)=>{f.calls.push(['start',args]);if(reject)throw Object.assign(new Error('network'),{code:'NETWORK'});return {execution:f.execution};}});
 await f.journey.open(f.instance);await f.submit();await f.journey.review(f.review.declared_paths);f.check();await f.journey.confirm();
 assert.equal(f.calls.filter(c=>c[0]==='start').length,1);assert.equal(f.dialog.mode,'execution-unavailable');assert.match(f.root.textContent,/may already have committed/);assert.equal(f.root.textContent.includes('src/**'),false);
 reject=false;await workflowExecutionAction(f.journey,'workflow-execution-request-retry',{});assert.equal(f.calls.filter(c=>c[0]==='start').length,2);assert.deepEqual(f.calls[1+1][1][2],f.calls.at(-1)[1][2]);assert.equal(f.dialog.mode,'execution-status');
});
test('Pause and Cancel require a fresh separate confirmation and requested-stop copy never claims exit',async t=>{
 const f=rig(t);await f.journey.open(f.instance);await f.journey.status(f.execution.id);await f.journey.control('pause');await f.journey.stop();assert.equal(f.calls.length,0);
 f.check();f.setNow(31000);await f.journey.stop();assert.equal(f.calls.length,0);assert.match(f.dialog.error,/Refresh current status/);
 f.setNow(31001);await f.journey.control('cancel');f.check();f.execution.stop_requests=[{state:'requested',confirmed:false}];await f.journey.stop();assert.equal(f.calls.at(-1)[1][2],'cancel');assert.match(f.root.textContent,/Process exit has not been confirmed/);
});
test('Check status after an outage performs a new current scoped read and enables no automatic command',async t=>{
 const reads=[],f=rig(t,{workflowExecution:async(...args)=>{reads.push(args);return {execution:f.execution};}});await f.journey.open(f.instance);await f.journey.status(f.execution.id);
 f.scope.connected=false;f.journey.invalidate();f.scope.connected=true;await workflowExecutionAction(f.journey,'workflow-execution-status',{dataset:{execution:f.execution.id}});
 assert.equal(f.dialog.mode,'execution-status');assert.equal(reads.length,2);assert.equal(reads.at(-1)[1],f.scope.boardId);assert.equal(f.calls.length,0);
});
test('actual app outage/reconnect and restart handlers discard the private dialog identity immediately',async t=>{
 const f=rig(t),source=readFileSync(new URL('../js/app.js',import.meta.url),'utf8');await f.journey.open(f.instance);await f.submit();await f.journey.review(f.review.declared_paths);const original=f.dialog.instance;
 const onStatus=source.slice(source.indexOf('function onStatus('),source.indexOf('\nfunction onMessage(')),onEpoch=source.slice(source.indexOf('function onHubEpoch('),source.indexOf('\nlet dashUpsertTimer'));
 const state={dialog:f.dialog,conn:{status:'open'},dash:{epoch:'one'},presence:{},view:'board'};
 const proxy={invalidate:message=>{f.journey.invalidate(message);state.dialog=f.dialog;}};
 const handlers=new Function('state','workflowJourney','update','refreshDetail','perf','resetDashboard','loadJournal','socket','boot','let detailRefresh=0;'+onEpoch+'\n'+onStatus+'\nreturn{onStatus,onHubEpoch};')(state,proxy,()=>{},()=>{},()=>0,()=>{},()=>{},null,()=>{});
 handlers.onStatus({status:'lost'});handlers.onStatus({status:'open'});assert.notEqual(f.dialog.instance,original);assert.equal(f.dialog.review,undefined);assert.equal(f.root.textContent.includes('src/**'),false);
 await f.journey.open(f.instance);const before=f.dialog.instance;state.dialog=f.dialog;handlers.onHubEpoch('two');assert.notEqual(f.dialog.instance,before);assert.equal(f.dialog.context,undefined);
});
