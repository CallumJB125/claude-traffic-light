// Sentry connector (CONTRACT D42 addendum "the Sentry connector"):
// webhook-only. An admin makes a Sentry Internal Integration and pastes its
// client secret, the webhook signing key and the only credential; a new
// issue (issue.created) becomes one todo card on an explicitly routed board.
// Signed issue status/regressions become durable coalesced comments. Critical
// metric alerts create one incident per rule/cooldown bucket; later updates
// match the incident's own link. No outbound request, card move or dispatch.
//
// Go-live gate: not in connectorsFor() on any hub until a real Sentry
// delivery has been checked against verify() over its raw bytes.
//
// Payload fields read (Sentry docs, integration-platform/webhooks/issues/):
// action, data.issue.{id, shortId, culprit, level, project.slug, metadata.type,
// metadata.value, title (only with include_message), count, userCount,
// firstSeen, web_url}; metric_alert fixed ids/projects/date_started and exact
// alert URL only. No actor, query, metric description or stack is persisted.
// Headers sentry-hook-signature, sentry-hook-resource,
// sentry-hook-timestamp (informational). Request-ID is never read.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { defineConnector } from '../connector.js';
import { own } from './text.js';
import { issueEvent, metricEvent } from './events.js';

const CLIENT_KEY_SHAPE = /^[A-Za-z0-9_-]{16,256}$/;
const SIG_RE = /^[0-9a-f]{64}$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const STATE_MAX = 1000;
export const NOTICE = 'Sentry is sending more new issues than this connection\'s card limit allows. New issues are not turned into cards until the limit refills; they are still in Sentry. The count is in this connection\'s Activity.';

const utf8 = new TextDecoder('utf-8', { fatal: true });

// Over valid JSON only. Two parsers that keep a different one of two equal
// keys would read a body verify() passed differently, so such a body is refused.
export function hasDuplicateKeys(text) {
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top?.keys && top.atKey) {
        const key = JSON.parse(text.slice(i, j + 1));
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.atKey = false;
      }
      i = j;
    } else if (ch === '{') stack.push({ keys: new Set(), atKey: true });
    else if (ch === '[') stack.push({ keys: null });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',' && stack.at(-1)?.keys) stack.at(-1).atKey = true;
  }
  return false;
}

