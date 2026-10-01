// Integrations page (I1): what this team has connected, how much each tool
// may do on its own, what it did, and connecting more. Pure: (model) → vnode.
// Text only (D25); nothing from a provider is rendered as markup.
import { h } from './h.js';
import { icon } from './icons.js';
import { formatAge } from './view.js';

const MODE_LABEL = { auto: 'Automatic', ask: 'Ask first', off: 'Off' };
const DECISION_LABEL = { attempted: 'In progress', auto: 'Done automatically', failed: 'Failed', asked: 'Waiting for a yes', approved: 'Approved', denied: 'Denied', skipped: 'Skipped (off)' };
// Health and audit carry a short code from the hub, never provider text.
const ERROR_LABEL = {
  provider_error: 'the tool’s server is having trouble',
  provider_unreachable: 'can’t reach the tool',
  host_refused: 'it tried to reach an address it isn’t allowed to',
  handler_failed: 'an update from the tool could not be applied',
  handler_timeout: 'an update from the tool took too long',
  actor_unavailable: 'the person who connected it was removed or can’t edit; reconnect it',
  rate_limited: 'too many changes at once',
};
export const errorLabel = (code) => ERROR_LABEL[code] ?? 'something went wrong';

// Plain names for the actions connectors declare (fallback: the id itself).
const ACTION_LABEL = {
  'card.create': 'Create cards from new issues',
  'card.move': 'Move cards when things happen',
  'card.link': 'Link pull requests and issues to cards',
  'issue.close': 'Close the issue when the card is done',
  'system.pr_merged': 'Mark a card Done when its PR merges',
  'system.pr_closed': 'Send a card back when its PR is closed',
  'notify.post': 'Post updates to channels',
};
export const actionLabel = (id) => ACTION_LABEL[id] ?? id;

function health(conn, nowMs) {
  const hh = conn.health;
  if (!hh) return { tone: 'grey', text: 'No activity yet' };
  if (hh.ok) return { tone: 'ok', text: hh.last_ok_at ? `Working · last event ${formatAge(Math.max(0, nowMs - Date.parse(hh.last_ok_at)))} ago` : 'Working' };
  return { tone: 'bad', text: `Problem: ${errorLabel(hh.last_error)}` };
}

function autonomyRows(conn, connector, canEdit, busy) {
  const actions = Object.entries(connector?.actions ?? {});
  if (!actions.length) return h('p', { class: 'muted small' }, 'This tool doesn’t act on its own.');
  return h('ul', { class: 'integ-autonomy' }, actions.map(([id, a]) => {
    const mode = conn.settings?.autonomy?.[id] ?? a.default;
    const changed = mode !== a.default;
    return h('li', { key: id, class: 'integ-auto-row' },
      h('span', { class: 'integ-auto-label' }, actionLabel(id), changed ? h('span', { class: 'integ-auto-default' }, ` (default: ${MODE_LABEL[a.default]})`) : null),
      canEdit
        ? h('label', null,
          h('span', { class: 'sr-only' }, `${actionLabel(id)}: `),
          h('select', { class: 'input input-sm', 'data-change': 'integ-autonomy', 'data-conn': conn.id, 'data-action-id': id, disabled: busy || null },
            ['auto', 'ask', 'off'].map((m) => h('option', { value: m, selected: m === mode }, MODE_LABEL[m]))))
        : h('span', { class: 'integ-mode', 'data-mode': mode }, MODE_LABEL[mode]));
  }));
}

function activity(entries) {
  if (!entries) return h('p', { class: 'muted small', role: 'status' }, 'Loading…');
  if (!entries.length) return h('p', { class: 'muted small' }, 'Nothing yet. Every automatic action shows up here.');
  return h('ol', { class: 'integ-activity' }, entries.map((e) => h('li', { key: e.id },
    h('span', { class: 'integ-act-what' }, actionLabel(e.action)),
    e.external_ref ? h('span', { class: 'integ-act-ref num' }, e.external_ref) : null,
    h('span', { class: 'integ-act-decision', 'data-decision': e.decision }, DECISION_LABEL[e.decision] ?? e.decision, e.decision === 'failed' && e.error ? `: ${errorLabel(e.error)}` : null),
    e.card_id ? h('button', { type: 'button', class: 'link small', 'data-action': 'open', 'data-card': e.card_id }, 'Open card') : null,
    h('time', { class: 'integ-act-at muted', datetime: e.at }, new Date(e.at).toLocaleString()))));
}

