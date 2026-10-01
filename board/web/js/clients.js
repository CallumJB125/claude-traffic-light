import { h, render } from './h.js';
import { clientCall } from './client-api.js';

const root = document.getElementById('clients');
const scopes = { 'status.read': 'Project status', 'artifacts.read': 'Shared deliverables', 'feedback.create': 'Send feedback', 'approvals.decide': 'Decide assigned approvals' };
const statuses = { todo: 'Planned', in_progress: 'In progress', review: 'Ready for review', done: 'Complete' };
const state = { account: null, workspaces: [], workspace: null, projects: [], project: null, items: [], manage: null, cards: [], boards: [], projectArchived: false, error: null, busy: false, link: null };
let generation = 0;
const eid = encodeURIComponent;
const selectedWorkspace = new URL(location.href).searchParams.get('workspace');
let workspaceId = selectedWorkspace, projectId = null;
const btn = (label, action, extra = {}) => h('button', { type: 'button', class: 'btn', 'data-action': action, disabled: state.busy, ...extra }, label);
const field = (label, name, props = {}) => h('label', {}, label, h('input', { class: 'input', name, ...props }));
const select = (label, name, choices, value) => h('label', {}, label, h('select', { class: 'input', name, value, disabled: state.busy }, choices.map((c) => h('option', { value: c.id }, c.name))));
const submit = (label) => h('button', { type: 'submit', class: 'btn btn-primary', disabled: state.busy }, label);
const form = (kind, ...kids) => h('form', { class: 'client-form', 'data-form': kind }, kids);
const section = (title, ...kids) => h('section', { class: 'client-section' }, h('h2', {}, title), kids);
const scopeFields = () => h('fieldset', {}, h('legend', {}, 'Client permissions'), Object.entries(scopes).map(([s, label]) => h('label', { class: 'client-check' }, h('input', { type: 'checkbox', name: 'scope', value: s, checked: s === 'status.read', disabled: s === 'status.read' }), label)));

function draw() {
  const w = state.workspace, admin = state.manage != null;
  render(root, h('div', {},
    h('header', { class: 'client-heading' }, h('h1', {}, 'Client projects'), h('nav', { class: 'client-actions', 'aria-label': 'Account' },
      state.account?.teams?.length ? h('a', { href: '/', class: 'btn' }, 'Team board') : null,
      state.account ? [h('a', { href: '/api/account/client-export', class: 'btn', download: 'plexiform-client-data.json' }, 'Export my client data'), btn('Sign out', 'signout')] : h('a', { href: '/signin', class: 'btn btn-primary' }, 'Sign in'))),
    h('p', { class: 'client-lead' }, 'Project updates and deliverables shared with you.'),
    state.error ? h('p', { role: 'alert', class: 'client-error' }, state.error) : null,
    !state.account ? h('p', { role: 'status' }, 'Sign in with the email address used for your invitation.') : null,
    state.account?.pending_client_invites?.length ? section('Your invitations', state.account.pending_client_invites.map((i) => h('div', { class: 'client-person', key: i.id }, h('p', {}, `${i.inviter_first_name} invited you to ${i.workspace_name}.`), btn('Accept invitation', 'accept', { 'data-invite': i.id })))) : null,
    state.workspaces.length ? select('Workspace', 'workspace', state.workspaces, w?.id) : state.account ? h('p', { role: 'status' }, 'No client projects are shared with you yet.') : null,
    w ? section(w.name,
      state.projects.length ? select('Project', 'project', state.projects, state.project?.id) : h('p', {}, 'No projects are available.'),
      state.project ? h('div', { class: 'client-status', 'aria-label': 'Published project updates' }, state.items.length ? state.items.map((i) => h('article', { class: 'client-item', key: i.id, 'data-item': i.id }, h('span', { class: 'client-badge' }, statuses[i.status]), h('h3', {}, i.title), i.summary ? h('p', {}, i.summary) : null,
        artifactView(i, admin), admin && !state.projectArchived ? btn('Stop sharing', 'unpublish', { 'data-item': i.id }) : null)) : h('p', {}, 'Your team has not shared any updates for this project yet.')) : null,
      btn('Refresh updates', 'refresh')) : null,
    admin ? staffView() : null,
    state.account?.teams?.some((t) => ['owner', 'admin'].includes(t.role)) ? section('New client workspace', h('p', { class: 'client-lead' }, 'Creates a separate team and its first project. Invite staff through its Team board and clients through this page.'), form('workspace', field('Client workspace name', 'name', { required: true, maxlength: 60 }), submit('Create client workspace'))) : null,
  ));
}

