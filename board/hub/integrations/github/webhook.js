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

export const EVENTS = Object.freeze(['pull_request', 'pull_request_review', 'check_suite', 'ping']);

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

const OBJECT_OF = { pull_request: 'pull_request', pull_request_review: 'review', check_suite: 'check_suite', ping: 'hook' };
const WHEN_OF = { pull_request: 'updated_at', pull_request_review: 'submitted_at', check_suite: 'updated_at', ping: 'updated_at' };

// Replay key from signed fields; a hash keeps it short and scalar. A review
// is keyed by its own id (two reviews on one PR in one second are two
// events); an event this connector ignores is keyed by its whole body.
export function dedupeKey(event, p, rawBody = JSON.stringify(p)) {
  if (!OBJECT_OF[event]) return `${event}:${createHash('sha256').update(rawBody).digest('hex').slice(0, 32)}`;
  const obj = p[OBJECT_OF[event]] ?? {};
  const parts = [event, p.action ?? '', String(obj.id ?? ''), String(obj[WHEN_OF[event]] ?? ''), String(p.pull_request?.head?.sha ?? p.check_suite?.head_sha ?? '')];
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

/**
 * The facts in one delivery, in the order to apply them. Each is one of:
 *   { kind: 'pr.opened' | 'pr.updated', ...pr, review_requested?, checks_pending? }   link / refresh status
 *   { kind: 'pr.merged', ...pr, by }                      → system pr_merged
 *   { kind: 'pr.closed', ...pr, by }                      → system pr_closed (unmerged)
 *   { kind: 'pr.review', ...pr, review: 'approved'|'changes_requested'|'commented'|'dismissed' }
 *   { kind: 'pr.checks', repo, head_sha, prs: [{pr_id, number}], checks: 'success'|'failure'|'pending' }
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
    if (!checks) return [];
    const headSha = str(suite?.head_sha, 40);
    const repoId = int(repository.id);
    // Only the PRs this suite actually ran for: same head commit, same repo.
    const prs = (Array.isArray(suite?.pull_requests) ? suite.pull_requests : [])
      .filter((x) => headSha && x?.head?.sha === headSha && repoId !== null && int(x?.base?.repo?.id) === repoId)
      .map((x) => ({ pr_id: str(x?.id, 30), number: int(x?.number) })).filter((x) => x.pr_id && x.number).slice(0, 20);
    return prs.length ? [{ kind: 'pr.checks', repo: str(repository.full_name, 140), head_sha: headSha, prs, checks }] : [];
  }
  return [];
}
