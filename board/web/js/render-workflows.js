import { h } from './h.js';
import {workflowBlocker,currentWorkflowReview} from './workflow-journey.js';

export const starterWorkflow = () => ({ name: 'Feature delivery', description: 'Turn a request into verified work and a clear delivery review.', steps: [
  { title: 'Clarify the request', body: 'Document the outcome, constraints and affected users.', acceptance: 'The brief and acceptance criteria have been reviewed by the task owner.', plan_approval: true },
  { title: 'Implement and verify', body: 'Use the approved brief. Explain the approach, implement the change and record the checks performed.', acceptance: 'Relevant checks pass and evidence identifies the exact change.', plan_approval: true },
  { title: 'Review and deliver', body: 'Review the implementation and evidence, resolve feedback and prepare the delivery summary.', acceptance: 'A person approves the outcome. Client-facing material is published for the appropriate client review.', plan_approval: true },
] });
const button = (title, action, extra = {}) => h('button', { type: 'button', class: 'btn btn-sm', 'data-action': action, ...extra }, title);
const field = (label, name, value, max, required = false, multiline = false) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), h(multiline ? 'textarea' : 'input', { class: 'input', name, value, maxlength: String(max), required: required || null, rows: multiline ? 3 : null }));

export function workflowDialog(d, model) {
  const write = !model.readOnly, busy = !!d.busy, w = d.selected?.workflow;
  let body;
  if (d.journey) {
    body = workflowExecutionBody(d,model);
  } else if (d.mode === 'edit') {
    const def = d.draft;
    body = h('form', { class: 'modal-body workflow-editor', 'data-form': 'workflow-publish' },
      field('Workflow name', 'name', def.name, 80, true), field('Description', 'description', def.description, 1000, false, true),
      def.steps.map((s, i) => h('fieldset', { key: `step-${i}`, class: 'workflow-step' }, h('legend', null, `Step ${i + 1}`),
        field('Task title', `title-${i}`, s.title, 140, true), field('Brief', `body-${i}`, s.body, 4000, false, true), field('Done means', `acceptance-${i}`, s.acceptance, 2000, false, true),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `plan-${i}`, checked: s.plan_approval }), 'Require human approval of the AI’s plan'),
        def.steps.length > 1 ? button('Remove step', 'workflow-remove-step', { 'data-position': String(i), disabled: busy || null }) : null)),
      def.steps.length < 8 ? button('Add step', 'workflow-add-step', { disabled: busy || null }) : null,
      h('p', { class: 'hint' }, w ? `Publishing creates version ${w.version + 1}. Existing task sets keep their original version.` : 'Publish this task set for your team to reuse.'),
      d.error ? h('p', { class: 'form-error', role: 'alert' }, d.error) : null,
      h('div', { class: 'modal-foot' }, button('Back', 'workflow-library', { disabled: busy || null }), h('button', { class: 'btn btn-primary', type: 'submit', disabled: busy || !write || null }, busy ? 'Publishing…' : 'Publish workflow')));
  } else if (d.mode === 'preview' && w) {
    const v = d.selected.versions.find((version) => version.version === d.previewVersion) ?? w;
    body = h('form', { class: 'modal-body', 'data-form': 'workflow-apply' },
      h('h3', null, v.definition.name), h('p', { class: 'hint' }, v.definition.description),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Version'), h('select', { class: 'input', 'data-change': 'workflow-version', value: String(v.version), disabled: busy || null }, d.selected.versions.map((version) => h('option', { key: version.version, value: String(version.version) }, `Version ${version.version}${version.version === w.version ? ' · latest' : ''}`)))),
      h('ol', { class: 'workflow-preview' }, v.definition.steps.map((s, i) => h('li', { key: i }, h('strong', null, s.title), h('p', null, s.body), s.acceptance ? h('p', { class: 'hint' }, `Done means: ${s.acceptance}`) : null, s.plan_approval ? h('span', { class: 'hint' }, 'Human plan approval required') : null))),
      field('Project name (optional)', 'title_prefix', d.title_prefix ?? '', 50), field('Project context (optional)', 'context', d.context ?? '', 2000, false, true),
      h('p', { class: 'hint' }, `Create ${v.definition.steps.length} To do tasks on ${model.board?.name ?? 'this board'}. Assign and review each task using the board’s usual controls.`),
      d.error ? h('p', { class: 'form-error', role: 'alert' }, d.error) : null,
      h('div', { class: 'modal-foot' }, button('Back', 'workflow-library', { disabled: busy || null }), h('button', { type: 'submit', class: 'btn btn-primary', disabled: busy || !write || !!w.archived_at || null }, busy ? 'Creating tasks…' : `Create ${v.definition.steps.length} tasks`)));
  } else if (d.mode === 'detail' && w) {
    body = h('div', { class: 'modal-body' }, h('h3', null, w.definition.name), h('p', { class: 'hint' }, `Version ${w.version} · ${w.definition.steps.length} steps${w.archived_at ? ' · archived' : ''}`), h('p', null, w.definition.description),
      h('div', { class: 'board-manager-actions' }, button('Back', 'workflow-library'), write && !w.archived_at ? button('Use workflow', 'workflow-preview') : null, write && !w.archived_at ? button('Edit new version', 'workflow-edit') : null, write ? button(w.archived_at ? 'Restore workflow' : 'Archive workflow', 'workflow-archive', { disabled: busy || null }) : null),
      h('h4', null, 'Recent task sets'),
      d.selected.instances.length ? d.selected.instances.map((instance) => h('section', { key: instance.id, class: 'workflow-instance' },
        h('p', { class: 'hint' }, `Version ${instance.version} · ${instance.steps.filter((s) => s.column === 'done').length}/${instance.steps.length} tasks done`),
        model.accounts && instance.board_id === model.board?.id ? button('Review execution', 'workflow-execution-open', { 'data-instance': instance.id, disabled: busy || model.conn?.status !== 'open' || null }) : null,
        h('ol', null, instance.steps.map((s) => h('li', { key: s.id }, button(`${s.key} ${s.title}`, 'workflow-open-card', { 'data-card': s.id, 'data-board': instance.board_id, disabled: s.archived_at || null }), h('span', { class: 'hint' }, ` · ${s.archived_at ? 'archived' : s.run_state ?? s.column}`)))))) : h('p', { class: 'hint' }, 'No task sets created from this workflow yet.'),
      d.error ? h('p', { class: 'form-error', role: 'alert' }, d.error) : null);
  } else {
    body = h('div', { class: 'modal-body board-manager' }, h('p', { class: 'hint' }, 'Reusable task sets shared with this team. Every use records its exact version.'),
      h('div', { class: 'board-manager-actions' }, write ? button('New workflow', 'workflow-new') : null, button(d.includeArchived ? 'Hide archived' : 'Show archived', 'workflow-show-archived')),
      d.loading ? h('p', null, 'Loading workflows…') : d.workflows?.length ? d.workflows.map((recipe) => h('section', { key: recipe.id, class: 'board-manager-row' }, h('div', null, h('strong', null, recipe.definition.name), h('p', { class: 'hint' }, `Version ${recipe.version} · ${recipe.definition.steps.length} steps${recipe.archived_at ? ' · archived' : ''}`)), button('Open', 'workflow-select', { 'data-workflow': recipe.id }))) : h('p', { class: 'hint' }, 'No workflows published yet.'),
      d.error ? h('p', { class: 'form-error', role: 'alert' }, d.error) : null);
  }
  return h('dialog', { class: 'modal modal-wide', 'data-dialog': 'workflows', 'aria-labelledby': 'dlg-workflows-title' },
    h('div', { class: 'modal-head' }, h('h2', { id: 'dlg-workflows-title' }, 'Reusable workflows'), button('Close', 'close-dialog', { disabled: busy || null })), body);
}

