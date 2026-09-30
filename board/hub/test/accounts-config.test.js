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

const base = (over = {}) => ({ ...testConfig({ auth: 'accounts', devLoginSecret: null, accountsDev: true }), ...over });

test('accounts refuses to start without a secret, a public URL (loopback try-outs need BOARD_ACCOUNTS_DEV) or an https one off loopback', () => {
  assert.doesNotThrow(() => validateConfig(base()), 'loopback + dev flag, no URL, no mailer');
  assert.doesNotThrow(() => validateConfig(base({ publicUrl: 'http://127.0.0.1:8787', accountsDev: false })));
  assert.throws(() => validateConfig(base({ accountsDev: false })), /needs BOARD_PUBLIC_URL \(only a loopback bind with BOARD_ACCOUNTS_DEV=1/);
  assert.throws(() => validateConfig(base({ bind: '0.0.0.0' })), /needs BOARD_PUBLIC_URL|https BOARD_PUBLIC_URL/);
  assert.throws(() => validateConfig(base({ secret: null })), /needs BOARD_SECRET/);
  assert.throws(() => validateConfig(base({ bind: '0.0.0.0', publicUrl: 'http://buddy.example.com' })), /https BOARD_PUBLIC_URL/);
  assert.throws(() => validateConfig(base({ publicUrl: 'http://buddy.example.com' })), /must be https unless/);
  assert.throws(() => validateConfig(base({ resendApiKey: 're_x' })), /needs BOARD_MAIL_FROM/);
  assert.throws(() => validateConfig(base({ bind: '0.0.0.0', publicUrl: 'https://buddy.example.com', resendApiKey: 're_x', mailFrom: 'x@y.z', trustCfIp: true })), /BOARD_TRUST_CF_IP needs a loopback/);
  assert.throws(() => validateConfig(base({ bootstrap: 'alice,1,a@x.io' })), /BOARD_BOOTSTRAP=<email> only/);
  assert.throws(() => validateConfig(base({ signinMethods: ['myspace'] })), /BOARD_SIGNIN_METHODS takes google, github/);
  assert.throws(() => validateConfig(testConfig({ auth: 'dev', trustCfIp: true })), /unset BOARD_TRUST_CF_IP/);
  // The Resend key is scrubbed from the environment once read.
  const env = { BOARD_AUTH: 'accounts', BOARD_SECRET: 's'.repeat(40), BOARD_RESEND_API_KEY: 're_secret', BOARD_MAIL_FROM: 'a@b.co', BOARD_ACCOUNTS_DEV: '1' };
  assert.equal(loadConfig(env).resendApiKey, 're_secret');
  assert.equal(env.BOARD_RESEND_API_KEY, undefined);
  assert.deepEqual(loadConfig({ BOARD_AUTH: 'accounts', BOARD_SECRET: 's'.repeat(40), BOARD_PUBLIC_URL: 'https://b.example.com', BOARD_TRUST_CF_IP: '1', BOARD_SIGNIN_METHODS: 'google, github' }).signinMethods, ['google', 'github']);
});

test('H1/D66: an exposed accounts hub needs https, BOARD_TRUST_CF_IP and a sign-in method, never the console mailer; no Resend key needed', () => {
  const exposed = (over = {}) => base({ publicUrl: 'https://buddy.example.com', trustCfIp: true, signinMethods: ['google'], accountsDev: false, ...over });
  assert.doesNotThrow(() => validateConfig(exposed()), 'Google only, no mailer');
  assert.doesNotThrow(() => validateConfig(exposed({ signinMethods: [], resendApiKey: 're_x', mailFrom: 'a@b.co' })), 'a mailer is a sign-in method');
  assert.throws(() => validateConfig(exposed({ trustCfIp: false })), /needs BOARD_TRUST_CF_IP=1/);
  assert.throws(() => validateConfig(exposed({ signinMethods: [] })), /needs a sign-in method/);
  assert.throws(() => validateConfig(exposed({ consoleMailer: true })), /BOARD_CONSOLE_MAILER is for a loopback hub that is not exposed/);
  assert.throws(() => validateConfig(exposed({ bind: '0.0.0.0', trustCfIp: false })), /needs BOARD_TRUST_CF_IP=1/, 'a direct non-loopback bind is never enough');
  // A tunnel probe means exposed, even with a loopback URL (or none).
  assert.throws(() => validateConfig(base({ tunnelProbeUrl: 'https://buddy.example.com/api/health', signinMethods: ['github'], trustCfIp: true })), /needs an https BOARD_PUBLIC_URL/);
  assert.throws(() => validateConfig(base({ publicUrl: 'http://127.0.0.1:8787', tunnelProbeUrl: 'https://buddy.example.com/api/health', signinMethods: ['github'], trustCfIp: true })), /needs an https BOARD_PUBLIC_URL/);
  assert.doesNotThrow(() => validateConfig(exposed({ tunnelProbeUrl: 'https://buddy.example.com/api/health' })));
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
    h = await startAccounts({ mailer: null, config: { signinMethods: ['google'] } });
    const m = await h.call('GET', '/api/auth/methods');
    assert.equal(m.status, 200);
    assert.deepEqual(m.body, { google: true, github: false, email: false });
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
