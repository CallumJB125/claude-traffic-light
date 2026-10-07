'use strict';

// Pure normalizers and view models for Burst's /api/usage and compaction
// stats. Burst's figures are API-equivalent prices from its own gateway log.
// They are never added to Plexiform's own Claude figure (spend.js reads the
// Claude transcripts, a different source); the Usage page labels which is which.

const SOURCE = 'Claude Burst gateway log, API-equivalent prices';
const PRIMARY_ROUTES = new Set(['anthropic', 'primary']);
const MAX_ROWS = 200;

const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const isSecondaryRoute = (route) => typeof route === 'string' && route !== '' && !PRIMARY_ROUTES.has(route.toLowerCase());

function group(g) {
  return { key: str(g && g.key), requests: num(g && g.requests), tokens: num(g && g.tokens), usd: num(g && g.usd), unpriced: !!(g && g.unpriced) };
}

function normalizeUsage(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const list = (a) => (Array.isArray(a) ? a.slice(0, 50).map(group) : []);
  const recent = (Array.isArray(r.recent) ? r.recent : []).slice(0, MAX_ROWS).map((e) => {
    const provider = str(e && (e.provider || e.route), 80);
    const slot = str(e && e.slot, 20);
    return {
      session: str(e && e.session_id, 80),
      repo: str(e && e.repo, 120),
      provider,
      secondary: slot ? slot === 'secondary' : isSecondaryRoute(provider),
      usd: num(e && e.api_equivalent_usd),
      at: str(e && e.time, 40),
    };
  });
  const t = r.totals && typeof r.totals === 'object' ? r.totals : {};
  return {
    range: str(r.range, 20),
    covered: r.covered !== false,
    totals: { requests: num(t.requests), usd: num(t.usd), unpriced: num(t.unpriced) },
    byProvider: list(r.by_provider).map((g) => ({ ...g, secondary: isSecondaryRoute(g.key) })),
    byRepo: list(r.by_repo),
    recent,
  };
}

// What the "Through Burst" section draws. Secondary-provider spend stands alone;
// Claude-plan traffic through Burst is shown as a request count only, because
// Plexiform already reads those turns from the Claude transcripts.
function throughBurstView(usage) {
  const u = usage || normalizeUsage(null);
  const secondary = u.byProvider.filter((g) => g.secondary);
  const plan = u.byProvider.filter((g) => !g.secondary);
  const repos = new Map();
  for (const row of u.recent) {
    if (!row.secondary || !row.repo) continue;
    repos.set(row.repo, (repos.get(row.repo) || 0) + row.usd);
  }
  return {
    source: SOURCE,
    range: u.range,
    secondaryUsd: secondary.reduce((n, g) => n + g.usd, 0),
    secondaryRequests: secondary.reduce((n, g) => n + g.requests, 0),
    unpriced: secondary.some((g) => g.unpriced),
    providers: secondary.map(({ key, requests, usd, unpriced }) => ({ key, requests, usd, unpriced })),
    planRequests: plan.reduce((n, g) => n + g.requests, 0),
    repos: [...repos].map(([key, usd]) => ({ key, usd })).sort((a, b) => b.usd - a.usd).slice(0, 10),
    reposNote: u.recent.length >= MAX_ROWS ? `Repositories are summed from the latest ${MAX_ROWS} requests.` : '',
    note: 'Secondary-provider spend only. It is not part of the Claude figures on this page, and is never added to them.',
    empty: !secondary.length,
  };
}

// Overflow USD for one session, from a /api/usage?session= answer (by_provider
// covers every request of the filter, so this is not limited to the recent page).
function secondaryUsdOf(usage) {
  return usage ? usage.byProvider.filter((g) => g.secondary).reduce((n, g) => n + g.usd, 0) : 0;
}

// Per-session overflow USD from the recent rows, for the board's budget check.
function secondaryBySession(usage) {
  const out = {};
  for (const r of usage ? usage.recent : []) if (r.secondary && r.session) out[r.session] = (out[r.session] || 0) + r.usd;
  return out;
}

const tokensLabel = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// What the Pauseless compaction section draws: the setting plus Burst's own savings figures.
function pauselessView(cfg, stats) {
  const st = stats && typeof stats === 'object' ? stats : {};
  const mode = cfg.mode === 'intelligent' ? 'intelligent' : 'fixed';
  const at = mode === 'intelligent' ? num(cfg.floor_tokens) : num(cfg.compact_at_tokens);
  const name = mode === 'intelligent' ? 'Smart' : 'Static';
  return {
    available: true,
    enabled: cfg.enabled === true,
    mode,
    thresholdLabel: at ? `${name}, from ${tokensLabel(at)} tokens` : name,
    savedUsd: num(st.saved_usd),
    compactions: num(st.compactions),
    tokensNotResent: num(st.tokens_not_resent),
  };
}

function normalizeCompaction(state) {
  const c = state && state.context && typeof state.context === 'object' ? state.context : {};
  const sessions = c.compaction_stats && Array.isArray(c.compaction_stats.sessions) ? c.compaction_stats.sessions : [];
  const cfg = c.compaction && typeof c.compaction === 'object' && !Array.isArray(c.compaction) ? c.compaction : null;
  return {
    active: !!(c.compaction && c.compaction.enabled === true),
    ...(cfg ? { pauseless: pauselessView(cfg, c.compaction_stats) } : {}),
    sessions: sessions.slice(0, 100).map((s) => ({
      session: str(s && s.session, 80), compactions: num(s && s.compactions), requests: num(s && s.requests),
      savedTokens: num(s && s.saved_tokens), savedUsd: num(s && s.saved_usd), netUsd: Number.isFinite(s && s.net_usd) ? s.net_usd : 0,
    })),
  };
}

const COMPACTION_NOTE = 'Burst is compacting Claude sessions';

// Plexiform's own Claude compactor is forced off while Burst compaction is on.
function withBurstCompaction(settings, burstActive) {
  if (!burstActive || !settings || typeof settings !== 'object') return settings;
  return { ...settings, providers: { ...(settings.providers || {}), claude: false } };
}

module.exports = { tokensLabel, normalizeUsage, throughBurstView, secondaryUsdOf, secondaryBySession, normalizeCompaction, withBurstCompaction, isSecondaryRoute, SOURCE, COMPACTION_NOTE, MAX_ROWS };
