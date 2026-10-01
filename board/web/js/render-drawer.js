// Card detail drawer (§5.4 CardDetail): pill + reason, the primary action for
// the state, sponsor, asks/approvals (first answer wins), pinned hypothesis,
// budget, evidence, overlaps, and tabs for activity / handover / comments.
import { h } from './h.js';
import { icon } from './icons.js';
import { renderMarkdown, inline } from './markdown.js';
import { pill, budgetBar, cardActions, avatar, labelChips } from './render-board.js';
import { LABEL_COLORS, canArchive } from './labels.js';
import { formatAge, repoBranch, isHumanOwned, COLUMNS, COLUMN_LABEL, fmtUsd } from './view.js';
import { packetPanel, messagePanel } from './render-communication.js';
import { captureBadge } from './render-capture.js';
import { ownershipPanel } from './render-ownership.js';

const ago = (ms) => (ms == null ? 'never' : `${formatAge(ms)} ago`);
const add = (ms, e) => (ms == null ? null : ms + e);

export const FEED_LABEL = {
  dispatched: 'Assigned to AI', claimed: 'Runner claimed it', started: 'Agent started', blocked: 'Asked for help',
  answered: 'Answered', parked: 'Parked: no agent running', requeued_answered: 'Answered and requeued', suspended: 'Laptop went to sleep',
  recovered: 'Back online', unresponsive: 'Lost signal', orphaned: 'Orphaned', reconnecting: 'Board restarted',
  failed: 'Run failed', stopped: 'Stopped', released: 'Agent released it', retried: 'Retried', taken_over: 'Taken over',
  handing_over: 'Handing over', handed_over: 'Handed over', human_on_it: 'A person took it', in_review: 'Sent for review',
  changes_requested: 'Changes requested', merged: 'Merged', approved_done: 'Marked done', cancelled: 'Cancelled',
  declined: 'Declined on the runner', prep_failed: 'Worktree prep failed', requeued_claim_timeout: 'Requeued: runner never started',
  pr_closed_unmerged: 'PR closed without merging', progress: 'Progress', status: 'Status', comment: 'Comment',
  tool_start: 'Tool', tool_end: 'Tool finished', file: 'File', command: 'Command', error: 'Error', git: 'Git', plan: 'Plan',
  subagent: 'Subagent', message: 'Agent said', compacted: 'Context compacted', cost: 'Cost', session: 'Session', degraded: 'Degraded',
  salvage: 'Salvage', withdrawn: 'Request withdrawn', created: 'Created', evidence: 'Evidence', plan_declared: 'Plan declared',
  handover_frozen: 'Handover frozen',
};
const FEED_TONE = {
  failed: 'red', orphaned: 'red', stopped: 'red', error: 'red', blocked: 'amber', parked: 'amber', unresponsive: 'grey',
  suspended: 'grey', recovered: 'grey', started: 'green', in_review: 'purple', merged: 'done', approved_done: 'done',
  handing_over: 'violet', handed_over: 'violet', taken_over: 'violet',
};

function feedText(ev) {
  if (ev.text) return ev.text;
  const d = ev.data ?? {};
  if (ev.kind === 'failed') return [d.fail_kind, d.reason].filter(Boolean).join(': ');
  if (ev.kind === 'blocked') return d.kind ? `${d.kind}` : '';
  if (ev.kind === 'file') return `${d.op ?? ''} ${d.path ?? ''}`.trim();
  if (ev.kind === 'command') return `${d.cmd ?? ''}${d.exit != null ? ` · exit ${d.exit}` : ''}`;
  if (ev.kind === 'handed_over') return d.provenance ? String(d.provenance).replace(/_/g, ' ') : '';
  return '';
}

