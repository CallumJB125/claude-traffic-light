// Accounts mode: config refusals (D51), dev hardening (design §9.5), the
// mailers (D55) and the §14 data migration in 009 (D58).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { validateConfig, loadConfig } from '../config.js';
import { migrate, loadMigrations } from '../../shared/migrate.js';
import { resendMailer, createMailer, consoleMailer } from '../identity/mailer.js';
import { startHub, testConfig } from './helpers.js';
import { startAccounts } from './accounts-helpers.js';
import { sha256hex } from '../auth.js';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKey, loadPreviousKey } from '../vault.js';

const base = (over = {}) => ({ ...testConfig({ auth: 'accounts', devLoginSecret: null, accountsDev: true }), ...over });

test('browser OAuth needs paired web credentials and an exact configured origin; new secrets are private and scrubbed', () => {
  const credentials = { googleWebClientId: 'web-id', googleWebClientSecret: 'private-web-value' };
  for (const publicUrl of [null, 'https://b.acme.test/path', 'https://user@b.acme.test', 'https://b.acme.test?q=x', 'https://b.acme.test#fragment']) {
    assert.throws(() => validateConfig(base({ ...credentials, publicUrl, trustCfIp: true })), /origin-only/);
  }
  assert.throws(() => validateConfig(base({ googleWebClientId: 'web-id' })), /must both be set/);
  assert.doesNotThrow(() => validateConfig(base({ ...credentials, publicUrl: 'https://b.acme.test', trustCfIp: true, signinMethods: [] })), 'web-only exposed hub is usable without mailer/native credentials');
  const env = { BOARD_AUTH: 'accounts', BOARD_SECRET: 's'.repeat(40), BOARD_PUBLIC_URL: 'https://b.acme.test', BOARD_TRUST_CF_IP: '1', BOARD_GOOGLE_WEB_CLIENT_ID: 'web-id', BOARD_GOOGLE_WEB_CLIENT_SECRET: 'private-web-value' };
  const cfg = loadConfig(env);
  assert.equal(cfg.googleWebClientSecret, 'private-web-value'); assert.equal(cfg.googleWebClientId, 'web-id');
  assert.equal(env.BOARD_GOOGLE_WEB_CLIENT_SECRET, undefined);
  assert.ok(!JSON.stringify(cfg).includes('private-web-value'));
  assert.equal({ ...cfg }.googleWebClientSecret, undefined);
});

