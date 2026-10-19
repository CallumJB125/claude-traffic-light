// Linear connector: webhook-only, like Sentry. An admin creates a Linear
// webhook (Settings → API → Webhooks, resource type Issues) and pastes its
// signing secret, the only credential; the connector makes no outbound request
// (`hosts: []`). A new or updated issue becomes one Todo card per Linear issue
// id on the connection's target board; a later status change adds one
// untrusted, human-readable comment. Nothing here moves a card or starts an AI.
//
// Create ticket (optional, outbound): an admin may paste, after the signing
// secret, a Linear personal API key and a team key ("<secret> lin_api_… ENG").
// Then a member's explicit Create from a session (POST
// /api/integrations/:id/issues) makes one issue in that team with the title
// and description the member approved; nothing else is ever sent to Linear.
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
const API_KEY_RE = /^lin_api_[A-Za-z0-9]{20,80}$/;
const API_URL = 'https://api.linear.app/graphql';
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

const fail = (code) => Object.assign(new Error('Linear did not create the issue'), { code });

/** One issue in the pasted team; { key, url } or a fixed-text throw. */
export async function createLinearIssue({ title, description, secrets, provider, fetch }) {
  const key = secrets?.api_key, team = provider?.team_key;
  if (typeof key !== 'string' || !API_KEY_RE.test(key) || typeof team !== 'string' || !TEAM_RE.test(team)) throw fail('not_configured');
  const gql = async (query, variables) => {
    const res = await fetch(API_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: key }, body: JSON.stringify({ query, variables }) }); // privacy-flow: create-ticket
    if (!res.ok) throw fail(res.status === 401 || res.status === 403 ? 'provider_auth' : 'provider_error');
    let body;
    try { body = await res.json(); } catch { throw fail('provider_error'); }
    if (own(body, 'errors')) throw fail('provider_error');
    return own(body, 'data');
  };
  const teams = own(own(await gql('query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }', { key: team }), 'teams'), 'nodes');
  const teamId = Array.isArray(teams) ? own(teams[0], 'id') : null;
  if (typeof teamId !== 'string' || !UUID_RE.test(teamId)) throw fail('provider_error');
  const made = own(await gql('mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }', { input: { teamId, title, description } }), 'issueCreate');
  const issue = own(made, 'issue'), identifier = own(issue, 'identifier');
  if (own(made, 'success') !== true || typeof identifier !== 'string' || !IDENTIFIER_RE.test(identifier)) throw fail('provider_error');
  return { key: identifier, url: issueLink(own(issue, 'url'), identifier) };
}

export function createLinearConnector({ now = () => Date.now() } = {}) {
  return defineConnector({
    id: 'linear',
    name: 'Linear',
    scopes: ['webhook:issues'],
    secrets: ['webhook_secret', 'api_key'],
    hosts: ['api.linear.app'],
    issueSecrets: ['api_key'],
    createIssue: createLinearIssue,
    showsWebhookUrl: true,
    dailyCardCap: 100,

    connect: {
      kind: 'token',
      // Shape only; nothing is fetched. The error never carries the value.
      // "<signing secret>" or "<signing secret> <lin_api_ key> <TEAM key>".
      async verifyToken({ token }) {
        const parts = typeof token === 'string' ? token.trim().split(/\s+/) : [];
        const [secret, apiKey, team] = parts;
        if (!SECRET_SHAPE.test(secret ?? '')) throw new Error('not a Linear webhook signing secret');
        const outbound = parts.length === 3 && API_KEY_RE.test(apiKey) && TEAM_RE.test(team);
        if (parts.length !== 1 && !outbound) throw new Error('not a Linear signing secret, API key and team key');
        return {
          external_id: createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16),
          display_name: 'Linear', scopes: outbound ? ['webhook:issues', 'issues:create'] : ['webhook:issues'],
          secrets: { webhook_secret: secret, ...(outbound ? { api_key: apiKey } : {}) },
          ...(outbound ? { settings: { team_key: team } } : {}),
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
