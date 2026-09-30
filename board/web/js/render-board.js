// Board screen: top bar, connection banner, alerts strip, four columns, cards.
// Pure: (model) → vnode. Interactions are data-action attributes handled by
// one delegated listener in app.js.
import { h } from './h.js';
import { icon, pixelClaude, PILL_ICON, ALERT_ICON } from './icons.js';
import { inline } from './markdown.js';
import { VIEWS } from './views.js';
import { PILLS } from '../../shared/cardface.js';
import {
  COLUMNS, COLUMN_LABEL, ACTION_LABEL, groupColumns, isHumanOwned, repoBranch, clock, initials, hueOf,
  primaryAction, boardLamps, stripGlyph,
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
  const label = ACTION_LABEL[id === 'allow_review' ? 'allow' : id];
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
  const primary = primaryAction(face);
  const buttons = face.actions.map((a) => actionButton(a, view, { primary: a === primary, busy: busy?.has(`${view.id}:${a}`), busyKeys: busy })).filter(Boolean);
  return buttons.length ? h('div', { class: 'card-actions' }, buttons) : null;
}

export function card({ view, face }, model) {
  const members = model.members;
  const assignees = (view.assignee_ids ?? []).map((id) => members.get(id));
  const owner = view.run?.owner ? members.get(view.run.owner.member_id) ?? view.run.owner : null;
  const people = [...new Map([...assignees, owner].filter(Boolean).map((m) => [m.member_id ?? m.name, m])).values()];
  const rb = repoBranch(view);
  const human = isHumanOwned(view);
  const req = view.ask?.count > 1 ? `${view.ask.count} req` : view.ask?.count === 1 && view.run_state === 'blocked' ? '1 req' : null;
  const sponsor = human ? (view.target ? face.sponsor : null) : face.sponsor;
  const selected = model.openCardId === view.id;

  return h('article', {
    key: view.id,
    class: `card${selected ? ' is-open' : ''}${human ? ' is-human' : ''}`,
    'data-tone': face.tone,
    'data-state': face.state,
    'data-card-id': view.id,
    draggable: human && !model.readOnly ? 'true' : null,
    'aria-labelledby': `t-${view.id}`,
  },
  h('div', { class: 'card-top' },
    h('span', { class: 'card-key num' }, view.key),
    view.agent_suggested ? h('span', { class: 'label agent-suggested', title: 'Created by an agent; a person must give it to Claude' }, 'agent-suggested') : null,
    rb ? h('span', { class: 'card-repo num', title: view.base_ref ? `base ${view.base_ref}` : null }, icon('branch', 'icon-xs'), rb) : null,
    avatarStack(people)),
  h('h3', { class: 'card-title', id: `t-${view.id}` },
    h('button', { type: 'button', class: 'card-open', 'data-action': 'open', 'data-card': view.id }, view.title)),
  pill(face),
  (sponsor || req || face.activity_line) ? h('div', { class: 'card-meta' },
    sponsor ? h('span', { class: 'card-sponsor' }, sponsor) : null,
    face.activity_line && face.state !== 'done' ? h('span', { class: 'card-activity' }, face.activity_line) : null,
    req ? h('span', { class: 'card-req num' }, req) : null) : null,
  face.overlap_chip ? h('button', { type: 'button', class: 'chip chip-overlap', 'data-action': 'open', 'data-card': view.id, 'data-section': 'overlaps' },
    icon('warn', 'icon-xs'), stripGlyph(face.overlap_chip)) : null,
  view.labels?.length ? h('div', { class: 'card-labels' }, view.labels.map((l) => h('span', { class: 'label' }, l))) : null,
  // An unspent budget on a card nobody is running is noise; the drawer and the Give dialog show it.
  face.budget && (view.run || view.budget?.spent_usd > 0) ? budgetBar(face.budget) : null,
  model.readOnly ? null : cardActions(face, view, model.busy),
  human && face.state === 'todo' && !view.target ? h('p', { class: 'card-foot' }, view.repo ? 'on your account' : 'no repo yet · add one to give it to Claude') : null);
}

