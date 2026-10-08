// Public API v1 (docs/PUBLIC-API.md): a versioned, read-biased subset of the
// board for other tools, authenticated only by team API tokens (tokens.js),
// plus the team-admin routes that manage tokens and outbound webhooks
// (webhooks.js). The /api/public/v1/* paths are answered before the hub's
// route table: no session, cookie or CSRF token ever counts there.

import { PROTOCOL_VERSION, PROTOCOL_HEADER, httpStatus } from '../../shared/protocol.js';
import { HubError } from '../db.js';
import { ipKey, limitOrThrow } from '../ratelimit.js';
import { ApiTokens } from './tokens.js';
import { Webhooks } from './webhooks.js';

export const API_VERSION = '1';
const BODY_MAX = 16 * 1024;
const BODY_DEADLINE_MS = 10_000;
const PAGE = Object.freeze({ default: 100, max: 200 });

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'plexiform-api-version': API_VERSION, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), ...headers,
  });
  res.end(JSON.stringify(body));
};

function readJson(req) {
  if (Number(req.headers['content-length']) > BODY_MAX) return Promise.reject(new HubError('PAYLOAD_TOO_LARGE', 'body over 16 KiB'));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let settled = false;
    const end = (fn, v) => { if (!settled) { settled = true; clearTimeout(t); fn(v); } };
    const t = setTimeout(() => end(reject, new HubError('TIMEOUT', 'body not received in time')), BODY_DEADLINE_MS);
    req.on('data', (c) => { n += c.length; if (n > BODY_MAX) end(reject, new HubError('PAYLOAD_TOO_LARGE', 'body over 16 KiB')); else chunks.push(c); });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        end(resolve, v);
      } catch { end(reject, new HubError('VALIDATION', 'body must be a JSON object')); }
    });
    req.on('error', () => end(reject, new HubError('VALIDATION', 'body not received')));
  });
}

const cursorOf = (row) => Buffer.from(JSON.stringify([row.created_at, row.id])).toString('base64url');
function parseCursor(s) {
  if (s == null || s === '') return null;
  try {
    const v = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'string')) return v;
  } catch { /* fall through */ }
  throw new HubError('VALIDATION', 'cursor is not valid');
}
function pageSize(q) {
  if (!q.has('limit')) return PAGE.default;
  const n = Number(q.get('limit'));
  if (!Number.isInteger(n) || n < 1 || n > PAGE.max) throw new HubError('VALIDATION', `limit must be 1–${PAGE.max}`);
  return n;
}

const labelsOf = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
const cardSummary = (c) => ({
  id: c.id, board_id: c.board_id, key: c.key, title: c.title, column: c.column_name, run_state: c.run_state ?? null,
  labels: labelsOf(c.labels), created_at: c.created_at, updated_at: c.updated_at, archived_at: c.archived_at ?? null,
});

export class PublicApi {
  constructor(hub, { api, bus = null, allowHttp = false, allowPrivate = false, lookup } = {}) {
    this.hub = hub;
    this.api = api;
    this.db = hub.db;
    this.tokens = new ApiTokens(hub);
    this.webhooks = new Webhooks(hub, { bus, allowHttp, allowPrivate, lookup });
  }

  // ── team admin routes (session or device sign-in, X-CSRF-Token on cookies) ──

  routes(route) {
    const admin = (fn) => (ctx) => { this.api.requireAdmin(ctx.member); return fn(ctx); };
    // An await (DNS, the test POST) may outlast the admin's role: check again after.
    const still = (ctx) => { const m = this.api.currentMember(ctx.member, ctx.ident?.cred ?? null); this.api.requireAdmin(m); return m; };
    const t = this.tokens, w = this.webhooks;
    route('GET', '/api/teams/:team_id/api-tokens', admin(({ member }) => t.list(member)), { replay: false });
    route('POST', '/api/teams/:team_id/api-tokens', admin(({ member, body, ip }) => t.create(member, body, { ip })), { replay: false });
    route('DELETE', '/api/teams/:team_id/api-tokens/:token_id', admin(({ member, params, ip }) => t.revoke(member, params.token_id, { ip })), { replay: false });
    route('GET', '/api/teams/:team_id/webhooks', admin(({ member }) => w.list(member)), { replay: false });
    route('POST', '/api/teams/:team_id/webhooks', admin((ctx) => w.create(ctx.member, ctx.body, { ip: ctx.ip, recheck: () => still(ctx) })), { replay: false });
    route('PATCH', '/api/teams/:team_id/webhooks/:endpoint_id', admin(({ member, params, body, ip }) => w.update(member, params.endpoint_id, body, { ip })), { replay: false });
    route('DELETE', '/api/teams/:team_id/webhooks/:endpoint_id', admin(({ member, params, ip }) => w.remove(member, params.endpoint_id, { ip })), { replay: false });
    route('GET', '/api/teams/:team_id/webhooks/:endpoint_id/deliveries', admin(({ member, params }) => w.deliveries(member, params.endpoint_id)), { replay: false });
    route('POST', '/api/teams/:team_id/webhooks/:endpoint_id/test', admin(async (ctx) => {
      const out = await w.test(ctx.member, ctx.params.endpoint_id, { ip: ctx.ip });
      still(ctx);
      return out;
    }), { replay: false });
  }

  // ── /api/public/v1/* (API token only) ─────────────────────────────────────

