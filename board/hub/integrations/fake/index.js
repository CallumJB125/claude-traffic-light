// A reference connector: the smallest complete example of the interface, used
// by the registry tests and as the template for real connectors (GitHub,
// Slack, Sentry, Linear/Jira). Signature scheme: GitHub-style
// `X-Fake-Signature: sha256=<hex HMAC of the raw body>` + `X-Fake-Delivery`.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { defineConnector } from '../connector.js';

export function sign(secret, rawBody) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export default defineConnector({
  id: 'fake',
  name: 'Fake tracker',
  scopes: ['issues:read'],
  secrets: ['api_token', 'webhook_secret'],

  connect: {
    kind: 'token',
    async verifyToken({ token }) {
      if (!/^fake_[a-z0-9]{8,}$/.test(token)) throw new Error('That token doesn’t look right.');
      return { external_id: 'fake-workspace-1', display_name: 'Fake workspace', scopes: ['issues:read'], secrets: { api_token: token, webhook_secret: `whsec_${token.slice(5)}` } };
    },
  },

  verify({ headers, rawBody, secrets }) {
    const got = String(headers['x-fake-signature'] ?? '');
    const want = sign(secrets.webhook_secret ?? '', rawBody);
    const a = Buffer.from(got);
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };
    const id = String(headers['x-fake-delivery'] ?? '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return { ok: false, reason: 'no delivery id' };
    return { ok: true, dedupe_key: id };
  },

  // A new issue becomes a card (a fact → automatic, deduplicated by issue id).
  async handleWebhook({ payload, ctx }) {
    if (payload.event !== 'issue.opened') return;
    const issueId = String(payload.issue?.id ?? '');
    if (!issueId || ctx.linked('issue', issueId)) return;
    const boardId = ctx.boardIds()[0];
    if (!boardId) return;
    await ctx.act('card.create', { external_ref: issueId, detail: { source: 'fake' } }, async () => {
      const res = await ctx.actAs(ctx.connection.created_by).createCard(boardId, {
        request_id: `fake-issue-${issueId}`, title: String(payload.issue?.title ?? 'Untitled issue').slice(0, 200), labels: ['auto'],
      });
      ctx.link(res.card.id, 'issue', issueId, payload.issue?.url ?? null);
      return res.card.id;
    });
  },

  consumes: ['card.transition'],
  async onEvent(row, ctx) {
    if (row.payload?.to !== 'done' || !row.card_id) return;
    // Closing the upstream issue speaks for the team → asks by default.
    await ctx.act('issue.close', { card_id: row.card_id }, async () => true);
  },

  actions: {
    'card.create': { default: 'auto', reversible: true },
    'issue.close': { default: 'ask' },
  },

  async health() { return { ok: true }; },
});
