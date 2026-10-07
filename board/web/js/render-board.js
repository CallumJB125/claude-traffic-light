// Board screen: top bar, connection banner, alerts strip, four columns, cards.
// Pure: (model) → vnode. Interactions are data-action attributes handled by
// one delegated listener in app.js.
import { h } from './h.js';
import { icon, pixelClaude, PILL_ICON, ALERT_ICON } from './icons.js';
import { inline } from './markdown.js';
import { VIEWS } from './views.js';
import { filterBar } from './render-filters.js';
import { THEMES, BACKGROUNDS } from './themes.js';
import { cardChips } from './chips.js';
import { costText, boardCostRollup, dailyCapText } from './cost.js';
import { labelColor, labelClass, VIA_LABEL } from './labels.js';
import { PILLS } from '../../shared/cardface.js';
import { captureBadge } from './render-capture.js';
import {
  COLUMNS, COLUMN_LABEL, ACTION_LABEL, groupColumns, isHumanOwned, repoBranch, clock, initials, hueOf,
  primaryAction, boardLamps, stripGlyph, isObservedWork, cardWorkPhase, ADVANCED_ACTIONS, formatAge,
} from './view.js';

export function avatar(member, { size = 'sm', dim = false } = {}) {
  if (!member) return null;
  const name = member.name ?? member.login ?? '?';
  return h('span', {
    class: `avatar avatar-${size}${dim ? ' avatar-dim' : ''}`,
    title: name,
    style: { '--hue': String(hueOf(member.login ?? name)) },
  },
  h('span', { class: 'avatar-initials', 'aria-hidden': 'true' }, initials(name)),
  member.avatar_url ? h('img', { src: member.avatar_url, alt: '', loading: 'lazy', 'data-avatar': '' }) : null);
}

export function avatarStack(members, max = 3) {
  const list = members.filter(Boolean);
  if (!list.length) return null;
  const shown = list.slice(0, max);
  return h('span', { class: 'avatars', 'aria-label': list.map((m) => m.name ?? m.login).join(', ') },
    shown.map((m) => avatar(m)),
    list.length > max ? h('span', { class: 'avatar avatar-sm avatar-more' }, `+${list.length - max}`) : null);
}

export function pill(face, { size = 'sm' } = {}) {
  if (!face.label) return null;
  // Pill labels are unique per PILLS key, and cardFace may show a different
  // key than run_state (running → "No signal"), so go by the label.
  const shownKey = Object.keys(PILLS).find((k) => PILLS[k].label === face.label) ?? face.state;
  return h('span', {
    // Keyed by label: a state change re-creates the pill, so it fades in once
    // (the board's one authored moment); age ticks only patch the reason text.
    key: `pill-${shownKey}`,
    class: `pill pill-${size}`,
    'data-tone': face.tone,
    'data-green': face.green ? '' : null,
  },
  h('span', { class: 'pill-lamp' }, icon(PILL_ICON[shownKey] ?? 'dot')),
  h('span', { class: 'pill-text' },
    h('span', { class: 'pill-label' }, face.label),
    face.reason ? h('span', { class: 'pill-reason' }, inline(face.reason)) : null));
}

export function budgetBar(budget) {
  if (!budget) return null;
  const pct = Math.round(budget.ratio * 100);
  return h('div', { class: 'budget', 'data-level': budget.ratio >= 1 ? 'over' : budget.ratio >= 0.8 ? 'high' : 'ok' },
    h('span', { class: 'budget-track', role: 'img', 'aria-label': `Budget ${budget.text} (${pct}%)` },
      h('span', { class: 'budget-fill', style: { '--ratio': String(budget.ratio) } })),
    h('span', { class: 'budget-text num' }, budget.text));
}

// One-click answer on the card face when the viewer is an approver of the
// open request (first answer wins on the hub); otherwise open the drawer.
function permissionButton(id, view, { primary, busyKeys }) {
  const prId = view.ask?.permission_request_id;
  if (!prId || !view.viewer_can_approve) return id === 'allow' ? actionButton('allow_review', view, { primary }) : null;
  const allow = id === 'allow';
  const busy = busyKeys?.has(`pr:${prId}`);
  return h('button', {
    type: 'button',
    class: `btn btn-sm${allow ? ' btn-primary' : ' btn-quiet-danger'}`,
    'data-action': 'permission', 'data-pr': prId, 'data-decision': allow ? 'allow' : 'deny', 'data-scope': allow ? 'once' : null,
    'data-card': view.id, disabled: busy || null, 'aria-busy': busy ? 'true' : null,
  }, allow ? 'Allow' : 'Deny');
}

