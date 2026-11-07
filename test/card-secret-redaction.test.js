'use strict';
// A prompt like "always use password <digits> ..." once became a My board card's title word for word. Every text that
// can reach a card, a team hub, a note or a hand-off passes src/scrub.js redactSecretsPass; these pin the shapes it
// must catch and the benign titles it must leave alone. Every secret below is made up. (A line that starts
// "password <word>" is still read as .netrc by the pinned shared list: fail closed, left as is.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { redactSecretsPass, scrubTitle } = require('../src/scrub.js');
const { createWorkCapture, clean, agentTitle } = require('../src/work-capture.js');
const { testTempDir } = require('./helpers/tmp');

const PW = '730194';
const SECRETS = [
  [`always use password ${PW} for the staging box`, PW],
  ['my pin 4471 for the alarm', '4471'],
  ['passcode: 88213', '88213'],
  ['set the passcode to "q7x!wk" please', 'q7x!wk'],
  ['sign in with password Tr0ub4dorX and continue', 'Tr0ub4dorX'],
  ['use pwd mango9lime', 'mango9lime'],
  ['PIN code 90210-7', '90210-7'],
  ['key sk-ant-api03-Zq8vN2mK4pL7rT1xW9yB3cD5fG6hJ0kQ', 'sk-ant-api03-Zq8vN2mK4pL7rT1xW9yB3cD5fG6hJ0kQ'],
  ['openai sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34', 'sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34'],
  ['token ghp_Q4w8E2r6T1y5U9i3O7p0A4s8D2f6G1h5J9k3', 'ghp_Q4w8E2r6T1y5U9i3O7p0A4s8D2f6G1h5J9k3'],
  ['gho_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2 oauth', 'gho_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'],
  ['pat github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345', 'github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345'],
  ['slack xoxb-1234567890-abcdefGHIJKL', 'xoxb-1234567890-abcdefGHIJKL'],
  ['aws AKIAZ7Q4M2LXWB3K9RTD here', 'AKIAZ7Q4M2LXWB3K9RTD'],
  ['maps AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q', 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'],
  ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eXoifQ.c2lnbmF0dXJlMTIzNDU2', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eXoifQ.c2lnbmF0dXJlMTIzNDU2'],
  ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx9Zt2Lq\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAx9Zt2Lq'],
  ['header Authorization: Bearer f3Kq9ZpL2xV7mN4rT8wY1bC6', 'f3Kq9ZpL2xV7mN4rT8wY1bC6'],
  ['hex 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
  ['blob Qm9vVGhpc0lzQVNlY3JldEtleTk4NzY1NDMyMXh5eg==', 'Qm9vVGhpc0lzQVNlY3JldEtleTk4NzY1NDMyMXh5eg=='],
  ['db postgres://admin:Sw0rdf1shX@db.example.test/app', 'Sw0rdf1shX'],
  ['curl https://api.example.test/v1?token=Zx81Qw72Er63&x=1', 'Zx81Qw72Er63'],
  ['curl https://api.example.test/v1?key=Lp09Ok98Ij87', 'Lp09Ok98Ij87'],
  ['STRIPE_SECRET_KEY=sk_live_51Hx2Ab3Cd4Ef5Gh6', 'sk_live_51Hx2Ab3Cd4Ef5Gh6'],
  ['DB_PASSWORD=ab12cd34ef', 'ab12cd34ef'],
];
const BENIGN = [
  'fix the password reset flow', 'add a pin to the map', 'change password field label', 'pin 3 deps',
  'update pw hashing to argon2id', 'Rename SomeVeryLongComponentNameForTheSettingsPage', 'edit src/components/settings/PasswordForm.tsx',
  'bump react to 18.3.1', 'Pin to node22 in CI', 'pin to 2024 releases', 'pin v2beta3 for now',
];

test('the one scrubber removes every secret shape a card, hub, note or hand-off could carry', () => {
  for (const [text, secret] of SECRETS) {
    for (const out of [redactSecretsPass(text), scrubTitle(text), clean(text, 400)]) {
      assert.ok(!out.includes(secret), `${JSON.stringify(secret)} survived in ${JSON.stringify(out)}`);
    }
    assert.match(redactSecretsPass(text), /\[redacted\]/, text);
  }
});

test('benign titles that mention passwords, pins, paths and identifiers are left alone', () => {
  for (const text of BENIGN) assert.equal(redactSecretsPass(text), text);
});

test('scrubbing is idempotent: an already redacted value is not redacted again', () => {
  const once = redactSecretsPass(`use password ${PW} now`);
  assert.equal(once, 'use password [redacted] now');
  assert.equal(redactSecretsPass(once), once);
});

const R = { hub: 'https://hub.example.test', user_id: 'user-a', team_id: 'team-a', board_id: 'board-a', repo_id: 'repo-a', canonical_url: 'github.com/org/app', role: 'member' };
const PROMPT = `always use password ${PW} when you log in to staging`;
function rig(t, opts = {}) {
  const dir = testTempDir('card-redact-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const router = createWorkCapture({ startEnabled: true, file: path.join(dir, 'capture.json'), host: 'mac', getRoutes: async () => ({ routes: [R], complete: true }),
    resolveRepo: async () => R.canonical_url, factsFor: () => ({ cwd: '/working/app', firstPrompt: PROMPT, lastPrompt: PROMPT }),
    sendLocal: async (body) => { calls.push({ kind: 'local', body }); return { ok: true, card: { id: 'local-card' } }; },
    sendTeam: async (destination, body) => { calls.push({ kind: 'team', destination, body }); return { ok: true, card: { id: 'team-card' } }; },
    now: () => 100000, ...opts });
  t.after(() => router.stop());
  return { calls, router };
}
const claude = (extra = {}) => ({ source: 'claude', sessionId: 'sess-1', host: 'mac', cwd: '/working/app', signal: 'tool-use', via: 'UserPromptSubmit', updatedAt: new Date(100000).toISOString(), ...extra });