// D98: a member's own link to their account at the tool (never anyone else's),
// and for admins who is linked, with Revoke. Names only, never the provider id.
function identitySection(conn, name, m) {
  const busy = m.busy.has(`integ-link:${conn.id}`);
  const list = m.linked?.[conn.id];
  return h('section', { class: 'integ-section', 'aria-label': `Your ${name} account` },
    h('h4', null, `Your ${name} account`),
    conn.linked
      ? h('p', { class: 'small' }, `Linked: what you do in ${name} acts as you here. `,
        h('button', { type: 'button', class: 'link small', 'data-action': 'integ-unlink', 'data-conn': conn.id, disabled: busy || null }, 'Unlink'))
      : m.canWrite
        ? h('p', { class: 'small' },
          h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'integ-link', 'data-conn': conn.id, 'data-provider': conn.provider, disabled: busy || null, 'aria-busy': busy ? 'true' : null }, `Link my ${name} account`))
        : h('p', { class: 'muted small' }, 'Viewers can’t link an account.'),
    m.canEdit ? h('button', { type: 'button', class: 'link small', 'data-action': 'integ-linked', 'data-conn': conn.id, 'aria-expanded': list ? 'true' : 'false' }, list ? 'Hide linked members' : 'Linked members') : null,
    m.canEdit && list ? (list.length
      ? h('ul', { class: 'integ-linked' }, list.map((x) => h('li', { key: x.member_id },
        h('span', null, x.display_name ?? 'A member'), ' ',
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet-danger', 'data-action': 'integ-revoke', 'data-conn': conn.id, 'data-member': x.member_id, disabled: busy || null }, 'Revoke'))))
      : h('p', { class: 'muted small' }, 'Nobody has linked an account yet.')) : null);
}

// Who the app ended up under, from the provider facts admins see (D42
// addendum C1): an account or organization login, public at the provider.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
function ownerLine(conn, name) {
  const p = conn.settings?.provider;
  const org = typeof p?.org === 'string' && LOGIN_RE.test(p.org) ? p.org : null;
  const login = typeof p?.login === 'string' && LOGIN_RE.test(p.login) ? p.login : null;
  if (org) return `Created under the ${name} organization ${org}`;
  return login ? `Created under the ${name} account ${login}` : null;
}

function connectedCard(conn, m) {
  const connector = m.available.find((c) => c.id === conn.provider);
  const hl = health(conn, m.nowMs);
  const owner = ownerLine(conn, connector?.name ?? conn.provider);
  const open = m.open === conn.id;
  const confirming = m.confirmDisconnect === conn.id;
  return h('article', { key: conn.id, class: 'integ-card', 'data-provider': conn.provider },
    h('header', { class: 'integ-card-head' },
      h('div', null,
        h('h3', { class: 'integ-name' }, connector?.name ?? conn.provider),
        conn.display_name ? h('p', { class: 'integ-account muted small' }, conn.display_name) : null,
        owner ? h('p', { class: 'integ-owner muted small' }, owner) : null),
      h('p', { class: 'integ-health', 'data-tone': hl.tone }, h('span', { class: 'integ-dot', 'aria-hidden': 'true' }), hl.text)),
    h('section', { class: 'integ-section', 'aria-label': 'What it may do on its own' },
      h('h4', null, 'On its own'),
      autonomyRows(conn, connector, m.canEdit, m.busy.has(`integ:${conn.id}`))),
    connector?.identity ? identitySection(conn, connector.name ?? conn.provider, m) : null,
    h('div', { class: 'integ-card-actions' },
      m.canEdit ? h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'integ-activity', 'data-conn': conn.id, 'aria-expanded': open ? 'true' : 'false' }, open ? 'Hide activity' : 'Activity') : null,
      m.canEdit ? (confirming
        ? h('span', { class: 'integ-confirm' },
          h('span', { class: 'small' }, `Disconnect ${connector?.name ?? conn.provider}? Cards stay; it stops syncing.`),
          h('button', { type: 'button', class: 'btn btn-sm btn-danger', 'data-action': 'integ-disconnect', 'data-conn': conn.id }, 'Disconnect'),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'integ-disconnect-cancel' }, 'Keep'))
        : h('button', { type: 'button', class: 'btn btn-sm btn-quiet-danger', 'data-action': 'integ-disconnect-ask', 'data-conn': conn.id }, 'Disconnect')) : null),
    open && m.canEdit ? h('section', { class: 'integ-section', 'aria-label': 'Activity' }, h('h4', null, 'Activity'), activity(m.audit[conn.id])) : null);
}

