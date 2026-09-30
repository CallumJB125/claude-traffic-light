// Tenancy fixture (ACCOUNTS-DESIGN.md §7.3): an accounts-mode hub with two
// teams, Alpha (A) and Beta (B), made through the API. A has an owner, an
// admin, a member and a viewer; B has an owner. User S is a member of both.
// Both teams link the SAME canonical repo URL (separate repo rows), and B holds
// content in every table a route can reach: a card with a comment, a run with
// an open permission request, a runner device, an ask, a pending invite, an
// integration connection (the fake connector). N is signed in and in no team. Everything B holds carries the marker `B-SECRET`.

import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { startAccounts } from '../accounts-helpers.js';
import { emailOnlyIdentity } from '../../views.js';
import fake from '../../integrations/fake/index.js';

export const MARK = 'B-SECRET';

// Many sign-ins from one test IP: lift the per-IP sign-in limits (their own
// tests live in accounts.test.js).
export const ROOMY = Object.freeze(Object.fromEntries(['auth_start_ip', 'auth_verify_ip', 'signup_ip', 'mutate_ip', 'mutate_member', 'login_ip'].map((k) => [k, { capacity: 10_000, per_ms: 60_000 }])));

export async function tenancy({ config = {}, ...opts } = {}) {
  const h = await startAccounts({ ...opts, config: { ...config, rateLimits: { ...ROOMY, ...config.rateLimits } } });
  const db = h.db;
  const users = {};
  async function user(key, email) {
    const r = await h.signIn(email);
    if (r.status !== 200) throw new Error(`sign-in ${email}: ${r.text}`);
    users[key] = { id: r.body.user.id, email, token: r.body.device_token, device_id: r.body.device_id };
    return users[key];
  }
  const origin = { origin: h.base };
  // Bearer calls with the hub's own Origin, as the desktop web view sends.
  const as = (u, method, path, body, headers = {}) => h.call(method, path, { token: u.token, body, headers: { ...origin, ...headers } });

  await user('ua', 'owner@alpha.test');
  await user('ub', 'owner@beta.test');
  for (const [k, e] of [['aadmin', 'admin@alpha.test'], ['amember', 'member@alpha.test'], ['aviewer', 'viewer@alpha.test'], ['s', 'shared@both.test'], ['n', 'nobody@none.test']]) await user(k, e);

  const ta = await as(users.ua, 'POST', '/api/teams', { name: 'Alpha' });
  const tb = await as(users.ub, 'POST', '/api/teams', { name: `Beta ${MARK}` });
  if (ta.status !== 200 || tb.status !== 200) throw new Error(`team create: ${ta.text} ${tb.text}`);
  const A = { team: ta.body.team.id, board: ta.body.board.id };
  const B = { team: tb.body.team.id, board: tb.body.board.id };

  /** Direct membership row (what an accepted invite writes). */
  function addMember(teamId, u, role) {
    const id = randomUUID();
    db.insert('members', {
      id, org_id: teamId, user_id: u.id, role, display_name: u.email.split('@')[0], email: u.email,
      ...emailOnlyIdentity(u.email), joined_via: 'fixture', created_at: h.hub.iso(),
    });
    return id;
  }
  const memberOf = (teamId, u) => db.get('SELECT id FROM members WHERE org_id = ? AND user_id = ? AND removed_at IS NULL', teamId, u.id)?.id;
  A.owner = memberOf(A.team, users.ua);
  A.admin = addMember(A.team, users.aadmin, 'admin');
  A.member = addMember(A.team, users.amember, 'member');
  A.viewer = addMember(A.team, users.aviewer, 'viewer');
  A.s = addMember(A.team, users.s, 'member');
  B.owner = memberOf(B.team, users.ub);
  B.s = addMember(B.team, users.s, 'member');

  // The same repo URL linked in both teams: two rows, one per team.
  const now = h.hub.iso();
  for (const T of [A, B]) {
    T.repo = randomUUID();
    db.insert('repos', { id: T.repo, org_id: T.team, canonical_url: 'github.com/shared/app', short_name: 'app' });
    db.run('INSERT INTO board_repos (board_id, repo_id) VALUES (?, ?)', T.board, T.repo);
  }

  const cb = await as(users.ub, 'POST', `/api/boards/${B.board}/cards`, { request_id: randomUUID(), title: `${MARK} card`, body: `${MARK} body`, repo_id: B.repo });
  const ca = await as(users.ua, 'POST', `/api/boards/${A.board}/cards`, { request_id: randomUUID(), title: 'Alpha card', repo_id: A.repo });
  if (cb.status !== 200 || ca.status !== 200) throw new Error(`card create: ${cb.text} ${ca.text}`);
  B.card = cb.body.card.id;
  A.card = ca.body.card.id;
  await as(users.ub, 'POST', `/api/cards/${B.card}/comments`, { request_id: randomUUID(), body: `${MARK} comment` });

  // B: a runner device, a run on its card, an open permission request and an ask.
  B.device = randomUUID();
  db.insert('devices', { id: B.device, member_id: B.owner, name: `${MARK} laptop`, kind: 'runner', token_hash: createHash('sha256').update(randomUUID()).digest('hex'), created_at: now });
  const dispatch = randomUUID();
  db.insert('dispatches', { request_id: dispatch, card_id: B.card, dispatched_by: B.owner, state: 'claimed', created_at: now });
  B.run = randomUUID();
  db.insert('runs', { id: B.run, card_id: B.card, fence: 1, device_id: B.device, on_behalf_of: B.owner, dispatched_by: B.owner, dispatch_request_id: dispatch, backend: 'claude_cli', repo_id: B.repo, base_ref: 'main', started_at: now });
  B.permission = randomUUID();
  db.insert('permission_requests', { id: B.permission, run_id: B.run, card_id: B.card, tool: 'Bash', input_summary: `${MARK} rm -rf`, state: 'open', approvers: JSON.stringify([B.owner, B.s]), created_at: now });
  const ib = await as(users.ub, 'POST', `/api/teams/${B.team}/invites`, { email: 'invitee@beta.test', role: 'member' });
  if (ib.status !== 200) throw new Error(`invite: ${ib.text}`);
  B.invite = ib.body.invite.id;
  B.inviteToken = ib.body.link.split('#')[1];
  B.ask = randomUUID();
  db.insert('asks', { id: B.ask, run_id: B.run, card_id: B.card, kind: 'question', text: `${MARK} ask`, state: 'open', created_at: now });
  h.hub.setVaultKey(randomBytes(32));
  h.app.integrations.register(fake);
  const v = await fake.connect.verifyToken({ token: 'fake_abcdef123456' });
  B.connection = h.app.integrations.createConnection({ ...v, display_name: `${MARK} workspace`, orgId: B.team, memberId: B.owner, provider: 'fake' }).id;

  /** Everything team B owns, as one string: equal before and after = untouched. */
  function snapshotB() {
    const q = (sql, ...a) => JSON.stringify(db.all(sql, ...a));
    return [
      q('SELECT * FROM orgs WHERE id = ?', B.team),
      q('SELECT * FROM boards WHERE org_id = ?', B.team),
      q('SELECT id, org_id, role, removed_at, display_name FROM members WHERE org_id = ?', B.team),
      q('SELECT c.* FROM cards c JOIN boards b ON b.id = c.board_id WHERE b.org_id = ?', B.team),
      q('SELECT * FROM comments WHERE card_id = ?', B.card),
      q('SELECT * FROM permission_requests WHERE card_id = ?', B.card),
      q('SELECT * FROM asks WHERE card_id = ?', B.card),
      q('SELECT * FROM devices WHERE member_id IN (SELECT id FROM members WHERE org_id = ?)', B.team),
      q('SELECT * FROM repos WHERE org_id = ?', B.team),
      q('SELECT * FROM invites WHERE org_id = ?', B.team),
      q('SELECT * FROM connections WHERE org_id = ?', B.team),
      q('SELECT * FROM connection_secrets WHERE connection_id = ?', B.connection),
    ].join('\n');
  }

  return { h, db, users, A, B, as, addMember, snapshotB };
}

