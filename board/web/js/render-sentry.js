import { h } from './h.js';
import { SENTRY_LEVELS } from './sentry-settings.js';

export function sentryRouting(conn, m) {
  const config = conn.settings?.config ?? {}, boards = m.boards ?? [];
  const routes = config.project_boards && typeof config.project_boards === 'object' && !Array.isArray(config.project_boards) ? Object.entries(config.project_boards).slice(0, 32) : [];
  const name = id => boards.find(b => b.id === id)?.name ?? 'Unavailable board';
  const defaultId = config.default_board_id ?? conn.target_board_id ?? '';
  const configured = typeof config.default_board_id === 'string' && boards.some(b => b.id === config.default_board_id && !b.archived_at);
  const help = 'New issues and critical incidents become Todo cards. Status updates add human-readable comments; they never start an AI or move a card. Multi-project incidents pause when their project routes disagree.';
  if (!m.canEdit) return h('section', { class: 'integ-section', 'aria-label': 'Sentry routing' },
    h('h4', null, 'Sentry intake'), h('p', { class: 'small' }, configured ? `Default board: ${name(defaultId)}` : 'New intake is paused until an admin saves an active default board.'),
    routes.length ? h('ul', { class: 'small' }, routes.map(([slug, id]) => h('li', { key: slug }, `${slug}: ${name(id)}`))) : null, h('p', { class: 'muted small' }, help));
  const busy = m.busy.has(`integ:${conn.id}`);
  const options = (selected, blank = false) => [
    ...(blank ? [h('option', { value: '', selected: !selected }, 'Choose a board')] : []),
    ...boards.filter(b => !b.archived_at || b.id === selected).map(b => h('option', { key: b.id, value: b.id, selected: b.id === selected }, `${b.name}${b.archived_at ? ' (Archived — intake paused)' : ''}`)),
    ...(selected && !boards.some(b => b.id === selected) ? [h('option', { value: selected, selected: true }, 'Unavailable board — choose another')] : []),
  ];
  return h('section', { class: 'integ-section', 'aria-label': 'Sentry routing' }, h('h4', null, 'Sentry intake'),
    !configured ? h('p', { class: 'small', role: 'status' }, 'New intake is paused until you save an active default board.') : null,
    h('p', { class: 'muted small' }, help),
    h('form', { 'data-form': 'sentry-settings', 'data-conn': conn.id },
      h('label', { class: 'field' }, h('span', null, 'Default board'), h('select', { name: 'default_board', class: 'input', disabled: busy || null }, options(defaultId, true))),
      h('fieldset', { disabled: busy || null }, h('legend', null, 'Project routes (optional)'),
        h('p', { class: 'muted small' }, 'Use the exact project slug shown in Sentry. Projects without a route use the default board. Clear both fields to remove a route.'),
        [...routes, ...(routes.length < 32 ? [['', '']] : [])].map(([slug, id], i) => h('div', { key: `route-${i}`, class: 'field' },
          h('label', null, h('span', { class: 'sr-only' }, `Project ${i + 1}`), h('input', { name: 'project_slug', class: 'input', value: slug, maxlength: 64, placeholder: 'Project slug' })),
          h('label', null, h('span', { class: 'sr-only' }, `Board for project ${i + 1}`), h('select', { name: 'project_board', class: 'input' }, options(id, true)))))),
      h('label', { class: 'field' }, h('span', null, 'Minimum new-issue severity'), h('select', { name: 'min_level', class: 'input', disabled: busy || null },
        SENTRY_LEVELS.map(level => h('option', { value: level, selected: level === (config.min_level ?? 'error') }, level)))),
      h('label', { class: 'field' }, h('input', { type: 'checkbox', name: 'include_message', checked: config.include_message === true, disabled: busy || null }), 'Include a redacted issue message'),
      h('label', { class: 'field' }, h('span', null, 'Incident cooldown (minutes)'), h('input', { type: 'number', name: 'cooldown_minutes', min: 1, max: 1440, value: config.cooldown_minutes ?? 60, class: 'input', disabled: busy || null })),
      h('p', { class: 'muted small' }, 'Critical alerts from the same rule share a card within each fixed cooldown interval. Status is the last update received; Sentry may deliver updates out of order.'),
      m.sentryErrors?.[conn.id] ? h('p', { role: 'alert', class: 'small' }, m.sentryErrors[conn.id]) : null,
      h('button', { type: 'submit', class: 'btn btn-sm', disabled: busy || null }, busy ? 'Saving…' : 'Save Sentry settings')));
}
