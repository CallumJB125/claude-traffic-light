// Modal dialogs: Give to Claude, confirm (destructive), hand over, request
// changes, new card. Native <dialog> + showModal() gives focus trapping and
// Escape for free; app.js opens them after render.
import { h } from './h.js';
import { icon, pixelClaude } from './icons.js';
import { formatAge } from './view.js';
import { paletteDialog } from './render-palette.js';
import { SENT_TEXT, VIEWER_TEXT } from './feedback-send.js';
import { LABEL_COLORS, labelClass, managerRows } from './labels.js';

function shell(kind, title, content, { wide = false, describedBy = null } = {}) {
  return h('dialog', { class: `modal${wide ? ' modal-wide' : ''}`, 'data-dialog': kind, 'aria-labelledby': `dlg-${kind}-title`, 'aria-describedby': describedBy },
    h('div', { class: 'modal-head' },
      h('h2', { id: `dlg-${kind}-title` }, title),
      h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'data-action': 'close-dialog', 'aria-label': 'Close' }, icon('close'))),
    content);
}

function errorLine(dlg) {
  return dlg.error ? h('p', { class: 'form-error', role: 'alert' }, icon('warn', 'icon-xs'), dlg.error) : null;
}

function field(id, label, control, hint) {
  return h('div', { class: 'field' },
    h('label', { for: id }, label),
    control,
    hint ? h('p', { class: 'hint', id: `${id}-hint` }, hint) : null);
}

