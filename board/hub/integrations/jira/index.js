// Jira (Cloud) connector: webhook-only, like Sentry. A Jira admin creates a
// webhook (Settings → System → WebHooks) with a secret they also paste here;
// that secret is the only credential and the connector makes no outbound
// request (`hosts: []`). A created or updated issue becomes one Todo card per
// Jira issue id on the connection's target board; a later status transition
// adds one untrusted, human-readable comment. Nothing here moves a card or
// starts an AI.
//
// Create ticket (optional, outbound): an admin may paste, after the webhook
// secret, an Atlassian account email, a scoped API token (write:jira-work),
// the site's cloud id, a project key and the site
// ("<secret> me@x.com <token> <cloud id> ENG acme.atlassian.net"). Then a
// member's explicit Create from a session makes one Task in that project
// through api.atlassian.com with the title and description they approved.
//
// Go-live gate: not in connectorsFor() on any hub until a real Jira delivery
// has been checked against verify() over its raw bytes (docs/JIRA-RUNBOOK.md).
//
// Payload fields read (Atlassian docs, developer.atlassian.com/cloud/jira/platform/webhooks):
// webhookEvent, timestamp, issue.{id, key, self, fields.{summary, status.{name,
// statusCategory.key}, issuetype.name, priority.name, project.key}},
// changelog.{id, items[].{field, toString}}. Description, comments, user and
// assignee are never read. Header: x-hub-signature ("sha256=" + hex
// HMAC-SHA256 of the raw body). X-Atlassian-Webhook-Identifier is unsigned and
// never a key.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { defineConnector } from '../connector.js';
import { own, scrub } from '../sentry/text.js';
import { hasDuplicateKeys } from '../sentry/index.js';

