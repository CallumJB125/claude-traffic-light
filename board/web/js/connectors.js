// What the local (not signed in) Integrations views promise about each tool.
// buddy-window/connectors.js carries the same list for the app's own page; a
// root test fails if the two drift.
//
// LAUNCH_CONNECTORS is the one switch: the connectors that are built AND
// enabled on the team hub today. Update it, in both files, when a connector is
// enabled on the prod hub. It is never decided by a network call, so a
// signed-out window cannot say "available" for something the hub doesn't offer.
export const LAUNCH_CONNECTORS = Object.freeze(['github']);

export const CONNECTORS = Object.freeze([
  { id: 'github', name: 'GitHub', value: 'Cards update when pull requests merge; open the PR from the card.' },
  { id: 'slack', name: 'Slack', value: 'Turn messages into cards and get updates in a channel.' },
  { id: 'sentry', name: 'Sentry', value: 'New errors become cards, deduplicated.' },
  { id: 'linear', name: 'Linear', value: 'Keep issues and cards in step.' },
  { id: 'jira', name: 'Jira', value: 'Keep issues and cards in step.' },
  { id: 'google', name: 'Google', value: 'Calendar and Workspace sign-in.' },
]);

export const STATUS_TEXT = Object.freeze({ available: 'Available after you join a team', soon: 'Coming soon' });

export const connectorStatus = (id) => (LAUNCH_CONNECTORS.includes(id) ? 'available' : 'soon');
