// Test helpers for the Slack connector: recorded fixtures, signed requests,
// a fake slack.com / hooks.slack.com, and a stub ctx with the framework's
// slice A/B/C shapes for the unit tests:
//   deliver()   F1 parseBody after verify, F2 ackBody, F2b ackEarly as a
//               function, the two dedupe keys (connector key + body hash)
//   stubCtx()   F5 ctx.boards() → [{id, title}] and ctx.card(id), D98
//               ctx.memberFor(user) → member_id | null, F6 board-only
//               createCard with durable request_id idempotency, F8
//               act(…, {subject}) with 5 cards an hour per subject,
//               connection.settings.provider / pinned as D97 promotion
//               writes them, C2 ctx.linkState and an optional ctx.hubUrl
// slack-e2e.test.js drives the real registry instead.
// Secrets and tokens are made at run time; no token-shaped literal is here.

import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { sign } from '../integrations/slack/webhook.js';

const FIXTURES = new URL('./fixtures/slack/', import.meta.url);
export const raw = (name) => readFileSync(new URL(name, FIXTURES));
export const fixture = (name) => JSON.parse(raw(name).toString('utf8'));

export const TEAM = 'T0TEAM1';
export const APP = 'A0APP01';
export const CONFIG = Object.freeze({ team_id: TEAM, app_id: APP, client_id: '1234567890.9876543210', bot_user_id: 'U0BOT001', hub_url: 'https://board.example.test' });
// What D97 promotion pins (settings.pinned): the prepare match, never patched.
export const PINNED = Object.freeze({ app_id: APP, client_id: CONFIG.client_id });
// settings.provider as promotion writes it (C1): prepare's settings, exchange's,
// every match key, and the hub's origin (diagnostic only; never a link base).
export const PROVIDER = Object.freeze({ ...PINNED, bot_user_id: 'U0BOT001', hub_url: 'https://board.example.test' });
export const MARKERS = Object.freeze(['slackfixture-marker-body-91c2', 'slackfixture-marker-action-22d0']);

const digits = (n) => [...randomBytes(n)].map((b) => String(b % 10)).join('');
export const botToken = () => `${['xo', 'xb'].join('')}-${digits(12)}-${digits(13)}-${randomBytes(12).toString('hex')}`;
export const signingSecret = () => randomBytes(16).toString('hex');
export const clientSecret = () => randomBytes(16).toString('hex');

export const nowS = () => Math.floor(Date.now() / 1000);

/** A signed Slack request: {headers, rawBody}. */
export function signed(secret, body, { contentType, ts = nowS(), sig } = {}) {
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const type = contentType ?? (rawBody[0] === 0x7b ? 'application/json' : 'application/x-www-form-urlencoded');
  return { headers: { 'content-type': type, 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig ?? sign(secret, ts, rawBody) }, rawBody };
}
/** An interaction payload as Slack posts it: payload=<JSON>, form-encoded. */
export const interactionBody = (p) => Buffer.from(new URLSearchParams({ payload: JSON.stringify(p) }).toString());
/** A slash command form, from the recorded fixture with fields overridden. */
export function commandBody(over = {}) {
  const f = new URLSearchParams(raw('slash-command-todo.form').toString('utf8'));
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return Buffer.from(f.toString());
}

/**
 * A fake slack.com / hooks.slack.com: records every call, answers recorded
 * shapes. `answer(method, init)` may answer first (connect and identity
 * calls in the e2e tests); undefined falls through.
 */
export function fakeSlack({ permalink = 'https://acme.slack.com/archives/C0CHAN1/p1759312700000200', fail = {}, answer = null } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ url: String(url), host: u.hostname, method: u.pathname.replace(/^\/api\//, ''), headers: { ...(init.headers ?? {}) }, body });
    const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'hooks.slack.com') return new Response('ok', { status: 200 });
    const m = u.pathname.replace(/^\/api\//, '');
    if (fail[m]) return json({ ok: false, error: fail[m] });
    const own = await answer?.(m, init);
    if (own !== undefined) return json(own);
    if (m === 'views.open') return json({ ok: true, view: { id: 'V0VIEW01' } });
    if (m === 'chat.getPermalink') return json({ ok: true, channel: 'C0CHAN1', permalink });
    if (m === 'chat.postEphemeral') return json({ ok: true, message_ts: '1759313000.000100' });
    return json({ ok: false, error: 'unknown_method' });
  };
  return { fetch, calls, replies: () => calls.filter((c) => c.host === 'hooks.slack.com').map((c) => JSON.parse(c.body)), api: (m) => calls.filter((c) => c.method === m) };
}

export const HUB = 'https://board.example.test';

/**
 * A stub ctx with the slice A/B/C shapes. external_id is the workspace the
 * connection was made for; provider and pinned are what promotion wrote
 * (null: none); config is the admin's. linked users can act; viewers are
 * linked but can't (linkState 'unavailable'). hubUrl is absent unless given.
 */
