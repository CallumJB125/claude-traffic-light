import { HubError } from '../db.js';
import { parseCookies } from '../auth.js';
import { appendCookie } from '../identity/accounts.js';
import { clientIp, ipKey, limitOrThrow } from '../ratelimit.js';
import { httpStatus } from '../../shared/protocol.js';
import { RemoteActions } from './actions.js';
import { authorizationMetadata, resourceMetadata, challenge } from './metadata.js';
import { serveMcp, validateRpc } from './transport.js';
import { closed, strictJson, uniqueParams, UUID, invalid } from './validation.js';

const SECURITY_HEADERS = ['host', 'origin', 'authorization', 'cookie', 'content-type', 'content-length',
  'transfer-encoding', 'mcp-protocol-version', 'mcp-session-id', 'x-csrf-token', 'x-board-team', 'board-org'];
const PATHS = Object.freeze([
  ['GET', '/.well-known/oauth-protected-resource'], ['GET', '/.well-known/oauth-protected-resource/api/mcp'],
  ['GET', '/.well-known/oauth-authorization-server'], ['GET', '/oauth/authorize'], ['POST', '/oauth/register'],
  ['POST', '/oauth/token'], ['POST', '/oauth/revoke'], ['GET', '/oauth/consent'], ['POST', '/oauth/consent'],
  ['POST', '/api/mcp'], ['GET', '/api/mcp'], ['DELETE', '/api/mcp'],
]);
const GRANT_PATH = /^\/api\/teams\/[^/]+\/remote-grants(?:\/(?:gesture|[^/]+))?$/;
function headers(req, issuer) {
  if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('#')) throw invalid();
  const counts = new Map();
  for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
    const key = req.rawHeaders[i].toLowerCase(); counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (SECURITY_HEADERS.some(key => (counts.get(key) ?? 0) > 1)) throw invalid();
  const base = new URL(issuer);
  if (typeof req.headers.host !== 'string' || req.headers.host.toLowerCase() !== base.host) throw new HubError('FORBIDDEN', 'configured host required');
  if (req.headers.origin != null && req.headers.origin !== base.origin) throw new HubError('FORBIDDEN', 'cross-origin request');
  if (req.headers['mcp-session-id'] != null) throw invalid();
}
const browserOrigin = (req, issuer) => req.headers.origin === issuer
  && (req.headers['sec-fetch-site'] == null || req.headers['sec-fetch-site'] === 'same-origin');