// A provider's App-manifest flow (GitHub) takes a POSTed form, not a link:
// a real form the admin submits themselves (no auto-submit, no inline script
// under the CSP). The hub checked the action host; https is re-checked here.
// Where the app will be made, read back from the form's own action (the
// typed org never enters the model).
function manifestOwner(c, action) {
  let path;
  try { path = new URL(action).pathname; } catch { return null; }
  const org = /^\/organizations\/([A-Za-z0-9-]{1,39})\/settings\/apps\/new$/.exec(path)?.[1];
  if (org) return `The app will be created under the ${c.name} organization ${org}.`;
  return path === '/settings/apps/new' ? `The app will be created under the ${c.name} account you're signed in as.` : null;
}

function manifestForm(c, mf) {
  const owner = manifestOwner(c, mf.action);
  return h('form', { class: 'integ-manifest', method: 'post', action: mf.action, target: mf.target ?? '_blank', rel: 'noopener noreferrer' },
    owner ? h('p', { class: 'small' }, owner) : null,
    Object.entries(mf.fields ?? {}).map(([name, value]) => h('input', { key: name, type: 'hidden', name, value })),
    h('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, `Create the app on ${c.name}`));
}

// D42 addendum "start inputs": optional plain text sent with /start only.
// Uncontrolled like inputField: takeInput reads and empties it on submit.
function startForm(c, busy) {
  const help = `integ-start-help-${c.id}`;
  return h('form', { class: 'integ-token', 'data-form': 'integ-start', 'data-provider': c.id },
    c.start.map((k) => h('label', { key: k, class: 'field' },
      h('span', null, k === 'org' ? `${c.name} organization (optional)` : `${inputLabel(k)} (optional)`),
      h('input', { class: 'input', name: k, type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...NO_MANAGER, 'aria-describedby': k === 'org' ? help : null }))),
    c.start.includes('org') ? h('p', { id: help, class: 'muted small' }, `Leave empty to create the app under the ${c.name} account you're signed in as. For a team's repositories, enter the organization name.`) : null,
    h('div', { class: 'integ-card-actions' },
      h('button', { type: 'submit', class: 'btn btn-sm btn-primary', disabled: busy || null, 'aria-busy': busy ? 'true' : null }, `Connect ${c.name}`)));
}

// ── pending connections (D97) ───────────────────────────────────────────────

const INPUT_LABEL = { config_token: 'App configuration token', app_id: 'App ID', client_id: 'Client ID', client_secret: 'Client secret', signing_secret: 'Signing secret' };
const inputLabel = (k) => INPUT_LABEL[k] ?? k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
// Ids are shown as typed; anything else (secrets, tokens) stays masked.
const inputType = (k) => (/_id$/.test(k) ? 'text' : 'password');

// Browsers ignore autocomplete=off on password fields and password managers
// offer to save (and sync) them: new-password plus the 1Password/LastPass
// opt-outs keep a one-shot token out of every vault.
const NO_MANAGER = { 'data-1p-ignore': '', 'data-lpignore': 'true' };

// Uncontrolled inputs: a value never enters the model, so it can't be
// re-rendered, stored or logged; takeInput empties them on submit.
function inputField(k, autofocus = false) {
  const type = inputType(k);
  return h('label', { key: k, class: 'field' }, h('span', null, inputLabel(k)),
    h('input', { class: 'input', name: k, type, autocomplete: type === 'password' ? 'new-password' : 'off', ...NO_MANAGER, spellcheck: 'false', required: true, autofocus: autofocus || null }));
}

/** The named inputs of a prepare form, trimmed, non-empty; every input is cleared at once. */
export function takeInput(form) {
  const out = {};
  for (const el of form.querySelectorAll('input[name]')) {
    const v = String(el.value ?? '').trim();
    if (v) out[el.name] = v;
    el.value = '';
  }
  return out;
}

function prepareForm(c, busy) {
  const token = c.prepare.includes('config_token');
  return h('div', { class: 'integ-prepare' },
    token ? h('form', { class: 'integ-token', 'data-form': 'integ-prepare', 'data-provider': c.id },
      inputField('config_token'),
      h('div', { class: 'integ-card-actions' },
        h('button', { type: 'submit', class: 'btn btn-sm btn-primary', disabled: busy || null, 'aria-busy': busy ? 'true' : null }, `Create the ${c.name} app`))) : null,
    h('button', { type: 'button', class: token ? 'link small' : 'btn btn-sm btn-primary', 'data-action': 'integ-paste', 'data-provider': c.id, disabled: busy || null },
      token ? 'Paste app credentials instead' : `Connect ${c.name}`));
}

function pendingCard(p, m) {
  const connector = m.available.find((c) => c.id === p.provider);
  const name = connector?.name ?? p.provider;
  const mins = Math.max(0, Math.ceil((Date.parse(p.expires_at) - m.nowMs) / 60_000));
  const mine = p.created_by === m.meId;
  const busy = m.busy.has(`integ-pending:${p.id}`);
  const needs = m.needs?.[p.id];
  const fields = needs?.fields ?? (connector?.prepare ?? []).filter((k) => k !== 'config_token');
  const createUrl = typeof needs?.create_url === 'string' && /^https:\/\//.test(needs.create_url) ? needs.create_url : null;
  const confirming = m.confirmCancel === p.id;
  return h('article', { key: p.id, class: 'integ-card integ-pending', 'data-pending': p.id },
    h('header', { class: 'integ-card-head' },
      h('h3', { class: 'integ-name' }, name),
      h('p', { class: 'integ-health', 'data-tone': 'grey' }, h('span', { class: 'integ-dot', 'aria-hidden': 'true' }),
        `${p.ready ? 'Waiting for approval' : 'Waiting for the app’s credentials'} · expires in ${mins} min`)),
    mine && !p.ready ? h('form', { class: 'integ-token', 'data-form': 'integ-prepare', 'data-pending': p.id },
      createUrl ? h('p', { class: 'small' }, h('a', { href: createUrl, target: '_blank', rel: 'noopener noreferrer' }, `Create the app on ${name}`), ', then paste its credentials here.') : null,
      fields.map((k, i) => inputField(k, i === 0)),
      h('div', { class: 'integ-card-actions' }, h('button', { type: 'submit', class: 'btn btn-sm btn-primary', disabled: busy || null, 'aria-busy': busy ? 'true' : null }, 'Continue'))) : null,
    h('div', { class: 'integ-card-actions' },
      mine && p.ready ? h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-action': 'integ-authorize', 'data-pending': p.id, 'data-provider': p.provider, disabled: busy || null }, 'Continue') : null,
      confirming
        ? h('span', { class: 'integ-confirm' },
          h('span', { class: 'small' }, `Cancel this setup? Also delete the app this setup created on ${name}: the hub can’t do that for you.`),
          h('button', { type: 'button', class: 'btn btn-sm btn-danger', 'data-action': 'integ-pending-cancel', 'data-pending': p.id }, 'Cancel setup'),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'integ-pending-cancel-keep' }, 'Keep'))
        : h('button', { type: 'button', class: 'btn btn-sm btn-quiet-danger', 'data-action': 'integ-pending-cancel-ask', 'data-pending': p.id }, 'Cancel')));
}