export function stubCtx({ secrets, config = {}, pinned = PINNED, externalId = TEAM, provider = PROVIDER, hubUrl, targetBoardId = 'board-1', linked = { U0ALICE: 'member-alice' }, viewers = [], boards = [{ id: 'board-1', title: 'Main' }, { id: 'board-2', title: 'Ops' }], slack = fakeSlack(), subjectLimit = 5 } = {}) {
  const byRequest = new Map();
  const cards = new Map();
  const links = new Map();
  const acts = [];
  const perSubject = new Map();
  let next = 1;
  const fail = (code) => { throw Object.assign(new Error(code), { code }); };
  const ctx = {
    acts, cards, links, slack,
    connection: { id: 'conn-slack', target_board_id: targetBoardId, external_id: externalId, settings: { autonomy: {}, config: { channel_id: 'C0CHAN1', ...config }, ...(pinned ? { pinned } : {}), ...(provider ? { provider } : {}) } },
    ...(hubUrl !== undefined ? { hubUrl } : {}),
    secret: (k) => secrets[k] ?? null,
    fetch: slack.fetch,
    memberFor: (subject) => linked[subject] ?? null,
    linkState: (subject) => (linked[subject] ? 'active' : viewers.includes(subject) ? 'unavailable' : 'none'),
    boards: () => boards,
    boardIds: () => boards.some(b => b.id === ctx.connection.target_board_id) ? [ctx.connection.target_board_id, ...boards.filter(b => b.id !== ctx.connection.target_board_id).map(b => b.id)] : [],
    card: (id) => cards.get(id) ?? null,
    linked: (kind, ext) => links.get(`${kind}:${ext}`) ?? null,
    log: () => {},
    async act(action, meta, run) {
      // F8: subject, when given, is a non-empty string of at most 128 chars.
      if (meta?.subject !== undefined && (typeof meta.subject !== 'string' || !meta.subject || meta.subject.length > 128)) fail('VALIDATION');
      acts.push({ action, meta });
      const out = await run({
        actAs: (member) => ({
          async createCard(boardId, body) {
            if (typeof boardId !== 'string' || !boards.some((b) => b.id === boardId)) fail('NOT_FOUND');
            if (typeof body.request_id !== 'string' || !body.request_id) fail('VALIDATION');
            const prior = byRequest.get(body.request_id);
            if (prior) {
              if (cards.get(prior).board_id !== boardId) fail('CONFLICT');
              return { card: cards.get(prior) };
            }
            // Counted only after an idempotency miss, like the registry's D8 cache.
            if (meta?.subject) {
              const n = (perSubject.get(meta.subject) ?? 0) + 1;
              if (n > subjectLimit) fail('RATE_LIMITED');
              perSubject.set(meta.subject, n);
            }
            const card = { id: `card-${next}`, key: `BDL-${next}`, title: body.title, body: body.body, board_id: boardId, column_name: 'todo', created_by: member };
            next += 1;
            cards.set(card.id, card);
            byRequest.set(body.request_id, card.id);
            return { card };
          },
        }),
        link: (cardId, kind, ext, url) => { if (!links.has(`${kind}:${ext}`)) links.set(`${kind}:${ext}`, cardId); void url; },
      });
      return { done: true, decision: 'auto', result: out };
    },
  };
  return ctx;
}

/**
 * The webhook pipeline as slices A and C run it: verify → parseBody → lease
 * both keys → ackEarly / ackBody → handler. A handler failure after an early
 * ack is dead-lettered (recorded), the delivery stays done (C2) and
 * onAckedFailure gets a short code and the ctx's fetch; a late failure is
 * released.
 */
export function shimPipeline(spec, { secrets, ctxOf }) {
  const done = new Set();
  const deadLetters = [];
  async function deliver({ headers, rawBody }) {
    const v = spec.verify({ headers, rawBody, secrets, now: Date.now() });
    if (!v.ok) return { status: 401, reason: v.reason };
    let payload;
    try { payload = spec.parseBody({ rawBody, headers }); } catch { return { status: 400 }; }
    // F1 (final): sync, a plain object, no top-level prototype keys.
    const plain = payload !== null && typeof payload === 'object' && !Array.isArray(payload) && [Object.prototype, null].includes(Object.getPrototypeOf(payload));
    if (!plain || ['__proto__', 'constructor', 'prototype'].some((k) => Object.hasOwn(payload, k))) return { status: 400 };
    const keys = [v.dedupe_key, `body:${createHash('sha256').update(rawBody).digest('hex')}`];
    if (keys.some((k) => done.has(k))) return { status: 200, duplicate: true };
    for (const k of keys) done.add(k);
    // F2b (final): only a returned plain true is early; a throw or a Promise is late.
    let early = false;
    try { early = spec.ackEarly === true || (typeof spec.ackEarly === 'function' && spec.ackEarly({ payload, headers }) === true); } catch { early = false; }
    // F2 (final): only for an early ack; a throw, an unserialisable value or over 4096 bytes is an empty 200.
    let body;
    if (early) {
      try {
        const a = spec.ackBody?.({ payload, headers });
        const isPlain = a !== null && typeof a === 'object' && !Array.isArray(a) && Object.getPrototypeOf(a) === Object.prototype;
        const text = typeof a === 'string' ? a : isPlain ? JSON.stringify(a) : undefined;
        body = text !== undefined && Buffer.byteLength(text) <= 4096 ? a : undefined;
      } catch { body = undefined; }
    }
    const ctx = ctxOf();
    const run = Promise.resolve().then(() => spec.handleWebhook({ headers, payload, ctx })).then(() => null, async (e) => {
      const code = e?.code === 'ACTOR_UNAVAILABLE' ? 'actor_unavailable' : e?.healthCode ?? e?.code ?? 'handler_failed';
      deadLetters.push(code);
      if (!early) for (const k of keys) done.delete(k);
      else await spec.onAckedFailure?.({ payload: structuredClone(payload), headers, error_code: code, fetch: ctx.fetch })?.catch(() => {});
      return e;
    });
    if (early) return { status: 200, body, early: true, settled: run };
    const err = await run;
    return err ? { status: 500 } : { status: 200, body };
  }
  return { deliver, deadLetters };
}
