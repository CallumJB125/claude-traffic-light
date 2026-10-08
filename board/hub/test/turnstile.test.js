// Optional Cloudflare Turnstile on email-code sign-up (BOARD_TURNSTILE_SITE_KEY +
// BOARD_TURNSTILE_SECRET). Cloudflare is a stub here: nothing leaves the process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { createTurnstile, TURNSTILE_ACTION } from '../identity/turnstile.js';
import { startAccounts } from './accounts-helpers.js';

const SITE = '0x4AAAAAAAsitekey';
const SECRET = '0x4AAAAAAAsecret';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// answer(token) → a siteverify JSON body, 'down' (a network failure) or an HTTP status.
function cloudflare(answer = (t) => ({ success: t === 'good', action: TURNSTILE_ACTION, hostname: 'board.test' })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url !== SITEVERIFY) throw new Error(`unexpected fetch ${url}`);
    const form = new URLSearchParams(init.body);
    calls.push({ init, form });
    const out = await answer(form.get('response'));
    if (out === 'down') throw new TypeError('fetch failed');
    if (typeof out === 'number') return new Response('nope', { status: out });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const on = { turnstileSiteKey: SITE, turnstileSecret: SECRET };

test('config: both env values turn it on; the secret is hidden and removed from the environment', () => {
  const base = { BOARD_AUTH: 'accounts', BOARD_SECRET: 's'.repeat(40), BOARD_ACCOUNTS_DEV: '1' };
  const off = loadConfig({ ...base });
  assert.equal(off.turnstileSiteKey, null);
  assert.equal(createTurnstile(off), null);
  const env = { ...base, BOARD_TURNSTILE_SITE_KEY: SITE, BOARD_TURNSTILE_SECRET: SECRET };
  const cfg = loadConfig(env);
  assert.equal(cfg.turnstileSiteKey, SITE);
  assert.equal(cfg.turnstileSecret, SECRET);
  assert.equal(env.BOARD_TURNSTILE_SECRET, undefined);
  assert.ok(!JSON.stringify(cfg).includes(SECRET));
  assert.equal(createTurnstile(loadConfig({ ...base, BOARD_TURNSTILE_SITE_KEY: SITE })), null, 'a site key alone is off');
});

test('verify: posts only the secret and token, with a timeout; checks success, action and the public hostname', async () => {
  const cf = cloudflare((t) => ({ success: true, action: t === 'other' ? 'login' : TURNSTILE_ACTION, hostname: t === 'elsewhere' ? 'evil.test' : 'board.test' }));
  const ts = createTurnstile({ ...on, publicUrl: 'https://board.test' }, { fetchImpl: cf.fetchImpl });
  await ts.verify('ok');
  assert.deepEqual([...cf.calls[0].form.keys()].sort(), ['response', 'secret']);
  assert.equal(cf.calls[0].form.get('secret'), SECRET);
  assert.ok(cf.calls[0].init.signal instanceof AbortSignal);
  await assert.rejects(ts.verify('other'), (e) => e.code === 'FORBIDDEN' && e.extra.reason === 'human_check');
  await assert.rejects(ts.verify('elsewhere'), (e) => e.code === 'FORBIDDEN');
  const n = cf.calls.length;
  await assert.rejects(ts.verify(''), (e) => e.code === 'FORBIDDEN');
  await assert.rejects(ts.verify('x'.repeat(2049)), (e) => e.code === 'FORBIDDEN');
  await assert.rejects(ts.verify(42), (e) => e.code === 'FORBIDDEN');
  assert.equal(cf.calls.length, n, 'a malformed token never reaches Cloudflare');
});

test('verify fails closed when Cloudflare is unreachable, errors or answers nonsense', async () => {
  for (const out of ['down', 500, { nonsense: true }]) {
    const ts = createTurnstile(on, { fetchImpl: cloudflare(() => out).fetchImpl });
    await assert.rejects(ts.verify('good'), (e) => e.code === 'PROVIDER_UNAVAILABLE', String(out));
  }
});

test('unset: methods carry no site key, the CSP is unchanged and a start never calls Cloudflare', async () => {
  const cf = cloudflare();
  const h = await startAccounts({ fetchImpl: cf.fetchImpl });
  try {
    const m = await h.call('GET', '/api/auth/methods');
    assert.deepEqual(Object.keys(m.body).sort(), ['email', 'github', 'google', 'web']);
    const page = await h.call('GET', '/signin');
    assert.doesNotMatch(page.headers.get('content-security-policy'), /challenges\.cloudflare\.com|frame-src/);
    const s = await h.start('new@dev.local', { turnstile_token: 'bad' });
    assert.equal(s.status, 200);
    assert.ok(h.codeFor('new@dev.local'), 'a new address is mailed as before');
    assert.equal(cf.calls.length, 0);
  } finally {
    await h.close();
  }
});

