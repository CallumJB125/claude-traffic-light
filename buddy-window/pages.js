// The Buddy window's sidebar: one registry, pure, shared by main and the
// sidebar renderer (it arrives there as JSON through the preload).
//
// kind:
//   hub     — a page of the board web app, loaded from the hub's own origin
//             in a sandboxed view (`view` is its ?view=).
//   window  — an the Widget rules popup (Rules and Auto-answer).
//   local   — an app file rendered in its own view with its own preload
//             (the plug-in point for Tasks and settings pages); `screen`
//             picks the account page's screen (account.html), `file` +
//             `preload` (in the app root) name a page of their own.
//   soon    — named in the plan but not built yet; says so honestly. (None today:
//             a page with no working feature is left out, not shown with a pill.)
'use strict';

const { NAME, MACHINE } = require('./brand');
const { isPrivateHost } = require('./workspaces');
const SettingsPanes = require('../src/settings-panes');

const PAGES = [
  { id: 'overview', title: 'Overview', icon: 'layers', kind: 'local', file: 'overview.html', preload: 'overview-preload.js', group: 'work' },
  // The personal landing page is the sidebar default.
  { id: 'home', title: 'Home', icon: 'sun', kind: 'local', file: 'home.html', preload: 'home-preload.js', group: 'work' },
  { id: 'board', title: 'Board', icon: 'board', kind: 'hub', view: 'board', group: 'work',
    children: [
      { id: 'board:table', title: 'Table', kind: 'hub', view: 'table' },
      { id: 'board:history', title: 'History', kind: 'hub', view: 'history' },
      { id: 'board:dashboard', title: 'Dashboard', kind: 'hub', view: 'dashboard' },
      { id: 'board:calendar', title: 'Calendar', kind: 'hub', view: 'calendar' },
      { id: 'board:timeline', title: 'Timeline', kind: 'hub', view: 'timeline' },
    ] },
  // Inbox keeps questions and daily priorities one click away; route IDs stay stable.
  { id: 'waiting', title: 'Waiting on you', icon: 'bell', kind: 'local', file: 'waiting.html', preload: 'waiting-preload.js', query: { embedded: '1' }, group: 'work' },
  { id: 'myday', title: 'My day', icon: 'sun', kind: 'local', file: 'myday.html', preload: 'myday-preload.js', group: 'work' },
  { id: 'sessions', title: 'Sessions', icon: 'team', kind: 'local', file: 'sessions.html', preload: 'sessions-preload.js', group: 'work' },
  { id: 'timeline', title: 'Session timeline', icon: 'layers', kind: 'local', file: 'timeline.html', preload: 'timeline-preload.js', group: 'work', unlisted: true },
  { id: 'checkpoints', title: 'What changed', icon: 'layers', kind: 'local', file: 'checkpoints.html', preload: 'checkpoints-preload.js', group: 'work' },
  // Search across every AI tool's local history (src/memory/search.js registers its IPC).
  { id: 'memory', title: 'Search everything', icon: 'layers', kind: 'local', file: 'memory.html', preload: 'memory-preload.js', group: 'work' },
  { id: 'tasks', title: 'Tasks', icon: 'tasks', kind: 'local', file: 'tasks.html', preload: 'tasks-preload.js', query: { embedded: '1' }, group: 'work' },
  // The community gallery (src/gallery.js): recipes, characters, widget rules, setups and packs from the site.
  { id: 'discover', title: 'Discover', icon: 'puzzle', kind: 'local', file: 'discover.html', preload: 'discover-preload.js', group: 'work' },
  // Find agents (src/agents-find-main.js serves its IPC): the bundled, pinned agent catalogue and + to your AI tools.
  { id: 'agents-find', title: 'Find agents', icon: 'find-agents', kind: 'local', file: 'agents-find.html', preload: 'agents-find-preload.js', group: 'work' },
  // localScreen: the account page's explainer for the local board, which has no integrations of its own.
  { id: 'integrations', title: 'Integrations', icon: 'plug', kind: 'hub', view: 'integrations', localScreen: 'integrations', group: 'team' },
  { id: 'team', title: 'Team', icon: 'team', kind: 'local', screen: 'team', group: 'team' },
  { id: 'usage', title: 'Usage', icon: 'chart', kind: 'local', file: 'lights.html', preload: 'lights-preload.js', query: { embedded: '1', view: 'mix' }, group: 'you' },
  // Usage & cost's Time tab; the page stays for deep links.
  { id: 'stats', title: 'Stats', icon: 'chart', kind: 'local', file: 'lights.html', preload: 'lights-preload.js', query: { embedded: '1', view: 'stats' }, group: 'you', unlisted: true },
  // Every user's cost-tool hub (src/optimiser-tools.js); with a trusted Burst on a Mac it also embeds Burst's dashboard (burst-embed.js).
  // A page may still be macOnly (left out of the sidebar elsewhere) or burstOnly (listed only while Burst is present).
  { id: 'optimiser', title: 'Usage optimiser', icon: 'chart', kind: 'local', file: 'optimiser.html', preload: 'optimiser-preload.js', query: { embedded: '1' }, group: 'you' },
  { id: 'clients', title: 'Client billing', icon: 'chart', kind: 'local', file: 'clients-local.html', preload: 'clients-preload.js', group: 'you' },
  { id: 'setups', title: 'Setups', icon: 'layers', kind: 'local', file: 'setups.html', preload: 'setups-preload.js', group: 'you', hidden: true },
  { id: 'thismac', title: `This ${MACHINE}`, icon: 'laptop', kind: 'local', screen: 'thismac', group: 'you' },
  // Phone approvals and pairing (src/remote-approvals-main.js serves its IPC; Plus shows an upsell otherwise).
  { id: 'phone', title: 'Phone', icon: 'bell', kind: 'local', file: 'phone-pairing.html', preload: 'phone-pairing-preload.js', group: 'you' },
  { id: 'account', title: 'Account', icon: 'user', kind: 'local', screen: 'account', group: 'you' },
  // Paid plan (src/entitlement-refresh.js serves its IPC): plan, limits, grace days, Upgrade / Manage billing.
  { id: 'upgrade', title: 'Plan & billing', icon: 'user', kind: 'local', file: 'upgrade.html', preload: 'upgrade-preload.js', group: 'you', hidden: true },
  // Encrypted sync across your own computers (src/sync/index.js serves its IPC; Plus/Team, upsell otherwise).
  { id: 'sync', title: 'Sync', icon: 'layers', kind: 'local', file: 'sync.html', preload: 'sync-preload.js', group: 'you', hidden: true },
  // The floating widget: live preview, show/hide, size, corner and what it shows (src/widget-page.js serves its IPC).
  { id: 'widget', title: 'Widget', icon: 'lights', kind: 'local', file: 'widget-page.html', preload: 'widget-page-preload.js', group: 'you' },
  { id: 'lights', title: 'Widget rules', icon: 'lights', kind: 'window', window: 'lights', group: 'you' },
  { id: 'aitools', title: 'AI tools', icon: 'plug', kind: 'local', file: 'aitools.html', preload: 'aitools-preload.js', group: 'you' },
  { id: 'settings', title: 'Preferences', icon: 'gear', kind: 'local', file: 'settings.html', preload: 'settings-preload.js', query: { embedded: '1' }, group: 'you' },
  { id: 'hatch', title: 'Hatch a character', icon: 'puzzle', kind: 'local', file: 'hatch.html', preload: 'hatch-preload.js', query: { embedded: '1' }, group: 'you' },
  { id: 'help', title: 'Help', icon: 'info', kind: 'local', file: 'help.html', preload: 'help-preload.js', query: { embedded: '1' }, group: 'you' },
  { id: 'feedback', title: 'Feedback', icon: 'info', kind: 'local', file: 'feedback.html', preload: 'feedback-preload.js', query: { embedded: '1' }, group: 'you' },
  { id: 'updates', title: "What's new", icon: 'info', kind: 'local', file: 'updates.html', preload: 'updates-preload.js', group: 'you' },
];

