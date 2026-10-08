// GitHub webhooks, the pure half: check the signature over the raw bytes,
// pick a replay key from signed content, and reduce a payload to the facts
// the connector acts on. No I/O, so every branch of it is testable with
// recorded fixtures.
//
// GitHub signs the body (X-Hub-Signature-256: sha256=<hex HMAC>) but no
// timestamp, and X-GitHub-Delivery is not signed. So the replay key is built
// from the signed body: event, action, the object's id and its own update
// time (README: "a dedupe_key that covers signed content").

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const EVENTS = Object.freeze(['pull_request', 'pull_request_review', 'check_suite', 'check_run', 'push', 'issue_comment', 'ping']);

const header = (headers, name) => {
  const v = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v == null ? '' : String(v);
};

export function sign(secret, rawBody) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/**
 * { ok: true, event, dedupe_key } | { ok: false, reason }. Only the signature
 * decides: a signed event this connector does not act on (installation,
 * push…) is still GitHub's, so it verifies, and handleWebhook ignores it
 * instead of spending the connection's failure budget on a 401.
 */
export function verify({ headers, rawBody, secrets }) {
  const secret = secrets?.webhook_secret;
  if (typeof secret !== 'string' || secret.length < 16) return { ok: false, reason: 'no webhook secret' };
  const got = Buffer.from(header(headers, 'x-hub-signature-256'));
  const want = Buffer.from(sign(secret, rawBody));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'signature mismatch' };
  const event = header(headers, 'x-github-event').replace(/[^a-z_]/g, '').slice(0, 40);
  let payload = null;
  try { payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)); } catch { /* the registry answers 400 */ }
  return { ok: true, event, dedupe_key: dedupeKey(event, payload && typeof payload === 'object' ? payload : {}, rawBody) };
}

const OBJECT_OF = { pull_request: 'pull_request', pull_request_review: 'review', check_suite: 'check_suite', check_run: 'check_run', ping: 'hook' };
const WHEN_OF = { pull_request: 'updated_at', pull_request_review: 'submitted_at', check_suite: 'updated_at', check_run: 'completed_at', ping: 'updated_at' };

