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
