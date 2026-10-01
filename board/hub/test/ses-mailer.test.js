// The Amazon SES mailer (D66 addendum): SigV4 against AWS's published test
// vectors, the exact SES v2 request, a fake SES on loopback for every failure
// shape, input checks before signing, config selection and validation, and
// the secret staying out of every error, log line and serialisation.
//
// No credential literal appears here: AWS's documented example key material
// is assembled from parts, and the SES credentials are random per run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { validateConfig, loadConfig, mailProvider, sesFromAddress } from '../config.js';
import { sesMailer, createMailer, deriveSigningKey, signV4, resendMailer } from '../identity/mailer.js';
import * as mailerModule from '../identity/mailer.js';
import { createApp } from '../app.js';
import { createLogger, silentLogger } from '../log.js';
import { seedDev } from '../seed.js';
import { testConfig, fakeGitHub, fakeClock } from './helpers.js';
import { startAccounts } from './accounts-helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

// AWS's documented example credentials (SigV4 test suite), built at runtime.
const EX_KEY = ['AKID', 'EXAMPLE'].join('');
const EX_SECRET = ['wJalrXUtnFEMI', 'K7MDENG+bPxRfiCYEXAMPLEKEY'].join('/');
const EMPTY_HASH = sha256('');

// Fresh fake SES credentials for each run, the shapes the config accepts.
const creds = () => ({
  accessKeyId: `TEST${randomBytes(10).toString('hex').toUpperCase()}`,
  secretAccessKey: randomBytes(30).toString('base64'),
});
const FROM = 'Plexiform <no-reply@plexiform.dev>';
const CLOCK = () => new Date('2026-10-01T12:34:56.789Z');

test('SigV4: reproduces AWS published test-suite vectors (get-vanilla, get-vanilla-with-session-token, post-x-www-form-urlencoded)', () => {
  // Source: aws-c-auth tests/aws-signing-test-suite/v4/<name>/ (context.json, header-canonical-request.txt, header-signature.txt).
  const vanilla = signV4({
    method: 'GET', path: '/', headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    payloadHash: EMPTY_HASH, amzDate: '20150830T123600Z', region: 'us-east-1', service: 'service', accessKeyId: EX_KEY, secret: EX_SECRET,
  });
  assert.equal(vanilla.canonicalRequest, `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_HASH}`);
  assert.equal(vanilla.stringToSign, 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63');
  assert.equal(vanilla.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(vanilla.authorization, `AWS4-HMAC-SHA256 Credential=${EX_KEY}/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`);

  const token = '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267';
  const withToken = signV4({
    method: 'GET', path: '/', headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z', 'x-amz-security-token': token },
    payloadHash: EMPTY_HASH, amzDate: '20150830T123600Z', region: 'us-east-1', service: 'service', accessKeyId: EX_KEY, secret: EX_SECRET,
  });
  assert.equal(withToken.signedHeaders, 'host;x-amz-date;x-amz-security-token');
  assert.equal(withToken.signature, '07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8');

  const body = 'Param1=value1';
  const post = signV4({
    method: 'POST', path: '/',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Host: 'example.amazonaws.com', 'content-length': '13', 'x-amz-content-sha256': sha256(body), 'x-amz-date': '20150830T123600Z' },
    payloadHash: sha256(body), amzDate: '20150830T123600Z', region: 'us-east-1', service: 'service', accessKeyId: EX_KEY, secret: EX_SECRET,
  });
  assert.equal(post.signedHeaders, 'content-length;content-type;host;x-amz-content-sha256;x-amz-date', 'lower-cased and sorted');
  assert.equal(post.signature, 'd3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b');

  // The signing key is the documented HMAC chain over "AWS4"+secret, date, region, service, "aws4_request".
  const chain = hmac(hmac(hmac(hmac(`AWS4${EX_SECRET}`, '20150830'), 'us-east-1'), 'service'), 'aws4_request');
  assert.deepEqual(deriveSigningKey(EX_SECRET, '20150830', 'us-east-1', 'service'), chain);
  assert.equal(createHmac('sha256', deriveSigningKey(EX_SECRET, '20150830', 'us-east-1', 'service')).update(vanilla.stringToSign).digest('hex'), vanilla.signature);
});

// An independent signer (straight from the SigV4 spec), used to check the mailer's requests.
function expectedAuth({ keyId, secret, region, amzDate, headers, body }) {
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonical = ['POST', '/v2/email/outbound-emails', '', ...names.map((n) => `${n}:${String(lower[n]).trim()}`), '', names.join(';'), sha256(body)].join('\n');
  const scope = `${amzDate.slice(0, 8)}/${region}/ses/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, amzDate.slice(0, 8)), region), 'ses'), 'aws4_request');
  return `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', key).update(sts).digest('hex')}`;
}

test('SES request: one signed POST to email.<region>.amazonaws.com/v2/email/outbound-emails, exact body and headers, no idempotency header', async () => {
  for (const sessionToken of [null, randomBytes(48).toString('base64')]) {
    const c = creds();
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ MessageId: '0100-abc' }), { status: 200 }); };
    const m = sesMailer({ region: 'af-south-1', ...c, sessionToken, from: FROM, fetchImpl, now: CLOCK });
    assert.equal(m.kind, 'ses');
    assert.deepEqual(await m.send({ to: 'jo@example.com', subject: '123456 is your code', text: 'code: 123456\n', idempotencyKey: 'flow1' }), { id: '0100-abc' });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, 'https://email.af-south-1.amazonaws.com/v2/email/outbound-emails');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(init.body), {
      FromEmailAddress: FROM,
      Destination: { ToAddresses: ['jo@example.com'] },
      Content: { Simple: { Subject: { Data: '123456 is your code', Charset: 'UTF-8' }, Body: { Text: { Data: 'code: 123456\n', Charset: 'UTF-8' } } } },
    });
    const want = ['content-type', 'x-amz-content-sha256', 'x-amz-date', ...(sessionToken ? ['x-amz-security-token'] : []), 'authorization'];
    assert.deepEqual(Object.keys(init.headers), want, 'header names and order');
    assert.equal(init.headers['content-type'], 'application/json');
    assert.equal(init.headers['x-amz-date'], '20261001T123456Z');
    assert.equal(init.headers['x-amz-content-sha256'], sha256(init.body));
    if (sessionToken) assert.equal(init.headers['x-amz-security-token'], sessionToken);
    const signedHeaders = `content-type;host;x-amz-content-sha256;x-amz-date${sessionToken ? ';x-amz-security-token' : ''}`;
    assert.match(init.headers.authorization, new RegExp(`^AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/20261001/af-south-1/ses/aws4_request, SignedHeaders=${signedHeaders}, Signature=[0-9a-f]{64}$`));
    const { authorization, ...rest } = init.headers;
    assert.equal(authorization, expectedAuth({ keyId: c.accessKeyId, secret: c.secretAccessKey, region: 'af-south-1', amzDate: '20261001T123456Z', headers: { ...rest, host: 'email.af-south-1.amazonaws.com' }, body: init.body }));
    assert.ok(!JSON.stringify(init.headers).includes('flow1'), 'SES v2 has no idempotency header: the key is not sent');
    assert.ok(!init.body.includes('Html'), 'plain text only');
  }
});

