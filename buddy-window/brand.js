// The product's name and every string that would change with it, for the
// Plexiform window and its deep links. A local stand-in until builder-3's
// shared brand module replaces it; keep brand-bearing copy here, not inline.
// Pure: main requires it, and the renderers get it over IPC or the query.
'use strict';

const SCHEME = 'plexiform';
// Links minted before the rename keep working; they parse exactly like SCHEME.
const LEGACY_SCHEMES = Object.freeze(['claudebuddy']);

module.exports = Object.freeze({
  NAME: 'Plexiform',
  SHORT: 'Plexiform',
  TAGLINE: 'Your team’s board, with Claude on it.',
  SCHEME,
  LEGACY_SCHEMES,
  SCHEMES: Object.freeze([SCHEME, ...LEGACY_SCHEMES]),
  // The hosted team hub: the sign-in screen's default until the member uses another.
  DEFAULT_HUB: 'https://app.plexiform.dev',
  WINDOW_TITLE: 'Plexiform',
  CONNECT_TITLE: 'Connect',
  OPEN_MENU_LABEL: 'Open Plexiform…',
  PROTOCOL_NAME: 'Plexiform',
  // Service names Activity Monitor shows for the helper processes.
  HUB_SERVICE: 'Plexiform Board Hub',
  RUNNER_SERVICE: 'Plexiform Board Runner',
  // The sidebar's status line under the page list; {teams} is filled in.
  HUB_TEXT: Object.freeze({
    starting: 'Plexiform is starting the board…',
    restarting: 'Board restarting…',
    failed: 'Board unavailable',
    team: 'Team board',
    local: 'Board on this Mac',
    running: 'This Mac is running cards for {teams}',
  }),
  COPY: Object.freeze({
    signInHeading: 'Sign in to Plexiform',
    signInSub: 'Enter your team hub’s address. You’ll sign in with your email; no password.',
    inviteHint: 'You’ll get a link and a code to send them yourself. Plexiform doesn’t email invites, and shows them only once.',
    notAHub: 'That address answered, but it isn’t a Plexiform team hub.',
    notASignIn: 'That address redirects somewhere that isn’t a Plexiform sign-in.',
    startingBoard: 'Plexiform is starting the board…',
  }),
});
