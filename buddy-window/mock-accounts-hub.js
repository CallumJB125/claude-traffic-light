// An in-process stand-in for a team hub in BOARD_AUTH=accounts mode, until
// callumbaker-70's real one lands. Used by tests and by the dev-only
// `--buddy-mock-accounts` flag. Shapes and error codes follow
// board/ACCOUNTS-API.md (P1 as built, P2–P4 as planned); state is in memory
// and dies with the process.
//
// The hub mails sign-in codes but no invites: an invite's link and code come
// back once to the inviter, who sends them on.
//
// Test hooks: `lastCode(email)` (the emailed sign-in code), `inviteCode(email)`
// (the last invite's XXXX-XXXX code), `setNow(ms)` (clock), `starts()` (email/start
// bodies), `revokeAll(email)`, `enrolments()`, `setVerified(email, bool)`,
// `teamHeaders()` (X-Board-Team values seen).
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
const ROLES = ['owner', 'admin', 'member', 'viewer'];
const RANK = { owner: 4, admin: 3, member: 2, viewer: 1 };
const WS_UNAUTHENTICATED = 4401;
const QUOTAS = { teams: 10, boards: 10, members: 25 };
// The invite's typed code: no 0/O or 1/I/L to misread.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const rid = (p) => `${p}_${crypto.randomBytes(9).toString('base64url')}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mask = (email) => `${email.charAt(0)}…@${email.split('@')[1]}`;
const firstName = (u) => String(u?.display_name ?? 'Someone').split(/\s+/)[0];