// Redesign R8-1: the Settings sheet's panes. NOT in PAGES (so with the dev chat preview off no such id exists, and
// pageById() stays null); index.js consults paneById() only when chatFirst is on. Each pane is its own document
// (own webContents, own guard); the ?pane= query only chooses what it renders (main builds it from this closed list).
const SETTINGS_PANES = Object.freeze(SettingsPanes.PANES.map((pane) => Object.freeze({
  id: `settings:${pane}`, title: SettingsPanes.TITLE[pane], icon: 'gear', kind: 'local', file: 'settings.html', preload: 'settings-preload.js',
  query: Object.freeze({ embedded: '1', pane }), group: 'you', unlisted: true, pane,
})));
// R8-2b: the widget rules editor in the sheet: lights.html's rules view, with lights-preload.js (its own guard in main: rulesEditor).
const RULES_PANE = Object.freeze({
  id: `settings:${SettingsPanes.RULES_PANE}`, title: SettingsPanes.TITLE[SettingsPanes.RULES_PANE], icon: 'lights', kind: 'local', file: 'lights.html', preload: 'lights-preload.js',
  query: Object.freeze({ embedded: '1', view: 'rules' }), group: 'you', unlisted: true, pane: SettingsPanes.RULES_PANE,
});
function paneById(id) { return typeof id === 'string' ? [...SETTINGS_PANES, RULES_PANE].find((p) => p.id === id) ?? null : null; }

