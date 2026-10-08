// What a verified provider delivery means to event triggers (triggers.js),
// the pure half: no I/O, so every branch is testable with recorded fixtures.
// An event is {type, id, repo?, branch?, labels?, number?, title?, url?,
// card_id?, subject}. `id` is the dedupe key (one firing per rule and id);
// `subject` is the short reference the activity log keeps (never provider
// text). Pull requests from forks never trigger: anyone can open one.

import { dedupeKey } from './integrations/github/webhook.js';
import { issueEvent } from './integrations/sentry/events.js';

const FAILING = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'cancelled']);
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const int = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || null : null);
const branchOf = (v) => (typeof v === 'string' && v && v.length <= 250 && !/[\s\p{Cc}]/u.test(v) ? v : null);

function prEvent(type, event, p, { connectionId, linked }) {
  const repo = p.repository, pr = p.pull_request;
  const repoId = int(repo?.id);
  // Same repository on both sides, by id: a fork's PR is anyone's.
  if (!pr || repoId === null || int(pr.head?.repo?.id) !== repoId || int(pr.base?.repo?.id) !== repoId) return [];
  const number = int(pr.number);
  if (!number) return [];
  const url = `https://github.com/${repo.full_name}/pull/${number}`;
  return [{
    type, id: `github:${connectionId}:${dedupeKey(event, p)}`, repo: repo.full_name, branch: branchOf(pr.head?.ref), base_ref: branchOf(pr.base?.ref),
    number, title: text(pr.title, 160), url: pr.html_url === url ? url : null,
    labels: (Array.isArray(pr.labels) ? pr.labels : []).map((l) => text(l?.name, 50)).filter(Boolean).slice(0, 20),
    author: typeof pr.user?.login === 'string' && LOGIN.test(pr.user.login) ? pr.user.login : null,
    card_id: pr.id != null ? linked('pr', String(pr.id)) : null, subject: `${repo.full_name}#${number}`,
  }];
}

// A failing suite on a PR from a branch of the same repository; one event per suite and head.
function checksEvent(event, p, { connectionId, linked }) {
  const repo = p.repository, suite = p.check_suite;
  const repoId = int(repo?.id), sha = typeof suite?.head_sha === 'string' ? suite.head_sha : null;
  if (p.action !== 'completed' || !FAILING.has(String(suite?.conclusion ?? '')) || repoId === null || !sha) return [];
  const prs = (Array.isArray(suite.pull_requests) ? suite.pull_requests : [])
    .filter((x) => x?.head?.sha === sha && int(x?.head?.repo?.id) === repoId && int(x?.base?.repo?.id) === repoId && int(x?.number)).slice(0, 20);
  if (!prs.length) return [];
  const card = prs.map((x) => (x.id != null ? linked('pr', String(x.id)) : null)).find(Boolean) ?? null;
  const number = int(prs[0].number);
  return [{
    type: 'github.checks.failed', id: `github:${connectionId}:${dedupeKey(event, p)}`, repo: repo.full_name, branch: branchOf(prs[0].head?.ref ?? suite.head_branch),
    number, title: null, url: `https://github.com/${repo.full_name}/pull/${number}`, labels: [], card_id: card, subject: `${repo.full_name}#${number}`,
  }];
}

/** The trigger events in one verified GitHub delivery. `linked(kind, externalId)` → the card a link of this connection names. */
export function githubTriggerEvents(event, p, { connectionId, linked = () => null }) {
  if (!p || typeof p !== 'object' || typeof p.repository?.full_name !== 'string' || !REPO.test(p.repository.full_name)) return [];
  const opts = { connectionId, linked };
  if (event === 'pull_request' && ['opened', 'reopened'].includes(p.action)) return prEvent('github.pr.opened', event, p, opts);
  if (event === 'pull_request' && p.action === 'review_requested') return prEvent('github.pr.review_requested', event, p, opts);
  if (event === 'check_suite') return checksEvent(event, p, opts);
  return [];
}

/** A new Sentry issue (the connector's own fresh, signed `created` check, events.js). */
export function sentryTriggerEvents(p, { connectionId, now, config = {}, linked = () => null }) {
  const e = issueEvent(p, { now, config });
  if (!e || e.action !== 'created') return [];
  const project = e.projects[0];
  return [{
    type: 'sentry.issue.new', id: `sentry:${connectionId}:issue:${e.id}`, repo: null, branch: null, labels: [],
    title: text(e.title, 160), body: typeof e.body === 'string' ? e.body.slice(0, 4000) : '', url: e.url ?? null,
    card_id: linked('issue', e.id), subject: `${project} ${e.id}`.slice(0, 160),
  }];
}