const SECRET_SHAPE = /^[\x21-\x7e]{16,256}$/;
const SIG_RE = /^sha256=([0-9a-f]{64})$/;
const ID_RE = /^\d{1,20}$/;
const KEY_RE = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;
const PROJECT_RE = /^[A-Z][A-Z0-9_]{0,19}$/;
const SITE_RE = /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const TOKEN_RE = /^[\x21-\x7e]{16,1024}$/;
const CLOUD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WINDOW_BACK_MS = 86_400_000;
const WINDOW_AHEAD_MS = 300_000;
export const SUGGESTION = 'Suggested: review this issue, choose an AI and start work from the card.';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** https://<site>.atlassian.net/browse/<KEY>, built from the issue's own REST `self` URL, else null. */
export function issueLink(self, id, key) {
  if (typeof self !== 'string' || self.length > 500 || !self.startsWith('https://') || /[?#@\\\s%]/.test(self)) return null;
  let u;
  try { u = new URL(self); } catch { return null; }
  if (u.port || u.username || u.password || !SITE_RE.test(u.hostname)) return null;
  const m = /^\/rest\/api\/(?:2|3|latest)\/issue\/(\d{1,20})$/.exec(u.pathname);
  return m && m[1] === id ? `https://${u.hostname}/browse/${key}` : null;
}

/** A card or a status comment from a verified payload, or null for anything else. */
export function issueEvent(payload) {
  const kind = own(payload, 'webhookEvent');
  if (kind !== 'jira:issue_created' && kind !== 'jira:issue_updated') return null;
  const issue = own(payload, 'issue'), fields = own(issue, 'fields');
  const id = own(issue, 'id'), key = own(issue, 'key');
  if (typeof id !== 'string' || !ID_RE.test(id) || typeof key !== 'string' || !KEY_RE.test(key)) return null;
  const status = own(fields, 'status');
  const statusName = scrub(own(status, 'name'), 40) || 'unknown';
  const url = issueLink(own(issue, 'self'), id, key);
  const changelog = own(payload, 'changelog');
  const changeId = own(changelog, 'id');
  const items = own(changelog, 'items');
  const move = kind === 'jira:issue_updated' && typeof changeId === 'string' && ID_RE.test(changeId) && Array.isArray(items)
    ? items.find(i => own(i, 'field') === 'status') : undefined;
  const project = own(own(fields, 'project'), 'key');
  const type = scrub(own(own(fields, 'issuetype'), 'name'), 30);
  const priority = scrub(own(own(fields, 'priority'), 'name'), 30);
  const summary = scrub(own(fields, 'summary'), 100);
  const lines = [
    `Jira issue: ${key}`,
    ...(typeof project === 'string' && PROJECT_RE.test(project) ? [`Project: ${project}`] : []),
    ...(type ? [`Type: ${type}`] : []),
    `Status: ${statusName}`,
    ...(priority ? [`Priority: ${priority}`] : []),
    ...(url ? [`Jira: ${url}`] : []),
    '', SUGGESTION,
  ];
  const to = move ? scrub(own(move, 'toString'), 40) || statusName : statusName;
  return {
    id, key, url, changed: !!move, closed: own(own(status, 'statusCategory'), 'key') === 'done',
    title: `${key}: ${summary || 'Untitled issue'}`,
    body: lines.join('\n'),
    statusRequest: move ? `jira-status-${id}-${changeId}` : null,
    statusBody: `Jira status changed to ${to}.\nThis update came from Jira; it does not move the card or start an AI.${url ? `\nJira: ${url}` : ''}`,
  };
}

const fail = (code) => Object.assign(new Error('Jira did not create the issue'), { code });
// Atlassian Document Format: one paragraph per line, text only.
const adf = (text) => ({ type: 'doc', version: 1, content: String(text).split('\n').map((l) => (l ? { type: 'paragraph', content: [{ type: 'text', text: l }] } : { type: 'paragraph' })) });

/** One Task in the pasted project; { key, url } or a fixed-text throw. */
export async function createJiraIssue({ title, description, secrets, provider, fetch }) {
  const email = secrets?.api_email, token = secrets?.api_token;
  const { cloud_id: cloud, project_key: project, site } = provider ?? {};
  if (!EMAIL_RE.test(email ?? '') || !TOKEN_RE.test(token ?? '') || !CLOUD_RE.test(cloud ?? '') || !PROJECT_RE.test(project ?? '') || !SITE_RE.test(site ?? '')) throw fail('not_configured');
  const res = await fetch(`https://api.atlassian.com/ex/jira/${cloud}/rest/api/3/issue`, { // privacy-flow: create-ticket
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}` },
    body: JSON.stringify({ fields: { project: { key: project }, summary: title, issuetype: { name: 'Task' }, description: adf(description) } }),
  });
  if (!res.ok) throw fail(res.status === 401 || res.status === 403 ? 'provider_auth' : 'provider_error');
  let body;
  try { body = await res.json(); } catch { throw fail('provider_error'); }
  const key = own(body, 'key');
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw fail('provider_error');
  return { key, url: `https://${site}/browse/${key}` };
}

export function createJiraConnector({ now = () => Date.now() } = {}) {
  return defineConnector({
    id: 'jira',
    name: 'Jira',
    scopes: ['webhook:jira:issue_created', 'webhook:jira:issue_updated'],
    secrets: ['webhook_secret', 'api_email', 'api_token'],
    hosts: ['api.atlassian.com'],
    issueSecrets: ['api_email', 'api_token'],
    createIssue: createJiraIssue,
    showsWebhookUrl: true,
    dailyCardCap: 100,

    connect: {
      kind: 'token',
      // Shape only; nothing is fetched. The error never carries the value.
      // "<secret>" or "<secret> <email> <api token> <cloud id> <PROJECT> <site>.atlassian.net".
      async verifyToken({ token }) {
        const parts = typeof token === 'string' ? token.trim().split(/\s+/) : [];
        const [secret, email, apiToken, cloud, project, site] = parts;
        if (!SECRET_SHAPE.test(secret ?? '')) throw new Error('not a Jira webhook secret');
        const outbound = parts.length === 6 && EMAIL_RE.test(email) && TOKEN_RE.test(apiToken) && CLOUD_RE.test(cloud) && PROJECT_RE.test(project) && SITE_RE.test(site);
        if (parts.length !== 1 && !outbound) throw new Error('not a Jira webhook secret and issue settings');
        const scopes = ['webhook:jira:issue_created', 'webhook:jira:issue_updated'];
        return {
          external_id: createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16),
          display_name: 'Jira', scopes: outbound ? [...scopes, 'write:jira-work'] : scopes,
          secrets: { webhook_secret: secret, ...(outbound ? { api_email: email, api_token: apiToken } : {}) },
          ...(outbound ? { settings: { cloud_id: cloud, project_key: project, site } } : {}),
        };
      },
    },

    verify({ headers, rawBody, secrets }) {
      const secret = secrets?.webhook_secret;
      if (typeof secret !== 'string' || !secret) return { ok: false, reason: 'no webhook secret' };
      const got = typeof headers?.['x-hub-signature'] === 'string' ? SIG_RE.exec(headers['x-hub-signature']) : null;
      if (!got) return { ok: false, reason: 'bad signature' };
      const want = createHmac('sha256', Buffer.from(secret, 'utf8')).update(rawBody).digest();
      const have = Buffer.from(got[1], 'hex');
      if (have.length !== want.length || !timingSafeEqual(have, want)) return { ok: false, reason: 'bad signature' };
      let text, body;
      try {
        text = utf8.decode(rawBody);
        body = JSON.parse(text);
      } catch { return { ok: false, reason: 'body is not UTF-8 JSON' }; }
      if (hasDuplicateKeys(text)) return { ok: false, reason: 'duplicate JSON key' };
      // timestamp is inside the signed body: a captured delivery stops working once its dedupe row could be swept.
      const ts = own(body, 'timestamp'), t = now();
      if (!Number.isSafeInteger(ts) || ts < t - WINDOW_BACK_MS || ts > t + WINDOW_AHEAD_MS) return { ok: false, reason: 'timestamp outside window' };
      return { ok: true, dedupe_key: `body:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}` };
    },

    async handleWebhook({ payload, ctx }) {
      const event = issueEvent(payload);
      if (!event) return;
      const card = ctx.linked('issue', event.id);
      if (card) {
        if (!event.changed) return;
        return ctx.act('jira.status', { card_id: card, external_ref: `jira-issue-${event.id}` }, s => s.actAs(ctx.connection.created_by)
          .comment(card, { request_id: event.statusRequest, body: event.statusBody }));
      }
      if (event.closed) return;
      const board = ctx.boardIds()[0];
      if (!board) return;
      const ref = `jira-issue-${event.id}`;
      try {
        await ctx.act('jira.card', { external_ref: ref }, async (s) => {
          const out = await s.actAs(ctx.connection.created_by).createCard(board, { request_id: ref, title: event.title, body: event.body });
          s.link(out.card.id, 'issue', event.id, event.url);
        });
      } catch (e) {
        // The issue's card is on another board (the target changed): it exists, a retry can't help.
        if (e?.code !== 'CONFLICT') throw e;
      }
    },

    actions: {
      'jira.card': { default: 'auto', reversible: true },
      'jira.status': { default: 'auto' },
    },
  });
}

export default createJiraConnector();
