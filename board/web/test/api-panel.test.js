// "API and webhooks" panel (render-api.js) on the Integrations page, and its
// actions (api-panel.js) against a stub api.
import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, findAll, byAttr } from '../js/h.js';
import { integrationsScreen } from '../js/render-integrations.js';
import { apiPanel, deliveryError } from '../js/render-api.js';
import { createApiPanel } from '../js/api-panel.js';
import { model } from './fixtures.js';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const pub = (over = {}) => ({
  status: 'ok', scopes: ['read:boards', 'read:cards', 'write:cards-comment'], event_types: ['card.created', 'card.moved', 'card.commented', 'run.finished', 'review.requested'],
  tokens: [{ id: 't1', name: 'CI', hint: 'wxyz', scopes: ['read:cards'], created_at: '2026-09-01T00:00:00Z', expires_at: '2026-12-01T00:00:00Z', last_used_at: null, revoked_at: null }],
  endpoints: [{ id: 'e1', url: 'https://hooks.example.com/p', events: ['card.created'], include_text: false, enabled: false, disabled_reason: 'failing' }],
  ...over,
});
const page = (role, p = pub()) => {
  const base = model([], { view: 'integrations' });
  return { ...base, busy: new Set(), me: { member: { ...base.me.member, role } }, integrations: { status: 'ok', data: { available: [], connections: [], vault: true }, audit: {}, nowMs: NOW }, apiPanel: p };
};

test('admins see tokens, endpoints, Send test event and the forms; members and the local hub see no panel', () => {
  const v = integrationsScreen(page('admin'));
  const t = textOf(v);
  assert.match(t, /API and webhooks/);
  assert.match(t, /CI · …wxyz · Read cards and their history/);
  assert.match(t, /last used never/);
  assert.match(t, /Off: deliveries kept failing/);
  assert.match(t, /ids and titles only/);
  assert.equal(byAttr(v, 'data-action', 'api-hook-test').length, 1);
  assert.equal(byAttr(v, 'data-form', 'api-token').length, 1);
  assert.equal(byAttr(v, 'data-form', 'api-webhook').length, 1);
  const textBox = findAll(v, (n) => n.tag === 'input' && n.props.name === 'include_text');
  assert.equal(textBox[0].props.checked, undefined, 'card text is off by default');
  assert.equal(byAttr(integrationsScreen(page('member')), 'data-panel', 'api').length, 0);
  const local = page('owner');
  local.integrations.local = true;
  assert.equal(byAttr(integrationsScreen(local), 'data-panel', 'api').length, 0);
});

test('a new secret is shown once with Copy and Done; revoked tokens show no Revoke', () => {
  const v = apiPanel(pub({ secret: { kind: 'token', value: 'plx_pat_SECRET' }, tokens: [{ ...pub().tokens[0], revoked_at: '2026-10-01T00:00:00Z' }] }), { nowMs: NOW });
  assert.match(textOf(v), /plx_pat_SECRET/);
  assert.match(textOf(v), /not shown again/);
  assert.equal(byAttr(v, 'data-action', 'api-secret-done').length, 1);
  assert.equal(byAttr(v, 'data-action', 'api-revoke-ask').length, 0);
  assert.match(textOf(v), /Revoked/);
});

test('the delivery log names statuses and errors in words', () => {
  const v = apiPanel(pub({ openLog: 'e1', deliveries: { e1: [
    { id: 'd1', event_type: 'webhook.test', state: 'failed', status: 302, error: 'redirect_refused', attempts: 1, latency_ms: 12, updated_at: '2026-10-01T11:00:00Z' },
    { id: 'd2', event_type: 'card.created', state: 'delivered', status: 204, error: null, attempts: 1, latency_ms: 40, updated_at: '2026-10-01T11:00:00Z' },
    { id: 'd3', event_type: 'card.moved', state: 'pending', status: 500, error: 'bad_status', attempts: 2, latency_ms: 40, updated_at: '2026-10-01T11:00:00Z' },
  ] } }), { nowMs: NOW });
  const t = textOf(v);
  assert.match(t, /Test event/);
  assert.match(t, /Failed: it answered with a redirect \(not followed\) \(302\)/);
  assert.match(t, /Delivered \(204\)/);
  assert.match(t, /Retrying \(attempt 2 of 6\)/);
  assert.equal(deliveryError('nope'), 'it failed');
});

test('actions: create keeps the secret until Done; revoke and test call the team routes', async () => {
  let st = { status: 'idle' };
  const calls = [];
  const toasts = [];
  const api = {
    apiTokens: async (team) => { calls.push(['tokens', team]); return { tokens: [], scopes: ['read:cards'] }; },
    webhooks: async (team) => { calls.push(['webhooks', team]); return { endpoints: [{ id: 'e1' }], event_types: ['card.created'] }; },
    revokeApiToken: async (team, id) => { calls.push(['revoke', team, id]); return { token: { id, revoked_at: 'x' } }; },
    testWebhook: async (team, id) => { calls.push(['test', team, id]); return { delivery: { state: 'delivered', status: 204, latency_ms: 9 } }; },
  };
  const p = createApiPanel({
    api, teamId: () => 'team1', get: () => st, set: (x) => { st = { ...st, ...x }; }, update: () => {},
    withBusy: (_k, fn) => fn(), toast: (t, tone) => toasts.push([t, tone]), copyText: () => {}, errorText: (e) => e.message,
  });
  await p.load();
  assert.equal(st.status, 'ok');
  assert.deepEqual(calls.slice(0, 2), [['tokens', 'team1'], ['webhooks', 'team1']]);
  st = { ...st, tokens: [{ id: 't1' }], secret: { kind: 'token', value: 's' } };
  assert.equal(p.action('api-revoke', { dataset: { token: 't1' } }), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(st.tokens[0].revoked_at, 'x');
  assert.ok(st.secret, 'a secret stays until Done');
  p.action('api-secret-done', { dataset: {} });
  assert.equal(st.secret, null);
  p.action('api-hook-test', { dataset: { endpoint: 'e1' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.at(-1), ['test', 'team1', 'e1']);
  assert.match(toasts.at(-1)[0], /delivered \(204, 9 ms\)/);
  assert.equal(p.action('integ-reload', { dataset: {} }), false, 'other actions are not the panel\'s');
});