function actionButton(id, view, { primary: wantPrimary = false, busy = false, busyKeys = null } = {}) {
  if (id === 'allow' || id === 'deny') return permissionButton(id, view, { primary: wantPrimary, busyKeys });
  let primary = wantPrimary;
  const label = id === 'take_over_with_claude' && view.handover_hold === true ? 'Choose next AI' : ACTION_LABEL[id === 'allow_review' ? 'allow' : id];
  if (!label) return null;
  if (id === 'open_pr') {
    return view.pr?.url
      ? h('a', { class: `btn btn-sm${primary ? ' btn-primary' : ''}`, href: view.pr.url, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external', 'icon-trail'))
      : null;
  }
  const give = id === 'give_to_claude' || id === 'take_over_with_claude';
  const destructive = id === 'stop' || id === 'cancel';
  if (destructive) primary = false;
  return h('button', {
    type: 'button',
    class: `btn btn-sm${give ? ' btn-claude' : primary ? ' btn-primary' : ''}${destructive ? ' btn-quiet-danger' : ''}`,
    'data-action': id === 'allow_review' ? 'allow' : id,
    'data-card': view.id,
    disabled: busy || null,
    'aria-busy': busy ? 'true' : null,
  }, id === 'watch' ? icon('eye', 'icon-lead') : null, label);
}

export function cardActions(face, view, busy) {
  if (isObservedWork(view)) return h('div', { class: 'card-actions' },
    h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'open', 'data-card': view.id }, 'Show details'));
  const primary = primaryAction(face);
  const buttons = face.actions.map((a) => actionButton(a, view, { primary: a === primary, busy: busy?.has(`${view.id}:${a}`), busyKeys: busy })).filter(Boolean);
  return buttons.length ? h('div', { class: 'card-actions' }, buttons) : null;
}

// Proof, handover age and cost as one row of small chips (chips.js decides which).
function chipRow(chips) {
  if (!chips.length) return null;
  return h('div', { class: 'card-chips' }, chips.map((c) => {
    const body = [
      c.icon ? icon(c.icon, 'icon-xs') : null,
      c.ratio != null ? h('span', { class: 'cchip-meter', 'aria-hidden': 'true' }, h('span', { class: 'cchip-fill', style: { '--ratio': String(c.ratio) } })) : null,
      h('span', { class: 'cchip-text num' }, c.text),
    ];
    const props = { key: c.id, class: `cchip cchip-${c.id}`, 'data-tone': c.tone, title: c.title };
    return c.href
      ? h('a', { ...props, href: c.href, target: '_blank', rel: 'noopener noreferrer' }, body)
      : h('span', props, body);
  }));
}

/** A card's labels as chips coloured from the board's registry (CSS classes only). */
export function labelChips(view, model, labels = view.labels ?? []) {
  if (!labels.length) return null;
  return h('div', { class: 'card-labels' }, labels.map((l) => {
    const i = (view.labels ?? []).indexOf(l);
    return h('span', { class: labelClass(l, labelColor(l, i, view, model.labelColors)) }, l);
  }));
}

