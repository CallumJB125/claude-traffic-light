// What the signed-out Integrations page promises about each tool. The board
// web carries the same list (board/web/js/connectors.js) for the local hub's
// own page; test/local-onboarding.test.js fails if the two drift.
//
// LAUNCH_CONNECTORS is the one switch: the connectors that are built AND
// enabled on the team hub today. Update it, in both files, when a connector is
// enabled on the prod hub. It is never decided by a network call, so a
// signed-out window cannot say "available" for something the hub doesn't offer.
'use strict';

const LAUNCH_CONNECTORS = Object.freeze(['github']);

const CONNECTORS = Object.freeze([
  { id: 'github', name: 'GitHub', value: 'Cards update when pull requests merge; open the PR from the card.' },
  { id: 'slack', name: 'Slack', value: 'Turn messages into cards and get updates in a channel.' },
  { id: 'sentry', name: 'Sentry', value: 'New errors become cards, deduplicated.' },
]);

const STATUS_TEXT = Object.freeze({ available: 'Available after you join a team', soon: 'Coming soon' });

const connectorStatus = (id) => (LAUNCH_CONNECTORS.includes(id) ? 'available' : 'soon');

/** The grid's rows, with the status words resolved: what crosses to the page. */
const connectorRows = () => CONNECTORS.map((c) => ({ ...c, status: connectorStatus(c.id), statusText: STATUS_TEXT[connectorStatus(c.id)] }));

module.exports = { LAUNCH_CONNECTORS, CONNECTORS, STATUS_TEXT, connectorStatus, connectorRows };
