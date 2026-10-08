// The Plexiform window's view of the brand: the name, schemes and hub URL
// come from the app's one brand module (../brand.js); only strings that
// belong to this window live here, built from that name so a rename is
// still one edit there. Pure: main requires it, and the renderers get it
// over IPC or the query.
'use strict';

const Brand = require('../brand');

const NAME = Brand.name;

module.exports = Object.freeze({
  NAME,
  SHORT: Brand.shortName,
  TAGLINE: Brand.tagline,
  SCHEME: Brand.scheme,
  // Links minted before the rename keep working; they parse exactly like SCHEME.
  LEGACY_SCHEMES: Brand.legacySchemes,
  SCHEMES: Object.freeze([Brand.scheme, ...Brand.legacySchemes]),
  // The hosted team hub: the sign-in screen's default until the member uses another.
  DEFAULT_HUB: Brand.urls.hub,
  WINDOW_TITLE: NAME,
  CONNECT_TITLE: 'Connect',
  OPEN_MENU_LABEL: Brand.label('Open {name}…'),
  PROTOCOL_NAME: NAME,
  // Service names Activity Monitor shows for the helper processes.
  HUB_SERVICE: `${NAME} Board Hub`,
  RUNNER_SERVICE: `${NAME} Board Runner`,
  // The sidebar's status line under the page list; {teams} is filled in.
  HUB_TEXT: Object.freeze({
    starting: `${NAME} is starting the board…`,
    restarting: 'Board restarting…',
    failed: 'Board unavailable',
    team: 'Team board',
    local: 'Board on this Mac',
    running: 'Running team tasks for {teams}',
  }),
  COPY: Object.freeze({
    signInHeading: `Sign in to ${NAME}`,
    signInSub: 'Enter your team’s Plexiform address (e.g. team.example.com). You’ll pick how to sign in next; no password.',
    inviteHint: `You’ll get a link and a code to send them yourself. ${NAME} doesn’t email invites, and shows them only once.`,
    notAHub: `That address answered, but it isn’t a ${NAME} team hub.`,
    notASignIn: `That address redirects somewhere that isn’t a ${NAME} sign-in.`,
    startingBoard: `${NAME} is starting the board…`,
  }),
});