export function card({ view, face, elapsed_ms = 0 }, model) {
  const members = model.members;
  const assignees = (view.assignee_ids ?? []).map((id) => members.get(id));
  const owner = view.run?.owner ? members.get(view.run.owner.member_id) ?? view.run.owner : null;
  const people = [...new Map([...assignees, owner].filter(Boolean).map((m) => [m.member_id ?? m.name, m])).values()];
  const rb = repoBranch(view);
  const human = isHumanOwned(view);
  const req = view.ask?.count > 1 ? `${view.ask.count} req` : view.ask?.count === 1 && view.run_state === 'blocked' ? '1 req' : null;
  const sponsor = human ? (view.target ? face.sponsor : null) : face.sponsor;
  const selected = model.openCardId === view.id;
  // An integration's card (via:<provider>, D42) shows as a badge, like agent-suggested.
  const via = (view.labels ?? []).find((l) => VIA_LABEL.test(l))?.slice(4) ?? null;
  const labels = (view.labels ?? []).filter((l) => !VIA_LABEL.test(l));
  const archived = !!view.archived;
  const dragging = model.drag?.mode === 'pointer' && model.drag.ids.includes(view.id);
  const chips = cardChips(view, face, { elapsed_ms });
  const pending = view.pending === true;
  const observed = isObservedWork(view);
  const workPhase = cardWorkPhase(view, face);
  const draggable = human && !model.readOnly && !pending && !archived;

  return h('article', {
    key: view.id,
    class: `card${archived ? ' is-archived' : ''}${pending ? ' is-pending' : ''}${selected ? ' is-open' : ''}${human ? ' is-human' : ''}${dragging ? ' is-dragging' : ''}${model.kbd?.ids.includes(view.id) ? ' is-lifted' : ''}`,
    'data-tone': face.tone,
    'data-state': face.state,
    'data-card-id': view.id,
    'data-draggable': draggable ? 'true' : null,
    'aria-labelledby': `t-${view.id}`,
    'aria-busy': pending ? 'true' : null,
  },
  h('div', { class: 'card-top' },
    h('span', { class: 'card-key num' }, view.key),
    archived ? h('span', { class: 'label archived-badge', title: view.archived.by_name ? `Archived by ${view.archived.by_name}` : 'Archived' }, 'Archived') : null,
    view.agent_suggested ? h('span', { class: 'label agent-suggested', title: 'Created by an agent; a person must assign it to an AI' }, 'agent-suggested') : null,
    via ? h('span', { class: 'label via-integration', title: `Created by the ${via} integration; a person must assign it to an AI` }, `via ${via}`) : null,
    rb ? h('span', { class: 'card-repo num', title: view.base_ref ? `base ${view.base_ref}` : null }, icon('branch', 'icon-xs'), rb) : null,
    avatarStack(people)),
  h('h3', { class: 'card-title', id: `t-${view.id}` },
    h('button', { type: 'button', class: 'card-open', 'data-action': pending ? null : 'open', 'data-card': view.id, disabled: pending || null, 'aria-describedby': draggable ? 'dnd-help' : null }, view.title)),
  observed ? captureBadge(view, elapsed_ms, model.conn?.status === 'lost') : pill(chips.some((c) => c.id === 'proof') ? { ...face, reason: null } : face),
  workPhase ? h('p', { class: 'card-work-phase' }, workPhase) : null,
  observed ? h('p', { class: 'card-foot' }, 'Existing session · details only. Stop it in your AI tool before starting elsewhere.') : null,
  (sponsor || req || face.activity_line) ? h('div', { class: 'card-meta' },
    sponsor ? h('span', { class: 'card-sponsor' }, sponsor) : null,
    face.activity_line && face.state !== 'done' ? h('span', { class: 'card-activity' }, face.activity_line) : null,
    req ? h('span', { class: 'card-req num' }, req) : null) : null,
  face.badge ? h('span', { class: 'chip chip-secondary' }, face.badge) : null,
  face.overlap_chip ? h('button', { type: 'button', class: 'chip chip-overlap', 'data-action': 'open', 'data-card': view.id, 'data-section': 'overlaps' },
    icon('warn', 'icon-xs'), stripGlyph(face.overlap_chip)) : null,
  labelChips(view, model, labels),
  chipRow(chips),
  archived ? archivedFoot(view, model) : model.readOnly || pending ? null : cardActions({ ...face, actions: face.stalled ? face.actions : face.actions.filter((a) => !ADVANCED_ACTIONS.has(a)) }, view, model.busy),
  human && !observed && !pending && !archived && face.state === 'todo' && !view.target ? h('p', { class: 'card-foot' }, view.repo ? 'on your account' : 'no repo yet · add one to tackle it with AI') : null);
}

// An archived card is read-only (D94): its one action is Restore.
function archivedFoot(view, model) {
  if (model.readOnly) return null;
  const busy = model.busy?.has(`${view.id}:restore`);
  return h('div', { class: 'card-actions' },
    h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'restore', 'data-card': view.id, disabled: busy || null, 'aria-busy': busy ? 'true' : null }, 'Restore'));
}

