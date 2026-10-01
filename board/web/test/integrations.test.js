// Integrations page: pure render over GET /api/integrations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, findAll, byAttr } from '../js/h.js';
import * as integ from '../js/render-integrations.js';

const { integrationsScreen, actionLabel, connectWindowName } = integ;
import { boardScreen } from '../js/render-board.js';
import { model } from './fixtures.js';

const available = [
  { id: 'github', name: 'GitHub', scopes: ['pull_requests:read'], connect: 'app_install', actions: { 'system.pr_merged': { default: 'auto' }, 'github.comment': { default: 'ask' } } },
  { id: 'fake', name: 'Fake tracker', scopes: ['issues:read'], connect: 'token', actions: { 'card.create': { default: 'auto' } } },
];
const conn = { id: 'c1', provider: 'github', display_name: 'acme', status: 'active', health: { ok: false, last_error: 'provider_error' }, settings: { autonomy: { 'github.comment': 'off' } } };

const m = (over = {}, role = 'owner') => {
  const base = model([], { view: 'integrations' });
  return { ...base, me: { member: { ...base.me.member, role } }, integrations: { status: 'ok', data: { available, connections: [conn], vault: true }, open: null, audit: {}, tokenFor: null, confirmDisconnect: null, nowMs: Date.parse('2026-09-30T20:00:00Z'), ...over } };
};

test('connected tools show health and per-action autonomy; available ones offer the right connect', () => {
  const v = integrationsScreen(m());
  const t = textOf(v);
  assert.match(t, /Problem: the tool’s server is having trouble/);
  assert.match(t, /Mark a card Done when its PR merges/);
  const selects = findAll(v, (n) => n.tag === 'select' && n.props['data-change'] === 'integ-autonomy');
  assert.equal(selects.length, 2);
  const comment = selects.find((s) => s.props['data-action-id'] === 'github.comment');
  assert.equal(comment.children.find((o) => o.props.selected).props.value, 'off');
  assert.match(t, /default: Ask first/);
  const connect = byAttr(v, 'data-action', 'integ-connect');
  assert.deepEqual(connect.map((b) => b.props['data-provider']), ['fake']);
  assert.equal(connect[0].props['data-kind'], 'token');
});

test('members see autonomy read-only and cannot connect or disconnect', () => {
  const v = integrationsScreen(m({}, 'member'));
  assert.equal(findAll(v, (n) => n.tag === 'select').length, 0);
  assert.equal(byAttr(v, 'data-action', 'integ-connect').length, 0);
  assert.equal(byAttr(v, 'data-action', 'integ-disconnect-ask').length, 0);
  assert.match(textOf(v), /A team admin can connect this/);
});

test('no vault key: says so and offers no connect', () => {
  const v = integrationsScreen(m({ data: { available, connections: [], vault: false } }));
  assert.match(textOf(v), /needs its encryption key/);
  assert.equal(byAttr(v, 'data-action', 'integ-connect').length, 0);
});

test('disconnect asks inline first; activity lists audit entries as text', () => {
  const v = integrationsScreen(m({ confirmDisconnect: 'c1', open: 'c1', audit: { c1: [{ id: 'a', action: 'system.pr_merged', decision: 'auto', external_ref: '<b>PR 7</b>', card_id: 'k1', at: '2026-09-30T19:00:00Z' }] } }));
  assert.equal(byAttr(v, 'data-action', 'integ-disconnect').length, 1);
  assert.match(textOf(v), /Done automatically/);
  assert.equal(findAll(v, (n) => n.tag === 'b').length, 0, 'provider refs stay text (D25)');
  assert.equal(byAttr(v, 'data-action', 'open')[0].props['data-card'], 'k1');
});

test('members see no Activity (the audit log is admin-only)', () => {
  const v = integrationsScreen(m({ open: 'c1', audit: { c1: [{ id: 'a', action: 'card.create', decision: 'auto', at: '2026-09-30T19:00:00Z' }] } }, 'member'));
  assert.equal(byAttr(v, 'data-action', 'integ-activity').length, 0);
  assert.ok(!/Activity|Done automatically/.test(textOf(v)));
  assert.equal(byAttr(integrationsScreen(m({}, 'admin')), 'data-action', 'integ-activity').length, 1);
});