function overlapWarning(preview, targetName) {
  if (preview?.loading) return h('div', { class: 'callout callout-quiet', role: 'status' }, 'Checking for overlapping work…');
  if (preview?.error) return h('div', { class: 'callout callout-quiet' }, `Couldn't check for overlaps: ${preview.error}`);
  const list = preview?.overlaps ?? [];
  if (!list.length) return h('div', { class: 'callout callout-ok' }, icon('check', 'icon-xs'), 'No overlapping work on this repo right now.');
  return h('div', { class: 'callout callout-warn', role: 'status' },
    h('p', { class: 'callout-title' }, icon('warn', 'icon-xs'), `Overlaps ${list.length} live card${list.length > 1 ? 's' : ''}`),
    h('ul', null, list.slice(0, 4).map((o) => h('li', { key: o.other_card_id },
      h('strong', null, o.other_key), o.other_owner ? ` (${o.other_owner}'s Claude)` : '',
      o.kind === 'adjacent' ? ' is working nearby' : ' is editing',
      o.paths?.length ? [' ', h('code', null, o.paths[0]), o.paths.length > 1 ? ` +${o.paths.length - 1}` : ''] : '',
      o.kind === 'adjacent' ? '' : ', which this card mentions'))),
    h('p', { class: 'hint' }, `This never blocks. ${targetName ? `${targetName}'s Claude` : 'Claude'} will see the same warning while it works.`));
}

export function giveDialog(dlg, model) {
  const view = model.entries.find((e) => e.view.id === dlg.cardId)?.view;
  if (!view) return null;
  const meId = model.me?.member?.id;
  const members = [...model.members.values()];
  const target = dlg.target ?? meId;
  const targetMember = model.members.get(target);
  const isMe = target === meId;
  const repos = dlg.repos ?? [];
  const busy = dlg.busy;
  const title = dlg.mode === 'redispatch' ? `Give ${view.key} back to Claude` : `Give ${view.key} to Claude`;

  return shell('give', title, h('form', { class: 'modal-body', 'data-form': 'give', 'data-card': view.id },
    h('p', { class: 'modal-lede' }, view.title),
    h('fieldset', { class: 'field runner-pick' },
      h('legend', null, 'Whose Claude runs it'),
      members.map((m) => h('label', { key: m.member_id, class: `runner-opt${target === m.member_id ? ' is-picked' : ''}` },
        h('input', { type: 'radio', name: 'target', value: m.member_id, checked: target === m.member_id, 'data-change': 'give-target' }),
        h('span', { class: 'runner-name' }, m.member_id === meId ? 'Your Claude' : `${m.name}'s Claude`),
        h('span', { class: 'runner-note' }, m.member_id === meId ? 'Starts right away' : `${m.name} confirms on their machine first`)))),
    h('div', { class: 'field-row' },
      field('give-repo', 'Repo',
        h('select', { id: 'give-repo', name: 'repo_id', class: 'input', required: true, 'data-change': 'give-repo' },
          h('option', { value: '', selected: !dlg.repo_id }, repos.length ? 'Choose a repo' : 'Loading repos…'),
          repos.map((r) => h('option', { key: r.id, value: r.id, selected: dlg.repo_id === r.id }, r.short_name ?? r.canonical_url)))),
      field('give-ref', 'Base branch',
        h('input', { id: 'give-ref', name: 'base_ref', class: 'input num', value: dlg.base_ref ?? '', placeholder: 'main', autocomplete: 'off', spellcheck: 'false' }))),
    h('div', { class: 'field-row' },
      field('give-budget', 'Budget (USD)',
        h('input', { id: 'give-budget', name: 'budget_usd', class: 'input num', type: 'number', min: '0.5', step: '0.5', value: dlg.budget_usd ?? '', inputmode: 'decimal' }),
        'The run stops when it reaches this. Soft by one API call.'),
      h('div', { class: 'field field-check' },
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', name: 'plan_approval', checked: !!dlg.plan_approval }),
          'Ask me to approve the plan first'),
        h('p', { class: 'hint' }, 'Claude writes a plan and waits for a yes before editing.'))),
    overlapWarning(dlg.preview, isMe ? null : targetMember?.name),
    h('div', { class: 'sponsor-box', id: 'give-sponsor' },
      pixelClaude({ lamps: { green: true }, cls: 'sponsor-mark' }),
      h('div', null,
        h('p', { class: 'sponsor-line' }, dlg.preview?.sponsor ?? (isMe ? 'Runs on your machine · your claude account' : `Runs on ${targetMember?.name}'s machine · ${targetMember?.name}'s claude account`)),
        h('p', { class: 'hint' }, isMe ? 'Usage comes out of your own plan.' : `This spends ${targetMember?.name}'s plan, so ${targetMember?.name} must confirm before it starts.`))),
    errorLine(dlg),
    h('div', { class: 'modal-foot' },
      h('button', { type: 'button', class: 'btn', 'data-action': 'close-dialog' }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn btn-claude', disabled: busy || null, 'aria-busy': busy ? 'true' : null, 'aria-describedby': 'give-sponsor' },
        busy ? 'Giving…' : isMe ? 'Give to Claude' : `Ask ${targetMember?.name}'s Claude`))), { wide: true });
}

const CONFIRM = {
  stop: (v) => ({ title: `Stop ${v.key}?`, body: 'The agent is interrupted and its process tree is killed. The handover and the last code snapshot stay on the card, so you or a teammate can pick it up.', confirm: 'Stop the run', danger: true }),
  cancel: (v) => ({ title: `Cancel ${v.key}?`, body: 'It goes back to To do. No runner has started it yet.', confirm: 'Cancel dispatch', danger: false }),
  take_over_confirm: (v) => ({
    title: `Take over ${v.key}?`,
    body: v.run_state === 'suspended'
      ? `${v.run?.owner?.name ?? 'The owner'}'s ${v.device_kind ?? 'laptop'} is asleep, not gone. If you take over, their agent is fenced and stops the moment it wakes, and its last work is kept as salvage.`
      : `No signal from ${v.run?.owner?.name ?? 'the owner'}'s runner for ${formatAge(v.state_age_ms)}. If it comes back, it's fenced and stops; its last work is kept as salvage.`,
    confirm: 'Take over',
    danger: true,
  }),
  take_over: (v) => ({ title: `Take over ${v.key}?`, body: 'You become the owner. You can give it to Claude again or work on it yourself.', confirm: 'Take over', danger: false }),
};

export function confirmDialog(dlg, model) {
  const view = model.entries.find((e) => e.view.id === dlg.cardId)?.view;
  if (!view) return null;
  const c = CONFIRM[dlg.action](view);
  return shell('confirm', c.title, h('form', { class: 'modal-body', 'data-form': 'confirm', 'data-card': view.id, 'data-confirm': dlg.action },
    h('p', { id: 'dlg-confirm-body' }, c.body),
    errorLine(dlg),
    h('div', { class: 'modal-foot' },
      h('button', { type: 'button', class: 'btn', 'data-action': 'close-dialog', autofocus: true }, 'Keep it'),
      h('button', { type: 'submit', class: `btn ${c.danger ? 'btn-danger' : 'btn-primary'}`, disabled: dlg.busy || null }, dlg.busy ? 'Working…' : c.confirm))),
  { describedBy: 'dlg-confirm-body' });
}

export function handOverDialog(dlg, model) {
  const view = model.entries.find((e) => e.view.id === dlg.cardId)?.view;
  if (!view) return null;
  const meId = model.me?.member?.id;
  const kind = dlg.kind_ ?? 'queue';
  const others = [...model.members.values()].filter((m) => m.member_id !== view.run?.owner?.member_id);
  return shell('handover', `Hand over ${view.key}`, h('form', { class: 'modal-body', 'data-form': 'handover', 'data-card': view.id },
    h('p', null, `Claude gets up to 90 seconds to write a final handover and push a snapshot, then stops. The card shows “Handing over · waiting for checkpoint” until it's done.`),
    h('fieldset', { class: 'field runner-pick' },
      h('legend', null, 'Who picks it up'),
      [['queue', 'Anyone’s Claude', 'The first runner with this repo claims it'], ['member', 'A teammate’s Claude', 'They confirm on their machine'], ['self', 'Me, by hand', 'It comes back to you in To do']]
        .map(([k, label, note]) => h('label', { key: k, class: `runner-opt${kind === k ? ' is-picked' : ''}` },
          h('input', { type: 'radio', name: 'kind', value: k, checked: kind === k, 'data-change': 'handover-kind' }),
          h('span', { class: 'runner-name' }, label), h('span', { class: 'runner-note' }, note)))),
    kind === 'member' ? field('ho-member', 'Teammate',
      h('select', { id: 'ho-member', name: 'member_id', class: 'input', required: true },
        others.map((m) => h('option', { key: m.member_id, value: m.member_id }, m.member_id === meId ? 'Me (my Claude)' : m.name)))) : null,
    errorLine(dlg),
    h('div', { class: 'modal-foot' },
      h('button', { type: 'button', class: 'btn', 'data-action': 'close-dialog' }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn btn-primary', disabled: dlg.busy || null }, dlg.busy ? 'Handing over…' : 'Hand over'))));
}

export function changesDialog(dlg, model) {
  const view = model.entries.find((e) => e.view.id === dlg.cardId)?.view;
  if (!view) return null;
  return shell('changes', `Request changes on ${view.key}`, h('form', { class: 'modal-body', 'data-form': 'changes', 'data-card': view.id },
    field('changes-comment', 'What should change',
      h('textarea', { id: 'changes-comment', name: 'comment', class: 'input', rows: 4, required: true, placeholder: 'The empty-body case should return 422, not 400.' }),
      'Claude starts a new run from the handover with this as its brief.'),
    errorLine(dlg),
    h('div', { class: 'modal-foot' },
      h('button', { type: 'button', class: 'btn', 'data-action': 'close-dialog' }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn btn-primary', disabled: dlg.busy || null }, dlg.busy ? 'Sending…' : 'Request changes'))));
}

export function newCardDialog(dlg) {
  const repos = dlg.repos ?? [];
  return shell('new', 'New card', h('form', { class: 'modal-body', 'data-form': 'new' },
    field('new-title', 'Title', h('input', { id: 'new-title', name: 'title', class: 'input', required: true, maxlength: '200', autocomplete: 'off', placeholder: 'Reject empty submit with a 400', autofocus: true })),
    field('new-body', 'Description', h('textarea', { id: 'new-body', name: 'body', class: 'input', rows: 4, placeholder: 'What and why. Paths you name here count towards overlap warnings.' })),
    field('new-acceptance', 'Done means', h('textarea', { id: 'new-acceptance', name: 'acceptance', class: 'input', rows: 2, placeholder: 'A regression test covers the empty-body case' })),
    h('div', { class: 'field-row' },
      field('new-repo', 'Repo', h('select', { id: 'new-repo', name: 'repo_id', class: 'input' },
        h('option', { value: '' }, 'No repo (a human task)'),
        repos.map((r) => h('option', { key: r.id, value: r.id }, r.short_name ?? r.canonical_url)))),
      field('new-ref', 'Base branch', h('input', { id: 'new-ref', name: 'base_ref', class: 'input num', placeholder: 'main', autocomplete: 'off', spellcheck: 'false' }))),
    h('div', { class: 'field-row' },
      field('new-labels', 'Labels', h('input', { id: 'new-labels', name: 'labels', class: 'input', placeholder: 'api, bug', autocomplete: 'off' }), 'Comma separated.'),
      field('new-budget', 'Budget (USD)', h('input', { id: 'new-budget', name: 'budget_usd', class: 'input num', type: 'number', min: '0.5', step: '0.5', placeholder: '5', inputmode: 'decimal' }))),
    errorLine(dlg),
    h('div', { class: 'modal-foot' },
      h('button', { type: 'button', class: 'btn', 'data-action': 'close-dialog' }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn btn-primary', disabled: dlg.busy || null }, dlg.busy ? 'Creating…' : 'Create card'))), { wide: true });
}

// The board's label registry (D91): members create and recolour, admins and
// owners rename and delete (with a confirm), viewers only read. Labels already
// on cards but not coloured are listed after the registry, ready to colour.
export function labelsDialog(dlg, model) {
  const role = model.me?.member?.role;
  const canWrite = !model.readOnly && role !== 'viewer';
  const canManage = role === 'owner' || role === 'admin';
  const cardLabels = model.entries.flatMap((e) => e.view.labels ?? []);
  const rows = managerRows(model.board?.labels, cardLabels);
  const colorSelect = (row) => h('select', {
    class: 'input input-sm', 'data-change': 'label-color', 'data-label': row.name, 'data-registered': row.registered ? '1' : null,
    'aria-label': `Colour of ${row.name}`, disabled: !canWrite || dlg.busy || null,
  },
  row.registered ? null : h('option', { value: '', selected: true }, 'No colour'),
  LABEL_COLORS.map((c) => h('option', { key: c, value: c, selected: row.color === c }, c)));
  const item = (row) => {
    const confirming = dlg.confirmDelete === row.name;
    const renaming = dlg.rename === row.name;
    return h('li', { key: `${row.registered ? 'r' : 'u'}:${row.name}`, class: 'labels-row' },
      h('span', { class: labelClass(row.name, row.color) }, row.name),
      colorSelect(row),
      canManage && row.registered && !confirming && !renaming ? [
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'label-rename-ask', 'data-label': row.name }, 'Rename'),
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet-danger', 'data-action': 'label-delete-ask', 'data-label': row.name }, 'Delete'),
      ] : null,
      renaming ? h('form', { class: 'labels-rename', 'data-form': 'label-rename', 'data-label': row.name },
        h('label', { class: 'sr-only', for: 'label-rename-input' }, `New name for ${row.name}`),
        h('input', { id: 'label-rename-input', name: 'name', class: 'input input-sm', value: row.name, maxlength: '50', required: true, autocomplete: 'off', autofocus: true }),
        h('button', { type: 'submit', class: 'btn btn-sm btn-primary', disabled: dlg.busy || null }, 'Rename'),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'label-cancel' }, 'Cancel'),
        h('p', { class: 'hint' }, 'Every card with this label gets the new name.')) : null,
      confirming ? h('div', { class: 'labels-confirm', role: 'alert' },
        h('span', null, `Delete ${row.name}?`),
        h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'label-delete', 'data-label': row.name, disabled: dlg.busy || null }, 'Remove the colour only'),
        h('button', { type: 'button', class: 'btn btn-sm btn-danger', 'data-action': 'label-delete', 'data-label': row.name, 'data-strip': '1', disabled: dlg.busy || null }, 'Also remove it from every card'),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'label-cancel' }, 'Keep it')) : null);
  };
  return shell('labels', 'Labels', h('div', { class: 'modal-body' },
    rows.length ? h('ul', { class: 'labels-list' }, rows.map(item)) : h('p', { class: 'muted' }, 'No labels yet.'),
    canWrite ? h('form', { class: 'labels-new', 'data-form': 'label-create' },
      field('label-new-name', 'New label', h('input', { id: 'label-new-name', name: 'name', class: 'input input-sm', maxlength: '50', required: true, autocomplete: 'off', placeholder: 'bug' })),
      field('label-new-color', 'Colour', h('select', { id: 'label-new-color', name: 'color', class: 'input input-sm' }, LABEL_COLORS.map((c) => h('option', { key: c, value: c }, c)))),
      h('button', { type: 'submit', class: 'btn btn-sm btn-primary', disabled: dlg.busy || null }, 'Add label')) : null,
    canWrite && !canManage ? h('p', { class: 'hint' }, 'Admins can rename or delete a label.') : null,
    errorLine(dlg)));
}

export function feedbackDialog(dlg, model) {
  const p = dlg.payload;
  const team = model.me?.org?.name ?? 'your team';
  const sent = dlg.result?.ok ? dlg.result : null;
  const viewer = model.readOnly || !model.me?.member;
  return shell('feedback', 'Send feedback', h('div', { class: 'modal-body' },
    h('p', { class: 'modal-lede' }, `Everyone on ${team}’s board can see this card.`),
    h('p', { class: 'hint' }, p.kind === 'idea' ? 'Idea' : 'Something’s off'),
    h('p', null, h('strong', { 'data-feedback': 'title' }, p.title)),
    h('pre', { class: 'feedback-body', 'data-feedback': 'body', tabindex: '0' }, p.body),
    sent ? h('p', { class: 'callout callout-ok', role: 'status' }, SENT_TEXT, ' ', h('a', { href: `/?board=${encodeURIComponent(sent.boardId)}#card=${encodeURIComponent(sent.cardId)}` }, 'Open the card')) : null,
    dlg.result && !dlg.result.ok ? h('p', { class: 'form-error', role: 'alert' }, dlg.result.text) : null,
    viewer ? h('p', { class: 'hint' }, VIEWER_TEXT) : null,
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', 'data-action': 'close-dialog' }, sent ? 'Close' : 'Cancel'),
      sent ? null : h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'feedback-send', disabled: dlg.busy || viewer || !dlg.armed || null }, 'Send to the Plexiform feedback board'))));
}

export function dialog(model) {
  const d = model.dialog;
  if (!d) return null;
  switch (d.kind) {
    case 'give': return giveDialog(d, model);
    case 'confirm': return confirmDialog(d, model);
    case 'handover': return handOverDialog(d, model);
    case 'changes': return changesDialog(d, model);
    case 'new': return newCardDialog(d, model);
    case 'palette': return paletteDialog(d, model);
    case 'labels': return labelsDialog(d, model);
    case 'feedback': return feedbackDialog(d, model);
    case 'boards': return boardsDialog(d, model);
    case 'new-board': case 'rename-board': case 'archive-board': return boardDialog(d);
    default: return null;
  }
}

function boardsDialog(d, model) {
  const boards = model.boards ?? [];
  const active = boards.filter((b) => !b.archived_at).length;
  return shell('boards', 'Boards', h('div', { class: 'modal-body board-manager' },
    h('p', { class: 'hint' }, 'Everyone on the team can see every board. Archived boards stay read-only until restored.'),
    h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'new-board' }, 'New board'),
    boards.map((b) => h('section', { key: b.id, class: 'board-manager-row', 'data-board': b.id },
      h('div', null, h('strong', null, b.name), h('span', { class: 'hint num' }, ` · ${b.key_prefix}${b.archived_at ? ' · Archived' : ''}`)),
      h('div', { class: 'board-manager-actions' },
        h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'switch-board', 'data-board': b.id }, 'Open'),
        b.archived_at ? h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'restore-board', 'data-board': b.id, disabled: d.busy || null }, 'Restore')
          : h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'rename-board', 'data-board': b.id }, 'Rename'),
        !b.archived_at ? h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'archive-board', 'data-board': b.id, disabled: active <= 1 || null, title: active <= 1 ? 'Keep at least one active board' : null }, 'Archive') : null))),
    errorLine(d)));
}

function boardDialog(d) {
  const archive = d.kind === 'archive-board';
  const create = d.kind === 'new-board';
  return shell(d.kind, archive ? `Archive ${d.name}?` : create ? 'New board' : 'Rename board',
    h('form', { class: 'modal-body', 'data-form': d.kind },
      archive ? h('p', null, 'The board becomes read-only and leaves the switcher. Its cards and history stay available, and an admin can restore it.')
        : field('board-name', 'Board name', h('input', { id: 'board-name', name: 'name', class: 'input', value: d.name ?? '', maxlength: '60', required: true, autofocus: true })),
      create ? field('board-prefix', 'Card key prefix (optional)', h('input', { id: 'board-prefix', name: 'key_prefix', class: 'input num', maxlength: '10', pattern: '[A-Z]{1,10}', placeholder: 'Chosen from the name', autocomplete: 'off' }), 'A unique prefix makes card keys unambiguous within your team.') : null,
      errorLine(d),
      h('div', { class: 'modal-foot' },
        h('button', { type: 'button', class: 'btn', 'data-action': 'close-dialog' }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary', disabled: d.busy || null, 'aria-busy': d.busy ? 'true' : null }, archive ? 'Archive board' : create ? 'Create board' : 'Save name'))));
}
