#!/usr/bin/env node
// Two-account acceptance (docs/ACCEPTANCE-TWO-ACCOUNTS.md Parts 1–4 + MESSAGING.md §6a agent mail)
// against an accounts-mode hub, over its HTTP API only. Sign-in is by email code
// (client 'buddy_desktop': verify returns a bearer device token). Resumable stages, state in state.json.
//
//   node acceptance.mjs start A|B|C <email>     POST /api/auth/email/start, save flow_id
//   node acceptance.mjs verify A|B <code>       verify, save device token + user id (C is never verified)
//   node acceptance.mjs run                     every API-checkable row, results table; re-runnable
//   node acceptance.mjs cleanup [code]          Part 4: delete throwaway teams (one emailed step-up code each), sign out
//
// Env: HUB (default http://127.0.0.1:18788), ACCEPT_STATE (default ./state.json), ACCEPT_TEAM.
// Codes, tokens and invite links are never printed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HUB = (process.env.HUB || 'http://127.0.0.1:18788').replace(/\/$/, '');
const STATE = process.env.ACCEPT_STATE || path.join(path.dirname(fileURLToPath(import.meta.url)), 'state.json');
const TEAM = process.env.ACCEPT_TEAM || 'acceptance-2026-10-11';
const TEAM2 = `${TEAM}-b`;
const MSG = '/api/messaging/v1';

const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { accounts: {}, part1: {}, teams: {}, results: [] });
const save = (s) => writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });

async function call(method, p, { body, token } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${HUB}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json, code: json?.error?.code ?? null, text };
}
// What a FAIL shows of an answer: status, error code/message and a few safe fields, never secrets.
const brief = (r) => {
  if (!r) return 'no answer';
  const e = r.body?.error;
  return e ? `${r.status} ${e.code}${e.message ? ` "${e.message}"` : ''}${e.attempts_left != null ? ` attempts_left=${e.attempts_left}` : ''}` : `${r.status}`;
};

function die(msg) { console.error(msg); process.exit(2); }

// ── start / verify ──────────────────────────────────────────────────────────
async function start(who, email) {
  if (!['A', 'B', 'C'].includes(who) || !email) die('usage: start A|B|C <email>');
  const s = load();
  const r = await call('POST', '/api/auth/email/start', { body: { email, client: 'buddy_desktop', device_name: `acceptance-${who}`, platform: 'acceptance-script' } });
  if (r.status !== 200 || !r.body?.flow_id) die(`start ${who}: ${brief(r)}`);
  s.accounts[who] = { ...(s.accounts[who] ?? {}), email, flow_id: r.body.flow_id };
  if (who === 'C') delete s.part1.c;
  save(s);
  console.log(`${who}: code requested for ${email} (expires in ${r.body.expires_in ?? 600} s). ${who === 'C' ? 'C is never verified: run will spend its flow on wrong codes.' : `Next: node acceptance.mjs verify ${who} <code>`}`);
}

async function verify(who, code) {
  if (!['A', 'B'].includes(who) || !code) die('usage: verify A|B <code>');
  const s = load();
  const a = s.accounts[who];
  if (!a?.flow_id) die(`no flow for ${who}: run start ${who} <email> first`);
  const r = await call('POST', '/api/auth/email/verify', { body: { flow_id: a.flow_id, code, device_name: `acceptance-${who}`, platform: 'acceptance-script' } });
  if (r.code === 'RATE_LIMITED') die(`verify ${who}: ${brief(r)}. Nothing was spent: run the same command again then (the code lasts 10 minutes).`);
  if (r.status !== 200 || !r.body?.device_token) die(`verify ${who}: ${brief(r)}`);
  const prior = a.user_id ?? null;
  Object.assign(a, { token: r.body.device_token, device_id: r.body.device_id, user_id: r.body.user.id, teams_at_signin: (r.body.teams ?? []).map((t) => t.id) });
  // 1.5: the same code again, at once (no code is stored anywhere).
  const again = await call('POST', '/api/auth/email/verify', { body: { flow_id: a.flow_id, code } });
  s.part1[`reuse_${who}`] = { status: again.status, code: again.code, attempts_left: again.body?.error?.attempts_left ?? null };
  s.part1[`signin_${who}`] = { user_id: a.user_id, prior_user_id: prior, email_verified: r.body.user.email_verified === true, email_matches: r.body.user.email === a.email };
  delete a.flow_id;
  save(s);
  console.log(`${who}: signed in as user ${a.user_id} (${r.body.user.email_verified ? 'verified' : 'unverified'} email), ${a.teams_at_signin.length} team(s).`);
}