function feedItem(ev, elapsed) {
  const label = ev.data?.client_feedback_id ? 'Client feedback' : FEED_LABEL[ev.kind] ?? String(ev.kind).replace(/[_.]/g, ' ');
  const text = feedText(ev);
  return h('li', { key: ev.id, class: 'feed-item', 'data-tone': FEED_TONE[ev.kind] ?? null },
    h('span', { class: 'feed-mark', 'aria-hidden': 'true' }),
    h('div', { class: 'feed-body' },
      h('div', { class: 'feed-head' },
        h('span', { class: 'feed-kind' }, label),
        ev.actor_name ? h('span', { class: 'feed-actor' }, ev.actor_name) : null,
        ev.run_n != null ? h('span', { class: 'feed-run num' }, `r${ev.run_n}`) : null,
        h('span', { class: 'feed-age num' }, ago(add(ev.at_age_ms, elapsed)))),
      text ? h('p', { class: 'feed-text' }, inline(text)) : null));
}

function askBlock(ask, model) {
  const open = ask.state === 'open' || ask.state == null;
  const busy = model.busy?.has(`ask:${ask.id}`);
  const kind = ask.kind ?? 'question';
  const ai = model.detail?.data?.run?.ai_label ?? 'The agent';
  const head = { question: `Question from ${ai}`, clarify: `${ai} needs a detail`, decision: 'Decision needed', plan: 'Plan ready to approve', conflict: 'Merge conflict', loop: 'Looks stuck' }[kind] ?? 'Question';
  if (!open) {
    return h('li', { key: `ask-${ask.id}`, class: 'ask is-answered' },
      h('p', { class: 'ask-head' }, icon('check', 'icon-xs'), head),
      h('p', { class: 'ask-text' }, inline(ask.text ?? '')),
      h('p', { class: 'ask-answered' }, `Answered by ${ask.answered_by_name ?? 'a teammate'}`, ask.answer ? h('span', { class: 'ask-answer' }, ` · “${ask.answer}”`) : null));
  }
  const options = Array.isArray(ask.options) ? ask.options : [];
  return h('li', { key: `ask-${ask.id}`, class: 'ask', 'data-kind': kind },
    h('p', { class: 'ask-head' }, icon('hand', 'icon-xs'), head),
    kind === 'plan' ? h('div', { class: 'ask-plan md' }, renderMarkdown(ask.text ?? '')) : h('p', { class: 'ask-text' }, inline(ask.text ?? '')),
    h('form', { class: 'ask-form', 'data-form': 'answer', 'data-card': model.detail.cardId, 'data-ask': ask.id },
      options.length ? h('div', { class: 'ask-options', role: 'group', 'aria-label': 'Choose an answer' },
        options.map((o) => h('button', { type: 'submit', class: 'btn btn-sm', name: 'option', value: o, disabled: busy || null }, o))) : null,
      kind === 'plan'
        ? h('div', { class: 'ask-row' },
          h('button', { type: 'submit', class: 'btn btn-primary btn-sm', name: 'option', value: 'approve', disabled: busy || null }, 'Approve plan'),
          h('label', { class: 'sr-only', for: `ans-${ask.id}` }, 'Or suggest a change'),
          h('input', { id: `ans-${ask.id}`, name: 'answer', class: 'input input-sm', placeholder: 'Or suggest a change…', autocomplete: 'off' }),
          h('button', { type: 'submit', class: 'btn btn-sm', disabled: busy || null }, 'Send'))
        : kind === 'loop'
          ? h('div', { class: 'ask-row' },
            h('button', { type: 'submit', class: 'btn btn-primary btn-sm', name: 'option', value: 'continue', disabled: busy || null }, 'Let it continue'),
            h('button', { type: 'button', class: 'btn btn-sm btn-quiet-danger', 'data-action': 'stop', 'data-card': model.detail.cardId }, 'Stop the run'))
          : h('div', { class: 'ask-row' },
            h('label', { class: 'sr-only', for: `ans-${ask.id}` }, 'Your answer'),
            h('textarea', { id: `ans-${ask.id}`, name: 'answer', class: 'input', rows: 2, placeholder: options.length ? 'Or write an answer…' : 'Write your answer…', required: options.length ? null : true }),
            h('button', { type: 'submit', class: 'btn btn-primary btn-sm', disabled: busy || null }, 'Send answer'))));
}

