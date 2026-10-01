// HTTP: static web/shared (CONTRACT §5.1), the JSON API (§5.2), member auth
// (Access JWT, the loopback dev cookie, the local-mode cookie, or in accounts
// mode a desktop device token / web cookie session), CSRF guards (JSON content
// type, same-origin; plus Origin + X-CSRF-Token for accounts cookie sessions),
// the (member, request_id) replay cache (D8) and WS upgrades.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { PROTOCOL_VERSION, PROTOCOL_HEADER, httpStatus, WS_CLOSE, WS_PATHS } from '../shared/protocol.js';
import { HubError } from './db.js';
import { devCookieValue, parseCookies, parseDevCookie, safeEqual } from './auth.js';
import { isExposed, isLoopback } from './config.js';
import { publicMember } from './api.js';
import { LOCAL_ONLY, selectedContext } from './views.js';
import { BrowserConn } from './ws-board.js';
import { RunnerConn, authenticateRunner } from './ws-runner.js';
import { clientIp, failBucketKey, ipKey, limitOrThrow } from './ratelimit.js';
import { redact } from './log.js';
import { appendCookie } from './identity/accounts.js';
import { BRAND } from '../shared/brand.js';
import { CLIENT_UPLOAD_BODY_MAX } from './identity/client-artifacts.js';
import { searchWork } from './search.js';
import { teamOverview } from './team-overview.js';
import { Workflows } from './workflows.js';
import { TeamCommunication } from './communication.js';
import { WorkCapture } from './work-capture.js';
import { Planning } from './planning.js';
import { Setups } from './setups.js';
import { SETUP_BODY_MAX } from '../shared/setups.js';
import { myDay } from './my-day.js';

const MAX_BODY = 1024 * 1024;
// Every request's ceilings (D105); config.requestLimits overrides them (tests, no env).
// The body deadline runs from when the API starts reading and ends before the
// server's own request timeout, so a slow body gets the hub's 408 and a cut socket.
// Keep-alive outlasts cloudflared's idle origin pool (90 s): the proxy, the only
// client on loopback, always drops an idle connection before the hub does, so
// it never sends a request down a socket the hub is closing (a 502). Node runs
// the headers/request timeouts only while a request is in progress, never on
// an idle connection, so they stay short.
export const REQUEST_LIMITS = Object.freeze({
  requestTimeoutMs: 30_000, headersTimeoutMs: 15_000, keepAliveTimeoutMs: 120_000, checkIntervalMs: 1_000,
  bodyDeadlineMs: 20_000, smallBodyMax: 64 * 1024,
});
// Card bodies (create, patch, actions, comments, permission answers) keep 1 MiB; every other API body is capped at smallBodyMax.
const bigBodyRoute = (pattern) => pattern === '/api/boards/:board_id/cards' || pattern.startsWith('/api/cards/') || pattern.startsWith('/api/permission-requests/');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const requestBinding = (route, params, body) => createHash('sha256').update(JSON.stringify({ method: route.method, route: route.pattern, params, body }, (_key, value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value)).digest('hex');
// The prepare body carries an admin's pasted configuration token (D97), and a
// /start answer a signed state, bind and the org it was given: their D8 replay
// entry is this, never the first answer.
const PREPARE_REPLAY = Object.freeze({ status: 409, body: { error: { code: 'CONFLICT', message: 'This request was already sent. Reload the page.', reason: 'REPLAYED' } } });
// An invite's answer is its link and code, shown once: the replay entry never holds them.
const INVITE_REPLAY = Object.freeze({ status: 409, body: { error: { code: 'CONFLICT', message: 'This invite was already made. Resend it to get a new link.', reason: 'REPLAYED' } } });
const SHARED_BROWSER = new Set(['states', 'liveness', 'fence', 'scope', 'overlap', 'cardface', 'handover', 'protocol', 'brand', 'ai', 'planning']);
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' https://avatars.githubusercontent.com; style-src 'self'; script-src 'self'; frame-ancestors 'none'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8' };

// Dev auth trusts a loopback peer. A request that passed through a proxy or
// tunnel still arrives from loopback, so refuse anything that carries proxy
// headers or names a non-loopback Host (on top of the config guard).
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'cf-access-jwt-assertion', 'x-forwarded-for', 'forwarded'];
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const devRequestOk = (req) => LOOPBACK_HOST.test(req.headers.host ?? '') && !PROXY_HEADERS.some((h) => req.headers[h] != null);
// Accounts mode without a public URL or tunnel is a loopback try-out (L-A): the same rule.
const loopbackOnly = (config) => config.auth === 'dev' || config.auth === 'local' || (config.auth === 'accounts' && !isExposed(config));
// Accounts mode: pages served without auth (their JS talks to /api/auth/*;
// tokens ride in the URL fragment, which never reaches the server).
const ACCOUNT_PAGES = { '/signin': 'signin.html', '/auth/email': 'signin.html', '/invite': 'invite.html', '/clients': 'clients.html', '/client-invite': 'client-invite.html' };

// A cookie-session mutation or WS upgrade in accounts mode (design §4.6): the
// Origin must be present and be this hub; Sec-Fetch-Site, when sent, same-origin.
export function strictOrigin(req, publicUrl) {
  const o = req.headers.origin;
  if (!o) return false;
  const site = req.headers['sec-fetch-site'];
  if (site != null && site !== 'same-origin') return false;
  try {
    return publicUrl ? new URL(publicUrl).origin === o : new URL(o).host === req.headers.host;
  } catch {
    return false;
  }
}
// Local auth (D35): every browser request carries the per-launch secret cookie.
// (parseCookies throws on a malformed %-escape: that is just "no".)
const localCookieOk = (hub, req) => {
  try { return safeEqual(parseCookies(req.headers.cookie).board_local ?? '', hub.localSecret); } catch { return false; }
};

// Webhook bodies are read before any signature is checked, so what an
// unverified sender can hold is bounded by count and time: in-flight reads
// per (connection, IP), per IP (over every connection) and per connection,
// and a deadline for the whole body (slowloris). A pair that delivered a
// new verified webhook recently (from its /24 or /48: providers send from
// pools), or an address in the connector's ingressCidrs, skips the
// per-connection cap, so a flood from fresh addresses can't crowd out the
// provider's own. A webhook body is small and sent at once, hence the short
// deadline. Every id that is not a live connection (the sender picks it, D97)
// shares one perUnknown slot pool, or random ids would each get a perConn of
// their own and only perIp would bound memory. config.webhookReads overrides.
const WEBHOOK_READS = Object.freeze({ perPair: 4, perIp: 8, perConn: 16, perUnknown: 32, deadlineMs: 3_000, verifiedMs: 15 * 60_000, verifiedMax: 10_000 });

// failBucketKey's key → the network a vetted sender vouches for.
const vetBucketKey = (key) => {
  const v4 = /^(\d+\.\d+\.\d+)\.\d+$/.exec(key);
  if (v4) return `${v4[1]}.0/24`;
  const v6 = /^([^:]+:[^:]+:[^:]+):[^:]+::\/64$/.exec(key);
  return v6 ? `${v6[1]}::/48` : key;
};

// A body still on the wire when the answer goes out: the answer says
// Connection: close, so a proxy that pools origin connections (cloudflared)
// never sends another request down a socket that is about to be cut.
function closeIfUnread(res) {
  const req = res.req;
  if (req && !req.complete && (req.headers['transfer-encoding'] != null || Number(req.headers['content-length'] ?? 0) > 0)) res.shouldKeepAlive = false;
}

// An answer given before the body was read (refused, too large, too slow) is
// not followed by draining the rest at the sender's pace: the socket goes a
// moment later. Node would close a Connection: close socket the moment the
// answer is out, which resets a sender still writing its body before it
// reads the answer (cloudflared then shows a 502): our side is ended, the
// rest drained for that moment, then cut.
const CURRENT = Symbol('current request');
function cutIfUnread(req, res) {
  const sock = req.socket;
  res.once('finish', () => {
    if (req.complete || !sock) return;
    if (!res.shouldKeepAlive) sock.removeListener('finish', sock.destroy);
    setTimeout(() => { if (!res.shouldKeepAlive || (!req.complete && sock[CURRENT] === req)) sock.destroy(); }, 1000).unref();
  });
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  closeIfUnread(res);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), ...headers });
  res.end(data);
}

// A connector's early webhook ack (text or pre-serialised JSON, ≤ 4 KiB):
// never rendered as a page, never framed.
function sendRaw(res, status, type, data, headers = {}) {
  closeIfUnread(res);
  res.writeHead(status, {
    'content-type': type, 'content-length': String(Buffer.byteLength(data)), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), ...headers,
  });
  res.end(data);
}

// Dispatch-like actions start paid agent runs: a tighter per-member limit.
export const DISPATCH_ACTIONS = new Set(['dispatch', 'retry', 'take_over_with_claude']);

const retryHeader = (e) => (e.code === 'RATE_LIMITED' && e.extra?.retry_after_s ? { 'retry-after': String(e.extra.retry_after_s) } : {});

function errorBody(e) {
  const { code, message, extra = {} } = e;
  return { error: { code, message, ...extra } };
}

