'use strict';
// Open pull requests by head branch, from the pages src/github-signals.js
// already fetched for one repo (open pulls, your Actions runs, reviews on your
// own PRs). No GitHub call of its own. My board links an observed session's
// card to the PR its branch has open (src/work-capture.js, local cards only).
//
// The values match the hub's link status allowlist (board/hub/integrations/
// connector.js LINK_STATUS), so the card face reads both the same way.
const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'cancelled', 'action_required']);
const PULL_URL = /^https:\/\/github\.com\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*\/pull\/[1-9][0-9]{0,9}$/;
const BRANCH_MAX = 255;

// Checks on the PR's head: only runs you triggered (the poll asks actor=<you>), newest per workflow.
function checksFor(pr, runs, isDeploy) {
  const latest = new Map();
  const sha = pr.head && pr.head.sha;
  for (const r of runs) {
    if (!r || r.head_branch !== pr.head.ref || isDeploy(r.name) || (sha && r.head_sha && r.head_sha !== sha)) continue;
    const at = Date.parse(r.updated_at || r.created_at || '') || 0;
    const seen = latest.get(r.workflow_id);
    if (!seen || at > seen.at) latest.set(r.workflow_id, { at, r });
  }
  const now = [...latest.values()].map((x) => x.r);
  if (!now.length) return null;
  if (now.some((r) => r.status !== 'completed')) return 'pending';
  if (now.some((r) => FAILED.has(r.conclusion))) return 'failing';
  return now.some((r) => r.conclusion === 'success') ? 'passing' : 'none';
}

// Each reviewer's newest verdict counts; a change request outweighs an approval.
function reviewFor(pr, reviews) {
  const by = new Map();
  for (const rv of reviews || []) {
    if (!rv || !rv.user || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(rv.state)) continue;
    by.set(rv.user.login, rv.state);
  }
  const states = [...by.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  return (pr.requested_reviewers || []).length || (pr.requested_teams || []).length ? 'requested' : 'none';
}

function index({ pulls = [], runs = [], reviews = {}, isDeploy = () => false }) {
  const out = {};
  for (const pr of pulls) {
    const ref = pr && pr.head && pr.head.ref;
    if (typeof ref !== 'string' || !ref || ref.length > BRANCH_MAX || !Number.isSafeInteger(pr.number) || pr.number <= 0 || typeof pr.html_url !== 'string' || !PULL_URL.test(pr.html_url)) continue;
    if (pr.head.repo && pr.base && pr.base.repo && pr.head.repo.full_name !== pr.base.repo.full_name) continue;
    if (out[ref] && out[ref].number > pr.number) continue;
    out[ref] = { number: pr.number, url: pr.html_url, state: pr.draft ? 'draft' : 'open', checks: checksFor(pr, runs, isDeploy), review: reviewFor(pr, reviews[pr.number]) };
  }
  return out;
}

module.exports = { index, checksFor, reviewFor };
