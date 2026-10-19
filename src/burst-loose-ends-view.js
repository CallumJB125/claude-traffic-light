'use strict';

// Loose ends per repository, from Burst's raw /api/loose-ends answer
// (claude-burst internal/looseends: report.repos[] = {root, branch, uncommitted[],
// unpushed[], ahead, stashes[]}; only repositories with something loose are listed).
// Pure: takes the scrubbed raw answer, or the client's normalized one
// (burst-client normalizeLooseEnds: {kind:'ok', repos:[{path, uncommitted:n, unpushed:n, stashes:n}]}),
// and gives counts keyed by repository root.
// Nothing here reads a file name, a diff or a stash's contents: counts and age only.

const HOUR_MS = 3_600_000;
const DEFAULT_STALE_HOURS = 24;
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const list = (v) => (Array.isArray(v) ? v : []);
const count = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);
const secs = (v) => (Number.isFinite(v) && v > 0 ? v * 1000 : null);

// A repository root as Burst reports it, or a session's cwd: no trailing slash, so prefix
// matching never pairs /a/b with /a/bc.
function normalizeRoot(p) {
  if (typeof p !== 'string' || !p) return '';
  const s = p.replace(/[\\/]+$/, '');
  return s || '/';
}

function repoCounts(repo, { at, staleMs }) {
  // Normalized shape: counts already; `oldest` (seconds) carries the one time the stale badge needs.
  if (Number.isSafeInteger(repo.uncommitted) || Number.isSafeInteger(repo.unpushed) || Number.isSafeInteger(repo.stashes)) {
    return { uncommitted: count(repo.uncommitted), unpushed: count(repo.unpushed), stashes: count(repo.stashes), branch: typeof repo.branch === 'string' ? repo.branch.slice(0, 120) : '', noRemote: repo.noRemote === true || repo.no_remote === true, stale: secs(repo.oldest) !== null && at !== null && at - secs(repo.oldest) >= staleMs };
  }
  const uncommitted = list(repo.uncommitted);
  const unpushed = list(repo.unpushed);
  const stashes = list(repo.stashes);
  const oldest = [...uncommitted.map((f) => secs(obj(f)?.mtime)), ...unpushed.map((c) => secs(obj(c)?.when)), ...stashes.map((s) => secs(obj(s)?.when))].filter((t) => t !== null);
  return {
    uncommitted: uncommitted.length,
    // `ahead` counts every unpushed commit; `unpushed` lists only the newest few.
    unpushed: Math.max(count(repo.ahead), unpushed.length),
    stashes: stashes.length,
    branch: typeof repo.branch === 'string' ? repo.branch.slice(0, 120) : '',
    noRemote: repo.no_remote === true,
    stale: oldest.length > 0 && at !== null && oldest.some((t) => at - t >= staleMs),
  };
}

/**
 * looseEndsView(raw, {now}) → { byRepo: Map<root, {uncommitted, unpushed, stashes, stale, branch, noRemote}>,
 *   totals: {repos, uncommitted, unpushed, stashes}, at: ms|null, scanned, staleHours }.
 * Returns null for anything that is not a report (so a caller can hide the whole section).
 */
function looseEndsView(raw, { now = Date.now } = {}) {
  const r = obj(raw);
  const normalized = r && r.kind === 'ok' && Array.isArray(r.repos);
  const report = normalized ? r : r && obj(r.report);
  if (!report) return null;
  const hours = normalized ? r.staleHours : r.stale_hours;
  const staleHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_STALE_HOURS;
  const at = secs(report.at) ?? (typeof now === 'function' ? now() : null);
  const byRepo = new Map();
  for (const repo of list(report.repos)) {
    const o = obj(repo);
    const root = o && normalizeRoot(normalized ? o.path : o.root);
    if (!root) continue;
    const c = repoCounts(o, { at, staleMs: staleHours * HOUR_MS });
    if (!c.uncommitted && !c.unpushed && !c.stashes) continue;
    byRepo.set(root, c);
  }
  const totals = { repos: byRepo.size, uncommitted: 0, unpushed: 0, stashes: 0 };
  for (const c of byRepo.values()) { totals.uncommitted += c.uncommitted; totals.unpushed += c.unpushed; totals.stashes += c.stashes; }
  return { byRepo, totals, at, scanned: count(report.scanned), staleHours };
}

/** "2 uncommitted · 1 unpushed · 1 stash": only the parts that are not zero; '' when nothing is loose. */
function badgeText(c) {
  if (!obj(c)) return '';
  const parts = [];
  if (count(c.uncommitted)) parts.push(`${c.uncommitted} uncommitted`);
  if (count(c.unpushed)) parts.push(`${c.unpushed} unpushed`);
  if (count(c.stashes)) parts.push(`${c.stashes} ${c.stashes === 1 ? 'stash' : 'stashes'}`);
  return parts.join(' · ');
}

/** The repository a working directory belongs to: the longest root that is the cwd or one of its parents. */
function forPath(view, cwd) {
  if (!view || !(view.byRepo instanceof Map)) return null;
  const p = normalizeRoot(cwd);
  if (!p) return null;
  let best = null;
  for (const [root, c] of view.byRepo) {
    if (p === root || p.startsWith(root === '/' ? '/' : `${root}/`)) { if (!best || root.length > best.root.length) best = { root, ...c }; }
  }
  return best;
}

/** The one Home line for everything loose: '' when nothing is. */
function summaryText(view) {
  if (!view || !view.totals.repos) return '';
  const t = view.totals;
  const parts = [t.uncommitted ? `${t.uncommitted} uncommitted ${t.uncommitted === 1 ? 'file' : 'files'}` : '', t.unpushed ? `${t.unpushed} unpushed ${t.unpushed === 1 ? 'commit' : 'commits'}` : '', t.stashes ? `${t.stashes} ${t.stashes === 1 ? 'stash' : 'stashes'}` : ''].filter(Boolean);
  return `${parts.join(', ')} in ${t.repos} ${t.repos === 1 ? 'repository' : 'repositories'}.`;
}

module.exports = { looseEndsView, badgeText, forPath, summaryText, normalizeRoot, DEFAULT_STALE_HOURS };