export function sameOrigin(req, publicUrl) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    if (publicUrl && new URL(publicUrl).origin === o) return true;
    return new URL(o).host === req.headers.host;
  } catch {
    return false;
  }
}

// → {body} | {error: 413 | 408 | 'aborted'}; never waits past deadlineMs.
function readRaw(req, deadlineMs, max = MAX_BODY) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(r);
    };
    const t = setTimeout(() => finish({ error: 408 }), deadlineMs);
    req.on('data', (c) => {
      if (settled) return;
      n += c.length;
      if (n > max) finish({ error: 413 });
      else chunks.push(c);
    });
    req.on('end', () => finish({ body: Buffer.concat(chunks) }));
    req.on('error', () => finish({ error: 'aborted' }));
    req.on('close', () => finish({ error: 'aborted' }));
  });
}

const sizeText = (max) => (max >= MAX_BODY ? `${max / MAX_BODY} MiB` : `${max / 1024} KiB`);

async function readBody(req, { max, deadlineMs }) {
  if (Number(req.headers['content-length']) > max) throw new HubError('PAYLOAD_TOO_LARGE', `body over ${sizeText(max)}`);
  const got = await readRaw(req, deadlineMs, max);
  if (got.error === 413) throw new HubError('PAYLOAD_TOO_LARGE', `body over ${sizeText(max)}`);
  if (got.error === 408) throw new HubError('TIMEOUT', 'body not received in time');
  if (got.error) throw new HubError('VALIDATION', 'body not received');
  if (!got.body.length) return {};
  try {
    const v = JSON.parse(got.body.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new HubError('VALIDATION', 'body must be a JSON object');
  }
}

// The provider's redirect lands here in the connect window: text only, no
// script, nothing from the query echoed back. kind: ok | error.
const CONNECT_TITLE = { ok: 'Connected', error: 'Not connected' };
// `next`: {url, name}, a second step at the provider (an app install): the
// registry checked it is https on one of the connector's hosts.
function sendConnectPage(res, status, text, kind, headers = {}, next = null) {
  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const after = next
    ? `<p><a href="${esc(next.url)}" rel="noopener noreferrer">${esc(next.text)}</a></p>`
    : '<p>You can close this window and go back to Buddy.</p>';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${CONNECT_TITLE[kind]} · Buddy</title><meta name="viewport" content="width=device-width"></head><body data-connect="${kind}"><h1>${CONNECT_TITLE[kind]}</h1><p>${esc(text)}</p>${after}</body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'", 'cross-origin-opener-policy': 'same-origin', 'referrer-policy': 'no-referrer', 'board-protocol': String(PROTOCOL_VERSION), ...headers });
  res.end(body);
}

export function createHttpHandler({ hub, api, config, integrations = null }) {
  const workflows = new Workflows(hub);
  const communication = new TeamCommunication(hub);
  const workCapture = new WorkCapture(hub);
  const planning = new Planning(api);
  const setups = hub.setups = new Setups(api);
  // This query can only narrow current staff access. Desktop grants derive it
  // privately in main; remote grants additionally require their own guard.
  const communicationOptions = (query) => query.has('board_id') ? { boardIds: Object.freeze(query.getAll('board_id')) } : {};
  // Where providers send people back: the public URL, or (dev/local only) this loopback hub.
  const publicBase = (req) => {
    if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
    // Only loopback hubs may use the request's Host: a public hub needs a fixed URL.
    if (config.auth === 'dev' || config.auth === 'local') return `http://${req.headers.host}`;
    throw new HubError('POLICY_DENIED', 'set BOARD_PUBLIC_URL to connect integrations');
  };
  const etags = new Map();
  // Without a form-action directive any form may post anywhere (it does not
  // fall back to default-src): a hub with a manifest connector names exactly
  // the hosts its connect forms post to.
  const webCsp = () => {
    const hosts = integrations?.formHosts() ?? [];
    return hosts.length ? `${CSP}; form-action 'self' ${hosts.map((x) => `https://${x}`).join(' ')}` : CSP;
  };
  const readLimits = { ...WEBHOOK_READS, ...config.webhookReads };
  const limits = { ...REQUEST_LIMITS, ...config.requestLimits };
  let clientUploads = 0; // reading, decoding or waiting for the board queue
  let setupUploads = 0;
  const reading = { pair: new Map(), ip: new Map(), conn: new Map() }; // key → webhook body reads in flight
  const verifiedPairs = new Map(); // (connection|/24 or /48) → hub mono ms until which it skips the per-connection cap
  // Never framed (the desktop app's view is a window, not an iframe); HSTS once served over https.
  const hsts = (() => { try { return new URL(config.publicUrl).protocol === 'https:'; } catch { return false; } })();


  const authMember = makeAuthMember({ hub, config });
  // The org a request's resource lives in: decides which member row answers
  // when one sign-in belongs to several orgs.
  // undefined = the route names no resource; null = it names one that
  // doesn't exist (or whose team was deleted).
  const resourceOrg = (r, params) => {
    const boardOrg = (boardId) => hub.board(boardId)?.org_id ?? null;
    if (params.team_id) return hub.db.get('SELECT id FROM orgs WHERE id = ? AND deleted_at IS NULL', params.team_id)?.id ?? null;
    if (params.profile_id) return hub.db.get('SELECT p.org_id FROM setup_profiles p JOIN orgs o ON o.id=p.org_id WHERE p.id=? AND o.deleted_at IS NULL', params.profile_id)?.org_id ?? null;
    if (params.board_id) return boardOrg(params.board_id);
    if (params.card_id) { const c = hub.card(params.card_id); return c ? boardOrg(c.board_id) : null; }
    if (params.workflow_id) return hub.db.get('SELECT r.org_id FROM workflow_recipes r JOIN orgs o ON o.id = r.org_id WHERE r.id = ? AND o.deleted_at IS NULL', params.workflow_id)?.org_id ?? null;
    if (r.pattern.startsWith('/api/client-items/:item_id')) return hub.db.get('SELECT p.workspace_id FROM client_items i JOIN client_projects p ON p.id = i.project_id WHERE i.id = ?', params.item_id)?.workspace_id ?? null;
    if (r.pattern.startsWith('/api/client-approval-requests/:approval_id')) return hub.db.get('SELECT p.workspace_id FROM client_approval_requests a JOIN client_items i ON i.id = a.item_id JOIN client_projects p ON p.id = i.project_id WHERE a.id = ?', params.approval_id)?.workspace_id ?? null;
    if (r.pattern.startsWith('/api/permission-requests/')) {
      const p = hub.db.get('SELECT card_id FROM permission_requests WHERE id = ?', params.id);
      const c = p && hub.card(p.card_id);
      return c ? boardOrg(c.board_id) : null;
    }
    if (r.pattern.startsWith('/api/devices/')) return hub.member(hub.device(params.id)?.member_id)?.org_id ?? null;
    if (r.pattern.startsWith('/api/members/')) return hub.member(params.id)?.org_id ?? null;
    // A provider names no resource; a pending id (D97) is its team's, like a connection id.
    if (r.pattern === '/api/integrations/:target/prepare') return UUID_RE.test(params.target) ? integrations?.orgOf(params.target) ?? null : undefined;
    if (r.pattern.startsWith('/api/integrations/:id')) return integrations?.orgOf(params.id) ?? null;
    return undefined;
  };

  const routes = [];
  // Serialize cache-eligible requests sharing an actor and request ID until
  // their response is cached, including collisions across different routes.
  const requestsInFlight = new Map();
  const route = (method, pattern, handler, { auth = 'member', mutating = method !== 'GET', limit = null, replay = null, maxBody = null, collaboration = false, writeScope = null, responseGuard = null } = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler, auth, mutating, pattern, limit, replay, collaboration, writeScope, responseGuard, maxBody: maxBody ?? (bigBodyRoute(pattern) ? MAX_BODY : limits.smallBodyMax) });
  };

  // `mail` appears only on a hub that can send mail; it says when a send last failed, and whether
  // sends are failing in a row (email is then off in /api/auth/methods), never to whom or why.
  route('GET', '/api/health', () => ({ ok: true, protocol: PROTOCOL_VERSION, hub_epoch: hub.epoch, uptime_ms: Math.round(hub.uptime()), auth: config.auth, ...(hub.accounts?.mailer ? { mail: { last_error_at: hub.accounts.mailLastErrorAt, failing: hub.accounts.mailFailing() } } : {}) }), { auth: 'none' });
  // Registered only in dev mode (design §9.5): elsewhere it is "no such route".
  if (config.auth === 'dev') route('POST', '/api/dev/login', ({ req, body, res }) => {
    if (!isLoopback(normalizeAddr(req.socket.remoteAddress))) throw new HubError('NOT_FOUND', 'not found');
    if (!hub.devLoginSecret || !safeEqual(req.headers['board-dev-secret'] ?? '', hub.devLoginSecret)) throw new HubError('FORBIDDEN', 'dev login needs the Board-Dev-Secret printed when the hub started');
    if (String(body.github_login ?? '').startsWith(LOCAL_ONLY)) throw new HubError('NOT_FOUND', 'no such member');
    const m = hub.db.get('SELECT * FROM members WHERE github_login = ? ORDER BY created_at LIMIT 1', String(body.github_login ?? ''));
    if (!m) throw new HubError('NOT_FOUND', 'no such member');
    res.setHeader('set-cookie', `board_dev=${encodeURIComponent(devCookieValue(hub.secret, m.id))}; HttpOnly; SameSite=Strict; Path=/`);
    return { member: publicMember(m) };
  }, { auth: 'none' });
  if (config.auth === 'accounts') {
    const acc = hub.accounts;
    route('GET', '/api/auth/methods', ({ ip }) => acc.methods({ ip }), { auth: 'none' });
    route('POST', '/api/auth/email/start', ({ body, ip, ident, req, res }) => acc.start(body, { ip, ident, req, res }), { auth: 'optional' });
    route('POST', '/api/auth/email/verify', ({ body, ip, ident, req, res }) => acc.verify(body, { ip, ident, req, res }), { auth: 'optional' });
    // Google / GitHub through the desktop app's loopback listener (D76–D78).
    route('POST', '/api/auth/oauth/start', ({ body, ip, ident }) => hub.oauth.start(body, { ip, ident }), { auth: 'optional' });
    route('POST', '/api/auth/oauth/exchange', ({ body, ip, ident }) => hub.oauth.exchange(body, { ip, ident }), { auth: 'optional' });
    const browserOrigin = (req) => { if (!strictOrigin(req, config.publicUrl)) throw new HubError('FORBIDDEN', 'cross-origin browser sign-in'); };
    route('POST', '/api/auth/oauth/web/start', (ctx) => { browserOrigin(ctx.req); return hub.oauthWeb.start(ctx.body, ctx); }, { auth: 'none' });
    for (const provider of ['google', 'github']) route('GET', `/api/auth/oauth/web/${provider}/callback`, ({ query, ...ctx }) => hub.oauthWeb.callback(provider, query, ctx), { auth: 'none' });
    route('POST', '/api/auth/oauth/web/result', (ctx) => { browserOrigin(ctx.req); return hub.oauthWeb.result(ctx.body, ctx); }, { auth: 'optional', replay: false });
    route('POST', '/api/auth/signout', ({ ident, ip, res }) => acc.signout(ident, { ip, res }), { auth: 'user' });
    route('GET', '/api/account', ({ ident }) => acc.account(ident), { auth: 'user' });
    route('GET', '/api/work-capture/routes', ({ ident }) => workCapture.routes(ident.user.id, ident.cred), { auth: 'user', replay: false });
    route('DELETE', '/api/account', ({ ident, body, ip }) => acc.deleteAccount(ident, body, { ip }), { auth: 'user' });
    route('GET', '/api/account/devices', ({ ident }) => acc.listDevices(ident), { auth: 'user' });
    route('DELETE', '/api/account/devices/:id', ({ ident, params, ip }) => acc.revokeDevice(ident, params.id, { ip }), { auth: 'user' });
    // The older web asks /api/me: the account plus, once the user is in a
    // team, the legacy {member, org, boards} of the chosen one.
    route('GET', '/api/me', ({ ident, req, query }) => {
      const out = acc.account(ident);
      const cands = userMembers(hub, ident.user.id);
      const requestedOrg = requestedTeam(req, query);
      if (!cands.length && !requestedOrg) return { ...out, member: null, org: null, boards: [] };
      return { ...out, ...api.me(pickAccountMember(hub, cands, { requestedOrg })) };
    }, { auth: 'user' });
    // Teams and members (P2, D59–D62). The team comes from the URL; the
    // caller's membership in it is resolved before the handler runs.
    const teams = hub.teams;
    route('POST', '/api/account/setup', ({ ident, ip }) => teams.setup(ident, { ip }), { auth: 'user', replay: false });
    const clients = hub.clients;
    route('POST', '/api/client-workspaces', ({ ident, body, ip }) => clients.create(ident, body, { ip }), { auth: 'user', replay: false });
    route('GET', '/api/teams/:team_id/client-workspace', ({ member }) => clients.manage(member), { replay: false });
    route('POST', '/api/teams/:team_id/client-invites', ({ member, body, ip, req }) => clients.invite(member, body, { ip, req }), { replay: false });
    route('POST', '/api/teams/:team_id/client-invites/:invite_id/resend', ({ member, params, ip, req }) => clients.resend(member, params.invite_id, { ip, req }), { replay: false });
    route('DELETE', '/api/teams/:team_id/client-invites/:invite_id', ({ member, params, ip }) => clients.revokeInvite(member, params.invite_id, { ip }), { replay: false });
    route('PATCH', '/api/teams/:team_id/client-guests/:guest_id', ({ member, params, body, ip }) => clients.setGuest(member, params.guest_id, body, { ip }), { replay: false });
    route('DELETE', '/api/teams/:team_id/client-guests/:guest_id', ({ member, params, ip }) => clients.revokeGuest(member, params.guest_id, { ip }), { replay: false });
    route('POST', '/api/boards/:board_id/client-project', ({ member, params, body, ip, ident }) => clients.addProject(member, params.board_id, body, { ip, cred: ident.cred }), { replay: false });
    route('POST', '/api/boards/:board_id/client-items', ({ member, params, body, ip, ident }) => clients.publish(member, params.board_id, body, { ip, cred: ident.cred }), { replay: false });
    route('DELETE', '/api/client-items/:item_id', ({ member, params, ip, ident }) => clients.unpublish(member, params.item_id, { ip, cred: ident.cred }), { replay: false });
    route('POST', '/api/client-invites/preview', ({ body, ip }) => clients.preview(body, { ip }), { auth: 'none' });
    route('POST', '/api/client-invites/accept', ({ ident, body, ip }) => clients.accept(ident, body, { ip }), { auth: 'user', replay: false });
    route('GET', '/api/client/workspaces', ({ ident }) => ({ workspaces: clients.catalog(ident.user) }), { auth: 'user', replay: false });
    route('GET', '/api/client/workspaces/:workspace_id/projects', ({ ident, params }) => clients.projects(ident.user, params.workspace_id), { auth: 'user', replay: false });
    route('GET', '/api/client/projects/:project_id', ({ ident, params }) => clients.project(ident.user, params.project_id), { auth: 'user', replay: false });
    route('GET', '/api/account/client-export', ({ ident }) => clients.export(ident.user), { auth: 'user', replay: false });
    const artifacts = hub.clientArtifacts;
    route('POST', '/api/client-items/:item_id/artifacts', ({ member, params, body, ip, ident }) => artifacts.upload(member, params.item_id, body, { ip, cred: ident.cred }), { replay: false, maxBody: CLIENT_UPLOAD_BODY_MAX });
    route('POST', '/api/client-items/:item_id/approvals', ({ member, params, body, ip, ident }) => artifacts.request(member, params.item_id, body, { ip, cred: ident.cred }), { replay: false });
    route('DELETE', '/api/client-approval-requests/:approval_id', ({ member, params, ip, ident }) => artifacts.withdraw(member, params.approval_id, { ip, cred: ident.cred }), { replay: false });
    route('GET', '/api/client/items/:item_id/artifacts', ({ ident, params }) => artifacts.list(ident.user, params.item_id, ident.cred), { auth: 'user', replay: false });
    route('GET', '/api/client/items/:item_id/artifacts/:version_id', ({ ident, params }) => artifacts.get(ident.user, params.item_id, params.version_id, ident.cred), { auth: 'user', replay: false });
    route('GET', '/api/client/items/:item_id/artifacts/:version_id/content', ({ ident, params, res }) => {
      const file = artifacts.content(ident.user, params.item_id, params.version_id, ident.cred);
      sendRaw(res, 200, file.mime, file.bytes, { 'content-disposition': file.disposition });
    }, { auth: 'user', replay: false });
    route('GET', '/api/client/approvals/:approval_id', ({ ident, params }) => artifacts.approval(ident.user, params.approval_id, ident.cred), { auth: 'user', replay: false });
    route('POST', '/api/client/approvals/:approval_id/decision', ({ ident, params, body, ip }) => artifacts.decide(ident.user, params.approval_id, body, { ip, cred: ident.cred }), { auth: 'user', replay: false });
    const feedback = hub.clientFeedback;
    route('GET', '/api/boards/:board_id/client-feedback-intake', ({ member, params, ident }) => feedback.config(member, params.board_id, ident.cred), { replay: false });
    route('PATCH', '/api/boards/:board_id/client-feedback-intake', ({ member, params, body, ip, ident }) => feedback.configure(member, params.board_id, body, { ip, cred: ident.cred }), { replay: false });
    route('GET', '/api/client/items/:item_id/feedback', ({ ident, params }) => feedback.list(ident.user, params.item_id, ident.cred), { auth: 'user', replay: false });
    route('POST', '/api/client/items/:item_id/feedback', ({ ident, params, body, ip }) => feedback.create(ident.user, params.item_id, body, { ip, cred: ident.cred }), { auth: 'user', replay: false });
    route('POST', '/api/teams', ({ ident, body, ip }) => teams.create(ident, body, { ip }), { auth: 'user' });
    route('GET', '/api/teams/:team_id', ({ member }) => teams.get(member));
    route('PATCH', '/api/teams/:team_id', ({ member, body, ip }) => teams.update(member, body, { ip }));
    route('DELETE', '/api/teams/:team_id', ({ member, body, ip, ident }) => teams.remove(member, body, { ip, cred: ident.cred }));
    route('POST', '/api/teams/:team_id/boards', ({ member, body, ip }) => teams.createBoard(member, body, { ip }));
    route('GET', '/api/teams/:team_id/boards', ({ member, query }) => api.listBoards(member, { includeArchived: query.get('include_archived') === '1' }));
    route('GET', '/api/teams/:team_id/members', ({ member }) => teams.listMembers(member));
    route('PATCH', '/api/teams/:team_id/members/:member_id', ({ member, params, body, ip }) => teams.setRole(member, params.member_id, body, { ip }));
    route('DELETE', '/api/teams/:team_id/members/:member_id', ({ member, params, ip }) => teams.removeMember(member, params.member_id, { ip }));
    // Invites (P3, D64–D65). preview is public (rate limited); accept needs a
    // signed-in user whose verified email is the invite's.
    const inv = hub.invites;
    route('GET', '/api/teams/:team_id/invites', ({ member }) => inv.list(member));
    route('POST', '/api/teams/:team_id/invites', ({ member, body, ip, req }) => inv.create(member, body, { ip, req }), { replay: INVITE_REPLAY });
    route('DELETE', '/api/teams/:team_id/invites/:invite_id', ({ member, params, ip }) => inv.revoke(member, params.invite_id, { ip }));
    route('POST', '/api/teams/:team_id/invites/:invite_id/resend', ({ member, params, ip, req }) => inv.resend(member, params.invite_id, { ip, req }), { replay: INVITE_REPLAY });
    route('POST', '/api/invites/preview', ({ body, ip }) => inv.preview(body, { ip }), { auth: 'none' });
    route('POST', '/api/invites/accept', ({ ident, body, ip }) => inv.accept(ident, body, { ip }), { auth: 'user' });
    route('POST', '/api/account/invites/:invite_id/accept', ({ ident, params, ip }) => inv.accept(ident, { invite_id: params.invite_id }, { ip }), { auth: 'user' });
    // Runner enrolment (P4, D79–D81): this install as a runner in the team in the URL.
    const enr = hub.enrolments;
    route('POST', '/api/teams/:team_id/enrol', ({ member, ident, body, ip }) => enr.enrol(member, ident, body, { ip }));
    route('DELETE', '/api/teams/:team_id/enrol', ({ member, ident, ip }) => enr.unenrol(member, ident, { ip }));
    route('GET', '/api/teams/:team_id/enrolments', ({ member, ident }) => enr.list(member, ident));
    route('DELETE', '/api/teams/:team_id/enrolments/:enrollment_id', ({ member, params, ip }) => enr.revoke(member, params.enrollment_id, { ip }));
  } else {
    route('GET', '/api/me', ({ member }) => api.me(member));
  }
  route('GET', '/api/boards', ({ member, query }) => api.listBoards(member, { includeArchived: query.get('include_archived') === '1' }));
  route('GET', '/api/search', ({ member, query, ident }) => searchWork(hub, member, query, { cred: ident?.cred }), { limit: 'search_member' });
  route('GET', '/api/team-overview', ({ member, query, ident }) => teamOverview(hub, member, query, { cred: ident?.cred }), { limit: 'overview_member' });
  route('GET', '/api/workflows', ({ member, ident, query }) => workflows.list(member, ident?.cred, { includeArchived: query.get('include_archived') === '1' }));
  route('POST', '/api/workflows', ({ member, body, ident }) => workflows.publish(member, null, body, ident?.cred), { replay: false });
  route('GET', '/api/workflows/:workflow_id', ({ member, params, ident }) => workflows.detail(member, params.workflow_id, ident?.cred));
  route('POST', '/api/workflows/:workflow_id/versions', ({ member, params, body, ident }) => workflows.publish(member, params.workflow_id, body, ident?.cred), { replay: false });
  route('POST', '/api/workflows/:workflow_id/archive', ({ member, params, body, ident }) => workflows.archive(member, params.workflow_id, body, ident?.cred), { replay: false });
  route('POST', '/api/boards/:board_id/workflows/:workflow_id/apply', ({ member, params, body, ident }) => workflows.apply(member, params.workflow_id, params.board_id, body, ident?.cred), { replay: false });
  route('POST', '/api/boards', ({ member, body }) => api.createBoard(member, body));
  route('PATCH', '/api/boards/:board_id', ({ member, params, body }) => api.updateBoard(member, params.board_id, body));
  route('POST', '/api/boards/:board_id/archive', ({ member, params }) => api.setBoardArchived(member, params.board_id, true));
  route('POST', '/api/boards/:board_id/restore', ({ member, params }) => api.setBoardArchived(member, params.board_id, false));
  route('GET', '/api/boards/:board_id', ({ member, params, query }) => selectedContext(hub, api.snapshot(member, params.board_id, { includeArchived: query.get('include_archived') === '1' }), communicationOptions(query).boardIds));
  route('GET', '/api/boards/:board_id/labels', ({ member, params }) => api.listLabels(member, params.board_id));
  route('POST', '/api/boards/:board_id/labels', ({ member, params, body, ident }) => api.createLabel(member, params.board_id, body, { cred: ident?.cred ?? null }), { writeScope: 'board' });
  route('PATCH', '/api/boards/:board_id/labels/:name', ({ member, params, body, ident }) => api.patchLabel(member, params.board_id, params.name, body, { cred: ident?.cred ?? null }), { writeScope: 'label' });
  route('DELETE', '/api/boards/:board_id/labels/:name', ({ member, params, body, query, ident }) => api.deleteLabel(member, params.board_id, params.name, { ...body, strip: body.strip === true || query.get('strip') === '1' }, { cred: ident?.cred ?? null }), { writeScope: 'labelManage' });
  route('GET', '/api/boards/:board_id/alerts', ({ member, params }) => api.alerts(member, params.board_id));
  route('GET', '/api/boards/:board_id/journal', ({ member, params, query }) => api.journalPage(member, params.board_id, { after_seq: query.get('after_seq') ?? 0, limit: query.get('limit') ?? 200 }));
  route('POST', '/api/boards/:board_id/cards', ({ member, params, body, ident }) => api.createCard(member, params.board_id, body, { cred: ident?.cred ?? null }), { collaboration: true });
  route('POST', '/api/boards/:board_id/work-capture', ({ member, params, body, ident }) => workCapture.observe(member, params.board_id, body, ident?.cred), { replay: false, maxBody: 12 * 1024 });
  route('POST', '/api/boards/:board_id/repos', ({ member, params, body }) => api.addBoardRepo(member, params.board_id, body));
  route('GET', '/api/boards/:board_id/presence', ({ member, params }) => { api.boardFor(member, params.board_id); return hub.presence.view(params.board_id); }, { limit: 'presence_member' });
  route('GET', '/api/my-day', ({ member, ident }) => myDay(hub, ident ? { userId: ident.user.id, cred: ident.cred } : { member }), { auth: config.auth === 'accounts' ? 'user' : 'member', replay: false });
  route('GET', '/api/cards/:card_id', ({ member, params, query }) => selectedContext(hub, api.detail(member, params.card_id), communicationOptions(query).boardIds));
  route('PATCH', '/api/cards/:card_id/planning', ({ member, params, body, ident }) => planning.patch(member, params.card_id, body, ident?.cred ?? null), { replay: false, maxBody: 4096 });
  if(config.auth === 'accounts') {
    const guarded = { replay:false, responseGuard:({member,params,ident,req},out)=>setups.guard(member,params,out,ident.cred,req.method) };
    route('GET','/api/teams/:team_id/setups',({member,params,ident})=>setups.list(member,params.team_id,ident.cred),guarded);
    route('POST','/api/teams/:team_id/setups',({member,params,body,ident})=>setups.publish(member,params.team_id,body,ident.cred),{...guarded,maxBody:SETUP_BODY_MAX});
    route('GET','/api/setup-profiles/:profile_id',({member,params,ident})=>setups.read(member,params.profile_id,null,ident.cred),guarded);
    route('GET','/api/setup-profiles/:profile_id/versions/:version_id',({member,params,ident})=>setups.read(member,params.profile_id,params.version_id,ident.cred),guarded);
    route('GET','/api/setup-profiles/:profile_id/export',({member,params,ident})=>setups.read(member,params.profile_id,null,ident.cred,true),guarded);
    route('DELETE','/api/setup-profiles/:profile_id',({member,params,body,ident})=>setups.unpublish(member,params.profile_id,body,ident.cred),guarded);
    route('GET','/api/setup-profiles/:profile_id/activity',({member,params,ident})=>setups.activity(member,params.profile_id,ident.cred),guarded);
    route('PUT','/api/teams/:team_id/setup-baseline',({member,params,body,ident})=>setups.baseline(member,params.team_id,body,ident.cred),guarded);
    route('POST','/api/setup-profiles/:profile_id/borrow-receipts',({member,params,body,ident})=>setups.receipt(member,params.profile_id,body,ident.cred),guarded);
  }
  route('POST', '/api/cards/:card_id/work-capture/stop', ({ member, params, body, ident }) => workCapture.stop(member, params.card_id, body, ident?.cred), { replay: false, maxBody: 1024 });
  route('PATCH', '/api/cards/:card_id', ({ member, params, body, ident }) => api.patchCard(member, params.card_id, body, { cred: ident?.cred ?? null }), { collaboration: true });
  route('POST', '/api/cards/:card_id/actions/:action', ({ member, params, body, ident }) => api.action(member, params.card_id, params.action, body, { cred: ident?.cred ?? null }), { writeScope: 'card' });
  route('POST', '/api/cards/:card_id/archive', ({ member, params, body, ident }) => api.archive(member, params.card_id, body, { cred: ident?.cred ?? null }), { writeScope: 'archive' });
  route('POST', '/api/cards/:card_id/restore', ({ member, params, body, ident }) => api.restore(member, params.card_id, body, { cred: ident?.cred ?? null }), { writeScope: 'archive' });
  route('GET', '/api/cards/:card_id/packet', ({ member, params, query, ident }) => communication.staffReadPacket(member, params.card_id, query.has('version') ? { version: Number(query.get('version')) } : {}, ident?.cred, communicationOptions(query)));
  route('POST', '/api/cards/:card_id/packet', ({ member, params, body, ident, query }) => communication.staffWritePacket(member, params.card_id, body, ident?.cred, communicationOptions(query)), { replay: false });
  route('GET', '/api/cards/:card_id/messages', ({ member, params, ident, query }) => communication.staffListMessages(member, params.card_id, ident?.cred, communicationOptions(query)), { limit: 'communication_read_member' });
  route('POST', '/api/cards/:card_id/messages', ({ member, params, body, ident, query }) => communication.staffSendMessage(member, params.card_id, body, ident?.cred, communicationOptions(query)), { replay: false });
  route('POST', '/api/cards/:card_id/comments', ({ member, params, body, ident }) => api.comment(member, params.card_id, body, { cred: ident?.cred ?? null }), { collaboration: true });
  route('GET', '/api/cards/:card_id/handover', ({ member, params, query, res }) => {
    const h = api.handover(member, params.card_id);
    if (query.get('format') === 'md') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) });
      res.end(h.markdown);
      return undefined;
    }
    return h;
  });
  route('GET', '/api/cards/:card_id/overlap-preview', ({ member, params, query }) => api.overlapPreview(member, params.card_id, query.get('target_member_id'), query.get('repo_id')));
  route('POST', '/api/permission-requests/:id/answer', ({ member, params, body, ident }) => api.answerPermission(member, params.id, body, { cred: ident?.cred ?? null }), { writeScope: 'permission' });
  route('GET', '/api/devices', ({ member }) => api.listDevices(member));
  // Accounts mode mints runner credentials only by enrolment (D79, H1); listing and revoking stay for cleanup.
  if (config.auth !== 'accounts') route('POST', '/api/devices', ({ member, body }) => api.createDevice(member, body));
  route('DELETE', '/api/devices/:id', ({ member, params }) => api.revokeDevice(member, params.id));
  route('GET', '/api/repos', ({ member }) => api.listRepos(member));
  route('POST', '/api/repos', ({ member, body }) => api.createRepo(member, body));
  // Accounts mode adds people by invite and removes them per team (P2/P3).
  if (config.auth !== 'accounts') {
    route('POST', '/api/members', ({ member, body }) => api.createMember(member, body));
    route('DELETE', '/api/members/:id', ({ member, params }) => api.removeMember(member, params.id));
  }

  // ── integrations (I1, D41; buddy-builder-5) ──────────────────────────────
  // Team-level: members see what's connected and its health; admins connect,
  // configure and disconnect. Secrets never appear in any response.
  if (integrations) {
    const own = (member, id) => {
      const c = integrations.get(id);
      if (!c || c.status === 'revoked' || integrations.orgOf(id) !== member.org_id) throw new HubError('NOT_FOUND', 'no such integration');
      return c;
    };
    // Members may read what's connected (by design, D42), but a connector's
    // config (channel ids, repo lists, …) is the admins' business.
    const forMember = (member, c) => (hub.isAdmin(member) ? c : { ...c, settings: { autonomy: c.settings?.autonomy ?? {} } });
    route('GET', '/api/integrations', ({ member }) => ({
      available: integrations.connectors(), vault: hub.vault.available,
      connections: integrations.list(member.org_id).map((c) => ({ ...forMember(member, c), linked: integrations.isLinked(c.id, member.id) })),
      ...(hub.isAdmin(member) ? { pending: integrations.pendingList(member.org_id) } : {}),
    }));
    route('POST', '/api/integrations/:provider/token', async ({ member, params, body }) => {
      api.requireAdmin(member);
      const conn = integrations.connectors().find((c) => c.id === params.provider);
      if (!conn || conn.connect !== 'token') throw new HubError('NOT_FOUND', 'no such token integration');
      const token = String(body.token ?? '').trim();
      if (!token || token.length > 4096) throw new HubError('VALIDATION', 'paste the token');
      let v;
      try { v = await integrations.verifyToken(params.provider, token); } catch (e) {
        // Provider/connector text never reaches the user (it can carry request details).
        hub.log.warn('integration token check failed', { integration: params.provider, err: redact(e?.message ?? e) });
        throw new HubError('VALIDATION', 'That token was not accepted. Check it and try again.');
      }
      // Named fields only: the id is the hub's to mint, and the connector's settings are provider facts (D42 addendum C1).
      return {
        connection: integrations.createConnection({
          external_id: v.external_id, display_name: v.display_name, scopes: v.scopes, secrets: v.secrets, settings: v.settings, orgId: member.org_id, memberId: member.id, provider: params.provider,
        }),
      };
    });
    // OAuth / app install (D42): the callback needs this cookie back. A
    // browser tab has it already; the desktop app's connect window (its own
    // session) gets `bind` through the window name and sets it itself.
    const setBind = (res, { name, value, path, secure, max_age_s }) => res.setHeader('set-cookie', `${name}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${max_age_s}${secure ? '; Secure' : ''}`);
    // body.input (D42 addendum "start inputs") goes to the registry only: never logged or kept.
    route('POST', '/api/integrations/:provider/start', ({ member, params, body, req, res }) => {
      api.requireAdmin(member);
      const out = integrations.oauthStart({ member, provider: params.provider, publicUrl: publicBase(req), input: body.input });
      setBind(res, out.cookie);
      return out.form ? { form: out.form, bind: out.bind } : { url: out.url, bind: out.bind };
    }, { replay: PREPARE_REPLAY });
    // Pending connections (D97): a provider starts one, a pending id takes the pasted fields.
    // body.input goes to the registry and nowhere else (no log, no cache, no error text).
    route('POST', '/api/integrations/:target/prepare', async ({ member, params, body, req, res }) => {
      api.requireAdmin(member);
      const publicUrl = publicBase(req);
      let out;
      try {
        out = UUID_RE.test(params.target)
          ? await integrations.pendingPrepare({ member, id: params.target, input: body.input, publicUrl })
          : await integrations.pendingCreate({ member, provider: params.target, input: body.input, publicUrl });
      } catch (e) {
        if (e instanceof HubError) throw e;
        hub.log.error('integration prepare failed', { path: '/api/integrations/:target/prepare' });
        throw new HubError('INTERNAL', 'internal error');
      }
      if (out.needs) return { pending: out.pending, needs: out.needs };
      setBind(res, out.cookie);
      return { pending: out.pending, url: out.url, bind: out.bind };
    }, { replay: PREPARE_REPLAY });
    route('POST', '/api/integrations/:id/authorize', ({ member, params, req, res }) => {
      api.requireAdmin(member);
      const out = integrations.pendingAuthorize({ member, id: params.id, publicUrl: publicBase(req) });
      setBind(res, out.cookie);
      return { url: out.url, bind: out.bind };
    });
    route('PATCH', '/api/integrations/:id', ({ member, params, body }) => {
      api.requireAdmin(member);
      own(member, params.id);
      const patch = {};
      if (body.autonomy !== undefined) patch.autonomy = body.autonomy;
      if (body.config !== undefined) patch.config = body.config;
      if (body.target_board_id !== undefined) patch.target_board_id = body.target_board_id;
      return { connection: integrations.setSettings(params.id, patch, { memberId: member.id }) };
    });
    route('DELETE', '/api/integrations/:id', ({ member, params }) => {
      api.requireAdmin(member);
      if (integrations.pendingDelete({ member, id: params.id })) return { ok: true };
      own(member, params.id);
      integrations.revokeConnection(params.id, member.id);
      return { ok: true };
    });
    // Identity links (D98): a member links, reads and unlinks only their own;
    // an admin lists and revokes, and never creates one.
    route('POST', '/api/integrations/:id/identity/start', async ({ member, params, req, res, ident }) => {
      const out = await integrations.identityStart({ member, connectionId: params.id, cred: ident?.cred ?? null, publicUrl: publicBase(req) });
      setBind(res, out.cookie);
      return { url: out.url, bind: out.bind };
    });
    route('GET', '/api/integrations/:id/identity', ({ member, params }) => {
      own(member, params.id);
      return integrations.identityStatus(params.id, member.id);
    });
    route('DELETE', '/api/integrations/:id/identity', ({ member, params }) => {
      own(member, params.id);
      return integrations.identityUnlink({ connectionId: params.id, memberId: member.id, by: 'self', actorId: member.id });
    });
    route('GET', '/api/integrations/:id/identities', ({ member, params }) => {
      api.requireAdmin(member);
      own(member, params.id);
      return { identities: integrations.identities(params.id) };
    });
    route('DELETE', '/api/integrations/:id/identities/:member_id', ({ member, params }) => {
      api.requireAdmin(member);
      own(member, params.id);
      const t = hub.member(params.member_id);
      if (!t || t.org_id !== member.org_id) throw new HubError('NOT_FOUND', 'member not found');
      return integrations.identityUnlink({ connectionId: params.id, memberId: t.id, by: 'admin', actorId: member.id });
    });
    route('GET', '/api/integrations/:id/audit', ({ member, params, query }) => {
      api.requireAdmin(member);
      own(member, params.id);
      return { entries: integrations.audit(params.id, { limit: Number(query.get('limit') ?? 100) }) };
    });
  }

  async function serveFile(req, res, path) {
    let info;
    try { info = await stat(path); } catch { info = null; }
    if (!info?.isFile()) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    const key = `${path}|${info.mtimeMs}|${info.size}`;
    let entry = etags.get(path);
    if (!entry || entry.key !== key) {
      const data = await readFile(path);
      entry = { key, data, etag: `"${createHash('sha1').update(data).digest('base64url')}"` };
      etags.set(path, entry);
    }
    const headers = {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache', etag: entry.etag,
      'content-security-policy': webCsp(), 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      // No opener handle on our pages: another site cannot navigate or re-hash a window it opened to us.
      'cross-origin-opener-policy': 'same-origin',
    };
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); res.end(); return undefined; }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : entry.data);
    return undefined;
  }

  function staticPath(pathname) {
    if (pathname === '/') return join(config.webDir, 'index.html');
    if (config.auth === 'accounts' && Object.hasOwn(ACCOUNT_PAGES, pathname)) return join(config.webDir, ACCOUNT_PAGES[pathname]);
    const shared = /^\/shared\/([a-z]+)\.js$/.exec(pathname);
    if (shared) return SHARED_BROWSER.has(shared[1]) ? join(config.sharedDir, `${shared[1]}.js`) : null;
    if (pathname.startsWith('/web/')) {
      let rel;
      try { rel = decodeURIComponent(pathname.slice(5)); } catch { return null; }
      const full = normalize(join(config.webDir, rel));
      return full.startsWith(config.webDir + sep) && !rel.includes('\0') ? full : null;
    }
    return null;
  }

  // The route table, for the tenancy suite's coverage assertion (D63).
  handle.routes = routes.map(({ method, pattern, auth }) => ({ method, pattern, auth }));
  return handle;

  async function handle(req, res) {
    // Pipelined behind a request that was answered with Connection: close.
    if (req.socket?.writableEnded) return req.socket.destroy();
    if (req.socket) req.socket[CURRENT] = req;
    const url = new URL(req.url, 'http://hub');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "frame-ancestors 'none'");
    if (hsts) res.setHeader('strict-transport-security', 'max-age=31536000');
    if (loopbackOnly(config) && !devRequestOk(req)) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: `${config.auth} auth serves direct loopback requests only` } });
    if (config.auth === 'local' && !localCookieOk(hub, req)) return sendJson(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
    // These two paths bypass Cloudflare Access (providers can't sign in):
    // the signed state and the webhook signature are their only auth.
    const cb = integrations && req.method === 'GET' ? /^\/integrations\/([a-z][a-z0-9-]{1,31})\/callback$/.exec(url.pathname) : null;
    if (cb) {
      try {
        const base = publicBase(req);
        // Only the variant this hub sets: on https the plain name is ignored.
        const ck = integrations.bindCookie(cb[1], base);
        let bind = null;
        try { bind = parseCookies(req.headers.cookie)[ck.name] ?? null; } catch { bind = null; }
        const out = await integrations.oauthCallback({ provider: cb[1], query: url.searchParams, publicUrl: base, bindCookie: bind });
        const clear = bind != null ? { 'set-cookie': `${ck.name}=; HttpOnly; SameSite=Lax; Path=${ck.path}; Max-Age=0${ck.secure ? '; Secure' : ''}` } : {};
        if (!out.ok) return sendConnectPage(res, 400, out.error, 'error', clear, out.link ?? null);
        return sendConnectPage(res, 200, `${out.connection.display_name ?? 'The integration'} is connected.`, 'ok', clear, out.next_url ? { url: out.next_url, text: `Continue on ${out.provider_name}` } : null);
      } catch (e) {
        hub.log.error('integration callback failed', { provider: cb[1], err: redact(e?.message ?? e) });
        return sendConnectPage(res, 500, 'Something went wrong. Start again from Buddy.', 'error');
      }
    }
    // D98: the same signed-state + bind-cookie model, for a member's own link.
    const idcb = integrations && req.method === 'GET' ? /^\/integrations\/([a-z][a-z0-9-]{1,31})\/identity\/callback$/.exec(url.pathname) : null;
    if (idcb) {
      try {
        const base = publicBase(req);
        const ck = integrations.bindCookie(idcb[1], base);
        let bind = null;
        try { bind = parseCookies(req.headers.cookie)[ck.name] ?? null; } catch { bind = null; }
        const ip = clientIp(req, config);
        let cred = null;
        let credInvalid = false;
        if (config.auth === 'accounts') {
          try {
            const ident = hub.accounts.authenticate(req, { ip, rotate: false });
            cred = ident ? { user_id: ident.user.id, kind: ident.cred.kind, id: ident.cred.id } : null;
          } catch { credInvalid = true; }
        }
        const out = await integrations.identityCallback({ provider: idcb[1], query: url.searchParams, publicUrl: base, bindCookie: bind, ip: ipKey(ip), cred, credInvalid });
        const clear = bind != null ? { 'set-cookie': `${ck.name}=; HttpOnly; SameSite=Lax; Path=${ck.path}; Max-Age=0${ck.secure ? '; Secure' : ''}` } : {};
        if (!out.ok) return sendConnectPage(res, out.status ?? 400, out.error, 'error', clear);
        return sendConnectPage(res, 200, `Your ${out.provider_name} account is linked.`, 'ok', clear);
      } catch {
        // Never the error itself: it may carry what the provider sent.
        hub.log.error('integration identity callback failed', { provider: idcb[1] });
        return sendConnectPage(res, 500, 'Something went wrong. Start again from Buddy.', 'error');
      }
    }
    const hook = integrations && req.method === 'POST' ? /^\/integrations\/([0-9a-f-]{36})\/webhook$/.exec(url.pathname) : null;
    if (hook) {
      try {
        // Any other id (unknown, inactive, revoked, pending) is read under the
        // same caps and answered by webhook(): one 404 for all of them (D97).
        const live = integrations.webhookTarget(hook[1]);
        // Nothing here refuses a delivery for other senders' failures: a
        // provider's shared egress IPs also carry anyone's forged posts. Failures
        // (per connection + client IP) only turn a later failure's 401 into a
        // 429; before the signature is checked only the in-flight read caps
        // (WEBHOOK_READS) apply, and a refused read is 503 so the provider retries.
        const raw = clientIp(req, config);
        const ip = failBucketKey(raw);
        const failKey = `${hook[1]}|${ip}`;
        // Not a connection: the sender picks the id, so its reads share one
        // slot pool and its failures one bucket per address (no bucket per id,
        // and no id answers apart).
        const connKey = live ? hook[1] : '-';
        const vetKey = `${hook[1]}|${vetBucketKey(ip)}`;
        const count = (m, k) => m.get(k) ?? 0;
        const vetted = live && (integrations.trustedIngress(hook[1], raw) || (verifiedPairs.get(vetKey) ?? -Infinity) > hub.mono());
        const cut = () => cutIfUnread(req, res);
        if (count(reading.pair, failKey) >= readLimits.perPair || count(reading.ip, ip) >= readLimits.perIp || (!vetted && count(reading.conn, connKey) >= (live ? readLimits.perConn : readLimits.perUnknown))) {
          cut();
          return sendJson(res, 503, { error: { code: 'UNAVAILABLE', message: 'too many deliveries in flight; retry' } }, { 'retry-after': '1' });
        }
        // `asLive`: what webhook() found after the read (an id may be promoted
        // or revoked meanwhile); before it, the check above.
        const failed = (status, body, asLive = live) => {
          const t = hub.limiter.take('webhook_fail_ip', asLive ? failKey : `-|${ip}`);
          if (t.ok || status !== (asLive ? 401 : 404)) return sendJson(res, status, body);
          const s = Math.max(1, Math.ceil(t.retry_after_ms / 1000));
          return sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: 'too many failed deliveries', retry_after_s: s } }, { 'retry-after': String(s) });
        };
        const tooLarge = () => failed(413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'body over 1 MiB' } });
        // The answer a read would end in anyway, without holding a slot for it.
        if (Number(req.headers['content-length']) > MAX_BODY) {
          cut();
          return tooLarge();
        }
        const slots = [[reading.pair, failKey], [reading.ip, ip], [reading.conn, connKey]];
        for (const [m, k] of slots) m.set(k, count(m, k) + 1);
        let got;
        try {
          got = await readRaw(req, readLimits.deadlineMs);
        } finally {
          for (const [m, k] of slots) { const n = count(m, k) - 1; if (n > 0) m.set(k, n); else m.delete(k); }
        }
        if (got.error) cut();
        if (got.error === 413) return tooLarge();
        if (got.error === 408) return failed(408, { error: { code: 'TIMEOUT', message: 'body not received in time' } });
        if (got.error) return undefined;
        // webhook() spends webhook_conn only once the signature is verified.
        const out = await integrations.webhook(hook[1], { headers: req.headers, rawBody: got.body });
        if (out.verified) {
          verifiedPairs.delete(vetKey);
          verifiedPairs.set(vetKey, hub.mono() + readLimits.verifiedMs);
          if (verifiedPairs.size > readLimits.verifiedMax) verifiedPairs.delete(verifiedPairs.keys().next().value);
        }
        const asLive = !!out.live;
        if (out.status === 401 || (!asLive && out.status === 404)) return failed(out.status, out.body, asLive);
        if (typeof out.raw === 'string') return sendRaw(res, out.status, out.type, out.raw, out.headers);
        return sendJson(res, out.status, out.body, out.headers);
      } catch (e) {
        if (e instanceof HubError) return sendJson(res, httpStatus(e.code), errorBody(e), retryHeader(e));
        hub.log.error('integration webhook failed', { connection_id: hook[1], err: redact(e?.message ?? e) });
        return sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
      }
    }
    let clientUploadSlot = false;
    let setupUploadSlot = false;
    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
        // The invite page's "Download" button (accounts): the configured app download.
        if (config.auth === 'accounts' && url.pathname === '/download') {
          const to = config.downloadUrl ?? BRAND.downloadUrlDefault;
          if (!to) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no download is configured (BOARD_DOWNLOAD_URL)' } });
          res.writeHead(302, { location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) });
          res.end();
          return undefined;
        }
        const p = staticPath(url.pathname);
        if (!p) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
        return await serveFile(req, res, p);
      }
      cutIfUnread(req, res);
      let match = null;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (m) { match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break; }
      }
      if (!match) throw new HubError('NOT_FOUND', 'no such route');
      const { r, params } = match;
      const ip = clientIp(req, config);
      if (r.mutating) limitOrThrow(hub, r.auth === 'none' ? 'login_ip' : 'mutate_ip', ipKey(ip));
      if (r.mutating) {
        if (!sameOrigin(req, config.publicUrl)) throw new HubError('FORBIDDEN', 'cross-origin request');
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HubError('VALIDATION', 'Content-Type must be application/json');
      }
      const pick = { resourceOrg: resourceOrg(r, params), requestedOrg: req.headers['board-org'] || url.searchParams.get('org') || null };
      if (config.auth === 'accounts') pick.requestedOrg = requestedTeam(req, url.searchParams);
      let ident = null;
      let member = null;
      if (config.auth === 'accounts') {
        if (r.auth !== 'none') {
          try { ident = hub.accounts.authenticate(req, { ip }); } catch (e) { if (r.auth !== 'optional') throw e; }
          if (!ident && r.auth !== 'optional') throw new HubError('UNAUTHENTICATED', 'not signed in');
        }
        if (ident?.setCookie) appendCookie(res, ident.setCookie);
        // Bearer (desktop) requests carry no ambient credential: no CSRF token.
        // On an optional-auth route a cookie that fails CSRF is just ignored.
        if (ident?.cred.kind === 'session' && r.mutating && (!strictOrigin(req, config.publicUrl) || !hub.accounts.csrfOk(ident, req.headers['x-csrf-token']))) {
          if (r.auth !== 'optional') throw new HubError('FORBIDDEN', 'cross-site request or missing X-CSRF-Token');
          ident = null;
        }
        if (r.auth === 'member') member = pickAccountMember(hub, userMembers(hub, ident.user.id), pick);
      } else if (r.auth === 'member') {
        member = await authMember(req, pick);
      }
      if(r.responseGuard && (req.headers['x-plexiform-account']!==ident?.user.id || req.headers['x-plexiform-member']!==member?.id)) throw new HubError('UNAUTHENTICATED','Setups account or membership changed; refresh your sign-in');
      if (r.pattern === '/api/client-items/:item_id/artifacts') {
        hub.clientArtifacts.staff(member, params.item_id, ident.cred, true);
        if (clientUploads >= 4) throw new HubError('RATE_LIMITED', 'deliverable uploads are busy; try again shortly', { retry_after_s: 1 });
        clientUploads++; clientUploadSlot = true;
      }
      if(r.method === 'POST' && r.pattern === '/api/teams/:team_id/setups') {
        setups.scope(member,params.team_id,ident.cred,'setups.publish');
        if(setupUploads>=4) throw new HubError('RATE_LIMITED','Setups uploads are busy; try again shortly',{retry_after_s:1});
        setupUploads++; setupUploadSlot=true;
      }
      // Only now, so nobody unauthenticated can make the hub hold a body (D105).
      let body = r.mutating ? await readBody(req, { max: r.maxBody, deadlineMs: limits.bodyDeadlineMs }) : {};
      // Bind retries to the effective operation, whether strip came from
      // JSON or the existing query option. Equivalent forms remain a retry.
      if (r.method === 'DELETE' && r.pattern === '/api/boards/:board_id/labels/:name') body = { ...body, strip: body.strip === true || url.searchParams.get('strip') === '1' };
      const refreshWrite = () => {
        if (ident && r.mutating && !hub.accounts.credValid(ident.cred)) throw new HubError('UNAUTHENTICATED', 'sign in again');
        if (member && r.auth === 'member' && r.mutating) member = api.currentMember(member, ident?.cred ?? null);
        if (r.writeScope === 'archive') member = api.collaborationScope(member, { cardId: params.card_id, allowArchived: true }, ident?.cred ?? null);
        if (['board', 'label', 'labelManage'].includes(r.writeScope)) {
          member = api.collaborationScope(member, { boardId: params.board_id }, ident?.cred ?? null);
          if (r.writeScope === 'labelManage' || (r.writeScope === 'label' && typeof body.name === 'string' && body.name.trim() !== params.name)) api.requireLabel(member, 'label.manage');
        }
        if (r.collaboration || r.writeScope === 'card') member = api.collaborationScope(member, { boardId: params.board_id, cardId: params.card_id }, ident?.cred ?? null);
        if (r.writeScope === 'card') api.requireActionRepo(api.cardFor(member, params.card_id), params.action);
        if (r.collaboration && body.repo_id != null) {
          const boardId = params.board_id ?? api.cardFor(member, params.card_id).board_id;
          if (!hub.db.get('SELECT 1 AS x FROM board_repos WHERE board_id = ? AND repo_id = ?', boardId, body.repo_id)) throw new HubError('NOT_FOUND', 'repo not on this board');
        }
        if (r.writeScope === 'permission') {
          const pr = hub.db.get('SELECT card_id FROM permission_requests WHERE id = ?', params.id);
          if (!pr) throw new HubError('NOT_FOUND', 'permission request not found');
          member = api.collaborationScope(member, { cardId: pr.card_id }, ident?.cred ?? null);
        }
      };
      refreshWrite();
      const paidAction = DISPATCH_ACTIONS.has(params.action);
      const actor = member?.id ?? (ident && r.auth === 'user' ? `user:${ident.user.id}` : null);
      // Client operations always pass through their live grant/role checks.
      // Workspace creation and acceptance have durable transactional retries;
      // an old response must not bypass later removal or guest revocation.
      // Paid dispatches use their durable, choice-bound row instead of a
      // generic response cache that could replay a different AI/budget.
      const rid = r.replay !== false && !paidAction && actor && r.mutating && typeof body.request_id === 'string' ? body.request_id : null;
      const binding = rid && (r.collaboration || r.writeScope) ? requestBinding(r, params, body) : null;
      const runRequest = async () => {
        refreshWrite();
        if (rid) {
          const hit = hub.cachedResponse(actor, rid);
          if (hit) {
            if ((binding != null || hit.binding != null) && binding !== hit.binding) throw new HubError('CONFLICT', 'request_id reused for a different request');
            return sendJson(res, hit.status, r.collaboration ? selectedContext(hub, hit.body, communicationOptions(url.searchParams).boardIds) : hit.body, { 'board-replayed': '1' });
          }
        }
        if (actor && r.mutating) {
          limitOrThrow(hub, 'mutate_member', actor);
          if (DISPATCH_ACTIONS.has(params.action)) limitOrThrow(hub, 'dispatch_member', actor);
        }
        if (member && r.limit) limitOrThrow(hub, r.limit, member.id);
        let status = 200;
        let out;
        try {
          out = await r.handler({ req, res, member, params, body, query: url.searchParams, ident, ip });
        } catch (e) {
          if (!(e instanceof HubError)) throw e;
          status = httpStatus(e.code);
          out = errorBody(e);
        }
        if (out === undefined) return undefined;
        if(status===200 && r.responseGuard) r.responseGuard({member,params,ident,req},out);
        if (r.collaboration) out = selectedContext(hub, out, communicationOptions(url.searchParams).boardIds);
        if (rid) hub.cacheResponse(actor, rid, r.replay?.status ?? status, r.replay?.body ?? out, binding);
        return sendJson(res, status, out, out?.error?.code === 'RATE_LIMITED' && out.error.retry_after_s ? { 'retry-after': String(out.error.retry_after_s) } : {});
      };
      if (!rid) return await runRequest();
      const key = `${actor}|${rid}`;
      const previous = requestsInFlight.get(key) ?? Promise.resolve();
      const pending = previous.then(runRequest, runRequest);
      requestsInFlight.set(key, pending);
      const clear = () => { if (requestsInFlight.get(key) === pending) requestsInFlight.delete(key); };
      pending.then(clear, clear);
      return await pending;
    } catch (e) {
      if (e instanceof HubError) return sendJson(res, httpStatus(e.code), errorBody(e), retryHeader(e));
      hub.log.error('http handler failed', { path: url.pathname, err: e });
      return sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
    } finally {
      if (clientUploadSlot) clientUploads--;
      if (setupUploadSlot) setupUploads--;
    }
  }
}