test('token form, loading and error states', () => {
  assert.equal(byAttr(integrationsScreen(m({ tokenFor: 'fake' })), 'data-form', 'integ-token').length, 1);
  assert.match(textOf(integrationsScreen(m({ status: 'loading', data: null }))), /Loading integrations/);
  assert.equal(byAttr(integrationsScreen(m({ status: 'error', data: null, error: 'nope' })), 'data-action', 'integ-reload').length, 1);
});

test('health codes and failed actions read as fixed text; an unknown code never shows raw', () => {
  const odd = { ...conn, health: { ok: false, last_error: '<script>token xoxb' } };
  const t = textOf(integrationsScreen(m({ data: { available, connections: [odd], vault: true }, open: 'c1', audit: { c1: [{ id: 'a', action: 'card.create', decision: 'failed', error: 'handler_timeout', at: '2026-09-30T19:00:00Z' }] } })));
  assert.match(t, /Problem: something went wrong/);
  assert.ok(!t.includes('xoxb'));
  assert.match(t, /Failed: an update from the tool took too long/);
});

test('the connect window is named plexiform-connect|<provider>|<bind> for the desktop app; no finish-here step', () => {
  const bind = 'AbCd_-0123456789abcdefghijklmnopqrstuv';
  assert.equal(connectWindowName('github', bind), `plexiform-connect|github|${bind}`);
  const [tag, provider, b] = connectWindowName('fake-oauth', bind).split('|');
  assert.deepEqual([tag, provider, b], ['plexiform-connect', 'fake-oauth', bind]);
  assert.match(provider, /^[a-z0-9-]{2,32}$/);
  assert.match(b, /^[A-Za-z0-9_-]{1,64}$/);
  assert.throws(() => connectWindowName('Git|Hub', bind));
  assert.throws(() => connectWindowName('github', 'x|y'));
  assert.throws(() => connectWindowName('github', 'x'.repeat(65)));
  const v = integrationsScreen(m({ data: { available, connections: [], vault: true } }));
  assert.equal(byAttr(v, 'data-action', 'integ-complete').length, 0);
  assert.ok(!textOf(v).includes('Finish connecting'));
});

test('the bind goes into the window name only inside the desktop shell; a plain browser tab gets _blank (the cookie suffices)', () => {
  const bind = 'AbCd_-0123456789abcdefghijklmnopqrstuv';
  const target = integ.connectWindowTarget;
  assert.equal(typeof target, 'function');
  const desktop = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Electron/38.0 Plexiform/1.4.0';
  assert.equal(target('github', bind, desktop), `plexiform-connect|github|${bind}`);
  for (const ua of ['Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36', '', undefined, 'Plexiform 1.0']) {
    const t = target('github', bind, ua);
    assert.equal(t, '_blank', String(ua));
    assert.ok(!t.includes(bind));
  }
});

test('Integrations is not in the board view switcher', () => {
  const v = boardScreen(model([], { view: 'integrations' }), integrationsScreen(m()));
  assert.equal(findAll(v, (n) => n.props['data-view'] === 'integrations').length, 0);
  assert.equal(actionLabel('unknown.x'), 'unknown.x');
});

test('a manifest connect renders a real POST form: hidden fields, one "Create the app" submit, no script, not intercepted', () => {
  const manifest = { provider: 'github', action: 'https://github.com/settings/apps/new?state=s.t', fields: { manifest: '{"name":"Buddy","url":"x\\"y"}' }, target: '_blank' };
  const v = integrationsScreen(m({ data: { available, connections: [], vault: true }, manifest }));
  const forms = findAll(v, (n) => n.tag === 'form');
  assert.equal(forms.length, 1);
  const f = forms[0];
  assert.equal(f.props.method, 'post');
  assert.equal(f.props.action, manifest.action);
  assert.equal(f.props.target, '_blank');
  assert.equal(f.props.rel, 'noopener noreferrer');
  assert.equal(f.props['data-form'], undefined, 'the app\'s submit handler must not preventDefault it');
  const hidden = findAll(f, (n) => n.tag === 'input');
  assert.deepEqual(hidden.map((i) => [i.props.type, i.props.name, i.props.value]), [['hidden', 'manifest', manifest.fields.manifest]]);
  const buttons = findAll(f, (n) => n.tag === 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.type, 'submit');
  assert.equal(textOf(buttons[0]), 'Create the app on GitHub');
  assert.equal(findAll(v, (n) => n.tag === 'script').length, 0);
  assert.equal(byAttr(v, 'data-provider', 'github').filter((n) => n.props['data-action'] === 'integ-connect').length, 0, 'the form replaces the connect button');
  // The fake (token) card is untouched; a manifest for another provider or a non-https action renders no form.
  assert.equal(findAll(integrationsScreen(m({ data: { available, connections: [], vault: true }, manifest: { ...manifest, provider: 'fake' } })), (n) => n.tag === 'form' && n.props.method === 'post').length, 0);
  assert.equal(findAll(integrationsScreen(m({ data: { available, connections: [], vault: true }, manifest: { ...manifest, action: 'http://github.com/x' } })), (n) => n.tag === 'form').length, 0);
});

