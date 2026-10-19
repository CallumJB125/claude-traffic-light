import { h } from './h.js';

// The hub's slack/webhook.js CHANNEL_ID: the connector refuses intake from any other channel.
export const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]{2,20}$/;

export function slackChannelPatch(form) {
  const raw = String(new form.ownerDocument.defaultView.FormData(form).get('channel_id') ?? '').trim();
  if (!raw) return { config: { channel_id: null } };
  if (!SLACK_CHANNEL_ID.test(raw)) throw Object.assign(new Error('Use the channel ID from Slack (starts with C or G, e.g. C0123ABCD).'), { code: 'VALIDATION' });
  return { config: { channel_id: raw } };
}

export function slackChannel(conn, m) {
  const saved = conn.settings?.config?.channel_id;
  const current = typeof saved === 'string' && SLACK_CHANNEL_ID.test(saved) ? saved : '';
  const status = current ? null : h('p', { class: 'small', role: 'status' }, 'Intake is paused until an admin chooses a Slack channel.');
  if (!m.canEdit) return h('section', { class: 'integ-section', 'aria-label': 'Slack channel' },
    h('h4', null, 'Slack channel'), current ? h('p', { class: 'small' }, h('code', { class: 'num' }, current)) : status);
  const busy = m.busy.has(`integ:${conn.id}`);
  const help = `slack-channel-help-${conn.id}`;
  return h('section', { class: 'integ-section', 'aria-label': 'Slack channel' }, h('h4', null, 'Slack channel'), status,
    h('form', { 'data-form': 'slack-channel', 'data-conn': conn.id },
      h('label', { class: 'field' }, h('span', null, 'Channel ID'),
        h('input', { name: 'channel_id', class: 'input', value: current, maxlength: 21, placeholder: 'C0123ABCD', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-describedby': help, disabled: busy || null })),
      h('p', { id: help, class: 'muted small' }, '/plex todo and the message shortcut make cards only in this channel. In Slack, open the channel details; the ID is at the bottom. Invite the app to a private channel first. Clear it to pause intake.'),
      m.slackErrors?.[conn.id] ? h('p', { role: 'alert', class: 'small' }, m.slackErrors[conn.id]) : null,
      h('button', { type: 'submit', class: 'btn btn-sm', disabled: busy || null }, busy ? 'Saving…' : 'Save channel')));
}