/**
 * §7.2 invariants as SQL: each query lists rows that point across teams.
 * All must return zero rows (T-DB).
 */
export const INVARIANTS = {
  card_repo: `SELECT c.id FROM cards c JOIN boards b ON b.id = c.board_id JOIN repos r ON r.id = c.repo_id WHERE r.org_id != b.org_id`,
  card_creator: `SELECT c.id FROM cards c JOIN boards b ON b.id = c.board_id JOIN members m ON m.id = c.created_by WHERE m.org_id != b.org_id`,
  card_stopper: `SELECT c.id FROM cards c JOIN boards b ON b.id = c.board_id JOIN members m ON m.id = c.stopped_by WHERE m.org_id != b.org_id`,
  board_repos: `SELECT br.board_id FROM board_repos br JOIN boards b ON b.id = br.board_id JOIN repos r ON r.id = br.repo_id WHERE r.org_id != b.org_id`,
  assignees: `SELECT a.card_id FROM card_assignees a JOIN cards c ON c.id = a.card_id JOIN boards b ON b.id = c.board_id JOIN members m ON m.id = a.member_id WHERE m.org_id != b.org_id`,
  dispatches: `SELECT d.request_id FROM dispatches d JOIN cards c ON c.id = d.card_id JOIN boards b ON b.id = c.board_id
    JOIN members m ON m.id = d.dispatched_by LEFT JOIN members t ON t.id = d.target_member_id WHERE m.org_id != b.org_id OR t.org_id != b.org_id`,
  runs: `SELECT r.id FROM runs r JOIN cards c ON c.id = r.card_id JOIN boards b ON b.id = c.board_id JOIN members o ON o.id = r.on_behalf_of
    JOIN members d ON d.id = r.dispatched_by JOIN repos rp ON rp.id = r.repo_id LEFT JOIN devices dv ON dv.id = r.device_id LEFT JOIN members dm ON dm.id = dv.member_id
    WHERE o.org_id != b.org_id OR d.org_id != b.org_id OR rp.org_id != b.org_id OR dm.org_id != b.org_id`,
  comments: `SELECT x.id FROM comments x JOIN cards c ON c.id = x.card_id JOIN boards b ON b.id = c.board_id JOIN members m ON m.id = x.author_member_id WHERE m.org_id != b.org_id`,
  asks: `SELECT x.id FROM asks x JOIN cards c ON c.id = x.card_id JOIN boards b ON b.id = c.board_id JOIN members m ON m.id = x.answered_by WHERE m.org_id != b.org_id`,
  permissions: `SELECT x.id FROM permission_requests x JOIN cards c ON c.id = x.card_id JOIN boards b ON b.id = c.board_id JOIN members m ON m.id = x.answered_by WHERE m.org_id != b.org_id`,
  memories: `SELECT x.id FROM memories x JOIN repos r ON r.id = x.repo_id LEFT JOIN cards c ON c.id = x.card_id LEFT JOIN boards b ON b.id = c.board_id
    LEFT JOIN members m ON m.id = x.author_member_id WHERE r.org_id != x.org_id OR b.org_id != x.org_id OR m.org_id != x.org_id`,
  overlaps: `SELECT o.id FROM overlaps o JOIN runs ra ON ra.id = o.run_a JOIN runs rb ON rb.id = o.run_b JOIN repos a ON a.id = ra.repo_id JOIN repos b ON b.id = rb.repo_id WHERE a.org_id != b.org_id`,
  runner_repos: `SELECT rr.device_id FROM runner_repos rr JOIN devices d ON d.id = rr.device_id JOIN members m ON m.id = d.member_id JOIN repos r ON r.id = rr.repo_id WHERE r.org_id != m.org_id`,
  journal: `SELECT j.seq FROM journal j JOIN cards c ON c.id = j.card_id WHERE j.board_id IS NOT c.board_id`,
  invites: `SELECT i.id FROM invites i JOIN members c ON c.id = i.created_by LEFT JOIN members m ON m.id = i.member_id WHERE c.org_id != i.org_id OR m.org_id != i.org_id`,
};
