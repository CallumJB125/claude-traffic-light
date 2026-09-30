// Mailer (D55, D66): send({to, subject, text}) → Promise. Optional: with none
// the hub sends no mail at all (email codes are off, invites are shared by the
// inviter). Three implementations: Resend over its HTTP API
// (BOARD_RESEND_API_KEY + BOARD_MAIL_FROM), a console mailer for a loopback
// hub that is not exposed (BOARD_CONSOLE_MAILER=1; prints to stderr for the
// person at the terminal, never through the log), and an outbox for tests.

import { isExposed } from '../config.js';
// Plain text only: no HTML built from user input (design §9.2).

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

export function resendMailer({ apiKey, from, fetchImpl = globalThis.fetch }) {
  return {
    kind: 'resend',
    async send({ to, subject, text, idempotencyKey = null }) {
      const res = await fetchImpl(RESEND_URL, {
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
export function createMailer(config, { fetchImpl } = {}) {
  if (config.resendApiKey) return resendMailer({ apiKey: config.resendApiKey, from: config.mailFrom, fetchImpl });
  if (config.consoleMailer && !isExposed(config)) return consoleMailer();
  return null;
}