export function column(id, entries, model) {
  const count = entries.length;
  const needs = entries.filter((e) => e.face.tone === 'amber' || e.face.tone === 'red').length;
  const isDone = id === 'done';
  const shown = isDone && !model.showAllDone ? entries.slice(0, 6) : entries;
  const over = model.drag?.over === id;
  return h('section', { key: id, class: `column column-${id}${over && model.drag.ok ? ' is-drop' : ''}${over && !model.drag.ok && model.drag.plan.skipped.length ? ' is-drop-none' : ''}`, 'data-column': id, 'aria-labelledby': `col-${id}` },
    h('header', { class: 'column-head' },
      h('h2', { id: `col-${id}` }, COLUMN_LABEL[id]),
      h('span', { class: 'column-count num', 'aria-label': `${count} cards` }, String(count)),
      needs ? h('span', { class: 'column-needs', title: `${needs} need attention` }, icon('dot', 'icon-xs'), String(needs)) : null,
      id === 'todo' && !model.readOnly ? h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'data-action': 'new-card', 'aria-label': 'New card' }, icon('plus')) : null),
    h('div', { class: 'column-body', 'data-drop': id },
      columnCards(id, shown, model),
      id === 'todo' && !model.readOnly ? quickAddRow(model.quickAdd) : null,
      isDone && entries.length > 6 ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm column-more', 'data-action': 'toggle-done' },
        model.showAllDone ? 'Show fewer' : `Show ${entries.length - 6} more`) : null));
}

// Runs the hub still holds in progress while nothing works on them. They are
// never drawn among live cards: each says why it stalled and offers a way out.
export function stalledLane(entries, model) {
  if (!entries.length) return null;
  return h('section', { class: 'stalled-lane', 'data-column': 'stalled', 'aria-labelledby': 'col-stalled' },
    h('header', { class: 'column-head' },
      h('h2', { id: 'col-stalled' }, COLUMN_LABEL.stalled),
      h('span', { class: 'column-count num', 'aria-label': `${entries.length} cards` }, String(entries.length)),
      h('span', { class: 'stalled-hint' }, 'Not running. Resume, hand over to another AI, or stop.')),
    h('div', { class: 'stalled-body' }, entries.map((e) => card(e, model))));
}

// Reported sessions with no recent report. They keep a card for context but
// never sit among the work that is actually moving.
export function idleLane(entries, model) {
  if (!entries.length) return null;
  return h('section', { class: 'stalled-lane idle-lane', 'data-column': 'idle', 'aria-labelledby': 'col-idle' },
    h('header', { class: 'column-head' },
      h('h2', { id: 'col-idle' }, COLUMN_LABEL.idle),
      h('span', { class: 'column-count num', 'aria-label': `${entries.length} cards` }, String(entries.length)),
      h('span', { class: 'stalled-hint' }, 'No report in the last 90 seconds. Hidden after 24 hours; use Show archived to see them.')),
    h('div', { class: 'stalled-body' }, entries.map((e) => card(e, model))));
}

// The drop indicator is an empty keyed node between cards: its line is a
// pseudo-element, so showing it never shifts the layout under the pointer.
function columnCards(id, shown, model) {
  const slot = model.drag?.ok && model.drag.over === id ? model.drag : null;
  const line = h('div', { key: 'drop-line', class: 'drop-line', 'aria-hidden': 'true' });
  if (!shown.length) return [h('p', { key: 'empty', class: 'column-empty' }, EMPTY[id]), slot ? line : null];
  if (!slot) return shown.map((e) => card(e, model));
  const at = shown.findIndex((e) => e.view.id === slot.before);
  const cards = shown.map((e) => card(e, model));
  cards.splice(at < 0 ? cards.length : at, 0, line);
  return cards;
}

