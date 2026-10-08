// The board's views, in switcher order. The app window's sidebar links to
// them as ?view=<id>. `switcher:false` views are reachable by ?view= only.
export const VIEWS = [
  { id: 'board', label: 'Board', icon: 'columns' },
  { id: 'table', label: 'Table', icon: 'rows' },
  { id: 'history', label: 'History', icon: 'clock' },
  // Project-planning views: AI runs carry no due dates or dependencies, so they are
  // off the switcher and palette unless the planner is on. Routes and deep links stay.
  { id: 'calendar', label: 'Calendar', icon: 'calendar', planner: true },
  { id: 'timeline', label: 'Timeline', icon: 'rows', planner: true },
  { id: 'dashboard', label: 'Dashboard', icon: 'chart' },
  // Team pages the app window's sidebar opens; not board views, so not in the switcher.
  { id: 'integrations', label: 'Integrations', icon: 'plug', switcher: false },
  { id: 'team', label: 'Team', icon: 'person', switcher: false },
];

/** ?planner=1 turns the planning views on (and remembers it); ?planner=0 turns them off again. */
export function plannerEnabled(search = '', stored = null) {
  const q = new URLSearchParams(search).get('planner');
  return q === '1' ? true : q === '0' ? false : stored === '1';
}
