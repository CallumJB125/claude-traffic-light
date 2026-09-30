// The Buddy window's sidebar: one registry, pure, shared by main and the
// sidebar renderer (it arrives there as JSON through the preload).
//
// kind:
//   hub     — a page of the board web app, loaded from the hub's own origin
//             in a sandboxed view (`view` is its ?view=).
//   window  — an existing app window (Lights, Preferences…) opened as is until
//             its owner moves it into this window.
//   local   — an app file rendered in its own view with its own preload
//             (the plug-in point for Tasks and settings pages); `screen`
//             picks the account page's screen (account.html).
//   soon    — named in the plan but not built yet; says so honestly.
'use strict';

const PAGES = [
  { id: 'board', title: 'Board', icon: 'board', kind: 'hub', view: 'board', group: 'work',
    children: [
      { id: 'board:table', title: 'Table', kind: 'hub', view: 'table' },
      { id: 'board:dashboard', title: 'Dashboard', kind: 'hub', view: 'dashboard' },
      { id: 'board:calendar', title: 'Calendar', kind: 'soon' },
      { id: 'board:timeline', title: 'Timeline', kind: 'soon' },
    ] },
  { id: 'myday', title: 'My day', icon: 'sun', kind: 'soon', group: 'work', blurb: 'Your cards, what is waiting on you, your agents and your calendar in one place.' },
  { id: 'tasks', title: 'Tasks', icon: 'tasks', kind: 'soon', group: 'work', blurb: 'Standalone Claude tasks you started from Buddy, with their messages. Being built by buddy-builder-2.' },
  { id: 'integrations', title: 'Integrations', icon: 'plug', kind: 'soon', group: 'team', blurb: 'Connect Slack, GitHub, Sentry and more to the board.' },
  { id: 'team', title: 'Team', icon: 'team', kind: 'local', screen: 'team', group: 'team' },
  { id: 'usage', title: 'Usage', icon: 'chart', kind: 'window', window: 'mix', group: 'you' },
  { id: 'setups', title: 'Setups', icon: 'layers', kind: 'soon', group: 'you', blurb: 'Borrow a teammate’s Claude setup. Being built by buddy-builder-4.' },
  { id: 'plugins', title: 'Plugins', icon: 'puzzle', kind: 'soon', group: 'you', blurb: 'Find and install Claude Code plugins.' },
  { id: 'thismac', title: 'This Mac', icon: 'laptop', kind: 'local', screen: 'thismac', group: 'you' },
  { id: 'account', title: 'Account', icon: 'user', kind: 'local', screen: 'account', group: 'you' },
  { id: 'lights', title: 'Lights', icon: 'lights', kind: 'window', window: 'lights', group: 'you' },
  { id: 'settings', title: 'Settings', icon: 'gear', kind: 'window', window: 'settings', group: 'you' },
];

const GROUPS = [
  { id: 'work', title: null },
  { id: 'team', title: 'Team' },
  { id: 'you', title: 'You' },
];

function flat(pages = PAGES) {
  const out = [];
  for (const p of pages) { out.push(p); for (const c of p.children ?? []) out.push({ ...c, parent: p.id }); }
  return out;
}

function pageById(id, pages = PAGES) {
  return flat(pages).find((p) => p.id === id) ?? null;
}

// The hub page URL for a board view. The web app reads ?view= on load, and
// ?org= picks the team on a hub where the member is in several.
function hubPageUrl(base, page, { org = null } = {}) {
  const u = new URL(base);
  u.pathname = '/';
  u.search = '';
  if (org) u.searchParams.set('org', org);
  if (page?.view && page.view !== 'board') u.searchParams.set('view', page.view);
  return u.toString();
}

const orgOfUrl = (url) => { try { return new URL(url).searchParams.get('org'); } catch { return null; } };

/**
 * Where may the hub view navigate itself? Only its own origin, plus the
 * Cloudflare Access login pages of a team hub. Everything else opens in the
 * system browser (http/https only) or nowhere.
 */
function navDecision(targetUrl, { hubOrigin, accessTeam = null }) {
  let u;
  try { u = new URL(targetUrl); } catch { return 'deny'; }
  if (u.origin === hubOrigin) return 'allow';
  if (accessTeam && u.protocol === 'https:' && u.hostname === `${accessTeam}.cloudflareaccess.com`) return 'allow';
  if (u.protocol === 'https:' || u.protocol === 'http:') return 'external';
  return 'deny';
}

/** Which sidebar entry does a hub URL correspond to (for in-page view switches)? */
function pageForHubUrl(url) {
  let v = null;
  try { v = new URL(url).searchParams.get('view'); } catch { return 'board'; }
  const hit = flat().find((p) => p.kind === 'hub' && p.view === (v || 'board'));
  return hit?.id ?? 'board';
}

module.exports = { PAGES, GROUPS, flat, pageById, hubPageUrl, navDecision, pageForHubUrl, orgOfUrl };