test('local hub (no accounts): a plain note says where to connect, and no connect button or manifest form is offered', () => {
  const v = integrationsScreen(m({ local: true, manifest: { provider: 'github', action: 'https://github.com/settings/apps/new?state=s', fields: { manifest: '{}' } } }));
  const note = findAll(v, (n) => n.props?.class === 'integ-local muted');
  assert.equal(note.length, 1);
  assert.equal(textOf(note[0]), 'Connect tools on a team hub: sign in and open your team’s board.');
  assert.equal(note[0].tag, 'p');
  assert.equal(byAttr(v, 'data-action', 'integ-connect').length, 0);
  assert.equal(findAll(v, (n) => n.tag === 'form').length, 0);
  assert.equal(findAll(v, (n) => n.tag === 'a').length, 0, 'text only');
  const team = integrationsScreen(m());
  assert.equal(findAll(team, (n) => n.props?.class === 'integ-local muted').length, 0, 'a team hub shows no note');
  assert.equal(byAttr(team, 'data-action', 'integ-connect').length, 1);
});

test('the app tells the Integrations page it is on the local hub from /api/health’s auth', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(src, /integrations: state\.view === 'integrations' \? \{ \.\.\.state\.integ, nowMs: Date\.now\(\), local: state\.authMode === 'local' \} : null,/);
  assert.match(src, /state\.authMode = \(await api\.health\(\)\)\.auth/);
});

// ── pending connections (D97) ─────────────────────────────────────────────

const pend = { id: 'pend', name: 'Pend', scopes: [], connect: 'oauth', actions: {}, prepare: ['config_token', 'app_id', 'client_id', 'client_secret', 'signing_secret'] };
const row = (over = {}) => ({ id: 'p1', provider: 'pend', status: 'pending', created_by: 'm-alice', created_at: '2026-09-30T19:18:00Z', expires_at: '2026-09-30T20:42:00Z', ready: true, ...over });
const pm = (over = {}, role = 'owner') => m({ data: { available: [pend], connections: [], vault: true, pending: [] }, ...over }, role);
const inputs = (v) => findAll(v, (n) => n.tag === 'input');

test('a prepare connector: admins get a password field for the configuration token and a paste-instead button; inputs never carry a value', () => {
  const v = integrationsScreen(pm());
  const f = byAttr(v, 'data-form', 'integ-prepare');
  assert.equal(f.length, 1);
  assert.equal(f[0].props['data-provider'], 'pend');
  const [token] = inputs(f[0]);
  assert.equal(token.props.name, 'config_token');
  assert.equal(token.props.type, 'password');
  assert.equal(token.props.value, undefined);
  assert.match(textOf(f[0]), /App configuration token/);
  assert.match(textOf(f[0]), /Create the Pend app/);
  assert.equal(byAttr(v, 'data-action', 'integ-paste').length, 1);
  assert.match(textOf(integrationsScreen(pm({}, 'member'))), /A team admin can connect this/);
  assert.equal(byAttr(integrationsScreen(pm({}, 'member')), 'data-form', 'integ-prepare').length, 0);
});