test('set: methods name the site key and the sign-in page may load the widget', async () => {
  const h = await startAccounts({ config: on, fetchImpl: cloudflare().fetchImpl });
  try {
    const m = await h.call('GET', '/api/auth/methods');
    assert.equal(m.body.turnstile_site_key, SITE);
    assert.ok(!m.text.includes(SECRET));
    const csp = (await h.call('GET', '/signin')).headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
    assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
  } finally {
    await h.close();
  }
});

test('set: a new address needs a passed check; without a token it is answered the same and mailed nothing', async () => {
  const cf = cloudflare();
  const h = await startAccounts({ config: on, fetchImpl: cf.fetchImpl });
  try {
    const quiet = await h.start('bot@dev.local', { client: 'web' });
    assert.equal(quiet.status, 200);
    assert.deepEqual(Object.keys(quiet.body).sort(), ['expires_in', 'flow_id']);
    assert.equal(h.mailer.last('bot@dev.local'), null);
    assert.equal(cf.calls.length, 0);
    const audit = h.db.get("SELECT detail FROM audit WHERE action = 'auth.code.suppressed' ORDER BY rowid DESC LIMIT 1");
    assert.equal(JSON.parse(audit.detail).reason, 'human_check');
    const v = await h.call('POST', '/api/auth/email/verify', { body: { flow_id: quiet.body.flow_id, code: '000000' } });
    assert.equal(v.status, 400);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM users WHERE primary_email = 'bot@dev.local'").n, 0);

    const bad = await h.start('bot@dev.local', { client: 'web', turnstile_token: 'bad' });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.error.reason, 'human_check');
    assert.equal(h.mailer.last('bot@dev.local'), null);

    const r = await h.signIn('carol@dev.local', { turnstile_token: 'good' });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.body.device_token);
    assert.ok(!JSON.stringify(h.db.all('SELECT * FROM audit')).includes('good'), 'the token is stored nowhere');
  } finally {
    await h.close();
  }
});

test('set: an existing account still signs in without a token (desktop app, phone page); a bad token is refused for every address alike', async () => {
  const cf = cloudflare();
  const h = await startAccounts({ config: on, fetchImpl: cf.fetchImpl });
  try {
    const made = await h.signIn('alice@dev.local', { turnstile_token: 'good' });
    assert.equal(made.status, 200, made.text);
    const again = await h.signIn('alice@dev.local');
    assert.equal(again.status, 200, again.text);
    const known = await h.start('alice@dev.local', { turnstile_token: 'bad' });
    const unknown = await h.start('nobody@dev.local', { turnstile_token: 'bad' });
    assert.equal(known.status, 403);
    assert.deepEqual(known.body, unknown.body);
  } finally {
    await h.close();
  }
});

test('set: Cloudflare unreachable refuses the start (fail closed) and mails nothing', async () => {
  const h = await startAccounts({ config: on, fetchImpl: cloudflare(() => 'down').fetchImpl });
  try {
    const s = await h.start('dave@dev.local', { client: 'web', turnstile_token: 'good' });
    assert.equal(s.status, 503);
    assert.equal(s.body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(h.mailer.last('dave@dev.local'), null);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM login_flows').n, 0);
  } finally {
    await h.close();
  }
});

test('set: token checks are rate limited per network before Cloudflare is asked', async () => {
  const cf = cloudflare(() => ({ success: false }));
  const h = await startAccounts({ config: on, fetchImpl: cf.fetchImpl });
  try {
    let last;
    for (let i = 0; i < 21; i++) last = await h.start(`x${i}@dev.local`, { turnstile_token: 'bad' });
    assert.equal(last.status, 429);
    assert.equal(cf.calls.length, 20);
  } finally {
    await h.close();
  }
});

test('set: a signed-in step-up code needs no check', async () => {
  const cf = cloudflare();
  const h = await startAccounts({ config: on, fetchImpl: cf.fetchImpl });
  try {
    const me = await h.signIn('alice@dev.local', { turnstile_token: 'good' });
    const n = cf.calls.length;
    await h.stepUp(me.body.device_token, 'alice@dev.local');
    assert.equal(cf.calls.length, n);
  } finally {
    await h.close();
  }
});
