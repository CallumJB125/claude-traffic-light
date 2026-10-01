// Mailer (D55, D66): send({to, subject, text}) → Promise. Optional: with none
// the hub sends no mail at all (email codes are off, invites are shared by the
// inviter). Four implementations: Resend over its HTTP API
// (BOARD_RESEND_API_KEY + BOARD_MAIL_FROM), Amazon SES v2 signed with SigV4
// (BOARD_MAIL_PROVIDER=ses, D66 addendum), a console mailer for a loopback
// hub that is not exposed (BOARD_CONSOLE_MAILER=1; prints to stderr for the
// person at the terminal, never through the log), and an outbox for tests.

import { createHash, createHmac } from 'node:crypto';
import { isExposed, mailProvider, isMailAddress, sesFromAddress, SES_REGION, SES_ACCESS_KEY_ID, PRINTABLE_256, PRINTABLE_4096 } from '../config.js';
// Plain text only: no HTML built from user input (design §9.2).

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

export function resendMailer({ apiKey, from, fetchImpl = globalThis.fetch }) { // privacy-flow: hub-server
  return {
    kind: 'resend',
    async send({ to, subject, text, idempotencyKey = null }) {
      const res = await fetchImpl(RESEND_URL, { // privacy-flow: hub-server
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Resend answered ${res.status}`);
      const body = await res.json().catch(() => ({}));
      return { id: body.id ?? null };
    },
  };
}

// ── Amazon SES v2 SendEmail, AWS Signature Version 4 ─────────────────────
// https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html

const SES_PATH = '/v2/email/outbound-emails';
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s).digest();
// Error types SES may name that help an operator; anything else adds no tag,
// so nothing SES or a middlebox says reaches the log verbatim.
const SES_ERROR_TAGS = new Set([
  'AccessDenied', 'AccountSuspended', 'BadRequest', 'ExpiredToken', 'InvalidClientTokenId', 'InvalidSignature', 'LimitExceeded',
  'MailFromDomainNotVerified', 'MessageRejected', 'NotFound', 'RequestExpired', 'SendingPaused', 'SignatureDoesNotMatch', 'Throttling', 'TooManyRequests', 'UnrecognizedClient',
]);
// An SES answer is a few hundred bytes; anything past this is not SES and is not read.
const SES_READ_MAX = 8192;
const SUBJECT_BAD = /[\p{C}\u2028\u2029]/u;
const MESSAGE_ID = /^[\x21-\x7e]{1,256}$/;

export function deriveSigningKey(secret, yyyymmdd, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, yyyymmdd), region), service), 'aws4_request');
}

/** SigV4 over a request with an empty query. `headers` must include host and x-amz-date; every one given is signed. */
export function signV4({ method, path, headers, payloadHash, amzDate, region, service, accessKeyId, secret }) {
  const canon = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/ +/g, ' ')])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = canon.map(([k]) => k).join(';');
  const canonicalRequest = [method, path, '', ...canon.map(([k, v]) => `${k}:${v}`), '', signedHeaders, payloadHash].join('\n');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', deriveSigningKey(secret, date, region, service)).update(stringToSign).digest('hex');
  return {
    canonicalRequest, stringToSign, signedHeaders, signature,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

const sesTag = (v) => {
  if (typeof v !== 'string') return null;
  const name = v.split(':')[0].split('#').pop().replace(/Exception$/, '');
  return SES_ERROR_TAGS.has(name) ? name : null;
};
// Not awaited: a body whose cancel never settles must not hold the send open.
const discard = (res) => { res?.body?.cancel?.().catch(() => {}); };

/**
 * The body as text, or null past `max` bytes. The cap counts the bytes the
 * stream yields, which fetch has already decompressed: that is what bounds a
 * gzip bomb. Past the cap, on an error or when `signal` fires, the body is
 * cancelled; the signal also bounds a body that never ends whatever fetchImpl
 * did with it.
 */
export async function readBounded(res, max, signal = null) {
  const body = res?.body;
  if (!body) return '';
  const reader = body.getReader();
  const stop = () => { reader.cancel().catch(() => {}); };
  let onAbort = null;
  const aborted = signal && new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted?.catch(() => {});
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      if (done) return Buffer.concat(chunks, size).toString('utf8');
      if (!(value instanceof Uint8Array)) throw new TypeError('body chunk is not bytes');
      size += value.byteLength;
      if (size > max) {
        stop();
        return null;
      }
      chunks.push(value);
    }
  } catch (e) {
    stop();
    throw e;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function sesErrorTag(res, signal) {
  const tag = sesTag(res.headers?.get?.('x-amzn-errortype'));
  if (tag) {
    discard(res);
    return tag;
  }
  try {
    const text = await readBounded(res, SES_READ_MAX, signal);
    if (text == null) return null;
    const body = JSON.parse(text);
    return sesTag(body?.__type) ?? sesTag(body?.code);
  } catch {
    return null;
  }
}
const timedOut = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

// Every error below is a fresh Error with a fixed text: never a wrapped fetch
// error (which can carry the request), a response body or a header.
export function sesMailer({ region, accessKeyId, secretAccessKey, sessionToken = null, from, fromFormat = 'display', fetchImpl = globalThis.fetch, now = () => new Date() }) { // privacy-flow: hub-server
  if (typeof region !== 'string' || !SES_REGION.test(region)) throw new Error('SES mailer: bad region');
  if (typeof accessKeyId !== 'string' || !SES_ACCESS_KEY_ID.test(accessKeyId) || typeof secretAccessKey !== 'string' || !PRINTABLE_256.test(secretAccessKey)
    || (sessionToken != null && (typeof sessionToken !== 'string' || !PRINTABLE_4096.test(sessionToken)))) throw new Error('SES mailer: bad credentials');
  const fromAddress = sesFromAddress(from, fromFormat);
  if (!fromAddress) throw new Error('SES mailer: bad From');
  const host = `email.${region}.amazonaws.com`;
  const url = `https://${host}${SES_PATH}`;
  return {
    kind: 'ses',
    // SES v2 has no idempotency header: the key is accepted for the shared signature and not sent.
    async send({ to, subject, text } = {}) {
      if (!isMailAddress(to)) throw new Error('SES mail refused: bad recipient');
      if (typeof subject !== 'string' || !subject || subject.length > 200 || SUBJECT_BAD.test(subject)) throw new Error('SES mail refused: bad subject');
      if (typeof text !== 'string' || text.length > 100_000 || text.includes('\0')) throw new Error('SES mail refused: bad text');
      const body = JSON.stringify({
        FromEmailAddress: fromAddress,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } },
      });
      const date = now();
      if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('SES mailer: clock is not usable');
      const amzDate = date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
      const payloadHash = sha256hex(body);
      const headers = {
        'content-type': 'application/json',
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
      };
      const { authorization } = signV4({ method: 'POST', path: SES_PATH, headers: { ...headers, host }, payloadHash, amzDate, region, service: 'ses', accessKeyId, secret: secretAccessKey });
      const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
      let res;
      try {
        res = await fetchImpl(url, { method: 'POST', headers: { ...headers, authorization }, body, redirect: 'manual', signal }); // privacy-flow: hub-server
      } catch (e) {
        throw new Error(timedOut(e) ? 'SES request timed out' : 'SES request failed');
      }
      const status = Number.isInteger(res?.status) ? res.status : 0;
      if (status < 200 || status > 299) {
        const tag = status >= 400 ? await sesErrorTag(res, signal) : null;
        if (status < 400) discard(res);
        throw new Error(`SES answered ${status}${tag ? ` (${tag})` : ''}`);
      }
      let raw;
      try {
        raw = await readBounded(res, SES_READ_MAX, signal);
      } catch (e) {
        throw new Error(timedOut(e) ? 'SES request timed out' : 'SES request failed');
      }
      if (raw == null) throw new Error('SES answer was not understood');
      let id = null;
      try { id = JSON.parse(raw)?.MessageId; } catch { /* below */ }
      if (typeof id !== 'string' || !MESSAGE_ID.test(id)) throw new Error('SES answer was not understood');
      return { id };
    },
  };
}

export function consoleMailer({ write = (s) => process.stderr.write(s) } = {}) {
  return {
    kind: 'console',
    async send({ to, subject, text }) {
      write(`\n── mail (console mailer, loopback only) ──\nTo: ${to}\nSubject: ${subject}\n\n${text}\n──\n`);
      return { id: null };
    },
  };
}

export function outboxMailer() {
  const sent = [];
  return {
    kind: 'outbox',
    sent,
    async send(mail) {
      sent.push({ ...mail });
      return { id: String(sent.length) };
    },
    last(to) { return [...sent].reverse().find((m) => !to || m.to === to) ?? null; },
  };
}

/** The configured mailer, or null (no mailer). Never the console one on an exposed hub. */
export function createMailer(config, { fetchImpl, now } = {}) {
  const provider = mailProvider(config);
  if (provider === 'ses') {
    // The credentials are non-enumerable on a loaded config; a spread copy loses them, and that must not mean "no mail" silently.
    if (!config.sesRegion || !config.sesAccessKeyId || !config.sesSecretAccessKey) throw new Error('SES mailer: missing credentials');
    return sesMailer({
      region: config.sesRegion, accessKeyId: config.sesAccessKeyId, secretAccessKey: config.sesSecretAccessKey, sessionToken: config.sesSessionToken ?? null,
      from: config.mailFrom, fromFormat: config.sesFromFormat ?? 'display', fetchImpl, ...(now ? { now } : {}),
    });
  }
  if (provider === 'resend' && config.resendApiKey) return resendMailer({ apiKey: config.resendApiKey, from: config.mailFrom, fetchImpl });
  if (config.consoleMailer && !isExposed(config)) return consoleMailer();
  return null;
}
