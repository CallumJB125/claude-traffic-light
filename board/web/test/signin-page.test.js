// The /signin page script (web/js/signin.js) in a stand-in DOM: plain words
// for every way a code can fail, the resend gate, a hub with no mailer, a
// network failure, and an invite that resumes once signed in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as text from '../js/account-text.js';
import { CLIENT_TOKEN_RE } from '../js/client-api.js';

const SRC = readFileSync(new URL('../js/signin.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '');
const TOKEN = `inv_${'A'.repeat(43)}`;
const settle = () => new Promise((r) => setImmediate(r));

function page({ hash = '', routes = {}, now = () => 1_000_000 } = {}) {
  const els = {};
  const el = (id) => (els[id] ??= { id, textContent: '', hidden: ['code-form', 'code-foot', 'confirm', 'signin-error'].includes(id), value: '', on: {}, focus() {}, addEventListener(type, fn) { this.on[type] = fn; } });
  const calls = [];
  const replaced = [];
  const fetch = async (path, opts) => {
    calls.push({ path, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : undefined });
    const r = routes[path];
    const out = await (typeof r === 'function' ? r(calls.at(-1)) : r ?? { status: 200, body: {} });
    if (out === 'network') throw new TypeError('fetch failed');
    return { ok: out.status < 400, status: out.status, json: async () => out.body };
  };
  const ctx = {
    ...text, CLIENT_TOKEN_RE, console, URL, URLSearchParams, JSON, Promise, Map, String,
    Date: { now },
    location: { hash, pathname: '/signin', replace: (u) => replaced.push(u), assign: (u) => replaced.push(u) },
    history: { replaceState() {} },
    document: { getElementById: el },
    fetch,
  };
  vm.runInNewContext(SRC, ctx);
  const submit = async (id) => { els[id].on.submit({ preventDefault() {} }); await settle(); await settle(); };
  const click = async (id) => { els[id].on.click(); await settle(); await settle(); };
  return { els: new Proxy(els, { get: (t, k) => el(k) }), calls, replaced, submit, click };
}

const start = { '/api/auth/email/start': { status: 200, body: { flow_id: 'f'.repeat(24), expires_in: 600 } } };

test('a wrong code says how many tries are left; a dead or expired one asks for a new code', async () => {
  let left = 4;
  const p = page({ routes: { ...start, '/api/auth/email/verify': () => ({ status: 400, body: { error: { code: 'INVALID_TOKEN', message: 'that code is wrong or has expired: ask for a new one', ...(left == null ? {} : { attempts_left: left }) } } }) } });
  p.els.email.value = 'jo@example.com';
  await p.submit('email-form');
  assert.equal(p.els['code-form'].hidden, false);
  assert.equal(p.els['code-foot'].hidden, false, 'resend and change-email links show with the code box');
  assert.equal(p.els['signin-lead'].textContent, 'We’ve asked for a 6-digit code to be sent to jo@example.com. It works for 10 minutes.', 'asked for, not "sent": the hub cannot know it arrived');
  p.els.code.value = '111111';
  await p.submit('code-form');
  assert.equal(p.els['signin-error'].textContent, 'That code isn’t right. 4 tries left.');
  left = 1;
  await p.submit('code-form');
  assert.equal(p.els['signin-error'].textContent, 'That code isn’t right. 1 try left.');
  left = 0;
  await p.submit('code-form');
  assert.match(p.els['signin-error'].textContent, /Ask for a new one\.$/);
  left = null;
  await p.submit('code-form');
  assert.match(p.els['signin-error'].textContent, /expired/);
  assert.doesNotMatch(p.els['signin-error'].textContent, /flow|token|INVALID|:/, 'no hub wording');
});

test('the failure budget and rate limits show a wait in plain words, never seconds of hub text', async () => {
  const p = page({ routes: { ...start, '/api/auth/email/verify': { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'too many wrong codes for this address; retry in 3600 s', retry_after_s: 3600 } } } } });
  p.els.email.value = 'jo@example.com';
  await p.submit('email-form');
  p.els.code.value = '111111';
  await p.submit('code-form');
  assert.equal(p.els['signin-error'].textContent, 'Too many tries. Wait 60 minutes and try again.');
});

test('a start that fails or never arrives says the email could not be sent, with no provider detail', async () => {
  for (const r of [{ status: 502, body: { error: { code: 'INTERNAL', message: 'Resend answered 500 at api.resend.com' } } }, 'network']) {
    const p = page({ routes: { '/api/auth/email/start': r } });
    p.els.email.value = 'jo@example.com';
    await p.submit('email-form');
    assert.equal(p.els['signin-error'].textContent, 'We couldn’t send the email. Try again in a minute.');
    assert.equal(p.els['code-form'].hidden, true);
  }
});

