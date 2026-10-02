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
  assert.equal(textOf(note[0]), 'Integrations live on a team hub. Open Team in the sidebar to sign in, then create a team or join one.');
  assert.equal(note[0].tag, 'p');
  assert.equal(byAttr(v, 'data-action', 'integ-connect').length, 0);
  assert.equal(findAll(v, (n) => n.tag === 'form').length, 0);
  assert.equal(findAll(v, (n) => n.tag === 'a').length, 0, 'text only');
  const team = integrationsScreen(m());
  assert.equal(findAll(team, (n) => n.props?.class === 'integ-local muted').length, 0, 'a team hub shows no note');
  assert.equal(byAttr(team, 'data-action', 'integ-connect').length, 1);
});

test('local hub: a grid of the six tools with a one-line value and a status in words; only GitHub is "Available after you join a team"', () => {
  const v = integrationsScreen(m({ local: true }));
  const cards = findAll(v, (n) => n.props?.['data-connector']);
  assert.deepEqual(cards.map((c) => c.props['data-connector']), ['github', 'slack', 'sentry', 'linear', 'jira', 'google']);
  const status = (id) => textOf(findAll(cards.find((c) => c.props['data-connector'] === id), (n) => n.props?.class === 'integ-status small')[0]);
  assert.equal(status('github'), 'Available after you join a team');
  for (const id of ['slack', 'sentry', 'linear', 'jira', 'google']) assert.equal(status(id), 'Coming soon', id);
  assert.match(textOf(cards[0]), /Cards update when pull requests merge/);
  assert.deepEqual(findAll(byAttr(v, 'data-grid', 'local-connectors')[0], (n) => n.tag === 'h3').map(textOf), ['GitHub', 'Slack', 'Sentry', 'Linear', 'Jira', 'Google'], 'tool names are headings');
  assert.equal(byAttr(integrationsScreen(m()), 'data-grid', 'local-connectors').length, 0, 'a team hub shows no local grid');
});