const select=(label,name,value,options,disabled=false)=>h('label',{class:'field'},h('span',{class:'field-label'},label),h('select',{class:'input',name,value,disabled:disabled||null,required:true,'data-change':'workflow-choice'},options.map(option=>h('option',{key:option.value,value:option.value,disabled:option.disabled||null},option.label))));
const problems=reasons=>(reasons??[]).length?h('ul',{class:'workflow-blockers',role:'status'},[...new Set(reasons)].map(reason=>h('li',{key:reason},workflowBlocker(reason)))):null;
const stepReview=(steps,open=true)=>h('ol',{class:'workflow-preview'},steps.map(step=>h('li',{key:step.position},h('strong',null,`${step.key} ${step.title}`),
 h('p',{class:'hint'},`${step.provider_label??step.provider} · ${step.target?.name??'Selected member'} · ${step.budget_usd==null?'No dollar cap':`$${step.budget_usd} cap`} · ${step.plan_approval?'Human plan approval required':'Plan approval not required'}`),
 h('p',{class:'hint'},`Base ${step.base_ref||'not selected'}${step.depends_on?.length?` · after ${step.depends_on.map(p=>`step ${p+1}`).join(', ')}`:''}`),problems(step.blocked_reasons),
 open?button('Open task for review','workflow-open-card',{'data-card':step.card_id}):null)));