function artifactView(item, admin) {
  const v = item.artifact;
  const eligible = (state.manage?.guests ?? []).filter((g) => !g.revoked_at && g.grants.some((p) => p.project_id === state.project?.id && p.scopes.includes('artifacts.read') && p.scopes.includes('approvals.decide')));
  const labels = { pending: 'Waiting for a decision', approved: 'Approved', rejected: 'Changes requested', superseded: 'Replaced by a newer version', withdrawn: 'Withdrawn' };
  return h('div', { class: 'client-deliverable' }, v ? [h('p', {}, `Deliverable · Version ${v.version_number}`), h('a', { href: v.content_url, class: 'client-link', download: v.name, 'data-artifact': v.id }, `Download ${v.name}`)] : null,
    (item.approvals ?? []).map((a) => h('div', { class: 'client-approval', key: a.id, 'data-approval': a.id }, h('p', {}, `Approval for version ${a.version_number}: ${labels[a.status]}`),
      a.decisions.filter((d) => d.decision).map((d) => h('p', {}, `${d.name}: ${d.decision === 'approve' ? 'Approved' : 'Changes requested'}${d.comment ? ` — ${d.comment}` : ''}`)),
      a.can_decide ? h('form', { 'data-form': 'decision', 'data-approval': a.id, class: 'client-form' }, h('label', {}, 'Optional note', h('textarea', { name: 'comment', class: 'input', maxlength: 1000 })), h('div', { class: 'client-actions' }, h('button', { type: 'submit', name: 'decision', value: 'approve', class: 'btn btn-primary', disabled: state.busy }, `Approve version ${a.version_number}`), h('button', { type: 'submit', name: 'decision', value: 'reject', class: 'btn', disabled: state.busy }, 'Request changes'))) : null,
      admin && a.current && !state.projectArchived ? btn('Withdraw approval request', 'withdraw-approval', { 'data-approval': a.id }) : null)),
    admin && !state.projectArchived ? [h('form', { 'data-form': 'artifact', 'data-item': item.id, class: 'client-form' }, field(v ? 'Publish a replacement deliverable' : 'Share a deliverable', 'file', { type: 'file', required: true, accept: '.png,.jpg,.jpeg,.webp,.pdf,.txt' }), h('p', { class: 'client-lead' }, 'PNG, JPEG, WebP, PDF or text. Up to 8 MiB per file.'), submit(v ? 'Publish new version' : 'Publish deliverable')),
      v && eligible.length ? h('form', { 'data-form': 'approval', 'data-item': item.id, class: 'client-form' }, h('fieldset', {}, h('legend', {}, `Ask clients to review version ${v.version_number}`), eligible.map((g) => h('label', { class: 'client-check' }, h('input', { type: 'checkbox', name: 'guest_id', value: g.id }), g.display_name))), submit('Request approval')) : v ? h('p', { class: 'client-lead' }, 'Give a client Shared deliverables and Decide assigned approvals permission to request their review.') : null] : null);
}

