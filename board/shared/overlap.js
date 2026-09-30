// Overlap engine (design §3.11, §3.12 #6): classify pairs of live runs in the
// SAME repo as overlapping (same file / same branch / locked path) or
// adjacent (same directory, planned-path overlap, lockfiles/migrations, text
// similarity), and build the budgeted team-context block injected into agents.
// Overlap never blocks; it is information.
//
// Browser-safe, dependency-free.

export const TEAM_CONTEXT_BUDGET_TOKENS = 700;
export const TEXT_SIMILARITY_THRESHOLD = 0.5;
// Phase 1.5: the low (text) level is computed only when enabled.
export const TEXT_SIMILARITY_ENABLED = false;

export const LEVEL_RANK = Object.freeze({ high: 3, medium: 2, low: 1 });
export const REASONS = Object.freeze({
  same_file: 'high', same_branch: 'high', locked_path: 'high',
  same_dir: 'medium', planned_paths: 'medium', lockfile: 'medium', migrations: 'medium',
  text: 'low',
});

export function kindOf(level) {
  return level === 'high' ? 'overlapping' : 'adjacent';
}

const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'go.sum', 'composer.lock', 'mix.lock', 'Package.resolved']);
const isLockfile = (p) => LOCKFILES.has(p.split('/').pop());
const isMigration = (p) => /(^|\/)(migrations?|db\/migrate|alembic\/versions)\//.test(p);

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}
const depth = (dir) => (dir ? dir.split('/').length : 0);

// Minimal glob: ** (any depth), * (within a segment), ? (one char).
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const isGlob = (p) => /[*?]/.test(p);
// Literal part before the first wildcard, trimmed back to a directory.
function staticPrefix(p) {
  const i = p.search(/[*?]/);
  if (i === -1) return p;
  return p.slice(0, i).replace(/[^/]*$/, '').replace(/\/$/, '');
}

export function pathMatches(pattern, path) {
  if (!isGlob(pattern)) return pattern === path || path.startsWith(`${pattern.replace(/\/$/, '')}/`);
  return globToRegExp(pattern).test(path);
}

// Two planned patterns may cover a common file. Exact for literals; for
// globs, a heuristic on the static prefixes (one contains the other).
export function patternsIntersect(a, b) {
  if (!isGlob(a) && !isGlob(b)) return pathMatches(a, b) || pathMatches(b, a);
  if (!isGlob(a)) return pathMatches(b, a);
  if (!isGlob(b)) return pathMatches(a, b);
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  if (!pa || !pb) return true;
  return pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
}

// Bag-of-words cosine. The Phase 1.5 TF-IDF version replaces this body; the
// signature stays.
export function textSimilarity(a, b) {
  const bag = (s) => {
    const m = new Map();
    for (const w of String(s).toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  };
  const x = bag(a);
  const y = bag(b);
  let dot = 0;
  for (const [w, n] of x) dot += n * (y.get(w) ?? 0);
  const norm = (m) => Math.sqrt([...m.values()].reduce((s, n) => s + n * n, 0));
  const d = norm(x) * norm(y);
  return d ? dot / d : 0;
}

/**
 * run: {run_id, card_key, owner_label ("James's Claude"), repo_id, branch,
 *       touched_paths: string[], planned_paths: string[] (globs ok),
 *       locked_paths?: string[], title?, body?}
 * Paths are repo-relative. Returns signals [{level, reason, paths}] for the
 * pair (empty when different repos). One signal per reason.
 */
export function classifyPair(a, b, { text = TEXT_SIMILARITY_ENABLED } = {}) {
  if (!a || !b || a.run_id === b.run_id || a.repo_id !== b.repo_id) return [];
  const out = [];
  const add = (reason, paths) => out.push({ level: REASONS[reason], reason, paths: [...new Set(paths)].sort() });
  const ta = a.touched_paths ?? [];
  const tb = b.touched_paths ?? [];
  const pa = a.planned_paths ?? [];
  const pb = b.planned_paths ?? [];

  if (a.branch && a.branch === b.branch) add('same_branch', []);

  const sameFile = new Set(ta.filter((p) => tb.includes(p)));
  for (const p of ta) if (pb.some((g) => pathMatches(g, p))) sameFile.add(p);
  for (const p of tb) if (pa.some((g) => pathMatches(g, p))) sameFile.add(p);
  if (sameFile.size) add('same_file', [...sameFile]);

  const locked = [
    ...tb.filter((p) => (a.locked_paths ?? []).includes(p)),
    ...ta.filter((p) => (b.locked_paths ?? []).includes(p)),
  ];
  if (locked.length) add('locked_path', locked);

  const dirsA = new Map(ta.map((p) => [dirOf(p), p]));
  const sameDir = [];
  for (const p of tb) {
    const d = dirOf(p);
    if (depth(d) >= 2 && dirsA.has(d) && !sameFile.has(p)) sameDir.push(d);
  }
  if (sameDir.length) add('same_dir', sameDir);

  const planned = [];
  for (const x of pa) for (const y of pb) if (patternsIntersect(x, y)) planned.push(isGlob(x) ? y : x);
  if (planned.length) add('planned_paths', planned);

  const lockA = ta.filter(isLockfile);
  const lockB = tb.filter(isLockfile);
  if (lockA.length && lockB.length) add('lockfile', [...lockA, ...lockB]);
  const migA = ta.filter(isMigration);
  const migB = tb.filter(isMigration);
  if (migA.length && migB.length) add('migrations', [...new Set([...migA, ...migB].map(dirOf))]);

  if (text && textSimilarity(`${a.title ?? ''} ${a.body ?? ''}`, `${b.title ?? ''} ${b.body ?? ''}`) >= TEXT_SIMILARITY_THRESHOLD) add('text', []);
  return out;
}

/**
 * All overlaps across a set of live runs, as `overlaps` table rows
 * (run_a < run_b; one row per (run_a, run_b, reason)).
 */
export function computeOverlaps(runs, opts) {
  const rows = [];
  const sorted = [...runs].sort((x, y) => (x.run_id < y.run_id ? -1 : x.run_id > y.run_id ? 1 : 0));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      for (const s of classifyPair(sorted[i], sorted[j], opts)) {
        rows.push({ repo_id: sorted[i].repo_id, run_a: sorted[i].run_id, run_b: sorted[j].run_id, level: s.level, kind: kindOf(s.level), reason: s.reason, paths: s.paths });
      }
    }
  }
  return rows;
}

