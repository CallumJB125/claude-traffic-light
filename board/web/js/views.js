// The board's views, in switcher order. The app window's sidebar links to
// them as ?view=<id>.
export const VIEWS = [
  { id: 'board', label: 'Board', icon: 'columns' },
  { id: 'table', label: 'Table', icon: 'rows' },
  { id: 'dashboard', label: 'Dashboard', icon: 'chart' },
  // Team pages the app window's sidebar opens; not board views, so not in the switcher.
  { id: 'integrations', label: 'Integrations', icon: 'plug', switcher: false },
];