// "+ Add a card" at the foot of To do. Title only: the New card dialog stays
// for everything else. Text lives in the textarea (not in state) so a render
// never touches what is being typed; `seed` only refills it after a failure.
function quickAddRow(qa) {
  if (!qa?.open) {
    return h('button', { key: 'quick-add', type: 'button', class: 'btn btn-ghost quickadd-open', 'data-action': 'quick-add', 'aria-keyshortcuts': 'n' },
      icon('plus', 'icon-lead'), 'Add a card');
  }
  return h('div', { key: 'quick-add', class: 'quickadd' },
    h('textarea', {
      class: 'input quickadd-input', 'data-input': 'quickadd', rows: 1, maxlength: '4000', value: qa.seed ?? '',
      placeholder: 'Card title…', 'aria-label': 'New card title', 'aria-describedby': 'quickadd-hint', autocomplete: 'off',
    }),
    qa.confirm ? h('div', { class: 'quickadd-confirm', role: 'alert' },
      h('span', null, `Create ${qa.confirm.length} cards from those lines?`),
      h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-action': 'quick-add-confirm' }, `Create ${qa.confirm.length}`),
      h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'quick-add-decline' }, 'Not yet')) : null,
    h('div', { class: 'quickadd-foot' },
      h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-action': 'quick-add-submit' }, 'Add card'),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-icon', 'data-action': 'quick-add-cancel', 'aria-label': 'Cancel' }, icon('close')),
      h('span', { id: 'quickadd-hint', class: 'quickadd-hint' }, 'Enter adds · Shift+Enter keeps adding · Esc cancels')));
}

const EMPTY = {
  todo: 'Nothing waiting. New cards land here.',
  in_progress: 'No one is working on anything. Tackle a card with AI to start.',
  in_review: 'Nothing to review.',
  done: 'Finished work shows up here.',
};

