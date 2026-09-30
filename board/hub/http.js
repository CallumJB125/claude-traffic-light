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
import { isLoopback } from './config.js';
import { publicMember } from './api.js';
import { LOCAL_ONLY } from './views.js';
import { BrowserConn } from './ws-board.js';
import { RunnerConn, authenticateRunner } from './ws-runner.js';
import { clientIp, limitOrThrow } from './ratelimit.js';
import { appendCookie } from './identity/accounts.js';

const MAX_BODY = 1024 * 1024;
const SHARED_BROWSER = new Set(['states', 'liveness', 'fence', 'scope', 'overlap', 'cardface', 'handover', 'protocol']);
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' https://avatars.githubusercontent.com; style-src 'self'; script-src 'self'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8' };

// Dev auth trusts a loopback peer. A request that passed through a proxy or
// tunnel still arrives from loopback, so refuse anything that carries proxy
// headers or names a non-loopback Host (on top of the config guard).
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'cf-access-jwt-assertion', 'x-forwarded-for', 'forwarded'];
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const devRequestOk = (req) => LOOPBACK_HOST.test(req.headers.host ?? '') && !PROXY_HEADERS.some((h) => req.headers[h] != null);
const loopbackOnly = (config) => config.auth === 'dev' || config.auth === 'local';
// Accounts mode: pages served without auth (their JS talks to /api/auth/*;
// tokens ride in the URL fragment, which never reaches the server).
const ACCOUNT_PAGES = { '/signin': 'signin.html', '/auth/email': 'signin.html', '/invite': 'invite.html' };

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

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), ...headers });
  res.end(data);
}

// Dispatch-like actions start paid agent runs: a tighter per-member limit.
const DISPATCH_ACTIONS = new Set(['dispatch', 'retry', 'take_over_with_claude']);

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

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) throw new HubError('PAYLOAD_TOO_LARGE', 'body over 1 MiB');
    chunks.push(c);
  }
  if (!n) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new HubError('VALIDATION', 'body must be a JSON object');
  }
}