test('a My board card made from the prompt never carries the password', async (t) => {
  const r = rig(t, { resolveRepo: async () => null });
  await r.router.observe([claude()]);
  const local = r.calls.filter((c) => c.kind === 'local');
  assert.ok(local.length >= 1, 'a My board card was made');
  for (const c of local) assert.ok(!JSON.stringify(c.body).includes(PW), JSON.stringify(c.body));
  assert.match(local[0].body.title, /password \[redacted\]/);
});

test('a team card never uses the prompt as its title without share_summaries, and scrubs it with it', async (t) => {
  const off = rig(t);
  await off.router.observe([claude()]);
  const team = off.calls.filter((c) => c.kind === 'team');
  assert.ok(team.length >= 1, 'a team card was made');
  for (const c of team) {
    assert.ok(!JSON.stringify(c.body).includes(PW));
    assert.ok(!/log in to staging/.test(c.body.title), `the prompt became a team title: ${c.body.title}`);
    assert.equal(c.body.summary, undefined);
  }
  const on = rig(t, { getRoutes: async () => ({ routes: [{ ...R, share_summaries: true }], complete: true }) });
  await on.router.observe([claude({ sessionId: 'sess-2' })]);
  const shared = on.calls.filter((c) => c.kind === 'team');
  assert.ok(shared.length >= 1);
  for (const c of shared) assert.ok(!JSON.stringify(c.body).includes(PW), JSON.stringify(c.body));
});

test('a reported task title and an AI-added card title are scrubbed on both boards', async (t) => {
  const r = rig(t);
  await r.router.observe([{ ...claude({ sessionId: 'sess-3' }), source: 'codex', taskTitle: `deploy with pin 5093 then password ${PW}` }]);
  assert.ok(r.calls.length >= 1);
  for (const c of r.calls) assert.ok(!new RegExp(`5093|${PW}`).test(JSON.stringify(c.body)), JSON.stringify(c.body));
  assert.ok(!agentTitle(`rotate password ${PW} on staging`, 'codex').includes(PW));
});

test('run results and onward hand-offs from the Tasks helper go through the same scrubber', async () => {
  const { scrubRun } = await import('../board/tasks-engine/bus/dispatcher.js');
  const out = scrubRun(`Done. I used password ${PW} and pin 4471.`, 400);
  assert.ok(!out.includes(PW) && !out.includes('4471'), out);
});