test('resend: a short gap first, then never a fourth code in 15 minutes (the hub would drop it silently)', async () => {
  let t = 1_000_000;
  const p = page({ routes: start, now: () => t });
  p.els.email.value = 'jo@example.com';
  await p.submit('email-form');
  await p.click('resend');
  assert.match(p.els['signin-error'].textContent, /You can ask for a new code in 30 seconds\./);
  assert.equal(p.calls.filter((c) => c.path === '/api/auth/email/start').length, 1);
  t += 31_000;
  await p.click('resend');
  assert.equal(p.els['signin-error'].hidden, true);
  assert.equal(p.els['signin-lead'].textContent, 'We’ve asked for a new code. Use the newest email: older codes stop working.');
  t += 31_000;
  await p.click('resend');
  t += 31_000;
  await p.click('resend');
  assert.equal(p.calls.filter((c) => c.path === '/api/auth/email/start').length, 3);
  assert.match(p.els['signin-error'].textContent, /You can ask for a new code in 14 minutes\./);
});

test('a hub with no mailer: the email form is hidden and the page says to use the app', async () => {
  const p = page({ routes: { '/api/auth/methods': { status: 200, body: { google: true, github: true, email: false } } } });
  await settle();
  await settle();
  assert.equal(p.els['email-form'].hidden, true);
  assert.equal(p.els['signin-lead'].textContent, text.EMAIL_OFF);
});

test('browser provider availability shows only its own configured buttons, independent of desktop methods', async () => {
  const p = page({ routes: { '/api/auth/methods': { status: 200, body: { google: false, github: true, email: false, web: { google: true, github: false } } } } });
  await settle(); await settle();
  assert.equal(p.els['email-form'].hidden, true);
  assert.equal(p.els['oauth-options'].hidden, false);
  assert.equal(p.els['google-signin'].hidden, false);
  assert.equal(p.els['github-signin'].hidden, true);
  assert.equal(p.els['signin-lead'].textContent, 'Choose how to sign in.');
});

test('delayed methods cannot reopen controls or replace the lead after entering the code phase', async () => {
  for (const email of [true, false]) {
    let release;
    const p = page({ routes: { ...start, '/api/auth/methods': () => new Promise(resolve => { release = resolve; }) } });
    p.els.email.value = 'jo@example.com'; await p.submit('email-form');
    const lead = p.els['signin-lead'].textContent;
    release({ status: 200, body: { email, web: { google: true, github: true } } });
    await settle(); await settle();
    assert.equal(p.els['email-form'].hidden, true);
    assert.equal(p.els['oauth-options'].hidden, true);
    assert.equal(p.els['code-form'].hidden, false);
    assert.equal(p.els['signin-lead'].textContent, lead);
  }
});

test('a response from the old method intent cannot overwrite a newer change-email intent', async () => {
  const replies = [];
  const p = page({ routes: { ...start, '/api/auth/methods': () => new Promise(resolve => replies.push(resolve)) } });
  p.els.email.value = 'jo@example.com'; await p.submit('email-form');
  await p.click('other-email'); assert.equal(replies.length, 2);
  replies[1]({ status: 200, body: { email: true, web: { google: true, github: false } } });
  await settle(); await settle();
  replies[0]({ status: 200, body: { email: false, web: { google: false, github: true } } });
  await settle(); await settle();
  assert.equal(p.els['email-form'].hidden, false);
  assert.equal(p.els['google-signin'].hidden, false);
  assert.equal(p.els['github-signin'].hidden, true);
});

