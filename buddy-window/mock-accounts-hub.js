// An in-process stand-in for a team hub in BOARD_AUTH=accounts mode, until
// callumbaker-70's real one lands. Used by tests and by the dev-only
// `--buddy-mock-accounts` flag. Shapes and error codes follow
// board/ACCOUNTS-API.md (P1 as built, P2–P4 as planned); state is in memory
// and dies with the process.
//
// Test hooks: `lastCode(email)` (the emailed code), `setNow(ms)` (clock),
// `starts()` (email/start bodies), `revokeAll(email)`, `enrolments()`.
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const STEP_UP_MS = 5 * 60_000;
const INVITE_TTL_MS = 7 * 24 * 3600_000;
const VERIFY_PER_ADDRESS = 10; // per 15 minutes, right or wrong
const VERIFY_WINDOW_MS = 15 * 60_000;
const ROLES = ['owner', 'admin', 'member', 'guest'];
const WS_UNAUTHENTICATED = 4401;

const rid = (p) => `${p}_${crypto.randomBytes(9).toString('base64url')}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mask = (email) => `${email.charAt(0)}…@${email.split('@')[1]}`;
const firstName = (u) => String(u?.display_name ?? 'Someone').split(/\s+/)[0];

function createMockAccountsHub({ log = () => {}, now: clock = () => Date.now() } = {}) {
  let skew = null;
  const now = () => skew ?? clock();
  let base = null; // our own origin, once listening
  const users = new Map(); // id → {id, email, display_name}
  const byEmail = new Map();
  const flows = new Map(); // id → {email, user_id, codeHash, expires, wrong, purpose, dead, verifiedAt, used}
  const codes = new Map(); // email → last plain code (test hook only)
  const verifies = new Map(); // email → [attempt times]
  const starts = [];
  const tokens = new Map(); // sha(token) → {user_id, device_id, revoked}
  const sockets = new Map(); // sha(token) → Set<ws>
  const teams = new Map(); // id → {id, name, slug, boards}
  const members = []; // {id, team_id, user_id, role, joined_at}
  const invites = new Map(); // id → {id, team_id, email, role, tokenHash, expires_at, inviter_id, used, revoked}
  const enrolments = [];

  const err = (status, code, message, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });
  const ok = (body) => ({ status: 200, body });

  function authed(req) {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (!m) return null;
    const t = tokens.get(sha(m[1]));
    if (!t || t.revoked) return null;
    return users.get(t.user_id) ? { ...t, user: users.get(t.user_id), tokenHash: sha(m[1]) } : null;
  }

  function revoke(tokenHash) {
    const t = tokens.get(tokenHash);
    if (t) t.revoked = true;
    for (const ws of sockets.get(tokenHash) ?? []) {
      try { ws.send(JSON.stringify({ type: 'session.revoked' })); ws.close(WS_UNAUTHENTICATED, 'revoked'); } catch { /* gone */ }
    }
    sockets.delete(tokenHash);
  }

  const roleIn = (teamId, userId) => members.find((m) => m.team_id === teamId && m.user_id === userId)?.role ?? null;
  const canManage = (teamId, userId) => ['owner', 'admin'].includes(roleIn(teamId, userId));
  const iso = (ms) => new Date(ms).toISOString();
  const inviteView = (i) => ({ id: i.id, email: i.email, role: i.role, expires_at: iso(i.expires_at), created_by_name: users.get(i.inviter_id)?.display_name ?? 'Someone' });
  const liveInvite = (i) => !i.used && !i.revoked && i.expires_at > now();

  function account(user) {
    return {
      user: { id: user.id, display_name: user.display_name, email: user.email, email_verified: true },
      teams: members.filter((m) => m.user_id === user.id).map((m) => {
        const t = teams.get(m.team_id);
        return { id: t.id, name: t.name, slug: t.slug, role: m.role, member_id: m.id, boards: t.boards };
      }).sort((a, b) => a.name.localeCompare(b.name)),
      pending_invites: [...invites.values()].filter((i) => i.email === user.email && liveInvite(i) && !roleIn(i.team_id, user.id)).map((i) => ({
        id: i.id, team_name: teams.get(i.team_id).name, inviter_first_name: firstName(users.get(i.inviter_id)), role: i.role, expires_at: iso(i.expires_at),
      })),
    };
  }

  function startFlow(email, purpose, userId = null) {
    const id = crypto.randomBytes(18).toString('base64url');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    flows.set(id, { email, user_id: userId, codeHash: sha(code), expires: now() + CODE_TTL_MS, wrong: 0, purpose, dead: false, verifiedAt: null, used: false });
    codes.set(email, code);
    log(`[mock-hub] ${purpose === 'delete' ? 'delete-account' : 'sign-in'} code for ${email}: ${code}`);
    return id;
  }

  // Every attempt counts against the address, right or wrong: over the limit
  // even the right code is refused until the bucket refills.
  function limited(email) {
    const t = now();
    const list = (verifies.get(email) ?? []).filter((x) => t - x < VERIFY_WINDOW_MS);
    list.push(t);
    verifies.set(email, list);
    if (list.length <= VERIFY_PER_ADDRESS) return null;
    const retry = Math.ceil((list[0] + VERIFY_WINDOW_MS - t) / 1000);
    return { ...err(429, 'RATE_LIMITED', 'too many attempts for this address', { retry_after_s: retry }), headers: { 'retry-after': String(retry) } };
  }

  function checkCode(f, code) {
    if (!f || f.dead || f.used || f.expires <= now()) { if (f) f.dead = true; return err(400, 'INVALID_TOKEN', 'invalid or expired code'); }
    const a = Buffer.from(sha(String(code ?? ''))); const b = Buffer.from(f.codeHash);
    if (!crypto.timingSafeEqual(a, b)) {
      f.wrong += 1;
      if (f.wrong >= MAX_ATTEMPTS) f.dead = true;
      return err(400, 'INVALID_TOKEN', 'wrong code', { attempts_left: MAX_ATTEMPTS - f.wrong });
    }
    return null;
  }

  function findInvite(t) {
    const h = sha(String(t ?? ''));
    return [...invites.values()].find((i) => i.tokenHash === h) ?? null;
  }

  function route(method, path, body, req, url) {
    const me = authed(req);
    const needMe = () => (me ? null : err(401, 'UNAUTHENTICATED', 'not signed in'));
    let m;

    if (method === 'GET' && path === '/api/health') return ok({ ok: true, protocol: 1, auth: 'accounts' });

    // A test route for the bearer guard: a hub URL that redirects to another
    // loopback server, as an open redirect on a real hub would.
    if (method === 'GET' && path === '/api/dev/bounce') {
      const to = url.searchParams.get('to') ?? '';
      if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(to)) return err(400, 'VALIDATION', 'loopback only');
      return { status: 302, body: {}, headers: { location: to } };
    }

    if (method === 'POST' && path === '/api/auth/email/start') {
      starts.push({ ...body });
      const purpose = body.purpose ?? 'signin';
      if (!['signin', 'delete'].includes(purpose)) return err(400, 'VALIDATION', 'bad purpose');
      if (purpose === 'delete') {
        // The code goes to the signed-in account's own address; email and client are ignored.
        if (!me) return err(401, 'UNAUTHENTICATED', 'not signed in');
        return ok({ flow_id: startFlow(me.user.email, 'delete', me.user.id), expires_in: CODE_TTL_MS / 1000 });
      }
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, 'VALIDATION', 'enter a valid email');
      if (body.client !== undefined && !['buddy_desktop', 'web'].includes(body.client)) return err(400, 'VALIDATION', 'bad client');
      if (String(body.device_name ?? '').length > 100 || String(body.platform ?? '').length > 50) return err(400, 'VALIDATION', 'name too long');
      return ok({ flow_id: startFlow(email, 'signin'), expires_in: CODE_TTL_MS / 1000 });
    }

    if (method === 'POST' && path === '/api/auth/email/verify') {
      const f = flows.get(String(body.flow_id ?? ''));
      if (f) { const rl = limited(f.email); if (rl) return rl; }
      if (f?.purpose === 'delete' && me?.user.id !== f.user_id) return err(401, 'UNAUTHENTICATED', 'sign in as that account');
      const bad = checkCode(f, body.code);
      if (bad) return bad;
      if (f.purpose === 'delete') {
        f.verifiedAt = now();
        return ok({ ok: true, flow_id: body.flow_id, step_up_expires_in: STEP_UP_MS / 1000 });
      }
      f.dead = true;
      let user = users.get(byEmail.get(f.email));
      if (!user) {
        user = { id: rid('usr'), email: f.email, display_name: f.email.split('@')[0] };
        users.set(user.id, user);
        byEmail.set(user.email, user.id);
      }
      const token = `bdt_${crypto.randomBytes(32).toString('base64url')}`;
      const device_id = rid('udev');
      tokens.set(sha(token), { user_id: user.id, device_id, name: String(body.device_name ?? ''), revoked: false });
      const a = account(user);
      return ok({ user: a.user, teams: a.teams, device_token: token, device_id });
    }

    if (method === 'POST' && path === '/api/auth/signout') {
      if (!me) return err(401, 'UNAUTHENTICATED', 'not signed in');
      revoke(me.tokenHash);
      return ok({ ok: true });
    }

    if (method === 'GET' && path === '/api/account') return needMe() ?? ok(account(me.user));

    if (method === 'DELETE' && path === '/api/account') {
      if (needMe()) return needMe();
      const f = flows.get(String(body.flow_id ?? ''));
      if (!f || f.purpose !== 'delete' || f.user_id !== me.user.id || f.used || !f.verifiedAt || now() - f.verifiedAt > STEP_UP_MS) {
        return err(401, 'STEP_UP_REQUIRED', 'verify a fresh delete flow first', { max_age_s: STEP_UP_MS / 1000 });
      }
      const sole = [];
      for (const mm of members.filter((x) => x.user_id === me.user.id && x.role === 'owner')) {
        const owners = members.filter((x) => x.team_id === mm.team_id && x.role === 'owner');
        const others = members.filter((x) => x.team_id === mm.team_id && x.user_id !== me.user.id);
        if (owners.length === 1 && others.length) sole.push({ id: mm.team_id, name: teams.get(mm.team_id).name });
      }
      if (sole.length) return err(409, 'CONFLICT', 'sole owner of a team with members', { sole_owner_of: sole });
      f.used = true;
      for (const [h, t] of tokens) if (t.user_id === me.user.id) revoke(h);
      for (const e of enrolments) if (e.user_id === me.user.id) e.revoked = true;
      for (let i = members.length - 1; i >= 0; i -= 1) if (members[i].user_id === me.user.id) members.splice(i, 1);
      users.delete(me.user.id);
      byEmail.delete(me.user.email);
      return ok({ ok: true });
    }

    if (method === 'POST' && path === '/api/teams') {
      if (needMe()) return needMe();
      const name = String(body.name ?? '').trim();
      if (!name || name.length > 60) return err(400, 'VALIDATION', 'name required');
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';
      const team = { id: rid('team'), name, slug, boards: [] };
      const board = { id: rid('brd'), name, key_prefix: name.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'BRD' };
      team.boards.push(board);
      teams.set(team.id, team);
      members.push({ id: rid('mem'), team_id: team.id, user_id: me.user.id, role: 'owner', joined_at: iso(now()) });
      return ok({ team: { id: team.id, name: team.name, slug }, board });
    }

    if ((m = /^\/api\/teams\/([^/]+)\/(members|invites|enrol)(?:\/([^/]+))?$/.exec(path))) {
      if (needMe()) return needMe();
      const [, teamId, what, sub] = m;
      const team = teams.get(teamId);
      const myRole = team ? roleIn(teamId, me.user.id) : null;
      if (!team || !myRole) return err(404, 'NOT_FOUND', 'no such team');
      const admin = canManage(teamId, me.user.id);

      if (what === 'members' && method === 'GET' && !sub) {
        return ok({ members: members.filter((x) => x.team_id === teamId).map((x) => {
          const u = users.get(x.user_id);
          return { member_id: x.id, user_id: u.id, display_name: u.display_name, role: x.role, joined_at: x.joined_at, ...(admin ? { email: u.email } : {}) };
        }) });
      }
      if (what === 'members' && sub && (method === 'PATCH' || method === 'DELETE')) {
        const target = members.find((x) => x.id === sub && x.team_id === teamId);
        if (!target) return err(404, 'NOT_FOUND', 'no such member');
        const self = target.user_id === me.user.id;
        if (!admin && !(method === 'DELETE' && self)) return err(403, 'FORBIDDEN', 'owners and admins only');
        if (target.role === 'owner' && myRole !== 'owner') return err(403, 'FORBIDDEN', 'only an owner can change an owner');
        const owners = members.filter((x) => x.team_id === teamId && x.role === 'owner');
        const demotes = target.role === 'owner' && (method === 'DELETE' || body.role !== 'owner');
        if (demotes && owners.length === 1) return err(409, 'LAST_OWNER', 'a team needs an owner');
        if (method === 'DELETE') { members.splice(members.indexOf(target), 1); return ok({ ok: true }); }
        if (!ROLES.includes(body.role)) return err(400, 'VALIDATION', 'bad role');
        if (body.role === 'owner' && myRole !== 'owner') return err(403, 'FORBIDDEN', 'only an owner can make an owner');
        target.role = body.role;
        return ok({ member: { member_id: target.id, role: target.role } });
      }
      if (what === 'invites' && !sub && method === 'GET') {
        if (!admin) return err(403, 'FORBIDDEN', 'owners and admins only');
        return ok({ invites: [...invites.values()].filter((i) => i.team_id === teamId && liveInvite(i)).map(inviteView) });
      }
      if (what === 'invites' && !sub && method === 'POST') {
        if (!admin) return err(403, 'FORBIDDEN', 'owners and admins only');
        const email = String(body.email ?? '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, 'VALIDATION', 'bad email');
        if (!['admin', 'member', 'guest'].includes(body.role)) return err(400, 'VALIDATION', 'bad role');
        // Inviting the same address again is a resend: a new link, and the old one dies.
        for (const i of invites.values()) if (i.team_id === teamId && i.email === email && liveInvite(i)) i.revoked = true;
        const token = crypto.randomBytes(32).toString('base64url');
        const inv = { id: rid('inv'), team_id: teamId, email, role: body.role, tokenHash: sha(token), expires_at: now() + INVITE_TTL_MS, inviter_id: me.user.id, used: false, revoked: false };
        invites.set(inv.id, inv);
        const link = `${base}/invite#${token}`;
        log(`[mock-hub] invite for ${email} to ${team.name}: ${link}`);
        return ok({ invite: inviteView(inv), link });
      }
      if (what === 'invites' && sub && method === 'DELETE') {
        if (!admin) return err(403, 'FORBIDDEN', 'owners and admins only');
        const inv = invites.get(sub);
        if (!inv || inv.team_id !== teamId) return err(404, 'NOT_FOUND', 'no such invite');
        inv.revoked = true;
        return ok({ ok: true });
      }
      if (what === 'enrol' && !sub && method === 'POST') {
        if (myRole === 'guest') return err(403, 'FORBIDDEN', 'guests cannot run cards');
        let e = enrolments.find((x) => x.team_id === teamId && x.device_id === me.device_id && !x.revoked);
        if (!e) { e = { enrollment_id: rid('enr'), team_id: teamId, user_id: me.user.id, device_id: me.device_id, revoked: false }; enrolments.push(e); }
        return ok({ enrollment_id: e.enrollment_id, team_id: teamId });
      }
      if (what === 'enrol' && !sub && method === 'DELETE') {
        const e = enrolments.find((x) => x.team_id === teamId && x.device_id === me.device_id && !x.revoked);
        if (!e) return err(404, 'NOT_FOUND', 'this device is not a runner here');
        e.revoked = true;
        return ok({ ok: true });
      }
      return err(404, 'NOT_FOUND', 'not found');
    }

    if (method === 'POST' && path === '/api/invites/preview') {
      const i = findInvite(body.t);
      if (!i || !liveInvite(i)) return err(400, 'INVALID_TOKEN', 'invalid invite');
      return ok({ team_name: teams.get(i.team_id).name, inviter_first_name: firstName(users.get(i.inviter_id)), role: i.role });
    }

    if (method === 'POST' && path === '/api/invites/accept') {
      if (needMe()) return needMe();
      const i = body.invite_id ? invites.get(String(body.invite_id)) : findInvite(body.t);
      if (!i || !liveInvite(i)) return err(400, 'INVALID_TOKEN', 'invalid invite');
      const team = teams.get(i.team_id);
      if (i.email !== me.user.email) return err(403, 'FORBIDDEN', 'invite is for another address', { code: 'WRONG_ACCOUNT', email_masked: mask(i.email) });
      if (roleIn(i.team_id, me.user.id)) return err(409, 'CONFLICT', 'already a member', { code: 'ALREADY_MEMBER', team: { id: team.id, name: team.name } });
      i.used = true;
      const member = { id: rid('mem'), team_id: team.id, user_id: me.user.id, role: i.role, joined_at: iso(now()) };
      members.push(member);
      return ok({ team: { id: team.id, name: team.name, slug: team.slug }, member: { member_id: member.id, role: member.role } });
    }

    return null;
  }

  // A stand-in for the board web: shows who the hub thinks you are, so a dev
  // run can see the bearer header arrived without the page ever holding it.
  function boardPage(req, url) {
    const me = authed(req);
    const org = url.searchParams.get('org');
    const team = org && teams.get(org);
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const line = me ? `Signed in as ${esc(me.user.display_name)}${team ? ` · ${esc(team.name)} (${esc(roleIn(team.id, me.user.id) ?? 'not a member')})` : ''}` : 'Not signed in';
    return `<!doctype html><meta charset="utf-8"><title>Board</title><style>body{font:14px system-ui;margin:0;padding:56px 32px;background:#eceaf0;color:#1d1a22}@media (prefers-color-scheme:dark){body{background:#1c1a1f;color:#eee}}h1{font-size:18px;margin:0 0 6px}p{margin:0;opacity:.7}</style><h1>${team ? esc(team.name) : 'Team board'}</h1><p>${line}</p><p>Mock team hub: the real board web appears here.</p>`;
  }

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'board-protocol': '1', ...headers });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { if (raw.length < 65536) raw += d; });
    req.on('end', () => {
      let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
      if (body === null || typeof body !== 'object') body = {};
      if (req.method === 'GET' && url.pathname === '/') {
        const html = boardPage(req, url);
        res.writeHead(authed(req) ? 200 : 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'board-protocol': '1' });
        res.end(html);
        return;
      }
      // Bearer requests need no CSRF token, but a present Origin must be ours.
      if (req.headers.origin && req.headers.origin !== base) { send(res, 403, { error: { code: 'FORBIDDEN', message: 'cross-origin' } }); return; }
      const r = route(req.method, url.pathname, body, req, url) ?? err(404, 'NOT_FOUND', 'not found');
      send(res, r.status, r.body, r.headers);
    });
  });

  // /ws/board: the injected Bearer (or nothing: a plain HTTP 401, no socket).
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const refuse = (code, text) => { socket.end(`HTTP/1.1 ${code} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); };
    if (url.pathname !== '/ws/board') { refuse(404, 'Not Found'); return; }
    if (req.headers.origin && req.headers.origin !== base) { refuse(403, 'Forbidden'); return; }
    const me = authed(req);
    if (!me) { refuse(401, 'Unauthorized'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!sockets.has(me.tokenHash)) sockets.set(me.tokenHash, new Set());
      sockets.get(me.tokenHash).add(ws);
      ws.on('close', () => sockets.get(me.tokenHash)?.delete(ws));
      ws.send(JSON.stringify({ type: 'welcome', protocol: 1, member: null, user: { id: me.user.id, display_name: me.user.display_name } }));
    });
  });

  return {
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(base); })); // privacy-flow: local-board-hub
    },
    close: () => new Promise((resolve) => { for (const c of wss.clients) c.terminate(); server.closeAllConnections?.(); server.close(() => resolve()); }),
    lastCode: (email) => codes.get(String(email).toLowerCase()) ?? null,
    setNow: (ms) => { skew = ms; },
    starts: () => starts.slice(),
    revokeAll: (email) => { const id = byEmail.get(email); for (const [h, t] of tokens) if (t.user_id === id) revoke(h); },
    enrolments: () => enrolments.slice(),
  };
}

module.exports = { createMockAccountsHub, CODE_TTL_MS, MAX_ATTEMPTS, VERIFY_PER_ADDRESS };
