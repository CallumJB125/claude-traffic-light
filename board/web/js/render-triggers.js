// Triggers panel on the Integrations page (hub/triggers.js, docs/event-triggers.md):
// a team's "when X happens, do Y" rules as plain sentences, each one's
// off / dry run / on switch, a form for admins, and the last firings.
// Pure: (state, vm) → vnode. Text only; the hub sends ids and short codes.
import { h } from './h.js';

const EVENT_LABEL = {
  'github.pr.opened': 'A pull request is opened (GitHub)',
  'github.pr.review_requested': 'A review is requested on a pull request (GitHub)',
  'github.checks.failed': 'Checks fail on a pull request (GitHub)',
  'card.moved_to_review': 'A card moves to Review',
  'sentry.issue.new': 'Sentry reports a new issue',
};
const ACTION_LABEL = {
  create_card: 'Create a card',
  add_comment: 'Comment on its card',
  request_ai_review: 'Ask the AI to review it and comment',
  notify_member: 'Notify a teammate',
  label_card: 'Label its card',
};
const MODE_TEXT = { off: 'Off', dry_run: 'Dry run: logging what it would do', on: 'On' };
const RESULT_TEXT = { done: 'Done', would: 'Would have done it (dry run)', skipped: 'Skipped', failed: 'Failed', rate_limited: 'Skipped: over its hourly limit' };
const DETAIL_TEXT = {
  no_card: 'no card for it', card_archived: 'its card is archived', board_unavailable: 'that board is gone or archived',
  ai_review_off: 'AI review is off on that board', no_run: 'the card has no run to review', run_in_progress: 'the run is still going',
  already_reviewed: 'that run already has a review', member_unavailable: 'that person left the team', already_labelled: 'the card already has that label',
  actor_unavailable: 'the admin who enabled it is no longer an admin', not_applicable: 'it no longer applied',
};
const NEEDS = { create_card: 'board', notify_member: 'member', add_comment: 'text', label_card: 'label' };

/** The request body the new-trigger form describes; only the selected action's parameter is sent. */
export function triggerBody(form) {
  const v = (name) => String(form.elements[name]?.value ?? '').trim();
  const action = v('action');
  const filters = Object.fromEntries(['repo', 'branch', 'label'].map((k) => [k, v(`filter_${k}`)]).filter(([, x]) => x));
  const params = {
    create_card: { board_id: v('board_id') }, add_comment: { text: v('text') }, notify_member: { member_id: v('member_id') }, label_card: { label: v('label') },
  }[action] ?? {};
  const rate = Number(v('max_per_hour'));
  return { event: v('event'), action, filters, params, ...(Number.isSafeInteger(rate) && rate > 0 ? { max_per_hour: rate } : {}) };
}

function modeControls(t, vm, s) {
  const busy = vm.busy.has(`trigger:${t.id}`);
  const ready = t.can_enable_at && vm.nowMs >= Date.parse(t.can_enable_at);
  const btn = (action, text, extra = {}) => h('button', { type: 'button', class: 'btn btn-sm', 'data-action': action, 'data-trigger': t.id, disabled: busy || null, ...extra }, text);
  if (s.confirmOn === t.id) {
    return h('span', { class: 'integ-confirm' },
      h('span', { class: 'small' }, 'From now on it acts for real. It still never starts an AI that edits code, moves a card or pushes.'),
      btn('trigger-on', 'Enable for real', { class: 'btn btn-sm btn-primary' }),
      btn('trigger-on-cancel', 'Not yet', { class: 'btn btn-sm btn-ghost' }));
  }
  return h('span', { class: 'trigger-controls' },
    t.mode === 'off' ? btn('trigger-dry-run', 'Start dry run') : null,
    t.mode === 'dry_run' ? (ready
      ? btn('trigger-on-ask', 'Enable for real', { class: 'btn btn-sm btn-primary' })
      : h('span', { class: 'muted small' }, `Enable for real from ${new Date(t.can_enable_at).toLocaleDateString()}`)) : null,
    t.mode !== 'off' ? btn('trigger-off', 'Turn off') : null,
    btn('trigger-delete', 'Delete', { class: 'btn btn-sm btn-quiet-danger' }));
}

function ruleRow(t, vm, s) {
  return h('li', { key: t.id, class: 'trigger-rule', 'data-mode': t.mode },
    h('p', { class: 'trigger-sentence' }, t.sentence),
    h('p', { class: 'small' }, h('span', { class: 'integ-mode', 'data-mode': t.mode }, MODE_TEXT[t.mode] ?? t.mode),
      h('span', { class: 'muted' }, ` · at most ${t.max_per_hour} an hour`)),
    s.data.can_edit ? modeControls(t, vm, s) : null);
}