function availableCard(c, m) {
  const manifest = c.connect === 'app_install' && m.manifest?.provider === c.id && /^https:\/\//.test(m.manifest.action ?? '') ? m.manifest : null;
  const tokenOpen = m.tokenFor === c.id;
  const busy = m.busy.has(`integ-connect:${c.id}`);
  return h('article', { key: c.id, class: 'integ-card integ-available' },
    h('header', { class: 'integ-card-head' }, h('h3', { class: 'integ-name' }, c.name)),
    c.scopes?.length ? h('p', { class: 'muted small' }, `Asks for: ${c.scopes.join(', ')}`) : null,
    // The local hub has no accounts, so a provider has no one to call back: integrationsScreen says where to go instead.
    m.local ? null
      : !m.canEdit ? h('p', { class: 'muted small' }, 'A team admin can connect this.')
      : !m.vault ? null
      : manifest ? manifestForm(c, manifest)
      : Array.isArray(c.start) && c.start.length && c.connect !== 'token' ? startForm(c, busy)
      : Array.isArray(c.prepare) && c.connect !== 'token' ? prepareForm(c, busy)
      : c.connect === 'token'
        ? (tokenOpen
          ? h('form', { class: 'integ-token', 'data-form': 'integ-token', 'data-provider': c.id },
            h('label', { class: 'field' }, h('span', null, `${c.name} token`),
              h('input', { class: 'input', name: 'token', type: 'password', autocomplete: 'new-password', ...NO_MANAGER, required: true, autofocus: true, spellcheck: 'false' })),
            h('div', { class: 'integ-card-actions' },
              h('button', { type: 'submit', class: 'btn btn-sm btn-primary', disabled: busy || null, 'aria-busy': busy ? 'true' : null }, 'Connect'),
              h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'integ-token-cancel' }, 'Cancel')))
          : h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-action': 'integ-connect', 'data-provider': c.id, 'data-kind': c.connect }, 'Connect'))
        : h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-action': 'integ-connect', 'data-provider': c.id, 'data-kind': c.connect, disabled: busy || null, 'aria-busy': busy ? 'true' : null }, `Connect ${c.name}`));
}