const GROUPS = [
  { id: 'work', title: null },
  { id: 'team', title: 'Team' },
  { id: 'you', title: 'You' },
];

// The sidebar shows these and nothing else, grouped under small headings; every page above is still a
// page (deep links, IPC and the app menu address pages, not sections). A
// section opens `default`; the others are its sub-nav, in this order. Board
// views are the board page's children, so they are listed by id like the rest.
// An `unlisted` page belongs to its section (so the section lights up while it
// is open) but has no sub-nav entry of its own.
const SECTIONS = [
  { id: 'home', title: 'Home', icon: 'sun', default: 'home', pages: ['home'] },
  { id: 'board', title: 'Projects', icon: 'board', default: 'board', pages: ['board', 'tasks', 'board:table', 'board:history', 'board:calendar', 'board:timeline', 'board:dashboard'] },
  { id: 'sessions', title: 'Agents', icon: 'layers', default: 'overview', pages: ['overview', 'sessions', 'timeline', 'checkpoints', 'memory', 'discover', 'agents-find'] },
  { id: 'inbox', title: 'Inbox', icon: 'bell', default: 'waiting', pages: ['waiting', 'myday'] },
  { id: 'team', title: 'Team', icon: 'team', default: 'team', pages: ['team', 'integrations', 'account'] },
  { id: 'usage', title: 'Usage & cost', icon: 'chart', default: 'usage', heading: 'Workspace', menu: 'more', pages: ['usage', 'stats', 'clients'] },
  // Claude Burst and the usage panel have their own entry (the optimiser page): its sections unfold beneath it while open.
  { id: 'optimiser', title: 'Usage & Burst', icon: 'chart', default: 'optimiser', menu: 'more', pages: ['optimiser'] },
  { id: 'settings', title: 'Settings', icon: 'gear', default: 'settings', pages: ['settings', 'thismac', 'aitools', 'widget', 'lights', 'hatch', 'phone'] },
];
// `menu: false` keeps a section out of the tray and widget menus; `menu: 'more'` lists it in their More submenu.
// At most six sections are primary; everything else is a page inside one of them.
// Small links under the sections, not a section of their own.
const FOOTER = ['help', 'feedback', 'updates'];
// Setups is listed only once it works. Personal export/import and the
// reviewed Apply with backup and Undo (src/setups-personal.js) are built and
// tested, cross-platform; the signed native helper path (src/setups-main.js,
// accepted:false) stays held and its panel hidden. The entitlement
// (setups.personal, a free feature) lists it with no env var.
// The page and its deep link remain; PLEXIFORM_SHOW_SETUPS=1 lists it for development.
const SETUPS_READY = true;
if (process.env.PLEXIFORM_SHOW_SETUPS === '1' || (SETUPS_READY && require('../src/entitlements').has('setups.personal'))) {
  SECTIONS.find((s) => s.id === 'settings').pages.splice(7, 0, 'setups');
  PAGES.find((p) => p.id === 'setups').hidden = false;
}
// Plan & billing is listed after beta ends and a verification key is pinned. PLEXIFORM_SHOW_UPGRADE=1 lists it for testing.
const UPGRADE_READY = (() => { try { return !require('../src/release-policy').BETA_ALL_FEATURES && require('../src/entitlement-keys').ENTITLEMENT_KEYS.length > 0; } catch { return false; } })();
if (process.env.PLEXIFORM_SHOW_UPGRADE === '1' || UPGRADE_READY) {
  PAGES.find((p) => p.id === 'upgrade').hidden = false;
  SECTIONS.find((s) => s.id === 'team').pages.push('upgrade');
}
// Sync sits under Settings once paid plans can work (the same pinned key):
// before that it could only show an upsell to a plan nobody can buy.
// PLEXIFORM_SHOW_SYNC=1 lists it for testing.
if (process.env.PLEXIFORM_SHOW_SYNC === '1' || UPGRADE_READY) {
  PAGES.find((p) => p.id === 'sync').hidden = false;
  SECTIONS.find((s) => s.id === 'settings').pages.push('sync');
}