  /** → true: answered (every /api/public/ path is answered here). */
  async handle(req, res, url, ip) {
    try {
      const out = await this.dispatch(req, url, ip);
      send(res, 200, out);
    } catch (e) {
      if (!(e instanceof HubError)) {
        this.hub.log.error('public api failed', { err: e?.message });
        send(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
        return true;
      }
      const { code, message, extra = {} } = e;
      const headers = code === 'RATE_LIMITED' && extra.retry_after_s ? { 'retry-after': String(extra.retry_after_s) }
        : code === 'UNAUTHENTICATED' ? { 'www-authenticate': 'Bearer realm="plexiform"' } : {};
      send(res, httpStatus(code), { error: { code, message, ...extra } }, headers);
    }
    return true;
  }

  match(method, path) {
    const m = (re) => re.exec(path);
    let p;
    if (method === 'GET' && path === '/api/public/v1/boards') return { name: 'boards', scope: 'read:boards' };
    if (method === 'GET' && (p = m(/^\/api\/public\/v1\/boards\/([^/]+)\/cards$/))) return { name: 'cards', scope: 'read:cards', id: p[1] };
    if (method === 'GET' && (p = m(/^\/api\/public\/v1\/cards\/([^/]+)$/))) return { name: 'card', scope: 'read:cards', id: p[1] };
    if (method === 'GET' && (p = m(/^\/api\/public\/v1\/cards\/([^/]+)\/events$/))) return { name: 'events', scope: 'read:cards', id: p[1] };
    if (method === 'POST' && (p = m(/^\/api\/public\/v1\/cards\/([^/]+)\/comments$/))) return { name: 'comment', scope: 'write:cards-comment', id: p[1] };
    return null;
  }

  async dispatch(req, url, ip) {
    const route = this.match(req.method, url.pathname);
    if (!route) throw new HubError('NOT_FOUND', 'no such route');
    let id;
    try { id = route.id === undefined ? undefined : decodeURIComponent(route.id); } catch { throw new HubError('NOT_FOUND', 'not found'); }
    const { token, member } = this.tokens.authenticate(req, { ipKey: ipKey(ip) });
    if (!token.scopes.includes(route.scope)) throw new HubError('FORBIDDEN', `this token lacks the ${route.scope} scope`, { reason: 'SCOPE' });
    if (route.name === 'comment') {
      limitOrThrow(this.hub, 'mutate_ip', ipKey(ip));
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HubError('VALIDATION', 'Content-Type must be application/json');
    }
    this.tokens.noteUse(token, member, { ip, route: `${req.method} ${route.name}` });
    const q = url.searchParams;
    if (route.name === 'boards') {
      return { boards: this.hub.boardList(member.org_id, { includeArchived: q.get('include_archived') === '1' }) };
    }
    if (route.name === 'cards') {
      const board = this.boardOf(member, id);
      const limit = pageSize(q);
      const after = parseCursor(q.get('cursor'));
      const archived = q.get('include_archived') === '1' ? '' : 'AND archived_at IS NULL';
      const rows = this.db.all(`SELECT * FROM cards WHERE board_id = ? ${archived} ${after ? 'AND (created_at, id) > (?, ?)' : ''} ORDER BY created_at, id LIMIT ?`,
        board.id, ...(after ?? []), limit + 1);
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      return { cards: page.map(cardSummary), next_cursor: more ? cursorOf(page.at(-1)) : null };
    }
    const card = this.cardOf(member, id);
    if (route.name === 'card') return { card: { ...cardSummary(card), body: card.body, acceptance: card.acceptance ?? null } };
    if (route.name === 'events') {
      const after = q.has('after_seq') ? Number(q.get('after_seq')) : 0;
      if (!Number.isSafeInteger(after) || after < 0) throw new HubError('VALIDATION', 'after_seq must be a whole number');
      const limit = pageSize(q);
      const rows = this.db.all('SELECT * FROM journal WHERE card_id = ? AND seq > ? ORDER BY seq LIMIT ?', card.id, after, limit);
      const events = rows.map((r) => {
        let payload;
        try { payload = JSON.parse(r.payload); } catch { payload = {}; }
        const types = this.webhooks.eventsOf({ ...r, payload }, card).map((x) => x.type);
        return { seq: r.seq, at: r.at_hub, kind: r.kind, actor_kind: r.actor_kind, types };
      });
      return { events, next_after_seq: rows.length ? rows.at(-1).seq : after };
    }
    const body = await readJson(req);
    if (body.request_id != null && (typeof body.request_id !== 'string' || !body.request_id || body.request_id.length > 100)) throw new HubError('VALIDATION', 'request_id must be a string of at most 100 characters');
    const actor = `api_token:${token.id}`;
    const hit = body.request_id ? this.hub.cachedResponse(actor, body.request_id) : null;
    if (hit) {
      if (hit.binding !== card.id) throw new HubError('CONFLICT', 'request_id reused for a different card');
      return hit.body;
    }
    limitOrThrow(this.hub, 'mutate_member', member.id);
    const out = await this.api.comment(member, card.id, { body: body.body, for_agent: false }, { cred: null });
    const answer = { comment: { id: out.comment.id, card_id: card.id, author_member_id: member.id, created_at: this.db.get('SELECT created_at FROM comments WHERE id = ?', out.comment.id)?.created_at ?? null } };
    if (body.request_id) this.hub.cacheResponse(actor, body.request_id, 200, answer, card.id);
    return answer;
  }

  boardOf(member, id) {
    const b = this.hub.board(id);
    if (!b || b.org_id !== member.org_id) throw new HubError('NOT_FOUND', 'board not found');
    return b;
  }

  cardOf(member, id) {
    const c = this.hub.card(id);
    if (!c) throw new HubError('NOT_FOUND', 'card not found');
    this.boardOf(member, c.board_id);
    return c;
  }
}