export function createHttpHandler({ hub, api, config }) {
  const etags = new Map();

  const authMember = makeAuthMember({ hub, config });
  // The org a request's resource lives in: decides which member row answers
  // when one sign-in belongs to several orgs.
  const resourceOrg = (r, params) => {
    const boardOrg = (boardId) => hub.board(boardId)?.org_id ?? null;
    if (params.board_id) return boardOrg(params.board_id);
    if (params.card_id) { const c = hub.card(params.card_id); return c ? boardOrg(c.board_id) : null; }
    if (r.pattern.startsWith('/api/permission-requests/')) {
      const p = hub.db.get('SELECT card_id FROM permission_requests WHERE id = ?', params.id);
      const c = p && hub.card(p.card_id);
      return c ? boardOrg(c.board_id) : null;
    }
    if (r.pattern.startsWith('/api/devices/')) return hub.member(hub.device(params.id)?.member_id)?.org_id ?? null;
    if (r.pattern.startsWith('/api/members/')) return hub.member(params.id)?.org_id ?? null;
    return null;
  };

  const routes = [];
  const route = (method, pattern, handler, { auth = 'member', mutating = method !== 'GET' } = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler, auth, mutating, pattern });
  };

  route('GET', '/api/health', () => ({ ok: true, protocol: PROTOCOL_VERSION, hub_epoch: hub.epoch, uptime_ms: Math.round(hub.uptime()), auth: config.auth }), { auth: 'none' });
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
    route('POST', '/api/auth/email/start', ({ body, ip, ident, req, res }) => acc.start(body, { ip, ident, req, res }), { auth: 'optional' });
    route('POST', '/api/auth/email/verify', ({ body, ip, ident, req, res }) => acc.verify(body, { ip, ident, req, res }), { auth: 'optional' });
    route('POST', '/api/auth/signout', ({ ident, ip, res }) => acc.signout(ident, { ip, res }), { auth: 'user' });
    route('GET', '/api/account', ({ ident }) => acc.account(ident), { auth: 'user' });
    route('DELETE', '/api/account', ({ ident, body, ip }) => acc.deleteAccount(ident, body, { ip }), { auth: 'user' });
    route('GET', '/api/account/devices', ({ ident }) => acc.listDevices(ident), { auth: 'user' });
    route('DELETE', '/api/account/devices/:id', ({ ident, params, ip }) => acc.revokeDevice(ident, params.id, { ip }), { auth: 'user' });
    // The older web asks /api/me: the account plus, once the user is in a
    // team, the legacy {member, org, boards} of the chosen one.
    route('GET', '/api/me', ({ ident, req, query }) => {
      const out = acc.account(ident);
      const cands = userMembers(hub, ident.user.id);
      if (!cands.length) return { ...out, member: null, org: null, boards: [] };
      return { ...out, ...api.me(pickMember(hub, cands, { requestedOrg: req.headers['board-org'] || query.get('org') || null })) };
    }, { auth: 'user' });
  } else {
    route('GET', '/api/me', ({ member }) => api.me(member));
  }
  route('GET', '/api/boards/:board_id', ({ member, params }) => api.snapshot(member, params.board_id));
  route('GET', '/api/boards/:board_id/alerts', ({ member, params }) => api.alerts(member, params.board_id));
  route('GET', '/api/boards/:board_id/journal', ({ member, params, query }) => api.journalPage(member, params.board_id, { after_seq: query.get('after_seq') ?? 0, limit: query.get('limit') ?? 200 }));
  route('POST', '/api/boards/:board_id/cards', ({ member, params, body }) => api.createCard(member, params.board_id, body));
  route('POST', '/api/boards/:board_id/repos', ({ member, params, body }) => api.addBoardRepo(member, params.board_id, body));
  route('GET', '/api/cards/:card_id', ({ member, params }) => api.detail(member, params.card_id));
  route('PATCH', '/api/cards/:card_id', ({ member, params, body }) => api.patchCard(member, params.card_id, body));
  route('POST', '/api/cards/:card_id/actions/:action', ({ member, params, body }) => api.action(member, params.card_id, params.action, body));
  route('POST', '/api/cards/:card_id/comments', ({ member, params, body }) => api.comment(member, params.card_id, body));
  route('GET', '/api/cards/:card_id/handover', ({ member, params, query, res }) => {
    const h = api.handover(member, params.card_id);
    if (query.get('format') === 'md') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) });
      res.end(h.markdown);
      return undefined;
    }
    return h;
  });
  route('GET', '/api/cards/:card_id/overlap-preview', ({ member, params, query }) => api.overlapPreview(member, params.card_id, query.get('target_member_id')));
  route('POST', '/api/permission-requests/:id/answer', ({ member, params, body }) => api.answerPermission(member, params.id, body));
  route('GET', '/api/devices', ({ member }) => api.listDevices(member));
  route('POST', '/api/devices', ({ member, body }) => api.createDevice(member, body));
  route('DELETE', '/api/devices/:id', ({ member, params }) => api.revokeDevice(member, params.id));
  route('GET', '/api/repos', ({ member }) => api.listRepos(member));
  route('POST', '/api/repos', ({ member, body }) => api.createRepo(member, body));
  route('POST', '/api/members', ({ member, body }) => api.createMember(member, body));
  route('DELETE', '/api/members/:id', ({ member, params }) => api.removeMember(member, params.id));

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
      'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
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

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://hub');
    if (loopbackOnly(config) && !devRequestOk(req)) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: `${config.auth} auth serves direct loopback requests only` } });
    if (config.auth === 'local' && !localCookieOk(hub, req)) return sendJson(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'not signed in' } });
    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
        const p = staticPath(url.pathname);
        if (!p) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
        return await serveFile(req, res, p);
      }
      let match = null;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (m) { match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break; }
      }
      if (!match) throw new HubError('NOT_FOUND', 'no such route');
      const { r, params } = match;
      const ip = clientIp(req, config);
      if (r.mutating) limitOrThrow(hub, r.auth === 'none' ? 'login_ip' : 'mutate_ip', ip);
      if (r.mutating) {
        if (!sameOrigin(req, config.publicUrl)) throw new HubError('FORBIDDEN', 'cross-origin request');
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HubError('VALIDATION', 'Content-Type must be application/json');
      }
      const body = r.mutating ? await readBody(req) : {};
      const pick = { resourceOrg: resourceOrg(r, params), requestedOrg: req.headers['board-org'] || url.searchParams.get('org') || null };
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
        if (r.auth === 'member') {
          const cands = userMembers(hub, ident.user.id);
          if (!cands.length) throw new HubError('NOT_FOUND', 'not in a team yet');
          member = pickMember(hub, cands, pick);
        }
      } else if (r.auth === 'member') {
        member = await authMember(req, pick);
      }
      const actor = member?.id ?? (ident && r.auth === 'user' ? `user:${ident.user.id}` : null);
      const rid = actor && r.mutating && typeof body.request_id === 'string' ? body.request_id : null;
      if (rid) {
        const hit = hub.cachedResponse(actor, rid);
        if (hit) return sendJson(res, hit.status, hit.body, { 'board-replayed': '1' });
      }
      if (actor && r.mutating) {
        limitOrThrow(hub, 'mutate_member', actor);
        if (DISPATCH_ACTIONS.has(params.action)) limitOrThrow(hub, 'dispatch_member', actor);
      }
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
      if (rid) hub.cacheResponse(actor, rid, status, out);
      return sendJson(res, status, out, out?.error?.code === 'RATE_LIMITED' && out.error.retry_after_s ? { 'retry-after': String(out.error.retry_after_s) } : {});
    } catch (e) {
      if (e instanceof HubError) return sendJson(res, httpStatus(e.code), errorBody(e), retryHeader(e));
      hub.log.error('http handler failed', { path: url.pathname, err: e });
      return sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
    }
  };
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
      const auth = await authenticateRunner(hub, req);
      return wss.handleUpgrade(req, socket, head, (ws) => {
        if (auth.close) { ws.close(auth.close, auth.reason); return; }
        new RunnerConn(hub, ws, auth.device);
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

export const userMembers = (hub, userId) => hub.db.all('SELECT * FROM members WHERE user_id = ? AND removed_at IS NULL ORDER BY created_at', userId);

export function makeAuthMember({ hub, config }) {
  const authenticate = makeAuthenticate({ hub, config });
  return async (req, opts) => pickMember(hub, (await authenticate(req)).candidates, opts);
}
