// Closed execution providers and the public part of runner readiness. No
// paths, authentication files or arbitrary provider labels cross this API.
export const AI_IDS = Object.freeze(['claude', 'codex']);
export const AI_LABELS = Object.freeze({ claude: 'Claude Code', codex: 'Codex' });
export const AI_BACKENDS = Object.freeze({ claude: 'claude_cli', codex: 'codex_cli' });
export const BUDGET_MAX_USD = 1000;
export const aiOfDispatch = (d) => d?.ai ?? (d?.backend === 'codex_cli' ? 'codex' : 'claude');

export function aiListError(list) {
  if (!Array.isArray(list) || list.length > 8) return 'ai must be a list of at most 8 providers';
  const seen = new Set();
  for (const a of list) {
    if (!a || typeof a !== 'object' || !AI_IDS.includes(a.id) || seen.has(a.id)) return 'unknown or duplicate AI provider';
    seen.add(a.id);
    if (typeof a.installed !== 'boolean' || ![true, false, 'unknown'].includes(a.signedIn)) return 'invalid AI readiness';
    if (a.startable != null && typeof a.startable !== 'boolean') return 'invalid AI startable flag';
    if (typeof a.label !== 'string' || !a.label || a.label.length > 40 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(a.label)) return 'invalid AI label';
    if (a.version != null && (typeof a.version !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(a.version))) return 'invalid AI version';
    if (!a.capabilities || !['native', 'metered', 'none'].includes(a.capabilities.budget) || typeof a.capabilities.resume !== 'boolean') return 'invalid AI capabilities';
  }
  return null;
}

export function runnerAis(list) {
  if (list === undefined) return [{ id: 'claude', label: AI_LABELS.claude, installed: true, signedIn: 'unknown', startable: true, capabilities: { budget: 'native', resume: true }, legacy: true }];
  return list.map((a) => ({ id: a.id, label: AI_LABELS[a.id], installed: a.installed, signedIn: a.signedIn, startable: a.startable !== false, capabilities: { budget: a.capabilities.budget, resume: a.capabilities.resume }, legacy: false }));
}
export function readiness(a) {
  if (!a?.installed) return 'not_installed';
  if (!a.startable) return 'unsupported_version';
  if (a.signedIn === false) return 'signed_out';
  return a.signedIn === 'unknown' ? 'may_need_sign_in' : null;
}
export function acceptsAi(conn, ai, budgetUsd = null) {
  const a = (conn.ai ?? runnerAis(undefined)).find((x) => x.id === ai);
  return !!a && [null, 'may_need_sign_in'].includes(readiness(a)) && (budgetUsd == null || a.capabilities.budget !== 'none');
}