test('a ready pending row of mine: "Waiting for approval · expires in N min", Continue and Cancel; Cancel asks first and says to delete the app at the provider', () => {
  const v = integrationsScreen(pm({ data: { available: [pend], connections: [], vault: true, pending: [row()] } }));
  assert.match(textOf(v), /Waiting for approval · expires in 42 min/);
  assert.equal(byAttr(v, 'data-action', 'integ-authorize')[0].props['data-pending'], 'p1');
  assert.equal(byAttr(v, 'data-form', 'integ-prepare').length, 0, 'no new setup while one is pending');
  assert.equal(byAttr(v, 'data-action', 'integ-pending-cancel-ask').length, 1);
  const c = integrationsScreen(pm({ data: { available: [pend], connections: [], vault: true, pending: [row()] }, confirmCancel: 'p1' }));
  assert.match(textOf(c), /delete the app this setup created on Pend/i);
  assert.match(textOf(c), /the hub can’t/);
  assert.equal(byAttr(c, 'data-action', 'integ-pending-cancel')[0].props['data-pending'], 'p1');
  // Another admin's row: no Continue (only its creator can finish), Cancel stays.
  const o = integrationsScreen(pm({ data: { available: [pend], connections: [], vault: true, pending: [row({ created_by: 'm-bob' })] } }));
  assert.equal(byAttr(o, 'data-action', 'integ-authorize').length, 0);
  assert.equal(byAttr(o, 'data-action', 'integ-pending-cancel-ask').length, 1);
});

test('a pending row that needs a paste: the create link and the fields (ids as text, secrets as password, no values)', () => {
  const needs = { p1: { fields: ['app_id', 'client_id', 'client_secret', 'signing_secret'], create_url: 'https://pend.example/apps?new_app=1' } };
  const v = integrationsScreen(pm({ data: { available: [pend], connections: [], vault: true, pending: [row({ ready: false })] }, needs }));
  const link = findAll(v, (n) => n.tag === 'a' && n.props.href === needs.p1.create_url);
  assert.equal(link.length, 1);
  assert.equal(link[0].props.rel, 'noopener noreferrer');
  const f = byAttr(v, 'data-form', 'integ-prepare')[0];
  assert.equal(f.props['data-pending'], 'p1');
  assert.deepEqual(inputs(f).map((i) => [i.props.name, i.props.type, i.props.value]), [['app_id', 'text', undefined], ['client_id', 'text', undefined], ['client_secret', 'password', undefined], ['signing_secret', 'password', undefined]]);
  // An http create_url is never linked.
  const bad = integrationsScreen(pm({ data: { available: [pend], connections: [], vault: true, pending: [row({ ready: false })] }, needs: { p1: { ...needs.p1, create_url: 'http://pend.example/x' } } }));
  assert.equal(findAll(bad, (n) => n.tag === 'a').length, 0);
});

test('takeInput reads the form\'s named inputs and clears them at once', () => {
  const els = [{ name: 'config_token', value: ' tok-value ' }, { name: 'app_id', value: '' }];
  const form = { querySelectorAll: () => els };
  assert.deepEqual(integ.takeInput(form), { config_token: 'tok-value' });
  assert.deepEqual(els.map((e) => e.value), ['', '']);
});

test('password managers keep out of secret fields: the configuration token, pasted secrets and the token connector field', () => {
  const pinned = (i) => [i.props.autocomplete, i.props['data-1p-ignore'], i.props['data-lpignore']];
  const [token] = inputs(byAttr(integrationsScreen(pm()), 'data-form', 'integ-prepare')[0]);
  assert.deepEqual(pinned(token), ['new-password', '', 'true']);
  const needs = { p1: { fields: ['app_id', 'client_secret'], create_url: 'https://pend.example/apps?new_app=1' } };
  const paste = inputs(byAttr(integrationsScreen(pm({ data: { available: [pend], connections: [], vault: true, pending: [row({ ready: false })] }, needs })), 'data-form', 'integ-prepare')[0]);
  assert.deepEqual(paste.map(pinned), [['off', '', 'true'], ['new-password', '', 'true']]);
  const [tok] = inputs(byAttr(integrationsScreen(m({ tokenFor: 'fake' })), 'data-form', 'integ-token')[0]);
  assert.equal(tok.props.name, 'token');
  assert.deepEqual(pinned(tok), ['new-password', '', 'true']);
});