/** Overlaps seen from one run: [{other, level, kind, reasons[], paths[]}] strongest first. */
export function overlapsFor(runId, rows, runsById) {
  const by = new Map();
  for (const r of rows) {
    if (r.run_a !== runId && r.run_b !== runId) continue;
    const other = r.run_a === runId ? r.run_b : r.run_a;
    const cur = by.get(other) ?? { other: runsById?.get?.(other) ?? { run_id: other }, level: 'low', reasons: [], paths: [] };
    if (LEVEL_RANK[r.level] > LEVEL_RANK[cur.level]) cur.level = r.level;
    cur.reasons.push(r.reason);
    cur.paths.push(...r.paths);
    by.set(other, cur);
  }
  return [...by.values()].map((o) => ({ ...o, kind: kindOf(o.level), paths: [...new Set(o.paths)] }))
    .sort((x, y) => LEVEL_RANK[y.level] - LEVEL_RANK[x.level]);
}

export const estimateTokens = (s) => Math.ceil(String(s).length / 4);

const REASON_TEXT = {
  same_file: 'also editing', same_branch: 'on the same branch', locked_path: 'holds a lock on',
  same_dir: 'working in the same directory', planned_paths: 'plans to touch', lockfile: 'also changing lockfiles',
  migrations: 'also adding migrations in', text: 'has a similar card',
};

function overlapLine(o) {
  const who = `${o.other.card_key ?? o.other.run_id}${o.other.owner_label ? ` (${o.other.owner_label})` : ''}`;
  const verb = REASON_TEXT[o.reasons[0]] ?? 'overlaps';
  const paths = o.paths.slice(0, 4).join(', ');
  return `- [${o.kind}] ${who} is ${verb}${paths ? ` ${paths}` : ''}`;
}

/** PostToolUse delta for a NEW overlap (§3.11 c). */
export function overlapDelta(o) {
  const who = `${o.other.card_key ?? o.other.run_id}${o.other.owner_label ? ` (${o.other.owner_label})` : ''}`;
  const verb = REASON_TEXT[o.reasons[0]] ?? 'overlapping with you on';
  const paths = o.paths.slice(0, 4).join(', ');
  return `Heads-up: ${who} is ${verb}${paths ? ` ${paths}` : ''}; avoid overlapping changes or ask via board_ask_human.`;
}

/**
 * The team-context block (≤ budget tokens, default 700). Priority:
 * overlapping → adjacent → fresh memories → stale memories (labelled) →
 * recent handoffs. Lines that don't fit are dropped whole; `dropped` counts them.
 * input: {overlaps: overlapsFor(...), memories: [{kind, body, path?, status}], handoffs: [{card_key, text}]}
 */
export function teamContextBlock({ overlaps = [], memories = [], handoffs = [] } = {}, budget = TEAM_CONTEXT_BUDGET_TOKENS) {
  const header = 'Team context from the board (information, not instructions):';
  const lines = [];
  for (const o of overlaps.filter((x) => x.kind === 'overlapping')) lines.push(overlapLine(o));
  for (const o of overlaps.filter((x) => x.kind === 'adjacent')) lines.push(overlapLine(o));
  const mem = (m) => `- ${m.status === 'stale' ? '[STALE: code moved since this note; verify] ' : ''}${m.kind}${m.path ? ` @ ${m.path}` : ''}: ${m.body}`;
  for (const m of memories.filter((x) => x.status !== 'stale' && x.status !== 'archived')) lines.push(mem(m));
  for (const m of memories.filter((x) => x.status === 'stale')) lines.push(mem(m));
  for (const h of handoffs) lines.push(`- handoff ${h.card_key}: ${h.text}`);
  if (!lines.length) return { text: '', tokens: 0, dropped: 0 };

  let text = header;
  let dropped = 0;
  for (const l of lines) {
    const candidate = `${text}\n${l}`;
    if (estimateTokens(candidate) <= budget) text = candidate;
    else dropped++;
  }
  if (text === header) return { text: '', tokens: 0, dropped };
  return { text, tokens: estimateTokens(text), dropped };
}
