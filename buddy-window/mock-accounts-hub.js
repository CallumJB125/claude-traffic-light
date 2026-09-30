// An in-process stand-in for a team hub in BOARD_AUTH=accounts mode, until
// callumbaker-70's real one lands. Used by tests and by the dev-only
// `--buddy-mock-accounts` flag. Same shapes as accounts.js's ROUTES; state is
// in memory and dies with the process.
//
// Test hooks: `lastCode(email)` (the emailed code), `setNow(ms)` (clock).
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const INVITE_TTL_MS = 7 * 24 * 3600_000;
const ROLES = ['owner', 'admin', 'member', 'guest'];

const rid = (p) => `${p}_${crypto.randomBytes(9).toString('base64url')}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createMockAccountsHub({ log = () => {}, now: clock = () => Date.now() } = {}) {
  let skew = null;
  const now = () => skew ?? clock();
  const users = new Map(); // id → {id, email, display_name}
  const byEmail = new Map();
  const flows = new Map(); // id → {email, codeHash, expires, attempts, purpose, dead}
  const codes = new Map(); // email → last plain code (test hook only)
  const tokens = new Map(); // sha(token) → {user_id, device_id, revoked}
  const teams = new Map(); // id → {id, name, boards}
  const members = []; // {id, team_id, user_id, role}
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

  const roleIn = (teamId, userId) => members.find((m) => m.team_id === teamId && m.user_id === userId)?.role ?? null;
  const canManage = (teamId, userId) => ['owner', 'admin'].includes(roleIn(teamId, userId));
  const inviteView = (i) => ({ id: i.id, email: i.email, role: i.role, expires_at: new Date(i.expires_at).toISOString() });
  const liveInvite = (i) => !i.used && !i.revoked && i.expires_at > now();

  function account(user) {
    return {
      user: { id: user.id, display_name: user.display_name, email: user.email },
      teams: members.filter((m) => m.user_id === user.id).map((m) => {
        const t = teams.get(m.team_id);
        return { id: t.id, name: t.name, role: m.role, boards: t.boards };
      }),
      pending_invites: [...invites.values()].filter((i) => i.email === user.email && liveInvite(i) && !roleIn(i.team_id, user.id)).map((i) => ({
        id: i.id, team_name: teams.get(i.team_id).name, inviter_name: users.get(i.inviter_id)?.display_name ?? 'Someone', role: i.role,
      })),
    };
  }

  function startFlow(email, purpose) {
    const id = rid('flow');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    flows.set(id, { email, codeHash: sha(code), expires: now() + CODE_TTL_MS, attempts: 0, purpose });
    codes.set(email, code);
    log(`[mock-hub] ${purpose === 'step_up' ? 'confirmation' : 'sign-in'} code for ${email}: ${code}`);
    return id;
  }

  function checkCode(flowId, code, purpose) {
    const f = flows.get(flowId);
    if (!f || f.purpose !== purpose || f.dead) return { e: err(400, 'CODE_EXPIRED', 'no such flow') };
    if (f.expires <= now()) { f.dead = true; return { e: err(400, 'CODE_EXPIRED', 'code expired') }; }
    f.attempts += 1;
    if (f.attempts > MAX_ATTEMPTS) { f.dead = true; return { e: err(400, 'TOO_MANY_ATTEMPTS', 'too many attempts') }; }
    const a = Buffer.from(sha(String(code))); const b = Buffer.from(f.codeHash);
    if (!crypto.timingSafeEqual(a, b)) {
      if (f.attempts >= MAX_ATTEMPTS) { f.dead = true; return { e: err(400, 'TOO_MANY_ATTEMPTS', 'too many attempts') }; }
      return { e: err(400, 'INVALID_CODE', 'wrong code') };
    }
    f.dead = true;
    return { f };
  }

  function findInvite(t) {
    const h = sha(String(t ?? ''));
    return [...invites.values()].find((i) => i.tokenHash === h) ?? null;
  }

  function inviteState(i) {
    if (!i) return err(404, 'INVITE_NOT_FOUND', 'no such invite');
    if (i.revoked) return err(410, 'INVITE_REVOKED', 'invite revoked');
    if (i.used) return err(410, 'INVITE_USED', 'invite already used');
    if (i.expires_at <= now()) return err(410, 'INVITE_EXPIRED', 'invite expired');
    return null;
  }

  function route(method, path, body, req) {
    const me = authed(req);
    const needMe = () => (me ? null : err(401, 'UNAUTHENTICATED', 'not signed in'));
    let m;

    if (method === 'GET' && path === '/api/health') return ok({ ok: true, protocol: 1, auth: 'accounts' });

    if (method === 'POST' && path === '/api/auth/email/start') {
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, 'VALIDATION', 'enter a valid email');
      if (body.purpose === 'step_up') {
        if (!me || me.user.email !== email) return err(401, 'UNAUTHENTICATED', 'not signed in');
        return ok({ flow_id: startFlow(email, 'step_up') });
      }
      return ok({ flow_id: startFlow(email, 'sign_in') });
    }

    if (method === 'POST' && path === '/api/auth/email/verify') {
      const { f, e } = checkCode(body.flow_id, body.code, 'sign_in');
      if (e) return e;
      let user = users.get(byEmail.get(f.email));
      if (!user) {
        user = { id: rid('usr'), email: f.email, display_name: f.email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) };
        users.set(user.id, user);
        byEmail.set(user.email, user.id);
      }
      const token = `bdt_${crypto.randomBytes(24).toString('base64url')}`;
      const device_id = rid('udev');
      tokens.set(sha(token), { user_id: user.id, device_id, name: String(body.device_name ?? ''), revoked: false });
      const a = account(user);
      return ok({ device_token: token, device_id, user: a.user, teams: a.teams });
    }

    if (method === 'POST' && path === '/api/auth/signout') {
      if (!me) return err(401, 'UNAUTHENTICATED', 'not signed in');
      tokens.get(me.tokenHash).revoked = true;
      return ok({ ok: true });
    }

    if (method === 'GET' && path === '/api/account') return needMe() ?? ok(account(me.user));

    if (method === 'POST' && path === '/api/account/delete') {
      if (needMe()) return needMe();
      const { e } = checkCode(body.flow_id, body.step_up_code, 'step_up');
      if (e) return e;
      for (const mm of members.filter((x) => x.user_id === me.user.id)) {
        const owners = members.filter((x) => x.team_id === mm.team_id && x.role === 'owner');
        const others = members.filter((x) => x.team_id === mm.team_id && x.user_id !== me.user.id);
        if (mm.role === 'owner' && owners.length === 1 && others.length) return err(409, 'LAST_OWNER', 'sole owner', { team: teams.get(mm.team_id).name });
      }
      for (const [h, t] of tokens) if (t.user_id === me.user.id) tokens.delete(h);
      for (let i = members.length - 1; i >= 0; i -= 1) if (members[i].user_id === me.user.id) members.splice(i, 1);
      users.delete(me.user.id);
      byEmail.delete(me.user.email);
      return ok({ ok: true });
    }

    if (method === 'POST' && path === '/api/teams') {
      if (needMe()) return needMe();
      const name = String(body.name ?? '').trim();
      if (!name || name.length > 60) return err(400, 'VALIDATION', 'name required');
      const team = { id: rid('team'), name, boards: [] };
      const board = { id: rid('brd'), name, key_prefix: name.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'BRD' };
      team.boards.push(board);
      teams.set(team.id, team);
      members.push({ id: rid('mem'), team_id: team.id, user_id: me.user.id, role: 'owner' });
      return ok({ team: { id: team.id, name: team.name, role: 'owner', boards: team.boards }, board });
    }

    if ((m = /^\/api\/teams\/([^/]+)\/(members|invites|enrol)(?:\/([^/]+))?$/.exec(path))) {
      if (needMe()) return needMe();
      const [, teamId, what, sub] = m;
      const team = teams.get(teamId);
      const myRole = team ? roleIn(teamId, me.user.id) : null;
      if (!team || !myRole) return err(404, 'NOT_FOUND', 'no such team');

      if (what === 'members' && method === 'GET' && !sub) {
        return ok({ members: members.filter((x) => x.team_id === teamId).map((x) => {
          const u = users.get(x.user_id);
          return { id: x.id, user_id: u.id, display_name: u.display_name, email: u.email, role: x.role, you: u.id === me.user.id };
        }) });
      }
      if (what === 'members' && sub && (method === 'PATCH' || method === 'DELETE')) {
        const target = members.find((x) => x.id === sub && x.team_id === teamId);
        if (!target) return err(404, 'NOT_FOUND', 'no such member');
        const self = target.user_id === me.user.id;
        if (!canManage(teamId, me.user.id) && !(method === 'DELETE' && self)) return err(403, 'FORBIDDEN', 'owners and admins only');
        if (target.role === 'owner' && myRole !== 'owner') return err(403, 'FORBIDDEN', 'only an owner can change an owner');
        const owners = members.filter((x) => x.team_id === teamId && x.role === 'owner');
        const demotes = target.role === 'owner' && (method === 'DELETE' || body.role !== 'owner');
        if (demotes && owners.length === 1) return err(409, 'LAST_OWNER', 'a team needs an owner');
        if (method === 'DELETE') { members.splice(members.indexOf(target), 1); return ok({ ok: true }); }
        if (!ROLES.includes(body.role)) return err(400, 'VALIDATION', 'bad role');
        if (body.role === 'owner' && myRole !== 'owner') return err(403, 'FORBIDDEN', 'only an owner can make an owner');
        target.role = body.role;
        return ok({ member: { id: target.id, role: target.role } });
      }
      if (what === 'invites' && !sub && method === 'GET') {
        if (!canManage(teamId, me.user.id)) return err(403, 'FORBIDDEN', 'owners and admins only');
        return ok({ invites: [...invites.values()].filter((i) => i.team_id === teamId && liveInvite(i)).map(inviteView) });
      }
      if (what === 'invites' && !sub && method === 'POST') {
        if (!canManage(teamId, me.user.id)) return err(403, 'FORBIDDEN', 'owners and admins only');
        const email = String(body.email ?? '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, 'VALIDATION', 'bad email');
        if (!['admin', 'member', 'guest'].includes(body.role)) return err(400, 'VALIDATION', 'bad role');
        // Re-inviting the same address replaces the pending invite (a resend).
        for (const i of invites.values()) if (i.team_id === teamId && i.email === email && liveInvite(i)) i.revoked = true;
        const code = `inv_${crypto.randomBytes(24).toString('base64url')}`;
        const inv = { id: rid('inv'), team_id: teamId, email, role: body.role, tokenHash: sha(code), expires_at: now() + INVITE_TTL_MS, inviter_id: me.user.id, used: false, revoked: false };
        invites.set(inv.id, inv);
        log(`[mock-hub] invite for ${email} to ${team.name}: ${code}`);
        return ok({ invite: inviteView(inv), code });
      }
      if (what === 'invites' && sub && method === 'DELETE') {
        if (!canManage(teamId, me.user.id)) return err(403, 'FORBIDDEN', 'owners and admins only');
        const inv = invites.get(sub);
        if (!inv || inv.team_id !== teamId) return err(404, 'NOT_FOUND', 'no such invite');
        inv.revoked = true;
        return ok({ ok: true });
      }
      if (what === 'enrol' && !sub && method === 'POST') {
        if (myRole === 'guest') return err(403, 'FORBIDDEN', 'guests cannot run cards');
        const e = { enrollment_id: rid('enr'), team_id: teamId, user_id: me.user.id, name: String(body.name ?? '') };
        enrolments.push(e);
        return ok({ enrollment_id: e.enrollment_id, device_token: `bdt_${crypto.randomBytes(24).toString('base64url')}` });
      }
      return err(404, 'NOT_FOUND', 'not found');
    }

    if (method === 'POST' && path === '/api/invites/preview') {
      const i = findInvite(body.t);
      const bad = inviteState(i);
      if (bad) return bad;
      return ok({ team_name: teams.get(i.team_id).name, inviter_name: users.get(i.inviter_id)?.display_name ?? 'Someone', role: i.role, email_masked: `${i.email.charAt(0)}…@${i.email.split('@')[1]}` });
    }

    if (method === 'POST' && path === '/api/invites/accept') {
      if (needMe()) return needMe();
      const i = body.invite_id ? invites.get(String(body.invite_id)) : findInvite(body.t);
      const bad = inviteState(i);
      if (bad) return bad;
      const team = teams.get(i.team_id);
      if (roleIn(i.team_id, me.user.id)) return err(409, 'ALREADY_MEMBER', 'already a member', { team: { id: team.id, name: team.name } });
      if (i.email !== me.user.email) return err(403, 'WRONG_ACCOUNT', 'invite is for another email', { email_masked: `${i.email.charAt(0)}…@${i.email.split('@')[1]}` });
      i.used = true;
      members.push({ id: rid('mem'), team_id: team.id, user_id: me.user.id, role: i.role });
      return ok({ team: { id: team.id, name: team.name, role: i.role, boards: team.boards } });
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
        const status = authed(req) ? 200 : 401;
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
      const r = route(req.method, url.pathname, body, req) ?? err(404, 'NOT_FOUND', 'not found');
      res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(r.body));
    });
  });

  return {
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
    },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    lastCode: (email) => codes.get(String(email).toLowerCase()) ?? null,
    setNow: (ms) => { skew = ms; },
    revokeAll: (email) => { const id = byEmail.get(email); for (const t of tokens.values()) if (t.user_id === id) t.revoked = true; },
    enrolments: () => enrolments.slice(),
  };
}

module.exports = { createMockAccountsHub, CODE_TTL_MS, MAX_ATTEMPTS };
