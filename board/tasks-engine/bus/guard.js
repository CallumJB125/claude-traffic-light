// Admission for agent bus handoffs (board/AGENT-BUS.md §5). Every check is a
// refusal with a reason the caller can read; nothing here prompts or waits.
// Order: halt, tier and scope, loops, rate and per-card/per-repo caps, circuit
// breaker, spend reservation.
import { BUS_RUN_PROVIDERS } from '../../shared/bus-schema.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true, auto_accept: true, accept_tiers: ['person', 'run_capability'], allow_pr: false, max_parallel: 2,
  stop_on_partition: true, wall_clock_min: 20, max_hops: 2,
  // Owner decision 2026-10-22: caps exist, default off.
  caps: { enabled: false, member_usd: 20, team_usd: 100, handoff_usd: 5 },
  rates: { agent_per_h: 20, member_per_h: 60, card_per_day: 6, repo_per_day: 12, failures_per_h: 3 },
});

export function mergeSettings(...layers) {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    for (const [k, v] of Object.entries(l)) {
      if (!Object.hasOwn(DEFAULT_SETTINGS, k)) continue;
      if (k === 'caps' || k === 'rates') { for (const [kk, vv] of Object.entries(v ?? {})) if (typeof vv === typeof DEFAULT_SETTINGS[k][kk]) out[k][kk] = vv; }
      else if (k === 'accept_tiers') { if (Array.isArray(v)) out[k] = v.filter((t) => ['person', 'run_capability', 'local_attested'].includes(t)); }
      else if (typeof v === typeof DEFAULT_SETTINGS[k]) out[k] = v;
    }
  }
  out.max_hops = Math.min(Math.max(1, Math.round(out.max_hops)), 5);
  out.wall_clock_min = Math.min(Math.max(1, Math.round(out.wall_clock_min)), 24 * 60);
  return out;
}

// policy.json and Preferences each may set these; whichever is stricter wins (off beats on, the shorter clock,
// caps on, the lower cap). A key only one of them sets is taken from it.
const STRICT = { enabled: (a, b) => a && b, auto_accept: (a, b) => a && b, wall_clock_min: Math.min };
const STRICT_CAPS = { enabled: (a, b) => a || b, member_usd: Math.min, team_usd: Math.min, handoff_usd: Math.min };
export function strictSettings(policy, prefs) {
  const out = mergeSettings(policy, prefs);
  const a = mergeSettings(policy), b = mergeSettings(prefs);
  const sets = (l, k, kk) => !!l && typeof l === 'object' && (kk ? typeof l[k]?.[kk] === typeof DEFAULT_SETTINGS[k][kk] : typeof l[k] === typeof DEFAULT_SETTINGS[k]);
  for (const [k, f] of Object.entries(STRICT)) if (sets(policy, k) && sets(prefs, k)) out[k] = f(a[k], b[k]);
  for (const [k, f] of Object.entries(STRICT_CAPS)) if (sets(policy, 'caps', k) && sets(prefs, 'caps', k)) out.caps[k] = f(a.caps[k], b.caps[k]);
  return out;
}

export const dayOf =(ms) => new Date(ms).toISOString().slice(0, 10);
const providerOf = (agentId) => String(agentId).split(':')[0];
const refuse = (reason, message) => ({ reason, message });

/**
 * h: {source:{agent_id, tier, provider}, to, scope, card_id, repoRoot, hop, visited, reservation}
 * self: {userId} of this Mac's person (null when signed out). Returns null to admit, else {reason, message}.
 */
export function admit(h, { log, settings, now, self = null }) {
  const t = now();
  if (log.state('halted', false)) return refuse('HALTED', 'The agent bus is stopped on this Mac. Your person can resume it from the tray or Preferences.');
  if (!settings.enabled) return refuse('HALTED', 'The agent bus is turned off in Preferences.');
  const crossUser = h.to?.user && h.to.user !== self?.userId;
  if (h.scope === 'team' || crossUser) {
    if (!settings.accept_tiers.includes(h.source.tier)) return refuse('TIER_NOT_ACCEPTED', 'Interactive sessions can hand off to this Mac only.');
    return refuse('NO_ELIGIBLE_AGENT', 'Team handoffs need the team hub, which this version does not connect to yet.');
  }
  if (h.to?.agent_id) {
    if (h.visited.includes(h.to.agent_id) || h.to.agent_id === h.source.agent_id) return refuse('LOOP', 'That agent is already in this handoff chain.');
    return refuse('NO_ELIGIBLE_AGENT', 'Handoffs start fresh runs; a live session cannot be addressed.');
  }
  if (!BUS_RUN_PROVIDERS.includes(h.to.provider)) return refuse('NO_ELIGIBLE_AGENT', `Bus runs start only on ${BUS_RUN_PROVIDERS.join(' or ')}.`);
  // A→B→A: handing straight back to the provider that handed this work over.
  if (h.visited.length >= 2 && providerOf(h.visited.at(-2)) === h.to.provider) return refuse('LOOP', 'Handing work straight back to the agent that handed it over is refused.');
  if (h.hop > settings.max_hops) return refuse('LOOP', `This would be hop ${h.hop}; the limit is ${settings.max_hops}.`);
  const r = settings.rates;
  if (log.countOffers({ since: t - HOUR_MS, agentId: h.source.agent_id }) >= r.agent_per_h) return refuse('RATE', 'This agent reached its hourly handoff limit.');
  if (log.countOffers({ since: t - HOUR_MS }) >= r.member_per_h) return refuse('RATE', 'This Mac reached its hourly handoff limit.');
  if (h.card_id && log.countOffers({ since: t - DAY_MS, cardId: h.card_id }) >= r.card_per_day) return refuse('RATE', 'This card reached its daily run limit.');
  if (log.countOffers({ since: t - DAY_MS, repoRoot: h.repoRoot }) >= r.repo_per_day) return refuse('RATE', 'This repository reached its daily run limit.');
  if (log.countFailures({ since: t - HOUR_MS, cardId: h.card_id, repoRoot: h.repoRoot }) >= r.failures_per_h) return refuse('RATE', 'Paused after repeated failures in the last hour.');
  if (settings.caps.enabled) {
    const s = log.spend(dayOf(t));
    if (h.reservation > settings.caps.handoff_usd || s.reserved + s.spent + h.reservation > settings.caps.member_usd) return refuse('SPEND_CAP', 'The daily agent bus spend cap is used up.');
  }
  return null;
}
