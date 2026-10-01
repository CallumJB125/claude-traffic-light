// GitHub connector (I2), first slice: a pull request opened from a branch the
// board created is linked to its card, its status (open/draft, checks,
// review) is kept on the card, and merging it moves the card to Done through
// the state machine's own pr_merged fact. Everything here is a fact, so every
// action defaults to 'auto'; nothing speaks for a person or writes to GitHub.
//
// Links come only from ctx.cardForBranch (a recorded run branch in a repo of
// this team's boards), never from text in a PR title or body, and never from
// a fork (webhook.js drops a fork PR's branch). Connect is a GitHub App made
// from a manifest (connect.manifestForm), so Callum approves one screen.

import { randomBytes } from 'node:crypto';
import { defineConnector } from '../connector.js';
import { verify as verifyWebhook, factsOf, EVENTS } from './webhook.js';

const API = 'https://api.github.com';
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const PERMISSIONS = { pull_requests: 'read', checks: 'read', metadata: 'read' };
const APP_EVENTS = ['pull_request', 'pull_request_review', 'check_suite'];
const PEM = /^-----BEGIN (RSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END \1PRIVATE KEY-----\r?\n?$/;
const validLogin = (v) => (typeof v === 'string' && LOGIN.test(v) ? v : null);
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// GitHub App names are global and at most 34 characters: a fixed name
// collides with every other team's app, and with this team's previous one.
function appName(owner) {
  const suffix = [...randomBytes(4)].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  return owner ? `Plexiform-${owner.slice(0, 34 - 15)}-${suffix}` : `Plexiform-${suffix}`;
}

// The manifest conversion's answer becomes sealed secrets and stored
// settings: every field is checked, and an app with any other permission or
// event than the manifest asked for is refused.
function checkApp(app) {
  const bad = (what) => { throw new Error(`manifest conversion returned ${what}`); };
  if (!isObj(app)) bad('no app');
  if (!posInt(app.id)) bad('a bad app id');
  if (!isObj(app.owner) || !posInt(app.owner.id) || !validLogin(app.owner.login)) bad('a bad owner');
  if (typeof app.slug !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,32}[a-z0-9])?$/.test(app.slug)) bad('a bad slug');
  if (typeof app.pem !== 'string' || app.pem.length > 8192 || !PEM.test(app.pem)) bad('a bad private key');
  if (typeof app.webhook_secret !== 'string' || app.webhook_secret.length < 16 || app.webhook_secret.length > 256) bad('a bad webhook secret');
  const perms = isObj(app.permissions) ? app.permissions : bad('no permissions');
  const keys = Object.keys(perms);
  if (keys.length !== Object.keys(PERMISSIONS).length || !keys.every((k) => Object.hasOwn(PERMISSIONS, k) && perms[k] === PERMISSIONS[k])) bad('permissions other than read on pull requests, checks and metadata');
  if (!Array.isArray(app.events) || !app.events.every((e) => APP_EVENTS.includes(e))) bad('events other than pull_request, pull_request_review and check_suite');
  return app;
}

// What the card face shows, in the registry's allowlisted words.
// A PR's own state wins: an `edited` event on a merged PR must not show it as open again.
const STATE = (f) => (f.kind === 'pr.merged' || f.merged ? 'merged' : f.kind === 'pr.closed' || f.open === false ? 'closed' : f.draft ? 'draft' : 'open');
const HEAD_SHA = /^[0-9a-f]{40}$/;
const CHECKS = { success: 'passing', failure: 'failing', pending: 'pending' };
const REVIEW = { approved: 'approved', changes_requested: 'changes_requested', dismissed: 'none', commented: null };

export function manifest({ redirectUri, webhookUrl, name }) {
  return {
    name,
    url: 'https://plexiform.dev',
    hook_attributes: { url: webhookUrl, active: true },
    redirect_url: redirectUri,
    callback_urls: [redirectUri],
    public: false,
    default_permissions: { pull_requests: 'read', checks: 'read', metadata: 'read' },
    default_events: ['pull_request', 'pull_request_review', 'check_suite'],
  };
}

// A board branch's card, and the base its PR must target to count: the base
// its run was cut from (cardForBranch → {card_id, base_ref}), else the repo's
// default branch. A PR from the board branch into a throwaway base is not the
// card's PR.
function boardCard(ctx, f) {
  if (!f.branch || !f.repo || typeof ctx.cardForBranch !== 'function') return null;
  const r = ctx.cardForBranch(f.repo, f.branch);
  const card = r && typeof r === 'object' ? r.card_id : r;
  const base = (r && typeof r === 'object' ? r.base_ref : null) ?? f.default_branch;
  return card && typeof base === 'string' && base ? { card, base } : null;
}

