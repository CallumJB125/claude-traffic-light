// Team view: who is live in repos linked to this board, from the hub's
// team.presence (CONTRACT D37b), plus what each person is running or assigned
// on the board. Pure: (model) → vnode. Every string from a session (summary,
// branch, repo) is untrusted and only ever a text child.
import { h } from './h.js';
import { icon } from './icons.js';
import { avatar, pill } from './render-board.js';
import { columnFor, formatAge, isActive } from './view.js';

export const AGENT_LABEL = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', hermes: 'Hermes' };
const STATE = {
  working: { label: 'Working', icon: 'lamp', tone: 'green', rank: 0 },
  waiting: { label: 'Waiting', icon: 'hand', tone: 'amber', rank: 1 },
  idle: { label: 'Idle', icon: 'moon', tone: 'grey', rank: 2 },
};
const stateOf = (s) => STATE[s] ?? STATE.idle;
const MAX_JOBS = 5;

const ageMs = (since, nowMs) => {
  const t = Date.parse(since);
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
};

function sessionsOf(pm, nowMs) {
  return (pm?.sessions ?? [])
    .map((s) => ({ ...s, age_ms: ageMs(s.since, nowMs) }))
    .sort((a, b) => stateOf(a.state).rank - stateOf(b.state).rank || (a.age_ms ?? Infinity) - (b.age_ms ?? Infinity));
}

function jobsOf(memberId, entries) {
  const jobs = [];
  for (const e of entries) {
    const v = e.view;
    if (columnFor(v, e.face) === 'done') continue;
    const running = v.run?.owner?.member_id === memberId && isActive(v.run_state);
    if (running || (v.assignee_ids ?? []).includes(memberId)) jobs.push({ entry: e, running });
  }
  return jobs.sort((a, b) => Number(b.running) - Number(a.running)
    || String(a.entry.view.key).localeCompare(String(b.entry.view.key), undefined, { numeric: true }));
}

/** People in page order: you, then live ones (working → waiting → idle), then the rest A–Z. */
export function teamRows(model) {
  const nowMs = model.nowMs ?? Date.now();
  const byId = new Map();
  for (const m of model.members.values()) byId.set(m.member_id, { member_id: m.member_id, name: m.name ?? m.login ?? '?', login: m.login, avatar_url: m.avatar_url, role: m.role ?? null });
  const presence = new Map((model.presence?.members ?? []).map((p) => [p.member_id, p]));
  for (const p of presence.values()) if (!byId.has(p.member_id)) byId.set(p.member_id, { member_id: p.member_id, name: p.name ?? '?' });
  const meId = model.me?.member?.id;
  const rows = [...byId.values()].map((m) => {
    const sessions = sessionsOf(presence.get(m.member_id), nowMs);
    return { ...m, role: m.role ?? (m.member_id === meId ? model.me.member.role ?? null : null), is_me: m.member_id === meId, sessions, best: sessions.length ? Math.min(...sessions.map((s) => stateOf(s.state).rank)) : 9, jobs: jobsOf(m.member_id, model.entries) };
  });
  return rows.sort((a, b) => Number(b.is_me) - Number(a.is_me) || a.best - b.best || a.name.localeCompare(b.name));
}

function statePill(state) {
  const s = stateOf(state);
  return h('span', { class: 'pill pill-sm', 'data-tone': s.tone },
    h('span', { class: 'pill-lamp' }, icon(s.icon)),
    h('span', { class: 'pill-text' }, h('span', { class: 'pill-label' }, s.label)));
}

const agentName = (a) => AGENT_LABEL[a] ?? String(a).slice(0, 20);
const where = (s) => h('span', { class: 'team-where num' }, icon('branch', 'icon-xs'), `${s.repo_short}${s.branch ? `@${s.branch}` : ''}`);
const since = (s) => (s.age_ms == null ? null : h('span', { class: 'team-since num' }, `since ${formatAge(s.age_ms)} ago`));

