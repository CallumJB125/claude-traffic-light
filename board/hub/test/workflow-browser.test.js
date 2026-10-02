// Actual browser API/cookie/CSRF + DOM + enrolled WS; all state is synthetic
// in a temporary SQLite hub and all network traffic stays on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {tenancy,MARK} from './tenancy/fixture.js';
import {FakeRunner,until,runMsg,runHb,settle} from './helpers.js';
import {WorkflowExecutor} from '../workflow-executor.js';
import {api,setOrg,setCsrf} from '../../web/js/api.js';
import {WorkflowJourney,workflowExecutionSubmit,workflowExecutionChange,workflowExecutionAction} from '../../web/js/workflow-journey.js';
import {workflowDialog} from '../../web/js/render-workflows.js';
import {render} from '../../web/js/h.js';
const SHA='a'.repeat(40),HEAD='b'.repeat(40);
const capability={id:'codex',label:'Codex',installed:true,signedIn:true,startable:true,capabilities:{budget:'none',resume:true}};
async function fixture(t,{runner=false}={}){
 const f=await tenancy();t.after(()=>f.h.close());f.h.hub.github={enabled:true,async getBaseCommit(){return {sha:SHA};},async getCommit(_repo,sha){return sha===HEAD?{sha}:null;}};
 const recipe=await f.as(f.users.amember,'POST','/api/workflows',{request_id:randomUUID(),definition:{name:'Browser delivery',description:'Inert until confirmed',steps:[{title:'Implement <img onerror=unsafe>',body:'PRIVATE-BRIEF',acceptance:'Human reviews',plan_approval:false},{title:'Verify',body:'PRIVATE-SECOND-BRIEF',acceptance:'Human reviews',plan_approval:false}]}});assert.equal(recipe.status,200,recipe.text);
 const applied=await f.as(f.users.amember,'POST',`/api/boards/${f.A.board}/workflows/${recipe.body.workflow.id}/apply`,{request_id:randomUUID(),version:recipe.body.workflow.version,content_hash:recipe.body.workflow.content_hash});assert.equal(applied.status,200,applied.text);
 f.instance=applied.body.instance;f.recipe=recipe.body.workflow;
 if(runner){const enrolled=await f.as(f.users.amember,'POST',`/api/teams/${f.A.team}/enrol`,{});assert.equal(enrolled.status,200,enrolled.text);
  f.runner=new FakeRunner(f.h.base,{device_id:'',device_token:enrolled.body.runner_token,team:f.A.team});t.after(()=>f.runner.terminate());await f.runner.open();await f.runner.hello();f.runner.send({type:'advertise',repos:[{repo_id:f.A.repo}],ai:[capability]});await until(()=>f.h.hub.runners.get(f.runner.welcome.device_id)?.ai?.[0]?.signedIn===true);
 }
 return f;
}
const contextPath=f=>`/api/workflow-instances/${f.instance.id}/execution-context?board_id=${f.A.board}`;
const privateEffects=f=>JSON.stringify(['cards','journal','dispatches','runs','workflow_execution_plans','workflow_control_previews','workflow_executions','workflow_execution_receipts'].map(table=>f.db.all(`SELECT * FROM ${table} ORDER BY rowid`)));
function browser(t,f,session){
 const oldFetch=globalThis.fetch,oldDocument=globalThis.document,dom=new JSDOM('<main></main>'),requests=[];globalThis.document=dom.window.document;
 globalThis.fetch=(path,options)=>{if(!String(path).startsWith('/'))return oldFetch(path,options);requests.push({path,options});return oldFetch(f.h.base+path,{...options,headers:{...options.headers,cookie:session.cookie,origin:f.h.base}});};setOrg(f.A.team);setCsrf(session.csrf);
 t.after(()=>{globalThis.fetch=oldFetch;globalThis.document=oldDocument;setOrg(null);setCsrf(null);dom.window.close();});
 let dialog;const scope={boardId:f.A.board,generation:1,org:f.A.team,member:f.A.member,user:f.users.amember.id,role:'member',auth:'ok',accounts:true,connected:true,readOnly:false,epoch:f.h.hub.epoch},root=document.querySelector('main');
 const journey=new WorkflowJourney({api,getScope:()=>scope,getDialog:()=>dialog,setDialog:d=>{dialog=d;},update:()=>render(root,workflowDialog(dialog,{accounts:true,board:{id:f.A.board},readOnly:scope.readOnly,conn:{status:'open'},nowMs:Date.now()}))});
 const choose=(name,value)=>{const el=root.querySelector(`[name="${name}"]`);assert.ok(el,name);el.value=value;if(el.dataset.change)workflowExecutionChange(journey,el,dom.window.FormData);};
 const submit=()=>workflowExecutionSubmit(journey,root.querySelector('form'),dom.window.FormData);
 const confirm=async()=>{const el=root.querySelector('[data-change="workflow-execution-confirm"]');assert.ok(el,root.textContent);assert.equal(el.disabled,false,root.textContent);el.checked=true;workflowExecutionChange(journey,el,dom.window.FormData);return workflowExecutionAction(journey,dialog.mode==='execution-stop'?'workflow-execution-stop':'workflow-execution-confirm',{});};
 return {journey,root,requests,choose,submit,confirm,get dialog(){return dialog;}};
}
test('actual cookie+CSRF DOM journey configures, previews, Starts, Pauses, Resumes, explicitly Retries, reviews both tasks and reopens after refresh',async t=>{
 const f=await fixture(t,{runner:true}),session=await f.h.webSignIn(f.users.amember.email);assert.equal(session.res.status,200,session.res.text);const b=browser(t,f,session);
 const noLaunch=()=>{assert.equal(f.db.get('SELECT count(*) n FROM workflow_executions').n,0);assert.equal(f.db.get('SELECT count(*) n FROM dispatches WHERE card_id=?',f.instance.steps[0].id).n,0);};
 await b.journey.open(f.instance.id);assert.equal(b.dialog.mode,'execution-configure');assert.equal(b.root.querySelector('img'),null);assert.equal(b.root.textContent.includes(MARK),false);assert.equal(b.root.textContent.includes('PRIVATE-BRIEF'),false);
 b.choose('repo_id',f.A.repo);b.choose('base_ref','main');await b.submit();assert.equal(b.dialog.mode,'execution-plan',b.root.textContent);noLaunch();
 for(const step of f.instance.steps)assert.equal(f.h.hub.card(step.id).repo_id,f.A.repo);
 b.choose('paths-0','src/first/**');b.choose('paths-1','src/second/**');await b.submit();assert.equal(b.dialog.mode,'execution-review',b.root.textContent);assert.equal(b.dialog.review.base_review.commits[0].sha,SHA);noLaunch();
 assert.equal(b.root.querySelector('[data-action="workflow-execution-confirm"]').disabled,true);await b.confirm();assert.equal(b.dialog.mode,'execution-status',b.root.textContent);const executionId=b.dialog.execution.id;
 const start=b.requests.find(r=>r.path.includes('/start?'));assert.ok(start.options.headers['X-CSRF-Token']);assert.equal(start.options.credentials,'same-origin');assert.equal(JSON.parse(start.options.body).confirm,true);
 assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',executionId).n,1);
 const firstOffer=await f.runner.next('offer',o=>o.card_id===f.instance.steps[0].id);
 await b.journey.control('pause');await b.confirm();assert.equal(b.dialog.execution.authorization_current,false);assert.equal((await f.runner.claim(firstOffer)).ok,false);
 await b.journey.control('resume');await b.submit();assert.equal(b.dialog.review.purpose,'resume');await b.confirm();assert.equal(b.dialog.execution.authorization_current,true);
 const resumedOffer=await f.runner.next('offer',o=>o.card_id===firstOffer.card_id&&o.request_id!==firstOffer.request_id),failed=await f.runner.claim(resumedOffer);assert.equal(failed.ok,true,JSON.stringify(failed));
 const failedRun={...failed,card_id:firstOffer.card_id,repo_id:f.A.repo};await f.runner.out({...runMsg(failedRun),kind:'prep.failed',cause:'synthetic'});await until(()=>!!f.h.hub.run(failed.run_id).ended_at);await settle();
 await b.journey.status(executionId);assert.equal(b.dialog.execution.steps[0].attempts.at(-1).state,'uncertain');const before=f.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',executionId).n;
 await workflowExecutionAction(b.journey,'workflow-execution-retry',{dataset:{position:'0'}});await b.submit();assert.equal(b.dialog.review.purpose,'retry');assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',executionId).n,before);assert.match(b.root.textContent,/Confirm a new paid attempt/);await b.confirm();assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',executionId).n,before+1);
 const claim=async card=>{const offer=await f.runner.next('offer',o=>o.card_id===card&&o.request_id!==resumedOffer.request_id&&o.request_id!==firstOffer.request_id),response=await f.runner.claim(offer);assert.equal(response.ok,true,JSON.stringify(response));const run={...response,card_id:card,repo_id:f.A.repo};await f.runner.out({...runMsg(run),kind:'activity',source:'init'});await f.runner.hb([runHb(run)]);return run;};
 const complete=async run=>{const code=await f.runner.rpc(run,'board_attach_evidence',{kind:'commit',ref:HEAD}),checks=await f.runner.rpc(run,'board_attach_evidence',{kind:'test_run',ref:'synthetic tests',result:'pass'});assert.equal(code.ok,true,JSON.stringify(code));assert.equal(checks.ok,true,JSON.stringify(checks));const completed=await f.runner.rpc(run,'board_complete',{evidence_ids:[code.result.evidence_id,checks.result.evidence_id]});assert.equal(completed.ok,true,JSON.stringify(completed));};
 const first=await claim(firstOffer.card_id);await complete(first);await b.journey.status(executionId);assert.equal(b.dialog.execution.steps[0].predecessor_released,false);
 await api.action(first.card_id,'approve_done',{});await until(()=>f.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=? AND position=1',executionId).n===1);
 const second=await claim(f.instance.steps[1].id);await complete(second);await api.action(second.card_id,'approve_done',{});await until(()=>f.db.get('SELECT state FROM workflow_executions WHERE id=?',executionId).state==='completed');
 const previous=b.journey;previous.setDialog(null);b.journey=new WorkflowJourney({api,getScope:previous.getScope,getDialog:previous.getDialog,setDialog:previous.setDialog,update:previous.update});
 await b.journey.open(f.instance.id);assert.equal(b.dialog.context.executions[0].id,executionId);assert.match(b.root.textContent,/Open completed execution/);await b.journey.status(executionId);assert.equal(b.dialog.execution.state,'completed');assert.equal(b.root.querySelector('[data-action="workflow-execution-cancel"]'),null);
});
test('actual claimed-run Cancel is explicitly requested and never presented as confirmed process exit',async t=>{
 const f=await fixture(t,{runner:true}),session=await f.h.webSignIn(f.users.amember.email),b=browser(t,f,session);await b.journey.open(f.instance.id);b.choose('repo_id',f.A.repo);b.choose('base_ref','main');await b.submit();await b.submit();await b.confirm();
 const offer=await f.runner.next('offer',o=>o.card_id===f.instance.steps[0].id),response=await f.runner.claim(offer);assert.equal(response.ok,true);const run={...response,card_id:offer.card_id,repo_id:f.A.repo};await f.runner.out({...runMsg(run),kind:'activity',source:'init'});await f.runner.hb([runHb(run)]);
 await b.journey.control('cancel');assert.match(b.root.textContent,/does not confirm that a process exited/);await b.confirm();assert.equal(b.dialog.execution.state,'cancelled');assert.deepEqual(b.dialog.execution.stop_requests.map(s=>[s.state,s.confirmed]),[['requested',false]]);assert.match(b.root.textContent,/Process exit has not been confirmed/);
});
test('a real second-card choice conflict retains the first ordinary save, withholds the preview and explains partial-save recovery',async t=>{
 const f=await fixture(t),session=await f.h.webSignIn(f.users.amember.email),b=browser(t,f,session),original=f.h.app.api.patchCard.bind(f.h.app.api);let first=true;
 f.h.app.api.patchCard=async(...args)=>{const out=await original(...args);if(first){first=false;f.db.run('UPDATE cards SET version=version+1 WHERE id=?',f.instance.steps[1].id);}return out;};
 await b.journey.open(f.instance.id);b.choose('repo_id',f.A.repo);b.choose('base_ref','main');await b.submit();
 assert.equal(b.dialog.mode,'execution-unavailable');assert.match(b.root.textContent,/choices may have been saved/);assert.equal(f.h.hub.card(f.instance.steps[0].id).repo_id,f.A.repo);assert.equal(f.h.hub.card(f.instance.steps[1].id).repo_id,null);
 assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_plans').n,0);assert.equal(f.db.get('SELECT count(*) n FROM workflow_executions').n,0);assert.equal(b.root.querySelector('[data-action="workflow-execution-confirm"]'),null);
 await b.journey.open(f.instance.id);assert.equal(b.dialog.context.cards[0].repo_id,f.A.repo);assert.equal(b.dialog.context.cards[1].repo_id,null);
});
test('actual DOM parallel choices retain requested2 and explicit independent graph; overlap remains blocked until a new disjoint review',async t=>{
 const f=await fixture(t,{runner:true}),session=await f.h.webSignIn(f.users.amember.email),b=browser(t,f,session);await b.journey.open(f.instance.id);b.choose('repo_id',f.A.repo);b.choose('base_ref','main');b.choose('concurrency','2');
 const dependency=b.root.querySelector('[name="depends-1-0"]');assert.equal(dependency.checked,true);dependency.checked=false;workflowExecutionChange(b.journey,dependency,b.root.ownerDocument.defaultView.FormData);await b.submit();
 assert.equal(b.dialog.plan.concurrency,2);const posted=JSON.parse(b.requests.find(r=>r.path.includes('/preview?')).options.body);assert.deepEqual(posted.dependencies,[]);assert.equal(posted.concurrency,2);
 b.choose('paths-0','src/shared/**');b.choose('paths-1','src/shared/file.js');await b.submit();assert.ok(b.dialog.review.blocked_reasons.includes('DECLARED_PATH_OVERLAP'));assert.equal(b.root.querySelector('[data-action="workflow-execution-confirm"]').disabled,true);await b.journey.confirm();assert.equal(f.db.get('SELECT count(*) n FROM workflow_executions').n,0);
 await b.journey.review([{position:0,paths:['src/one/**']},{position:1,paths:['src/two/**']}]);assert.deepEqual(b.dialog.review.blocked_reasons,[]);await b.confirm();assert.equal(b.dialog.execution.concurrency,2);assert.equal(f.db.get('SELECT count(*) n FROM workflow_execution_attempts WHERE execution_id=?',b.dialog.execution.id).n,2);
});
test('current scoped context is inert, bounded, redacted, role-aware and rejects foreign board selection',async t=>{
 const f=await fixture(t),before=privateEffects(f),result=await f.as(f.users.amember,'GET',contextPath(f));assert.equal(result.status,200,result.text);assert.equal(privateEffects(f),before);assert.equal(result.text.includes(MARK),false);assert.equal(result.text.includes('PRIVATE-BRIEF'),false);assert.equal(result.text.includes('@alpha.test'),false);assert.ok(Buffer.byteLength(result.text)<=32768);
 assert.equal((await f.as(f.users.amember,'GET',contextPath(f).replace(f.A.board,f.B.board))).status,404);
 const viewer=await f.as(f.users.aviewer,'GET',contextPath(f));assert.equal(viewer.status,200,viewer.text);assert.equal(viewer.body.execution_context.can_write,false);
 // The server makes the bounded list refusal; no client parser can confer authority.
 for(let n=0;n<101;n++){const repo=randomUUID();f.db.insert('repos',{id:repo,org_id:f.A.team,canonical_url:`github.com/fixture/repo${n}`,short_name:'fixture'});f.db.run('INSERT INTO board_repos(board_id,repo_id) VALUES(?,?)',f.A.board,repo);}
 const oversized=await f.as(f.users.amember,'GET',contextPath(f));assert.equal(oversized.status,413,oversized.text);assert.equal(oversized.text.includes('PRIVATE-BRIEF'),false);
});
test('the final encoded32KiB context cap refuses oversized Unicode choices below individual row limits',async t=>{
 const f=await fixture(t);
 for(let n=0;n<42;n++){const repo=randomUUID();f.db.insert('repos',{id:repo,org_id:f.A.team,canonical_url:`github.com/fixture/wide${n}`,short_name:'漢'.repeat(80),default_branch:'漢'.repeat(200)});f.db.run('INSERT INTO board_repos(board_id,repo_id) VALUES(?,?)',f.A.board,repo);}
 const before=privateEffects(f),result=await f.as(f.users.amember,'GET',contextPath(f));assert.equal(result.status,413,result.text);assert.equal(result.body.error.code,'PAYLOAD_TOO_LARGE');assert.equal(privateEffects(f),before);assert.equal(result.body.execution_context,undefined);
});
for(const dimension of ['credential','session','both-owner','board-repo','card-board','removed-member'])test(`actual final context delivery withholds data after ${dimension} changed following the handler await`,async t=>{
 const f=await fixture(t),session=dimension==='session'?await f.h.webSignIn(f.users.amember.email):null;let destination=null;if(dimension==='card-board'){const created=await f.as(f.users.ua,'POST','/api/boards',{name:'Same-team destination'});assert.equal(created.status,200,created.text);destination=created.body.board.id;}f.db.run('UPDATE cards SET repo_id=? WHERE id=?',f.A.repo,f.instance.steps[0].id);const original=WorkflowExecutor.prototype.instanceContext;
 WorkflowExecutor.prototype.instanceContext=async function(...args){const out=await original.apply(this,args);
  if(dimension==='credential')f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',f.h.hub.iso(),f.users.amember.device_id);
  if(dimension==='session')f.db.run('UPDATE sessions SET revoked_at=? WHERE user_id=?',f.h.hub.iso(),f.users.amember.id);
  if(dimension==='both-owner'){f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',f.users.n.id,f.users.amember.device_id);f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);}
  if(dimension==='board-repo')f.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?',f.A.board,f.A.repo);
  if(dimension==='card-board')f.db.run('UPDATE cards SET board_id=? WHERE id=?',destination,f.instance.steps[0].id);
  if(dimension==='removed-member')f.db.run('UPDATE members SET removed_at=? WHERE id=?',f.h.hub.iso(),f.A.member);
  return out;
 };t.after(()=>WorkflowExecutor.prototype.instanceContext=original);
 const result=session?await f.h.call('GET',contextPath(f),{cookie:session.cookie,headers:{'Board-Org':f.A.team}}):await f.as(f.users.amember,'GET',contextPath(f));assert.ok([401,403,404,409].includes(result.status),result.text);assert.equal(result.body.execution_context,undefined);assert.equal(result.text.includes('Implement'),false);
});
test('private context proof is one-use, cannot be cloned and refreshes current role instead of retaining write controls',async t=>{
 const f=await fixture(t),service=f.h.app.api.workflowExecutor,member=f.h.hub.activeMember(f.A.member),cred={kind:'device',id:f.users.amember.device_id};
 const out=await service.instanceContext(member,f.instance.id,cred,{boardIds:[f.A.board]});assert.throws(()=>service.guard(structuredClone(out)),/fresh read/);
 f.db.run("UPDATE members SET role='viewer' WHERE id=?",f.A.member);service.guard(out);assert.equal(out.execution_context.can_write,false);assert.throws(()=>service.guard(out),/fresh read/);
});