function permissionBlock(pr, model) {
  const meId = model.me?.member?.id;
  const canAnswer = (pr.approvers ?? []).includes(meId);
  const busy = model.busy?.has(`pr:${pr.id}`);
  const names = (pr.approvers ?? []).map((id) => model.members.get(id)?.name).filter(Boolean);
  // parked requests (the run was parked) can still be answered: the answer requeues the card.
  if (pr.state !== 'open' && pr.state !== 'parked') {
    const verb = pr.state === 'allowed' ? 'Allowed' : pr.state === 'denied' ? 'Denied' : pr.state === 'cancelled' ? 'Cancelled' : 'Answered';
    return h('li', { key: `pr-${pr.id}`, class: 'ask is-answered', 'data-kind': 'permission' },
      h('p', { class: 'ask-head' }, icon(pr.state === 'denied' ? 'close' : 'check', 'icon-xs'), `${pr.tool ?? 'Tool'} request`),
      h('p', { class: 'ask-cmd' }, h('code', null, pr.input_summary ?? '')),
      h('p', { class: 'ask-answered' }, pr.answered_by_name ? `${verb} by ${pr.answered_by_name}` : verb));
  }
  return h('li', { key: `pr-${pr.id}`, class: 'ask', 'data-kind': 'permission' },
    h('p', { class: 'ask-head' }, icon('hand', 'icon-xs'), `Claude wants to run ${pr.tool ?? 'a tool'}`),
    h('p', { class: 'ask-cmd' }, h('code', null, pr.input_summary ?? '')),
    canAnswer
      ? h('div', { class: 'ask-row', role: 'group', 'aria-label': 'Answer this request' },
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'permission', 'data-pr': pr.id, 'data-decision': 'allow', 'data-scope': 'once', disabled: busy || null }, 'Allow once'),
        h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'permission', 'data-pr': pr.id, 'data-decision': 'allow', 'data-scope': 'run', disabled: busy || null }, 'Allow for this run'),
        h('button', { type: 'button', class: 'btn btn-sm btn-quiet-danger', 'data-action': 'permission', 'data-pr': pr.id, 'data-decision': 'deny', disabled: busy || null }, 'Deny'),
        h('span', { class: 'ask-note' }, 'First answer wins.'))
      : h('p', { class: 'ask-note' }, `Waiting for ${names.length ? names.join(', ') : 'an approver'}. You're not an approver on this run.`));
}

function syncStrip(detail, elapsed) {
  const ho = detail.data?.handover;
  if (!ho) return null;
  const ages = ho.ages ?? {};
  const snap = ho.doc?.layers?.snapshot;
  const unsynced = ho.doc?.unsynced_paths ?? [];
  const layer = (name, ms, extra) => h('span', { class: 'sync-layer', 'data-stale': ms == null || ms > 10 * 60 * 1000 ? '' : null },
    h('span', { class: 'sync-name' }, name), h('span', { class: 'num' }, extra ?? ago(add(ms, elapsed))));
  return h('div', { class: 'sync' },
    h('span', { class: 'sync-title' }, 'Last synced'),
    layer('Facts', ages.facts_ms),
    layer('Narrative', ages.narrative_ms, ho.doc?.layers?.narrative?.version ? `v${ho.doc.layers.narrative.version} · ${ago(add(ages.narrative_ms, elapsed))}` : null),
    layer('Code', ages.snapshot_ms, snap ? `${snap.sha ? String(snap.sha).slice(0, 7) : '?'} · ${ago(add(ages.snapshot_ms, elapsed))} · ${snap.status === 'held' ? `held: ${snap.reason ?? 'possible secret'}` : snap.status}` : 'none'),
    unsynced.length ? h('p', { class: 'sync-warn' }, icon('warn', 'icon-xs'), `${unsynced.length} file${unsynced.length > 1 ? 's' : ''} changed after the last snapshot and are not synced: `, h('code', null, unsynced.join(', '))) : null);
}

