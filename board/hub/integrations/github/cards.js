// Card actions with the hub's GitHub App (step 4): a member opens the card's
// PR, or comments the card's status on it, with the installation's token.
// Only from a member's click (never from an event), only by someone who can
// write on the card's board, only for a repository a team admin linked on
// an installation connection, and limited per member and per card. Each one
// runs inside that connection's act(), so it is audited, and an admin can
// switch it off ('pr.create', 'pr.comment' set to off or ask).
//
// The PR's description is made from the card (title, goal, done means, the
// run's latest status line), secrets redacted: never comments, member
// names, the handover or anything an agent wrote beyond that status line.

import { HubError } from '../../db.js';
import { limitOrThrow } from '../../ratelimit.js';
import { prBound } from '../../github.js';
import { redactSecrets } from '../../../shared/secret-patterns.mjs';
import { randomUUID } from 'node:crypto';

const BODY_MAX = 60_000;
const SECTION_MAX = 8_000;
const COLUMN = { todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done' };
const clip = (v, n) => { const t = String(v ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const clean = (v, n = SECTION_MAX) => redactSecrets(clip(v, n));

/** The PR title and description for a card (pure). */
export function prText({ card, status, cardUrl = null }) {
  const parts = [];
  if (status) parts.push('## Status', '', clean(status, 300), '');
  if (card.body) parts.push('## Goal', '', clean(card.body), '');
  if (card.acceptance) parts.push('## Done means', '', clean(card.acceptance), '');
  parts.push('---', '', cardUrl ? `Opened from Plexiform card [${card.key}](${cardUrl}).` : `Opened from Plexiform card ${card.key}.`);
  return { title: clean(`${card.key}: ${card.title}`, 250), body: parts.join('\n').slice(0, BODY_MAX) };
}

/** The status comment for a card (pure). */
export function statusText({ card, status, link }) {
  const lines = [`**Plexiform status · ${card.key}**`, '', `- Column: ${COLUMN[card.column_name] ?? card.column_name ?? 'To do'}`];
  if (card.run_state) lines.push(`- Run: ${String(card.run_state).replace(/_/g, ' ')}`);
  if (link?.checks) lines.push(`- Checks: ${link.checks}`);
  if (link?.review) lines.push(`- Review: ${String(link.review).replace(/_/g, ' ')}`);
  if (status) lines.push('', clean(status, 300));
  return lines.join('\n');
}

export function createGitHubCards({ hub, api, integrations, app, provider = 'github' }) {
  const db = hub.db;

  // The card, its repo's linked installation connection, its latest run with a branch.
  function scope(member, cardId, cred) {
    const current = api.collaborationScope(member, { cardId }, cred);
    const card = hub.card(cardId);
    const repo = card?.repo_id ? hub.repo(card.repo_id) : null;
    if (!repo) throw new HubError('VALIDATION', 'this card has no repository');
    const link = integrations.appConnectionForRepo(current.org_id, provider, repo.canonical_url);
    if (!link) throw new HubError('POLICY_DENIED', 'Link this repository to the GitHub App on the Integrations page first.');
    const ctx = integrations.ctxFor(link.connection_id);
    const installation = ctx?.connection?.settings?.provider?.installation_id;
    if (!ctx || !Number.isSafeInteger(installation)) throw new HubError('POLICY_DENIED', 'Link this repository to the GitHub App on the Integrations page first.');
    limitOrThrow(hub, 'github_card_action_member', current.id);
    limitOrThrow(hub, 'github_card_action_card', cardId);
    return { member: current, card, repo, link, ctx, installation };
  }

  const latestRun = (cardId) => db.get('SELECT * FROM runs WHERE card_id = ? AND branch IS NOT NULL ORDER BY fence DESC, started_at DESC LIMIT 1', cardId);
  const refused = (r, what) => {
    if (r.decision === 'skipped' && r.reason === 'archived') throw new HubError('CONFLICT', 'this card is archived: restore it first');
    throw new HubError('POLICY_DENIED', `${what} is switched off for this GitHub connection (Integrations → GitHub → On its own).`);
  };
  const ghError = (status) => (status === 422
    ? new HubError('VALIDATION', 'GitHub refused it: check the branch is pushed and has commits the base does not.')
    : status === 403 || status === 404 ? new HubError('FORBIDDEN', 'The GitHub App has no access to this repository: check its installation.')
      : new HubError('PROVIDER_ERROR', 'GitHub could not do that right now. Try again in a minute.'));

  // The PR GitHub answered with, only when it is the card's own (D90 binding).
  const bound = (pull, run, card) => prBound({
    head_ref: pull?.head?.ref ?? null, head_repo_id: pull?.head?.repo?.id ?? null, base_repo_id: pull?.base?.repo?.id ?? null, base_ref: pull?.base?.ref ?? null,
  }, { branch: run.branch, key: card.key, baseRef: run.base_ref });

  /** POST /api/cards/:card_id/github/pr → {pr: {number, url, state}, existing}. */
  async function openPr(member, cardId, { cred = null } = {}) {
    const s = scope(member, cardId, cred);
    const run = latestRun(cardId);
    if (!run) throw new HubError('CONFLICT', 'this card has no branch yet: give it to Claude first');
    const have = s.ctx.linkedByCard(cardId, 'pr');
    if (have) {
      const l = db.get("SELECT url FROM external_links WHERE connection_id = ? AND card_id = ? AND kind = 'pr' AND external_id = ?", s.link.connection_id, cardId, have);
      return { pr: { url: l?.url ?? null, state: s.ctx.linkStatusFor(cardId, 'pr')?.state ?? null }, existing: true };
    }
    const full = s.link.full_name;
    const base = run.base_ref;
    const text = prText({ card: s.card, status: run.status_summary, cardUrl: s.ctx.hubUrl ? `${s.ctx.hubUrl}/?card=${encodeURIComponent(cardId)}` : null });
    const r = await s.ctx.act('pr.create', { card_id: cardId, external_ref: run.branch, detail: { branch: run.branch } }, async (sc) => {
      let res = await app.request(s.installation, 'POST', `/repos/${full}/pulls`, { title: text.title, head: run.branch, base, body: text.body });
      let pull = res.status === 201 ? res.body : null;
      if (res.status === 422) {
        // Already open (a person opened it on GitHub first): that one, if it is the card's.
        const owner = full.split('/')[0];
        res = await app.request(s.installation, 'GET', `/repos/${full}/pulls?state=open&per_page=5&head=${encodeURIComponent(`${owner}:${run.branch}`)}&base=${encodeURIComponent(base)}`);
        pull = res.status === 200 && Array.isArray(res.body) ? res.body.find((p) => bound(p, run, s.card)) ?? null : null;
        if (!pull) throw ghError(422);
      }
      if (!pull) throw ghError(res.status);
      if (!bound(pull, run, s.card) || !Number.isSafeInteger(pull.number) || typeof pull.html_url !== 'string' || !pull.html_url.startsWith(`https://github.com/${full}/pull/`)) {
        throw new HubError('PROVIDER_ERROR', 'GitHub answered with a pull request this card does not own');
      }
      sc.link(cardId, 'pr', String(pull.id), pull.html_url);
      sc.linkStatus(cardId, 'pr', String(pull.id), { state: pull.draft ? 'draft' : 'open', ...(typeof pull.head?.sha === 'string' ? { head_sha: pull.head.sha } : {}) });
      return { number: pull.number, url: pull.html_url, head_repo_id: pull.head.repo.id, base_repo_id: pull.base.repo.id, base_ref: pull.base.ref, draft: !!pull.draft };
    });
    if (!r.done) refused(r, 'Opening pull requests');
    const pr = r.result;
    // The hub made this PR itself and checked its binding: evidence the
    // merge (webhook or poll) moves the card to Done on.
    await hub.withBoard(s.card.board_id, () => hub.txn(() => {
      const id = randomUUID();
      const ref = `https://${s.repo.canonical_url}/pull/${pr.number}`;
      db.insert('evidence', {
        id, card_id: cardId, run_id: run.id, kind: 'pr', ref, summary: null, result: null, verification: 'hub_verified', verified_at: hub.iso(), created_at: hub.iso(),
        pr_head_repo_id: pr.head_repo_id, pr_base_repo_id: pr.base_repo_id, pr_base_ref: pr.base_ref,
      });
      hub.feed(cardId, 'evidence', { kind: 'pr', ref, verification: 'hub_verified', result: null }, { actor: s.member.id });
      hub.journal({ board_id: s.card.board_id, card_id: cardId, run_id: run.id, actor_kind: 'member', actor_id: s.member.id, kind: 'evidence.create', payload: { evidence_id: id, kind: 'pr', ref, verification: 'hub_verified', result: null } });
      hub.later(() => hub.broadcastCard(cardId));
    }));
    return { pr: { number: pr.number, url: pr.url, state: pr.draft ? 'draft' : 'open' }, existing: false };
  }

  /** POST /api/cards/:card_id/github/comment → {comment: {url}}. */
  async function commentStatus(member, cardId, { cred = null } = {}) {
    const s = scope(member, cardId, cred);
    const have = s.ctx.linkedByCard(cardId, 'pr');
    const url = have ? db.get("SELECT url FROM external_links WHERE connection_id = ? AND card_id = ? AND kind = 'pr' AND external_id = ?", s.link.connection_id, cardId, have)?.url : null;
    const m = typeof url === 'string' ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]{0,9})$/.exec(url) : null;
    if (!m || m[1].toLowerCase() !== s.link.full_name.toLowerCase()) throw new HubError('CONFLICT', 'this card has no pull request yet: open one first');
    const run = latestRun(cardId);
    const body = statusText({ card: s.card, status: run?.status_summary, link: s.ctx.linkStatusFor(cardId, 'pr') });
    const r = await s.ctx.act('pr.comment', { card_id: cardId, external_ref: `#${m[2]}`, detail: { pr: Number(m[2]) } }, async () => {
      const res = await app.request(s.installation, 'POST', `/repos/${s.link.full_name}/issues/${m[2]}/comments`, { body });
      if (res.status !== 201) throw ghError(res.status);
      return typeof res.body?.html_url === 'string' && res.body.html_url.startsWith(`${url}#issuecomment-`) ? res.body.html_url : null;
    });
    if (!r.done) refused(r, 'Commenting on pull requests');
    return { comment: { url: r.result } };
  }

  return { openPr, commentStatus };
}

/**
 * What a card offers (cardView): {open_pr, comment} when its repo is linked
 * on one of the team's installation connections and the hub has the app;
 * else null. Pure reads.
 */
export function githubCardView(hub, row, { provider = 'github' } = {}) {
  if (!hub.hasGitHubApp || !row.repo_id) return null;
  const canon = hub.repo(row.repo_id)?.canonical_url;
  const full = typeof canon === 'string' && canon.startsWith('github.com/') ? canon.slice('github.com/'.length).toLowerCase() : null;
  const orgId = full ? hub.board(row.board_id)?.org_id : null;
  if (!orgId) return null;
  const links = hub.db.all(`SELECT a.connection_id FROM integration_app_repos a JOIN connections c ON c.id = a.connection_id
    WHERE c.org_id = ? AND c.provider = ? AND c.status = 'active' AND lower(a.full_name) = ?`, orgId, provider, full);
  if (links.length !== 1) return null;
  const pr = hub.db.get("SELECT 1 AS x FROM external_links WHERE connection_id = ? AND card_id = ? AND kind = 'pr'", links[0].connection_id, row.id);
  const branch = hub.db.get('SELECT 1 AS x FROM runs WHERE card_id = ? AND branch IS NOT NULL LIMIT 1', row.id);
  return { open_pr: !pr && !!branch && row.column_name !== 'done', comment: !!pr };
}
