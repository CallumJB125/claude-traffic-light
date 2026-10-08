// "API and webhooks" panel on the Integrations page (docs/PUBLIC-API.md):
// a team admin's API tokens and outbound webhook endpoints. Pure: (model) →
// vnode. A token or signing secret is in the model only between its creation
// and the admin dismissing it, and is shown once.
import { h } from './h.js';

const SCOPE_LABEL = { 'read:boards': 'Read boards', 'read:cards': 'Read cards and their history', 'write:cards-comment': 'Comment on cards' };
const EVENT_LABEL = { 'card.created': 'Card created', 'card.moved': 'Card moved', 'card.commented': 'Card commented on', 'run.finished': 'Run finished', 'review.requested': 'Review requested' };
const ERROR_LABEL = {
  timeout: 'no answer within 5 seconds', connect_failed: 'could not connect', address_refused: 'the address is private or did not resolve',
  redirect_refused: 'it answered with a redirect (not followed)', bad_status: 'it answered with an error', no_key: 'the hub has no encryption key',
  endpoint_disabled: 'the endpoint was turned off', interrupted: 'the hub restarted during the send',
};
export const EXPIRY_CHOICES = Object.freeze([30, 90, 365]);
const NO_MANAGER = { 'data-1p-ignore': '', 'data-lpignore': 'true' };

export const scopeLabel = (s) => SCOPE_LABEL[s] ?? s;
export const eventLabel = (e) => EVENT_LABEL[e] ?? e;
export const deliveryError = (code) => ERROR_LABEL[code] ?? 'it failed';

const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');

function secretBox(secret) {
  const what = secret.kind === 'token' ? 'API token' : 'signing secret';
  return h('div', { class: 'callout', role: 'status', 'data-secret': secret.kind },
    h('p', { class: 'small' }, `Copy this ${what} now. It is not shown again.`),
    h('p', { class: 'integ-webhook-url' }, h('code', { class: 'num' }, secret.value), ' ',
      h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'api-copy-secret' }, 'Copy')),
    h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'api-secret-done' }, 'Done'));
}

function tokenRow(t, p, nowMs, busy) {
  const expired = Date.parse(t.expires_at) <= nowMs;
  const status = t.revoked_at ? 'Revoked' : expired ? 'Expired' : `Expires ${when(t.expires_at)}`;
  const confirming = p.confirmRevoke === t.id;
  return h('li', { key: t.id, class: 'integ-auto-row', 'data-token': t.id },
    h('span', { class: 'integ-auto-label' }, h('strong', null, t.name), ` · …${t.hint} · ${t.scopes.map(scopeLabel).join(', ')}`,
      h('span', { class: 'muted small' }, ` · ${status} · last used ${when(t.last_used_at)}`)),
    t.revoked_at ? null : confirming
      ? h('span', { class: 'integ-confirm' },
        h('span', { class: 'small' }, `Revoke ${t.name}? Tools using it stop working at once.`),
        h('button', { type: 'button', class: 'btn btn-sm btn-danger', 'data-action': 'api-revoke', 'data-token': t.id, disabled: busy || null }, 'Revoke'),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'api-cancel' }, 'Keep'))
      : h('button', { type: 'button', class: 'btn btn-sm btn-quiet-danger', 'data-action': 'api-revoke-ask', 'data-token': t.id }, 'Revoke'));
}

function tokenForm(scopes, busy) {
  return h('form', { class: 'integ-token', 'data-form': 'api-token' },
    h('label', { class: 'field' }, h('span', null, 'Name'), h('input', { class: 'input', name: 'name', type: 'text', maxlength: 80, required: true, autocomplete: 'off' })),
    h('fieldset', { class: 'field' }, h('legend', null, 'Allowed to'),
      scopes.map((s) => h('label', { key: s, class: 'small' }, h('input', { type: 'checkbox', name: 'scope', value: s, checked: s.startsWith('read:') || null }), ` ${scopeLabel(s)}`))),
    h('label', { class: 'field' }, h('span', null, 'Expires after'),
      h('select', { class: 'input input-sm', name: 'expires_days' }, EXPIRY_CHOICES.map((d) => h('option', { key: d, value: String(d), selected: d === 90 }, `${d} days`)))),
    h('div', { class: 'integ-card-actions' }, h('button', { type: 'submit', class: 'btn btn-sm btn-primary', disabled: busy || null, 'aria-busy': busy ? 'true' : null }, 'Create token')));
}

function deliveryList(list) {
  if (!list) return h('p', { class: 'muted small', role: 'status' }, 'Loading…');
  if (!list.length) return h('p', { class: 'muted small' }, 'Nothing sent yet.');
  return h('ol', { class: 'integ-activity' }, list.map((d) => h('li', { key: d.id, 'data-delivery': d.state },
    h('span', { class: 'integ-act-what' }, d.event_type === 'webhook.test' ? 'Test event' : eventLabel(d.event_type)),
    h('span', { class: 'integ-act-decision', 'data-decision': d.state === 'delivered' ? 'auto' : d.state === 'failed' ? 'failed' : 'attempted' },
      d.state === 'delivered' ? `Delivered (${d.status})` : d.state === 'failed' ? `Failed: ${deliveryError(d.error)}${d.status ? ` (${d.status})` : ''}` : `Retrying (attempt ${d.attempts} of 6)`),
    d.latency_ms != null ? h('span', { class: 'muted small num' }, ` ${d.latency_ms} ms`) : null,
    h('time', { class: 'integ-act-at muted', datetime: d.updated_at }, when(d.updated_at)))));
}