function staffView() {
  const m = state.manage, p = m.projects.find((p) => p.id === state.project?.id);
  return [
    section('Share a project update', p ? [h('a', { href: `/?org=${eid(m.workspace.id)}&board=${eid(p.board_id)}`, class: 'client-link' }, 'Open this project’s Team board'), state.projectArchived ? h('p', {}, 'This project is archived. Shared updates remain readable.') : state.cards.length ? form('publish',
      select('Internal task', 'card_id', state.cards.map((c) => ({ id: c.id, name: `${c.key} · ${c.title}` }))),
      field('Client title', 'title', { required: true, maxlength: 200 }), h('label', {}, 'Client summary', h('textarea', { name: 'summary', class: 'input', maxlength: 2000 })),
      select('Client status', 'status', Object.entries(statuses).map(([id, name]) => ({ id, name })), 'todo'), submit('Share update')) : h('p', {}, 'Create an internal task on the Team board to share its client update.')] : null),
    section('Invite a client', form('invite', field('Client email', 'email', { type: 'email', required: true }), select('Permitted project', 'project_id', m.projects), scopeFields(), submit('Invite client')),
      state.link ? h('label', { class: 'client-form' }, 'Invitation link', h('input', { class: 'input', 'aria-label': 'Client invitation link', value: state.link, readonly: true })) : null,
      m.invites.map((i) => h('div', { key: i.id, class: 'client-person' }, h('p', {}, i.email), btn('Resend invitation', 'resend', { 'data-invite': i.id }), ' ', btn('Withdraw invitation', 'withdraw', { 'data-invite': i.id })))),
    section('Client access', m.guests.map((g) => h('div', { key: g.id, class: 'client-person' }, h('h3', {}, g.display_name), h('p', {}, g.email), g.revoked_at ? h('p', {}, 'Access revoked') : [
      h('form', { class: 'client-form', 'data-form': 'grants', 'data-guest': g.id }, m.projects.map((p) => h('fieldset', {}, h('legend', {}, p.name), h('label', { class: 'client-check' }, h('input', { type: 'checkbox', name: 'project_id', value: p.id, checked: g.grants.some((x) => x.project_id === p.id) }), 'Permit this project'), Object.entries(scopes).filter(([s]) => s !== 'status.read').map(([s, label]) => h('label', { class: 'client-check' }, h('input', { type: 'checkbox', name: `scope:${p.id}`, value: s, checked: g.grants.some((x) => x.project_id === p.id && x.scopes.includes(s)) }), label)))), submit('Save permitted projects')),
      btn('Revoke client access', 'revoke', { 'data-guest': g.id })]))),
    state.boards.some((b) => !m.projects.some((p) => p.board_id === b.id)) ? section('Add an existing board as a client project', form('project', select('Team board', 'board_id', state.boards.filter((b) => !m.projects.some((p) => p.board_id === b.id))), submit('Add client project'))) : null,
  ];
}

async function load() {
  const current = ++generation;
  try {
    const account = await clientCall('GET', '/api/account');
    const workspaces = account.client_workspaces ?? [];
    const w = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0] ?? null;
    const list = w ? await clientCall('GET', `/api/client/workspaces/${eid(w.id)}/projects`) : { projects: [] };
    const p = list.projects.find((p) => p.id === projectId) ?? list.projects[0] ?? null;
    const status = p ? await clientCall('GET', `/api/client/projects/${eid(p.id)}`) : { items: [] };
    const admin = w?.mode === 'staff' && ['owner', 'admin'].includes(w.role);
    const manage = admin ? await clientCall('GET', `/api/teams/${eid(w.id)}/client-workspace`) : null;
    const board = manage?.projects.find((x) => x.id === p?.id)?.board_id;
    const boardData = board ? await clientCall('GET', `/api/boards/${eid(board)}`) : null;
    const cards = boardData?.cards ?? [];
    const projectArchived = !!boardData?.board?.archived_at;
    const boards = manage ? (await clientCall('GET', `/api/teams/${eid(w.id)}/boards`)).boards : [];
    if (current !== generation) return;
    Object.assign(state, { account, workspaces, workspace: w, projects: list.projects, project: p, items: status.items, manage, cards, boards, projectArchived });
    workspaceId = w?.id; projectId = p?.id;
    if (w) history.replaceState(null, '', `/clients?workspace=${eid(w.id)}`);
  } catch (e) {
    if (current !== generation) return;
    Object.assign(state, { workspace: null, projects: [], project: null, items: [], manage: null, cards: [], boards: [], projectArchived: false, workspaces: [] });
    if (e.status === 401) state.account = null;
    state.error = e.message;
  }
  if (current === generation) draw();
}