// The card a fact belongs to: its existing link, or (mode, only for a PR
// from a board branch in the same repo into that branch's base) the card
// whose run made that branch. A card that already has another PR gets this
// one only as a relink, and only when this PR is the card's verified PR or
// the old one has ended (closed or merged); the registry checks both again.
// mode: 'first' may link or relink (an open PR); 'verified' may only relink
// to the card's hub-verified PR (its merge: the PR may have opened before the
// hub verified it, while another PR held the slot); otherwise existing links only.
function cardFor(ctx, f, mode) {
  const linked = f.pr_id ? ctx.linked('pr', f.pr_id) : null;
  if (linked) return { card: linked, linked: true };
  if (mode !== 'first' && mode !== 'verified') return null;
  const b = boardCard(ctx, f);
  if (!b || f.base_ref !== b.base) return null;
  const have = typeof ctx.linkedByCard === 'function' ? ctx.linkedByCard(b.card, 'pr') : null;
  if (have == null) return mode === 'first' ? { card: b.card, linked: false } : null;
  if (typeof ctx.linkStatusFor !== 'function' || !f.url) return null;
  const v = typeof ctx.verifiedPr === 'function' ? ctx.verifiedPr(b.card) : null;
  // Evidence that names no repo is bound to the card's own repo, which only
  // the registry knows: it refuses the relink if f.url is another repo.
  const verified = !!v && v.number === f.number && (!v.repo || v.repo.toLowerCase() === String(f.repo).toLowerCase());
  // A merged PR is final for its card: only the verified PR may replace it.
  const ended = ctx.linkStatusFor(b.card, 'pr')?.state === 'closed';
  if (mode === 'verified') return verified ? { card: b.card, linked: false, relink: have } : null;
  return verified || ended ? { card: b.card, linked: false, relink: have } : null;
}

// What s.link and s.relink refuse is an answer about the card's PR slot (it
// has another PR, the PR is not the card's), not a failure: a throw would
// make GitHub redeliver it again and again.
const SLOT_ANSWERS = new Set(['CONFLICT', 'NOT_FOUND', 'VALIDATION']);

async function linkAndStatus(ctx, f, status, mode = null) {
  const hit = cardFor(ctx, f, mode);
  if (!hit) return null;
  // Only the slot call's own refusal is an answer: a failure after it (the
  // status write) must throw, or a relinked merge would be marked done unapplied.
  let slotted = hit.linked;
  try {
    await ctx.act(hit.linked ? 'pr.status' : 'pr.link', { external_ref: f.pr_id, detail: { pr: f.number } }, async (s) => {
      if (hit.relink) s.relink(hit.card, 'pr', hit.relink, f.pr_id, f.url);
      else if (!hit.linked) s.link(hit.card, 'pr', f.pr_id, f.url);
      slotted = true;
      s.linkStatus(hit.card, 'pr', f.pr_id, status);
    });
  } catch (e) {
    if (!slotted && (e?.code === 'CONFLICT' || (hit.relink && SLOT_ANSWERS.has(e?.code)))) return null;
    throw e;
  }
  return hit;
}

export async function apply(ctx, facts) {
  for (const f of facts) {
    if (ctx.signal?.aborted) return;
    switch (f.kind) {
      case 'pr.opened':
      case 'pr.updated':
        // head_sha is kept for the connector only (the card never shows it),
        // so a check suite for an older head can be told apart below.
        await linkAndStatus(ctx, f, {
          state: STATE(f), ...(HEAD_SHA.test(f.head_sha ?? '') ? { head_sha: f.head_sha } : {}),
          ...(f.review_requested ? { review: 'requested' } : {}), ...(f.checks_pending ? { checks: 'pending' } : {}),
        }, f.open === true ? 'first' : null);
        break;
      case 'pr.review': {
        const review = REVIEW[f.review];
        if (review) await linkAndStatus(ctx, f, { review });
        break;
      }
      case 'pr.merged':
      case 'pr.closed': {
        // Never a first link: a PR the board never saw open can't close a card.
        // A merge may take the slot from another PR only if it is the card's
        // hub-verified PR (the registry binds that to its number and repo).
        const hit = await linkAndStatus(ctx, f, { state: STATE(f) }, f.kind === 'pr.merged' ? 'verified' : null);
        if (!hit) break;
        // Its base may have been edited since it was linked.
        const b = boardCard(ctx, f);
        const base = b && b.card === hit.card ? b.base : f.default_branch;
        // The registry applies it only for the card's hub-verified PR (number and
        // repo); {done: false, reason: 'no_verified_pr' | 'not_the_verified_pr'}
        // is a normal answer, not an error.
        if (f.base_ref && f.base_ref === base) await ctx.system.event(f.kind === 'pr.merged' ? 'pr_merged' : 'pr_closed', { kind: 'pr', external_id: f.pr_id, pr: f.number, by: f.by, repo: f.repo });
        break;
      }
      case 'pr.checks':
        for (const pr of f.prs) {
          // GitHub delivers out of order: a suite that finishes after a push
          // describes the old head, and must not mark the new one passing.
          const card = typeof ctx.linkStatusFor === 'function' ? ctx.linked('pr', pr.pr_id) : null;
          const head = card ? ctx.linkStatusFor(card, 'pr')?.head_sha : null;
          if (head && head !== f.head_sha) {
            // Older or newer head, it can't tell (a synchronize may have been
            // lost): never leave a passing it can't confirm on the card.
            if (f.checks !== 'success') await linkAndStatus(ctx, { ...pr, repo: f.repo }, { checks: 'pending' });
            continue;
          }
          await linkAndStatus(ctx, { ...pr, repo: f.repo }, { checks: CHECKS[f.checks] });
        }
        break;
      default:
    }
  }
}