test('SES region: the host is built from the region as given; opt-in regions are accepted, anything else refused', () => {
  for (const region of ['us-east-1', 'af-south-1', 'me-south-1', 'ap-east-1', 'eu-south-1', 'ap-southeast-2', 'us-gov-west-1']) {
    const calls = [];
    const m = sesMailer({ region, ...creds(), from: FROM, fetchImpl: async (u) => { calls.push(u); return new Response('{"MessageId":"x"}'); }, now: CLOCK });
    assert.equal(m.kind, 'ses', region);
    assert.doesNotThrow(() => validateConfig(sesBase({ sesRegion: region })), region);
  }
  assert.throws(() => sesMailer({ region: '', ...creds(), from: FROM, fetchImpl: async () => { throw new Error('no'); }, now: CLOCK }), /^Error: SES mailer: bad region$/);
  for (const region of ['US-EAST-1', 'us-east-1.evil.example', 'us-east-1/', 'useast1', 'us-east-10', 'af-south-1\n', 'evil.example#us-east-1', 'u-east-1']) {
    assert.throws(() => sesMailer({ region, ...creds(), from: FROM, fetchImpl: async () => { throw new Error('no'); }, now: CLOCK }), /^Error: SES mailer: bad region$/, JSON.stringify(region));
    assert.throws(() => validateConfig(sesBase({ sesRegion: region })), /^Error: BOARD_SES_REGION must look like af-south-1$/, JSON.stringify(region));
  }
});

test('From format: display sends BOARD_MAIL_FROM as given, bare only the address; both are what the signature covers', async () => {
  assert.equal(sesFromAddress(FROM, 'display'), FROM);
  assert.equal(sesFromAddress(FROM, 'bare'), 'no-reply@plexiform.dev');
  assert.equal(sesFromAddress('no-reply@plexiform.dev', 'bare'), 'no-reply@plexiform.dev');
  assert.equal(sesFromAddress('no-reply@plexiform.dev', 'display'), 'no-reply@plexiform.dev');
  for (const bad of ['A <b@c.dev> <e@f.dev>', 'A <b@c.dev', 'A <<b@c.dev>>', 'A <b@c.dev>, C <e@f.dev>', 'A <b@c.dev> trailing', 'A <b@c.dev>\r\nBcc: x@y.dev', 'A <b c@d.dev>', 'A <>', '', 'A <a@b@c.dev>']) {
    assert.equal(sesFromAddress(bad, 'bare'), null, JSON.stringify(bad));
  }
  for (const bad of ['A <b@c.dev>\r\nBcc: x@y.dev', 'A <b@c.dev>\n', 'A\0 <b@c.dev>', '', 'x'.repeat(321)]) assert.equal(sesFromAddress(bad, 'display'), null, JSON.stringify(bad));
  assert.equal(sesFromAddress(FROM, 'other'), null);

  const ses = await fakeSes();
  try {
    for (const [fmt, want] of [['display', FROM], ['bare', 'no-reply@plexiform.dev']]) {
      const c = creds();
      const m = sesMailer({ region: 'af-south-1', ...c, from: FROM, fromFormat: fmt, fetchImpl: ses.fetchImpl, now: CLOCK });
      ses.mode = 'ok';
      ses.creds = c;
      assert.deepEqual(await m.send({ to: 'jo@example.com', subject: 'S', text: 'T' }), { id: 'ses-msg-1' });
      const got = ses.requests.at(-1);
      assert.equal(JSON.parse(got.body).FromEmailAddress, want, fmt);
      assert.equal(got.signatureOk, true, 'the fake SES re-derived the signature over the received body and headers');
      assert.equal(got.headers['x-amz-content-sha256'], sha256(got.body));
    }
  } finally {
    await ses.close();
  }
  assert.throws(() => sesMailer({ region: 'af-south-1', ...creds(), from: 'A <b@c.dev', fromFormat: 'bare', fetchImpl: ses.fetchImpl, now: CLOCK }), /^Error: SES mailer: bad From$/);
});

// A fake SES on loopback: the mailer builds the AWS URL; fetchImpl records it
// and sends the request here instead. Checks each request's signature itself.
async function fakeSes() {
  const state = { mode: 'ok', requests: [], urls: [], creds: null, region: 'af-south-1', sentinel: `SENTINEL-${randomBytes(6).toString('hex')}` };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const headers = { ...req.headers };
      let signatureOk = null;
      if (state.creds) {
        const signed = {};
        for (const n of /SignedHeaders=([^,]+)/.exec(headers.authorization ?? '')?.[1].split(';') ?? []) signed[n] = n === 'host' ? `email.${state.region}.amazonaws.com` : headers[n];
        signatureOk = headers.authorization === expectedAuth({ keyId: state.creds.accessKeyId, secret: state.creds.secretAccessKey, region: state.region, amzDate: headers['x-amz-date'], headers: signed, body });
      }
      state.requests.push({ path: req.url, headers, body, signatureOk });
      const s = state.sentinel;
      const json = (status, obj, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(obj)); };
      switch (state.mode) {
        case 'ok': return json(200, { MessageId: 'ses-msg-1' });
        case 'rejected': return json(400, { message: `Email address is not verified ${s} ${body}` }, { 'x-amzn-errortype': `MessageRejected:http://internal.amazon.com/coral/${s}` });
        case 'denied': return json(403, { message: `User ${s} is not authorized to perform ses:SendEmail` }, { 'x-amzn-errortype': 'AccessDeniedException:' });
        case 'throttle': return json(429, { message: `Maximum sending rate exceeded ${s}` }, { 'x-amzn-errortype': 'TooManyRequestsException' });
        case 'body-type': return json(400, { __type: 'com.amazonaws.sesv2#MailFromDomainNotVerifiedException', message: s });
        case 'unknown-type': return json(400, { message: s }, { 'x-amzn-errortype': `${s}Exception` });
        case 'server': return json(500, { message: `internal ${s} ${headers.authorization}` });
        case 'redirect': res.writeHead(302, { location: `https://evil.example/${s}` }); return res.end(s);
        case 'malformed': res.writeHead(200, { 'content-type': 'application/json' }); return res.end(`{"MessageId": ${s}`);
        case 'no-id': return json(200, { Other: s });
        case 'reset': return req.socket.destroy();
        case 'custom': res.on('error', () => {}); return state.custom(res, s);
        default: return json(418, {});
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  state.fetchImpl = async (url, init) => {
    state.urls.push(url);
    const u = new URL(url);
    return fetch(`${base}${u.pathname}${u.search}`, init);
  };
  state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return state;
}