// PLEXIFORM_SHOW_PLANNER=0 takes Calendar and Timeline off the sub-nav; the pages and deep links stay.
if (process.env.PLEXIFORM_SHOW_PLANNER === '0') { const board = SECTIONS.find((s) => s.id === 'board'); board.pages = board.pages.filter((id) => id !== 'board:calendar' && id !== 'board:timeline'); }

/** The sections as this platform shows them: macOnly pages are left out elsewhere. */
function sectionsFor(platform = process.platform, sections = SECTIONS) {
  return sections.map((s) => ({ ...s, pages: s.pages.filter((id) => platform === 'darwin' || !pageById(id)?.macOnly) }));
}

function flat(pages = PAGES) {
  const out = [];
  for (const p of pages) { out.push(p); for (const c of p.children ?? []) out.push({ ...c, parent: p.id }); }
  return out;
}

/** The section a page lives in (a board view lives with the board). */
function sectionOf(id, sections = SECTIONS) {
  const parent = flat().find((p) => p.id === id)?.parent;
  return sections.find((s) => s.pages.includes(id) || (parent && s.pages.includes(parent)))?.id ?? null;
}

function pageById(id, pages = PAGES) {
  return flat(pages).find((p) => p.id === id) ?? null;
}

// The hub page URL for a board view. The web app reads ?view= on load, and
// ?org= picks the team on a hub where the member is in several.
function hubPageUrl(base, page, { org = null, fragment = null } = {}) {
  const u = new URL(base);
  u.pathname = '/';
  u.search = '';
  if (org) u.searchParams.set('org', org);
  if (page?.view && page.view !== 'board') u.searchParams.set('view', page.view);
  if (fragment !== null) {
    if (!fragmentOk(fragment)) throw new Error('bad fragment');
    u.hash = fragment;
  }
  return u.toString();
}

// A fragment never leaves the browser (the server never sees it), so the desktop can hand a hub page
// a small payload without any bridge into the sandboxed view. Only the one named key, base64url.
// plexiform-feedback: a saved report (large); plexiform-budget: a card id for the budget notice (tiny).
const FRAGMENT_RE = /^(?:plexiform-feedback=[A-Za-z0-9_-]{1,32768}|plexiform-budget=[A-Za-z0-9_-]{1,512})$/;
const fragmentOk = (f) => typeof f === 'string' && FRAGMENT_RE.test(f);

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

const CONNECT_PREFIX = 'plexiform-connect';
const PROVIDER_RE = /^[a-z0-9-]{2,32}$/;
const BIND_RE = /^[A-Za-z0-9_-]{1,64}$/;
// A browser's transient user activation lasts about this long too.
const GESTURE_MS = 5000;
const BIND_COOKIE_S = 600;

/** `plexiform-connect|<provider>|<bind>` → {provider, bind}, or null for anything else. */
function parseConnectName(name) {
  const parts = String(name ?? '').split('|');
  if (parts.length !== 3 || parts[0] !== CONNECT_PREFIX) return null;
  const [, provider, bind] = parts;
  return PROVIDER_RE.test(provider) && BIND_RE.test(bind) ? { provider, bind } : null;
}

/** A provider's authorize page: https on a public name, never loopback, private, a private-use suffix or any IP literal. */
function connectUrlOk(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  // `localhost.` is loopback too, so a trailing dot is refused before the suffix checks.
  if (h.startsWith('[') || h.endsWith('.') || !h.includes('.') || /^[\d.]+$/.test(h) || isPrivateHost(h)) return false;
  return !/(^|\.)(localhost|local|internal|home\.arpa)$/.test(h);
}