function normalizeAddr(a) {
  return String(a ?? '').replace(/^::ffff:/, '');
}

function refuse(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createUpgradeHandler({ hub, config, wss, authenticate }) {
  return async function onUpgrade(req, socket, head) {
    const { pathname, searchParams } = new URL(req.url, 'http://hub');
    socket.on('error', () => {});
    if (loopbackOnly(config) && !devRequestOk(req)) return refuse(socket, 403, 'Forbidden');
    // Runners keep device-token auth; every other upgrade needs the local cookie.
    if (config.auth === 'local' && pathname !== WS_PATHS.runner && !localCookieOk(hub, req)) return refuse(socket, 401, 'Unauthorized');
    if (pathname === WS_PATHS.browser && config.auth === 'accounts') {
      // Accounts: no credential → plain HTTP 401 on the upgrade, no socket.
      let auth;
      try { auth = await authenticate(req); } catch { return refuse(socket, 401, 'Unauthorized'); }
      const originOk = auth.cred.kind === 'session' ? strictOrigin(req, config.publicUrl) : sameOrigin(req, config.publicUrl);
      if (!originOk) return refuse(socket, 403, 'Forbidden');
      return wss.handleUpgrade(req, socket, head, (ws) => {
        new BrowserConn(hub, ws, { candidates: auth.candidates, user: auth.user, cred: auth.cred });
      });
    }
    if (pathname === WS_PATHS.browser) {
      if (!sameOrigin(req, config.publicUrl)) return refuse(socket, 403, 'Forbidden');
      let auth = null;
      let close = null;
      try { auth = await authenticate(req); } catch (e) {
        close = e.code === 'FORBIDDEN' ? WS_CLOSE.REVOKED : e.code === 'ACCESS_UNAVAILABLE' ? WS_CLOSE.UNAVAILABLE : WS_CLOSE.UNAUTHENTICATED;
      }
      return wss.handleUpgrade(req, socket, head, (ws) => {
        if (close) { ws.close(close, { [WS_CLOSE.REVOKED]: 'not a member of this board', [WS_CLOSE.UNAVAILABLE]: 'try again later' }[close] ?? 'unauthenticated'); return; }
        // Several orgs and no ?org=: the subscribed board's org decides (BrowserConn).
        let member = null;
        try { member = pickMember(hub, auth.candidates, { requestedOrg: searchParams.get('org') }); } catch { member = null; }
        new BrowserConn(hub, ws, { member, candidates: auth.candidates, expMs: auth.exp_ms });
      });
    }
    if (pathname === WS_PATHS.runner) {
      const auth = await authenticateRunner(hub, req, { ip: clientIp(req, config) });
      return wss.handleUpgrade(req, socket, head, (ws) => {
        if (auth.close) { ws.close(auth.close, auth.reason); return; }
        new RunnerConn(hub, ws, auth.device, { enrollmentId: auth.enrollmentId ?? null });
      });
    }
    return refuse(socket, 404, 'Not Found');
  };
}

/**
 * → {candidates:[member], exp_ms}: every active member row this sign-in maps
 * to (one per org), and when the Access session expires. Access maps only the
 * verified `email` claim (any IdP: GitHub or the one-time PIN), never a
 * GitHub identity.
 */
export function makeAuthenticate({ hub, config }) {
  return async (req) => {
    if (config.auth === 'accounts') {
      // No rotation here: an upgrade response can't carry the new cookie.
      const ident = hub.accounts.authenticate(req, { ip: clientIp(req, config), rotate: false });
      if (!ident) throw new HubError('UNAUTHENTICATED', 'not signed in');
      return { candidates: userMembers(hub, ident.user.id), exp_ms: null, user: ident.user, cred: ident.cred };
    }
    if (config.auth === 'local') {
      const m = localCookieOk(hub, req) && hub.activeMember(hub.localMemberId);
      if (!m) throw new HubError('UNAUTHENTICATED', 'not signed in');
      return { candidates: [m], exp_ms: null };
    }
    if (config.auth === 'dev') {
      const id = parseDevCookie(hub.secret, parseCookies(req.headers.cookie).board_dev);
      const m = id && hub.activeMember(id);
      if (!m) throw new HubError('UNAUTHENTICATED', 'not signed in');
      return { candidates: [m], exp_ms: null };
    }
    const claims = await hub.access.verify(req.headers['cf-access-jwt-assertion']);
    const list = typeof claims.email === 'string' && claims.email
      ? hub.db.all('SELECT * FROM members WHERE lower(email) = lower(?) AND removed_at IS NULL ORDER BY created_at', claims.email) : [];
    if (!list.length) throw new HubError('FORBIDDEN', 'not a member of this board');
    return { candidates: list, exp_ms: typeof claims.exp === 'number' ? claims.exp * 1000 : null };
  };
}

/**
 * The member row that acts: the explicitly requested org (Board-Org header or
 * ?org=), else the only one, else the one in the resource's org. Ambiguous
 * with no resource → CONFLICT listing the orgs; never a silent pick.
 */
export function pickMember(hub, candidates, { resourceOrg = null, requestedOrg = null } = {}) {
  const inOrg = (org) => candidates.find((m) => m.org_id === org) ?? null;
  if (requestedOrg) {
    const m = inOrg(requestedOrg);
    if (!m) throw new HubError('FORBIDDEN', 'not a member of that org');
    return m;
  }
  if (candidates.length === 1) return candidates[0];
  if (resourceOrg) {
    const m = inOrg(resourceOrg);
    if (!m) throw new HubError('NOT_FOUND', 'not found');
    return m;
  }
  throw new HubError('CONFLICT', 'this sign-in belongs to several orgs: choose one with ?org=<org_id> or the Board-Org header', {
    orgs: candidates.map((m) => ({ id: m.org_id, name: hub.db.get('SELECT name FROM orgs WHERE id = ?', m.org_id)?.name ?? null, member_id: m.id })),
  });
}

/**
 * Accounts mode (D61): the membership that acts is the one in the team that
 * owns the resource in the URL. A route that names a resource the user's
 * teams don't own, an unknown one, or one whose team was deleted → 404 (never
 * 403: no existence oracle). An `X-Board-Team` / `Board-Org` header or
 * `?team=` / `?org=` only picks among the user's own teams, and must agree
 * with the resource when there is one. No resource and several teams → CONFLICT.
 */
export function pickAccountMember(hub, candidates, { resourceOrg = undefined, requestedOrg = null } = {}) {
  const inOrg = (org) => candidates.find((m) => m.org_id === org) ?? null;
  const notFound = () => new HubError('NOT_FOUND', 'not found');
  if (resourceOrg !== undefined) {
    if (!resourceOrg || (requestedOrg && requestedOrg !== resourceOrg)) throw notFound();
    return inOrg(resourceOrg) ?? (() => { throw notFound(); })();
  }
  if (requestedOrg) return inOrg(requestedOrg) ?? (() => { throw notFound(); })();
  if (!candidates.length) throw new HubError('NOT_FOUND', 'not in a team yet');
  if (candidates.length === 1) return candidates[0];
  throw new HubError('CONFLICT', 'you are in several teams: choose one with the X-Board-Team header or ?team=<team_id>', {
    orgs: candidates.map((m) => ({ id: m.org_id, name: hub.db.get('SELECT name FROM orgs WHERE id = ?', m.org_id)?.name ?? null, member_id: m.id })),
  });
}

const requestedTeam = (req, query) => req.headers['x-board-team'] || req.headers['board-org'] || query.get('team') || query.get('org') || null;

// Live memberships of a user, in teams that aren't deleted.
export const userMembers = (hub, userId) => hub.db.all(`SELECT m.* FROM members m JOIN orgs o ON o.id = m.org_id
  WHERE m.user_id = ? AND m.removed_at IS NULL AND o.deleted_at IS NULL ORDER BY m.created_at`, userId);

export function makeAuthMember({ hub, config }) {
  const authenticate = makeAuthenticate({ hub, config });
  return async (req, opts) => pickMember(hub, (await authenticate(req)).candidates, opts);
}