export default defineConnector({
  id: 'github',
  name: 'GitHub',
  scopes: ['pull_requests:read', 'checks:read', 'metadata:read'],
  secrets: ['app_private_key', 'webhook_secret'],
  hosts: ['api.github.com', 'github.com'],
  // GitHub's webhook senders, the `hooks` array of GET https://api.github.com/meta
  // (2026-10-01). Only a head start past the in-flight cap; every delivery
  // still needs its signature. The hub takes IPv6 /32 or narrower, so the /29
  // is its eight /32s. Refresh when GitHub changes the list.
  ingressCidrs: [
    '192.30.252.0/22', '185.199.108.0/22', '140.82.112.0/20', '143.55.64.0/20',
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `2a0a:a44${i}::/32`),
    '2606:50c0::/32',
  ],

  connect: {
    kind: 'app_install',
    // Creating the app is a POST form on github.com: one visible button, no
    // auto-submit. Reconnecting goes through the same form.
    formHost: 'github.com',
    manifestForm({ state, redirectUri, webhookUrl, config }) {
      const org = validLogin(config?.org);
      const action = org ? `https://github.com/organizations/${org}/settings/apps/new?state=${encodeURIComponent(state)}` : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
      const name = appName(org ?? validLogin(config?.login));
      return { action, fields: { manifest: JSON.stringify(manifest({ redirectUri, webhookUrl, name })) } };
    },
    // The manifest callback: trade the one-time code for the app's credentials.
    async exchange({ query, fetch, config }) {
      const code = String(query?.code ?? '');
      if (!/^[A-Za-z0-9]{1,100}$/.test(code)) throw new Error('bad manifest code');
      const res = await fetch(`${API}/app-manifests/${code}/conversions`, { method: 'POST', headers: { accept: 'application/vnd.github+json' } }); // privacy-flow: integrations-hub
      if (!res.ok) throw new Error(`manifest conversion failed: ${res.status}`);
      const app = checkApp(await res.json());
      const org = validLogin(config?.org) ?? (app.owner.type === 'Organization' ? app.owner.login : null);
      return {
        // Each app is its own connection: a reconnect makes a new app, and
        // keying by owner collided with the old one (CONFLICT, orphaned app).
        external_id: String(app.id),
        display_name: app.owner.login,
        scopes: ['pull_requests:read', 'checks:read', 'metadata:read'],
        secrets: { app_private_key: app.pem, webhook_secret: app.webhook_secret },
        settings: { app_id: app.id, app_slug: app.slug, login: app.owner.login, ...(org ? { org } : {}) },
        next_url: `https://github.com/apps/${app.slug}/installations/new`,
      };
    },
  },

  verify({ headers, rawBody, secrets }) {
    const r = verifyWebhook({ headers, rawBody, secrets });
    return r.ok ? { ok: true, dedupe_key: r.dedupe_key } : { ok: false, reason: r.reason };
  },

  async handleWebhook({ headers, payload, ctx }) {
    const event = String(headers?.['x-github-event'] ?? '');
    if (!EVENTS.includes(event)) return;
    await apply(ctx, factsOf(event, payload));
  },

  systemEvents: ['pr_merged', 'pr_closed'],
  actions: {
    'system.pr_merged': { default: 'auto' },
    'system.pr_closed': { default: 'auto' },
    'pr.link': { default: 'auto', reversible: true },
    'pr.status': { default: 'auto', reversible: true },
  },

  async health() { return { ok: true }; },
});
