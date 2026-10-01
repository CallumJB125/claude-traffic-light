// Accounts re-review follow-ups (CONTRACT D73–D75): step-ups keep their own
// failure budget (M-A) and purpose (L-H), the operator erasure CLI (M-B), the
// loopback-only try-out hub (L-A), the failure budget across a restart (L-B)
// and its bounds (L-C, L-D), a suppressed flow's fixed answer (L-G), and mail
// limits per mailbox with half the daily cap kept for existing accounts (M-C).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../config.js';
import { FailureBudget } from '../ratelimit.js';
import { Accounts, mailbox } from '../identity/accounts.js';
import { runAdmin } from '../admin.js';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { createLogger } from '../log.js';
import { startAccounts } from './accounts-helpers.js';
import { fakeGitHub, testConfig } from './helpers.js';
import { outboxMailer } from '../identity/mailer.js';

const MIN = 60_000;
const ROOMY = { rateLimits: { auth_start_ip: { capacity: 10_000, per_ms: MIN }, auth_verify_ip: { capacity: 10_000, per_ms: MIN }, signup_ip: { capacity: 10_000, per_ms: MIN } } };
const wrong = (h, flowId, token) => h.call('POST', '/api/auth/email/verify', { token, body: { flow_id: flowId, code: '000000' } });

test('M-A: a third party locking an address out of sign-in does not block that user\'s delete step-up', async () => {
  const h = await startAccounts({ config: ROOMY });
  try {
    const bob = await h.signIn('bob@dev.local');
    const tok = bob.body.device_token;
    // Someone else burns the address's whole failure budget (20 wrong codes).
    for (let i = 0; i < 4; i++) {
      h.clock.advance(15 * MIN);
      const f = await h.start('bob@dev.local');
      for (let j = 0; j < 5; j++) await wrong(h, f.body.flow_id);
    }
    h.clock.advance(15 * MIN);
    const locked = await h.start('bob@dev.local');
    assert.equal((await h.call('POST', '/api/auth/email/verify', { body: { flow_id: locked.body.flow_id, code: h.codeFor('bob@dev.local') } })).status, 429, 'sign-in is locked');
    // The signed-in user still confirms a deletion: its own budget, its own start buckets.
    const flow = await h.stepUp(tok, 'bob@dev.local');
    assert.equal((await h.call('DELETE', '/api/account', { token: tok, body: { flow_id: flow } })).status, 200);
  } finally {
    await h.close();
  }
});

test('M-A: wrong step-up codes count against the user, not the address, and send no lockout notice', async () => {
  const h = await startAccounts({ config: { ...ROOMY, authFailBudget: 5 } });
  try {
    const bob = await h.signIn('bob@dev.local');
    const tok = bob.body.device_token;
    const s = await h.call('POST', '/api/auth/email/start', { token: tok, body: { purpose: 'delete' } });
    for (let i = 0; i < 5; i++) await wrong(h, s.body.flow_id, tok);
    const uid = bob.body.user.id;
    assert.ok(h.hub.accounts.failures.lockedFor(`delete|${uid}`) > 0);
    assert.equal(h.hub.accounts.failures.lockedFor('bob@dev.local'), 0, 'sign-in stays open');
    assert.equal(h.mailer.sent.filter((m) => /trying sign-in codes/.test(m.subject)).length, 0);
    const again = await h.call('POST', '/api/auth/email/start', { token: tok, body: { purpose: 'delete' } });
    assert.equal((await h.call('POST', '/api/auth/email/verify', { token: tok, body: { flow_id: again.body.flow_id, code: h.codeFor('bob@dev.local') } })).status, 429);
    assert.equal((await h.signIn('bob@dev.local')).status, 200, 'the address still signs in');
  } finally {
    await h.close();
  }
});