function assertClean(err, forbidden, what) {
  assert.ok(err instanceof Error, what);
  assert.equal(err.cause, undefined, `${what}: no cause`);
  assert.deepEqual(Object.keys(err), [], `${what}: no extra fields`);
  const views = [String(err), err.message, JSON.stringify(err), inspect(err, { showHidden: true, depth: 10 }), String(err.stack)];
  for (const v of views) for (const f of forbidden) assert.ok(!v.includes(f), `${what}: leaked ${f.slice(0, 12)}…`);
}

test('SES failures: fixed texts with at most an allowlisted tag; never the body, headers, credentials, signature or address', async () => {
  const ses = await fakeSes();
  const c = creds();
  const token = randomBytes(40).toString('base64');
  ses.creds = c;
  const m = sesMailer({ region: 'af-south-1', ...c, sessionToken: token, from: FROM, fetchImpl: ses.fetchImpl, now: CLOCK });
  const cases = [
    ['rejected', 'SES answered 400 (MessageRejected)'],
    ['denied', 'SES answered 403 (AccessDenied)'],
    ['throttle', 'SES answered 429 (TooManyRequests)'],
    ['body-type', 'SES answered 400 (MailFromDomainNotVerified)'],
    ['unknown-type', 'SES answered 400'],
    ['server', 'SES answered 500'],
    ['redirect', 'SES answered 302'],
    ['malformed', 'SES answer was not understood'],
    ['no-id', 'SES answer was not understood'],
    ['reset', 'SES request failed'],
  ];
  try {
    for (const [mode, text] of cases) {
      ses.mode = mode;
      const before = ses.requests.length;
      const err = await m.send({ to: 'secret-person@example.com', subject: 'S', text: 'T', idempotencyKey: 'flow-x' }).then(() => null, (e) => e);
      assert.equal(err?.message, text, mode);
      const sig = /Signature=([0-9a-f]{64})/.exec(ses.requests[before]?.headers.authorization ?? '')?.[1];
      assert.ok(sig, `${mode}: the request reached the fake`);
      assert.equal(ses.requests[before].signatureOk, true, `${mode}: signature verifies`);
      assertClean(err, [ses.sentinel, c.secretAccessKey, c.accessKeyId, token, sig, 'AWS4-HMAC', 'Credential=', 'secret-person', 'evil.example', 'flow-x'], mode);
    }
    assert.ok(ses.urls.every((u) => u === 'https://email.af-south-1.amazonaws.com/v2/email/outbound-emails'), 'every request was for the AWS URL');
    assert.equal(ses.requests.length, cases.length, 'no retries, redirect not followed');
  } finally {
    await ses.close();
  }
  // Timeout and a network error carrying request details: neither is wrapped.
  const leaky = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${c.secretAccessKey}`), { headers: { authorization: 'AWS4-HMAC' } }) });
  for (const [thrown, text] of [[new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'SES request timed out'], [new DOMException('aborted', 'AbortError'), 'SES request timed out'], [leaky, 'SES request failed'], ['a string', 'SES request failed']]) {
    const t = sesMailer({ region: 'af-south-1', ...c, from: FROM, fetchImpl: async () => { throw thrown; }, now: CLOCK });
    const err = await t.send({ to: 'jo@example.com', subject: 'S', text: 'T' }).then(() => null, (e) => e);
    assert.equal(err?.message, text);
    assertClean(err, [c.secretAccessKey, c.accessKeyId, 'AWS4-HMAC', 'connect'], text);
  }
  // A body that never ends is cut by the same signal: reading it rejects, mapped to the fixed text.
  const stall = sesMailer({ region: 'af-south-1', ...c, from: FROM, now: CLOCK, fetchImpl: async () => new Response(new ReadableStream({ start(ctl) { ctl.error(new DOMException('timeout', 'TimeoutError')); } }), { status: 200 }) });
  assert.equal((await stall.send({ to: 'jo@example.com', subject: 'S', text: 'T' }).then(() => null, (e) => e))?.message, 'SES request timed out');
});

test('SES input: CR/LF/NUL, several addresses or oversize values are refused before anything is signed or sent', async () => {
  let fetched = 0;
  let clockRead = 0;
  const m = sesMailer({ region: 'af-south-1', ...creds(), from: FROM, fetchImpl: async () => { fetched++; return new Response('{"MessageId":"x"}'); }, now: () => { clockRead++; return CLOCK(); } });
  const ok = { to: 'jo@example.com', subject: 'S', text: 'T' };
  const bad = [
    [{ to: 'jo@example.com\r\nBcc: x@y.dev' }, 'recipient'], [{ to: 'jo@example.com\n' }, 'recipient'], [{ to: 'jo@exa\0mple.com' }, 'recipient'],
    [{ to: 'a@b.dev, c@d.dev' }, 'recipient'], [{ to: 'a@b.dev;c@d.dev' }, 'recipient'], [{ to: 'Jo <jo@example.com>' }, 'recipient'], [{ to: 'jo @example.com' }, 'recipient'],
    [{ to: `${'a'.repeat(250)}@b.dev` }, 'recipient'], [{ to: 'no-at-sign' }, 'recipient'], [{ to: '"q"@b.dev' }, 'recipient'], [{ to: null }, 'recipient'], [{ to: ['a@b.dev'] }, 'recipient'],
    [{ subject: 'S\r\nBcc: x@y.dev' }, 'subject'], [{ subject: 'S\n' }, 'subject'], [{ subject: 'S\0' }, 'subject'], [{ subject: '' }, 'subject'], [{ subject: 'x'.repeat(201) }, 'subject'], [{ subject: 7 }, 'subject'], [{ subject: 'a b' }, 'subject'],
    [{ text: 'T\0' }, 'text'], [{ text: 'x'.repeat(100_001) }, 'text'], [{ text: undefined }, 'text'],
  ];
  for (const [over, what] of bad) {
    const err = await m.send({ ...ok, ...over }).then(() => null, (e) => e);
    assert.equal(err?.message, `SES mail refused: bad ${what}`, JSON.stringify(over).slice(0, 80));
    assert.equal(err.cause, undefined);
  }
  assert.equal(fetched, 0, 'nothing sent');
  assert.equal(clockRead, 0, 'nothing signed (the signing date was never read)');
  assert.deepEqual(await m.send({ ...ok, subject: 'x'.repeat(200), text: 'multi\r\nline\n' }), { id: 'x' }, 'a 200-character subject and a multi-line body are fine');
  assert.equal(fetched, 1);
});

test('SES through Accounts: a failed sign-in mail logs the fixed text and the mailer kind, never the address, body or credentials', async () => {
  const ses = await fakeSes();
  ses.mode = 'rejected';
  const c = creds();
  const lines = [];
  const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
  const mailer = sesMailer({ region: 'af-south-1', ...c, from: FROM, fetchImpl: ses.fetchImpl, now: CLOCK });
  const h = await startAccounts({ mailer, log });
  try {
    assert.deepEqual((await h.call('GET', '/api/auth/methods')).body, { google: false, github: false, email: true, web: { google: false, github: false } }, 'an SES mailer turns email on');
    const s = await h.start('new-person@example.com');
    assert.equal(s.status, 200);
    for (let i = 0; i < 100 && !lines.some((l) => l.includes('sign-in mail failed')); i++) await new Promise((r) => setTimeout(r, 10));
    const line = lines.find((l) => l.includes('sign-in mail failed'));
    assert.ok(line, 'the failure is logged');
    assert.deepEqual({ ...JSON.parse(line), t: undefined }, { t: undefined, level: 'warn', msg: 'sign-in mail failed', mailer: 'ses', err: 'SES answered 400 (MessageRejected)' });
    const all = lines.join('\n');
    for (const f of [ses.sentinel, c.secretAccessKey, c.accessKeyId, 'new-person', 'AWS4-HMAC', 'Signature=']) assert.ok(!all.includes(f), `log leaked ${f.slice(0, 12)}…`);
  } finally {
    await h.close();
    await ses.close();
  }
});

// ── configuration ───────────────────────────────────────────────────────────

const accountsBase = (over = {}) => ({ ...testConfig({ auth: 'accounts', devLoginSecret: null, accountsDev: true }), ...over });
function sesBase(over = {}) {
  const c = creds();
  return accountsBase({ mailProvider: 'ses', sesRegion: 'af-south-1', sesAccessKeyId: c.accessKeyId, sesSecretAccessKey: c.secretAccessKey, mailFrom: FROM, ...over });
}
const sesEnv = (c, over = {}) => ({
  BOARD_AUTH: 'accounts', BOARD_SECRET: 's'.repeat(40), BOARD_ACCOUNTS_DEV: '1', BOARD_MAIL_PROVIDER: 'ses', BOARD_SES_REGION: 'af-south-1',
  BOARD_SES_ACCESS_KEY_ID: c.accessKeyId, BOARD_SES_SECRET_ACCESS_KEY: c.secretAccessKey, BOARD_MAIL_FROM: FROM, ...over,
});

test('config: provider selection; SES secrets leave the environment and never serialise', () => {
  const c = creds();
  const token = randomBytes(40).toString('base64');
  const env = sesEnv(c, { BOARD_SES_SESSION_TOKEN: token });
  const cfg = loadConfig(env);
  assert.equal(mailProvider(cfg), 'ses');
  assert.equal(cfg.sesRegion, 'af-south-1');
  assert.equal(cfg.sesFromFormat, null, 'kept raw: the display default is applied where it is used');
  assert.equal(cfg.sesSecretAccessKey, c.secretAccessKey, 'readable by the mailer factory');
  assert.equal(cfg.sesSessionToken, token);
  assert.equal(env.BOARD_SES_SECRET_ACCESS_KEY, undefined, 'removed from the environment');
  assert.equal(env.BOARD_SES_SESSION_TOKEN, undefined);
  for (const view of [JSON.stringify(cfg), inspect(cfg, { depth: 10 }), String(Object.keys(cfg)), JSON.stringify({ ...cfg }), JSON.stringify(Object.entries(cfg))]) {
    assert.ok(!view.includes(c.secretAccessKey), 'secret not serialised');
    assert.ok(!view.includes(token), 'session token not serialised');
  }
  assert.equal(createMailer(cfg, { fetchImpl: async () => new Response('{}') }).kind, 'ses');
  assert.equal(loadConfig(sesEnv(c, { BOARD_SES_FROM_FORMAT: 'bare' })).sesFromFormat, 'bare');

  // Default: today's rule.
  assert.equal(mailProvider(accountsBase({ resendApiKey: 're_x', mailFrom: 'a@b.dev' })), 'resend');
  assert.equal(mailProvider(accountsBase()), null);
  assert.equal(mailProvider(accountsBase({ mailProvider: 'resend', resendApiKey: 're_x', mailFrom: 'a@b.dev' })), 'resend');
  assert.equal(createMailer(accountsBase({ mailProvider: 'resend', resendApiKey: 're_x', mailFrom: 'a@b.dev' })).kind, 'resend');
  // A Resend key next to ses is a misconfiguration, refused at boot.
  assert.throws(() => validateConfig(sesBase({ resendApiKey: 're_x' })), /^Error: BOARD_RESEND_API_KEY is set but BOARD_MAIL_PROVIDER is ses$/);
  // The console mailer is still loopback-only, and never chosen over SES.
  assert.equal(createMailer(sesBase({ consoleMailer: true }), { fetchImpl: async () => new Response('{}') }).kind, 'ses');
  // An SES provider whose secret did not survive (a spread config) fails closed.
  assert.throws(() => createMailer({ ...sesBase(), sesSecretAccessKey: undefined }), /^Error: SES mailer: missing credentials$/);
});

test('config: SES validation fails with fixed texts that never repeat a value', () => {
  const sentinel = `SENT${randomBytes(8).toString('hex').toUpperCase()}`;
  const cases = [
    [{ mailProvider: 'sendgrid' }, /^Error: BOARD_MAIL_PROVIDER takes resend or ses$/],
    [{ mailProvider: sentinel }, /^Error: BOARD_MAIL_PROVIDER takes resend or ses$/],
    [{ mailProvider: 'sendgrid', resendApiKey: 're_x', mailFrom: 'a@b.dev', sesRegion: 'af-south-1', sesAccessKeyId: 'A'.repeat(20), sesSecretAccessKey: sentinel }, /^Error: BOARD_MAIL_PROVIDER takes resend or ses$/],
    [{ mailProvider: 'resend' }, /^Error: BOARD_MAIL_PROVIDER=resend needs BOARD_RESEND_API_KEY$/],
    [{ mailProvider: 'ses' }, /^Error: BOARD_MAIL_PROVIDER=ses needs BOARD_SES_REGION, BOARD_SES_ACCESS_KEY_ID and BOARD_SES_SECRET_ACCESS_KEY$/],
    [{ sesRegion: 'af-south-1', sesAccessKeyId: 'A'.repeat(20), sesSecretAccessKey: sentinel }, /^Error: BOARD_SES_\* is set but BOARD_MAIL_PROVIDER is not ses$/],
    [{ mailProvider: 'resend', resendApiKey: 're_x', mailFrom: 'a@b.dev', sesSecretAccessKey: sentinel }, /^Error: BOARD_SES_\* is set but BOARD_MAIL_PROVIDER is not ses$/],
  ];
  for (const [over, re] of cases) {
    const err = (() => { try { validateConfig(accountsBase(over)); } catch (e) { return e; } return null; })();
    assert.match(String(err), re, JSON.stringify(over).slice(0, 60));
    assert.ok(!String(err).includes(sentinel));
  }
  const sesCases = [
    [{ sesSecretAccessKey: null }, /needs BOARD_SES_REGION, BOARD_SES_ACCESS_KEY_ID and BOARD_SES_SECRET_ACCESS_KEY$/],
    [{ sesAccessKeyId: null }, /needs BOARD_SES_REGION, BOARD_SES_ACCESS_KEY_ID and BOARD_SES_SECRET_ACCESS_KEY$/],
    [{ sesRegion: null }, /needs BOARD_SES_REGION, BOARD_SES_ACCESS_KEY_ID and BOARD_SES_SECRET_ACCESS_KEY$/],
    [{ mailFrom: null }, /^Error: BOARD_MAIL_PROVIDER=ses needs BOARD_MAIL_FROM$/],
    [{ mailFrom: `A <a@b.dev>\r\nBcc: ${sentinel}@x.dev` }, /^Error: BOARD_MAIL_FROM is not a usable From address$/],
    [{ sesFromFormat: 'bare', mailFrom: `A <a@b.dev> <${sentinel}@x.dev>` }, /^Error: BOARD_MAIL_FROM is not a usable From address$/],
    [{ sesFromFormat: sentinel }, /^Error: BOARD_SES_FROM_FORMAT takes display or bare$/],
    [{ sesRegion: `${sentinel}.evil` }, /^Error: BOARD_SES_REGION must look like af-south-1$/],
    [{ sesAccessKeyId: `${sentinel}-lower` }, /^Error: BOARD_SES_ACCESS_KEY_ID is not an AWS access key id$/],
    [{ sesAccessKeyId: 'SHORT' }, /^Error: BOARD_SES_ACCESS_KEY_ID is not an AWS access key id$/],
    [{ sesSecretAccessKey: `${sentinel}${'x'.repeat(260)}` }, /^Error: BOARD_SES_SECRET_ACCESS_KEY must be 1 to 256 printable characters$/],
    [{ sesSecretAccessKey: `${sentinel} with space` }, /^Error: BOARD_SES_SECRET_ACCESS_KEY must be 1 to 256 printable characters$/],
    [{ sesSessionToken: `${sentinel}\r\nx` }, /^Error: BOARD_SES_SESSION_TOKEN must be 1 to 4096 printable characters$/],
  ];
  for (const [over, re] of sesCases) {
    const err = (() => { try { validateConfig(sesBase(over)); } catch (e) { return e; } return null; })();
    assert.match(String(err), re, JSON.stringify(over).slice(0, 60));
    assert.ok(!String(err).includes(sentinel), 'never repeats the value');
  }
  assert.doesNotThrow(() => validateConfig(sesBase()));
  assert.doesNotThrow(() => validateConfig(sesBase({ sesSessionToken: randomBytes(600).toString('base64'), sesFromFormat: 'bare' })));
});

test('config: SES counts as a mailer for an exposed hub; the console mailer is still refused there', () => {
  const exposed = (over = {}) => sesBase({ publicUrl: 'https://buddy.acme.test', trustCfIp: true, signinMethods: [], accountsDev: false, ...over });
  assert.doesNotThrow(() => validateConfig(exposed()), 'SES alone is a sign-in method');
  assert.equal(createMailer(exposed(), { fetchImpl: async () => new Response('{}') }).kind, 'ses');
  assert.throws(() => validateConfig(exposed({ mailProvider: null, sesRegion: null, sesAccessKeyId: null, sesSecretAccessKey: null })), /needs a sign-in method/);
  assert.throws(() => validateConfig(exposed({ consoleMailer: true })), /BOARD_CONSOLE_MAILER is for a loopback hub that is not exposed/);
  assert.throws(() => validateConfig(exposed({ sesSecretAccessKey: null })), /needs BOARD_SES_REGION/);
});

test('configured SES: createApp builds it from config, /api/auth/methods says email, and mail goes to the AWS URL signed with the hub clock', async () => {
  const c = creds();
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ MessageId: 'm-1' }), { status: 200 }); };
  const cfg = testConfig({ auth: 'accounts', devLoginSecret: null, accountsDev: true, signup: 'open', mailProvider: 'ses', sesRegion: 'me-south-1', sesAccessKeyId: c.accessKeyId, sesSecretAccessKey: c.secretAccessKey, mailFrom: FROM });
  const clock = fakeClock();
  const app = createApp(cfg, { clock, log: silentLogger, github: fakeGitHub(), timers: false, fetchImpl });
  seedDev(app.hub);
  try {
    assert.equal(app.hub.accounts.mailer.kind, 'ses');
    const addr = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${addr.port}`;
    assert.deepEqual(await (await fetch(`${base}/api/auth/methods`)).json(), { google: false, github: false, email: true, web: { google: false, github: false } });
    const r = await fetch(`${base}/api/auth/email/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'jo@example.com', client: 'buddy_desktop' }) });
    assert.equal(r.status, 200);
    for (let i = 0; i < 100 && !calls.length; i++) await new Promise((res) => setTimeout(res, 10));
    assert.equal(calls[0].url, 'https://email.me-south-1.amazonaws.com/v2/email/outbound-emails');
    assert.equal(calls[0].init.headers['x-amz-date'], '20260930T100000Z', 'signed with the hub clock');
    assert.deepEqual(JSON.parse(calls[0].init.body).Destination, { ToAddresses: ['jo@example.com'] });
  } finally {
    await app.close();
  }
  const none = await startAccounts({ mailer: null });
  try {
    assert.equal((await none.call('GET', '/api/auth/methods')).body.email, false, 'no mailer: email off');
  } finally {
    await none.close();
  }
});

// The real entry point: the boot log never carries the secret, and a refused config never echoes it.
function runServer(env, { until = null } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [resolve(HERE, '..', 'server.js')], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d) => { out += d; if (until && out.includes(until)) child.kill('SIGTERM'); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const kill = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('exit', (code) => { clearTimeout(kill); resolveRun({ code, out }); });
  });
}

test('boot: the hub with SES starts, logs, stops, and its output never contains the secret, token or key id', async () => {
  const c = creds();
  const token = randomBytes(40).toString('base64');
  const dir = mkdtempSync(join(tmpdir(), 'board-ses-'));
  const ok = await runServer({ ...sesEnv(c, { BOARD_SES_SESSION_TOKEN: token }), BOARD_PORT: '0', BOARD_DATA_DIR: dir, BOARD_LOG_LEVEL: 'debug' }, { until: 'hub listening' });
  assert.match(ok.out, /hub listening/);
  for (const f of [c.secretAccessKey, token, c.accessKeyId]) assert.ok(!ok.out.includes(f), 'boot output leaked a credential');
  const bad = await runServer({ ...sesEnv(c, { BOARD_SES_SECRET_ACCESS_KEY: `${c.secretAccessKey}${'x'.repeat(300)}` }), BOARD_PORT: '0', BOARD_DATA_DIR: dir });
  assert.equal(bad.code, 2);
  assert.match(bad.out, /invalid configuration/);
  assert.match(bad.out, /BOARD_SES_SECRET_ACCESS_KEY must be 1 to 256 printable characters/);
  assert.ok(!bad.out.includes(c.secretAccessKey), 'a refused config never echoes the secret');
});

test('Resend is unchanged: same request, idempotency header, error text', async () => {
  const calls = [];
  const m = resendMailer({ apiKey: 're_test', from: FROM, fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response('{"id":"em_1"}'); } });
  assert.deepEqual(await m.send({ to: 'a@b.dev', subject: 'S', text: 'T', idempotencyKey: 'f1' }), { id: 'em_1' });
  assert.equal(calls[0].init.headers['idempotency-key'], 'f1');
});

// ── review fixes: bounded reads, From and address shapes, config ───────────

// Wraps each fetch answer so the test sees how many (already decompressed)
// bytes the mailer pulled from the body and whether it cancelled it.
function counted(fetchImpl) {
  const seen = [];
  const wrapped = async (url, init) => {
    const r = await fetchImpl(url, init);
    const s = { bytes: 0, cancelled: 0, ended: false };
    seen.push(s);
    if (!r.body) return r;
    const up = r.body.getReader();
    const body = new ReadableStream({
      async pull(ctl) {
        const { done, value } = await up.read();
        if (done) { s.ended = true; ctl.close(); return; }
        s.bytes += value.byteLength;
        ctl.enqueue(value);
      },
      cancel(reason) { s.cancelled++; return up.cancel(reason); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: r.status, headers: r.headers });
  };
  return { fetchImpl: wrapped, seen };
}

async function streamBody(res, status, prefix, total, suffix) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.write(prefix);
  const chunk = Buffer.alloc(64 * 1024, 0x78);
  for (let sent = 0; sent < total && !res.destroyed; sent += chunk.length) {
    if (!res.write(chunk)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
  }
  if (!res.destroyed) res.end(suffix);
}

test('SES bounded reads: oversized, streamed and gzip-bomb answers are cut at the cap and cancelled; a tagged error or a 3xx is never read', async () => {
  const ses = await fakeSes();
  const c = creds();
  ses.creds = c;
  const { fetchImpl, seen } = counted(ses.fetchImpl);
  const m = sesMailer({ region: 'af-south-1', ...c, from: FROM, fetchImpl, now: CLOCK });
  const pad = (n) => 'x'.repeat(n);
  const bomb = (head) => gzipSync(Buffer.concat([Buffer.from(`${head},"pad":"`), Buffer.alloc(32 * 1024 * 1024, 0x30), Buffer.from('"}')]));
  const okBomb = bomb('{"MessageId":"ses-msg-1"');
  const errBomb = bomb('{"__type":"MessageRejected"');
  assert.ok(okBomb.length < 256 * 1024, 'the bomb is small on the wire');
  const json = (res, status, text, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(text); };
  const cases = [
    ['200, 64 KiB with a MessageId', (res) => json(res, 200, JSON.stringify({ MessageId: 'ses-msg-1', pad: pad(64 * 1024) })), 'SES answer was not understood', { cancelled: 1 }],
    ['200, 16 MiB streamed', (res) => streamBody(res, 200, '{"MessageId":"ses-msg-1","pad":"', 16 * 1024 * 1024, '"}'), 'SES answer was not understood', { cancelled: 1, under: 1024 * 1024 }],
    ['200, gzip bomb (32 MiB inflated)', (res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(okBomb); }, 'SES answer was not understood', { cancelled: 1, under: 1024 * 1024 }],
    ['500, gzip bomb', (res) => { res.writeHead(500, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(errBomb); }, 'SES answered 500', { cancelled: 1, under: 1024 * 1024 }],
    ['400, 64 KiB untagged', (res) => json(res, 400, JSON.stringify({ __type: 'MessageRejected', pad: pad(64 * 1024) })), 'SES answered 400', { cancelled: 1 }],
    ['400, 16 MiB streamed untagged', (res) => streamBody(res, 400, '{"__type":"MessageRejected","pad":"', 16 * 1024 * 1024, '"}'), 'SES answered 400', { cancelled: 1, under: 1024 * 1024 }],
    ['400 tagged by header, 64 KiB body', (res) => json(res, 400, JSON.stringify({ message: pad(64 * 1024) }), { 'x-amzn-errortype': 'MessageRejectedException' }), 'SES answered 400 (MessageRejected)', { cancelled: 1, bytes: 0 }],
    ['302 with a 64 KiB body', (res) => { res.writeHead(302, { location: 'https://evil.example/' }); res.end(pad(64 * 1024)); }, 'SES answered 302', { cancelled: 1, bytes: 0 }],
    ['400, small JSON body tag still read', (res) => json(res, 400, JSON.stringify({ __type: 'com.amazonaws.sesv2#MessageRejectedException' })), 'SES answered 400 (MessageRejected)', {}],
    ['200, small answer still read', (res) => json(res, 200, JSON.stringify({ MessageId: 'ses-msg-1' })), null, {}],
  ];
  try {
    ses.mode = 'custom';
    for (const [what, handler, text, want] of cases) {
      ses.custom = handler;
      const out = await m.send({ to: 'jo@example.com', subject: 'S', text: 'T' }).then((r) => r, (e) => e);
      if (text === null) assert.deepEqual(out, { id: 'ses-msg-1' }, what);
      else assert.equal(out?.message, text, what);
      const s = seen.at(-1);
      if ('cancelled' in want) assert.equal(s.cancelled, want.cancelled, `${what}: body cancelled`);
      if ('bytes' in want) assert.equal(s.bytes, want.bytes, `${what}: body never read`);
      if ('under' in want) assert.ok(s.bytes < want.under, `${what}: read ${s.bytes} bytes`);
      assert.equal(s.ended, text === null || what.includes('small'), `${what}: read to the end only when small`);
    }
  } finally {
    await ses.close();
  }
});

test('SES bounded reads: body cancel spied on the tag path and the 3xx path (fake fetch)', async () => {
  for (const [status, headers, text] of [[400, { 'x-amzn-errortype': 'ThrottlingException' }, 'SES answered 400 (Throttling)'], [301, {}, 'SES answered 301'], [307, {}, 'SES answered 307']]) {
    let cancels = 0;
    let pulls = 0;
    const fetchImpl = async () => {
      const res = new Response(new ReadableStream({ pull(ctl) { pulls++; ctl.enqueue(new Uint8Array(1024)); } }, { highWaterMark: 0 }), { status, headers });
      const cancel = res.body.cancel.bind(res.body);
      res.body.cancel = (r) => { cancels++; return cancel(r); };
      return res;
    };
    const m = sesMailer({ region: 'af-south-1', ...creds(), from: FROM, fetchImpl, now: CLOCK });
    const err = await Promise.race([m.send({ to: 'jo@example.com', subject: 'S', text: 'T' }).then(() => null, (e) => e), new Promise((r) => setTimeout(() => r(new Error('hung')), 3000))]);
    assert.equal(err?.message, text);
    assert.equal(cancels, 1, `${status}: cancel called`);
    assert.equal(pulls, 0, `${status}: body never pulled`);
  }
});

test('SES bounded reads: readBounded caps decompressed bytes, cancels at the cap, and a stalled body is cut by the signal', async () => {
  const { readBounded } = mailerModule;
  assert.equal(typeof readBounded, 'function', 'mailer.js exports readBounded');
  const bytes = (n) => new Uint8Array(n).fill(0x61);
  assert.equal(await readBounded(new Response('{"a":1}'), 8192), '{"a":1}');
  assert.equal(await readBounded(new Response(bytes(8192)), 8192), 'a'.repeat(8192), 'exactly the cap is fine');
  assert.equal(await readBounded(new Response(bytes(8193)), 8192), null, 'one byte over is not');
  assert.equal(await readBounded(new Response(null), 8192), '', 'no body');
  let cancelled = 0;
  let pulled = 0;
  const endless = new ReadableStream({ pull(ctl) { pulled += 1024; ctl.enqueue(bytes(1024)); }, cancel() { cancelled++; } });
  assert.equal(await readBounded(new Response(endless), 8192), null);
  assert.equal(cancelled, 1, 'cancelled at the cap');
  assert.ok(pulled <= 16 * 1024, `pulled ${pulled}`);
  // A body that never ends: the signal bounds it and the body is cancelled.
  let stalledCancel = 0;
  const stalled = new ReadableStream({ start(ctl) { ctl.enqueue(bytes(10)); }, cancel() { stalledCancel++; } });
  const t0 = Date.now();
  const err = await readBounded(new Response(stalled), 8192, AbortSignal.timeout(50)).then(() => null, (e) => e);
  assert.equal(err?.name, 'TimeoutError');
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(stalledCancel, 1, 'the stalled body is cancelled');
  const pre = AbortSignal.abort(new DOMException('t', 'TimeoutError'));
  assert.equal((await readBounded(new Response(new ReadableStream({})), 8192, pre).then(() => null, (e) => e))?.name, 'TimeoutError', 'an already-fired signal');
});

test('SES bounded reads: through the mailer a stalled body is bounded by the send timeout on both paths', async () => {
  const orig = AbortSignal.timeout;
  AbortSignal.timeout = () => orig.call(AbortSignal, 50);
  try {
    for (const [status, text] of [[200, 'SES request timed out'], [500, 'SES answered 500']]) {
      let cancels = 0;
      const fetchImpl = async () => new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new Uint8Array(4)); }, cancel() { cancels++; } }), { status });
      const m = sesMailer({ region: 'af-south-1', ...creds(), from: FROM, fetchImpl, now: CLOCK });
      const err = await Promise.race([m.send({ to: 'jo@example.com', subject: 'S', text: 'T' }).then(() => null, (e) => e), new Promise((r) => setTimeout(() => r(new Error('hung')), 3000))]);
      assert.equal(err?.message, text, String(status));
      assert.equal(cancels, 1, `${status}: stalled body cancelled`);
    }
  } finally {
    AbortSignal.timeout = orig;
  }
});