function json(res, status, body, extra = {}) {
  if (res.req && !res.req.complete && (res.req.headers['transfer-encoding'] != null || Number(res.req.headers['content-length'] ?? 0) > 0)) res.shouldKeepAlive = false;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'", ...extra });
  res.end(JSON.stringify(body));
}
function redirect(res, location) {
  res.writeHead(303, { location, 'cache-control': 'no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'" }); res.end();
}
function read(req, signal, max, form = false) {
  const type = req.headers['content-type'] ?? '';
  if (!(form ? /^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i : /^application\/json(?:;\s*charset=utf-8)?$/i).test(type)) throw invalid();
  if (Number(req.headers['content-length']) > max) throw new HubError('PAYLOAD_TOO_LARGE', 'remote request too large');
  return new Promise((resolve, reject) => {
    let length = 0, ended = false; const chunks = [];
    const finish = (error, value) => {
      if (ended) return; ended = true;
      req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', fail);
      signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value);
    };
    const fail = () => finish(invalid());
    const abort = () => finish(new HubError('TIMEOUT', 'remote request ended'));
    const data = chunk => { length += chunk.length; if (length > max) finish(new HubError('PAYLOAD_TOO_LARGE', 'remote request too large')); else chunks.push(chunk); };
    const end = () => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        finish(null, form ? new URLSearchParams(text) : strictJson(text));
      } catch { finish(invalid()); }
    };
    req.on('data', data); req.once('end', end); req.once('error', fail); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export function createRemoteHttp(hub) {
  const authority = hub.remoteAuthority;
  if (!authority) return null;
  const actions = new RemoteActions(hub), state = { transports: new Set(), inFlight: 0, ips: new Map(), grants: new Map() };
  const cookieName = () => authority.issuer().startsWith('https:') ? '__Host-plexiform_remote' : 'plexiform_remote';
  const cookie = req => {
    try {
      const key = cookieName(), raw = req.headers.cookie ?? '';
      if (String(raw).split(';').filter(part => part.slice(0, part.indexOf('=')).trim() === key).length !== 1) return null;
      return parseCookies(raw)[key] ?? null;
    } catch { return null; }
  };
  const setCookie = (res, value) => appendCookie(res, `${cookieName()}=${value ?? ''}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${value ? 600 : 0}${authority.issuer().startsWith('https:') ? '; Secure' : ''}`);
  const identity = req => {
    const ident = hub.accounts.authenticate(req, { rotate: false });
    if (!ident || ident.cred.kind !== 'session') throw new HubError('FORBIDDEN', 'a current browser session is required');
    authority.session(ident.user, ident.cred); return ident;
  };
  const member = (ident, id) => {
    if (typeof id !== 'string' || !UUID.test(id)) throw invalid();
    const row = hub.db.get('SELECT * FROM members WHERE user_id=? AND org_id=? AND removed_at IS NULL', ident.user.id, id);
    if (!row) throw new HubError('NOT_FOUND', 'team unavailable');
    return authority.currentMember(row.id, ident.user.id, id);
  };
  const refreshSession = ctx => {
    if (!browserOrigin(ctx.req, authority.issuer()) || !hub.accounts.csrfOk(ctx.ident, ctx.req.headers['x-csrf-token'])) throw new HubError('FORBIDDEN', 'browser confirmation required');
    authority.session(ctx.ident.user, ctx.ident.cred);
  };
  const management = (route) => {
    route('GET', '/api/teams/:team_id/remote-grants', ({ member, ident }) => authority.list(member, ident.cred), { replay: false });
    route('POST', '/api/teams/:team_id/remote-grants/gesture', ctx => { refreshSession(ctx); return authority.gesture(ctx.member, ctx.ident.cred, ctx.body); }, { replay: false, strictBody: true });
    route('POST', '/api/teams/:team_id/remote-grants', ctx => { refreshSession(ctx); return authority.create(ctx.member, ctx.ident.cred, ctx.body); }, { replay: false, strictBody: true });
    route('DELETE', '/api/teams/:team_id/remote-grants/:grant_id', ctx => { refreshSession(ctx); return authority.revoke(ctx.member, ctx.ident.cred, ctx.params.grant_id, ctx.body); }, { replay: false, strictBody: true });
  };
  const guardManagement = (req, url) => {
    if (!hub.config.publicUrl || !GRANT_PATH.test(url.pathname)) return;
    headers(req, authority.issuer()); if (url.search) throw invalid();
    if (req.method !== 'GET' && !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw invalid();
  };
  async function handle(req, res, url) {
    if (!hub.config.publicUrl || !PATHS.some(([, path]) => path === url.pathname)) return false;
    let admitted = false, grantId = null; const controller = new AbortController();
    const abort = () => controller.abort(); let timeout = null;
    const ip = ipKey(clientIp(req, hub.config)), count = (map, key) => map.get(key) ?? 0;
    const remove = (map, key) => { const n = count(map, key) - 1; n > 0 ? map.set(key, n) : map.delete(key); };
    try {
      headers(req, authority.issuer());
      if (!PATHS.some(([method, path]) => path === url.pathname && method === req.method)) { json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method unavailable' } }); return true; }
      const mcp = url.pathname === '/api/mcp';
      if (url.pathname !== '/oauth/authorize' && url.pathname !== '/oauth/consent' && url.search) throw invalid();
      if (state.inFlight >= authority.limit('httpInFlight', 32) || count(state.ips, ip) >= authority.limit('httpInFlightPerIP', 4)) throw new HubError('RATE_LIMITED', 'remote requests are busy');
      limitOrThrow(hub, mcp ? 'remote_request_ip' : 'remote_public_ip', ip);
      let token = null;
      if (mcp) {
        if (typeof req.headers.authorization !== 'string' || !/^Bearer pfm_[A-Za-z0-9_-]{43}$/.test(req.headers.authorization)) throw new HubError('UNAUTHENTICATED', 'remote bearer required');
        token = req.headers.authorization.slice(7);
        const scope = authority.authenticate(token, 'mcp'); grantId = scope.grant.id;
        if (count(state.grants, grantId) >= authority.limit('httpInFlightPerGrant', 8)) throw new HubError('RATE_LIMITED', 'remote connection is busy');
        limitOrThrow(hub, 'remote_request_grant', grantId);
        if (req.method !== 'POST') { json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'stateless resource accepts POST' } }, { allow: 'POST' }); return true; }
      } else if (req.headers.authorization != null) throw new HubError('FORBIDDEN', 'ordinary bearer credentials are not accepted here');
      state.inFlight++; state.ips.set(ip, count(state.ips, ip) + 1); if (grantId) state.grants.set(grantId, count(state.grants, grantId) + 1); admitted = true;
      req.once('aborted', abort); res.once('close', abort); res.once('finish', abort);
      timeout = setTimeout(abort, authority.limit('httpDeadlineMs', 20_000)); timeout.unref();
      res.setHeader('cache-control', 'no-store'); res.setHeader('pragma', 'no-cache'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
      if (mcp) {
        const body = await read(req, controller.signal, 64 * 1024);
        validateRpc(body, req.headers['mcp-protocol-version']); authority.authenticate(token, 'mcp');
        if (body.method === 'tools/call') actions.guard(token, 'mcp', body.params?.name, body.params?.arguments ?? {});
        await serveMcp({ req, res, body, token, actions, signal: controller.signal, state });
      } else if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) json(res, 200, resourceMetadata(authority));
      else if (url.pathname === '/.well-known/oauth-authorization-server') json(res, 200, authorizationMetadata(authority));
      else if (url.pathname === '/oauth/authorize') {
        const params = uniqueParams(url.searchParams, ['client_id', 'redirect_uri', 'response_type', 'state', 'resource', 'code_challenge', 'code_challenge_method', 'scope']);
        const intent = authority.authorize(params); setCookie(res, intent.browser); redirect(res, `/remote-consent#intent=${intent.intent_id}`);
      } else if (url.pathname === '/oauth/register') {
        const body = await read(req, controller.signal, 8 * 1024); json(res, 201, authority.register(body, { ip }));
      } else if (url.pathname === '/oauth/token' || url.pathname === '/oauth/revoke') {
        const params = await read(req, controller.signal, 16 * 1024, true);
        const body = uniqueParams(params, url.pathname === '/oauth/token'
          ? ['grant_type', 'code', 'redirect_uri', 'client_id', 'code_verifier', 'resource', 'refresh_token']
          : ['token', 'client_id', 'token_type_hint']);
        json(res, 200, url.pathname === '/oauth/token' ? authority.token(body) : authority.revokeToken(body));
      } else if (req.method === 'GET') {
        const params = uniqueParams(url.searchParams, ['intent'], ['intent']);
        let ident = null; try { ident = identity(req); } catch { /* preview grants no authority */ }
        const preview = authority.preview(params.intent, cookie(req), ident);
        json(res, 200, { ...preview, signed_in: !!ident, ...(ident ? { account: hub.accounts.account(ident) } : {}) });
      } else {
        if (url.search || !browserOrigin(req, authority.issuer())) throw new HubError('FORBIDDEN', 'browser confirmation required');
        const ident = identity(req);
        if (!hub.accounts.csrfOk(ident, req.headers['x-csrf-token'])) throw new HubError('FORBIDDEN', 'browser confirmation required');
        const body = await read(req, controller.signal, 16 * 1024); closed(body, ['intent_id', 'team_id', 'approve', 'board_ids', 'mode']);
        authority.session(ident.user, ident.cred);
        const result = authority.consent(member(ident, body.team_id), ident.cred, body.intent_id, cookie(req),
          { approve: body.approve, board_ids: body.board_ids, mode: body.mode });
        setCookie(res, null); json(res, 200, result);
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const status = error instanceof HubError ? httpStatus(error.code) : 500;
        if (url.pathname === '/api/mcp') json(res, status, { error: { code: error instanceof HubError ? error.code : 'INTERNAL', message: error instanceof HubError ? error.message : 'remote resource unavailable' } },
          [401, 403].includes(status) ? { 'www-authenticate': challenge(authority, status === 403) } : {});
        else json(res, status === 401 && url.pathname === '/oauth/token' ? 400 : status, { error: status === 401 ? 'invalid_grant' : status === 429 ? 'temporarily_unavailable' : status >= 500 ? 'server_error' : 'invalid_request' });
      }
      if (!req.complete) { res.shouldKeepAlive = false; req.resume(); setTimeout(() => req.socket?.destroy(), 1000).unref(); }
    } finally {
      if (timeout) clearTimeout(timeout); controller.abort();
      req.removeListener('aborted', abort); res.removeListener('close', abort); res.removeListener('finish', abort);
      if (admitted) { state.inFlight--; remove(state.ips, ip); if (grantId) remove(state.grants, grantId); }
    }
    return true;
  }
  return { handle, management, guardManagement, state, routes: PATHS.map(([method, pattern]) => ({ method, pattern, auth: 'remote' })) };
}