// The hub's markdown carries its own title and a "Last synced" line computed
// at send time; the drawer shows both live, so drop them from the body.
export function handoverBody(markdown) {
  return String(markdown ?? '').split('\n').filter((l, i) => !(i < 4 && (/^# Handover/.test(l) || /^Last synced:/.test(l)))).join('\n');
}

function tabs(active, counts) {
  const list = [['activity', 'Activity'], ['packet', 'Task context'], ['messages', 'Messages'], ['ownership', 'Coordination'], ['handover', 'Handover'], ['comments', `Comments${counts.comments ? ` ${counts.comments}` : ''}`], ['details', 'Details']];
  return h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Card sections' },
    list.map(([id, label]) => h('button', {
      type: 'button', role: 'tab', id: `tab-${id}`, class: 'tab', 'aria-selected': String(active === id), 'aria-controls': 'tabpanel',
      tabindex: active === id ? '0' : '-1', 'data-action': 'tab', 'data-tab': id,
    }, label)));
}

function tabPanel(tab, detail, model, elapsed) {
  const d = detail.data;
  if (tab === 'packet') return packetPanel(detail, model);
  if (tab === 'messages') return messagePanel(detail, model);
  if (tab === 'ownership') return ownershipPanel(detail, model, detail.ownership_elapsed_ms ?? 0);
  if (tab === 'handover') {
    if (!d.handover) return h('p', { class: 'muted' }, 'No handover yet. The agent can record progress and next steps during the run.');
    return h('div', null,
      syncStrip(detail, elapsed),
      h('div', { class: 'md handover' }, renderMarkdown(handoverBody(d.handover.markdown))),
      h('a', { class: 'btn btn-ghost btn-sm', href: `/api/cards/${encodeURIComponent(d.card.id)}/handover?format=md`, download: `${d.card.key}-handover.md` }, 'Download as Markdown'));
  }
  if (tab === 'comments') {
    const list = d.comments ?? [];
    const busy = model.busy?.has(`comment:${d.card.id}`);
    return h('div', null,
      list.length ? h('ul', { class: 'comments' }, list.map((c) => h('li', { key: c.id, class: `comment${c.source === 'agent' ? ' is-agent' : ''}` },
        h('div', { class: 'comment-head' },
          h('span', { class: 'comment-author' }, c.author_name ?? (c.source === 'agent' ? 'Claude' : 'Someone')),
          c.for_agent ? h('span', { class: 'label' }, '@claude') : null,
          h('span', { class: 'num muted' }, ago(add(c.created_age_ms, elapsed)))),
        h('p', { class: 'comment-body' }, c.body),
        c.for_agent ? h('p', { class: 'comment-seen' }, c.delivered_age_ms != null ? `Seen by Claude ${ago(add(c.delivered_age_ms, elapsed))}` : 'Not seen by Claude yet') : null)))
        : h('p', { class: 'muted' }, 'No comments yet.'),
      d.card.archived ? null : h('form', { class: 'composer', 'data-form': 'comment', 'data-card': d.card.id },
        h('label', { class: 'sr-only', for: 'comment-body' }, 'Comment'),
        h('textarea', { id: 'comment-body', name: 'body', class: 'input', rows: 3, required: true, placeholder: 'Write a comment…' }),
        h('div', { class: 'composer-row' },
          h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'for_agent' }), 'Send to Claude at its next step'),
          h('button', { type: 'submit', class: 'btn btn-primary btn-sm', disabled: busy || null }, 'Comment'))));
  }
  if (tab === 'details') {
    return h('dl', { class: 'details' },
      h('dt', null, 'Description'), h('dd', { class: 'prose' }, d.body ? d.body : h('span', { class: 'muted' }, 'None')),
      h('dt', null, 'Done means'), h('dd', { class: 'prose' }, d.acceptance ? d.acceptance : h('span', { class: 'muted' }, 'Not set')),
      d.run ? [h('dt', null, 'Run'), h('dd', { class: 'num' }, `r${d.card.fence ?? '?'} · ${d.run.id}`)] : null,
      d.run?.planned_paths?.length ? [h('dt', null, 'Planned paths'), h('dd', null, h('code', null, d.run.planned_paths.join('\n')))] : null,
      d.run?.touched_paths?.length ? [h('dt', null, 'Touched paths'), h('dd', null, h('code', null, d.run.touched_paths.join('\n')))] : null,
      (d.memories ?? []).length ? [h('dt', null, 'Handoff history'), h('dd', null, h('ul', { class: 'md-list' }, d.memories.map((m, i) => h('li', { key: m.id ?? i }, m.text ?? String(m)))))] : null);
  }
  const feed = d.feed ?? [];
  return feed.length
    // Feed ages arrive pre-advanced per event (each has its own receipt time).
    ? h('ol', { class: 'feed', 'aria-label': 'Activity, newest first' }, [...feed].reverse().map((ev) => feedItem(ev, 0)))
    : h('p', { class: 'muted' }, 'No activity yet.');
}