function endpointCard(e, p, busy) {
  const open = p.openLog === e.id;
  const confirming = p.confirmDelete === e.id;
  return h('article', { key: e.id, class: 'integ-card', 'data-endpoint': e.id },
    h('header', { class: 'integ-card-head' },
      h('div', null, h('h3', { class: 'integ-name num' }, e.url),
        h('p', { class: 'muted small' }, e.events.map(eventLabel).join(', '), e.include_text ? ' · includes card text' : ' · ids and titles only')),
      h('p', { class: 'integ-health', 'data-tone': e.enabled ? 'ok' : 'bad' }, h('span', { class: 'integ-dot', 'aria-hidden': 'true' }),
        e.enabled ? 'On' : e.disabled_reason === 'failing' ? 'Off: deliveries kept failing' : 'Off')),
    h('div', { class: 'integ-card-actions' },
      h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'api-hook-test', 'data-endpoint': e.id, disabled: busy || null, 'aria-busy': busy ? 'true' : null }, 'Send test event'),
      h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'api-hook-log', 'data-endpoint': e.id, 'aria-expanded': open ? 'true' : 'false' }, open ? 'Hide deliveries' : 'Deliveries'),
      h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'api-hook-toggle', 'data-endpoint': e.id, 'data-enable': e.enabled ? '0' : '1', disabled: busy || null }, e.enabled ? 'Turn off' : 'Turn on'),
      confirming
        ? h('span', { class: 'integ-confirm' },
          h('span', { class: 'small' }, 'Delete this endpoint and its delivery log?'),
          h('button', { type: 'button', class: 'btn btn-sm btn-danger', 'data-action': 'api-hook-delete', 'data-endpoint': e.id, disabled: busy || null }, 'Delete'),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'api-cancel' }, 'Keep'))
        : h('button', { type: 'button', class: 'btn btn-sm btn-quiet-danger', 'data-action': 'api-hook-delete-ask', 'data-endpoint': e.id }, 'Delete')),
    open ? h('section', { class: 'integ-section', 'aria-label': 'Deliveries' }, h('h4', null, 'Last 50 deliveries'), deliveryList(p.deliveries?.[e.id])) : null);
}

function webhookForm(events, busy) {
  return h('form', { class: 'integ-token', 'data-form': 'api-webhook' },
    h('label', { class: 'field' }, h('span', null, 'Endpoint URL (https)'),
      h('input', { class: 'input', name: 'url', type: 'url', required: true, placeholder: 'https://example.com/plexiform', autocomplete: 'off', spellcheck: 'false', ...NO_MANAGER })),
    h('fieldset', { class: 'field' }, h('legend', null, 'Send these events'),
      events.map((ev) => h('label', { key: ev, class: 'small' }, h('input', { type: 'checkbox', name: 'event', value: ev, checked: true }), ` ${eventLabel(ev)}`))),
    h('label', { class: 'small' }, h('input', { type: 'checkbox', name: 'include_text' }), ' Include card text (descriptions and comments). Off: ids and titles only.'),
    h('div', { class: 'integ-card-actions' }, h('button', { type: 'submit', class: 'btn btn-sm btn-primary', disabled: busy || null, 'aria-busy': busy ? 'true' : null }, 'Add endpoint')));
}

/** p: the panel state ({status, tokens, scopes, endpoints, event_types, secret, …}); busy: the page's busy Set. */
export function apiPanel(p, { nowMs = Date.now(), busy = new Set() } = {}) {
  const head = h('h2', { id: 'integ-api' }, 'API and webhooks');
  const section = (...kids) => h('section', { class: 'integ-group', 'aria-labelledby': 'integ-api', 'data-panel': 'api' }, head, ...kids);
  if (!p || p.status === 'loading' && !p.tokens) return section(h('p', { class: 'muted', role: 'status' }, 'Loading…'));
  if (p.status === 'error' && !p.tokens) return section(h('div', { class: 'callout callout-warn', role: 'alert' }, p.error ?? 'Couldn’t load API settings.'));
  const tokens = p.tokens ?? [];
  const endpoints = p.endpoints ?? [];
  return section(
    h('p', { class: 'muted' }, 'Let other tools read this team’s boards with an API token, and tell them when things change with webhooks. See PUBLIC-API.md for the contract.'),
    p.error ? h('div', { class: 'callout callout-warn', role: 'alert' }, p.error) : null,
    p.secret ? secretBox(p.secret) : null,
    h('section', { class: 'integ-section', 'aria-label': 'API tokens' },
      h('h3', null, 'API tokens'),
      tokens.length ? h('ul', { class: 'integ-autonomy' }, tokens.map((t) => tokenRow(t, p, nowMs, busy.has(`api-token:${t.id}`)))) : h('p', { class: 'muted small' }, 'No tokens yet.'),
      tokenForm(p.scopes ?? Object.keys(SCOPE_LABEL), busy.has('api-token-new'))),
    h('section', { class: 'integ-section', 'aria-label': 'Webhooks' },
      h('h3', null, 'Webhooks'),
      endpoints.length ? h('div', { class: 'integ-grid' }, endpoints.map((e) => endpointCard(e, p, busy.has(`api-hook:${e.id}`)))) : h('p', { class: 'muted small' }, 'No endpoints yet.'),
      webhookForm(p.event_types ?? Object.keys(EVENT_LABEL), busy.has('api-hook-new'))));
}

/** The token form's fields → the POST body. */
export function readTokenForm(form) {
  const fd = new FormData(form);
  return { name: String(fd.get('name') ?? '').trim(), scopes: fd.getAll('scope').map(String), expires_days: Number(fd.get('expires_days') ?? 90) };
}

/** The webhook form's fields → the POST body. */
export function readWebhookForm(form) {
  const fd = new FormData(form);
  return { url: String(fd.get('url') ?? '').trim(), events: fd.getAll('event').map(String), include_text: fd.get('include_text') != null };
}