test('SES error tags: RequestExpired (clock skew) is allowlisted, from the header or the body', async () => {
  for (const res of [
    () => new Response('{}', { status: 400, headers: { 'x-amzn-errortype': 'RequestExpired:http://internal' } }),
    () => new Response(JSON.stringify({ __type: 'com.amazonaws.sesv2#RequestExpiredException' }), { status: 400 }),
  ]) {
    const m = sesMailer({ region: 'af-south-1', ...creds(), from: FROM, fetchImpl: async () => res(), now: CLOCK });
    assert.equal((await m.send({ to: 'jo@example.com', subject: 'S', text: 'T' }).then(() => null, (e) => e))?.message, 'SES answered 400 (RequestExpired)');
  }
});

test('config: BOARD_SES_FROM_FORMAT counts as a BOARD_SES_* variable; ses with a Resend key is refused', () => {
  const c = creds();
  const notSes = /^Error: BOARD_SES_\* is set but BOARD_MAIL_PROVIDER is not ses$/;
  for (const v of ['junk', 'display', 'bare']) {
    assert.throws(() => validateConfig(accountsBase({ sesFromFormat: v })), notSes, v);
    assert.throws(() => validateConfig(accountsBase({ mailProvider: 'resend', resendApiKey: 're_x', mailFrom: 'a@b.dev', sesFromFormat: v })), notSes, `resend + ${v}`);
  }
  const noSes = Object.fromEntries(Object.entries(sesEnv(c)).filter(([name]) => !/^BOARD_(SES_|MAIL_PROVIDER)/.test(name)));
  assert.throws(() => loadConfig({ ...noSes, BOARD_SES_FROM_FORMAT: 'junk' }), notSes);
  // resend + the other SES variables still errors as before
  assert.throws(() => validateConfig(accountsBase({ mailProvider: 'resend', resendApiKey: 're_x', mailFrom: 'a@b.dev', sesRegion: 'af-south-1' })), notSes);
  // The default still applies where it is used.
  const cfg = loadConfig(sesEnv(c));
  assert.equal(cfg.sesFromFormat, null);
  assert.doesNotThrow(() => validateConfig(cfg));
  // ses + a Resend key: refused at boot with a fixed text that never repeats it.
  const key = ['re', randomBytes(12).toString('hex')].join('_');
  const err = (() => { try { loadConfig(sesEnv(c, { BOARD_RESEND_API_KEY: key })); } catch (e) { return e; } return null; })();
  assert.match(String(err), /^Error: BOARD_RESEND_API_KEY is set but BOARD_MAIL_PROVIDER is ses$/);
  assert.ok(!String(err).includes(key));
});