// ── run ─────────────────────────────────────────────────────────────────────
async function run() {
  const s = load();
  const A = s.accounts.A, B = s.accounts.B;
  if (!A?.token) die('A is not signed in: start A <email>, verify A <code>');
  const results = [];
  const row = (id, title, status, detail = '') => { results.push({ id, title, status, detail }); };
  const check = (id, title, ok, expected, actual) => row(id, title, ok ? 'PASS' : 'FAIL', ok ? '' : `expected ${expected}; got ${actual}`);
  const na = (id, title, why) => row(id, title, 'N/A', why);
  const as = (u, method, p, body) => call(method, p, { body, token: u.token });

  // Setup prerequisites
  const health = await call('GET', '/api/health');
  check('0.1', 'health ok and auth=accounts', health.status === 200 && health.body?.ok === true && health.body?.auth === 'accounts', 'ok:true auth:accounts', `${health.status} ok=${health.body?.ok} auth=${health.body?.auth}`);
  const methods = await call('GET', '/api/auth/methods');
  check('0.2', 'auth/methods offers email', methods.status === 200 && methods.body?.email === true, 'email:true', `${methods.status} ${JSON.stringify(methods.body)}`);

  // Part 1
  na('1.1', 'Team page visible before sign-in', 'desktop app UI');
  na('1.2', 'Continue with Google/GitHub', 'Google/GitHub sign-in in a browser');
  na('1.3', 'Still signed in after relaunch (Keychain)', 'desktop app');
  const sa = s.part1.signin_A;
  check('1.4', 'Email-code sign-in works, same user as before', !!sa && sa.email_verified && sa.email_matches && (!sa.prior_user_id || sa.prior_user_id === sa.user_id),
    'verified sign-in as the same user', JSON.stringify(sa ?? null));
  const ru = s.part1.reuse_A;
  check('1.5', 'Same code again is refused', !!ru && ru.status === 400 && ru.code === 'INVALID_TOKEN', '400 INVALID_TOKEN', ru ? `${ru.status} ${ru.code}` : 'not recorded (verify A again)');
  // 1.6 on C's throwaway flow: spent once across runs (the per-address budget is 20 a day). The hub keeps the
  // flow's attempt count, so a run stopped by the 10-a-10-min verify limit per IP resumes where it left off.
  const c = s.part1.c ?? (s.accounts.C?.flow_id ? { seen: [], done: false } : null);
  let cWait = null;
  while (c && !c.done) {
    const r = await call('POST', '/api/auth/email/verify', { body: { flow_id: s.accounts.C.flow_id, code: '000000' } });
    if (r.code === 'RATE_LIMITED') { cWait = r.body?.error?.retry_after_s ?? 60; break; }
    const left = r.body?.error?.attempts_left ?? null;
    c.seen.push({ status: r.status, code: r.code, left, msg: r.body?.error?.message ?? '' });
    if (left == null || c.seen.length > 5) c.done = true;
  }
  if (c) { s.part1.c = c; save(s); }
  if (!c) na('1.6', 'Wrong codes until the flow dies', 'start C <throwaway email> first');
  else if (!c.done) row('1.6', 'Wrong codes until the flow dies', 'PENDING', `verify rate limit per IP: ${c.seen.length} of 6 attempts made; run again in ${cWait} s`);
  else {
    const seen = c.seen;
    const lefts = seen.slice(0, 5).map((x) => x.left);
    const last = seen[5];
    const leaks = seen.some((x) => /account|registered|exist/i.test(x.msg));
    // A '000000' could in theory be C's real code (1 in 10^6): then the first answer is 200.
    check('1.6', 'Wrong codes: INVALID_TOKEN + attempts_left, dead after 5', seen.slice(0, 5).every((x) => x.status === 400 && x.code === 'INVALID_TOKEN') && lefts.join() === '4,3,2,1,0'
      && last && last.status === 400 && last.code === 'INVALID_TOKEN' && last.left == null && !leaks,
      'five 400 INVALID_TOKEN with attempts_left 4,3,2,1,0, then a dead flow (no attempts_left), no account hint', JSON.stringify(seen.map((x) => `${x.status} ${x.code} left=${x.left}`)));
  }
  na('1.7', 'SIGNUP_CLOSED for a new address without invite', 'email-code start answers 200 and mails nothing to a refused address, so the refusal is not observable over the API without a code');
  na('1.8', 'Cancel an in-progress Google sign-in', 'Google sign-in in a browser');

  // Team(s) owned by A: reuse by name (3 creations a day per user).
  const acct = await as(A, 'GET', '/api/account');
  if (acct.status !== 200) die(`GET /api/account as A: ${brief(acct)}`);
  async function ensureTeam(name) {
    const t = acct.body.teams.find((x) => x.name === name && x.role === 'owner');
    if (t) return { id: t.id, slug: t.slug };
    const r = await as(A, 'POST', '/api/teams', { name });
    if (r.status !== 200) die(`create team ${name}: ${brief(r)}`);
    return { id: r.body.team.id, slug: r.body.team.slug };
  }
  const T = await ensureTeam(TEAM);
  const T2 = await ensureTeam(TEAM2);
  s.teams[T.id] = { name: TEAM, slug: T.slug };
  s.teams[T2.id] = { name: TEAM2, slug: T2.slug };
  save(s);

  const members = async (team, u = A) => (await as(u, 'GET', `/api/teams/${team}/members`)).body?.members ?? [];
  const memberOf = async (team, uid) => (await members(team)).find((m) => m.user_id === uid);
  const pending = async (team) => (await as(A, 'GET', `/api/teams/${team}/invites`)).body?.invites ?? [];
  // Baseline so every run starts the same: B out of both teams, no pending invites for B.
  async function baseline(team) {
    if (B?.user_id) {
      const m = await memberOf(team, B.user_id);
      if (m) await as(A, 'DELETE', `/api/teams/${team}/members/${m.member_id}`, {});
    }
    if (B?.email) for (const i of await pending(team)) if (i.email === B.email.trim().toLowerCase()) await as(A, 'DELETE', `/api/teams/${team}/invites/${i.id}`, {});
  }
  await baseline(T.id);
  await baseline(T2.id);

  // Part 2
  const bEmail = B?.email ?? s.accounts.B?.email;
  if (!bEmail) die('B has no address: start B <email> first (B may verify later, after the invite exists)');
  const inv1 = await as(A, 'POST', `/api/teams/${T.id}/invites`, { email: bEmail, role: 'member' });
  const tok1 = inv1.body?.link?.split('#')[1];
  check('2.1', 'Invite B as member: link + code shown once', inv1.status === 200 && /^inv_/.test(tok1 ?? '') && /^[A-Z]{4}-[A-Z]{4}$/.test(inv1.body?.code ?? '') && inv1.body?.invite?.role === 'member',
    '200 {invite.role:member, link …#inv_…, code XXXX-XXXX}', `${brief(inv1)} role=${inv1.body?.invite?.role} link=${tok1 ? 'present' : 'missing'} code=${inv1.body?.code ? 'present' : 'missing'} mailed=${inv1.body?.mailed}`);
  const inv2 = await as(A, 'POST', `/api/teams/${T.id}/invites`, { email: bEmail, role: 'member' });
  check('2.2', 'Second invite for B → 409 CONFLICT naming the first', inv2.status === 409 && inv2.code === 'CONFLICT' && inv2.body?.error?.invite_id === inv1.body?.invite?.id,
    `409 CONFLICT invite_id=${inv1.body?.invite?.id}`, `${brief(inv2)} invite_id=${inv2.body?.error?.invite_id}`);
  const inv3 = await as(A, 'POST', `/api/teams/${T.id}/invites`, { email: A.email, role: 'member' });
  check('2.3', "Invite A's own address → 409 ALREADY_MEMBER", inv3.status === 409 && inv3.code === 'ALREADY_MEMBER', '409 ALREADY_MEMBER', brief(inv3));
  const inv4 = await as(A, 'POST', `/api/teams/${T.id}/invites`, { email: `owner-${Date.now()}@acceptance.invalid`, role: 'owner' });
  check('2.4', 'Invite as owner is refused', inv4.status === 403 && inv4.code === 'FORBIDDEN' && /invites never make owners/.test(inv4.body?.error?.message ?? ''),
    '403 FORBIDDEN "invites never make owners: invite, then change the role"', brief(inv4));
  // 2.5: A (signed in as another address) tries B's link. A is already in T, but the address check comes first.
  const wrong = tok1 ? await as(A, 'POST', '/api/invites/accept', { t: tok1 }) : null;
  const stillUsable = tok1 ? await call('POST', '/api/invites/preview', { body: { t: tok1 } }) : null;
  check('2.5', 'Another account accepting B\'s link → 403 WRONG_ACCOUNT, invite still usable', wrong?.status === 403 && wrong.code === 'WRONG_ACCOUNT' && !wrong.text.includes(bEmail) && stillUsable?.status === 200,
    '403 WRONG_ACCOUNT naming no address; preview still 200', `${brief(wrong)} names_address=${wrong?.text.includes(bEmail)}; preview ${brief(stillUsable)}`);

  if (!B?.token) {
    for (const [id, t] of [['2.6', 'B accepts'], ['2.7', 'Spent invite'], ['2.8', 'Role changes'], ['2.9', 'Second team'], ['3.x', 'Board share'], ['M.x', 'Agent mail']]) row(id, t, 'PENDING', 'B not signed in yet');
    s.results = results;
    save(s);
    printTable(results);
    console.log(`\nB has a pending invite now. Next: node acceptance.mjs start B ${bEmail}; verify B <code>; then run again.`);
    return;
  }

  const acc1 = await as(B, 'POST', '/api/invites/accept', { t: tok1 });
  const bm = await memberOf(T.id, B.user_id);
  check('2.6', 'B accepts and is a member', acc1.status === 200 && acc1.body?.team?.id === T.id && acc1.body?.member?.role === 'member' && bm?.role === 'member',
    `200 team=${T.id} role member; A's list shows B as member`, `${brief(acc1)} role=${acc1.body?.member?.role}; A's list: ${bm ? bm.role : 'absent'}`);
  const again = await as(B, 'POST', '/api/invites/accept', { t: tok1 });
  const bRows = (await members(T.id)).filter((m) => m.user_id === B.user_id).length;
  // Same user, same invite: the contract answers 200 with the same body (idempotent); it never adds a row.
  check('2.7', 'Reopening the spent invite adds nothing', (again.status === 200 && again.body?.member?.member_id === acc1.body?.member?.member_id) || again.code === 'INVALID_TOKEN' || again.code === 'ALREADY_MEMBER',
    'idempotent 200 (same member), INVALID_TOKEN or ALREADY_MEMBER; exactly one member row', `${brief(again)}; rows=${bRows}`);
  if (bRows !== 1) results.at(-1).status = 'FAIL', results.at(-1).detail = `expected 1 member row for B; got ${bRows}`;
  const memberId = bm?.member_id;
  const setRole = (role) => as(A, 'PATCH', `/api/teams/${T.id}/members/${memberId}`, { role });
  const bRole = async () => (await as(B, 'GET', `/api/teams/${T.id}`)).body?.me?.role;
  const toViewer = await setRole('viewer');
  const sawViewer = await bRole();
  const toMember = await setRole('member');
  const sawMember = await bRole();
  check('2.8', 'Role → viewer → member, seen by B', toViewer.status === 200 && toMember.status === 200 && sawViewer === 'viewer' && sawMember === 'member',
    "200, 200; B's /api/teams/:id me.role viewer then member", `${brief(toViewer)}, ${brief(toMember)}; B saw ${sawViewer} then ${sawMember}`);

  const inv9 = await as(A, 'POST', `/api/teams/${T2.id}/invites`, { email: bEmail, role: 'viewer' });
  const acc9 = inv9.body?.link ? await as(B, 'POST', '/api/invites/accept', { t: inv9.body.link.split('#')[1] }) : null;
  const bAcct = await as(B, 'GET', '/api/account');
  const bTeams = bAcct.body?.teams ?? [];
  const tb1 = (await as(B, 'GET', `/api/teams/${T.id}/boards`)).body?.boards?.map((b) => b.id) ?? [];
  const tb2 = (await as(B, 'GET', `/api/teams/${T2.id}/boards`)).body?.boards?.map((b) => b.id) ?? [];
  const m1 = (await members(T.id, B)).map((m) => m.user_id).sort().join();
  const m2 = (await members(T2.id, B)).map((m) => m.user_id).sort().join();
  check('2.9', 'Second team as viewer: two teams, each with its own boards', inv9.status === 200 && acc9?.body?.member?.role === 'viewer' && bTeams.some((t) => t.id === T.id) && bTeams.some((t) => t.id === T2.id)
    && tb1.length > 0 && tb2.length > 0 && !tb1.some((x) => tb2.includes(x)) && m1 === m2,
    'B in both teams; disjoint board lists; both list A+B', `invite ${brief(inv9)}, accept ${brief(acc9)} role=${acc9?.body?.member?.role}; teams=${bTeams.length}; boards ${tb1.length}/${tb2.length}`);
  na('2.10', 'Expired invite refused', 'invites last 7 days (INVITE_TTL_MS) with no short-expiry setting; cannot wait over the API');

  // Part 3
  const boardsOf = async (u, team) => (await as(u, 'GET', `/api/teams/${team}/boards`)).body?.boards ?? [];
  let board = (await as(A, 'GET', `/api/teams/${T.id}/boards?include_archived=1`)).body?.boards?.find((b) => b.name === 'Acceptance board');
  if (board?.archived_at) await as(A, 'POST', `/api/boards/${board.id}/restore`, {});
  let mkBoard = null;
  if (!board) { mkBoard = await as(A, 'POST', `/api/teams/${T.id}/boards`, { name: 'Acceptance board' }); board = mkBoard.body?.board; }
  const cardA = board ? await as(A, 'POST', `/api/boards/${board.id}/cards`, { request_id: randomUUID(), title: 'A-1 from A' }) : null;
  const cA = cardA?.body?.card;
  check('3.1', 'A creates Acceptance board and card A-1', !!board?.key_prefix && cardA?.status === 200 && typeof cA?.key === 'string' && cA.key.startsWith(`${board.key_prefix}-`),
    'board with key prefix; card key PREFIX-n', `board ${mkBoard ? brief(mkBoard) : 'reused'} prefix=${board?.key_prefix}; card ${brief(cardA)} key=${cA?.key}`);
  if (!board || !cA) { finish(s, results); return; }
  const bSeesBoard = (await boardsOf(B, T.id)).some((b) => b.id === board.id);
  const bSnap = await as(B, 'GET', `/api/boards/${board.id}`);
  const bCardIds = JSON.stringify(bSnap.body ?? {}).includes(cA.id);
  check('3.2', 'B sees the board and A-1', bSeesBoard && bSnap.status === 200 && bCardIds, 'board listed for B; snapshot contains A-1', `listed=${bSeesBoard}; snapshot ${brief(bSnap)} has card=${bCardIds}`);
  const com = await as(B, 'POST', `/api/cards/${cA.id}/comments`, { request_id: randomUUID(), body: 'B was here' });
  const cardB = await as(B, 'POST', `/api/boards/${board.id}/cards`, { request_id: randomUUID(), title: 'B-1 from B' });
  const detail = await as(A, 'GET', `/api/cards/${cA.id}`);
  const comments = detail.body?.comments ?? detail.body?.card?.comments ?? [];
  const bComment = comments.find((c) => c.body === 'B was here');
  const aSnap = await as(A, 'GET', `/api/boards/${board.id}`);
  const aCard = (aSnap.body?.cards ?? []).find((c) => c.id === cardB.body?.card?.id);
  // Comments carry the author's display name; a card's creator is in the board journal (actor = member id).
  const attributedComment = bComment && bComment.author_name === bm?.display_name;
  const journal = [];
  for (let after = 0; ;) {
    const pg = (await as(A, 'GET', `/api/boards/${board.id}/journal?after_seq=${after}&limit=1000`)).body;
    if (!pg?.rows?.length) break;
    journal.push(...pg.rows);
    after = pg.next_after_seq;
  }
  const attributedCard = aCard && journal.some((j) => j.card_id === aCard.id && JSON.stringify(j).includes(memberId));
  check('3.3', 'B comments and creates B-1; A sees both attributed to B (API read; live push not checked)', com.status === 200 && cardB.status === 200 && !!attributedComment && !!attributedCard,
    "200, 200; A's card detail has B's comment and A's snapshot has B-1, comment author_name = B, B-1's journal entry names B's member id", `comment ${brief(com)} seen=${!!bComment} attributed=${!!attributedComment}; card ${brief(cardB)} seen=${!!aCard} attributed=${!!attributedCard}`);
  await setRole('viewer');
  const vRead = await as(B, 'GET', `/api/boards/${board.id}`);
  const vCom = await as(B, 'POST', `/api/cards/${cA.id}/comments`, { request_id: randomUUID(), body: 'viewer comment' });
  const vCard = await as(B, 'POST', `/api/boards/${board.id}/cards`, { request_id: randomUUID(), title: 'viewer card' });
  const vMove = await as(B, 'PATCH', `/api/cards/${cA.id}`, { column: 'in_progress' });
  const refused = (r) => r.status === 403;
  check('3.4', 'As viewer: B reads; comment, create and move are refused', vRead.status === 200 && refused(vCom) && refused(vCard) && refused(vMove),
    'read 200; writes 403', `read ${brief(vRead)}; comment ${brief(vCom)}; create ${brief(vCard)}; move ${brief(vMove)}`);
  await setRole('member');
  const mCom = await as(B, 'POST', `/api/cards/${cA.id}/comments`, { request_id: randomUUID(), body: 'member again' });
  check('3.5', 'Back to member: B writes again', mCom.status === 200, '200', brief(mCom));
  const arch = await as(A, 'POST', `/api/boards/${board.id}/archive`, {});
  const goneA = !(await boardsOf(A, T.id)).some((b) => b.id === board.id);
  const goneB = !(await boardsOf(B, T.id)).some((b) => b.id === board.id);
  const archWrite = await as(A, 'POST', `/api/boards/${board.id}/cards`, { request_id: randomUUID(), title: 'on archived' });
  const rest = await as(A, 'POST', `/api/boards/${board.id}/restore`, {});
  check('3.6', 'Archive: board leaves both active lists (then restored)', arch.status === 200 && goneA && goneB && archWrite.status === 409 && rest.status === 200,
    'archive 200; absent from A and B lists; card create 409 BOARD_ARCHIVED; restore 200', `archive ${brief(arch)}; goneA=${goneA} goneB=${goneB}; write ${brief(archWrite)}; restore ${brief(rest)}`);

  // 3.10 (first half): B as admin makes a read:boards API token.
  await setRole('admin');
  const mkTok = await as(B, 'POST', `/api/teams/${T.id}/api-tokens`, { name: 'acceptance', scopes: ['read:boards'], expires_days: 1 });
  const pubTok = mkTok.body?.secret;
  const pubRead = pubTok ? await call('GET', '/api/public/v1/boards', { token: pubTok }) : null;
  await setRole('member');

  // 3.7 removal
  const rm = await as(A, 'DELETE', `/api/teams/${T.id}/members/${memberId}`, {});
  const rTeam = await as(B, 'GET', `/api/teams/${T.id}`);
  const rBoard = await as(B, 'GET', `/api/boards/${board.id}`);
  const rCard = await as(B, 'GET', `/api/cards/${cA.id}`);
  const rInv = await as(B, 'POST', '/api/invites/accept', { t: tok1 });
  const rAcct = await as(B, 'GET', '/api/account');
  const rTeams = rAcct.body?.teams?.map((t) => t.id) ?? [];
  check('3.7', 'A removes B: team, board, card gone for B; old link does not re-add; team 2 unaffected', rm.status === 200 && rTeam.status === 404 && rBoard.status === 404 && rCard.status === 404
    && rInv.status !== 200 && !rTeams.includes(T.id) && rTeams.includes(T2.id),
    'remove 200; B gets 404 ×3; old invite refused; B still in team 2', `remove ${brief(rm)}; team ${brief(rTeam)} board ${brief(rBoard)} card ${brief(rCard)}; old invite ${brief(rInv)}; teams has T=${rTeams.includes(T.id)} T2=${rTeams.includes(T2.id)}`);
  // 3.9 isolation, while B is not in T.
  const fake = randomUUID();
  const fBoard = await as(B, 'GET', `/api/boards/${fake}`);
  const fCard = await as(B, 'GET', `/api/cards/${fake}`);
  const leaked = [rBoard.text, rCard.text].some((t) => t.includes('Acceptance board') || t.includes(board.key_prefix) || t.includes('A-1 from A') || t.includes(cA.key));
  const same = rBoard.status === fBoard.status && rBoard.code === fBoard.code && rCard.status === fCard.status && rCard.code === fCard.code
    && rBoard.body?.error?.message === fBoard.body?.error?.message && rCard.body?.error?.message === fCard.body?.error?.message;
  check('3.9', 'Non-member requesting A\'s board/card ids: same as a missing id, nothing leaked', same && !leaked,
    'identical answers to random ids; no name/key/title', `board ${brief(rBoard)} vs ${brief(fBoard)}; card ${brief(rCard)} vs ${brief(fCard)}; leaked=${leaked}`);
  if (mkTok.status === 404 && mkTok.code === 'NOT_FOUND') na('3.10', 'API token acts only while its maker is in the team', 'api-tokens route not served (migration 070 not deployed)');
  else {
    const pubAfter = pubTok ? await call('GET', '/api/public/v1/boards', { token: pubTok }) : null;
    check('3.10', 'API token reads while B is admin, 401 after B is removed', mkTok.status === 200 && pubRead?.status === 200 && pubAfter?.status === 401,
      'create 200; read 200; after removal 401', `create ${brief(mkTok)}; read ${brief(pubRead)}; after ${brief(pubAfter)}`);
    if (mkTok.body?.token?.id) await as(A, 'DELETE', `/api/teams/${T.id}/api-tokens/${mkTok.body.token.id}`, {});
  }
  // 3.8 re-invite
  const inv8 = await as(A, 'POST', `/api/teams/${T.id}/invites`, { email: bEmail, role: 'member' });
  const acc8 = inv8.body?.link ? await as(B, 'POST', '/api/invites/accept', { t: inv8.body.link.split('#')[1] }) : null;
  const backSees = (await boardsOf(B, T.id)).some((b) => b.id === board.id);
  const hist = await as(A, 'GET', `/api/cards/${cA.id}`);
  const histOk = (hist.body?.comments ?? hist.body?.card?.comments ?? []).some((c) => c.body === 'B was here');
  check('3.8', 'Re-invite: B is a member again, sees boards; history intact', inv8.status === 200 && acc8?.status === 200 && acc8.body?.member?.role === 'member' && acc8.body?.member?.member_id === memberId && backSees && histOk,
    'invite 200; accept 200 member with the old member row; board listed; B\'s old comment still on A-1', `invite ${brief(inv8)}; accept ${brief(acc8)} role=${acc8?.body?.member?.role} same_row=${acc8?.body?.member?.member_id === memberId}; sees=${backSees}; history=${histOk}`);

  // Agent mail (MESSAGING §6a): A's agent asks B (held), A releases, B answers, then a handoff B accepts.
  const ask = await as(A, 'POST', `${MSG}/messages`, { request_id: randomUUID(), to: { user_id: B.user_id, org_id: T.id }, body: 'Acceptance: which env var holds the queue URL?', hold: true, via: { surface: 'local', provider: 'claude', label: 'acceptance script' } });
  const m = ask.body?.message;
  check('M.1', "A's agent drafts an ask to B: held", ask.status === 200 && m?.state === 'held' && m?.via?.label_source === 'self_declared', '200 state held, via self_declared', `${brief(ask)} state=${m?.state}`);
  if (!m) { finish(s, results); return; }
  const bInbox0 = (await as(B, 'GET', `${MSG}/messages?box=inbox`)).body?.messages ?? [];
  const bGet0 = await as(B, 'GET', `${MSG}/messages/${m.id}`);
  const aHeld = (await as(A, 'GET', `${MSG}/messages?box=held`)).body?.messages ?? [];
  check('M.2', 'Held message invisible to B; listed in A\'s held box', !bInbox0.some((x) => x.id === m.id) && bGet0.status === 404 && aHeld.some((x) => x.id === m.id),
    'B inbox lacks it, B GET 404, A held lists it', `inB=${bInbox0.some((x) => x.id === m.id)} B GET ${brief(bGet0)} inHeld=${aHeld.some((x) => x.id === m.id)}`);
  const rel = await as(A, 'POST', `${MSG}/messages/${m.id}/release`, { decision: 'send' });
  const rel2 = await as(A, 'POST', `${MSG}/messages/${m.id}/release`, { decision: 'send' });
  check('M.3', 'A releases it (once): queued', rel.status === 200 && rel.body?.message?.state === 'queued' && rel2.status === 409, 'release 200 queued; again 409', `${brief(rel)} state=${rel.body?.message?.state}; again ${brief(rel2)}`);
  const bInbox = (await as(B, 'GET', `${MSG}/messages?box=inbox`)).body?.messages ?? [];
  const rcpt = await as(B, 'POST', `${MSG}/messages/${m.id}/receipt`, { state: 'delivered' });
  check('M.4', 'B receives it and marks delivered', bInbox.some((x) => x.id === m.id) && rcpt.status === 200, 'in B inbox; receipt 200', `inB=${bInbox.some((x) => x.id === m.id)}; receipt ${brief(rcpt)}`);
  const ans = await as(B, 'POST', `${MSG}/messages`, { request_id: randomUUID(), to: { user_id: A.user_id, org_id: T.id }, body: 'QUEUE_URL', reply_to: m.id });
  const replies = (await as(A, 'GET', `${MSG}/messages?box=inbox&reply_to=${m.id}`)).body?.messages ?? [];
  check('M.5', "B answers; A's replies-to-ask lists the answer", ans.status === 200 && replies.some((x) => x.id === ans.body?.message?.id && x.body === 'QUEUE_URL'),
    'answer 200; A inbox?reply_to lists it', `answer ${brief(ans)}; replies=${replies.length}`);
  const ho = await as(A, 'POST', `${MSG}/messages`, { request_id: randomUUID(), to: { user_id: B.user_id, org_id: T.id }, kind: 'handoff', body: 'Acceptance: please take A-1', handoff: { card_refs: [cA.id], artifacts: [] }, hold: true, via: { surface: 'local', provider: 'claude', label: 'acceptance script' } });
  const hm = ho.body?.message;
  const hrel = hm ? await as(A, 'POST', `${MSG}/messages/${hm.id}/release`, { decision: 'send' }) : null;
  const bSees = hm ? await as(B, 'GET', `${MSG}/messages/${hm.id}`) : null;
  const dec = hm ? await as(B, 'POST', `${MSG}/messages/${hm.id}/handoff`, { decision: 'accept', report: 'Taking it.' }) : null;
  const aView = hm ? await as(A, 'GET', `${MSG}/messages/${hm.id}`) : null;
  check('M.6', 'Held handoff released; B accepts; A sees accepted', ho.status === 200 && hm?.state === 'held' && hrel?.status === 200 && bSees?.body?.message?.handoff?.state === 'offered'
    && dec?.status === 200 && aView?.body?.message?.handoff?.state === 'accepted',
    'held → released → offered to B → accept 200 → A reads accepted', `create ${brief(ho)} state=${hm?.state}; release ${brief(hrel)}; B sees ${bSees?.body?.message?.handoff?.state}; accept ${brief(dec)}; A sees ${aView?.body?.message?.handoff?.state}`);

  finish(s, results);
}