export function workflowExecutionBody(d,model){
 const connected=model.conn?.status==='open',write=!model.readOnly&&connected&&d.context?.can_write!==false&&d.execution?.controls_allowed!==false,busy=!!d.busy;
 const error=d.error?h('p',{class:'form-error',role:'alert'},d.error):null;
 const back=button('Back to workflow','workflow-select',{'data-workflow':d.selected?.workflow?.id,disabled:busy||null});
 if(!connected||d.mode==='execution-unavailable'||model.readOnly&&['execution-plan','execution-paths','execution-review','execution-stop'].includes(d.mode))return h('div',{class:'modal-body'},h('p',null,'Workflow details are unavailable. Reload a current view before controlling work.'),error,
  d.uncertain?h('p',{class:'hint'},'The response was interrupted. The command may already have committed; checking status does not start work.'):null,
  h('div',{class:'modal-foot'},back,button('Reload task set','workflow-execution-open',{'data-instance':d.instanceId,disabled:!connected||busy||null}),
   d.executionId?button('Check execution status','workflow-execution-status',{'data-execution':d.executionId,disabled:!connected||busy||null}):null,
   d.pending&&write?button('Retry the same request','workflow-execution-request-retry',{disabled:busy||null}):null));
 if(d.mode==='execution-configure'){
  const c=d.context,choices=d.choices;
  if(!c)return h('div',{class:'modal-body'},h('p',null,busy?'Loading current task choices…':'Reload the task set.'),error,back);
  return h('form',{class:'modal-body workflow-editor','data-form':'workflow-execution-configure'},h('h3',null,'Choose how these tasks run'),
   h('p',{class:'hint'},'Saving choices updates each task’s repository, base and plan policy. It creates a preview; no AI starts.'),
   c.executions.length?h('section',{class:'workflow-instance'},h('h4',null,'Existing executions'),c.executions.map(e=>h('p',{key:e.id},button(`Open ${e.state.replaceAll('_',' ')} execution`,'workflow-execution-status',{'data-execution':e.id,disabled:busy||null})))):null,
   h('div',{class:'field-row'},select('Repository','repo_id',choices.repo_id,[{value:'',label:'Choose a linked repository'},...c.repos.map(repo=>({value:repo.id,label:repo.name}))],busy||!write),field('Base branch (blank uses repository default)','base_ref',choices.base_ref,200)),
   select('Scheduling','concurrency',String(choices.concurrency),[{value:'1',label:'Sequential · review each predecessor'},{value:'2',label:'Up to two · review dependencies and intended paths'}],busy||!write),
   c.cards.map((card,position)=>{const choice=choices.steps[position];return h('fieldset',{key:card.id,class:'workflow-step'},h('legend',null,`${position+1}. ${card.key} ${card.title}`),
    h('div',{class:'field-row'},select('AI provider',`ai-${position}`,choice.ai,[{value:'codex',label:'Codex'},{value:'claude',label:'Claude Code'}],busy||!write),
     select('Machine owner',`target-${position}`,choice.target_member_id,c.members.map(member=>({value:member.id,label:member.name,disabled:!member.can_run})),busy||!write)),
    h('div',{class:'field-row'},select('Budget',`budget-mode-${position}`,choice.budget_mode,choice.ai==='codex'?[{value:'none',label:'No dollar cap (Codex)'}]:[{value:'cap',label:'Card dollar cap'},{value:'none',label:'No dollar cap'}],busy||!write),
     choice.ai==='claude'&&choice.budget_mode==='cap'?h('label',{class:'field'},h('span',{class:'field-label'},'Card budget in USD'),h('input',{class:'input',type:'number',name:`budget-${position}`,min:'0.5',max:'1000',step:'0.01',required:true,value:choice.budget_usd,disabled:busy||!write||null,'data-change':'workflow-choice'})):null),
    choice.ai==='codex'?h('p',{class:'hint'},'Codex uses the selected owner’s provider plan without a native dollar cap. Cost telemetry is unavailable.'):null,
    position?h('fieldset',{class:'workflow-step'},h('legend',null,'Reviewed prerequisites'),c.cards.slice(0,position).map((prior,from)=>h('label',{class:'check',key:from},h('input',{type:'checkbox',name:`depends-${position}-${from}`,checked:choices.dependencies.some(([a,b])=>a===from&&b===position),disabled:busy||!write||null,'data-change':'workflow-choice'}),`Step ${from+1}: ${prior.key} ${prior.title}`)),h('p',{class:'hint'},'Unchecked predecessors can run independently, within the reviewed concurrency and path limits.')):null,
    h('label',{class:'check'},h('input',{type:'checkbox',name:`plan-${position}`,checked:choice.plan_approval,disabled:card.plan_required||busy||!write||null,'data-change':'workflow-choice'}),card.plan_required?'Human plan approval required by this workflow':'Require human approval of the AI’s plan'));
   }),error,h('div',{class:'modal-foot'},back,h('button',{type:'submit',class:'btn btn-primary',disabled:busy||!write||null},busy?'Saving and previewing…':'Save choices and preview')));
 }
 if(d.mode==='execution-plan'||d.mode==='execution-paths'){
  const plan=d.plan;
  return h('form',{class:'modal-body workflow-editor','data-form':'workflow-execution-paths'},h('h3',null,d.purpose==='retry'?'Review a new paid attempt':d.purpose==='resume'?'Review resumed scheduling':'Review the task plan'),
   h('p',{class:'hint'},`${plan.repository?.name??d.execution?.repository?.name??'Selected repository'} · ${plan.concurrency??d.execution?.concurrency} concurrent task${(plan.concurrency??d.execution?.concurrency)===1?'':'s'}`),stepReview(plan.steps),
   h('p',{class:'hint'},'Declare relative files or directories, one per line (up to 16 per step; a directory may end in /**). Sequential work may leave paths unknown. Parallel work requires reviewed, non-overlapping declarations.'),
   plan.steps.map((step,position)=>field(`Step ${position+1} intended paths`,`paths-${position}`,(d.paths?.find(p=>p.position===position)?.paths??[]).join('\n'),3216,false,true)),
   h('p',{class:'hint'},'These paths are advisory. They do not lock files. A person must review changes to the base or integration between steps; there is no automatic merge or source transfer.'),error,
   h('div',{class:'modal-foot'},back,h('button',{type:'submit',class:'btn btn-primary',disabled:busy||!write||null},busy?'Verifying base and paths…':'Review current base and paths')));
 }
 if(d.mode==='execution-review'){
  const review=d.review,expired=!currentWorkflowReview(d,model.nowMs),allowed=write&&!busy&&!expired&&review.state==='inert'&&!review.blocked_reasons.length;
  return h('div',{class:'modal-body'},h('h3',null,review.purpose==='retry'?'Confirm a new paid attempt':review.purpose==='resume'?'Confirm resumed scheduling':'Confirm Start'),
   stepReview(review.steps),h('p',{class:'hint'},`Scheduling: up to ${review.concurrency} · review valid until ${review.valid_until}`),
   h('section',{class:'workflow-instance'},h('h4',null,'Verified base commits'),review.base_review.commits.map(commit=>h('p',{key:commit.position},`Step ${commit.position+1}: ${commit.base_ref} `,h('code',null,commit.sha))),
    !review.base_review.commits.length?h('p',null,'No verified base is available.'):null),
   h('section',{class:'workflow-instance'},h('h4',null,'Reviewed intended paths'),review.declared_paths.map(step=>h('p',{key:step.position},`Step ${step.position+1}: ${step.paths.join(', ')||'unknown · sequential only'}`))),
   problems(review.blocked_reasons),expired?h('p',{role:'status',class:'hint'},'This displayed review is older than 30 seconds. Verify it again before confirming.'):null,
   h('p',{class:'hint'},'Each successor requires human review or a verified merge of its exact predecessor. Plan and permission requests use the task’s usual approval controls. This confirmation supplies no approval or merge.'),
   h('label',{class:'check'},h('input',{type:'checkbox','data-change':'workflow-execution-confirm',checked:d.confirmed,disabled:!allowed||null}),'I reviewed the selected tasks, machine owners, provider budgets, paths and base commits. I authorize this scheduling and any new attempt shown.'),error,
   h('div',{class:'modal-foot'},back,button('Review again','workflow-execution-review-again',{disabled:busy||!write||null}),button(review.purpose==='start'?'Start reviewed workflow':review.purpose==='retry'?'Start reviewed retry':'Resume reviewed workflow','workflow-execution-confirm',{class:'btn btn-primary',disabled:!allowed||!d.confirmed||null})));
 }
 if(d.mode==='execution-stop'){const fresh=currentWorkflowReview(d,model.nowMs);return h('div',{class:'modal-body'},h('h3',null,d.purpose==='cancel'?'Cancel this execution?':'Pause future scheduling?'),
  h('p',null,d.purpose==='cancel'?'Cancel withdraws pending work and requests stop for the exact current runs. A requested stop does not confirm that a process exited.':'Pause withdraws unclaimed work and stops future scheduling. Already running work remains observed.'),
  h('label',{class:'check'},h('input',{type:'checkbox','data-change':'workflow-execution-confirm',checked:d.confirmed,disabled:busy||!write||!fresh||null}),`I confirm ${d.purpose==='cancel'?'Cancel':'Pause'} for this current execution.`),error,
  h('div',{class:'modal-foot'},button('Back to status','workflow-execution-status',{'data-execution':d.execution.id,disabled:busy||null}),button(d.purpose==='cancel'?'Request Cancel':'Pause scheduling','workflow-execution-stop',{class:'btn btn-quiet-danger',disabled:!d.confirmed||busy||!write||!fresh||null})));}
 const execution=d.execution;
 if(d.mode==='execution-status'&&execution)return h('div',{class:'modal-body'},h('h3',null,execution.state.replaceAll('_',' ')),h('p',{class:'hint'},`${execution.repository.name} · ${execution.authorization_current?'Current human scheduling authority':'Scheduling is not currently authorized'} · revision ${execution.revision}`),
  h('p',{class:'hint'},'Task state is observed by the hub. Review completed work from each task. Resume and Retry always require a new reviewed confirmation.'),
  h('ol',{class:'workflow-preview'},execution.steps.map(step=>h('li',{key:step.position},h('strong',null,`${step.key} ${step.title}`),h('p',null,`Step ${step.position+1}: ${step.state} · ${step.attempt_count} attempt${step.attempt_count===1?'':'s'}`),
   h('p',{class:'hint'},`${step.provider} · ${step.target.name} · ${step.budget_usd==null?'No dollar cap':`$${step.budget_usd} cap`}`),problems(step.blocked_reasons),
   button('Open task for review','workflow-open-card',{'data-card':step.card_id,'data-board':execution.board_id}),
   write&&!['completed','cancelled'].includes(execution.state)&&['failed','uncertain'].includes(step.attempts.at(-1)?.state)&&step.attempt_count<8?button('Review a new retry','workflow-execution-retry',{'data-position':String(step.position),disabled:busy||null}):null))),
  execution.stop_requests.length?h('p',{role:'status'},'Stop requested for current runs. Process exit has not been confirmed.'):null,error,
  h('div',{class:'modal-foot'},back,button(busy?'Refreshing…':'Refresh current status','workflow-execution-status',{'data-execution':execution.id,disabled:busy||null}),
   write&&!['cancelled','completed'].includes(execution.state)?[execution.authorization_current?button('Pause scheduling','workflow-execution-pause',{disabled:busy||null}):button('Review Resume','workflow-execution-resume',{disabled:busy||null}),button('Cancel execution','workflow-execution-cancel',{class:'btn btn-quiet-danger',disabled:busy||null})]:null));
 return h('div',{class:'modal-body'},error,back);
}