test('createMailer: an unset From format means display', async () => {
  const c = creds();
  const calls = [];
  const cfg = loadConfig(sesEnv(c));
  const m = createMailer(cfg, { fetchImpl: async (u, init) => { calls.push(init); return new Response('{"MessageId":"x"}'); }, now: CLOCK });
  await m.send({ to: 'jo@example.com', subject: 'S', text: 'T' });
  assert.equal(JSON.parse(calls[0].body).FromEmailAddress, FROM);
});

test('addresses: strict ASCII shape for SES (apostrophe allowed); dot rules on the local part; the mailer refuses the rest before sending', async () => {
  const { isMailAddress } = await import('../config.js');
  const good = ["o'brien@example.com", 'first.last+tag@sub.example.co.za', 'a_b-c@x-y.io', 'UPPER@EXAMPLE.COM', "!#$%&'*+/=?^_`{|}~-@example.com", 'a@b.co'];
  const bad = [
    'jö@example.com', 'jo@exämple.com', 'jo@例え.jp', 'a(b)@x.com', 'a@[1.2.3.4]', 'a..b@example.com', '.a@example.com', 'a.@example.com', '.@example.com',
    'a@localhost', 'a@-x.com', 'a@x-.com', 'a@x..com', 'a@x.com.', 'a@.x.com', '"q"@b.dev', 'a b@x.com', 'a<b@x.com', 'a>b@x.com', 'a,b@x.com', 'a;b@x.com', 'a\\b@x.com',
    'a:b@x.com', '@x.com', 'a@', 'a@b@c.com', 'a\t@x.com', 'a@x.com\n', 'a @x.com', `${'a'.repeat(250)}@b.dev`, '', null, 7,
  ];
  for (const a of good) assert.equal(isMailAddress(a), true, JSON.stringify(a));
  for (const a of bad) assert.equal(isMailAddress(a), false, JSON.stringify(a));
  let fetched = 0;
  const m = sesMailer({ region: 'af-south-1', ...creds(), from: FROM, fetchImpl: async () => { fetched++; return new Response('{"MessageId":"x"}'); }, now: CLOCK });
  assert.deepEqual(await m.send({ to: "o'brien@example.com", subject: 'S', text: 'T' }), { id: 'x' });
  for (const to of ['jö@example.com', 'a(b)@x.com', 'a@[1.2.3.4]', 'a..b@example.com']) {
    assert.equal((await m.send({ to, subject: 'S', text: 'T' }).then(() => null, (e) => e))?.message, 'SES mail refused: bad recipient', to);
  }
  assert.equal(fetched, 1);
});