/**
 * A window.open from the hub view. The Integrations page opens a provider's
 * sign-in as `window.open(url, 'plexiform-connect|<provider>|<bind>', 'noopener')`:
 * that (https only) may get the in-app connect window, once connectDecision
 * agrees; any other connect-looking name (and the old `buddy-connect`) opens
 * nothing; everything else is navDecision's call.
 */
function openDecision({ url, frameName }, opts) {
  const name = String(frameName ?? '');
  if (name === 'buddy-connect' || name.startsWith(CONNECT_PREFIX)) return parseConnectName(name) && connectUrlOk(url) ? 'connect' : 'deny';
  const d = navDecision(url, opts);
  return d === 'allow' ? 'deny' : d;
}

// GitHub's App-manifest flow is the one connect that starts with a POST: the
// Integrations page's form (connect.manifestForm in the GitHub connector)
// posts a single `manifest` field to one of these two pages, with the hub's state.
const MANIFEST_PATH_RE = /^\/(?:organizations\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/)?settings\/apps\/new$/;
const MANIFEST_STATE_RE = /^[A-Za-z0-9_.-]{16,1024}$/;
const MANIFEST_BODY_MAX = 64 * 1024;
const MANIFEST_JSON_MAX = 16 * 1024;
const MANIFEST_KEYS = new Set(['name', 'url', 'hook_attributes', 'redirect_url', 'callback_urls', 'public', 'default_permissions', 'default_events']);
const MANIFEST_REQUIRED = ['name', 'url', 'hook_attributes', 'redirect_url'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,33}$/;
const SLUG_RE = /^[a-z][a-z_]{0,49}$/;
const WEBHOOK_PATH_RE = /^\/integrations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/webhook$/;
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function manifestUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hostname !== 'github.com' || u.hash || !MANIFEST_PATH_RE.test(u.pathname)) return null;
  const keys = [...u.searchParams.keys()];
  const state = u.searchParams.get('state');
  if (keys.length !== 1 || keys[0] !== 'state' || !MANIFEST_STATE_RE.test(state ?? '')) return null;
  const out = `https://github.com${u.pathname}?state=${state}`;
  return u.href === out ? out : null;
}

// The webhook URL the registry mints (webhookFor): the hub's own origin, nothing else in it.
function hubWebhookOk(v, hubOrigin) {
  if (typeof v !== 'string' || v.length > 512) return false;
  let u;
  try { u = new URL(v); } catch { return false; }
  return u.origin === hubOrigin && WEBHOOK_PATH_RE.test(u.pathname) && v === `${hubOrigin}${u.pathname}`;
}

/** The manifest object, rebuilt from checked values only, or null. */
function cleanManifest(m, { hubOrigin, provider }) {
  if (!plain(m)) return null;
  const keys = Object.keys(m);
  if (keys.some((k) => !MANIFEST_KEYS.has(k)) || MANIFEST_REQUIRED.some((k) => !keys.includes(k))) return null;
  const redirect = `${hubOrigin}/integrations/${provider}/callback`;
  const out = {};
  for (const k of keys) {
    const v = m[k];
    let ok = false;
    if (k === 'name') ok = typeof v === 'string' && NAME_RE.test(v);
    else if (k === 'url') ok = typeof v === 'string' && v.length <= 2048 && connectUrlOk(v);
    else if (k === 'redirect_url') ok = v === redirect;
    else if (k === 'callback_urls') ok = Array.isArray(v) && v.length >= 1 && v.length <= 5 && v.every((x) => x === redirect);
    else if (k === 'public') ok = v === false;
    else if (k === 'hook_attributes') ok = plain(v) && Object.keys(v).every((x) => x === 'url' || x === 'active') && hubWebhookOk(v.url, hubOrigin) && (!('active' in v) || typeof v.active === 'boolean');
    // The GitHub connector asks for read access only, and refuses an app that got more.
    else if (k === 'default_permissions') ok = plain(v) && Object.keys(v).length <= 50 && Object.entries(v).every(([p, a]) => SLUG_RE.test(p) && a === 'read');
    else if (k === 'default_events') ok = Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string' && SLUG_RE.test(x));
    if (!ok) return null;
    out[k] = k === 'hook_attributes' ? { ...v } : Array.isArray(v) ? [...v] : plain(v) ? { ...v } : v;
  }
  return out;
}