function newForm(s, vm, members) {
  const boards = (vm.boards ?? []).filter((b) => !b.archived_at);
  const people = [...(members?.values?.() ?? [])];
  const busy = vm.busy.has('trigger:new');
  const field = (label, control, need) => h('label', { class: 'field', 'data-needs': need ?? null }, h('span', null, label), control);
  const text = (name, extra = {}) => h('input', { class: 'input input-sm', name, type: 'text', autocomplete: 'off', spellcheck: 'false', ...extra });
  return h('form', { class: 'trigger-new', 'data-form': 'trigger-new' },
    h('h4', null, 'New trigger'),
    field('When', h('select', { class: 'input input-sm', name: 'event' }, (s.data.events ?? []).map((e) => h('option', { key: e, value: e }, EVENT_LABEL[e] ?? e)))),
    field('In repository (optional)', text('filter_repo', { placeholder: 'acme/api', maxlength: 201 })),
    field('On branches matching (optional)', text('filter_branch', { placeholder: 'release/*', maxlength: 100 })),
    field('With label (optional)', text('filter_label', { maxlength: 50 })),
    field('Do', h('select', { class: 'input input-sm', name: 'action' }, (s.data.actions ?? []).map((a) => h('option', { key: a, value: a }, ACTION_LABEL[a] ?? a)))),
    field('Card goes to', h('select', { class: 'input input-sm', name: 'board_id' }, boards.map((b) => h('option', { key: b.id, value: b.id }, b.name))), NEEDS.create_card),
    field('Comment', h('textarea', { class: 'input input-sm', name: 'text', rows: 2, maxlength: 1000 }), NEEDS.add_comment),
    field('Teammate', h('select', { class: 'input input-sm', name: 'member_id' }, people.map((p) => h('option', { key: p.member_id, value: p.member_id }, p.name ?? p.login ?? 'A teammate'))), NEEDS.notify_member),
    field('Label', text('label', { maxlength: 50 }), NEEDS.label_card),
    field('At most this many an hour', h('input', { class: 'input input-sm', name: 'max_per_hour', type: 'number', min: 1, max: s.data.max_per_hour_max ?? 60, value: 10 })),
    h('p', { class: 'muted small' }, 'Only the field for the chosen action is used. A new trigger starts off.'),
    s.formError ? h('p', { role: 'alert', class: 'small' }, s.formError) : null,
    h('button', { type: 'submit', class: 'btn btn-sm btn-primary', disabled: busy || null, 'aria-busy': busy ? 'true' : null }, 'Add trigger'));
}

function activity(firings, rules) {
  if (!firings) return h('p', { class: 'muted small', role: 'status' }, 'Loading…');
  if (!firings.length) return h('p', { class: 'muted small' }, 'Nothing has fired yet. Dry runs show up here too.');
  const byId = new Map(rules.map((t) => [t.id, t]));
  return h('ol', { class: 'integ-activity trigger-activity' }, firings.map((f) => h('li', { key: f.id },
    h('span', { class: 'integ-act-what' }, EVENT_LABEL[f.event] ?? f.event),
    f.subject ? h('span', { class: 'integ-act-ref num' }, f.subject) : null,
    h('span', { class: 'muted small' }, ` → ${ACTION_LABEL[f.action] ?? f.action}`),
    h('span', { class: 'integ-act-decision', 'data-decision': f.result }, RESULT_TEXT[f.result] ?? f.result,
      (f.result === 'skipped' || f.result === 'failed') && f.detail ? `: ${DETAIL_TEXT[f.detail] ?? f.detail}` : null),
    byId.has(f.trigger_id) ? null : h('span', { class: 'muted small' }, ' (deleted trigger)'),
    f.card_id ? h('button', { type: 'button', class: 'link small', 'data-action': 'open', 'data-card': f.card_id }, 'Open card') : null,
    h('time', { class: 'integ-act-at muted', datetime: f.at }, new Date(f.at).toLocaleString()))));
}

export function triggersPanel(s, vm, members) {
  const section = (...kids) => h('section', { class: 'integ-group', 'aria-labelledby': 'integ-triggers' }, h('h2', { id: 'integ-triggers' }, 'Triggers'), ...kids);
  if (!s || s.status === 'loading' && !s.data) return section(h('p', { class: 'muted', role: 'status' }, 'Loading triggers…'));
  if (!s.data) return section(h('p', { class: 'muted' }, s.error ?? 'Couldn’t load triggers.'));
  const rules = s.data.triggers ?? [];
  const days = s.data.dry_run_days ?? 7;
  return section(
    h('p', { class: 'muted' }, `When something happens, do one small thing. A trigger never starts an AI that edits code, never moves a card and never pushes. Each one starts off; run it as a dry run for ${days} days, then enable it for real.`),
    rules.length ? h('ul', { class: 'trigger-rules' }, rules.map((t) => ruleRow(t, vm, s))) : h('p', { class: 'muted' }, 'No triggers yet.'),
    s.data.can_edit ? newForm(s, vm, members) : h('p', { class: 'muted small' }, 'A team admin can add triggers.'),
    h('div', { class: 'integ-card-actions' },
      h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'trigger-activity', 'aria-expanded': s.showActivity ? 'true' : 'false' }, s.showActivity ? 'Hide trigger activity' : 'Trigger activity')),
    s.showActivity ? h('section', { class: 'integ-section', 'aria-label': 'Trigger activity' }, h('h4', null, 'Last 100 firings'), activity(s.activity, rules)) : null);
}