async function act(fn) {
  if (state.busy) return;
  state.busy = true; state.error = null; draw();
  try { await fn(); await load(); } catch (e) { state.error = e.message; }
  finally { state.busy = false; draw(); }
}
root.addEventListener('change', (e) => {
  if (e.target.name === 'workspace') { workspaceId = e.target.value; projectId = null; state.link = null; state.error = null; load(); }
  if (e.target.name === 'project') { projectId = e.target.value; state.error = null; load(); }
});
root.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]'); if (!b) return;
  const action = b.dataset.action, csrf = state.account?.csrf_token;
  const w = state.workspace?.id;
  act(async () => {
    if (action === 'refresh') return;
    if (action === 'signout') {
      await clientCall('POST', '/api/auth/signout', {}, csrf);
      // The desktop's existing 401 backstop clears its sealed credential and
      // hub partition; browser cookies were cleared by the sign-out response.
      await clientCall('GET', '/api/account').catch(() => null);
      location.replace('/signin'); return;
    }
    if (action === 'accept') { const r = await clientCall('POST', '/api/client-invites/accept', { invite_id: b.dataset.invite }, csrf); workspaceId = r.workspace.id; return; }
    if (action === 'resend') { const r = await clientCall('POST', `/api/teams/${eid(w)}/client-invites/${eid(b.dataset.invite)}/resend`, {}, csrf); state.link = r.link; return; }
    if (action === 'withdraw-approval') { await clientCall('DELETE', `/api/client-approval-requests/${eid(b.dataset.approval)}`, {}, csrf); return; }
    const path = action === 'withdraw' ? `/api/teams/${eid(w)}/client-invites/${eid(b.dataset.invite)}` : action === 'revoke' ? `/api/teams/${eid(w)}/client-guests/${eid(b.dataset.guest)}` : `/api/client-items/${eid(b.dataset.item)}`;
    await clientCall('DELETE', path, {}, csrf);
  });
});
root.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]'); if (!f) return; e.preventDefault();
  const data = new FormData(f), value = Object.fromEntries(data), kind = f.dataset.form;
  const w = state.workspace?.id, csrf = state.account?.csrf_token;
  const p = state.manage?.projects.find((p) => p.id === state.project?.id);
  const guest = state.manage?.guests.find((g) => g.id === f.dataset.guest);
  const item = state.items.find((i) => i.id === f.dataset.item);
  const approval = state.items.flatMap((i) => i.approvals ?? []).find((a) => a.id === f.dataset.approval);
  const decision = e.submitter?.value;
  act(async () => {
    const request_id = crypto.randomUUID();
    if (kind === 'workspace') { const r = await clientCall('POST', '/api/client-workspaces', { name: value.name, request_id }, csrf); workspaceId = r.workspace.id; projectId = null; return; }
    if (kind === 'invite') { const r = await clientCall('POST', `/api/teams/${eid(w)}/client-invites`, { email: value.email, grants: [{ project_id: value.project_id, scopes: ['status.read', ...data.getAll('scope').filter((s) => s !== 'status.read')] }], request_id }, csrf); state.link = r.link; return; }
    if (kind === 'publish') { await clientCall('POST', `/api/boards/${eid(p.board_id)}/client-items`, { card_id: value.card_id, title: value.title, summary: value.summary, status: value.status, request_id }, csrf); return; }
    if (kind === 'project') { await clientCall('POST', `/api/boards/${eid(value.board_id)}/client-project`, { request_id }, csrf); return; }
    if (kind === 'artifact') {
      const file = data.get('file');
      if (!file?.size || file.size > 8 * 1024 * 1024) throw new Error('Choose a file up to 8 MiB.');
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
      for (let n = 0; n < bytes.length; n += 32768) binary += String.fromCharCode(...bytes.subarray(n, n + 32768));
      const mime = file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain' })[file.name.split('.').at(-1).toLowerCase()];
      await clientCall('POST', `/api/client-items/${eid(item.id)}/artifacts`, { request_id, name: file.name, mime, data_base64: btoa(binary) }, csrf); return;
    }
    if (kind === 'approval') { await clientCall('POST', `/api/client-items/${eid(item.id)}/approvals`, { request_id, artifact_version_id: item.artifact.id, guest_ids: data.getAll('guest_id') }, csrf); return; }
    if (kind === 'decision') { await clientCall('POST', `/api/client/approvals/${eid(approval.id)}/decision`, { request_id, artifact_version_id: approval.artifact_version_id, sha256: approval.sha256, decision, comment: value.comment }, csrf); return; }
    if (kind === 'grants') await clientCall('PATCH', `/api/teams/${eid(w)}/client-guests/${eid(guest.id)}`, { grants: data.getAll('project_id').map((id) => ({ project_id: id, scopes: ['status.read', ...data.getAll(`scope:${id}`)] })), request_id }, csrf);
  });
});
load();
setInterval(() => { if (!state.busy && state.workspace?.mode === 'client' && document.visibilityState === 'visible') load(); }, 15000);