/**
 * A form POST from the Integrations page to the connect window: only GitHub's
 * App-manifest page with the hub's state, and only a urlencoded body holding
 * one `manifest` field whose JSON names this hub's own callback and webhook.
 * The body is re-encoded from the checked values, never forwarded as sent.
 * → {ok:true, url, postData, extraHeaders} or {ok:false, reason}; the reason
 * is a fixed word, so nothing from the body reaches a log.
 */
function manifestPost({ url, postBody, hubOrigin, provider }) {
  const refuse = (reason) => ({ ok: false, reason });
  if (provider !== 'github') return refuse('post-provider');
  const target = manifestUrl(url);
  if (!target) return refuse('post-url');
  if (!postBody || typeof postBody !== 'object' || !Array.isArray(postBody.data) || String(postBody.contentType ?? '').trim().toLowerCase() !== 'application/x-www-form-urlencoded') return refuse('post-body');
  const chunks = [];
  let size = 0;
  for (const d of postBody.data) {
    if (!d || d.type !== 'rawData' || !(d.bytes instanceof Uint8Array)) return refuse('post-body');
    size += d.bytes.length;
    if (size > MANIFEST_BODY_MAX) return refuse('post-body');
    chunks.push(d.bytes);
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { return refuse('post-body'); }
  if (!/^[\x21-\x7e]+$/.test(text)) return refuse('post-body');
  const form = new URLSearchParams(text);
  const names = [...form.keys()];
  if (names.length !== 1 || names[0] !== 'manifest') return refuse('post-body');
  const raw = form.get('manifest');
  if (Buffer.byteLength(raw) > MANIFEST_JSON_MAX) return refuse('manifest');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return refuse('manifest'); }
  const manifest = cleanManifest(parsed, { hubOrigin, provider });
  if (!manifest) return refuse('manifest');
  const body = new URLSearchParams([['manifest', JSON.stringify(manifest)]]).toString();
  return { ok: true, url: target, postData: [{ type: 'rawData', bytes: Buffer.from(body) }], extraHeaders: 'Content-Type: application/x-www-form-urlencoded' };
}

/**
 * Every guard on a connect open, in one place: the hub view's own page (the
 * signed-in account hub's Integrations view, and a referrer, when sent, from
 * that origin), a click or key press on it within GESTURE_MS, and a public
 * https URL; a form POST also passes manifestPost.
 * → {ok:true, provider, bind[, post]} or {ok:false, reason}.
 */
function connectDecision({ url, frameName, referrer = '', postBody = null, pageUrl, hubOrigin, signedIn, gestureAt = 0, now = Date.now() }) {
  const c = parseConnectName(frameName);
  if (!c) return { ok: false, reason: 'name' };
  if (!signedIn) return { ok: false, reason: 'signed-out' };
  let page;
  try { page = new URL(pageUrl); } catch { return { ok: false, reason: 'opener' }; }
  // The Integrations view lives at / (hubPageUrl): any other path on the hub (a callback or static page) is not it.
  if (page.origin !== hubOrigin || page.pathname !== '/' || page.searchParams.getAll('view').join() !== 'integrations') return { ok: false, reason: 'opener' };
  if (referrer) { try { if (new URL(referrer).origin !== hubOrigin) return { ok: false, reason: 'opener' }; } catch { return { ok: false, reason: 'opener' }; } }
  if (!(gestureAt > 0 && now - gestureAt >= 0 && now - gestureAt <= GESTURE_MS)) return { ok: false, reason: 'gesture' };
  if (!connectUrlOk(url)) return { ok: false, reason: 'url' };
  if (postBody == null) return { ok: true, ...c };
  const post = manifestPost({ url, postBody, hubOrigin, provider: c.provider });
  if (!post.ok) return post;
  return { ok: true, ...c, post: { url: post.url, postData: post.postData, extraHeaders: post.extraHeaders } };
}

/**
 * The bind cookie the hub's callback reads, set on the hub origin in the
 * connect window's partition before the provider page loads. https hubs get
 * the __Host- form (Secure, Path=/, no Domain); http dev/local hubs the plain
 * one on /integrations/. Both HttpOnly, SameSite=Lax, 10 minutes.
 */
