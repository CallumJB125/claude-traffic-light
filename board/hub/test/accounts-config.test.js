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

const base = (over = {}) => ({ ...testConfig({ auth: 'accounts', devLoginSecret: null }), ...over });

test('accounts refuses to start without a secret, an https public URL (off loopback) or a real mailer', () => {
  assert.doesNotThrow(() => validateConfig(base()), 'loopback, no URL, console mailer');
  assert.doesNotThrow(() => validateConfig(base({ publicUrl: 'http://127.0.0.1:8787' })));
  assert.throws(() => validateConfig(base({ secret: null })), /needs BOARD_SECRET/);
  assert.throws(() => validateConfig(base({ bind: '0.0.0.0' })), /https BOARD_PUBLIC_URL/);
  assert.throws(() => validateConfig(base({ bind: '0.0.0.0', publicUrl: 'http://buddy.example.com' })), /https BOARD_PUBLIC_URL/);
  assert.throws(() => validateConfig(base({ publicUrl: 'http://buddy.example.com' })), /must be https unless/);
  assert.throws(() => validateConfig(base({ bind: '0.0.0.0', publicUrl: 'https://buddy.example.com' })), /BOARD_RESEND_API_KEY/);
  assert.throws(() => validateConfig(base({ resendApiKey: 're_x' })), /needs BOARD_MAIL_FROM/);
  assert.doesNotThrow(() => validateConfig(base({ bind: '0.0.0.0', publicUrl: 'https://buddy.example.com', resendApiKey: 're_x', mailFrom: 'Buddy <signin@mail.example.com>' })));
  assert.throws(() => validateConfig(base({ bind: '0.0.0.0', publicUrl: 'https://buddy.example.com', resendApiKey: 're_x', mailFrom: 'x@y.z', trustCfIp: true })), /BOARD_TRUST_CF_IP needs a loopback/);
  assert.throws(() => validateConfig(base({ bootstrap: 'alice,1,a@x.io' })), /BOARD_BOOTSTRAP=<email> only/);
  assert.throws(() => validateConfig(testConfig({ auth: 'dev', trustCfIp: true })), /unset BOARD_TRUST_CF_IP/);
  // The Resend key is scrubbed from the environment once read.
  const env = { BOARD_AUTH: 'accounts', BOARD_SECRET: 's'.repeat(40), BOARD_RESEND_API_KEY: 're_secret', BOARD_MAIL_FROM: 'a@b.co' };
  assert.equal(loadConfig(env).resendApiKey, 're_secret');
  assert.equal(env.BOARD_RESEND_API_KEY, undefined);
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
  assert.equal(createMailer({}).kind, 'console');
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