test('L-H: delete_team is its own step-up with its own mail; neither purpose is spent on the other', async () => {
  const h = await startAccounts({ config: ROOMY });
  try {
    const u = await h.signIn('solo@example.com');
    const tok = u.body.device_token;
    const t = await h.call('POST', '/api/teams', { token: tok, body: { name: 'Solo' } });
    const team = t.body.team;
    const teamStep = await h.stepUp(tok, 'solo@example.com', 'delete_team');
    const mail = h.mailer.last('solo@example.com');
    assert.match(mail.subject, /confirms deleting a Plexiform team/);
    assert.match(mail.text, /delete a team you own/);
    assert.ok(!/delete it\./.test(mail.text), 'never "delete your account" wording');
    const acct = await h.call('DELETE', '/api/account', { token: tok, body: { flow_id: teamStep } });
    assert.equal(acct.body.error.code, 'STEP_UP_REQUIRED');
    assert.equal(acct.body.error.purpose, 'delete');
    const acctStep = await h.stepUp(tok, 'solo@example.com', 'delete');
    const tr = await h.call('DELETE', `/api/teams/${team.id}`, { token: tok, body: { confirm_slug: team.slug, flow_id: acctStep } });
    assert.equal(tr.body.error.code, 'STEP_UP_REQUIRED');
    assert.equal(tr.body.error.purpose, 'delete_team');
    assert.equal((await h.call('DELETE', `/api/teams/${team.id}`, { token: tok, body: { confirm_slug: team.slug, flow_id: teamStep } })).status, 200);
    assert.equal((await h.call('POST', '/api/auth/email/start', { token: tok, body: { purpose: 'nuke' } })).status, 400);
  } finally {
    await h.close();
  }
});

test('L-G: a verify on a suppressed flow counts down like a real one; an unknown flow answers attempts_left 5', async () => {
  const h = await startAccounts({ config: { mailDailyCap: 2 } });
  try {
    await h.start('a@example.com');               // the one new-address mail of the day
    const quiet = await h.start('b@example.com'); // suppressed: a dud row, no mail
    assert.ok(h.db.get('SELECT 1 AS x FROM login_flows WHERE id = ?', quiet.body.flow_id));
    for (const [id, left] of [[quiet.body.flow_id, 4], ['made-up', 5]]) {
      const r = await wrong(h, id);
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'INVALID_TOKEN');
      assert.equal(r.body.error.attempts_left, left);
    }
  } finally {
    await h.close();
  }
});

test('L-B: the failure budget is re-read from login_flows at start, so a restart does not unlock', async () => {
  const h = await startAccounts({ config: { ...ROOMY, authFailBudget: 10 } });
  try {
    await h.signIn('carol@example.com');
    for (let i = 0; i < 2; i++) {
      h.clock.advance(15 * MIN);
      const f = await h.start('carol@example.com');
      for (let j = 0; j < 5; j++) await wrong(h, f.body.flow_id);
    }
    const before = h.hub.accounts.failures.lockedFor('carol@example.com');
    assert.ok(before > 0);
    // A new Accounts over the same DB, as after a restart (memory empty).
    const restarted = new Accounts(h.hub, { mailer: h.mailer });
    assert.ok(restarted.failures.lockedFor('carol@example.com') > 0, 'still locked');
    // Older than a day: forgotten.
    h.clock.advance(24 * 60 * MIN + 1);
    assert.equal(new Accounts(h.hub, { mailer: h.mailer }).failures.lockedFor('carol@example.com'), 0);
  } finally {
    await h.close();
  }
});

test('L-B: failures a later right code cleared are not re-read', async () => {
  const h = await startAccounts({ config: { ...ROOMY, authFailBudget: 5 } });
  try {
    const f = await h.start('dan@example.com');
    for (let j = 0; j < 4; j++) await wrong(h, f.body.flow_id);
    h.clock.advance(MIN);
    assert.equal((await h.signIn('dan@example.com')).status, 200);
    const restarted = new Accounts(h.hub, { mailer: h.mailer });
    assert.equal(restarted.failures.keys.has('dan@example.com'), false);
  } finally {
    await h.close();
  }
});

test('L-C: BOARD_AUTH_FAIL_BUDGET is 1–100', () => {
  const base = (over) => ({ ...testConfig({ auth: 'accounts', devLoginSecret: null, accountsDev: true }), ...over });
  assert.doesNotThrow(() => validateConfig(base({ authFailBudget: 100 })));
  assert.throws(() => validateConfig(base({ authFailBudget: 101 })), /from 1 to 100/);
  assert.throws(() => validateConfig(base({ authFailBudget: 0 })), /from 1 to 100/);
});