function bindCookie(hubOrigin, provider, bind, nowMs = Date.now()) {
  // Checked again here, not only in parseConnectName: this is the one place a cookie is minted.
  let o = null;
  try { o = new URL(hubOrigin); } catch { /* refused below */ }
  if (!o || !/^https?:$/.test(o.protocol) || o.origin !== hubOrigin || typeof provider !== 'string' || typeof bind !== 'string' || !PROVIDER_RE.test(provider) || !BIND_RE.test(bind)) throw new Error('bad bind cookie');
  const secure = o.protocol === 'https:';
  const name = secure ? `__Host-board_int_${provider}` : `board_int_${provider}`;
  const cookiePath = secure ? '/' : '/integrations/';
  return { url: `${hubOrigin}${cookiePath}`, name, value: bind, path: cookiePath, secure, httpOnly: true, sameSite: 'lax', expirationDate: Math.floor(nowMs / 1000) + BIND_COOKIE_S };
}

/** The hub view's user agent with the app's token, which the board web looks for before it names a connect window. */
function appUserAgent(ua, version) {
  const s = String(ua ?? '');
  return /(^| )Plexiform\//.test(s) ? s : `${s} Plexiform/${version}`.trim();
}

/** Has the connect window come back to the hub's integration callback page? */
function isConnectCallback(url, hubOrigin) {
  try {
    const u = new URL(url);
    return u.origin === hubOrigin && /^\/integrations\/[a-z0-9_-]{1,40}\/callback\/?$/i.test(u.pathname);
  } catch { return false; }
}

/** May the connect window go here? A public https page (the provider's hops) or the hub's own callback, nothing else. */
function connectNavOk(url, hubOrigin) {
  return connectUrlOk(url) || isConnectCallback(url, hubOrigin);
}

// ── Chat-first redirects (redesign R1; plan-redesign §R2.5) ─────────────────
// Everything below is consulted only when the dev-only chat preview is on
// (index.js passes chatFirst). With it off, ids resolve exactly as before:
// none of these lists is read by select(), the sidebar or the menus.

// The account flows open through goTo(), not select(); they are not pages.
const FLOW_IDS = Object.freeze(['signin', 'join', 'create-team']);

// Documents the redesign adds later (§R4.5.9). They are deliberately not in
// PAGES: pageById() stays null for them, so selecting one is still a no-op.
// Each moves into PAGES in the PR that builds it.
const FUTURE_IDS = Object.freeze(['sidebar', 'newchat', 'thread']);

// Destinations that are not page ids at all: the ⌘K palette document and the
// Library sheet (R14). Named so the redirect table can say where an id goes.
const DESTINATIONS = Object.freeze(['palette', 'library']);

// The sidebar filters a redirect can land on (focus the tree, set the filter).
const SIDEBAR_FILTERS = Object.freeze(['all', 'needs', 'terminals', 'chats', 'team']);

// The bucket groups a person can collapse in the chat-first sidebar (Needs
// you never collapses), and the default: Idle starts collapsed.
const COLLAPSIBLE = Object.freeze(['working', 'check', 'stuck', 'idle']);
const DEFAULT_COLLAPSED = Object.freeze(['idle']);
/** A saved or sent collapsed list → a clean one, or null when it is not one. */
function sidebarCollapsed(v) {
  if (!Array.isArray(v) || v.length > COLLAPSIBLE.length || !v.every((x) => COLLAPSIBLE.includes(x))) return null;
  return COLLAPSIBLE.filter((x) => v.includes(x));
}