test('the web list of tools: only the launch connectors are available', async () => {
  const { LAUNCH_CONNECTORS, connectorStatus } = await import('../js/connectors.js');
  assert.deepEqual([...LAUNCH_CONNECTORS], ['github']);
  assert.deepEqual(['github', 'slack', 'sentry', 'linear', 'jira', 'google', 'x'].map(connectorStatus), ['available', 'soon', 'soon', 'soon', 'soon', 'soon', 'soon']);
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

// ── identity links (D98) ────────────────────────────────────────────────────

const slk = { id: 'slack', name: 'Slack', scopes: [], connect: 'oauth', actions: {}, prepare: null, identity: true };
const slkConn = (linked) => ({ id: 'c9', provider: 'slack', display_name: 'ws', status: 'active', health: null, settings: {}, linked });
const mi = (linked, role, over = {}) => m({ data: { available: [...available, slk], connections: [slkConn(linked)], vault: true }, ...over }, role);

test('identity: a member gets "Link my Slack account"; once linked, "Unlink"; a viewer can\'t link; a connector without identity shows nothing', () => {
  const v = integrationsScreen(mi(false, 'member'));
  const link = byAttr(v, 'data-action', 'integ-link');
  assert.equal(link.length, 1);
  assert.equal(link[0].props['data-conn'], 'c9');
  assert.equal(link[0].props['data-provider'], 'slack');
  assert.match(textOf(v), /Link my Slack account/);
  assert.equal(byAttr(v, 'data-action', 'integ-linked').length, 0, 'the linked-members list is for admins');
  const linked = integrationsScreen(mi(true, 'member'));
  assert.equal(byAttr(linked, 'data-action', 'integ-unlink').length, 1);
  assert.equal(byAttr(linked, 'data-action', 'integ-link').length, 0);
  const viewer = integrationsScreen(mi(false, 'viewer'));
  assert.equal(byAttr(viewer, 'data-action', 'integ-link').length, 0);
  assert.match(textOf(viewer), /Viewers can’t link an account/);
  assert.equal(byAttr(integrationsScreen(mi(true, 'viewer')), 'data-action', 'integ-unlink').length, 1, 'a viewer may still unlink');
  assert.equal(byAttr(integrationsScreen(m()), 'data-action', 'integ-link').length, 0);
});

test('identity: admins list linked members by name, plain text, with Revoke per member; never a provider id', () => {
  const v = integrationsScreen(mi(false, 'admin', { linked: { c9: [{ member_id: 'mb', display_name: '<b>Bob</b>', linked_at: '2026-09-30T19:00:00Z' }] } }));
  assert.equal(byAttr(v, 'data-action', 'integ-linked')[0].props['aria-expanded'], 'true');
  const revoke = byAttr(v, 'data-action', 'integ-revoke');
  assert.deepEqual(revoke.map((b) => [b.props['data-conn'], b.props['data-member']]), [['c9', 'mb']]);
  assert.match(textOf(v), /<b>Bob<\/b>/, 'names are text');
  assert.equal(findAll(v, (n) => n.tag === 'b').length, 0);
  assert.match(textOf(integrationsScreen(mi(false, 'admin', { linked: { c9: [] } }))), /Nobody has linked an account yet/);
});

// ── the GitHub organization at connect (D42 addendum "start inputs") ────────

const ghStart = { ...available[0], start: ['org'] };
const sm = (over = {}, role = 'owner') => m({ data: { available: [ghStart], connections: [], vault: true }, ...over }, role);

test('start input: admins get an optional plain organization field with its help line, no value, no autocomplete; members get none', () => {
  const v = integrationsScreen(sm());
  const forms = byAttr(v, 'data-form', 'integ-start');
  assert.equal(forms.length, 1);
  assert.equal(forms[0].props['data-provider'], 'github');
  const ins = findAll(forms[0], (n) => n.tag === 'input');
  assert.equal(ins.length, 1);
  const org = ins[0];
  assert.equal(org.props.name, 'org');
  assert.equal(org.props.type, 'text');
  assert.equal(org.props.autocomplete, 'off');
  assert.equal(org.props.spellcheck, 'false');
  assert.equal(org.props.value, undefined, 'never a value from the model');
  assert.ok(!org.props.required, 'optional');
  const t = textOf(forms[0]);
  assert.match(t, /GitHub organization \(optional\)/);
  assert.match(t, /Leave empty to create the app under the GitHub account you're signed in as\. For a team's repositories, enter the organization name\./);
  const submit = findAll(forms[0], (n) => n.tag === 'button');
  assert.deepEqual(submit.map((b) => [b.props.type, textOf(b)]), [['submit', 'Connect GitHub']]);
  assert.equal(byAttr(v, 'data-action', 'integ-connect').length, 0, 'the form is the connect');
  for (const role of ['member', 'viewer']) {
    const mv = integrationsScreen(sm({}, role));
    assert.equal(byAttr(mv, 'data-form', 'integ-start').length, 0, role);
    assert.equal(findAll(mv, (n) => n.tag === 'input').length, 0, role);
  }
  // A connector without start inputs keeps its plain Connect button.
  assert.equal(byAttr(integrationsScreen(m({ data: { available, connections: [], vault: true } })), 'data-form', 'integ-start').length, 0);
});

test('start input: the manifest form says which owner the app will be created under (from its action), and replaces the start form', () => {
  const at = (action) => integrationsScreen(sm({ manifest: { provider: 'github', action, fields: { manifest: '{}' }, target: '_blank' } }));
  const org = at('https://github.com/organizations/acme-co/settings/apps/new?state=s.t');
  assert.match(textOf(org), /The app will be created under the GitHub organization acme-co\./);
  assert.equal(byAttr(org, 'data-form', 'integ-start').length, 0);
  assert.match(textOf(at('https://github.com/settings/apps/new?state=s.t')), /The app will be created under the GitHub account you're signed in as\./);
});

test('start input: a connected app shows its owner to admins (organization or personal account), from the provider facts only', () => {
  const owned = (provider, role = 'owner') => textOf(integrationsScreen(m({ data: { available: [ghStart], connections: [{ ...conn, display_name: provider.login, settings: { autonomy: {}, provider, config: { org: 'not-this' } } }], vault: true } }, role)));
  assert.match(owned({ login: 'acme-co', org: 'acme-co' }), /Created under the GitHub organization acme-co/);
  assert.match(owned({ login: 'callum' }), /Created under the GitHub account callum/);
  assert.doesNotMatch(owned({ login: 'callum' }), /not-this/);
  assert.doesNotMatch(owned({ login: '<b>x</b>' }), /Created under/, 'only a login-shaped owner');
});

test('start input: the typed org leaves the form at once and never enters state (takeInput), and goes only in the start body', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../js/api.js', import.meta.url), 'utf8');
  assert.match(app, /if \(kind === 'integ-start'\) return connectIntegration\(form\.dataset\.provider, 'app_install', takeInput\(form\)\);/);
  assert.match(app, /api\.startConnect\(provider, input\)/);
  assert.match(app, /manifest: \{ provider, \.\.\.res\.form, target: connectWindowTarget\(provider, res\.bind, navigator\.userAgent\) \}/);
  assert.match(api, /startConnect: \(provider, input\) => mut\('POST', `\/api\/integrations\/\$\{enc\(provider\)\}\/start`, input && Object\.keys\(input\)\.length \? \{ input \} : undefined\),/);
});

// ── Sentry slice S-A: the webhook URL (G1) and the secret note ────────────

const sentry = { id: 'sentry', name: 'Sentry', scopes: ['event:read'], connect: 'token', shows_webhook_url: true, actions: { 'sentry.card': { default: 'auto' }, 'sentry.notice': { default: 'auto' }, 'sentry.suppressed': { default: 'auto' } } };
const sentryConn = (over = {}) => ({ id: 's1', provider: 'sentry', display_name: 'Sentry', status: 'active', health: null, settings: { autonomy: {} }, ...over });
const URL_S1 = 'https://hub.example/integrations/s1/webhook';

test('Sentry: admins see the connection\'s webhook URL as plain text with a Copy button; members never do', () => {
  const v = integrationsScreen(m({ data: { available: [sentry], connections: [sentryConn({ webhook_url: URL_S1 })], vault: true } }));
  const t = textOf(v);
  assert.match(t, /Paste this URL into Sentry as the integration's Webhook URL/);
  assert.ok(t.includes(URL_S1));
  const [copy] = byAttr(v, 'data-action', 'integ-copy-url');
  assert.equal(copy.tag, 'button');
  assert.equal(copy.props['data-url'], URL_S1);
  assert.equal(findAll(v, (n) => n.tag === 'a' && String(n.props?.href ?? '').includes('/webhook')).length, 0, 'text, not a link');
  // A member's list has no webhook_url; even if one slipped in, it is not shown to them.
  const mv = integrationsScreen(m({ data: { available: [sentry], connections: [sentryConn({ webhook_url: URL_S1 })], vault: true } }, 'member'));
  assert.ok(!textOf(mv).includes(URL_S1));
  assert.equal(byAttr(mv, 'data-action', 'integ-copy-url').length, 0);
  // No public URL on the hub: says how to get one, no button.
  const nv = integrationsScreen(m({ data: { available: [sentry], connections: [sentryConn({ webhook_url: null })], vault: true } }));
  assert.match(textOf(nv), /Ask its administrator to configure one before connecting webhooks/);
  assert.equal(byAttr(nv, 'data-action', 'integ-copy-url').length, 0);
  // A connector without it shows nothing of the kind.
  assert.equal(byAttr(integrationsScreen(m()), 'data-action', 'integ-copy-url').length, 0);
});

test('Sentry: the token form says the secret is never shown again and to rotate it in Sentry before reconnecting', () => {
  const v = integrationsScreen(m({ tokenFor: 'sentry', data: { available: [sentry], connections: [], vault: true } }));
  const [form] = byAttr(v, 'data-form', 'integ-token');
  const t = textOf(form);
  assert.match(t, /Sentry client secret/);
  assert.match(t, /Plexiform stores this secret encrypted and never displays it again\./);
  assert.match(t, /Rotate the secret in Sentry before reconnecting so old signed requests cannot be reused\./);
  assert.equal(findAll(form, (n) => n.tag === 'input')[0].props.type, 'password');
  // The fake token connector keeps its plain form.
  assert.doesNotMatch(textOf(integrationsScreen(m({ tokenFor: 'fake' }))), /never shows it again/);
});

test('Sentry: its actions have plain names, and the copy button writes only the URL from the button', async () => {
  assert.equal(actionLabel('sentry.card'), 'Create cards from new Sentry issues');
  assert.equal(actionLabel('sentry.notice'), 'Comment when new issues exceed the card limit');
  assert.equal(actionLabel('sentry.suppressed'), 'Record issues that were not turned into cards');
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /case 'integ-copy-url': copyText\(el\.dataset\.url\); return;/);
});