function sessionRow(s, i, boardName) {
  return h('li', { key: `${s.agent}:${s.repo_short}:${s.branch ?? ''}:${i}`, class: 'team-session', 'data-state': s.state },
    h('div', { class: 'team-session-top' },
      h('span', { class: 'team-agent' }, icon('terminal', 'icon-xs'), agentName(s.agent)),
      where(s),
      statePill(s.state),
      since(s),
      h('span', { class: 'team-scope-badge', title: SCOPE_RULE }, icon('check', 'icon-xs'), `counting for ${boardName}`)),
    s.summary ? h('p', { class: 'team-summary' }, String(s.summary).slice(0, 120)) : null);
}

function jobButton(j) {
  const { view, face } = j.entry;
  return h('li', { key: view.id },
    h('button', { type: 'button', class: 'team-job', 'data-action': 'open', 'data-card': view.id },
      h('span', { class: 'card-key num' }, view.key),
      h('span', { class: 'team-job-title' }, view.title),
      h('span', { class: 'team-job-rel' }, j.running ? 'running' : 'assigned'),
      pill(face)));
}

function memberCard(m, model, loaded) {
  const online = m.sessions.length > 0;
  const shown = m.jobs.slice(0, MAX_JOBS);
  return h('article', { key: m.member_id, class: 'team-member', 'data-online': online ? 'true' : 'false', 'aria-labelledby': `tm-${m.member_id}` },
    h('header', { class: 'team-member-head' },
      avatar(m, { size: 'md' }),
      h('div', { class: 'team-member-id' },
        h('h3', { class: 'team-name', id: `tm-${m.member_id}` }, m.name, m.is_me ? h('span', { class: 'team-you' }, 'you') : null),
        m.role ? h('span', { class: 'team-role' }, m.role) : null),
      h('span', { class: `team-online${online ? ' is-on' : ''}` }, icon(online ? 'lamp' : 'ring', 'icon-xs'), online ? 'Online' : 'Not sharing')),
    online
      ? h('ul', { class: 'team-sessions', 'aria-label': `${m.name}'s live sessions` }, m.sessions.map((s, i) => sessionRow(s, i, model.board?.name ?? 'this board')))
      : h('p', { class: 'team-empty' }, loaded ? 'Not sharing live sessions right now' : 'Checking for live sessions…'),
    shown.length ? h('div', { class: 'team-jobs' },
      h('h4', { class: 'team-jobs-h' }, 'On the board'),
      h('ul', { class: 'team-joblist' }, shown.map(jobButton),
        m.jobs.length > shown.length ? h('li', { key: 'more', class: 'team-more' }, `+${m.jobs.length - shown.length} more`) : null)) : null);
}

export const SCOPE_RULE = 'A session only shows once it writes into a repo linked to this board. Personal repos and sessions marked “Personal — don’t track” never show.';

function needsYou(rows, model) {
  const waiting = rows.flatMap((m) => m.sessions.filter((s) => s.state === 'waiting').map((s) => ({ m, s })))
    .sort((a, b) => (b.s.age_ms ?? 0) - (a.s.age_ms ?? 0));
  if (!waiting.length) return null;
  return h('section', { class: 'team-needs', 'aria-labelledby': 'team-needs-h' },
    h('h2', { class: 'team-needs-h', id: 'team-needs-h' }, icon('hand', 'icon-xs'), 'Needs you', h('span', { class: 'team-needs-count num' }, String(waiting.length))),
    h('ul', { class: 'team-needs-list' }, waiting.map(({ m, s }, i) => h('li', { key: `${m.member_id}:${i}`, class: 'team-needs-item' },
      h('strong', null, m.name), ` is waiting in ${agentName(s.agent)} `, where(s), s.age_ms == null ? null : h('span', { class: 'team-since num' }, ` · ${formatAge(s.age_ms)}`),
      s.summary ? h('span', { class: 'team-needs-summary' }, String(s.summary).slice(0, 120)) : null))));
}