// Where every page id goes once the redesign is on, from the §R2.5 table.
//   { keep: true }            the page stays.
//   { sidebar: <filter> }     focus the sidebar with that filter (built in R1).
//   { to, pane|tab, until }   a destination that `until` names the PR for; not built yet.
//   bySession                 with a session the id opens that thread (R2); without one, `otherwise`.
const R8 = 'R8', R7 = 'R7', R2 = 'R2';
const settings = (pane) => Object.freeze({ to: 'settings', pane, until: R8 });
const REDIRECTS = Object.freeze({
  home: { to: 'newchat' },
  overview: { sidebar: 'all' },
  waiting: { sidebar: 'needs' },
  myday: { to: 'newchat' },
  sessions: { sidebar: 'terminals' },
  timeline: { to: 'thread', bySession: true, otherwise: { sidebar: 'terminals' }, until: R2 },
  checkpoints: { to: 'thread', pane: 'changes', bySession: true, otherwise: { to: 'palette', query: 'changes in' }, until: R2 },
  memory: { to: 'palette', until: 'palette' },
  tasks: { to: 'thread', bySession: true, otherwise: { to: 'newchat' }, until: R2 },
  discover: { to: 'library', until: 'R14' },
  'agents-find': { to: 'library', until: 'R14' },
  board: { keep: true },
  'board:table': { keep: true },
  'board:history': { keep: true },
  'board:dashboard': { keep: true },
  'board:calendar': { keep: true },
  'board:timeline': { keep: true },
  integrations: settings('account-team/integrations'),
  team: { keep: true },
  usage: { keep: true },
  stats: { to: 'usage', tab: 'stats', until: R7 },
  optimiser: { to: 'usage', tab: 'burst', until: R7 },
  clients: { to: 'usage', tab: 'clients', until: R7 },
  setups: settings('advanced/setups'),
  thismac: settings('general'),
  phone: settings('phone'),
  account: settings('account-team'),
  upgrade: settings('account-team/plan'),
  sync: settings('account-team/sync'),
  widget: settings('widget'),
  lights: settings('widget/when-to-light-up'),
  aitools: settings('ai-tools'),
  settings: settings('general'),
  hatch: settings('widget/character'),
  help: { keep: true },
  feedback: { keep: true },
  updates: { keep: true },
  signin: { keep: true },
  join: { keep: true },
  'create-team': { keep: true },
});

/**
 * Where a select() of `id` goes. Returns { page } (open that page id),
 * { sidebar } (focus the sidebar with that filter) or { newchat: true } (the
 * new-chat screen, R7-1); never more than one hop.
 * Gate off, or a select that came from the sidebar itself, is the identity.
 * Anything whose destination is not built yet (it has `until`) stays put.
 */
function resolve(id, { chatFirst = false, from = null } = {}) {
  const stay = { page: id };
  if (!chatFirst || from === 'sidebar') return stay;
  const r = REDIRECTS[id];
  if (!r || r.keep || r.until) return stay;
  if (r.sidebar) return { sidebar: r.sidebar };
  if (r.to === 'newchat') return { newchat: true }; // R7-1: Home and My day
  return stay;
}

// A section is a valid target with the preview on: it opens its default.
// Page ids win the bare name, so the one section whose id is also a page with
// a different default (`sessions`, default overview) is addressed internally
// as `section:sessions`.
const SECTION_PREFIX = 'section:';
function sectionTarget(id, sections = SECTIONS) {
  const bare = typeof id === 'string' && id.startsWith(SECTION_PREFIX) ? id.slice(SECTION_PREFIX.length) : null;
  if (bare === null && pageById(id)) return null; // a page id: not a section target
  const s = sections.find((x) => x.id === (bare ?? id));
  return s ? s.default : null;
}
/** The id a section is addressed by: its own id, or `section:<id>` when a page owns that name with another default. */
const sectionAddress = (s) => (pageById(s.id) && s.default !== s.id ? SECTION_PREFIX + s.id : s.id);

/** Which sidebar entry does a hub URL correspond to (for in-page view switches)? */
function pageForHubUrl(url) {
  let v = null;
  try { v = new URL(url).searchParams.get('view'); } catch { return 'board'; }
  const hit = flat().find((p) => p.kind === 'hub' && p.view === (v || 'board'));
  return hit?.id ?? 'board';
}

module.exports = { PAGES, GROUPS, SECTIONS, FOOTER, FLOW_IDS, FUTURE_IDS, DESTINATIONS, SIDEBAR_FILTERS, COLLAPSIBLE, DEFAULT_COLLAPSED, sidebarCollapsed, REDIRECTS, resolve, sectionTarget, sectionAddress, sectionsFor, sectionOf, flat, pageById, SETTINGS_PANES, RULES_PANE, paneById, hubPageUrl, fragmentOk, navDecision, openDecision, connectDecision, manifestPost, parseConnectName, connectUrlOk, connectNavOk, bindCookie, appUserAgent, isConnectCallback, pageForHubUrl, orgOfUrl, GESTURE_MS };
