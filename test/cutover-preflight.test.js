const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'cutover-preflight.mjs');
const good = {
  BOARD_AUTH: 'accounts', BOARD_SECRET: 'k'.repeat(48), BOARD_PUBLIC_URL: 'https://app.plexiform.dev', BOARD_TRUST_CF_IP: '1', BOARD_BIND: '127.0.0.1',
  BOARD_ENC_KEY: 'e'.repeat(44), BOARD_GOOGLE_CLIENT_ID: 'gid', BOARD_GOOGLE_CLIENT_SECRET: 'gsecret', BOARD_SIGNUP: 'allowlist', BOARD_SIGNUP_ALLOW: 'email:ann@plexiform.dev',
  BOARD_TUNNEL_PROBE_URL: 'https://app.plexiform.dev/api/health',
};
const load = () => import('../scripts/cutover-preflight.mjs');

test('parseEnv: comments, quotes, export, trailing comments', async () => {
  const { parseEnv } = await load();
  assert.deepEqual(parseEnv('# c\nA=1\nexport B="two words"\nC=\'x\' \nD=v # note\n\nbad line\n'), { A: '1', B: 'two words', C: 'x', D: 'v' });
});
test('a complete accounts env has no errors', async () => {
  const { preflight } = await load();
  const r = preflight({ ...good });
  assert.deepEqual(r.errors, []);
  assert.equal(r.risks.length, 1, r.risks.join('\n'));
  assert.match(r.risks[0], /Testing mode/, 'the standing Google consent reminder is the only risk');
});
test('access mode, placeholders and a short secret are blocking; secrets are never echoed', async () => {
  const { preflight } = await load();
  assert.match(preflight({ BOARD_AUTH: 'access', BOARD_ACCESS_TEAM: 't', BOARD_ACCESS_AUD: 'a' }).errors[0], /set BOARD_AUTH=accounts/);
  const ph = preflight({ ...good, BOARD_SECRET: 'change-me-openssl-rand-base64-48-before-first-start' });
  assert.match(ph.errors.join(), /placeholder/);
  assert.doesNotMatch(ph.errors.join(), /openssl-rand/);
  assert.match(preflight({ ...good, BOARD_SECRET: 'short' }).errors.join(), /32 bytes/);
  assert.match(preflight({ ...good, BOARD_TRUST_CF_IP: '' }).errors.join(), /BOARD_TRUST_CF_IP/);
});
test('risks: open signup, public-mail domain, leftover Access/bootstrap/restore, missing probe and key', async () => {
  const { preflight } = await load();
  const r = preflight({ ...good, BOARD_SIGNUP: 'open', BOARD_ACCESS_TEAM: 't', BOARD_BOOTSTRAP: 'a@b.co', BOARD_RESTORE: '1', BOARD_TUNNEL_PROBE_URL: '', BOARD_ENC_KEY: '' });
  const t = r.risks.join('\n');
  for (const re of [/SIGNUP=open/, /Testing mode/, /BOARD_ACCESS_\*/, /BOARD_BOOTSTRAP/, /BOARD_RESTORE/, /TUNNEL_PROBE_URL/, /ENC_KEY/]) assert.match(t, re);
  assert.match(preflight({ ...good, BOARD_SIGNUP_ALLOW: 'domain:gmail.com' }).risks.join(), /public mail provider/);
});
test('CLI: reads the env file, lists unclaimed members read-only, exit codes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  try {
    const envFile = path.join(dir, 'hub.env');
    fs.writeFileSync(envFile, Object.entries(good).map(([k, v]) => `${k}=${v}`).join('\n'));
    const dbFile = path.join(dir, 'board.db');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE members (email TEXT, role TEXT, github_login TEXT, user_id TEXT, removed_at TEXT); INSERT INTO members VALUES ('old@x.co','owner','old',NULL,NULL),('claimed@x.co','member','c','u1',NULL),('gone@x.co','member','g',NULL,'2026-01-01')");
    db.close();
    const before = fs.statSync(dbFile).mtimeMs;
    const ok = spawnSync(process.execPath, [SCRIPT, envFile, '--db', dbFile], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /1 unclaimed Access-era member row/);
    assert.match(ok.stdout, /old@x\.co/);
    assert.doesNotMatch(ok.stdout, /claimed@x\.co|gone@x\.co/);
    assert.equal(fs.statSync(dbFile).mtimeMs, before);
    fs.writeFileSync(envFile, 'BOARD_AUTH=access\n');
    assert.equal(spawnSync(process.execPath, [SCRIPT, envFile], { encoding: 'utf8' }).status, 1);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
