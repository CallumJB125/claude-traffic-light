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
      h('p', { class: 'teamview-line' }, 'Live sessions in repos linked to this board. Only members who turned on sharing appear. Read-only sessions never show.'),
      h('details', { class: 'team-scope' },
        h('summary', null, 'How sessions are counted'),
        h('p', null, SCOPE_RULE))),
    invitePanel(model),
    p.loaded ? needsYou(rows, model) : null,
    h('div', { class: 'team-grid' }, rows.map((m) => memberCard(m, model, p.loaded))));
}
