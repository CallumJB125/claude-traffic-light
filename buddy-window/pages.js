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
//             picks the account page's screen (account.html), `file` +
//             `preload` (in the app root) name a page of their own.
//   soon    — named in the plan but not built yet; says so honestly.
'use strict';

const { NAME } = require('./brand');
const { isPrivateHost } = require('./workspaces');

const PAGES = [
  { id: 'board', title: 'Board', icon: 'board', kind: 'hub', view: 'board', group: 'work',
    children: [
      { id: 'board:table', title: 'Table', kind: 'hub', view: 'table' },
      { id: 'board:dashboard', title: 'Dashboard', kind: 'hub', view: 'dashboard' },
      { id: 'board:calendar', title: 'Calendar', kind: 'soon' },
      { id: 'board:timeline', title: 'Timeline', kind: 'soon' },
    ] },
  { id: 'waiting', title: 'Waiting on you', icon: 'bell', kind: 'local', file: 'waiting.html', preload: 'waiting-preload.js', query: { embedded: '1' }, group: 'work' },
  { id: 'myday', title: 'My day', icon: 'sun', kind: 'soon', group: 'work', blurb: 'Your cards, what is waiting on you, your agents and your calendar in one place.' },
  { id: 'tasks', title: 'Tasks', icon: 'tasks', kind: 'soon', group: 'work', blurb: `Standalone Claude tasks you started from ${NAME}, with their messages. Being built by buddy-builder-2.` },
  // localScreen: the account page's explainer for the local board, which has no integrations of its own.
  { id: 'integrations', title: 'Integrations', icon: 'plug', kind: 'hub', view: 'integrations', localScreen: 'integrations', group: 'team' },
  { id: 'team', title: 'Team', icon: 'team', kind: 'local', screen: 'team', group: 'team' },
  { id: 'usage', title: 'Usage', icon: 'chart', kind: 'window', window: 'mix', group: 'you' },
  { id: 'setups', title: 'Setups', icon: 'layers', kind: 'soon', group: 'you', blurb: 'Borrow a teammate’s Claude setup. Being built by buddy-builder-4.' },
  { id: 'plugins', title: 'Plugins', icon: 'puzzle', kind: 'soon', group: 'you', blurb: 'Find and install Claude Code plugins.' },
  { id: 'thismac', title: 'This Mac', icon: 'laptop', kind: 'local', screen: 'thismac', group: 'you' },
  { id: 'account', title: 'Account', icon: 'user', kind: 'local', screen: 'account', group: 'you' },
  { id: 'lights', title: 'Lights', icon: 'lights', kind: 'window', window: 'lights', group: 'you' },
  { id: 'settings', title: 'Settings', icon: 'gear', kind: 'window', window: 'settings', group: 'you' },
  { id: 'updates', title: 'About & Updates', icon: 'info', kind: 'local', file: 'updates.html', preload: 'updates-preload.js', group: 'you' },
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
const FRAGMENT_RE = /^plexiform-feedback=[A-Za-z0-9_-]{1,32768}$/;
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

/** Which sidebar entry does a hub URL correspond to (for in-page view switches)? */
function pageForHubUrl(url) {
  let v = null;
  try { v = new URL(url).searchParams.get('view'); } catch { return 'board'; }
  const hit = flat().find((p) => p.kind === 'hub' && p.view === (v || 'board'));
  return hit?.id ?? 'board';
}

module.exports = { PAGES, GROUPS, flat, pageById, hubPageUrl, fragmentOk, navDecision, openDecision, connectDecision, manifestPost, parseConnectName, connectUrlOk, connectNavOk, bindCookie, appUserAgent, isConnectCallback, pageForHubUrl, orgOfUrl, GESTURE_MS };
