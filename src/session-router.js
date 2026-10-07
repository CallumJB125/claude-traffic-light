'use strict';
// Advisory "cheapest capable" provider suggestion. Pure and offline: no model
// call decides, only length and keyword heuristics. It never starts or routes
// anything; the Overview shows it as a hint the user may click.
// Loaded by Node (tests) and as a plain script by the Overview page.
(function (root) {
  // Default cost tiers (user-editable later). Rank: lower = cheaper.
  const TIERS = Object.freeze({
    free: { rank: 0, label: 'free', ability: 1 },
    cheap: { rank: 1, label: 'cheap', ability: 2 },
    standard: { rank: 2, label: 'standard', ability: 3 },
    premium: { rank: 3, label: 'premium', ability: 3 },
  });
  const DEFAULT_TABLE = Object.freeze({ codex: 'standard', claude: 'cheap', gemini: 'cheap' });
  const HEAVY = /\b(refactor|implement|architect\w*|debug\w*|migrat\w*|multi-?file|codebase|repo(sitory)?|stack ?trace|failing tests?|write (the )?tests?|security|review (this|the|my) (code|pr|diff))\b/i;
  const MEDIUM = /```|\b(code|function|script|regex|sql|bug|error|explain|summari[sz]e|translate|json|class|compile)\b/i;

  const TIER_ORDER = ['free', 'cheap', 'standard', 'premium'];
  // Claude is under pressure when Burst reports it on and either failed over to
  // the paid secondary route or seeing refused windows ("Limit near").
  const burstPressure = (v) => !!v && v.kind === 'on' && (v.route === 'SECONDARY' || (!!v.chip && v.chip.label === 'Limit near'));
  const tierOf = (provider, table) => {
    const t = Object.hasOwn(table, provider) ? table[provider] : /^local-/.test(provider) ? 'free' : 'standard';
    return Object.hasOwn(TIERS, t) ? t : 'standard';
  };
  function need(message) {
    const text = typeof message === 'string' ? message.trim() : '';
    if (text.length > 1500 || HEAVY.test(text)) return { ability: 3, why: 'a larger coding task' };
    if (text.length > 400 || MEDIUM.test(text)) return { ability: 2, why: 'a code or reasoning question' };
    return { ability: 1, why: 'a short question' };
  }

  // Continuing someone's session: a WorkRecord v1 (TEAM-CONTEXT-CONTRACT.md)
  // plus the handover its author chose to share become the new session's first
  // prompt. Both arrive already scrubbed by the hub; this only bounds them.
  const SEED_MAX = 8000, HANDOVER_MAX = 5000;
  const line = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const isSeed = (m) => !!m && typeof m === 'object' && !!m.record && typeof m.record === 'object' && m.record.v === 1 && typeof m.record.record_id === 'string';
  function seed(record, handover) {
    if (!record || typeof record !== 'object') return '';
    const r = record, edited = Array.isArray(r.files?.edited) ? r.files.edited.filter((f) => typeof f === 'string').slice(0, 50) : [];
    const parts = [`Continue this work from an earlier ${line(r.adapter, 20) || 'AI'} session${r.folder ? ` in ${line(r.folder, 120)}` : ''}.`];
    if (line(r.title, 120)) parts.push(`Task: ${line(r.title, 120)}`);
    if (line(r.goal, 400)) parts.push(`Goal: ${line(r.goal, 400)}`);
    if (line(r.status, 20)) parts.push(`It was ${r.status === 'paused_limit' ? 'paused at a plan limit' : `last ${line(r.status, 20)}`}${r.branch ? ` on branch ${line(r.branch, 200)}` : ''}.`);
    if (line(r.summary, 1500)) parts.push(`Summary so far: ${line(r.summary, 1500)}`);
    if (edited.length) parts.push(`Files it edited: ${edited.join(', ')}`);
    const h = typeof handover === 'string' ? handover.trim() : '';
    if (h) parts.push(`Handover from that session:\n${h.length > HANDOVER_MAX ? `${h.slice(0, HANDOVER_MAX)}…` : h}`);
    parts.push('Check the current state of the files before changing anything.');
    const out = parts.join('\n\n');
    return out.length > SEED_MAX ? out.slice(0, SEED_MAX) : out;
  }

  // providers: [{ provider, label, available }] as interaction:capabilities lists them.
  // message: the user's text, or { record, handover } to continue a WorkRecord
  // with another AI (the record's own adapter only when nothing else is usable).
  // Returns null when nothing available can be suggested.
  function suggest(message, providers, { table = DEFAULT_TABLE, burst = null } = {}) {
    let usable = (Array.isArray(providers) ? providers : []).filter((p) => p && typeof p.provider === 'string' && typeof p.label === 'string' && p.available === true);
    const seeded = isSeed(message) ? seed(message.record, message.handover) : null;
    if (seeded !== null) { const others = usable.filter((p) => p.provider !== message.record.adapter); if (others.length) usable = others; }
    if (!usable.length) return null;
    const n = need(seeded ?? message);
    const pressed = burstPressure(burst);
    const ranked = usable.map((p) => { let tier = tierOf(p.provider, table); if (pressed && p.provider === 'claude') tier = TIER_ORDER[Math.min(TIER_ORDER.indexOf(tier) + 1, TIER_ORDER.length - 1)]; return { provider: p.provider, label: p.label, tier, rank: TIERS[tier].rank, capable: TIERS[tier].ability >= n.ability }; })
      .sort((a, b) => (b.capable - a.capable) || (a.capable ? a.rank - b.rank : b.rank - a.rank) || a.label.localeCompare(b.label));
    const best = ranked[0];
    let reason = best.capable
      ? `Looks like ${n.why}; ${best.label} is the cheapest available option that should handle it.`
      : `Looks like ${n.why}; nothing available is rated for it, so ${best.label} is the most capable option you have.`;
    if (pressed && best.provider !== 'claude' && usable.some((p) => p.provider === 'claude')) reason += ' Claude is close to its limit.';
    return { provider: best.provider, label: best.label, tier: best.tier, cheaper: best.capable && ranked.some((r) => r.rank > best.rank), reason, ranked: ranked.map(({ provider, tier, capable }) => ({ provider, tier, capable })), ...(seeded !== null ? { seed: seeded, from: message.record.record_id } : {}) };
  }

  const api = { suggest, seed, need, tierOf, burstPressure, TIERS, DEFAULT_TABLE };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformRouter = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