// Accounts mode: owners and admins invite from here (POST /api/teams/:id/invites).
// The link and code are shown once, from memory: the hub keeps only their hashes.
export const CAN_INVITE = new Set(['owner', 'admin']);
const INVITE_ROLES = [['member', 'Member'], ['admin', 'Admin'], ['viewer', 'Viewer']];

export function invitePanel(model) {
  if (!model.accounts || !CAN_INVITE.has(model.me?.member?.role)) return null;
  const inv = model.invite ?? {};
  const made = inv.made;
  return h('section', { class: 'team-invite', 'aria-labelledby': 'team-invite-h' },
    h('h2', { class: 'team-needs-h', id: 'team-invite-h' }, icon('person', 'icon-xs'), 'Invite people'),
    h('p', { class: 'hint' }, 'Only the address you invite can join with the link or the code.'),
    h('form', { class: 'signin-row', 'data-form': 'team-invite' },
      h('label', { class: 'sr-only', for: 'invite-email' }, 'Email to invite'),
      h('input', { id: 'invite-email', name: 'email', type: 'email', class: 'input', placeholder: 'name@example.com', autocomplete: 'off', required: true }),
      h('label', { class: 'sr-only', for: 'invite-role' }, 'Role'),
      h('select', { id: 'invite-role', name: 'role', class: 'input' }, INVITE_ROLES.map(([v, label]) => h('option', { key: v, value: v }, label))),
      h('button', { type: 'submit', class: 'btn btn-primary', disabled: inv.busy || null }, 'Create invite')),
    inv.error ? h('p', { class: 'form-error', role: 'alert' }, inv.error) : null,
    inv.resend ? h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'resend-invite', disabled: inv.busy || null }, 'Resend') : null,
    made ? h('div', { class: 'team-invite-made', role: 'status' },
      h('p', null, made.mailed ? `We emailed ${made.email} the link and the code.` : `Nothing was emailed: send ${made.email} the link or the code yourself.`, ' They show only this once.'),
      h('div', { class: 'signin-row' },
        h('input', { class: 'input num', readonly: true, value: made.link, 'aria-label': 'Invite link' }),
        h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'copy-invite', 'data-what': 'link' }, 'Copy link')),
      h('div', { class: 'signin-row' },
        h('code', { class: 'team-invite-code num', 'aria-label': 'Invite code' }, made.code),
        h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'copy-invite', 'data-what': 'code' }, 'Copy code'))) : null);
}

// " · $1.20 today of $3.00 cap · over cap" (Team plan roll-up); nothing without the field.
export function boardSpendText(spend) {
  if (!spend) return '';
  const cap = spend.cap_usd != null ? ` of $${spend.cap_usd.toFixed(2)} cap` : '';
  return ` · $${(spend.today_usd ?? 0).toFixed(2)} today${cap}${spend.over ? ' · over cap' : ''}`;
}

const ACTIVITY = { working: 'Working', waiting: 'Waiting for a person', quiet: 'Quiet', idle: 'Idle · task still open', disconnected: 'Runner disconnected', no_live_run: 'No active AI run' };
const TASK_STATE = { todo: 'To do', queued: 'Queued', claimed: 'Starting', running: 'In progress', quiet: 'In progress', blocked: 'Blocked', parked: 'Waiting', suspended: 'Paused', reconnecting: 'Reconnecting', unresponsive: 'Not responding', orphaned: 'Run lost', handing_over: 'Moving to another AI', handed_over: 'Moved to another AI', in_review: 'In review', done: 'Done', failed: 'Failed' };
// The team's cloud runner (docs/CLOUD-RUNNER-RUNBOOK.md): admins add one (its
// token is shown once, for the server) and store the provider keys hosted runs
// use. Keys go in and never come back: the hub answers only "has a key".
const HOSTED_PROVIDERS = [['claude', 'Claude Code'], ['codex', 'Codex'], ['hermes-dgx', 'Hermes · DGX (tailnet model)']];