// Local mode only: the board works alone, and a team is where it is shared. The app's
// Team page does the signing in (this page has no way to ask for it), so this points there.
export function localCard(model) {
  if (!model.localCard || model.view !== 'board') return null;
  return h('section', { class: 'localcard', 'aria-labelledby': 'localcard-title' },
    h('div', { class: 'localcard-text' },
      h('h2', { id: 'localcard-title', class: 'localcard-title' }, 'You’re on your local board'),
      h('p', { class: 'localcard-body muted small' }, 'Create a team to collaborate: share one board with teammates and their AI sessions, and connect tools like GitHub. Open Team in the sidebar to sign in. Teams and integrations live on the team hub.')),
    h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-action': 'local-card-dismiss' }, 'Dismiss'));
}

export function alertsStrip(alerts, model) {
  if (model.conn.status === 'lost') return null;
  if (!alerts.items.length) {
    return h('div', { class: 'alerts alerts-clear', role: 'status' }, icon('check', 'icon-xs'), 'Nothing needs you right now.');
  }
  return h('nav', { class: 'alerts', 'aria-label': 'Needs your attention' },
    h('ul', { class: 'alerts-list' },
      alerts.items.map((a) => h('li', { key: `${a.kind}:${a.card_id}:${a.text}` },
        h('button', { type: 'button', class: 'alert', 'data-kind': a.kind, 'data-action': 'open', 'data-card': a.card_id, 'data-section': a.kind === 'blocked' ? 'asks' : a.kind === 'overlap' ? 'overlaps' : null },
          icon(ALERT_ICON[a.kind] ?? 'dot', 'icon-xs'), h('span', null, a.text)))),
      alerts.more ? h('li', { key: 'more' }, h('span', { class: 'alert alert-more' }, `+${alerts.more} more`)) : null));
}

export function connectionBanner(conn) {
  if (conn.status !== 'lost') return null;
  return h('div', { class: 'banner banner-lost', role: 'alert' },
    icon('sync', 'icon-xs'),
    h('span', null, h('strong', null, 'Board connection lost: '), `states as of ${clock(conn.lostAt)}.`),
    h('span', { class: 'banner-sub' }, conn.retryInMs != null ? `Reconnecting in ${Math.max(1, Math.ceil(conn.retryInMs / 1000))}s` : 'Reconnecting…'),
    h('button', { type: 'button', class: 'btn btn-sm', 'data-action': 'reconnect' }, 'Retry now'));
}

export const THEME_NEXT = { system: 'dark', dark: 'light', light: 'system' };
const THEME_ICON = { system: 'auto', dark: 'moon', light: 'sun' };

// One button opens a small menu: colour scheme, then the board background.
// Roving focus (arrows), Esc and an outside click close it; see app.js.
export function themeMenu(model) {
  const open = !!model.themeMenu;
  return h('div', { class: 'menu-wrap' },
    h('button', {
      type: 'button', class: 'btn btn-ghost btn-icon', 'data-action': 'theme-menu', 'aria-haspopup': 'menu', 'aria-expanded': open ? 'true' : 'false',
      'aria-controls': 'theme-menu', 'aria-label': 'Appearance', title: 'Appearance',
    }, icon(THEME_ICON[model.theme] ?? 'auto')),
    open ? h('div', { id: 'theme-menu', class: 'menu theme-menu', role: 'menu', 'aria-label': 'Appearance' },
      h('p', { class: 'menu-title', id: 'menu-scheme' }, 'Theme'),
      h('div', { role: 'group', 'aria-labelledby': 'menu-scheme' },
        THEMES.map((t) => h('button', {
          key: t.id, type: 'button', class: 'menu-item', role: 'menuitemradio', 'aria-checked': model.theme === t.id ? 'true' : 'false',
          'data-action': 'theme', 'data-next': t.id,
        }, icon(t.icon, 'icon-xs'), h('span', null, t.label), model.theme === t.id ? icon('check', 'icon-xs menu-check') : null))),
      h('p', { class: 'menu-title', id: 'menu-bg' }, 'Board background'),
      h('div', { role: 'group', 'aria-labelledby': 'menu-bg', class: 'bg-grid' },
        BACKGROUNDS.map((b) => h('button', {
          key: b.id, type: 'button', class: 'bg-opt', role: 'menuitemradio', 'aria-checked': (model.bg ?? 'none') === b.id ? 'true' : 'false',
          'data-action': 'board-bg', 'data-bg': b.id, title: b.label,
        }, h('span', { class: 'bg-swatch', 'data-bg': b.id, 'aria-hidden': 'true' }), h('span', { class: 'bg-name' }, b.label))))) : null);
}

function costChip(model) {
  const total = costText(boardCostRollup((model.entries ?? []).map((e) => e.view)));
  const daily = dailyCapText(model.board?.daily_cap);
  if (!total && !daily) return null;
  return h('span', { class: `topbar-cost num${model.board?.daily_cap?.exceeded ? ' is-over' : ''}`, title: daily ?? 'Spend where the AI reports dollars', 'aria-label': `Board cost ${total ?? 'none'}${daily ? `, ${daily}` : ''}` },
    total ? `Spent ${total}` : null, daily ? ` · ${daily}` : null);
}

export function topBar(model, lamps) {
  // /api/me is publicMember ({display_name, github_login}); snapshot members
  // are {name, login}. Normalise so the avatar and label never fall back to "?".
  const m = model.me?.member;
  const me = m && { ...m, name: m.display_name ?? m.name ?? m.github_login ?? m.login ?? null, login: m.github_login ?? m.login ?? null };
  const conn = model.conn.status;
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand' },
      pixelClaude({ lamps, eyes: conn === 'lost' ? 'shut' : 'open', cls: 'brand-mark' }),
      h('div', { class: 'brand-text' },
        h('span', { class: 'brand-board' }, model.board?.name ?? 'Board'),
        model.board?.key_prefix ? h('span', { class: 'brand-key num' }, model.board.key_prefix) : null),
      model.boards?.length ? h('select', { class: 'input input-sm board-switcher', 'aria-label': 'Switch board', 'data-change': 'board' },
        model.boards.filter((b) => !b.archived_at || b.id === model.board?.id).map((b) => h('option', { key: b.id, value: b.id, selected: b.id === model.board?.id }, `${b.name}${b.archived_at ? ' (Archived)' : ''}`))) : null),
    viewSwitch(model, (v) => !ADVANCED_VIEWS.has(v.id)),
    h('div', { class: 'topbar-status', role: 'status', 'aria-live': 'polite' },
      h('span', { class: `conn conn-${conn}` }, h('span', { class: 'conn-dot', 'aria-hidden': 'true' }),
        conn === 'open' ? 'Live' : conn === 'lost' ? 'Offline' : 'Connecting'), costChip(model)),
    h('div', { class: 'topbar-actions' },
      h('details', { class: 'menu-wrap topbar-advanced' },
        h('summary', { class: 'btn btn-ghost btn-sm' }, 'Advanced'),
        h('div', { class: 'menu topbar-advanced-menu' },
          viewSwitch(model, (v) => ADVANCED_VIEWS.has(v.id), 'More views'),
          model.accounts ? h('a', { class: 'btn btn-ghost btn-sm', href: '/clients' }, 'Clients') : null,
          ['owner', 'admin'].includes(m?.role) ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'manage-boards' }, 'Boards') : null,
          themeMenu(model),
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm palette-open', 'data-action': 'palette', 'aria-keyshortcuts': 'Control+K Meta+K', 'aria-label': 'Search and commands' }, icon('search', 'icon-lead'), h('span', { class: 'palette-open-label' }, 'Search'), h('kbd', { class: 'kbd', 'aria-hidden': 'true' }, '⌘K')))),
      model.accounts && ['owner', 'admin'].includes(m?.role) && model.view !== 'team' ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'view', 'data-view': 'team' }, icon('person', 'icon-lead'), 'Invite') : null,
      model.readOnly ? null : h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'new-card', 'aria-keyshortcuts': 'n' }, icon('plus', 'icon-lead'), 'New card'),
      me ? h('span', { class: 'me', title: `${me.name ?? me.login}${me.email ? ` · ${me.email}` : ''}` }, avatar({ ...me, member_id: me.id }), h('span', { class: 'me-name' }, me.name ?? me.login)) : null));
}