export function createSentryConnector({ now = () => Date.now() } = {}) {
  // Per connection, in memory (reset with the process, which also refills
  // every bucket): the card-rule backoff, skipped counts, the day's notice.
  const states = new Map();
  const stateOf = (id) => {
    let st = states.get(id);
    if (!st) {
      if (states.size >= STATE_MAX) states.delete(states.keys().next().value);
      st = { until: 0, noticeDay: null, tsHour: null, skipped: { no_board: { count: 0, hour: null }, card_cap: { count: 0, hour: null } } };
      states.set(id, st);
    }
    return st;
  };

  // Counted per reason, audited at most once per UTC hour with what was skipped since the last audit.
  async function suppressed(ctx, st, reason, t) {
    const r = st.skipped[reason];
    r.count += 1;
    const hour = Math.floor(t / HOUR_MS);
    if (r.hour === hour) return;
    r.hour = hour;
    const n = r.count;
    r.count = 0;
    await ctx.act('sentry.suppressed', { detail: { suppressed: n, reason } }, async () => {});
  }

  // One fixed comment per UTC day, only on an unarchived card this connection made.
  async function notice(ctx, st, t) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (st.noticeDay === day) return;
    st.noticeDay = day;
    const card = ctx.lastCreatedCard();
    if (!card || card.archived) return;
    try {
      await ctx.act('sentry.notice', { card_id: card.id, external_ref: `sentry-notice-${day}` }, (s) => s.actAs(ctx.connection.created_by)
        .comment(card.id, { request_id: `sentry-notice-${day}`, body: NOTICE }));
    } catch (e) {
      // A hint only: the delivery still succeeds (its act() audited the failure).
      ctx.log('sentry suppression notice not posted', { code: typeof e?.code === 'string' ? e.code : 'error' });
    }
  }

  function boardFor(ctx, config, slug) {
    const mapped = own(own(config, 'project_boards'), slug);
    const id = typeof mapped === 'string' ? mapped : own(config, 'default_board_id');
    return typeof id === 'string' && ctx.boardIds().includes(id) ? id : null;
  }

  // The timestamp is unsigned, so it never decides anything: a far one is only worth a line.
  function noteTimestamp(ctx, st, headers, t) {
    const ts = headers?.['sentry-hook-timestamp'];
    if (typeof ts !== 'string' || !/^\d{1,12}$/.test(ts) || Math.abs(Number(ts) * 1000 - t) <= DAY_MS) return;
    const hour = Math.floor(t / HOUR_MS);
    if (st.tsHour === hour) return;
    st.tsHour = hour;
    ctx.log('sentry webhook timestamp is far from the hub clock');
  }

  return defineConnector({
    id: 'sentry',
    name: 'Sentry',
    scopes: ['event:read'],
    secrets: ['webhook_secret'],
    hosts: [],
    showsWebhookUrl: true,
    dailyCardCap: 100,
    configKeys: ['default_board_id', 'project_boards', 'min_level', 'include_message', 'cooldown_minutes'],

    connect: {
      kind: 'token',
      // Shape only; nothing is fetched. The error never carries the value.
      async verifyToken({ token }) {
        if (typeof token !== 'string' || !CLIENT_KEY_SHAPE.test(token)) throw new Error('not a Sentry client secret');
        return {
          external_id: createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16),
          display_name: 'Sentry', scopes: ['event:read'], secrets: { webhook_secret: token },
        };
      },
    },

    verify({ headers, rawBody, secrets }) {
      const secret = secrets?.webhook_secret;
      if (typeof secret !== 'string' || !secret) return { ok: false, reason: 'no webhook secret' };
      const got = headers?.['sentry-hook-signature'];
      if (typeof got !== 'string' || !SIG_RE.test(got)) return { ok: false, reason: 'bad signature' };
      const want = createHmac('sha256', Buffer.from(secret, 'utf8')).update(rawBody).digest();
      const have = Buffer.from(got, 'hex');
      if (have.length !== want.length || !timingSafeEqual(have, want)) return { ok: false, reason: 'bad signature' };
      let text;
      try {
        text = utf8.decode(rawBody);
        JSON.parse(text);
      } catch { return { ok: false, reason: 'body is not UTF-8 JSON' }; }
      if (hasDuplicateKeys(text)) return { ok: false, reason: 'duplicate JSON key' };
      // Signed bytes only: Request-ID is unsigned and never a key.
      return { ok: true, dedupe_key: `body:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}` };
    },

    async handleWebhook({ headers, payload, ctx }) {
      const t = now();
      const st = stateOf(ctx.connection.id);
      noteTimestamp(ctx, st, headers, t);
      const config = own(ctx.connection.settings, 'config') ?? {};
      const kind = headers?.['sentry-hook-resource'] === 'issue' ? 'issue' : headers?.['sentry-hook-resource'] === 'metric_alert' ? 'alert' : null;
      const event = kind === 'issue' ? issueEvent(payload, { now: t, config }) : kind === 'alert' ? metricEvent(payload, { now: t, config }) : null;
      if (!event) return;
      const card = ctx.linked(kind, event.id);
      const creating = kind === 'issue' ? event.action === 'created' : event.action === 'critical' && !card;
      if (!creating) {
        if (!card) return; // Never adopt a card from a payload id/key.
        const action = kind === 'issue' ? 'sentry.status' : 'sentry.incident-status';
        const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        const request_id = `sentry-${kind}-status-${event.id}-${digest}`;
        return ctx.act(action, { card_id: card, external_ref: `sentry-${kind}-${event.id}` }, s => s.actAs(ctx.connection.created_by)
          .observeLink(card, kind, event.id, { state: event.state }, { request_id, body: kind === 'issue' ? event.body : event.statusBody }));
      }
      // Every project must route to the same current active board. A multi-
      // project incident with conflicting routes is paused, never guessed.
      const targets = event.projects.map(slug => boardFor(ctx, config, slug));
      const board = targets.every(id => id && id === targets[0]) ? targets[0] : null;
      if (!board) return suppressed(ctx, st, 'no_board', t);
      // Over a card rule: no act() at all until it refills, so a storm writes no audit row per issue.
      if (st.until > t) return suppressed(ctx, st, 'card_cap', t);
      const { title, body, url } = event;
      const ref = kind === 'issue' ? `sentry-issue-${event.id}` : event.ref;
      try {
        await ctx.act(kind === 'issue' ? 'sentry.card' : 'sentry.incident', { external_ref: ref }, async (s) => {
          const out = await s.actAs(ctx.connection.created_by).createCard(board, { request_id: ref, title, body, labels: kind === 'issue' ? ['bug'] : ['incident'] });
          s.link(out.card.id, kind, event.id, url);
        });
      } catch (e) {
        // The issue's card is on another board (project_boards changed): it exists, a retry can't help.
        if (e?.code === 'CONFLICT') return;
        if (e?.code !== 'RATE_LIMITED') throw e;
        // Answered 200: Sentry's retries would only add load.
        st.until = t + Math.max(1, Number(e.extra?.retry_after_s) || 60) * 1000;
        await notice(ctx, st, t);
        await suppressed(ctx, st, 'card_cap', t);
      }
    },

    actions: {
      'sentry.card': { default: 'auto', reversible: true },
      'sentry.status': { default: 'auto' },
      'sentry.incident': { default: 'auto', reversible: true },
      'sentry.incident-status': { default: 'auto' },
      'sentry.notice': { default: 'auto' },
      'sentry.suppressed': { default: 'auto' },
    },
  });
}

export default createSentryConnector();
