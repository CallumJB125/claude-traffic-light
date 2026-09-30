// Runner-local trust policy (CONTRACT §6.4, T1). policy.json is authoritative;
// the hub's view is display only.
import { normalizeRemoteUrl } from '../shared/scope.js';

export const DEFAULT_MAX_CONCURRENT = 2;

/**
 * What to do with an offer: {action:'claim'|'confirm'|'decline'|'defer', reason}.
 *  - self-dispatch → claim, no confirm
 *  - teammate in accept_from[repo_id] → claim (per-repo auto-accept)
 *  - other teammate → confirm (local callback; headless default = deny)
 * 'defer' = leave it queued for now (at capacity) without declining.
 */
export function decideOffer(offer, { policy, ownerId, activeCount = 0 }) {
  const repo = policy.repos?.[offer.repo_id];
  if (!repo?.opt_in) return { action: 'decline', reason: 'repo not opted in on this machine' };
  const never = new Set(policy.never_auto_labels ?? []);
  if ((offer.labels ?? []).some((l) => never.has(l))) return { action: 'decline', reason: 'never_auto label' };
  if (activeCount >= (repo.max_concurrent ?? DEFAULT_MAX_CONCURRENT)) return { action: 'defer', reason: 'at max_concurrent' };
  const by = offer.dispatched_by?.member_id;
  if (by && by === ownerId) return { action: 'claim', reason: 'self' };
  if (by && (policy.accept_from?.[offer.repo_id] ?? []).includes(by)) return { action: 'claim', reason: 'auto_accept' };
  return { action: 'confirm', reason: 'teammate dispatch' };
}

/** Repos this runner may advertise: opted in locally AND on a board allowlist (D14). */
export function advertisable(policy, allowlist) {
  const allowed = new Set((allowlist ?? []).map((r) => r.repo_id));
  return Object.entries(policy.repos ?? {})
    .filter(([id, r]) => r?.opt_in && allowed.has(id))
    .map(([id, r]) => ({
      repo_id: id,
      canonical_url: normalizeRemoteUrl(allowlist.find((a) => a.repo_id === id).canonical_url) ?? allowlist.find((a) => a.repo_id === id).canonical_url,
      approvals_from: r.approvals_from ?? [],
      auto_accept_from: policy.accept_from?.[id] ?? [],
    }));
}

/**
 * T1 re-check of a permission answer: only the owner or someone in the repo's
 * local approvals_from may allow a tool on this machine. Fail-closed.
 */
export function answererAllowed(policy, repoId, ownerId, answeredBy) {
  const id = answeredBy?.member_id;
  if (!id) return false;
  if (id === ownerId) return true;
  return (policy.repos?.[repoId]?.approvals_from ?? []).includes(id);
}

// "Allow for this run": same tool and, for Bash, the same first command word.
export function runAllowKey(toolName, input) {
  if (toolName === 'Bash') {
    const word = String(input?.command ?? '').trim().split(/\s+/)[0] ?? '';
    return `Bash:${word}`;
  }
  return toolName;
}