function createMockAccountsHub({ log = () => {}, now: clock = () => Date.now(), quotas = {} } = {}) {
  const limits = { ...QUOTAS, ...quotas };
  let skew = null;
  const now = () => skew ?? clock();
  let base = null; // our own origin, once listening
  const users = new Map(); // id → {id, email, display_name, email_verified}
  const byEmail = new Map();
  const flows = new Map(); // id → {email, user_id, codeHash, expires, wrong, purpose, dead, verifiedAt, used}
  const codes = new Map(); // email → last plain code (test hook only)
  const verifies = new Map(); // email → [attempt times]
  const starts = [];
  const tokens = new Map(); // sha(token) → {user_id, device_id, revoked}
  const sockets = new Map(); // sha(token) → Set<ws>
  const teams = new Map(); // id → {id, name, slug, plan, boards, deleted}
  const members = []; // {id, team_id, user_id, role, joined_at}
  const invites = new Map(); // id → {id, team_id, email, role, tokenHash, codeHash, expires_at, inviter_id, used_by, revoked}
  const inviteCodes = new Map(); // email → last plain invite code (test hook only)
  const enrolments = [];
  const teamHeaders = [];

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

  const roleIn = (teamId, userId) => (teams.get(teamId)?.deleted ? null : members.find((m) => m.team_id === teamId && m.user_id === userId)?.role ?? null);
  const canManage = (teamId, userId) => ['owner', 'admin'].includes(roleIn(teamId, userId));
  const iso = (ms) => new Date(ms).toISOString();
  const inviteView = (i) => ({ id: i.id, email: i.email, role: i.role, expires_at: iso(i.expires_at), created_by_name: users.get(i.inviter_id)?.display_name ?? 'Someone' });
  const liveInvite = (i) => !i.used_by && !i.revoked && i.expires_at > now() && !teams.get(i.team_id)?.deleted;
  const liveTeam = (id) => { const t = teams.get(id); return t && !t.deleted ? t : null; };
  const pendingFor = (teamId) => [...invites.values()].filter((i) => i.team_id === teamId && liveInvite(i));
  const teamView = (t) => ({ id: t.id, name: t.name, slug: t.slug, plan: t.plan });
  const normCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  function account(user) {
    return {
      user: { id: user.id, display_name: user.display_name, email: user.email, email_verified: user.email_verified },
      teams: members.filter((m) => m.user_id === user.id && liveTeam(m.team_id)).map((m) => {
        const t = teams.get(m.team_id);
        return { id: t.id, name: t.name, slug: t.slug, plan: t.plan, role: m.role, member_id: m.id, boards: t.boards };
      }).sort((a, b) => a.name.localeCompare(b.name)),
      pending_invites: [...invites.values()].filter((i) => user.email_verified && i.email === user.email && liveInvite(i) && !roleIn(i.team_id, user.id)).map((i) => ({
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

  function mintInvite(teamId, email, role, inviterId) {
    const token = `inv_${crypto.randomBytes(32).toString('base64url')}`;
    const raw = Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const inv = { id: rid('inv'), team_id: teamId, email, role, tokenHash: sha(token), codeHash: sha(raw), expires_at: now() + INVITE_TTL_MS, inviter_id: inviterId, used_by: null, revoked: false };
    invites.set(inv.id, inv);
    inviteCodes.set(email, code);
    const link = `${base}/invite#${token}`;
    log(`[mock-hub] invite created for ${email} to ${teams.get(teamId).name}: ${link} (code ${code})`);
    return { invite: inviteView(inv), link, code };
  }

  // One user signed in (email code or a provider): the same answer either way.
  function signInUser(email, deviceName) {
    let user = users.get(byEmail.get(email));
    if (!user) {
      user = { id: rid('usr'), email, display_name: email.split('@')[0], email_verified: true };
      users.set(user.id, user);
      byEmail.set(user.email, user.id);
    }
    const token = `bdt_${crypto.randomBytes(32).toString('base64url')}`;
    const device_id = rid('udev');
    tokens.set(sha(token), { user_id: user.id, device_id, name: String(deviceName ?? ''), revoked: false });
    const a = account(user);
    return ok({ user: a.user, teams: a.teams, device_token: token, device_id });
  }

  function accept(me, i, { byId }) {
    // By id or code: anything not addressed to your verified address is just invalid.
    if (!i || (byId && (i.email !== me.user.email || !me.user.email_verified))) return err(400, 'INVALID_TOKEN', 'invalid invite');
    const team = liveTeam(i.team_id);
    if (!team) return err(400, 'INVALID_TOKEN', 'invalid invite');
    const mine = members.find((x) => x.team_id === team.id && x.user_id === me.user.id);
    // The same user accepting the same invite again gets the same answer.
    if (i.used_by === me.user.id && mine) return ok({ team: teamView(team), member: { member_id: mine.id, role: mine.role } });
    if (!liveInvite(i)) return err(400, 'INVALID_TOKEN', 'invalid invite');
    if (i.email !== me.user.email || !me.user.email_verified) return err(403, 'WRONG_ACCOUNT', 'invite is for another address', { email_masked: mask(i.email) });
    if (mine) return err(409, 'ALREADY_MEMBER', 'already a member', { team: { id: team.id, name: team.name } });
    i.used_by = me.user.id;
    const member = { id: rid('mem'), team_id: team.id, user_id: me.user.id, role: i.role, joined_at: iso(now()) };
    members.push(member);
    return ok({ team: teamView(team), member: { member_id: member.id, role: member.role } });
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
      return signInUser(f.email, body.device_name);
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
      if (!me.user.email_verified) return err(403, 'EMAIL_UNVERIFIED', 'verify your email first');
      const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
      if (!name || name.length > 60) return err(400, 'VALIDATION', 'name required');
      if (members.filter((x) => x.user_id === me.user.id && x.role === 'owner' && liveTeam(x.team_id)).length >= limits.teams) return err(403, 'QUOTA_EXCEEDED', 'team limit', { resource: 'teams', limit: limits.teams });
      const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';
      let slug = stem;
      for (let n = 2; [...teams.values()].some((t) => t.slug === slug); n += 1) slug = `${stem}-${n}`;
      const team = { id: rid('team'), name, slug, plan: 'free', boards: [], deleted: false };
      const board = { id: rid('brd'), name, key_prefix: name.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'BRD' };
      team.boards.push(board);
      teams.set(team.id, team);
      members.push({ id: rid('mem'), team_id: team.id, user_id: me.user.id, role: 'owner', joined_at: iso(now()) });
      return ok({ team: teamView(team), board });
    }

    if ((m = /^\/api\/teams\/([^/]+)(?:\/(members|invites|enrol|boards)(?:\/([^/]+)(?:\/(resend))?)?)?$/.exec(path))) {
      if (needMe()) return needMe();
      const [, teamId, what, sub, verb] = m;
      const named = req.headers['x-board-team'];
      if (named !== undefined) teamHeaders.push(named);
      // A header naming another team than the URL's is a foreign id: 404.
      if (named !== undefined && named !== teamId) return err(404, 'NOT_FOUND', 'no such team');
      const team = liveTeam(teamId);
      const myRole = team ? roleIn(teamId, me.user.id) : null;
      if (!team || !myRole) return err(404, 'NOT_FOUND', 'no such team');
      const admin = canManage(teamId, me.user.id);
      const onlyAdmins = () => err(403, 'FORBIDDEN', 'owners and admins only');

      if (!what) {
        if (method === 'GET') {
          const mine = members.find((x) => x.team_id === teamId && x.user_id === me.user.id);
          return ok({ team: teamView(team), me: { member_id: mine.id, role: mine.role }, counts: { members: members.filter((x) => x.team_id === teamId).length, boards: team.boards.length }, quotas: { members: limits.members, boards: limits.boards } });
        }
        if (method === 'PATCH') {
          if (!admin) return onlyAdmins();
          const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
          if (!name || name.length > 60) return err(400, 'VALIDATION', 'name required');
          team.name = name;
          return ok({ team: teamView(team) });
        }
        if (method === 'DELETE') {
          if (myRole !== 'owner') return err(403, 'FORBIDDEN', 'owners only');
          if (body.confirm_slug !== team.slug) return err(400, 'VALIDATION', 'confirm_slug does not match');
          team.deleted = true;
          for (const e of enrolments) if (e.team_id === teamId) e.revoked = true;
          return ok({ ok: true, purge_after: iso(now() + 7 * 24 * 3600_000) });
        }
        return err(404, 'NOT_FOUND', 'not found');
      }

      if (what === 'boards' && !sub && method === 'POST') {
        if (!admin) return onlyAdmins();
        const name = String(body.name ?? '').trim();
        if (!name || name.length > 60) return err(400, 'VALIDATION', 'name required');
        if (body.key_prefix !== undefined && !/^[A-Z]{1,10}$/.test(body.key_prefix)) return err(400, 'VALIDATION', 'bad key_prefix');
        if (team.boards.length >= limits.boards) return err(403, 'QUOTA_EXCEEDED', 'board limit', { resource: 'boards', limit: limits.boards });
        const board = { id: rid('brd'), name, key_prefix: body.key_prefix ?? (name.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'BRD') };
        team.boards.push(board);
        return ok({ board });
      }
      if (what === 'members' && method === 'GET' && !sub) {
        return ok({ members: members.filter((x) => x.team_id === teamId).sort((a, b) => RANK[b.role] - RANK[a.role]).map((x) => {
          const u = users.get(x.user_id);
          return { member_id: x.id, user_id: u.id, display_name: u.display_name, role: x.role, joined_at: x.joined_at, ...(admin ? { email: u.email } : {}) };
        }) });
      }
      if (what === 'members' && sub && !verb && (method === 'PATCH' || method === 'DELETE')) {
        const target = members.find((x) => x.id === sub && x.team_id === teamId);
        if (!target) return err(404, 'NOT_FOUND', 'no such member');
        const self = target.user_id === me.user.id;
        if (!admin && !(method === 'DELETE' && self)) return onlyAdmins();
        if (target.role === 'owner' && myRole !== 'owner') return err(403, 'FORBIDDEN', 'only an owner can change an owner');
        const owners = members.filter((x) => x.team_id === teamId && x.role === 'owner');
        const demotes = target.role === 'owner' && (method === 'DELETE' || body.role !== 'owner');
        if (demotes && owners.length === 1) return err(409, 'CONFLICT', 'a team needs an owner', { reason: 'LAST_OWNER' });
        if (method === 'DELETE') { members.splice(members.indexOf(target), 1); return ok({ ok: true }); }
        if (!ROLES.includes(body.role)) return err(400, 'VALIDATION', 'bad role');
        if (body.role === 'owner' && myRole !== 'owner') return err(403, 'FORBIDDEN', 'only an owner can make an owner');
        target.role = body.role;
        return ok({ member: { member_id: target.id, role: target.role } });
      }
      if (what === 'invites' && !sub && method === 'GET') {
        if (!admin) return onlyAdmins();
        return ok({ invites: pendingFor(teamId).map(inviteView) });
      }
      if (what === 'invites' && !sub && method === 'POST') {
        if (!admin) return onlyAdmins();
        if (!me.user.email_verified) return err(403, 'EMAIL_UNVERIFIED', 'verify your email first');
        const email = String(body.email ?? '').trim().toLowerCase();
        const role = body.role ?? 'member';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, 'VALIDATION', 'bad email');
        if (!['admin', 'member', 'viewer'].includes(role)) return err(400, 'VALIDATION', 'bad role');
        if (RANK[role] > RANK[myRole]) return err(403, 'FORBIDDEN', 'not above your own role');
        const already = members.find((x) => x.team_id === teamId && users.get(x.user_id)?.email === email);
        if (already) return err(409, 'ALREADY_MEMBER', 'already a member', { team: { id: team.id, name: team.name } });
        const dup = pendingFor(teamId).find((i) => i.email === email);
        if (dup) return err(409, 'CONFLICT', 'an invite is already pending', { invite_id: dup.id });
        if (members.filter((x) => x.team_id === teamId).length + pendingFor(teamId).length >= limits.members) return err(403, 'QUOTA_EXCEEDED', 'team is full', { resource: 'members', limit: limits.members });
        return ok(mintInvite(teamId, email, role, me.user.id));
      }
      if (what === 'invites' && sub && verb === 'resend' && method === 'POST') {
        if (!admin) return onlyAdmins();
        const old = invites.get(sub);
        if (!old || old.team_id !== teamId || old.used_by || old.revoked) return err(404, 'NOT_FOUND', 'no such invite');
        if (RANK[old.role] > RANK[myRole]) return err(403, 'FORBIDDEN', 'not above your own role');
        old.revoked = true;
        return ok(mintInvite(teamId, old.email, old.role, me.user.id));
      }
      if (what === 'invites' && sub && !verb && method === 'DELETE') {
        if (!admin) return onlyAdmins();
        const inv = invites.get(sub);
        if (!inv || inv.team_id !== teamId || !liveInvite(inv)) return err(404, 'NOT_FOUND', 'no such invite');
        inv.revoked = true;
        return ok({ ok: true });
      }
      if (what === 'enrol' && !sub && method === 'POST') {
        if (myRole === 'viewer') return err(403, 'FORBIDDEN', 'viewers cannot run cards');
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
      if (body.invite_id !== undefined) return accept(me, invites.get(String(body.invite_id)), { byId: true });
      if (body.code !== undefined) {
        const h = sha(normCode(body.code));
        return accept(me, [...invites.values()].find((i) => i.codeHash === h && i.email === me.user.email) ?? null, { byId: true });
      }
      return accept(me, findInvite(body.t), { byId: false });
    }

    if (method === 'POST' && (m = /^\/api\/account\/invites\/([^/]+)\/accept$/.exec(path))) {
      if (needMe()) return needMe();
      return accept(me, invites.get(m[1]), { byId: true });
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
    inviteCode: (email) => inviteCodes.get(String(email).toLowerCase()) ?? null,
    setVerified: (email, v) => { const u = users.get(byEmail.get(String(email).toLowerCase())); if (u) u.email_verified = !!v; },
    teamHeaders: () => teamHeaders.slice(),
    revokeAll: (email) => { const id = byEmail.get(email); for (const [h, t] of tokens) if (t.user_id === id) revoke(h); },
    enrolments: () => enrolments.slice(),
  };
}

module.exports = { createMockAccountsHub, CODE_TTL_MS, MAX_ATTEMPTS, VERIFY_PER_ADDRESS };
