// Linear connector: webhook-only, like Sentry. An admin creates a Linear
// webhook (Settings → API → Webhooks, resource type Issues) and pastes its
// signing secret, the only credential; the connector makes no outbound request
// (`hosts: []`). A new or updated issue becomes one Todo card per Linear issue
// id on the connection's target board; a later status change adds one
// untrusted, human-readable comment. Nothing here moves a card or starts an AI.
//
// Go-live gate: not in connectorsFor() on any hub until a real Linear delivery
// has been checked against verify() over its raw bytes (docs/LINEAR-RUNBOOK.md).
//
// Payload fields read (Linear docs, developers.linear.app/docs/graphql/webhooks):
// action, type, webhookTimestamp, url, updatedFrom.stateId, data.{id,
// identifier, title, priority, updatedAt, stateId, state.{id, name, type},
// team.key}. Description, assignee, labels and actor are never read.
// Headers: linear-signature (hex HMAC-SHA256 of the raw body). Linear-Delivery
// is unsigned and never a key.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { defineConnector } from '../connector.js';
import { own, scrub } from '../sentry/text.js';
import { hasDuplicateKeys } from '../sentry/index.js';

const SECRET_SHAPE = /^[A-Za-z0-9_-]{16,256}$/;
const SIG_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENTIFIER_RE = /^[A-Z0-9]{1,10}-\d{1,9}$/;
const TEAM_RE = /^[A-Z0-9]{1,10}$/;
const WORKSPACE_RE = /^[a-z0-9-]{1,64}$/;
const STATE_TYPES = Object.freeze(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']);
const CLOSED = Object.freeze(['completed', 'canceled']);
const PRIORITY = Object.freeze(['No priority', 'Urgent', 'High', 'Medium', 'Low']);
const WINDOW_BACK_MS = 86_400_000;
const WINDOW_AHEAD_MS = 300_000;
export const SUGGESTION = 'Suggested: review this issue, choose an AI and start work from the card.';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The issue's Linear URL rebuilt from checked parts: https://linear.app/<workspace>/issue/<IDENTIFIER>, else null. */
export function issueLink(raw, identifier) {
  if (typeof raw !== 'string' || raw.length > 500 || !raw.startsWith('https://linear.app/') || /[?#@\\\s%]/.test(raw)) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.hostname !== 'linear.app' || u.port || u.username || u.password) return null;
  const m = /^\/([a-z0-9-]{1,64})\/issue\/([A-Z0-9]{1,10}-\d{1,9})(?:\/[a-z0-9-]{0,200})?$/.exec(u.pathname);
  if (!m || !WORKSPACE_RE.test(m[1]) || m[2] !== identifier) return null;
  return `https://linear.app/${m[1]}/issue/${m[2]}`;
}

/** A card or a status comment from a verified payload, or null for anything else. */
export function issueEvent(payload) {
  if (own(payload, 'type') !== 'Issue') return null;
  const action = own(payload, 'action');
  if (action !== 'create' && action !== 'update') return null;
  const data = own(payload, 'data');
  const id = own(data, 'id'), identifier = own(data, 'identifier');
  if (typeof id !== 'string' || !UUID_RE.test(id) || typeof identifier !== 'string' || !IDENTIFIER_RE.test(identifier)) return null;
  const state = own(data, 'state');
  const stateType = STATE_TYPES.includes(own(state, 'type')) ? state.type : null;
  const stateName = scrub(own(state, 'name'), 40) || (stateType ?? 'unknown');
  const url = issueLink(own(payload, 'url') ?? own(data, 'url'), identifier);
  const from = own(payload, 'updatedFrom');
  const stateId = own(data, 'stateId');
  const changed = action === 'update' && typeof own(from, 'stateId') === 'string' && typeof stateId === 'string' && from.stateId !== stateId;
  const team = own(own(data, 'team'), 'key');
  const priority = own(data, 'priority');
  const title = scrub(own(data, 'title'), 100);
  const lines = [
    `Linear issue: ${identifier}`,
    ...(typeof team === 'string' && TEAM_RE.test(team) ? [`Team: ${team}`] : []),
    `Status: ${stateName}`,
    ...(Number.isInteger(priority) && priority >= 0 && priority < PRIORITY.length ? [`Priority: ${PRIORITY[priority]}`] : []),
    ...(url ? [`Linear: ${url}`] : []),
    '', SUGGESTION,
  ];
  const updatedAt = own(data, 'updatedAt');
  const version = createHash('sha256').update(`${typeof stateId === 'string' ? stateId : ''}|${typeof updatedAt === 'string' ? updatedAt : ''}`).digest('hex').slice(0, 32);
  return {
    id, identifier, url, changed, closed: CLOSED.includes(stateType),
    title: `${identifier}: ${title || 'Untitled issue'}`,
    body: lines.join('\n'),
    statusRequest: `linear-status-${id}-${version}`,
    statusBody: `Linear status changed to ${stateName}.\nThis update came from Linear; it does not move the card or start an AI.${url ? `\nLinear: ${url}` : ''}`,
  };
}

export function createLinearConnector({ now = () => Date.now() } = {}) {
  return defineConnector({
    id: 'linear',
    name: 'Linear',
    scopes: ['webhook:issues'],
    secrets: ['webhook_secret'],
    hosts: [],
    showsWebhookUrl: true,
    dailyCardCap: 100,

    connect: {
      kind: 'token',
      // Shape only; nothing is fetched. The error never carries the value.
      async verifyToken({ token }) {
        if (typeof token !== 'string' || !SECRET_SHAPE.test(token)) throw new Error('not a Linear webhook signing secret');
        return {
          external_id: createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16),
          display_name: 'Linear', scopes: ['webhook:issues'], secrets: { webhook_secret: token },
        };
      },
    },

    verify({ headers, rawBody, secrets }) {
      const secret = secrets?.webhook_secret;
      if (typeof secret !== 'string' || !secret) return { ok: false, reason: 'no webhook secret' };
      const got = headers?.['linear-signature'];
      if (typeof got !== 'string' || !SIG_RE.test(got)) return { ok: false, reason: 'bad signature' };
      const want = createHmac('sha256', Buffer.from(secret, 'utf8')).update(rawBody).digest();
      const have = Buffer.from(got, 'hex');
      if (have.length !== want.length || !timingSafeEqual(have, want)) return { ok: false, reason: 'bad signature' };
      let text, body;
      try {
        text = utf8.decode(rawBody);
        body = JSON.parse(text);
      } catch { return { ok: false, reason: 'body is not UTF-8 JSON' }; }
      if (hasDuplicateKeys(text)) return { ok: false, reason: 'duplicate JSON key' };
      // webhookTimestamp is inside the signed body: a captured delivery stops working once its dedupe row could be swept.
      const ts = own(body, 'webhookTimestamp'), t = now();
      if (!Number.isSafeInteger(ts) || ts < t - WINDOW_BACK_MS || ts > t + WINDOW_AHEAD_MS) return { ok: false, reason: 'timestamp outside window' };
      return { ok: true, dedupe_key: `body:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}` };
    },

    async handleWebhook({ payload, ctx }) {
      const event = issueEvent(payload);
      if (!event) return;
      const card = ctx.linked('issue', event.id);
      if (card) {
        if (!event.changed) return;
        return ctx.act('linear.status', { card_id: card, external_ref: `linear-issue-${event.id}` }, s => s.actAs(ctx.connection.created_by)
          .comment(card, { request_id: event.statusRequest, body: event.statusBody }));
      }
      if (event.closed) return;
      const board = ctx.boardIds()[0];
      if (!board) return;
      const ref = `linear-issue-${event.id}`;
      try {
        await ctx.act('linear.card', { external_ref: ref }, async (s) => {
          const out = await s.actAs(ctx.connection.created_by).createCard(board, { request_id: ref, title: event.title, body: event.body });
          s.link(out.card.id, 'issue', event.id, event.url);
        });
      } catch (e) {
        // The issue's card is on another board (the target changed): it exists, a retry can't help.
        if (e?.code !== 'CONFLICT') throw e;
      }
    },

    actions: {
      'linear.card': { default: 'auto', reversible: true },
      'linear.status': { default: 'auto' },
    },
  });
}

export default createLinearConnector();
