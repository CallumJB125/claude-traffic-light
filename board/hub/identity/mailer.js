// Mailer (D55): send({to, subject, text}) → Promise. Three implementations:
// Resend over its HTTP API (BOARD_RESEND_API_KEY + BOARD_MAIL_FROM), a console
// mailer for a loopback hub (prints to stderr for the person at the terminal,
// never through the log), and an outbox that records mails for tests.
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

export function createMailer(config, { fetchImpl } = {}) {
  if (config.resendApiKey) return resendMailer({ apiKey: config.resendApiKey, from: config.mailFrom, fetchImpl });
  return consoleMailer();
}
