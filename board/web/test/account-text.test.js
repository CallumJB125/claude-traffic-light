// account-text.js: the web's plain sentences for accounts errors, the resend
// gate and the "join with a code or link" parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountErrorText, parseJoin, resendWaitS, waitFor, SEND_FAILED, INVITE_INVALID, INVITE_REPLAYED, WRONG_ACCOUNT } from '../js/account-text.js';

const ORIGIN = 'https://board.example.com';
const TOKEN = `inv_${'b'.repeat(43)}`;

test('waits read as minutes or hours, never raw seconds', () => {
  assert.equal(waitFor(5), 'a minute');
  assert.equal(waitFor(undefined), 'a minute');
  assert.equal(waitFor(301), '6 minutes');
  assert.equal(waitFor(86_400), '24 hours');
});

test('every code gets a short plain sentence; nothing from the hub message leaks', () => {
  const leak = { message: 'internal: smtp relay api.resend.com refused jo@example.com' };
  const cases = [
    [{ status: 404, code: 'METHOD_DISABLED', extra: leak }, 'start', /Email sign-in is off/],
    [{ status: 502, code: 'INTERNAL', extra: leak }, 'start', new RegExp(`^${SEND_FAILED}$`)],
    [{ status: 400, code: 'VALIDATION', extra: leak }, 'start', /Enter your email address/],
    [{ status: 400, code: 'INVALID_TOKEN', extra: { attempts_left: 2, ...leak } }, 'verify', /2 tries left/],
    [{ status: 400, code: 'INVALID_TOKEN', extra: leak }, 'invite', new RegExp(`^${INVITE_INVALID}$`)],
    [{ status: 403, code: 'WRONG_ACCOUNT', extra: { email_masked: 'c•••@example.com' } }, 'invite', new RegExp(`^${WRONG_ACCOUNT}$`)],
    [{ status: 409, code: 'ALREADY_MEMBER', extra: { team: { id: 't', name: 'Acme' } } }, 'invite', /You’re already in Acme\./],
    [{ status: 409, code: 'CONFLICT', extra: { reason: 'REPLAYED', ...leak } }, 'invite', /^This invite was already made\. Resend it to get a new link\.$/],
    [{ status: 403, code: 'QUOTA_EXCEEDED', extra: { resource: 'teams', limit: 10 } }, 'team', /as many teams/],
    [{ status: 403, code: 'QUOTA_EXCEEDED', extra: { resource: 'members', limit: 25 } }, 'invite', /team is full/],
    [{ status: 429, code: 'RATE_LIMITED', extra: { retry_after_s: 90 } }, 'team', /Wait 2 minutes/],
    [{ status: 0, code: 'NETWORK', extra: {} }, 'team', /Can’t reach the board/],
  ];
  for (const [err, step, want] of cases) {
    const t = accountErrorText(err, step);
    assert.match(t, want, `${err.code}/${step}`);
    assert.doesNotMatch(t.replace(INVITE_REPLAYED, ''), /resend|smtp|jo@example|internal|c•••/i, `${err.code}/${step} leaks: ${t}`);
  }
});

test('resend gate: 30 s between a code and a new one, at most 3 in 15 minutes', () => {
  assert.equal(resendWaitS([], 0), 0);
  assert.equal(resendWaitS([0], 10_000), 20);
  assert.equal(resendWaitS([0], 30_000), 0);
  assert.equal(resendWaitS([0, 40_000, 80_000], 120_000), 780);
  assert.equal(resendWaitS([0, 40_000, 80_000], 900_000), 0);
  assert.equal(resendWaitS([0], 10_000, { resend: false }), 0, 'signing in again is no resend');
  assert.equal(resendWaitS([0, 40_000, 80_000], 120_000, { resend: false }), 780, 'the cap holds either way');
});

test('join: a code, a bare token or this board’s invite link; another board’s link is refused', () => {
  assert.deepEqual(parseJoin(' bcdf-ghjk ', ORIGIN), { code: 'BCDF-GHJK' });
  assert.deepEqual(parseJoin('BCDFGHJK', ORIGIN), { code: 'BCDFGHJK' });
  assert.deepEqual(parseJoin(TOKEN, ORIGIN), { t: TOKEN });
  assert.deepEqual(parseJoin(`${ORIGIN}/invite#${TOKEN}`, ORIGIN), { t: TOKEN });
  assert.match(parseJoin(`https://evil.example/invite#${TOKEN}`, ORIGIN).error, /another board/);
  assert.match(parseJoin(`${ORIGIN}/invite#inv_short`, ORIGIN).error, /doesn’t look like an invite/);
  assert.match(parseJoin(`javascript:alert(1)`, ORIGIN).error, /doesn’t look like an invite/);
  assert.match(parseJoin('', ORIGIN).error, /Paste/);
});

test('sign-up control (D104): SIGNUP_CLOSED is the fixed invite-only sentence at any step, never the hub message', () => {
  for (const step of ['verify', 'start', 'invite']) {
    assert.equal(accountErrorText({ status: 403, code: 'SIGNUP_CLOSED', extra: { message: 'hub words' } }, step), 'Sign-up is invite-only right now. Ask a team owner for an invite.');
  }
});

test('temporary signup and storage refusals explain the admission pause without plan or provider details', () => {
  const extra = { resource: 'storage', message: '/private/board.db is over a private configured limit' };
  for (const step of ['start', 'verify', 'team', 'invite']) {
    assert.equal(accountErrorText({ status: 503, code: 'SIGNUP_PAUSED', extra }, step), 'New sign-ups are temporarily paused. Try again later.');
    assert.equal(accountErrorText({ status: 403, code: 'QUOTA_EXCEEDED', extra }, step), 'The board is temporarily unable to add new items. Try again later.');
  }
});
