import { AI_IDS, AI_LABELS } from '../../shared/ai.js';

// Merge readiness across the target's online devices. A cap is offered only
// when every available device for that provider can actually enforce it.
export function tackleChoices(runners = []) {
  return AI_IDS.map((id) => {
    const entries = runners.flatMap((r) => r.ai ?? []).filter((a) => a.id === id);
    const available = entries.filter((a) => a.available);
    return { id, label: AI_LABELS[id], available: !runners.length || !!available.length,
      reason: available.length ? (available.every((a) => a.reason === 'may_need_sign_in') ? 'may_need_sign_in' : null) : entries[0]?.reason ?? 'not_installed',
      budget: (available.length ? available : entries).some((a) => a.budget === 'none') || id === 'codex' ? 'none' : 'native' };
  });
}
export const readinessText = (reason) => ({ not_installed: 'not installed', signed_out: 'sign in first', unsupported_version: 'update Codex first', may_need_sign_in: 'may need sign-in' }[reason] ?? '');