export function cloudPanel(model) {
  if (!model.accounts || !CAN_INVITE.has(model.me?.member?.role)) return null;
  const c = model.cloud ?? {};
  const data = c.data;
  const runners = data?.runners ?? [];
  return h('section', { class: 'team-cloud', 'aria-labelledby': 'team-cloud-h' },
    h('h2', { class: 'team-needs-h', id: 'team-cloud-h' }, icon('sync', 'icon-xs'), 'Cloud runner'),
    h('p', { class: 'hint' }, 'An always-on runner on your own server keeps cards working while laptops are closed. Choose "Run in the cloud" when you send a card to an AI.'),
    c.status === 'loading' && !data ? h('p', { class: 'hint', role: 'status' }, 'Checking…') : null,
    c.status === 'error' ? h('p', { class: 'form-error', role: 'alert' }, c.error) : null,
    data ? (runners.length
      ? h('ul', { class: 'team-cloud-list' }, runners.map((r) => h('li', { key: r.id },
        h('strong', null, r.name), ` · ${r.owner?.name ?? ''} · `,
        r.online ? `online${r.active_runs ? `, ${r.active_runs} running` : ''}` : r.last_seen_at ? `offline, last seen ${formatAge(Date.now() - Date.parse(r.last_seen_at))} ago` : 'never connected')))
      : h('p', { class: 'hint' }, 'No cloud runner yet.')) : null,
    h('form', { class: 'signin-row', 'data-form': 'cloud-runner-add' },
      h('label', { class: 'sr-only', for: 'cloud-name' }, 'Cloud runner name'),
      h('input', { id: 'cloud-name', name: 'name', class: 'input', placeholder: 'Pi 5', maxlength: '100', autocomplete: 'off' }),
      h('button', { type: 'submit', class: 'btn btn-primary', disabled: c.busy || null }, 'Add cloud runner')),
    c.made ? h('div', { class: 'team-invite-made', role: 'status' },
      h('p', null, 'Runner token for the server. It shows only this once: put it in /etc/buddy-runner/runner.token (root, 0600) as the runbook says, then forget it here.'),
      h('div', { class: 'signin-row' },
        h('code', { class: 'team-invite-code num', 'aria-label': 'Runner token' }, c.made.runner_token),
        h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'copy-cloud-token' }, 'Copy token')),
      h('p', { class: 'hint' }, `Team id for BUDDY_RUNNER_TEAM: ${c.made.team_id}`)) : null,
    h('h3', { class: 'team-needs-h' }, 'Provider keys for cloud runs'),
    data && !data.providers?.length ? h('p', { class: 'hint' }, 'None stored: cloud runs use the server CLI\'s own sign-in.') : null,
    data?.providers?.length ? h('ul', { class: 'team-cloud-list' }, data.providers.map((p) => h('li', { key: p.provider },
      h('strong', null, p.label ?? p.provider), p.has_key ? ' · key stored' : ' · no key', p.model ? ` · ${p.model}` : '', p.base_url ? ` · ${p.base_url}` : '', ' ',
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'cloud-provider-remove', 'data-provider': p.provider, disabled: c.busy || null }, 'Remove')))) : null,
    h('form', { class: 'signin-row', 'data-form': 'cloud-provider-save' },
      h('label', { class: 'sr-only', for: 'cloud-provider' }, 'Provider'),
      h('select', { id: 'cloud-provider', name: 'provider', class: 'input' }, HOSTED_PROVIDERS.map(([v, label]) => h('option', { key: v, value: v }, label))),
      h('label', { class: 'sr-only', for: 'cloud-key' }, 'API key'),
      h('input', { id: 'cloud-key', name: 'api_key', type: 'password', class: 'input', placeholder: 'API key (kept sealed on the hub)', autocomplete: 'off' }),
      h('label', { class: 'sr-only', for: 'cloud-url' }, 'Model server URL'),
      h('input', { id: 'cloud-url', name: 'base_url', class: 'input', placeholder: 'Hermes only: model server URL (tailnet IP)', autocomplete: 'off', spellcheck: 'false' }),
      h('label', { class: 'sr-only', for: 'cloud-model' }, 'Model'),
      h('input', { id: 'cloud-model', name: 'model', class: 'input', placeholder: 'Model (optional)', autocomplete: 'off', spellcheck: 'false' }),
      h('button', { type: 'submit', class: 'btn', disabled: c.busy || null }, 'Save')),
    data && !data.encryption ? h('p', { class: 'hint' }, 'This hub has no encryption key, so it cannot store provider keys.') : null);
}

