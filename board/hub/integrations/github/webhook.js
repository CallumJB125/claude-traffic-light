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

/** { ok: true, event, payload, dedupe_key } | { ok: false, reason } */
export function verify({ headers, rawBody, secrets }) {
  const secret = secrets?.webhook_secret;
  if (typeof secret !== 'string' || secret.length < 16) return { ok: false, reason: 'no webhook secret' };
  const got = Buffer.from(header(headers, 'x-hub-signature-256'));
  const want = Buffer.from(sign(secret, rawBody));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'signature mismatch' };
  const event = header(headers, 'x-github-event');
  if (!EVENTS.includes(event)) return { ok: false, reason: `ignored event ${event.slice(0, 40)}` };
  let payload;
  try { payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)); } catch { return { ok: false, reason: 'body is not JSON' }; }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'body is not an object' };
  return { ok: true, event, payload, dedupe_key: dedupeKey(event, payload) };
}

// Replay key from signed fields; a hash keeps it short and scalar.
export function dedupeKey(event, p) {
  const obj = p.pull_request ?? p.review ?? p.check_suite ?? p.hook ?? {};
  const when = p.review?.submitted_at ?? p.check_suite?.updated_at ?? p.pull_request?.updated_at ?? p.hook?.updated_at ?? '';
  const parts = [event, p.action ?? '', String(obj.id ?? ''), String(when), String(p.pull_request?.head?.sha ?? p.check_suite?.head_sha ?? '')];
  return `${event}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : v == null ? null : String(v).slice(0, max));
const int = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const login = (u) => (u && typeof u.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(u.login) ? u.login : null);

// A PR can be linked to a card only when its branch lives in the base repo
// itself: anyone can push a branch named board/KEY-r1 to a fork and open a
// PR from it.
function sameRepo(pr) {
  const base = pr?.base?.repo?.full_name;
  const head = pr?.head?.repo?.full_name;
  return typeof base === 'string' && typeof head === 'string' && base.toLowerCase() === head.toLowerCase();
}

function prFacts(pr, repo) {
  return {
    repo: str(repo, 140),
    pr_id: str(pr?.id, 30),
    number: int(pr?.number),
    url: typeof pr?.html_url === 'string' && pr.html_url.startsWith('https://github.com/') ? pr.html_url.slice(0, 300) : null,
    branch: sameRepo(pr) ? str(pr?.head?.ref, 250) : null,
    head_sha: str(pr?.head?.sha, 40),
    draft: pr?.draft === true,
  };
}

/**
 * The facts in one delivery, in the order to apply them. Each is one of:
 *   { kind: 'pr.opened' | 'pr.updated', ...pr }          link / refresh status
 *   { kind: 'pr.merged', ...pr, by }                      → system pr_merged
 *   { kind: 'pr.closed', ...pr, by }                      → system pr_closed (unmerged)
 *   { kind: 'pr.review', ...pr, review: 'approved'|'changes_requested'|'commented' }
 *   { kind: 'pr.checks', repo, head_sha, prs: [{pr_id, number}], checks: 'success'|'failure'|'pending'|'neutral' }
 */
export function factsOf(event, p) {
  const repo = p?.repository?.full_name;
  if (typeof repo !== 'string') return [];
  if (event === 'pull_request') {
    const pr = p.pull_request;
    if (!pr) return [];
    const base = prFacts(pr, repo);
    switch (p.action) {
      case 'opened': case 'reopened': return [{ kind: 'pr.opened', ...base }];
      case 'synchronize': case 'edited': case 'ready_for_review': case 'converted_to_draft': case 'review_requested': case 'review_request_removed':
        return [{ kind: 'pr.updated', ...base, review_requested: (pr.requested_reviewers ?? []).length > 0 }];
      case 'closed':
        return [{ kind: pr.merged === true ? 'pr.merged' : 'pr.closed', ...base, by: login(pr.merged === true ? pr.merged_by : p.sender) }];
      default: return [];
    }
  }
  if (event === 'pull_request_review' && p.action === 'submitted') {
    const state = String(p.review?.state ?? '').toLowerCase();
    const review = state === 'approved' ? 'approved' : state === 'changes_requested' ? 'changes_requested' : 'commented';
    return [{ kind: 'pr.review', ...prFacts(p.pull_request, repo), review, by: login(p.review?.user) }];
  }
  if (event === 'check_suite' && p.action === 'completed') {
    const c = String(p.check_suite?.conclusion ?? '');
    const checks = c === 'success' ? 'success' : ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(c) ? 'failure' : c ? 'neutral' : 'pending';
    const prs = (p.check_suite?.pull_requests ?? []).map((x) => ({ pr_id: str(x?.id, 30), number: int(x?.number) })).filter((x) => x.pr_id && x.number).slice(0, 20);
    return [{ kind: 'pr.checks', repo: str(repo, 140), head_sha: str(p.check_suite?.head_sha, 40), prs, checks }];
  }
  return [];
}
