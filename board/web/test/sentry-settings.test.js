import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { render } from '../js/h.js';
import { integrationsScreen } from '../js/render-integrations.js';
import { sentrySettings, saveSentrySettings } from '../js/sentry-settings.js';
import { model } from './fixtures.js';

const boards = [{ id: 'a', name: 'Team board' }, { id: 'b', name: '<b>Private names stay text</b>' }, { id: 'old', name: 'Archived', archived_at: '2026-09-30' }];
const connection = { id: 's1', provider: 'sentry', status: 'active', target_board_id: 'a', settings: { config: {} } };
function rig(role = 'owner', conn = connection) {
  const dom = new JSDOM('<main id="root"></main>');
  const previous = globalThis.document; globalThis.document = dom.window.document;
  const m = model([], { view: 'integrations' });
  render(document.getElementById('root'), integrationsScreen({ ...m, boards, me: { member: { ...m.me.member, role } },
    integrations: { status: 'ok', data: { connections: [conn], available: [], vault: true } } }));
  return { dom, form: document.querySelector('[data-form="sentry-settings"]'), close: () => { globalThis.document = previous; dom.window.close(); } };
}
test('actual DOM routing form submits explicit matching default/target, exact project routes and bounded preferences', () => {
  const r = rig();
  try {
    assert.match(r.dom.window.document.body.textContent, /paused until you save/);
    assert.equal(r.dom.window.document.querySelectorAll('b').length, 0);
    r.form.elements.default_board.value = 'b';
    r.form.elements.project_slug.value = 'app'; r.form.elements.project_board.value = 'a';
    r.form.elements.include_message.checked = true; r.form.elements.cooldown_minutes.value = '120';
    const out = sentrySettings(r.form, boards);
    assert.equal(out.target_board_id, 'b'); assert.equal(out.config.default_board_id, 'b');
    assert.deepEqual({ ...out.config.project_boards }, { app: 'a' });
    assert.equal(out.config.min_level, 'error'); assert.equal(out.config.include_message, true); assert.equal(out.config.cooldown_minutes, 120);
    assert.equal(Object.keys(out.config).length, 5);
  } finally { r.close(); }
});
test('members see routing as text without an editable form, while missing/archived boards cannot be saved', () => {
  const read = rig('member');
  try { assert.equal(read.form, null); assert.match(read.dom.window.document.body.textContent, /admin saves an active default board/); } finally { read.close(); }
  const r = rig('owner', { ...connection, settings: { config: { default_board_id: 'old' } } });
  try { assert.match(r.dom.window.document.body.textContent, /Archived — intake paused/); assert.throws(() => sentrySettings(r.form, boards), /active default board/); } finally { r.close(); }
});
test('actual form rejects duplicate/invalid routes, absent boards and cooldown bounds before a request', () => {
  const r = rig('owner', { ...connection, settings: { config: { default_board_id: 'a', project_boards: { app: 'a' } } } });
  try {
    const slugs = r.form.querySelectorAll('[name="project_slug"]'), targets = r.form.querySelectorAll('[name="project_board"]');
    slugs[1].value = 'app'; targets[1].value = 'b'; assert.throws(() => sentrySettings(r.form, boards), /one route/);
    for (const invalid of ['__proto__', 'constructor', 'Bad Project', '../escape']) { slugs[1].value = invalid; assert.throws(() => sentrySettings(r.form, boards), /exact Sentry project slug/); }
    slugs[1].value = ''; targets[1].value = ''; r.form.elements.cooldown_minutes.value = '1441'; assert.throws(() => sentrySettings(r.form, boards), /cooldown/);
  } finally { r.close(); }
});
test('deferred save never installs a response into a switched team/session; current save updates exactly the same connection', async () => {
  const r = rig();
  try {
    let scope = { org: 'team', member: 'member', user: 'user', role: 'owner', generation: 1, auth: 'ok' }, finish, calls = 0, saves = 0;
    const saving = saveSentrySettings({ form: r.form, connection, boards, getScope: () => scope,
      patch: () => { calls++; return new Promise(resolve => { finish = resolve; }); }, saved: () => { saves++; } });
    scope = { ...scope, org: 'other', generation: 2 }; finish({ connection });
    assert.equal(await saving, false); assert.equal(calls, 1); assert.equal(saves, 0);
    scope = { ...scope, role: 'viewer' };
    assert.equal(await saveSentrySettings({ form: r.form, connection, boards, getScope: () => scope, patch: () => { calls++; }, saved: () => {} }), false);
    assert.equal(calls, 1);
    scope = { ...scope, role: 'owner' };
    assert.equal(await saveSentrySettings({ form: r.form, connection, boards, getScope: () => scope, patch: async () => ({ connection }), saved: c => { assert.equal(c, connection); saves++; } }), true);
    assert.equal(saves, 1);
  } finally { r.close(); }
});
