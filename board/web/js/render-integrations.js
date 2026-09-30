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

function connectedCard(conn, m) {
  const connector = m.available.find((c) => c.id === conn.provider);
  const hl = health(conn, m.nowMs);
  const open = m.open === conn.id;
  const confirming = m.confirmDisconnect === conn.id;
  return h('article', { key: conn.id, class: 'integ-card', 'data-provider': conn.provider },
    h('header', { class: 'integ-card-head' },
      h('div', null,
        h('h3', { class: 'integ-name' }, connector?.name ?? conn.provider),
        conn.display_name ? h('p', { class: 'integ-account muted small' }, conn.display_name) : null),
      h('p', { class: 'integ-health', 'data-tone': hl.tone }, h('span', { class: 'integ-dot', 'aria-hidden': 'true' }), hl.text)),
    h('section', { class: 'integ-section', 'aria-label': 'What it may do on its own' },
      h('h4', null, 'On its own'),
      autonomyRows(conn, connector, m.canEdit, m.busy.has(`integ:${conn.id}`))),
    h('div', { class: 'integ-card-actions' },
      h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'integ-activity', 'data-conn': conn.id, 'aria-expanded': open ? 'true' : 'false' }, open ? 'Hide activity' : 'Activity'),
      m.canEdit ? (confirming
        ? h('span', { class: 'integ-confirm' },
          h('span', { class: 'small' }, `Disconnect ${connector?.name ?? conn.provider}? Cards stay; it stops syncing.`),
          h('button', { type: 'button', class: 'btn btn-sm btn-danger', 'data-action': 'integ-disconnect', 'data-conn': conn.id }, 'Disconnect'),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'integ-disconnect-cancel' }, 'Keep'))
        : h('button', { type: 'button', class: 'btn btn-sm btn-quiet-danger', 'data-action': 'integ-disconnect-ask', 'data-conn': conn.id }, 'Disconnect')) : null),
    open ? h('section', { class: 'integ-section', 'aria-label': 'Activity' }, h('h4', null, 'Activity'), activity(m.audit[conn.id])) : null);
}

// A provider's App-manifest flow (GitHub) takes a POSTed form, not a link:
// a real form the admin submits themselves (no auto-submit, no inline script
// under the CSP). The hub checked the action host; https is re-checked here.
function manifestForm(c, mf) {
  return h('form', { class: 'integ-manifest', method: 'post', action: mf.action, target: mf.target ?? '_blank', rel: 'noopener noreferrer' },
    Object.entries(mf.fields ?? {}).map(([name, value]) => h('input', { key: name, type: 'hidden', name, value })),
    h('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, `Create the app on ${c.name}`));
}

function availableCard(c, m) {
  const manifest = c.connect === 'app_install' && m.manifest?.provider === c.id && /^https:\/\//.test(m.manifest.action ?? '') ? m.manifest : null;
  const tokenOpen = m.tokenFor === c.id;
  const busy = m.busy.has(`integ-connect:${c.id}`);
  return h('article', { key: c.id, class: 'integ-card integ-available' },
    h('header', { class: 'integ-card-head' }, h('h3', { class: 'integ-name' }, c.name)),
    c.scopes?.length ? h('p', { class: 'muted small' }, `Asks for: ${c.scopes.join(', ')}`) : null,
    !m.canEdit ? h('p', { class: 'muted small' }, 'A team admin can connect this.')
      : !m.vault ? null
      : manifest ? manifestForm(c, manifest)
      : c.connect === 'token'
        ? (tokenOpen
          ? h('form', { class: 'integ-token', 'data-form': 'integ-token', 'data-provider': c.id },
            h('label', { class: 'field' }, h('span', null, `${c.name} token`),
              h('input', { class: 'input', name: 'token', type: 'password', autocomplete: 'off', required: true, autofocus: true, spellcheck: 'false' })),
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
    nowMs: m.nowMs ?? Date.now(), open: m.open, audit: m.audit ?? {}, tokenFor: m.tokenFor, manifest: m.manifest, confirmDisconnect: m.confirmDisconnect, busy: model.busy,
  };
  const connected = data.connections ?? [];
  const notYet = vm.available.filter((c) => !connected.some((x) => x.provider === c.id));
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
    h('section', { class: 'integ-group', 'aria-labelledby': 'integ-available' },
      h('h2', { id: 'integ-available' }, 'Add a tool'),
      notYet.length ? h('div', { class: 'integ-grid' }, notYet.map((c) => availableCard(c, vm)))
        : h('p', { class: 'muted' }, vm.available.length ? 'Everything available is connected.' : 'No tools are available on this board yet.')));
}