/**
 * The name the OAuth window is opened with in the desktop shell (D42). The
 * app's connect window is its own session and never saw the hub's bind
 * cookie: the app reads this name at window.open, renames the window at once
 * (so the provider's page never sees it) and sets the bind cookie there.
 */
export function connectWindowName(provider, bind) {
  if (!/^[a-z0-9-]{2,32}$/.test(provider) || !/^[A-Za-z0-9_-]{1,64}$/.test(bind)) throw new Error('bad connect window name');
  return `plexiform-connect|${provider}|${bind}`;
}

/**
 * window.open target: the bind travels in the name only inside the desktop
 * shell (its user agent carries `Plexiform/`). A plain browser tab already has
 * the cookie from /start, and a name there would be readable by the provider's page.
 */
export function connectWindowTarget(provider, bind, userAgent) {
  return String(userAgent ?? '').includes('Plexiform/') ? connectWindowName(provider, bind) : '_blank';
}

export function integrationsScreen(model) {
  const m = model.integrations;
  const main = (...kids) => h('main', { class: 'integview', id: 'board', 'aria-label': 'Integrations' }, ...kids);
  if (!m || m.status === 'loading' && !m.data) return main(h('p', { class: 'muted', role: 'status' }, 'Loading integrations…'));
  if (m.status === 'error' && !m.data) {
    return main(h('div', { class: 'callout callout-warn', role: 'alert' }, h('p', null, m.error ?? 'Couldn’t load integrations.'),
      h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'integ-reload' }, 'Try again')));
  }
  const data = m.data;
  const vm = {
    available: data.available ?? [], vault: !!data.vault, canEdit: ['owner', 'admin'].includes(model.me?.member?.role),
    canWrite: ['owner', 'admin', 'member'].includes(model.me?.member?.role), linked: m.linked ?? {},
    local: !!m.local, nowMs: m.nowMs ?? Date.now(), open: m.open, audit: m.audit ?? {}, tokenFor: m.tokenFor, manifest: m.manifest, confirmDisconnect: m.confirmDisconnect, busy: model.busy,
    meId: model.me?.member?.id, needs: m.needs ?? {}, confirmCancel: m.confirmCancel,
  };
  const connected = data.connections ?? [];
  const pending = vm.canEdit ? data.pending ?? [] : [];
  const notYet = vm.available.filter((c) => !connected.some((x) => x.provider === c.id) && !pending.some((p) => p.provider === c.id));
  return main(
    h('header', { class: 'integview-head' },
      h('h1', null, 'Integrations'),
      h('p', { class: 'muted' }, 'Connect your team’s tools once. Facts (a PR merged, a new error) update cards on their own; anything that speaks for someone asks first.')),
    !vm.vault ? h('div', { class: 'callout callout-warn', role: 'status' }, icon('warn', 'icon-xs'), 'This board needs its encryption key before any tool can be connected.') : null,
    m.error ? h('div', { class: 'callout callout-warn', role: 'alert' }, m.error) : null,
    h('section', { class: 'integ-group', 'aria-labelledby': 'integ-connected' },
      h('h2', { id: 'integ-connected' }, 'Connected'),
      connected.length ? h('div', { class: 'integ-grid' }, connected.map((c) => connectedCard(c, vm)))
        : h('p', { class: 'muted' }, 'Nothing connected yet.')),
    pending.length ? h('section', { class: 'integ-group', 'aria-labelledby': 'integ-pending' },
      h('h2', { id: 'integ-pending' }, 'Being set up'),
      h('div', { class: 'integ-grid' }, pending.map((p) => pendingCard(p, vm)))) : null,
    h('section', { class: 'integ-group', 'aria-labelledby': 'integ-available' },
      h('h2', { id: 'integ-available' }, 'Add a tool'),
      vm.local ? h('p', { class: 'integ-local muted' }, 'Connect tools on a team hub: sign in and open your team’s board.') : null,
      notYet.length ? h('div', { class: 'integ-grid' }, notYet.map((c) => availableCard(c, vm)))
        : h('p', { class: 'muted' }, vm.available.length ? 'Everything available is connected.' : 'No tools are available on this board yet.')));
}