function whoBlock(view, face, model) {
  const rows = [];
  if (face.sponsor) rows.push(['Account', face.sponsor]);
  if (view.run) rows.push(['Runner', `${face.runner_line}${view.run.device_name ? ` on ${view.run.device_name}` : ''}`]);
  if (view.run?.dispatched_by) rows.push(['Given by', view.run.dispatched_by.name]);
  const assignees = (view.assignee_ids ?? []).map((id) => model.members.get(id)).filter(Boolean);
  return h('dl', { class: 'who' },
    rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
    h('dt', null, 'People'),
    h('dd', { class: 'who-people' }, assignees.length ? assignees.map((m) => h('span', { class: 'who-person' }, avatar(m), m.name)) : h('span', { class: 'muted' }, 'Unassigned')));
}

function evidenceBlock(view, detail) {
  const ev = view.evidence;
  const pr = view.pr;
  const list = detail.data?.evidence ?? [];
  if (!ev && !pr && !list.length) return null;
  return h('section', { class: 'dsec' },
    h('h3', { class: 'dsec-title' }, 'Evidence'),
    h('ul', { class: 'evidence' },
      pr ? h('li', null, icon('branch', 'icon-xs'), h('a', { href: pr.url, target: '_blank', rel: 'noopener noreferrer' }, `PR #${pr.number}`), h('span', { class: 'muted' }, ` · ${pr.state}`)) : null,
      ev?.tests ? h('li', { 'data-tone': ev.tests === 'pass' ? 'green' : ev.tests === 'fail' ? 'red' : null }, icon(ev.tests === 'pass' ? 'check' : ev.tests === 'fail' ? 'close' : 'dot', 'icon-xs'), ev.tests === 'pass' ? 'Tests pass' : ev.tests === 'fail' ? 'Tests fail' : 'No tests run') : null,
      ev?.verification ? h('li', null, icon(ev.verification === 'hub_verified' ? 'check' : 'person', 'icon-xs'), ev.verification === 'hub_verified' ? 'Verified by the board against GitHub' : 'Reported by the agent') : null,
      list.map((e, i) => h('li', { key: e.id ?? i }, icon('dot', 'icon-xs'), `${e.kind ?? 'evidence'}: ${e.summary ?? e.ref ?? ''}`))));
}

function overlapsBlock(overlaps, elapsed) {
  if (!overlaps?.length) return null;
  return h('section', { class: 'dsec', id: 'sec-overlaps' },
    h('h3', { class: 'dsec-title' }, 'Overlaps'),
    h('ul', { class: 'overlaps' }, overlaps.map((o) => h('li', { key: o.other_card_id, 'data-kind': o.kind },
      icon('warn', 'icon-xs'),
      h('div', null,
        h('p', null, h('button', { type: 'button', class: 'link', 'data-action': 'open', 'data-card': o.other_card_id }, o.other_key),
          o.other_owner ? ` (${o.other_owner}'s ${o.other_provider_label ?? 'agent'})` : '', o.kind === 'adjacent' ? ' has related work' : ' has overlapping work'),
        o.paths?.length ? h('p', { class: 'overlap-paths' }, o.paths.slice(0, 4).map((p) => h('code', null, p))) : null,
        h('p', { class: 'muted num' }, `${o.level ?? ''}${o.reasons?.length ? ` · ${o.reasons.join(', ')}` : ''}${o.age_ms != null ? ` · ${ago(add(o.age_ms, elapsed))}` : ''}`))))),
    h('p', { class: 'muted small' }, 'Overlaps never block. Talk to each other, or let one card finish first.'));
}

