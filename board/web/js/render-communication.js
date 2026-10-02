import { h } from './h.js';

const field = (name, label, value, maxLength, rows = 3) => h('div', { class: 'field' },
  h('label', { for: `packet-${name}` }, label),
  h('textarea', { id: `packet-${name}`, name, class: 'input', rows, maxlength: maxLength, value }));
const hidden = (name, value) => h('input', { type: 'hidden', name, value });
const authorSource = author => author.identity_source === 'remote_grant'
  ? `via ${author.application ?? 'Remote application'} · unverified application` : author.provider ?? 'Team member';
const writable = (detail, model) => ['owner', 'admin', 'member'].includes(model.me?.member?.role)
  && !detail.data.card.archived && !model.board?.archived_at;

export function packetPanel(detail, model) {
  if (detail.data.card.archived) return h('p', { class: 'muted' }, 'Restore this task to access its shared context.');
  if (detail.packetError) return h('div', null, h('p', { class: 'form-error', role: 'alert' }, detail.packetError),
    h('button', { class: 'btn btn-sm', 'data-action': 'communication-reload' }, 'Reload task context'));
  if (!detail.packetLoaded) return h('p', { class: 'muted', role: 'status' }, 'Loading task context…');
  const p = detail.packet, d = p?.data;
  const values = detail.packetDraft ?? { brief: d?.brief ?? '', decisions: (d?.decisions ?? []).join('\n'), progress: d?.progress ?? '',
    nextAction: d?.nextAction ?? '', paths: (d?.artifacts ?? []).filter((a) => a.kind === 'path').map((a) => a.path).join('\n'),
    reportedChecks: (d?.reportedChecks ?? []).join('\n'), expected_version: p?.version ?? 0, expected_fence: detail.data.card.fence,
    evidence: (d?.artifacts ?? []).filter((a) => a.kind === 'evidence') };
  return h('div', { class: 'task-packet' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'communication-reload' }, 'Refresh context'),
    p ? h('p', { class: 'muted small' }, `Version ${p.version} · ${p.author.name} · ${authorSource(p.author)}`)
      : h('p', { class: 'muted' }, 'Save a brief, decisions and next action so another teammate can pick this up.'),
    p?.evidence?.length ? h('ul', { class: 'md-list' }, p.evidence.map((e) => h('li', { key: e.id }, `${e.kind ?? 'Evidence'} · ${e.verification} · ${e.summary ?? ''}`))) : null,
    writable(detail, model) ? h('form', { 'data-form': 'task-packet', 'data-card': detail.cardId },
      hidden('expected_version', values.expected_version), hidden('expected_fence', values.expected_fence),
      field('brief', 'Brief', values.brief, 4000), field('decisions', 'Decisions (one per line)', values.decisions, 10020),
      field('progress', 'Progress', values.progress, 4000), field('nextAction', 'Next action', values.nextAction, 2000),
      field('paths', 'Artifacts (one repository-relative path per line)', values.paths, 16032),
      field('reportedChecks', 'Reported checks (one per line)', values.reportedChecks, 10020),
      h('p', { class: 'muted small' }, 'Reported checks are participant statements. Evidence verification is shown separately.'),
      detail.packetSaveError ? h('p', { class: 'form-error', role: 'alert' }, detail.packetSaveError) : null,
      h('div', { class: 'composer-row' }, h('button', { type: 'submit', class: 'btn btn-primary btn-sm', disabled: model.busy?.has(`packet:${detail.cardId}`) || null }, 'Save task context'),
        detail.packetDraft ? h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'packet-reload' }, 'Discard draft and reload') : null))
      : d ? h('dl', { class: 'details' }, ['brief', 'decisions', 'progress', 'nextAction', 'reportedChecks'].map((k) => [h('dt', null, ({ brief: 'Brief', decisions: 'Decisions', progress: 'Progress', nextAction: 'Next action', reportedChecks: 'Reported checks' })[k]),
        h('dd', { class: 'prose' }, Array.isArray(d[k]) ? d[k].join('\n') : d[k])])) : null);
}

export function messagePanel(detail, model) {
  if (detail.data.card.archived) return h('p', { class: 'muted' }, 'Restore this task to access its messages.');
  if (detail.messagesError) return h('div', null, h('p', { class: 'form-error', role: 'alert' }, detail.messagesError),
    h('button', { class: 'btn btn-sm', 'data-action': 'communication-reload' }, 'Reload messages'));
  if (!detail.messagesLoaded) return h('p', { class: 'muted', role: 'status' }, 'Loading messages…');
  const history = detail.messages?.messages ?? [], peers = detail.messages?.peers ?? [], draft = detail.messageDraft ?? {};
  return h('div', null, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'communication-reload' }, 'Refresh messages'),
    history.length ? h('ul', { class: 'comments task-messages' }, history.map((m) => h('li', { key: m.id, class: 'comment' },
      h('div', { class: 'comment-head' }, h('strong', null, m.author.name), h('span', { class: 'muted small' }, `${authorSource(m.author)} · ${m.kind} · ${m.card_key}`)),
      h('p', { class: 'comment-body' }, m.body), h('p', { class: 'muted small' }, m.deliveries.map((r) => `${r.recipient_name ?? 'Teammate'}’s ${r.provider ?? 'agent'}: ${r.state === 'acknowledged' ? 'Acknowledged (agent reported)' : r.state === 'received' ? 'Received by host' : r.state === 'superseded' ? 'Previous run' : 'Pending'}`).join(' · ')))))
      : h('p', { class: 'muted' }, 'No task messages yet.'),
    detail.messages?.truncated ? h('p', { class: 'muted small' }, 'Showing the latest 50 messages.') : null,
    writable(detail, model) && peers.length ? h('form', { class: 'composer', 'data-form': 'task-message', 'data-card': detail.cardId },
      h('label', { for: 'message-peer' }, 'Recipient'), h('select', { id: 'message-peer', class: 'input', name: 'recipient', required: true, value: draft.recipient ?? '' },
        h('option', { value: '' }, 'Choose a current task'), peers.map((p) => h('option', { key: p.run_id, value: p.run_id }, `${p.card_key} · ${p.name} · ${p.provider}`))),
      h('label', { for: 'message-kind' }, 'Message type'), h('select', { id: 'message-kind', class: 'input', name: 'kind', value: draft.kind ?? 'coordination' },
        ['coordination', 'question', 'handoff', 'status'].map((k) => h('option', { value: k }, k[0].toUpperCase() + k.slice(1)))),
      h('label', { for: 'message-body' }, 'Message'), h('textarea', { id: 'message-body', name: 'body', class: 'input', rows: 3, maxlength: 4000, required: true, value: draft.body ?? '' }),
      h('p', { class: 'muted small' }, 'Messages wait for the current agent to read them. Sending does not start work or approve an action.'),
      detail.messageSaveError ? h('p', { class: 'form-error', role: 'alert' }, detail.messageSaveError) : null,
      h('button', { type: 'submit', class: 'btn btn-primary btn-sm', disabled: model.busy?.has(`message:${detail.cardId}`) || null }, 'Send task message'))
      : writable(detail, model) ? h('p', { class: 'muted' }, 'A current agent run on this linked repository is needed to receive a message.') : null);
}