export function column(id, entries, model) {
  const count = entries.length;
  const needs = entries.filter((e) => e.face.tone === 'amber' || e.face.tone === 'red').length;
  const isDone = id === 'done';
  const shown = isDone && !model.showAllDone ? entries.slice(0, 6) : entries;
  return h('section', { key: id, class: `column column-${id}`, 'data-column': id, 'aria-labelledby': `col-${id}` },
    h('header', { class: 'column-head' },
      h('h2', { id: `col-${id}` }, COLUMN_LABEL[id]),
      h('span', { class: 'column-count num', 'aria-label': `${count} cards` }, String(count)),
      needs ? h('span', { class: 'column-needs', title: `${needs} need attention` }, icon('dot', 'icon-xs'), String(needs)) : null,
      id === 'todo' && !model.readOnly ? h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'data-action': 'new-card', 'aria-label': 'New card' }, icon('plus')) : null),
    h('div', { class: 'column-body', 'data-drop': id },
      shown.length ? shown.map((e) => card(e, model)) : h('p', { class: 'column-empty' }, EMPTY[id]),
      isDone && entries.length > 6 ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm column-more', 'data-action': 'toggle-done' },
        model.showAllDone ? 'Show fewer' : `Show ${entries.length - 6} more`) : null));
}

const EMPTY = {
  todo: 'Nothing waiting. New cards land here.',
  in_progress: 'No one is working on anything. Give a card to Claude to start.',
  in_review: 'Nothing to review.',
  done: 'Finished work shows up here.',
};

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

const THEME_NEXT = { system: 'dark', dark: 'light', light: 'system' };
const THEME_ICON = { system: 'auto', dark: 'moon', light: 'sun' };
const THEME_LABEL = { system: 'Theme: match system', dark: 'Theme: dark', light: 'Theme: light' };

export function topBar(model, lamps) {
  const me = model.me?.member;
  const conn = model.conn.status;
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand' },
      pixelClaude({ lamps, eyes: conn === 'lost' ? 'shut' : 'open', cls: 'brand-mark' }),
      h('div', { class: 'brand-text' },
        h('span', { class: 'brand-board' }, model.board?.name ?? 'Board'),
        model.board?.key_prefix ? h('span', { class: 'brand-key num' }, model.board.key_prefix) : null)),
    viewSwitch(model),
    h('div', { class: 'topbar-status', role: 'status', 'aria-live': 'polite' },
      h('span', { class: `conn conn-${conn}` }, h('span', { class: 'conn-dot', 'aria-hidden': 'true' }),
        conn === 'open' ? 'Live' : conn === 'lost' ? 'Offline' : 'Connecting')),
    h('div', { class: 'topbar-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'data-action': 'theme', 'data-next': THEME_NEXT[model.theme], 'aria-label': `${THEME_LABEL[model.theme]}. Switch to ${THEME_NEXT[model.theme]}.`, title: THEME_LABEL[model.theme] }, icon(THEME_ICON[model.theme])),
      model.readOnly ? null : h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'new-card', 'aria-keyshortcuts': 'n' }, icon('plus', 'icon-lead'), 'New card'),
      me ? h('span', { class: 'me', title: `${me.name ?? me.login}${me.email ? ` · ${me.email}` : ''}` }, avatar({ ...me, member_id: me.id }), h('span', { class: 'me-name' }, me.name ?? me.login)) : null));
}

function viewSwitch(model) {
  return h('nav', { class: 'viewswitch', 'aria-label': 'Board views' },
    VIEWS.map((v) => h('button', {
      key: v.id, type: 'button', class: 'viewswitch-btn', 'data-action': 'view', 'data-view': v.id,
      'aria-pressed': model.view === v.id ? 'true' : 'false',
      // The text label is hidden on phones; the name must survive it.
      'aria-label': v.label, title: v.label,
    }, icon(v.icon, 'icon-xs'), h('span', { class: 'viewswitch-label' }, v.label))));
}

/** `body` replaces the columns for the other views (table, dashboard, …). */
export function boardScreen(model, body = null) {
  const cols = groupColumns(model.entries);
  const lamps = boardLamps(model.me?.member?.id, model.entries, model.conn.status === 'lost');
  return h('div', { class: 'app', 'data-conn': model.conn.status },
    topBar(model, lamps),
    connectionBanner(model.conn),
    alertsStrip(model.alerts, model),
    body ?? h('main', { class: 'board', id: 'board', 'aria-label': 'Board columns' },
      COLUMNS.map((c) => column(c, cols[c], model))));
}

export function loadingScreen(text = 'Loading the board…') {
  return h('div', { class: 'app app-center' },
    h('div', { class: 'loading', role: 'status' }, pixelClaude({ cls: 'loading-mark' }), h('p', null, text)));
}
