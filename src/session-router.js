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

  // providers: [{ provider, label, available }] as interaction:capabilities lists them.
  // Returns null when nothing available can be suggested.
  function suggest(message, providers, { table = DEFAULT_TABLE } = {}) {
    const usable = (Array.isArray(providers) ? providers : []).filter((p) => p && typeof p.provider === 'string' && typeof p.label === 'string' && p.available === true);
    if (!usable.length) return null;
    const n = need(message);
    const ranked = usable.map((p) => { const tier = tierOf(p.provider, table); return { provider: p.provider, label: p.label, tier, rank: TIERS[tier].rank, capable: TIERS[tier].ability >= n.ability }; })
      .sort((a, b) => (b.capable - a.capable) || (a.capable ? a.rank - b.rank : b.rank - a.rank) || a.label.localeCompare(b.label));
    const best = ranked[0];
    const reason = best.capable
      ? `Looks like ${n.why}; ${best.label} is the cheapest available option that should handle it.`
      : `Looks like ${n.why}; nothing available is rated for it, so ${best.label} is the most capable option you have.`;
    return { provider: best.provider, label: best.label, tier: best.tier, cheaper: best.capable && ranked.some((r) => r.rank > best.rank), reason, ranked: ranked.map(({ provider, tier, capable }) => ({ provider, tier, capable })) };
  }

  const api = { suggest, need, tierOf, TIERS, DEFAULT_TABLE };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformRouter = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
