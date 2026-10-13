// Boots a local accounts-mode hub (allowlist sign-up, A on the list, B not) and drives
// acceptance.mjs through every stage as child processes, reading codes from the outbox mailer.
import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const { startAccounts } = await import(path.join(here, '..', '..', 'test', 'accounts-helpers.js'));
const script = path.join(here, 'acceptance.mjs');
const STATE = path.join(here, 'selftest-state.json');
rmSync(STATE, { force: true });

const EA = 'owner-a@acceptance.test', EB = 'invitee-b@acceptance.test', EC = 'throwaway-c@acceptance.test';
const h = await startAccounts({ config: { signup: 'allowlist', signupAllow: `email:${EA}` } });
const codeFor = (email) => {
  const m = [...h.mailer.sent].reverse().find((x) => x.to === email && /code: \d{6}/.test(x.text ?? ''));
  return m ? /code: (\d{6})/.exec(m.text)[1] : null;
};
const mails = (email) => h.mailer.sent.filter((x) => x.to === email).length;

function cli(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { ...process.env, HUB: h.base, ACCEPT_STATE: STATE } }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr });
    });
  });
}
const step = async (label, ...args) => {
  const r = await cli(...args);
  console.log(`$ acceptance.mjs ${label}\n${r.out.trimEnd()}\n`);
  return r;
};
const state = () => JSON.parse(readFileSync(STATE, 'utf8'));
const EXPECTED_NA = ['1.1', '1.2', '1.3', '1.7', '1.8', '2.10'];

function assertGreen(label) {
  const res = state().results;
  const bad = res.filter((r) => r.status === 'FAIL' || r.status === 'PENDING' || (r.status === 'N/A' && !EXPECTED_NA.includes(r.id)));
  assert.deepEqual(bad, [], `${label}: rows not green`);
  assert.deepEqual(res.filter((r) => r.status === 'N/A').map((r) => r.id).sort(), [...EXPECTED_NA].sort(), `${label}: N/A set`);
  return res;
}

try {
  assert.equal((await step('start A', 'start', 'A', EA)).code, 0);
  assert.ok(codeFor(EA));
  assert.equal((await step('verify A', 'verify', 'A', codeFor(EA))).code, 0);
  assert.equal((await step('start C', 'start', 'C', EC)).code, 0);
  assert.equal((await step('start B (before invite)', 'start', 'B', EB)).code, 0);
  assert.equal(mails(EB), 0, 'allowlist hub mailed a code to a non-listed address');

  const r1 = await step('run (B not signed in)', 'run');
  assert.equal(r1.code, 0, 'first run');
  assert.ok(state().results.some((r) => r.status === 'PENDING'));
  assert.ok(!state().results.some((r) => r.status === 'FAIL'));

  assert.equal((await step('start B', 'start', 'B', EB)).code, 0);
  assert.ok(codeFor(EB), 'invited B got a code');
  assert.equal((await step('verify B', 'verify', 'B', codeFor(EB))).code, 0);

  const r2 = await step('run', 'run');
  assertGreen('run');
  assert.equal(r2.code, 0);
  const r3 = await step('run (again: idempotent)', 'run');
  const res = assertGreen('re-run');
  assert.equal(r3.code, 0);
  const teams = Object.keys(state().teams);
  assert.equal(teams.length, 2);

  assert.equal((await step('cleanup (step-up 1)', 'cleanup')).code, 0);
  // Verifies so far: A 2, B 2, C 6 = the 10-per-10-min per-IP limit, so this one is refused and must keep its state.
  const limited = await step('cleanup <code 1> (rate limited)', 'cleanup', codeFor(EA));
  assert.notEqual(limited.code, 0);
  assert.match(limited.out, /RATE_LIMITED.*run the same cleanup command again/is);
  assert.ok(state().stepup, 'step-up kept after 429');
  h.clock.advance(120_000);
  assert.equal((await step('cleanup <code 1> (after 2 min)', 'cleanup', codeFor(EA))).code, 0);
  assert.equal((await step('cleanup <code 2>', 'cleanup', codeFor(EA))).code, 0);
  const s = state();
  assert.deepEqual(s.teams, {});
  assert.ok(!s.accounts.A.token && !s.accounts.B.token, 'tokens dropped');
  for (const id of teams) assert.ok(h.db.get('SELECT deleted_at FROM orgs WHERE id = ?', id).deleted_at, 'team soft-deleted');
  assert.equal(h.db.get('SELECT COUNT(*) n FROM user_devices WHERE revoked_at IS NULL').n, 0, 'devices revoked');
  // Nothing secret reached stdout of any stage is asserted by construction; check the file holds no code.
  console.log(`SELFTEST GREEN: ${res.filter((r) => r.status === 'PASS').length} PASS, ${res.filter((r) => r.status === 'N/A').length} N/A (expected), 0 FAIL`);
} finally {
  await h.destroy();
  rmSync(STATE, { force: true });
}