test('L-D: the failure budget sweeps at most once a minute and keeps at most maxKeys, least recently failed out first', () => {
  let now = 0;
  const fb = new FailureBudget({ now: () => now, budget: 3, windowMs: 10 * MIN, maxKeys: 3 });
  let scans = 0;
  const realState = fb.state.bind(fb);
  fb.state = (k) => { scans++; return realState(k); };
  for (const k of ['a', 'b', 'c']) fb.fail(k);
  fb.fail('a');           // a is now the most recent
  fb.fail('d');           // evicts b, the least recently failed
  assert.deepEqual([...fb.keys.keys()], ['c', 'a', 'd']);
  scans = 0;
  for (let i = 0; i < 100; i++) fb.fail('d');
  assert.ok(scans < 250, `no full sweep per failure (${scans} state calls)`);
  now += 11 * MIN;        // every failure outside the window; d is still locked out
  fb.fail('e');           // the minute has passed: one sweep drops the idle keys
  assert.deepEqual([...fb.keys.keys()], ['d', 'e']);
});

test('M-C: mail limits are per mailbox (+tags folded), and half the daily cap stays for existing accounts', async () => {
  assert.equal(mailbox('jo+x1@example.com'), 'jo@example.com');
  assert.equal(mailbox('jo@example.com'), 'jo@example.com');
  assert.equal(mailbox('+x@example.com'), '+x@example.com');
  const h = await startAccounts({ config: { ...ROOMY, mailDailyCap: 8 } });
  try {
    await h.signIn('eve@example.com');                            // new-address mail 1 of 4
    for (const tag of ['a', 'b', 'c']) await h.start(`eve+${tag}@example.com`);
    // One mailbox: 3 per 15 min whatever the +tag, so the third tagged start is silent.
    assert.equal(h.mailer.sent.filter((m) => m.to.startsWith('eve')).length, 3);
    h.clock.advance(20 * MIN);
    await h.start('s1@example.com');                              // new-address mail 4 of 4
    await h.start('s2@example.com');                              // the new-address half is spent
    assert.ok(h.mailer.last('s1@example.com'));
    assert.equal(h.mailer.last('s2@example.com'), null);
    const known = await h.start('eve@example.com');               // an existing account still gets mail
    assert.ok(h.db.get('SELECT 1 AS x FROM login_flows WHERE id = ?', known.body.flow_id));
    assert.equal(h.mailer.last('eve@example.com').to, 'eve@example.com');
  } finally {
    await h.close();
  }
});

test('L-A: a loopback try-out accounts hub refuses proxy headers and a foreign Host, like dev and local', async () => {
  const h = await startAccounts();
  try {
    const port = new URL(h.base).port;
    const get = (headers) => new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path: '/api/health', headers }, (res) => { res.resume(); resolve(res.statusCode); });
      r.on('error', reject);
      r.end();
    });
    assert.equal(await get({}), 200);
    assert.equal(await get({ 'x-forwarded-for': '203.0.113.9' }), 403);
    assert.equal(await get({ 'cf-connecting-ip': '203.0.113.9' }), 403);
    assert.equal(await get({ host: 'buddy.example.com' }), 403);
    assert.equal(await h.upgradeStatus({ 'x-forwarded-for': '203.0.113.9' }), 403);
  } finally {
    await h.close();
  }
  const exposed = await startAccounts({ config: { publicUrl: 'https://buddy.example.com', trustCfIp: true, signinMethods: ['google'], accountsDev: false } });
  try {
    assert.equal((await exposed.call('GET', '/api/health', { headers: { 'cf-connecting-ip': '203.0.113.9' } })).status, 200, 'an exposed hub sits behind the tunnel');
  } finally {
    await exposed.close();
  }
});