test('addresses through the sign-in route: the same 200 for an address SES takes and one it refuses (no enumeration); only the first is mailed', async () => {
  const ses = await fakeSes();
  ses.mode = 'ok';
  const lines = [];
  const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
  const mailer = sesMailer({ region: 'af-south-1', ...creds(), from: FROM, fetchImpl: ses.fetchImpl, now: CLOCK });
  const h = await startAccounts({ mailer, log });
  const sendable = ["o'brien@example.com", 'jo@example.com', 'alice@dev.local'];
  const refused = ['jö@example.com', 'a(b)@x.com', 'a@[1.2.3.4]', 'a..b@example.com'];
  try {
    const shapes = new Set();
    for (const email of [...sendable, ...refused]) {
      const r = await h.start(email);
      assert.equal(r.status, 200, email);
      shapes.add(JSON.stringify({ keys: Object.keys(r.body).sort(), expires: r.body.expires_in, cookies: r.cookies.length, type: r.headers.get('content-type') }));
    }
    assert.equal(shapes.size, 1, 'one answer shape for every address');
    const failed = () => lines.filter((l) => l.includes('sign-in mail failed'));
    for (let i = 0; i < 200 && (ses.requests.length < sendable.length || failed().length < refused.length); i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(ses.requests.map((q) => JSON.parse(q.body).Destination.ToAddresses[0]).sort(), [...sendable].sort());
    assert.equal(failed().length, refused.length);
    for (const l of failed()) assert.equal(JSON.parse(l).err, 'SES mail refused: bad recipient');
    for (const a of refused) assert.ok(!lines.join('\n').includes(a), 'the refused address is not logged');
  } finally {
    await h.close();
    await ses.close();
  }
});

test('From display: the address inside <…> passes the same check, and the name must be plain ASCII or a clean quoted string', () => {
  assert.equal(sesFromAddress(FROM, 'display'), FROM, 'our configured From');
  for (const ok of ['"Plexiform, Inc." <no-reply@plexiform.dev>', '=?UTF-8?B?UGzDq3hpZm9ybQ==?= <no-reply@plexiform.dev>', "O'Brien Mail <o'brien@plexiform.dev>", '<no-reply@plexiform.dev>', 'Plexiform<no-reply@plexiform.dev>', 'no-reply@plexiform.dev']) {
    assert.equal(sesFromAddress(ok, 'display'), ok, ok);
  }
  for (const bad of ['Plëxiform <no-reply@plexiform.dev>', 'A "B" <x@y.dev>', '"A\\"B" <x@y.dev>', '"A\\B" <x@y.dev>', 'A,B <x@y.dev>', 'A: B <x@y.dev>', 'A <a(b)@x.com>', 'A <jö@x.com>', 'A <a@[1.2.3.4]>', 'A <a..b@x.com>',
    'Plexiform no-reply@plexiform.dev', 'a(b)@x.com', 'A <b@c.dev> <e@f.dev>', 'A <b@c.dev> trailing', 'A <>']) {
    assert.equal(sesFromAddress(bad, 'display'), null, bad);
  }
  assert.throws(() => validateConfig(sesBase({ mailFrom: 'Plëxiform <no-reply@plexiform.dev>' })), /^Error: BOARD_MAIL_FROM display name must be plain ASCII or RFC 2047 words$/);
  assert.throws(() => validateConfig(sesBase({ mailFrom: 'A "B" <x@y.dev>' })), /^Error: BOARD_MAIL_FROM display name must be plain ASCII or RFC 2047 words$/);
  assert.throws(() => validateConfig(sesBase({ mailFrom: 'A <a(b)@x.com>' })), /^Error: BOARD_MAIL_FROM is not a usable From address$/);
  assert.throws(() => validateConfig(sesBase({ mailFrom: 'A <a(b)@x.com>', sesFromFormat: 'bare' })), /^Error: BOARD_MAIL_FROM is not a usable From address$/);
  assert.doesNotThrow(() => validateConfig(sesBase({ mailFrom: 'Plëxiform <no-reply@plexiform.dev>', sesFromFormat: 'bare' })), 'bare never sends the name');
  assert.doesNotThrow(() => loadConfig(sesEnv(creds())), 'Plexiform <no-reply@plexiform.dev> passes at boot');
  assert.throws(() => sesMailer({ region: 'af-south-1', ...creds(), from: 'Plëxiform <no-reply@plexiform.dev>', fetchImpl: async () => new Response('{}'), now: CLOCK }), /^Error: SES mailer: bad From$/);
});