// Replay key from signed fields; a hash keeps it short and scalar. A review
// is keyed by its own id (two reviews on one PR in one second are two
// events); any other event (push, issue_comment, one it ignores) by its whole body.
export function dedupeKey(event, p, rawBody = JSON.stringify(p)) {
  if (!OBJECT_OF[event]) return `${event}:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`;
  const obj = p[OBJECT_OF[event]] ?? {};
  const parts = [event, p.action ?? '', String(obj.id ?? ''), String(obj[WHEN_OF[event]] ?? ''), String(p.pull_request?.head?.sha ?? p.check_suite?.head_sha ?? p.check_run?.head_sha ?? '')];
  return `${event}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : v == null ? null : String(v).slice(0, max));
const int = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const login = (u) => (u && typeof u.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(u.login) ? u.login : null);

// A PR can be linked to a card only when its branch lives in the base repo
// itself: anyone can push a branch named board/KEY-r1 to a fork and open a
// PR from it. Compared by repo id: names can be renamed, recased or reused.
function sameRepo(pr, repository) {
  const id = int(repository?.id);
  return id !== null && int(pr?.head?.repo?.id) === id && int(pr?.base?.repo?.id) === id;
}

function prFacts(pr, repository) {
  return {
    repo: str(repository?.full_name, 140),
    default_branch: str(repository?.default_branch, 250),
    pr_id: str(pr?.id, 30),
    number: int(pr?.number),
    url: typeof pr?.html_url === 'string' && pr.html_url.startsWith('https://github.com/') ? pr.html_url.slice(0, 300) : null,
    branch: sameRepo(pr, repository) ? str(pr?.head?.ref, 250) : null,
    base_ref: str(pr?.base?.ref, 250),
    head_sha: str(pr?.head?.sha, 40),
    draft: pr?.draft === true,
    // GitHub sends `edited` and review events for closed PRs too.
    open: pr?.state === 'open',
    merged: pr?.merged === true,
  };
}

// Reviews from people with write access only: on a public repo anyone can
// submit an approving review.
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const FAILING = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'cancelled']);
const SHA = /^[0-9a-f]{40}$/;

// The PR's own html URL in this repository, else null.
function prUrlOf(v, fullName) {
  if (typeof v !== 'string' || typeof fullName !== 'string') return null;
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]{0,9})$/.exec(v);
  return m && m[1].toLowerCase() === fullName.toLowerCase() ? v : null;
}

// A suite or run speaks only for the PRs it actually ran for: same head commit, same repo.
function checkFacts(obj, repository, checks) {
  const headSha = str(obj?.head_sha, 40);
  const repoId = int(repository.id);
  const prs = (Array.isArray(obj?.pull_requests) ? obj.pull_requests : [])
    .filter((x) => headSha && x?.head?.sha === headSha && repoId !== null && int(x?.base?.repo?.id) === repoId)
    .map((x) => ({ pr_id: str(x?.id, 30), number: int(x?.number) })).filter((x) => x.pr_id && x.number).slice(0, 20);
  return prs.length ? [{ kind: 'pr.checks', repo: str(repository.full_name, 140), head_sha: headSha, prs, checks }] : [];
}

/**
 * The facts in one delivery, in the order to apply them. Each is one of:
 *   { kind: 'pr.opened' | 'pr.updated', ...pr, review_requested?, checks_pending? }   link / refresh status
 *   { kind: 'pr.merged', ...pr, by }                      → system pr_merged
 *   { kind: 'pr.closed', ...pr, by }                      → system pr_closed (unmerged)
 *   { kind: 'pr.review', ...pr, review: 'approved'|'changes_requested'|'commented'|'dismissed' }
 *   { kind: 'pr.checks', repo, head_sha, prs: [{pr_id, number}], checks: 'success'|'failure'|'pending' }
 *   { kind: 'branch.push', repo, branch, head_sha }       a new head on a branch (checks pending again)
 *   { kind: 'pr.comment', repo, number, url, comment_id, comment_url, by }   a trusted person commented on a PR
 */
export function factsOf(event, p) {
  const repository = p?.repository;
  if (typeof repository?.full_name !== 'string') return [];
  if (event === 'pull_request') {
    const pr = p.pull_request;
    if (!pr) return [];
    const base = prFacts(pr, repository);
    switch (p.action) {
      case 'opened': case 'reopened': return [{ kind: 'pr.opened', ...base }];
      // A new head: the old checks no longer describe it.
      case 'synchronize': return [{ kind: 'pr.updated', ...base, checks_pending: true }];
      case 'review_requested': return [{ kind: 'pr.updated', ...base, review_requested: true }];
      case 'edited': case 'ready_for_review': case 'converted_to_draft': case 'review_request_removed':
        return [{ kind: 'pr.updated', ...base }];
      case 'closed':
        return [{ kind: pr.merged === true ? 'pr.merged' : 'pr.closed', ...base, by: login(pr.merged === true ? pr.merged_by : p.sender) }];
      default: return [];
    }
  }
  if (event === 'pull_request_review' && ['submitted', 'dismissed'].includes(p.action)) {
    if (!TRUSTED.has(p.review?.author_association)) return [];
    const state = String(p.review?.state ?? '').toLowerCase();
    const review = p.action === 'dismissed' ? 'dismissed' : state === 'approved' ? 'approved' : state === 'changes_requested' ? 'changes_requested' : 'commented';
    return [{ kind: 'pr.review', ...prFacts(p.pull_request, repository), review, by: login(p.review?.user) }];
  }
  if (event === 'check_suite') {
    const suite = p.check_suite;
    let checks = null;
    if (p.action === 'requested' || p.action === 'rerequested') checks = 'pending';
    else if (p.action === 'completed') {
      const c = String(suite?.conclusion ?? '');
      checks = c === 'success' ? 'success' : FAILING.has(c) ? 'failure' : null; // neutral, skipped, stale: no news
    }
    return checks ? checkFacts(suite, repository, checks) : [];
  }
  // One failing check run is news before its suite completes; a passing one
  // is not (the others may still fail), so only the suite says passing.
  if (event === 'check_run') {
    const run = p.check_run;
    return p.action === 'completed' && FAILING.has(String(run?.conclusion ?? '')) ? checkFacts(run, repository, 'failure') : [];
  }
  if (event === 'push') {
    const ref = typeof p.ref === 'string' ? p.ref : '';
    if (!ref.startsWith('refs/heads/') || ref.length > 11 + 250 || p.deleted === true || !SHA.test(p.after ?? '')) return [];
    return [{ kind: 'branch.push', repo: str(repository.full_name, 140), default_branch: str(repository.default_branch, 250), branch: ref.slice('refs/heads/'.length), head_sha: p.after }];
  }
  // A comment on a PR by someone with write access, never a bot's (the
  // app's own status comments come back as issue_comment events).
  if (event === 'issue_comment' && p.action === 'created') {
    const c = p.comment;
    const url = prUrlOf(p.issue?.pull_request?.html_url, repository.full_name);
    const commentUrl = url && typeof c?.html_url === 'string' && c.html_url.startsWith(url) && /^#issuecomment-[0-9]{1,20}$/.test(c.html_url.slice(url.length)) ? c.html_url : null;
    if (!commentUrl || !TRUSTED.has(c?.author_association) || c?.user?.type === 'Bot' || !int(c?.id)) return [];
    return [{ kind: 'pr.comment', repo: str(repository.full_name, 140), number: Number(url.slice(url.lastIndexOf('/') + 1)), url, comment_id: c.id, comment_url: commentUrl, by: login(c.user) }];
  }
  return [];
}

/**
 * Where one delivery to the hub's own app goes (step 4): the installation it
 * is for and the repository it is about, or that installation's lifecycle
 * ({op: 'deleted' | 'suspend' | 'unsuspend' | 'repositories_removed', repo_ids}).
 * null: nothing to route (no installation, a ping, an event about no repository).
 */
export function appRoute(event, p) {
  const installation = int(p?.installation?.id);
  if (!installation) return null;
  if (event === 'installation') return ['deleted', 'suspend', 'unsuspend'].includes(p.action) ? { installation_id: installation, lifecycle: { op: p.action } } : null;
  if (event === 'installation_repositories') {
    if (p.action !== 'removed') return null;
    const ids = (Array.isArray(p.repositories_removed) ? p.repositories_removed : []).map((r) => int(r?.id)).filter(Boolean).slice(0, 1000);
    return ids.length ? { installation_id: installation, lifecycle: { op: 'repositories_removed', repo_ids: ids } } : null;
  }
  const repo = int(p?.repository?.id);
  return EVENTS.includes(event) && event !== 'ping' && repo ? { installation_id: installation, repo_id: repo } : null;
}