// A colour strip on the card face (D93): one of the label tokens, or none.
export function coverPicker(view, model) {
  const busy = model.busy?.has(`${view.id}:cover`);
  const opt = (token, label) => h('button', {
    key: token ?? 'none', type: 'button', class: `cover-opt${token ? ` cover-swatch-${token}` : ' cover-none'}`,
    'data-action': 'set-cover', 'data-card': view.id, 'data-cover': token ?? '', 'aria-pressed': (view.cover ?? null) === token ? 'true' : 'false',
    'aria-label': label, title: label, disabled: busy || null,
  }, token ? null : 'None');
  return h('section', { class: 'dsec' },
    h('h3', { class: 'dsec-title', id: 'cover-title' }, 'Cover'),
    h('div', { class: 'cover-picker', role: 'group', 'aria-labelledby': 'cover-title' },
      opt(null, 'No cover'), LABEL_COLORS.map((c) => opt(c, `Cover ${c}`))));
}

function archiveButton(view, model) {
  if (model.readOnly) return null;
  if (view.archived) {
    return h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-action': 'restore', 'data-card': view.id, disabled: model.busy?.has(`${view.id}:restore`) || null }, 'Restore');
  }
  if (!canArchive(view)) return null;
  return h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'archive', 'data-card': view.id, disabled: model.busy?.has(`${view.id}:archive`) || null }, 'Archive');
}

const HAND_OVER_FROM = new Set(['running', 'quiet', 'blocked']);
// On the card these open the drawer; inside it the requests are already on screen.
const OPENS_DRAWER = new Set(['watch', 'allow', 'deny', 'answer', 'approve_plan', 'resolve_conflict', 'continue']);