test('M-B: node hub/admin.js delete-user / delete-team erase without a step-up; refuses off the hub host', async () => {
  const h = await startAccounts({ config: ROOMY });
  const config = h.app.config;
  const u = await h.signIn('zed@example.com');
  const t = await h.call('POST', '/api/teams', { token: u.body.device_token, body: { name: 'Zed Team' } });
  const other = await h.signIn('yan@example.com');
  const t2 = await h.call('POST', '/api/teams', { token: other.body.device_token, body: { name: 'Yan Team' } });
  await h.close();
  const out = [];
  const err = [];
  const io = { config, out: (s) => out.push(s), err: (s) => err.push(s) };
  try {
    assert.equal(runAdmin(['delete-team', t2.body.team.slug], io), 0, err.join('\n'));
    assert.equal(runAdmin(['delete-user', 'ZED@example.com'], io), 0, err.join('\n'));
    assert.equal(runAdmin(['delete-user', 'zed@example.com'], io), 1, 'already gone');
    assert.equal(runAdmin(['delete-team', 'no-such-team'], io), 1);
    assert.equal(runAdmin(['explode'], io), 2);
    assert.equal(runAdmin(['revoke-legacy-devices', 'extra'], io), 2);
    assert.equal(runAdmin(['delete-user', 'x@y.z'], { ...io, config: { ...config, auth: 'dev' } }), 2);
    assert.equal(runAdmin(['delete-user', 'x@y.z'], { ...io, config: { ...config, dbPath: `${config.dbPath}.missing` } }), 2);
    assert.match(err.at(-1), /run this on the hub host/);
    const db = openDb(config.dbPath);
    try {
      const user = db.get('SELECT * FROM users WHERE id = ?', u.body.user.id);
      assert.ok(user.deleted_at);
      assert.equal(user.primary_email, null);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM identities WHERE subject = 'zed@example.com'").n, 0);
      assert.ok(db.get('SELECT deleted_at FROM orgs WHERE id = ?', t.body.team.id).deleted_at, 'their sole-member team goes with them');
      assert.ok(db.get('SELECT deleted_at FROM orgs WHERE id = ?', t2.body.team.id).deleted_at);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM user_devices WHERE user_id = ? AND token_hash IS NOT NULL", u.body.user.id).n, 0);
      const audits = db.all("SELECT action, detail FROM audit WHERE action IN ('user.deleted', 'team.delete') ORDER BY rowid").map((r) => [r.action, JSON.parse(r.detail ?? '{}').by ?? null]);
      assert.deepEqual(audits.filter(([, by]) => by), [['team.delete', 'operator'], ['user.deleted', 'operator']]);
    } finally {
      db.close();
    }
    // The real entry point, with the hub's environment.
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../admin.js', import.meta.url)), 'delete-user', 'yan@example.com'], {
      env: { ...process.env, BOARD_AUTH: 'accounts', BOARD_ACCOUNTS_DEV: '1', BOARD_SECRET: config.secret, BOARD_DATA_DIR: config.dataDir, BOARD_DB: config.dbPath },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).deleted_user, other.body.user.id);
  } finally {
    rmSync(config.dataDir, { recursive: true, force: true });
  }
});

test('M-B: an accounts hub with users, no mailer and no OAuth method warns that deletion is unavailable', async () => {
  const h = await startAccounts({ config: ROOMY });
  await h.signIn('warn@example.com');
  const config = h.app.config;
  await h.close();
  const lines = [];
  const log = createLogger({ level: 'info', sink: (l) => lines.push(JSON.parse(l)) });
  // A configured OAuth provider (id + secret, D76) is a step-up; BOARD_SIGNIN_METHODS alone is not.
  const google = { googleClientId: 'id-x', googleClientSecret: ['sec', 'ret'].join('-') };
  for (const [mailer, cfg, expect] of [[null, {}, true], [outboxMailer(), {}, false], [null, { signinMethods: ['google'] }, true], [null, google, false]]) {
    lines.length = 0;
    const app = createApp({ ...config, ...cfg }, { log, github: fakeGitHub(), timers: false, mailer });
    await app.close({ graceMs: 0 });
    assert.equal(lines.some((l) => /deletion is unavailable/.test(l.msg) && /admin\.js delete-user/.test(l.msg)), expect, JSON.stringify(cfg));
  }
  rmSync(config.dataDir, { recursive: true, force: true });
});