function finish(s, results) {
  s.results = results;
  s.ran_at = new Date().toISOString();
  save(s);
  printTable(results);
  if (results.some((r) => r.status === 'FAIL')) process.exitCode = 1;
}

function printTable(results) {
  const w = Math.max(...results.map((r) => r.title.length), 5);
  console.log(`\n${'#'.padEnd(5)} ${'Row'.padEnd(w)} Result`);
  for (const r of results) {
    console.log(`${r.id.padEnd(5)} ${r.title.padEnd(w)} ${r.status}`);
    if (r.detail) console.log(`${''.padEnd(5)} ${''.padEnd(w)}   ${r.detail}`);
  }
  const n = (k) => results.filter((r) => r.status === k).length;
  console.log(`\nPASS ${n('PASS')}  FAIL ${n('FAIL')}  N/A ${n('N/A')}${n('PENDING') ? `  PENDING ${n('PENDING')}` : ''}`);
}

// ── cleanup (Part 4) ────────────────────────────────────────────────────────
// Deleting a team needs a fresh 'delete_team' step-up: one emailed code per team.
async function cleanup(code) {
  const s = load();
  const A = s.accounts.A;
  const left = Object.entries(s.teams ?? {});
  if (left.length && !A?.token) die('A is not signed in: cannot delete teams');
  if (left.length) {
    const [id, t] = left[0];
    if (!code) {
      const st = await call('POST', '/api/auth/email/start', { token: A.token, body: { purpose: 'delete_team' } });
      if (st.status !== 200) die(`step-up start: ${brief(st)}`);
      s.stepup = { team: id, flow_id: st.body.flow_id };
      save(s);
      console.log(`A code to delete team "${t.name}" was mailed to A. Next: node acceptance.mjs cleanup <code>`);
      return;
    }
    if (s.stepup?.team !== id) die('no step-up pending for this team: run cleanup without a code first');
    const v = await call('POST', '/api/auth/email/verify', { token: A.token, body: { flow_id: s.stepup.flow_id, code } });
    if (v.code === 'RATE_LIMITED') die(`step-up verify: ${brief(v)}. Run the same cleanup command again then (the code lasts 10 minutes).`);
    if (v.status !== 200) die(`step-up verify: ${brief(v)}`);
    const del = await call('DELETE', `/api/teams/${id}`, { token: A.token, body: { confirm_slug: t.slug, flow_id: s.stepup.flow_id } });
    if (del.status !== 200 && del.status !== 404) die(`delete team ${t.name}: ${brief(del)}`);
    const gone = await call('GET', `/api/teams/${id}`, { token: A.token });
    console.log(`Deleted team "${t.name}" (${brief(del)}; now ${brief(gone)}).`);
    delete s.teams[id];
    delete s.stepup;
    save(s);
    if (Object.keys(s.teams).length) { await cleanup(); return; }
  }
  for (const who of ['A', 'B']) {
    const u = s.accounts[who];
    if (!u?.token) continue;
    const out = await call('POST', '/api/auth/signout', { token: u.token, body: {} });
    const after = await call('GET', '/api/account', { token: u.token });
    console.log(`${who}: signed out (${brief(out)}); token now ${brief(after)}.`);
    delete u.token;
    delete u.device_id;
  }
  save(s);
  console.log('Cleanup done. Delete test accounts in the app if they are throwaway (Account, Delete my account).');
}

const [cmd, ...args] = process.argv.slice(2);
const cmds = { start: () => start(args[0], args[1]), verify: () => verify(args[0], args[1]), run, cleanup: () => cleanup(args[0]) };
if (!cmds[cmd]) die('usage: node acceptance.mjs start A|B|C <email> | verify A|B <code> | run | cleanup [code]');
await cmds[cmd]();