test('accounts refuses to start without a secret, a public URL (loopback try-outs need BOARD_ACCOUNTS_DEV) or an https one off loopback', () => {
  assert.doesNotThrow(() => validateConfig(base()), 'loopback + dev flag, no URL, no mailer');
  assert.doesNotThrow(() => validateConfig(base({ publicUrl: 'http://127.0.0.1:8787', accountsDev: false })));
  assert.throws(() => validateConfig(base({ accountsDev: false })), /needs BOARD_PUBLIC_URL \(only a loopback bind with BOARD_ACCOUNTS_DEV=1/);
  assert.throws(() => validateConfig(base({ bind: '0.0.0.0' })), /needs BOARD_PUBLIC_URL|https BOARD_PUBLIC_URL/);
  assert.throws(() => validateConfig(base({ secret: null })), /needs BOARD_SECRET/);
  assert.throws(() => validateConfig(base({ bind: '0.0.0.0', publicUrl: 'http://buddy.acme.test' })), /https BOARD_PUBLIC_URL/);
  assert.throws(() => validateConfig(base({ publicUrl: 'http://buddy.acme.test' })), /must be https unless/);
  assert.throws(() => validateConfig(base({ resendApiKey: 're_x' })), /needs BOARD_MAIL_FROM/);
  assert.throws(() => validateConfig(base({ bind: '0.0.0.0', publicUrl: 'https://buddy.acme.test', resendApiKey: 're_x', mailFrom: 'x@y.z', trustCfIp: true })), /BOARD_TRUST_CF_IP needs a loopback/);
  assert.throws(() => validateConfig(base({ bootstrap: 'alice,1,a@x.io' })), /BOARD_BOOTSTRAP=<email> only/);
  assert.throws(() => validateConfig(base({ signinMethods: ['myspace'] })), /BOARD_SIGNIN_METHODS takes google, github/);
  assert.throws(() => validateConfig(testConfig({ auth: 'dev', trustCfIp: true })), /unset BOARD_TRUST_CF_IP/);
  // The Resend key is scrubbed from the environment once read.
  const env = { BOARD_AUTH: 'accounts', BOARD_SECRET: 's'.repeat(40), BOARD_RESEND_API_KEY: 're_secret', BOARD_MAIL_FROM: 'a@b.co', BOARD_ACCOUNTS_DEV: '1' };
  assert.equal(loadConfig(env).resendApiKey, 're_secret');
  assert.equal(env.BOARD_RESEND_API_KEY, undefined);
  // So are the OAuth client secrets (D76).
  const oenv = { BOARD_AUTH: 'accounts', BOARD_SECRET: 's'.repeat(40), BOARD_ACCOUNTS_DEV: '1', BOARD_GOOGLE_CLIENT_ID: 'g-id', BOARD_GOOGLE_CLIENT_SECRET: 'g-sec', BOARD_GITHUB_CLIENT_ID: 'gh-id', BOARD_GITHUB_CLIENT_SECRET: 'gh-sec' };
  const oc = loadConfig(oenv);
  assert.deepEqual([oc.googleClientId, oc.googleClientSecret, oc.githubClientId, oc.githubClientSecret], ['g-id', 'g-sec', 'gh-id', 'gh-sec']);
  assert.equal(oenv.BOARD_GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(oenv.BOARD_GITHUB_CLIENT_SECRET, undefined);
  assert.deepEqual(loadConfig({ BOARD_AUTH: 'accounts', BOARD_SECRET: 's'.repeat(40), BOARD_PUBLIC_URL: 'https://b.acme.test', BOARD_TRUST_CF_IP: '1', BOARD_SIGNIN_METHODS: 'google, github' }).signinMethods, ['google', 'github']);
});

test('H1/D66: an exposed accounts hub needs https, BOARD_TRUST_CF_IP and a sign-in method, never the console mailer; no Resend key needed', () => {
  const exposed = (over = {}) => base({ publicUrl: 'https://buddy.acme.test', trustCfIp: true, signinMethods: ['google'], accountsDev: false, ...over });
  assert.doesNotThrow(() => validateConfig(exposed()), 'Google only, no mailer');
  assert.doesNotThrow(() => validateConfig(exposed({ signinMethods: [], resendApiKey: 're_x', mailFrom: 'a@b.co' })), 'a mailer is a sign-in method');
  // D76: a configured OAuth provider (client id AND secret) is a sign-in method: BOARD_SIGNIN_METHODS becomes optional.
  assert.doesNotThrow(() => validateConfig(exposed({ signinMethods: [], githubClientId: 'gh-id', githubClientSecret: ['s', 'x'].join('') })), 'GitHub configured');
  assert.throws(() => validateConfig(exposed({ signinMethods: [], githubClientId: 'gh-id' })), /needs a sign-in method/, 'an id without its secret is not a method');
  assert.throws(() => validateConfig(exposed({ trustCfIp: false })), /needs BOARD_TRUST_CF_IP=1/);
  assert.throws(() => validateConfig(exposed({ signinMethods: [] })), /needs a sign-in method/);
  assert.throws(() => validateConfig(exposed({ consoleMailer: true })), /BOARD_CONSOLE_MAILER is for a loopback hub that is not exposed/);
  assert.throws(() => validateConfig(exposed({ bind: '0.0.0.0', trustCfIp: false })), /needs BOARD_TRUST_CF_IP=1/, 'a direct non-loopback bind is never enough');
  // A tunnel probe means exposed, even with a loopback URL (or none).
  assert.throws(() => validateConfig(base({ tunnelProbeUrl: 'https://buddy.acme.test/api/health', signinMethods: ['github'], trustCfIp: true })), /needs an https BOARD_PUBLIC_URL/);
  assert.throws(() => validateConfig(base({ publicUrl: 'http://127.0.0.1:8787', tunnelProbeUrl: 'https://buddy.acme.test/api/health', signinMethods: ['github'], trustCfIp: true })), /needs an https BOARD_PUBLIC_URL/);
  assert.doesNotThrow(() => validateConfig(exposed({ tunnelProbeUrl: 'https://buddy.acme.test/api/health' })));
  // The console mailer: loopback and not exposed only; never picked when exposed.
  assert.doesNotThrow(() => validateConfig(base({ consoleMailer: true })));
  assert.equal(createMailer(base({ consoleMailer: true })).kind, 'console');
  assert.equal(createMailer(base()), null, 'no mailer configured: none');
  assert.equal(createMailer({ ...exposed(), consoleMailer: true }), null, 'an exposed config never gets the console mailer, even unvalidated');
  assert.equal(createMailer(exposed({ resendApiKey: 're_x', mailFrom: 'a@b.co' })).kind, 'resend');
});

test('D66: no mailer: email sign-in is 404 METHOD_DISABLED and silent, methods says so, invites return link + code and send nothing', async () => {
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (c, ...a) => { writes.push(String(c)); return orig.call(process.stderr, c, ...a); };
  let h;
  try {
    // D76: methods reports the providers with a client id AND secret; BOARD_SIGNIN_METHODS alone turns none on.
    h = await startAccounts({ mailer: null, config: { signinMethods: ['google'], googleClientId: 'id-x', googleClientSecret: ['sec', 'ret'].join('-') } });
    const m = await h.call('GET', '/api/auth/methods');
    assert.equal(m.status, 200);
    assert.deepEqual(m.body, { google: true, github: false, email: false, web: { google: false, github: false } });
    const s = await h.start('alice@dev.local');
    assert.equal(s.status, 404);
    assert.equal(s.body.error.code, 'METHOD_DISABLED');
    const v = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: 'x', code: '123456' } });
    assert.equal(v.body.error.code, 'METHOD_DISABLED');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM login_flows').n, 0, 'nothing written');
    assert.ok(!writes.join('').includes('sign-in code'), 'nothing on stderr');

    // An admin signed in some other way (OAuth, later) invites: link + code once, no mail.
    const alice = h.db.get("SELECT * FROM members WHERE github_login = 'alice'");
    const now = h.hub.iso();
    const uid = 'u-alice';
    h.db.insert('users', { id: uid, display_name: 'Alice', primary_email: 'alice@dev.local', primary_email_verified_at: now, created_at: now });
    h.db.run('UPDATE members SET user_id = ?, email = ? WHERE id = ?', uid, 'alice@dev.local', alice.id);
    h.db.insert('user_devices', { id: 'd-alice', user_id: uid, name: 'Mac', client: 'buddy_desktop', token_hash: sha256hex('bdt_alice'), created_at: now });
    const inv = await h.call('POST', `/api/teams/${h.ids.org}/invites`, { token: 'bdt_alice', headers: { origin: h.base }, body: { email: 'New@Example.com', role: 'member' } });
    assert.equal(inv.status, 200, inv.text);
    assert.match(inv.body.link, /\/invite#inv_[A-Za-z0-9_-]{43}$/);
    assert.match(inv.body.code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    assert.equal(inv.body.mailed, false);
    const again = await h.call('POST', `/api/teams/${h.ids.org}/invites/${inv.body.invite.id}/resend`, { token: 'bdt_alice', headers: { origin: h.base }, body: {} });
    assert.equal(again.status, 200, again.text);
    assert.notEqual(again.body.link, inv.body.link);
    assert.notEqual(again.body.code, undefined);
    assert.equal(again.body.mailed, false);
    assert.equal((await h.call('POST', '/api/invites/preview', { body: { t: again.body.link.split('#')[1] } })).status, 200);
    assert.equal(h.mailer, null);
  } finally {
    process.stderr.write = orig;
    await h?.close();
  }
});

test('dev login exists only in dev mode (not registered under access or accounts)', async () => {
  const acc = await startAccounts();
  try {
    const r = await acc.call('POST', '/api/dev/login', { body: { github_login: 'alice' } });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.message, 'no such route');
  } finally {
    await acc.close();
  }
  const dev = await startHub();
  try {
    const r = await fetch(`${dev.base}/api/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...dev.devHeaders }, body: JSON.stringify({ github_login: 'alice' }) });
    assert.equal(r.status, 200);
    assert.equal((await fetch(`${dev.base}/invite`)).status, 404, 'accounts pages only in accounts mode');
    assert.equal((await fetch(`${dev.base}/api/account`)).status, 404);
  } finally {
    await dev.close();
  }
});

test('Resend mailer: one POST to the emails endpoint with Bearer key, idempotency key and plain text; errors throw', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); };
  const m = resendMailer({ apiKey: 're_test', from: 'Buddy <signin@mail.example.com>', fetchImpl });
  assert.deepEqual(await m.send({ to: 'a@b.co', subject: 'S', text: 'T', idempotencyKey: 'flow1' }), { id: 'em_1' });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer re_test');
  assert.equal(calls[0].init.headers['idempotency-key'], 'flow1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'Buddy <signin@mail.example.com>', to: ['a@b.co'], subject: 'S', text: 'T' });
  const failing = resendMailer({ apiKey: 'k', from: 'f', fetchImpl: async () => new Response('{}', { status: 422 }) });
  await assert.rejects(failing.send({ to: 'a@b.co', subject: 'S', text: 'T' }), /Resend answered 422/);
  assert.equal(createMailer({ resendApiKey: 'k', mailFrom: 'f' }, { fetchImpl }).kind, 'resend');
  assert.equal(createMailer({}), null);
  assert.equal(createMailer({ consoleMailer: true }).kind, 'console');
  let out = '';
  await consoleMailer({ write: (s) => { out += s; } }).send({ to: 'a@b.co', subject: 'S', text: 'code: 123456' });
  assert.match(out, /To: a@b\.co[\s\S]*code: 123456/);
});

test('009 migrates Access-era members: one verified user per email, rows linked, GitHub ids kept, slugs made', () => {
  const db = new DatabaseSync(':memory:');
  const all = loadMigrations();
  migrate(db, { migrations: all.filter((m) => m.version <= 6) });
  const NOW = '2026-09-30T10:00:00.000Z';
  db.exec(`
    INSERT INTO orgs (id, name, created_at) VALUES ('o1','Acme Team','${NOW}'), ('o2','Acme Team','${NOW}'), ('o3','Ünïcode!','${NOW}');
    INSERT INTO members (id, org_id, github_id, github_login, email, display_name, role, created_at) VALUES
      ('m1','o1',101,'callum','Callum@X.io','Callum','owner','2026-01-01T00:00:00.000Z'),
      ('m2','o2',101,'callum','callum@x.io','Callum B','admin','2026-02-01T00:00:00.000Z'),
      ('m3','o1',-5,'email:jo@x.io','jo@x.io','Jo','member','${NOW}'),
      ('m4','o1',202,'noemail',NULL,'No Email','member','${NOW}');
    INSERT INTO devices (id, member_id, name, kind, token_hash, created_at) VALUES ('d1','m1','Mac','runner','h1','${NOW}');
  `);
  migrate(db, { migrations: all });
  const users = db.prepare('SELECT * FROM users ORDER BY primary_email').all();
  assert.deepEqual(users.map((u) => [u.primary_email, u.display_name, !!u.primary_email_verified_at]), [['callum@x.io', 'Callum B', true], ['jo@x.io', 'Jo', true]]);
  const uid = (e) => users.find((u) => u.primary_email === e).id;
  const link = Object.fromEntries(db.prepare('SELECT id, user_id FROM members').all().map((r) => [r.id, r.user_id]));
  assert.deepEqual(link, { m1: uid('callum@x.io'), m2: uid('callum@x.io'), m3: uid('jo@x.io'), m4: null });
  const ids = db.prepare('SELECT provider, subject, user_id, email_verified FROM identities ORDER BY provider, subject').all().map((r) => ({ ...r }));
  assert.deepEqual(ids, [
    { provider: 'email', subject: 'callum@x.io', user_id: uid('callum@x.io'), email_verified: 1 },
    { provider: 'email', subject: 'jo@x.io', user_id: uid('jo@x.io'), email_verified: 1 },
    { provider: 'github', subject: '101', user_id: uid('callum@x.io'), email_verified: 0 },
  ]);
  const slugs = db.prepare('SELECT id, slug FROM orgs ORDER BY id').all().map((r) => r.slug);
  assert.equal(slugs[0], 'acme-team');
  assert.match(slugs[1], /^acme-team-o2$/);
  assert.match(slugs[2], /^team-o3$/);
  assert.equal(db.prepare("SELECT v FROM hub_meta WHERE k = 'session_epoch'").get().v, '1');
  assert.equal(db.prepare("SELECT member_id FROM devices WHERE id = 'd1'").get().member_id, 'm1', 'existing rows untouched');
});

test('007–012 in order: a fresh DB and a populated 006 DB end with every xteam trigger; 008 is refused after 012', () => {
  const all = loadMigrations();
  const triggers = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'xteam_%' ORDER BY name").all().map((r) => r.name);
  const shipped = [...all.flatMap((m) => [...m.sql.matchAll(/CREATE TRIGGER (?:IF NOT EXISTS )?(xteam_\w+)/g)].map((x) => x[1]))];
  const want = [...new Set(shipped)].sort();
  assert.ok(want.includes('xteam_comments_ins') && want.includes('xteam_invites_ins'));

  const fresh = new DatabaseSync(':memory:');
  migrate(fresh, { migrations: all });
  assert.deepEqual(fresh.prepare('SELECT version FROM schema_migrations WHERE version >= 7 ORDER BY version').all().map((r) => r.version), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 22, 23, 25, 26, 28, 29, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 42]);
  assert.deepEqual(triggers(fresh), want);
  fresh.close();

  const old = new DatabaseSync(':memory:');
  migrate(old, { migrations: all.filter((m) => m.version <= 6) });
  const NOW = '2026-09-30T10:00:00.000Z';
  old.exec(`
    INSERT INTO orgs (id, name, created_at) VALUES ('o1','Acme','${NOW}');
    INSERT INTO members (id, org_id, github_id, github_login, email, display_name, role, created_at) VALUES ('m1','o1',101,'callum','c@x.io','Callum','owner','${NOW}');
    INSERT INTO boards (id, org_id, name, key_prefix) VALUES ('b1','o1','Board','BRD');
    INSERT INTO cards (id, board_id, key, title, created_by, created_at, updated_at) VALUES ('c1','b1','BRD-1','Card','m1','${NOW}','${NOW}');
    INSERT INTO comments (id, card_id, author_member_id, source, trusted, body, created_at) VALUES ('k1','c1','m1','web',1,'hi','${NOW}');
    INSERT INTO journal (board_id, card_id, at_hub, actor_kind, actor_id, kind) VALUES ('b1','c1','${NOW}','member','m1','card.create');
  `);
  assert.deepEqual(migrate(old, { migrations: all }), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 22, 23, 25, 26, 28, 29, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 42]);
  assert.deepEqual(triggers(old), want);
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 1);
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM journal').get().n, 1);
  old.close();

  // Accounts first (a DB that skipped the integrations merge): the rebuild in 008 must not run.
  // 017, 022, 023, 025, 026 and 029 need 008's tables, so that DB skips them (018 and 019 don't).
  const skipped = new DatabaseSync(':memory:');
  migrate(skipped, { migrations: all.filter((m) => m.version !== 7 && m.version !== 8 && m.version !== 17 && m.version !== 22 && m.version !== 23 && m.version !== 25 && m.version !== 26 && m.version !== 29) });
  assert.throws(() => migrate(skipped, { migrations: all }), /008_integrations rebuilds tables and cannot be applied after version 42/);
  assert.equal(skipped.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 8').get().n, 0);
  const from017 = [17, 22].flatMap((v) => [...all.find((m) => m.version === v).sql.matchAll(/CREATE TRIGGER (xteam_\w+)/g)].map((x) => x[1]));
  assert.deepEqual(triggers(skipped), want.filter((t) => !from017.includes(t)));
  skipped.close();
});

test('migrate refuses a DB whose applied version carries another name (the branch-era 014_integration_requests) and applies nothing', () => {
  const all = loadMigrations();
  const db = new DatabaseSync(':memory:');
  migrate(db, { migrations: all.filter((m) => m.version <= 13) });
  const branch = { ...all.find((m) => m.version === 17), version: 14 };
  migrate(db, { migrations: [...all.filter((m) => m.version <= 13), branch] });
  assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version = 14').get().name, 'integration_requests');
  assert.throws(() => migrate(db, { migrations: all }), /migration 014 was applied as 014_integration_requests but this hub ships 014_oauth/);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 14, 'nothing applied');
  db.close();
});

test('017: a connection cannot link, audit or record a card of another team', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const NOW = '2026-09-30T10:00:00.000Z';
  db.exec(`
    INSERT INTO orgs (id, name, created_at) VALUES ('oa','A','${NOW}'), ('ob','B','${NOW}');
    INSERT INTO members (id, org_id, github_id, github_login, email, display_name, role, created_at) VALUES ('ma','oa',1,'a','a@x.io','A','owner','${NOW}'), ('mb','ob',2,'b','b@x.io','B','owner','${NOW}');
    INSERT INTO boards (id, org_id, name, key_prefix) VALUES ('ba','oa','A','AAA'), ('bb','ob','B','BBB');
    INSERT INTO cards (id, board_id, key, title, created_by, created_at, updated_at) VALUES ('ca','ba','AAA-1','a','ma','${NOW}','${NOW}'), ('cb','bb','BBB-1','b','mb','${NOW}','${NOW}');
    INSERT INTO connections (id, org_id, provider, external_id, created_by, created_at) VALUES ('ka','oa','github','1','ma','${NOW}');
  `);
  const bad = {
    'link to a B card': `INSERT INTO external_links (card_id, connection_id, kind, external_id, created_at) VALUES ('cb','ka','pr','1','${NOW}')`,
    'audit row on a B card': `INSERT INTO integration_audit (id, connection_id, action, decision, card_id, at) VALUES ('x1','ka','card.link','auto','cb','${NOW}')`,
    'request for a B card': `INSERT INTO integration_requests (connection_id, request_id, card_id, created_at) VALUES ('ka','r1','cb','${NOW}')`,
  };
  for (const [name, sql] of Object.entries(bad)) assert.throws(() => db.exec(sql), /cross-team reference/, name);
  db.exec(`
    INSERT INTO external_links (card_id, connection_id, kind, external_id, created_at) VALUES ('ca','ka','pr','1','${NOW}');
    INSERT INTO integration_audit (id, connection_id, action, decision, card_id, at) VALUES ('x2','ka','card.link','auto','ca','${NOW}'), ('x3','ka','notify.post','auto',NULL,'${NOW}');
    INSERT INTO integration_requests (connection_id, request_id, card_id, created_at) VALUES ('ka','r2','ca','${NOW}');
  `);
  const moves = {
    'link moved to a B card': "UPDATE external_links SET card_id = 'cb'",
    'audit moved to a B card': "UPDATE integration_audit SET card_id = 'cb' WHERE id = 'x2'",
    'request moved to a B card': "UPDATE integration_requests SET card_id = 'cb'",
  };
  for (const [name, sql] of Object.entries(moves)) assert.throws(() => db.exec(sql), /cross-team reference/, name);
  db.close();
});

test('018/019 apply on a populated DB at 017 and on a fresh DB; labels, covers and archive keep their CHECKs and cross-team triggers', () => {
  const all = loadMigrations();
  const NOW = '2026-09-30T10:00:00.000Z';
  const at17 = new DatabaseSync(':memory:');
  migrate(at17, { migrations: all.filter((m) => m.version <= 17) });
  at17.exec(`
    INSERT INTO orgs (id, name, created_at) VALUES ('oa','A','${NOW}'), ('ob','B','${NOW}');
    INSERT INTO members (id, org_id, github_id, github_login, email, display_name, role, created_at) VALUES ('ma','oa',1,'a','a@x.io','A','owner','${NOW}'), ('mb','ob',2,'b','b@x.io','B','owner','${NOW}');
    INSERT INTO boards (id, org_id, name, key_prefix) VALUES ('ba','oa','A','AAA'), ('bb','ob','B','BBB');
    INSERT INTO cards (id, board_id, key, title, labels, created_by, created_at, updated_at) VALUES ('ca','ba','AAA-1','a','["bug"]','ma','${NOW}','${NOW}');
  `);
  assert.deepEqual(migrate(at17, { migrations: all }), [18, 19, 22, 23, 25, 26, 28, 29, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 42]);
  assert.deepEqual({ ...at17.prepare('SELECT labels, cover, archived_at, archived_by FROM cards').get() }, { labels: '["bug"]', cover: null, archived_at: null, archived_by: null }, 'existing cards untouched');
  assert.deepEqual(at17.prepare('PRAGMA foreign_key_check').all(), []);
  const fresh = new DatabaseSync(':memory:');
  migrate(fresh, { migrations: all });
  const shape = (db) => db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name LIKE '%label%' OR name LIKE '%archived%' ORDER BY name").all().map((r) => ({ ...r }));
  assert.deepEqual(shape(at17), shape(fresh));
  fresh.close();

  const db = at17;
  const bad = {
    'label created by another team\'s member': `INSERT INTO board_labels (id, board_id, name, color, created_by, created_at, updated_at) VALUES ('l1','ba','x','red','mb','${NOW}','${NOW}')`,
    'colour outside the palette': `INSERT INTO board_labels (id, board_id, name, color, created_by, created_at, updated_at) VALUES ('l2','ba','x','magenta','ma','${NOW}','${NOW}')`,
    'empty name': `INSERT INTO board_labels (id, board_id, name, color, created_by, created_at, updated_at) VALUES ('l3','ba','','red','ma','${NOW}','${NOW}')`,
    'cover outside the palette': "UPDATE cards SET cover = 'magenta' WHERE id = 'ca'",
    'archived by another team\'s member': "UPDATE cards SET archived_at = '2026', archived_by = 'mb' WHERE id = 'ca'",
    'a new card archived by another team\'s member': `INSERT INTO cards (id, board_id, key, title, created_by, created_at, updated_at, archived_by) VALUES ('cx','ba','AAA-9','x','ma','${NOW}','${NOW}','mb')`,
  };
  for (const [name, sql] of Object.entries(bad)) assert.throws(() => db.exec(sql), /cross-team reference|CHECK constraint/, name);
  db.exec(`INSERT INTO board_labels (id, board_id, name, color, created_by, created_at, updated_at) VALUES ('l4','ba','Bug','red','ma','${NOW}','${NOW}')`);
  assert.throws(() => db.exec(`INSERT INTO board_labels (id, board_id, name, color, created_by, created_at, updated_at) VALUES ('l5','ba','BUG','blue','ma','${NOW}','${NOW}')`), /UNIQUE/, 'names are unique ignoring case');
  assert.throws(() => db.exec("UPDATE board_labels SET created_by = 'mb'"), /cross-team reference/);
  assert.throws(() => db.exec("UPDATE board_labels SET board_id = 'bb'"), /cross-team reference/);
  db.exec("UPDATE cards SET cover = 'teal', archived_at = '2026-09-30T10:00:00.000Z', archived_by = 'ma' WHERE id = 'ca'");
  db.close();
});

test('022 applies at 019 with 020/021 absent (an intentional gap, reserved for S2b/S2c); a later 020/021 still applies after it', () => {
  const all = loadMigrations();
  assert.deepEqual(all.filter((m) => m.version > 19).map((m) => m.version), [22, 23, 25, 26, 28, 29, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 42], '020, 021, 024, 027, 030, 039 are reserved, not shipped here');
  const NOW = '2026-09-30T10:00:00.000Z';
  const db = new DatabaseSync(':memory:');
  migrate(db, { migrations: all.filter((m) => m.version <= 19) });
  db.exec(`
    INSERT INTO orgs (id, name, created_at) VALUES ('oa','A','${NOW}'), ('ob','B','${NOW}');
    INSERT INTO members (id, org_id, github_id, github_login, email, display_name, role, created_at) VALUES ('ma','oa',1,'a','a@x.io','A','owner','${NOW}'), ('mb','ob',2,'b','b@x.io','B','owner','${NOW}');
    INSERT INTO connections (id, org_id, provider, external_id, created_by, created_at, settings) VALUES ('ka','oa','slack','T1','ma','${NOW}','{"pinned":{"app_id":"A1"}}');
  `);
  assert.deepEqual(migrate(db, { migrations: all }), [22, 23, 25, 26, 28, 29, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 42]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const pend = (id, org = 'oa', member = 'ma') => db.prepare("INSERT INTO integration_pending (id, org_id, provider, created_by, created_at, expires_at) VALUES (?, ?, 'slack', ?, ?, ?)").run(id, org, member, NOW, '2026-09-30T11:00:00.000Z');
  assert.throws(() => pend('p0', 'oa', 'mb'), /cross-team reference/);
  assert.throws(() => pend('ka'), /is a connection/);
  pend('p1');
  assert.throws(() => pend('p2'), /UNIQUE/, 'one per (org, provider)');
  assert.throws(() => db.exec("INSERT INTO connections (id, org_id, provider, external_id, created_by, created_at) VALUES ('p1','oa','slack','T2','ma','" + NOW + "')"), /is still pending/);
  assert.throws(() => db.exec("UPDATE integration_pending SET expires_at = '2099-01-01T00:00:00.000Z'"), /fixed/);
  db.exec("UPDATE integration_pending SET match = '{\"app_id\":\"A2\"}', authorize_count = 1");
  db.exec(`INSERT INTO integration_pending_secrets (pending_id, kind, key_id, nonce, ciphertext, created_at) VALUES ('p1','client_secret','k',x'00',x'00','${NOW}')`);
  db.exec("DELETE FROM integration_pending WHERE id = 'p1'");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM integration_pending_secrets').get().n, 0);
  assert.throws(() => db.exec(`UPDATE connections SET settings = '{"pinned":{"app_id":"A9"}}' WHERE id = 'ka'`), /pinned/);
  db.exec(`UPDATE connections SET settings = '{"pinned":{"app_id":"A1"},"autonomy":{}}' WHERE id = 'ka'`);
  // A reserved number landing later still applies (D50: gaps are filled).
  const late = { version: 20, name: 'reserved_later', sql: 'CREATE TABLE _late (a INTEGER);' };
  assert.deepEqual(migrate(db, { migrations: [...all, late].sort((a, b) => a.version - b.version) }), [20]);
  db.close();
});

// Placeholders left in from hub.env.example (production cutover review): a
// hub that would sign with a published secret, link to a reserved host or
// admit an example domain refuses to start, and never says the value.
const realSecret = () => randomBytes(48).toString('base64');
const WORDS = ['change' + '-me', 'replace' + '-with', 'exam' + 'ple', 'place' + 'holder'];

test('accounts refuses a BOARD_SECRET that is still a placeholder, with a fixed text that never repeats it', () => {
  const priv = `q${randomBytes(6).toString('hex')}`;
  for (const w of WORDS) {
    for (const secret of [`${w}-${priv}-${'z'.repeat(32)}`, `${priv}${w.toUpperCase()}${'z'.repeat(32)}`]) {
      assert.throws(() => validateConfig(base({ secret })), (e) => e.message === 'BOARD_SECRET still has its example placeholder: set a real secret (openssl rand -base64 48)' && !e.message.includes(priv), secret.slice(0, 20));
      assert.throws(() => loadConfig({ BOARD_AUTH: 'accounts', BOARD_SECRET: secret, BOARD_ACCOUNTS_DEV: '1' }), (e) => !e.message.includes(priv));
    }
  }
  for (let i = 0; i < 20; i++) assert.doesNotThrow(() => validateConfig(base({ secret: realSecret() })), 'a random secret');
  // Dev mode is a loopback try-out: unchanged.
  assert.doesNotThrow(() => validateConfig(testConfig({ auth: 'dev', secret: `${WORDS[0]}-${'z'.repeat(40)}` })));
});

test('accounts refuses an example.com/.org/.net BOARD_PUBLIC_URL and BOARD_SIGNUP_ALLOW entries on those domains', () => {
  const exposed = (over = {}) => base({ publicUrl: 'https://buddy.acme.test', trustCfIp: true, signinMethods: ['google'], accountsDev: false, ...over });
  assert.doesNotThrow(() => validateConfig(exposed()));
  const ex = (tld) => ['exam', 'ple.', tld].join('');
  for (const host of [ex('com'), ex('org'), ex('net'), `app.${ex('com')}`, `a.b.${ex('org')}`, `x.${ex('net')}`, ex('COM')]) {
    assert.throws(() => validateConfig(exposed({ publicUrl: `https://${host}` })), (e) => e.message === 'BOARD_PUBLIC_URL still names an example host: set the address people reach this hub at' && !e.message.includes(host.toLowerCase()), host);
  }
  for (const host of [`${ex('com')}.acme.test`, `my${ex('com')}`, 'example.io']) {
    assert.doesNotThrow(() => validateConfig(exposed({ publicUrl: `https://${host}` })), `${host} is not a reserved example host`);
  }
  for (const entry of [`domain:${ex('com')}`, `email:someone@${ex('org')}`, `domain:sub.${ex('net')}`, `email:a@b.${ex('com')}`, `DOMAIN:${ex('COM')}`]) {
    assert.throws(() => validateConfig(exposed({ signupAllow: `domain:acme.test,${entry}` })), (e) => e.message === 'BOARD_SIGNUP_ALLOW still has an example.com/.org/.net entry: list your own domains and addresses' && !e.message.includes('acme'), entry);
  }
  assert.doesNotThrow(() => validateConfig(exposed({ signupAllow: `domain:acme.test,email:a@my${ex('com')}` })));
  // Outside accounts mode nothing changes.
  assert.doesNotThrow(() => validateConfig(testConfig({ auth: 'access', accessTeam: 't', accessAud: 'a', publicUrl: `https://${ex('com')}` })));
});

test('BOARD_ENC_KEY / BOARD_ENC_KEY_FILE text that still has a placeholder word is refused in accounts mode, even when it decodes to 32 bytes', () => {
  // 43 base64 characters and '=': 32 bytes, so only the words give it away.
  const b64 = (w) => `${w}${'A'.repeat(43 - w.length)}=`;
  const dir = mkdtempSync(join(tmpdir(), 'enckey-'));
  for (const w of WORDS) {
    const text = /^[A-Za-z]+$/.test(w) ? b64(w) : `${w}-${'a'.repeat(30)}`;
    assert.throws(() => loadKey({ env: { BOARD_ENC_KEY: text }, hasParentPort: false, refusePlaceholder: true }), (e) => e.message === 'BOARD_ENC_KEY still has an example placeholder: set a real key (openssl rand -base64 32)' && !e.message.includes(text), w);
    const f = join(dir, `${w}.key`);
    writeFileSync(f, `${text}\n`, { mode: 0o600 });
    assert.throws(() => loadKey({ env: { BOARD_ENC_KEY_FILE: f }, hasParentPort: false, refusePlaceholder: true }), (e) => e.message === 'BOARD_ENC_KEY_FILE still holds an example placeholder: set a real key (openssl rand -base64 32)', w);
  }
  // The same 32-byte text outside accounts mode decodes as before.
  assert.equal(loadKey({ env: { BOARD_ENC_KEY: b64(WORDS[2]) }, hasParentPort: false }).length, 32);
  for (let i = 0; i < 20; i++) {
    const k = randomBytes(32).toString(i % 2 ? 'hex' : 'base64');
    assert.equal(loadKey({ env: { BOARD_ENC_KEY: k }, hasParentPort: false, refusePlaceholder: true }).length, 32, 'a random key');
  }
});

test('accounts refuses a placeholder in every secret-ish variable that is set (the deploy kit\'s own values included), naming the variable, never the value', () => {
  const hex = (n) => randomBytes(n).toString('hex');
  const base64 = (n) => randomBytes(n).toString('base64');
  const envFor = (over = {}) => ({ BOARD_AUTH: 'accounts', BOARD_SECRET: base64(48), BOARD_ACCOUNTS_DEV: '1', ...over });
  const ses = { BOARD_MAIL_PROVIDER: 'ses', BOARD_SES_REGION: 'af-south-1', BOARD_SES_ACCESS_KEY_ID: hex(10).toUpperCase(), BOARD_SES_SECRET_ACCESS_KEY: base64(30), BOARD_MAIL_FROM: 'a@b.co' };
  const cases = {
    BOARD_SES_ACCESS_KEY_ID: ses,
    BOARD_SES_SECRET_ACCESS_KEY: ses,
    BOARD_SES_SESSION_TOKEN: ses,
    BOARD_RESEND_API_KEY: { BOARD_MAIL_FROM: 'a@b.co' },
    BOARD_GOOGLE_CLIENT_SECRET: { BOARD_GOOGLE_CLIENT_ID: 'g-id' },
    BOARD_GITHUB_CLIENT_SECRET: { BOARD_GITHUB_CLIENT_ID: 'gh-id' },
    BOARD_GITHUB_TOKEN: {},
  };
  const priv = hex(5).toUpperCase();
  for (const [name, extra] of Object.entries(cases)) {
    // The real thing passes; each placeholder word refuses it.
    assert.doesNotThrow(() => loadConfig(envFor({ ...extra, [name]: name === 'BOARD_SES_ACCESS_KEY_ID' ? hex(10).toUpperCase() : base64(30) })), `${name}: a real-looking value`);
    for (const w of WORDS) {
      const value = `${w}-${priv}`;
      assert.throws(() => loadConfig(envFor({ ...extra, [name]: value })), (e) => e.message === `${name} still has an example placeholder: set the real value` && !e.message.includes(priv), `${name} ${w}`);
    }
  }
  // AWS's documentation key id shape passes the format check, not this one.
  assert.throws(() => loadConfig(envFor({ ...ses, BOARD_SES_ACCESS_KEY_ID: `${priv}EXAM${'PLE'}` })), (e) => e.message === 'BOARD_SES_ACCESS_KEY_ID still has an example placeholder: set the real value');
  // Exactly what hub.env.example ships with.
  const kit = { BOARD_SECRET: `${WORDS[0]}-openssl-rand-base64-48-before-first-start` };
  assert.equal(kit.BOARD_SECRET.length, 51);
  assert.throws(() => loadConfig(envFor(kit)), /^Error: BOARD_SECRET still has its example placeholder/);
  assert.throws(() => loadConfig(envFor({ ...ses, BOARD_SES_SECRET_ACCESS_KEY: WORDS[0] })), /^Error: BOARD_SES_SECRET_ACCESS_KEY still has an example placeholder/);
  assert.throws(() => loadConfig(envFor({ BOARD_PUBLIC_URL: `https://app.${['exam', 'ple.com'].join('')}`, BOARD_TRUST_CF_IP: '1', BOARD_SIGNIN_METHODS: 'google' })), /^Error: BOARD_PUBLIC_URL still names an example host/);
  assert.throws(() => loadConfig(envFor({ BOARD_SIGNUP_ALLOW: `domain:${['exam', 'ple.com'].join('')}` })), /^Error: BOARD_SIGNUP_ALLOW still has an example/);
  // Other modes read none of these as accounts secrets: unchanged.
  assert.doesNotThrow(() => loadConfig({ BOARD_AUTH: 'dev', BOARD_GITHUB_TOKEN: `${WORDS[0]}-x` }));
  // The previous encryption key too.
  assert.throws(() => loadPreviousKey({ env: { BOARD_ENC_KEY_PREVIOUS: `${WORDS[3]}${'A'.repeat(32)}=` }, hasParentPort: false, refusePlaceholder: true }), (e) => e.message === 'BOARD_ENC_KEY_PREVIOUS still has an example placeholder: set a real key (openssl rand -base64 32)');
  assert.equal(loadPreviousKey({ env: { BOARD_ENC_KEY_PREVIOUS: base64(32) }, hasParentPort: false, refusePlaceholder: true }).length, 32);
});

test('app: an accounts hub refuses a placeholder BOARD_ENC_KEY / BOARD_ENC_KEY_PREVIOUS at start; a dev hub takes the same 32 bytes', async () => {
  const text = `${WORDS[2]}${'A'.repeat(43 - WORDS[2].length)}=`;
  for (const name of ['BOARD_ENC_KEY', 'BOARD_ENC_KEY_PREVIOUS']) {
    try {
      if (name === 'BOARD_ENC_KEY_PREVIOUS') process.env.BOARD_ENC_KEY = randomBytes(32).toString('hex');
      process.env[name] = text;
      const started = await startAccounts().catch((e) => e);
      if (!(started instanceof Error)) await started.close();
      assert.equal(started?.message, `${name} still has an example placeholder: set a real key (openssl rand -base64 32)`);
      if (name === 'BOARD_ENC_KEY_PREVIOUS') process.env.BOARD_ENC_KEY = randomBytes(32).toString('hex');
      process.env[name] = text;
      const dev = await startHub();
      await dev.close();
    } finally {
      delete process.env.BOARD_ENC_KEY;
      delete process.env.BOARD_ENC_KEY_PREVIOUS;
    }
  }
});

test('BOARD_SECRET and BOARD_SIGNUP_ALLOW leave process.env once read and never show in a dump of the config; a plain env object is left alone', async () => {
  const { inspect } = await import('node:util');
  const secret = randomBytes(48).toString('base64');
  const allow = `domain:${randomBytes(4).toString('hex')}.test`;
  const keep = { ...process.env };
  try {
    Object.assign(process.env, { BOARD_AUTH: 'accounts', BOARD_SECRET: secret, BOARD_SIGNUP_ALLOW: allow, BOARD_ACCOUNTS_DEV: '1' });
    const cfg = loadConfig(process.env);
    assert.equal(process.env.BOARD_SECRET, undefined);
    assert.equal(process.env.BOARD_SIGNUP_ALLOW, undefined);
    assert.equal(cfg.secret, secret);
    assert.equal(cfg.signupAllow, allow);
    const dumps = [JSON.stringify(cfg), inspect(cfg), JSON.stringify({ ...cfg }), Object.keys(cfg).join(',')].join('\n');
    assert.ok(!dumps.includes(secret) && !dumps.includes(allow), 'not in a dump');
    assert.ok(!Object.keys(cfg).includes('secret') && !Object.keys(cfg).includes('signupAllow'));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
  // Pure for any other env object: it reads from it and deletes nothing from it.
  const env = { BOARD_AUTH: 'accounts', BOARD_SECRET: secret, BOARD_SIGNUP_ALLOW: allow, BOARD_ACCOUNTS_DEV: '1' };
  assert.equal(loadConfig(env).secret, secret);
  assert.equal(env.BOARD_SECRET, secret);
  assert.equal(env.BOARD_SIGNUP_ALLOW, allow);
});
