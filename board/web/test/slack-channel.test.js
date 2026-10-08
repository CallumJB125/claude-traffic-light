import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { render } from '../js/h.js';
import { integrationsScreen } from '../js/render-integrations.js';
import { slackChannelPatch, SLACK_CHANNEL_ID } from '../js/render-slack.js';
import { CHANNEL_ID } from '../../hub/integrations/slack/webhook.js';
import { model } from './fixtures.js';

const boards = [{ id: 'a', name: 'Team board' }];
const slack = { id: 'slack', name: 'Slack', scopes: ['commands'], connect: 'prepare', actions: {} };
const connection = (config = {}) => ({ id: 'k1', provider: 'slack', status: 'active', target_board_id: 'a', settings: { config } });
function rig(role = 'owner', conn = connection(), extra = {}) {
  const dom = new JSDOM('<main id="root"></main>');
  const previous = globalThis.document; globalThis.document = dom.window.document;
  const m = model([], { view: 'integrations' });
  render(document.getElementById('root'), integrationsScreen({ ...m, boards, me: { member: { ...m.me.member, role } },
    integrations: { status: 'ok', data: { connections: [conn], available: [slack], vault: true }, ...extra } }));
  return { dom, text: dom.window.document.body.textContent, form: document.querySelector('[data-form="slack-channel"]'), close: () => { globalThis.document = previous; dom.window.close(); } };
}

test('the web channel rule is the hub connector rule', () => {
  assert.equal(SLACK_CHANNEL_ID.source, CHANNEL_ID.source);
  assert.equal(SLACK_CHANNEL_ID.flags, CHANNEL_ID.flags);
});

test('an admin with no channel sees intake paused and saves an exact channel id as the only config key', () => {
  const r = rig();
  try {
    assert.match(r.text, /Intake is paused until an admin chooses a Slack channel/);
    assert.equal(r.form.dataset.conn, 'k1');
    r.form.elements.channel_id.value = '  C0123ABCD ';
    assert.deepEqual(slackChannelPatch(r.form), { config: { channel_id: 'C0123ABCD' } });
  } finally { r.close(); }
});

test('clearing the field removes the channel; malformed ids are refused before a request', () => {
  const r = rig('admin', connection({ channel_id: 'G01ABC' }));
  try {
    assert.equal(r.form.elements.channel_id.value, 'G01ABC');
    assert.doesNotMatch(r.text, /Intake is paused/);
    r.form.elements.channel_id.value = '';
    assert.deepEqual(slackChannelPatch(r.form), { config: { channel_id: null } });
    for (const bad of ['c0123abcd', '#general', 'U0123ABCD', 'C0', 'C0123ABCD<b>', 'C' + 'A'.repeat(21)]) {
      r.form.elements.channel_id.value = bad;
      assert.throws(() => slackChannelPatch(r.form), (e) => e.code === 'VALIDATION' && /channel ID/.test(e.message), bad);
    }
  } finally { r.close(); }
});

test('members see the channel as text without a form; a stored non-channel value is never shown', () => {
  const read = rig('member', connection({ channel_id: 'C0123ABCD' }));
  try { assert.equal(read.form, null); assert.match(read.text, /C0123ABCD/); } finally { read.close(); }
  const odd = rig('member', connection({ channel_id: '<img src=x>' }));
  try { assert.equal(odd.form, null); assert.doesNotMatch(odd.text, /img/); assert.match(odd.text, /Intake is paused/); } finally { odd.close(); }
});

test('a save error is shown on its own connection and the section is absent for other providers', () => {
  const r = rig('owner', connection(), { slackErrors: { k1: 'Slack has no setting x' } });
  try { assert.match(r.dom.window.document.querySelector('[role="alert"]').textContent, /no setting x/); } finally { r.close(); }
  const g = rig('owner', { id: 'g1', provider: 'github', status: 'active', target_board_id: 'a', settings: { config: { channel_id: 'C0123ABCD' } } });
  try { assert.equal(g.form, null); assert.doesNotMatch(g.text, /Slack channel/); } finally { g.close(); }
});
