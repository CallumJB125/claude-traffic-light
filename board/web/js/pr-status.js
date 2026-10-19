// A card's linked pull request as one compact chip, and whether it waits on
// the viewer's review. Pure, from fields CardView already carries: `pr` (the
// hub's PR evidence), `pr_link_status` (the GitHub integration's state, checks
// and review) and, on My board, `capture.pr` (the desktop's own GitHub poll).
//
// The hub knows a review was requested on a PR, not from whom, so "waiting on
// you" is the board's notion of a reviewer: an approver named on the card, or,
// when nobody is named, anyone on the board who is not its author.

const OPEN = new Set(['open', 'draft']);
const CHECKS = { passing: 'checks passing', failing: 'checks failing', pending: 'checks running' };
const REVIEW = { approved: 'review: approved', changes_requested: 'review: changes requested', requested: 'review: waiting' };
const CHECKS_TITLE = { passing: 'Checks are passing', failing: 'Checks are failing', pending: 'Checks are running' };
const REVIEW_TITLE = { approved: 'Approved', changes_requested: 'Changes were requested', requested: 'Waiting for a review' };
const STATE_TITLE = { open: 'open', draft: 'a draft', merged: 'merged', closed: 'closed without merging' };

/** {number, url, state, checks, review} for the card's PR, or null. */
export function linkedPr(view) {
  const s = view?.pr_link_status ?? view?.capture?.pr ?? null;
  const number = view?.pr?.number ?? s?.number ?? null;
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const state = view?.pr?.state === 'merged' ? 'merged' : s?.state ?? view?.pr?.state ?? 'open';
  return { number, url: view?.pr?.url ?? s?.url ?? null, state, checks: s?.checks ?? null, review: s?.review ?? null };
}

export function prChip(view) {
  const pr = linkedPr(view);
  if (!pr) return null;
  const live = OPEN.has(pr.state);
  const parts = [`PR #${pr.number}`];
  if (!live) parts.push(pr.state);
  else {
    if (pr.state === 'draft') parts.push('draft');
    if (CHECKS[pr.checks]) parts.push(CHECKS[pr.checks]);
    if (REVIEW[pr.review]) parts.push(REVIEW[pr.review]);
  }
  const tone = !live ? 'quiet' : pr.checks === 'failing' ? 'red' : pr.review === 'changes_requested' ? 'amber'
    : pr.checks === 'passing' && pr.review === 'approved' ? 'green' : 'quiet';
  const icon = pr.state === 'merged' || tone === 'green' ? 'check' : tone === 'red' ? 'cross' : tone === 'amber' ? 'warn' : 'branch';
  return {
    id: 'pr', text: parts.join(' · '), tone, icon,
    title: [`Pull request #${pr.number} is ${STATE_TITLE[pr.state] ?? pr.state}`, live ? CHECKS_TITLE[pr.checks] : null, live ? REVIEW_TITLE[pr.review] : null, pr.url ? 'Open it on GitHub' : null].filter(Boolean).join(' · '),
    href: pr.url,
  };
}

export function waitingOnYou(view, viewerId) {
  const pr = linkedPr(view);
  if (!viewerId || !pr || !OPEN.has(pr.state) || pr.review !== 'requested' || view.capture) return false;
  if (view.run?.owner?.member_id === viewerId || view.run?.dispatched_by?.member_id === viewerId) return false;
  const approvers = view.approvers ?? [];
  return approvers.length ? approvers.includes(viewerId) : !(view.assignee_ids ?? []).includes(viewerId);
}