export function drawer(model) {
  const det = model.detail;
  if (!det) return null;
  const entry = model.entries.find((e) => e.view.id === det.cardId);
  const view = entry?.view ?? det.data?.card;
  const face = entry?.face;
  const elapsed = det.elapsed_ms ?? 0;
  const body = [];

  if (!view || !face) {
    body.push(h('div', { class: 'drawer-loading', role: 'status' }, det.error ? det.error : 'Loading card…'));
  } else {
    const rb = repoBranch(view);
    const archived = !!view.archived;
    const human = isHumanOwned(view) && !archived;
    const extra = [];
    if (!model.readOnly && HAND_OVER_FROM.has(view.run_state)) extra.push(h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'hand_over', 'data-card': view.id }, icon('swap', 'icon-lead'), 'Hand over…'));
    if (!model.readOnly && view.run_state === 'in_review') extra.push(h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'approve_done', 'data-card': view.id }, icon('check', 'icon-lead'), 'Mark done'));
    if (!model.readOnly && human) {
      extra.push(h('label', { class: 'move' }, h('span', null, 'Column'),
        h('select', { class: 'input input-sm', 'data-change': 'move', 'data-card': view.id },
          COLUMNS.map((c) => h('option', { value: c, selected: (view.column ?? 'todo') === c }, COLUMN_LABEL[c])))));
    }
    extra.push(archiveButton(view, model));
    const hypothesis = det.data?.handover?.doc?.sections?.hypothesis;
    const asks = det.data?.asks ?? [];
    const prs = det.data?.permission_requests ?? [];
    const openCount = asks.filter((a) => a.state === 'open' || a.state == null).length + prs.filter((p) => p.state === 'open' || p.state === 'parked').length;

    body.push(
      h('div', { class: 'drawer-status' },
        view.capture && !view.run ? captureBadge(view, elapsed) : pill(face, { size: 'lg' }),
        face.state === 'running' && face.disagree ? h('p', { class: 'muted small' }, 'Waiting for the board and this browser to agree the run is alive.') : null,
        archived ? h('p', { class: 'archived-note', role: 'note' }, `Archived${view.archived.by_name ? ` by ${view.archived.by_name}` : ''}${view.archived.at_age_ms != null ? ` ${ago(view.archived.at_age_ms + elapsed)}` : ''}. Restore it to change anything.`) : null,
        model.readOnly ? null : h('div', { class: 'drawer-actions' }, archived ? null : cardActions({ ...face, actions: face.actions.filter((a) => !OPENS_DRAWER.has(a)) }, view, model.busy), extra)),
      whoBlock(view, face, model),
      h('section', { class: 'dsec', 'aria-label': 'Planning' }, h('h3', { class: 'dsec-title' }, 'Planning'),
        h('p', { class: 'muted' }, `Start: ${view.start_date ?? 'Unscheduled'} · Due: ${view.due_date ?? 'Unscheduled'}`),
        h('p', { class: 'muted' }, `${view.depends_on?.length ?? 0} predecessors`),
        model.readOnly || archived ? null : h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'planning-edit', 'data-card': view.id }, 'Edit dates and dependencies')),
      view.capture ? h('section', { class: 'dsec', 'aria-label': 'AI work report' }, h('h3', { class: 'dsec-title' }, 'AI work report'),
        h('p', {}, 'This card follows activity reported by a local AI session. Your manual edits take priority.'),
        h('p', { class: 'muted small' }, 'A finished report requests review; it does not verify completion or start an AI run.')) : null,
      view.client_feedback ? h('section', { class: 'dsec', 'aria-label': 'Client feedback source' }, h('h3', { class: 'dsec-title' }, 'Client feedback'), h('p', {}, `Feedback from ${view.client_feedback.source_name}`), h('p', {}, `Intake authorized by ${view.client_feedback.intake_name}`), h('p', { class: 'muted small' }, 'Feedback intake creates a task for human triage.')) : null,
      (asks.length || prs.length) ? h('section', { class: 'dsec dsec-asks', id: 'sec-asks' },
        h('h3', { class: 'dsec-title' }, openCount ? `Needs you · ${openCount}` : 'Requests'),
        h('ul', { class: 'asks' }, prs.map((p) => permissionBlock(p, model)), asks.map((a) => askBlock(a, model)))) : null,
      hypothesis ? h('section', { class: 'dsec hypothesis' },
        h('h3', { class: 'dsec-title' }, 'Current hypothesis'),
        h('p', null, inline(hypothesis)),
        det.data?.handover?.ages?.narrative_ms != null ? h('p', { class: 'muted small' }, `Narrative synced ${ago(add(det.data.handover.ages.narrative_ms, elapsed))}`) : null) : null,
      face.budget ? h('section', { class: 'dsec' }, h('h3', { class: 'dsec-title' }, 'Budget'), budgetBar(face.budget),
        view.run ? h('p', { class: 'muted small' }, `Spent on ${face.sponsor ? face.sponsor.replace(/^Runs on [^·]+· /, '') : 'the owner\'s account'}. Soft by one API call.`) : null) : null,
      model.readOnly || archived ? null : coverPicker(view, model),
      evidenceBlock(view, det),
      overlapsBlock(det.data?.overlaps ?? view.overlaps, elapsed),
      det.data ? h('section', { class: 'dsec dsec-tabs' },
        tabs(det.tab, { comments: det.data.comments?.length ?? 0 }),
        h('div', { class: 'tabpanel', id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${det.tab}`, tabindex: '0' },
          tabPanel(det.tab, det, model, elapsed))) : h('p', { class: 'muted', role: 'status' }, det.error ?? 'Loading details…'));

    return h('dialog', { class: 'drawer', 'data-dialog': 'drawer', 'aria-labelledby': 'drawer-title' },
      h('div', { class: 'drawer-inner' },
        h('header', { class: 'drawer-head' },
          h('div', { class: 'drawer-meta' },
            h('span', { class: 'card-key num' }, view.key),
            rb ? h('span', { class: 'card-repo num' }, icon('branch', 'icon-xs'), rb) : null,
            view.budget?.cap_usd != null && !face.budget ? h('span', { class: 'num muted' }, fmtUsd(view.budget.cap_usd)) : null),
          h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'data-action': 'close-drawer', 'aria-label': 'Close card' }, icon('close'))),
        h('h2', { class: 'drawer-title', id: 'drawer-title' }, view.title),
        labelChips(view, model),
        body));
  }
  return h('dialog', { class: 'drawer', 'data-dialog': 'drawer', 'aria-label': 'Card' },
    h('div', { class: 'drawer-inner' },
      h('header', { class: 'drawer-head' }, h('span', null), h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'data-action': 'close-drawer', 'aria-label': 'Close card' }, icon('close'))),
      body));
}
