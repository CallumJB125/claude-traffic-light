// The /signin page script (web/js/signin.js) in a stand-in DOM: plain words
// for every way a code can fail, the resend gate, a hub with no mailer, a
// network failure, and an invite that resumes once signed in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as text from '../js/account-text.js';

const SRC = readFileSync(new URL('../js/signin.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '');
const TOKEN = `inv_${'A'.repeat(43)}`;
const settle = () => new Promise((r) => setImmediate(r));

function page({ hash = '', routes = {}, now = () => 1_000_000 } = {}) {
  const els = {};
  const el = (id) => (els[id] ??= { id, textContent: '', hidden: ['code-form', 'code-foot', 'confirm', 'signin-error'].includes(id), value: '', on: {}, focus() {}, addEventListener(type, fn) { this.on[type] = fn; } });
  const calls = [];
  const replaced = [];
  const fetch = async (path, opts) => {
    calls.push({ path, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
    const r = routes[path];
    const out = typeof r === 'function' ? r(calls.at(-1)) : r ?? { status: 200, body: {} };
    if (out === 'network') throw new TypeError('fetch failed');
    return { ok: out.status < 400, status: out.status, json: async () => out.body };
  };
  const ctx = {
    ...text, console, URLSearchParams, JSON, Promise, Map, String,
    Date: { now },
    location: { hash, pathname: '/signin', replace: (u) => replaced.push(u) },
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

test('an invite opened while signed out resumes on /invite after the code; a malformed one is ignored', async () => {
  const ok = { ...start, '/api/auth/email/verify': { status: 200, body: { user: {}, teams: [], csrf_token: 'x' } } };
  const p = page({ hash: `#invite=${TOKEN}`, routes: ok });
  assert.match(p.els['signin-lead'].textContent, /accept your invite/);
  p.els.email.value = 'jo@example.com';
  await p.submit('email-form');
  p.els.code.value = '123456';
  await p.submit('code-form');
  assert.deepEqual(p.replaced, [`/invite#${TOKEN}`]);
  const q = page({ hash: '#invite=inv_short', routes: ok });
  q.els.email.value = 'jo@example.com';
  await q.submit('email-form');
  q.els.code.value = '123456';
  await q.submit('code-form');
  assert.deepEqual(q.replaced, ['/']);
});
