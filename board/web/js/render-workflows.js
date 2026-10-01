import { h } from './h.js';

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
  if (d.mode === 'edit') {
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