test('OAuth start carries only strict invitation context and refuses poisoned provider URLs', async () => {
  const p = page({ hash: `#invite=${TOKEN}`, routes: { '/api/auth/oauth/web/start': { status: 200, body: { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=random', expires_in: 600 } } } });
  await p.click('google-signin');
  assert.deepEqual(p.calls.find(c => c.path === '/api/auth/oauth/web/start').body, { provider: 'google', invitation: { kind: 'team', token: TOKEN } });
  assert.deepEqual(p.replaced, ['https://accounts.google.com/o/oauth2/v2/auth?state=random']);
  const bad = page({ routes: { '/api/auth/oauth/web/start': { status: 200, body: { url: 'https://evil.test/steal', expires_in: 600 } } } });
  await bad.click('google-signin'); assert.deepEqual(bad.replaced, []);
  assert.match(bad.els['signin-error'].textContent, /Sign-in didn’t finish/);
});

test('OAuth result obtains fresh normal CSRF and resumes explicit client acceptance; failed provider keeps invite for email retry', async () => {
  const token = `clinv_${'B'.repeat(43)}`;
  const p = page({ hash: '#oauth=web', routes: {
    '/api/account': { status: 200, body: { user: { id: 'guest' }, teams: [], csrf_token: 'normal-csrf', client_workspaces: [] } },
    '/api/auth/oauth/web/result': { status: 200, body: { ok: true, invitation: { kind: 'client', token } } },
    '/api/client-invites/accept': { status: 200, body: { workspace: { id: 'client-workspace' } } },
  } });
  await settle(); await settle(); await settle();
  assert.deepEqual(p.replaced, ['/clients?workspace=client-workspace']);
  assert.equal(p.calls.find(c => c.path === '/api/auth/oauth/web/result').headers['X-CSRF-Token'], 'normal-csrf');
  assert.equal(p.calls.find(c => c.path === '/api/client-invites/accept').body.t, token);
  const retry = page({ hash: '#oauth=web', routes: { ...start,
    '/api/account': { status: 401, body: {} },
    '/api/auth/oauth/web/result': { status: 200, body: { ok: false, error: { code: 'PROVIDER_UNAVAILABLE' }, invitation: { kind: 'team', token: TOKEN } } },
    '/api/auth/methods': { status: 200, body: { email: true, web: { google: true, github: true } } },
    '/api/auth/email/verify': { status: 200, body: { user: {}, csrf_token: 'email-csrf' } },
    '/api/invites/accept': { status: 200, body: { team: { id: 'team-1' } } },
  } });
  await settle(); await settle(); await settle();
  assert.equal(retry.els['email-form'].hidden, false);
  assert.match(retry.els['signin-error'].textContent, /couldn’t reach/);
  retry.els.email.value = 'jo@example.com'; await retry.submit('email-form'); retry.els.code.value = '123456'; await retry.submit('code-form');
  assert.deepEqual(retry.replaced, ['/?org=team-1']);
});

test('an explicit invite joins after sign-in with CSRF; a malformed one is ignored', async () => {
  const ok = { ...start, '/api/auth/email/verify': { status: 200, body: { user: {}, teams: [], csrf_token: 'x' } }, '/api/invites/accept': { status: 200, body: { team: { id: 'team-1' } } } };
  const p = page({ hash: `#invite=${TOKEN}`, routes: ok });
  assert.match(p.els['signin-lead'].textContent, /accept your invite/);
  p.els.email.value = 'jo@example.com';
  await p.submit('email-form');
  p.els.code.value = '123456';
  await p.submit('code-form');
  assert.deepEqual(p.replaced, ['/?org=team-1']);
  const accept = p.calls.find((c) => c.path === '/api/invites/accept');
  assert.equal(accept.method, 'POST');
  assert.equal(accept.headers['X-CSRF-Token'], 'x');
  assert.deepEqual(accept.body.t, TOKEN);
  const q = page({ hash: '#invite=inv_short', routes: ok });
  q.els.email.value = 'jo@example.com';
  await q.submit('email-form');
  q.els.code.value = '123456';
  await q.submit('code-form');
  assert.deepEqual(q.replaced, ['/']);
  assert.equal(q.calls.some((c) => c.path === '/api/invites/accept'), false);
});

test('invite acceptance failures return to the invite recovery page without personal setup', async () => {
  for (const error of ['WRONG_ACCOUNT', 'INVALID_TOKEN', 'RATE_LIMITED']) {
    const p = page({ hash: `#invite=${TOKEN}`, routes: { ...start,
      '/api/auth/email/verify': { status: 200, body: { user: {}, csrf_token: 'x' } },
      '/api/invites/accept': { status: 403, body: { error: { code: error } } },
    } });
    p.els.email.value = 'jo@example.com';
    await p.submit('email-form');
    p.els.code.value = '123456';
    await p.submit('code-form');
    assert.deepEqual(p.replaced, [`/invite#${TOKEN}`]);
    assert.equal(p.calls.some((c) => c.path === '/api/account/setup'), false);
  }
});

test('email verification and browser OAuth admission pauses show the same truthful fixed message', async () => {
  const error = { code: 'SIGNUP_PAUSED', message: '/private/board.db private pressure' };
  const email = page({ routes: { ...start, '/api/auth/email/verify': { status: 503, body: { error } } } });
  email.els.email.value = 'jo@example.com'; await email.submit('email-form'); email.els.code.value = '123456'; await email.submit('code-form');
  const oauth = page({ hash: '#oauth=web', routes: {
    '/api/account': { status: 401, body: {} },
    '/api/auth/oauth/web/result': { status: 200, body: { ok: false, error, invitation: { kind: 'team', token: TOKEN } } },
    '/api/auth/methods': { status: 200, body: { email: true, web: { google: true, github: true } } },
  } });
  await settle(); await settle(); await settle();
  for (const p of [email, oauth]) { assert.equal(p.els['signin-error'].textContent, 'New sign-ups are temporarily paused. Try again later.'); assert.deepEqual(p.replaced, []); }
  assert.equal(oauth.els['email-form'].hidden, false);
  assert.ok(!oauth.calls.some(c => c.path === '/api/invites/accept' || c.path === '/api/account/setup'));
});