function overviewTask(item, stale) {
  const change = item.evidence?.verification === 'hub_verified' ? 'Change verified' : item.evidence ? 'Change self-reported' : 'No change evidence';
  const tests = item.evidence?.tests ? ` · Tests reported: ${item.evidence.tests}` : '';
  return h('li', { key: item.id, class: 'team-overview-task' },
    h('button', { type: 'button', class: 'team-overview-open', 'data-action': 'team-open-card', 'data-card': item.id, 'data-board': item.board.id },
      h('span', { class: 'team-overview-task-title' }, h('span', { class: 'card-key num' }, item.key), item.title),
      h('span', { class: 'team-overview-meta' }, item.board.name, ' · ', item.owner ? `${item.owner.name}’s ${item.ai_label ?? 'AI'}` : item.assignees?.length ? `Assigned to ${item.assignees.map((m) => m.name).join(', ')}` : item.ai_label ?? 'Unassigned',
        ' · ', stale ? `Last snapshot: ${ACTIVITY[item.activity] ?? item.state}` : ACTIVITY[item.activity] ?? item.state)),
    h('span', { class: 'team-overview-meta' }, TASK_STATE[item.state] ?? item.column ?? '', item.attention?.kind ? ` · ${item.attention.kind}` : '', item.attention?.can_approve ? ' · Your approval is needed' : ''),
    h('span', { class: 'team-overview-proof' }, change, tests, item.cost ? item.cost.cost_usd == null ? ' · Cost unavailable' : ` · $${item.cost.cost_usd.toFixed(2)} reported` : ''),
    item.attention?.summary ? h('p', { class: 'team-overview-meta' }, item.attention.summary) : null,
    item.overlap_count ? h('span', { class: 'team-overview-meta' }, `${item.overlap_count} overlapping path ${item.overlap_count === 1 ? 'claim' : 'claims'}`) : null);
}

function overviewList(label, data, stale, empty) {
  const items = data.items;
  return h('section', { class: 'team-overview-panel', 'aria-label': label },
    h('h3', null, label),
    items.length ? h('ul', { class: 'team-overview-list' }, items.slice(0, 6).map((item) => overviewTask(item, stale))) : h('p', { class: 'team-empty' }, empty),
    items.length > 6 ? h('details', { class: 'team-overview-more' }, h('summary', null, `Show ${items.length - 6} more`), h('ul', { class: 'team-overview-list' }, items.slice(6).map((item) => overviewTask(item, stale)))) : null,
    data.truncated ? h('p', { class: 'team-overview-meta' }, 'Showing the latest 20. Search all boards to find older tasks.') : null);
}

