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

export function tacklePreference(memberId, storage, defaultBudget = 5) {
  const defaults = { ai: 'codex', budget_mode: 'cap', budget_usd: Number.isFinite(defaultBudget) && defaultBudget >= 0.5 && defaultBudget <= 1000 ? defaultBudget : 5 };
  if (!memberId) return defaults;
  try {
    const value = JSON.parse((storage ?? globalThis.localStorage).getItem(`plexiform-tackle:${memberId}`));
    return { ai: AI_IDS.includes(value?.ai) ? value.ai : defaults.ai,
      budget_mode: value?.budget_mode === 'none' ? 'none' : 'cap',
      budget_usd: Number.isFinite(value?.budget_usd) && value.budget_usd >= 0.5 && value.budget_usd <= 1000 ? value.budget_usd : defaults.budget_usd };
  } catch { return defaults; }
}
export function rememberTackle(memberId, choice, storage) {
  if (!memberId) return;
  try { (storage ?? globalThis.localStorage).setItem(`plexiform-tackle:${memberId}`, JSON.stringify(choice)); } catch { /* storage off */ }
}