// Board and Table stay in the bar; the planning views sit behind Advanced.
const ADVANCED_VIEWS = new Set(['calendar', 'timeline', 'dashboard']);

function viewSwitch(model, keep = () => true, label = 'Board views') {
  return h('nav', { class: 'viewswitch', 'aria-label': label },
    VIEWS.filter((v) => v.switcher !== false && (!v.planner || model.showPlanner) && keep(v)).map((v) => h('button', {
      key: v.id, type: 'button', class: 'viewswitch-btn', 'data-action': 'view', 'data-view': v.id,
      'aria-pressed': model.view === v.id ? 'true' : 'false',
      // The text label is hidden on phones; the name must survive it.
      'aria-label': v.label, title: v.label,
    }, icon(v.icon, 'icon-xs'), h('span', { class: 'viewswitch-label' }, v.label))));
}

export function needsYouSection(items, model) {
  if (model.conn.status === 'lost' || !items?.length) return null;
  return h('section', { class: 'needs-you', 'aria-labelledby': 'needs-you-title' },
    h('h2', { id: 'needs-you-title', class: 'needs-you-title' }, `Needs you · ${items.length}`),
    h('ol', { class: 'needs-you-list' }, items.slice(0, 8).map((i) => h('li', { key: i.card_id },
      h('button', { type: 'button', class: 'needs-you-item', 'data-kind': i.kind, 'data-action': 'open', 'data-card': i.card_id, 'data-section': i.kind === 'waiting' ? 'asks' : null },
        h('span', { class: 'needs-you-key num' }, i.key),
        h('span', { class: 'needs-you-what' }, i.label),
        h('span', { class: 'needs-you-wait num' }, i.wait_ms == null ? '' : `waiting ${formatAge(i.wait_ms)}`)))),
      items.length > 8 ? h('li', { key: 'more', class: 'muted small' }, `+${items.length - 8} more`) : null));
}

/** `body` replaces the columns for the other views (table, dashboard, …). */
export function boardScreen(model, body = null) {
  const cols = groupColumns(model.visible ?? model.entries);
  const lamps = boardLamps(model.me?.member?.id, model.entries.filter((e) => !e.view.archived), model.conn.status === 'lost');
  return h('div', { class: 'app', 'data-conn': model.conn.status },
    topBar(model, lamps),
    connectionBanner(model.conn),
    model.board?.archived_at ? h('p', { class: 'board-archived callout', role: 'status' }, 'This board is archived and read-only. An admin can restore it from Boards.') : null,
    alertsStrip(model.alerts, model),
    needsYouSection(model.needsYou, model),
    localCard(model),
    model.view === 'dashboard' ? null : filterBar(model),
    body ? null : stalledLane(cols.stalled, model),
    body ? null : idleLane(cols.idle, model),
    body ?? h('main', { class: 'board', id: 'board', 'aria-label': 'Board columns' },
      COLUMNS.map((c) => column(c, cols[c], model))),
    h('p', { id: 'dnd-help', class: 'sr-only' }, 'Cards with no active agent run can be moved. Press Space to pick up, left and right arrows to choose a column, Space to drop, Escape to cancel.'),
    h('div', { class: 'sr-only', role: 'status', 'aria-live': 'assertive', 'aria-atomic': 'true' }, model.announce ?? ''));
}

export function loadingScreen(text = 'Loading the board…') {
  return h('div', { class: 'app app-center' },
    h('div', { class: 'loading', role: 'status' }, pixelClaude({ cls: 'loading-mark' }), h('p', null, text)));
}