export function overviewPanel(model) {
  const overview = model.teamOverview;
  if (!overview) return null;
  const data = overview.data;
  return h('section', { class: 'team-overview', 'aria-labelledby': 'team-overview-h' },
    h('header', { class: 'team-overview-head' },
      h('div', null, h('h2', { id: 'team-overview-h' }, 'Across the team'), h('p', { class: 'team-overview-meta' }, data ? `${data.team.name} · ${data.board_count} active ${data.board_count === 1 ? 'board' : 'boards'}` : 'Checking work across your team’s active boards…')),
      h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'team-overview-refresh', disabled: overview.status === 'loading' || null }, overview.status === 'loading' ? 'Refreshing…' : 'Refresh')),
    overview.error ? h('p', { class: 'form-error', role: 'alert' }, overview.error) : null,
    overview.stale && data ? h('p', { class: 'teamview-stale', role: 'status' }, 'Overview may be out of date. Refresh to check current activity.') : null,
    data ? [
      h('div', { class: 'team-overview-stats' }, [['Open tasks', data.totals.open], ['Need attention', data.totals.attention], ['Ready for review', data.totals.review], ['Done', data.totals.done], ...(data.totals.spend ? [['Spent today', `$${data.totals.spend.today_usd.toFixed(2)}`]] : [])].map(([label, n]) => h('div', { key: label, class: 'team-overview-stat' }, h('strong', { class: 'num' }, String(n)), h('span', null, label)))),
      data.totals.spend?.boards_over_cap ? h('p', { class: 'team-overview-meta team-overview-over' }, `${data.totals.spend.boards_over_cap} ${data.totals.spend.boards_over_cap === 1 ? 'board is' : 'boards are'} over its daily cap: new AI starts there wait until tomorrow.`) : null,
      h('p', { class: 'team-overview-meta' }, 'Live activity comes from current connected runners. Change verification checks the attached commit or pull request; test results remain the AI’s report.'),
      h('div', { class: 'team-overview-columns' },
        overviewList('Needs attention', data.attention, overview.stale, 'No blocked or failed tasks in this snapshot.'),
        overviewList('AI tasks', data.work, overview.stale, 'No queued or active AI tasks in this snapshot.'),
        overviewList('Ready for review', data.review, overview.stale, 'Nothing waiting for review in this snapshot.')),
      h('details', { class: 'team-overview-projects' }, h('summary', null, 'Board overview'), h('ul', { class: 'team-overview-list' }, data.boards.map((board) => h('li', { key: board.id, class: 'team-overview-board' }, h('strong', null, board.name), h('span', { class: 'team-overview-meta' }, `${board.open} open · ${board.attention} need attention · ${board.review} in review · ${board.done} done${boardSpendText(board.spend)}`)))), data.boards_truncated ? h('p', { class: 'team-overview-meta' }, 'Showing the first 60 active boards; totals include all active boards.') : null),
      h('details', { class: 'team-overview-projects' }, h('summary', null, 'Recently changed tasks'), h('ul', { class: 'team-overview-list' }, data.recent.items.map((item) => overviewTask(item, overview.stale))))
    ] : null);
}

export function teamScreen(model) {
  const p = model.presence ?? { members: [], loaded: false, stale: false };
  const rows = teamRows(model);
  const online = rows.filter((m) => m.sessions.length).length;
  return h('main', { class: 'teamview', id: 'board', 'aria-label': 'Team', 'data-stale': p.stale ? 'true' : null },
    h('header', { class: 'teamview-head' },
      h('div', { class: 'teamview-title' },
        h('h1', { class: 'teamview-h' }, 'Team'),
        h('span', { class: 'teamview-count num', role: 'status' }, p.loaded ? `${online} online` : 'Checking…'),
        p.stale ? h('span', { class: 'teamview-stale' }, icon('sync', 'icon-xs'), 'Presence may be out of date') : null),
      h('p', { class: 'teamview-line' }, 'Work, blockers and reviews across your team. Shared live sessions below count for the current board.'),
      model.accounts ? h('a', { href: '/connections', target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-sm' }, 'Your connections') : null,
      h('details', { class: 'team-scope' },
        h('summary', null, 'How sessions are counted'),
        h('p', null, SCOPE_RULE))),
    overviewPanel(model),
    invitePanel(model),
    cloudPanel(model),
    h('h2', { class: 'team-needs-h' }, `On ${model.board?.name ?? 'this board'}`),
    h('p', { class: 'teamview-line' }, 'Live sessions in repos linked to this board. Only members who turned on sharing appear. Read-only sessions never show.'),
    p.loaded ? needsYou(rows, model) : null,
    h('div', { class: 'team-grid' }, rows.map((m) => memberCard(m, model, p.loaded))));
}
