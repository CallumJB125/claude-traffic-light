'use strict';
// Policy packs, app side (hooks/policy-gate.js is the hook side):
//   - Settings → Privacy and data → Policies: view the built-in packs, see
//     which policy a repo is under, and write a pack to a repo's
//     .plexiform/policy.json or to the default policy, only after the person
//     has seen the exact file content and confirmed it
//   - the per-repo daily spend cap: today's spend per repo is worked out here
//     and written to policy-spend.json, which the hook reads (fail-open: a
//     missing or stale file allows everything)
//   - Sessions: which policy a session is under, and its latest refusal
// Everything stays on this Mac.
const fs = require('fs');
const path = require('path');
const Gate = require('../hooks/policy-gate.js');
const Packs = require('../hooks/policy-packs.js');
const Spend = require('../spend.js');

const TICK_MS = 60 * 1000;
const SPEND_TTL_MS = 3 * 60 * 1000;
const BLOCK_SHOWN_MS = 30 * 60 * 1000;
const BLOCK_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REPOS = 20;

const fileText = (policy) => `${JSON.stringify(policy, null, 2)}\n`;

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o644 });
    fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

function packList() {
  return Object.entries(Packs.PACKS).map(([id, p]) => ({ id, name: p.name, description: p.description, content: fileText(Packs.packPolicy(id)) }));
}

const describe = (loaded) => ({
  name: loaded.policy ? loaded.policy.name : null,
  budget: loaded.policy ? budgetSummary(loaded.policy) : null,
  source: loaded.source,
  file: loaded.file,
  warnings: loaded.warnings.slice(0, 5),
});

function budgetSummary(p) {
  const parts = [];
  if (p.dailySpendCapUsd) parts.push(`${usd(p.dailySpendCapUsd)} a day`);
  if (p.weeklySpendCapUsd) parts.push(`${usd(p.weeklySpendCapUsd)} a week`);
  if (p.holdTasksAtLimit) parts.push('no new background tasks once a limit is hit');
  return parts.length ? parts.join(', ') : null;
}

/** Repos seen in this Mac's session files, each with the policy it is under. */
function knownRepos(rootDir) {
  const roots = new Map();
  let names = [];
  try { names = fs.readdirSync(path.join(rootDir, 'sessions')).filter((n) => n.endsWith('.json')); } catch { names = []; }
  for (const n of names.slice(0, 500)) {
    let cwd = null;
    try { cwd = JSON.parse(fs.readFileSync(path.join(rootDir, 'sessions', n), 'utf8')).cwd; } catch { cwd = null; }
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue;
    const { root } = Gate.findRepo(cwd);
    if (!roots.has(root)) roots.set(root, root);
    if (roots.size >= MAX_REPOS) break;
  }
  return [...roots.keys()].sort().map((root) => repoView(rootDir, root));
}

function repoView(rootDir, root) {
  return { root, label: path.basename(root) || root, ...describe(Gate.loadFor({ rootDir, cwd: root })) };
}

function state(rootDir) {
  const def = Gate.readPolicyFile(path.join(rootDir, Gate.DEFAULT_FILE));
  return {
    packs: packList(),
    default: { path: path.join(rootDir, Gate.DEFAULT_FILE), name: def.policy ? def.policy.name : null, budget: def.policy ? budgetSummary(def.policy) : null, warnings: def.missing ? [] : def.warnings },
    repos: knownRepos(rootDir),
  };
}

/** Where a pack would be written. 'default' or an existing absolute folder; else null. */
function targetFile(rootDir, target) {
  if (target === 'default') return path.join(rootDir, Gate.DEFAULT_FILE);
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.resolve(target) === path.parse(target).root) return null;
  try { if (!fs.statSync(target).isDirectory()) return null; } catch { return null; }
  return path.join(path.resolve(target), Gate.REPO_FILE);
}

/** What applying `pack` to `target` would write, and what it would replace. */
function preview(rootDir, { target, pack } = {}) {
  const policy = Packs.packPolicy(pack);
  if (!policy) return { error: 'Choose one of the packs.' };
  const file = targetFile(rootDir, target);
  if (!file) return { error: 'Choose a folder that exists on this Mac.' };
  let current = null;
  try { current = fs.readFileSync(file, 'utf8').slice(0, 64 * 1024); } catch { current = null; }
  return { path: file, content: fileText(policy), current };
}

/** Writes the file, but only the exact content the person was shown and confirmed. */
function apply(rootDir, { target, pack, content } = {}) {
  const p = preview(rootDir, { target, pack });
  if (p.error) return p;
  if (typeof content !== 'string' || content !== p.content) return { error: 'The policy changed since you reviewed it. Review it again, then confirm.' };
  fs.mkdirSync(path.dirname(p.path), { recursive: true });
  writeAtomic(p.path, p.content);
  return { ok: true, path: p.path };
}

// ── The per-repo daily spend cap ─────────────────────────────────────────────

const startOfDay = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const usd = (n) => `$${n.toFixed(2)}`;

/** → Map(repo root → USD spent since `from`), by the nearest repo of each turn's folder. */
function spendByRepo({ turns, from, now, costOf }) {
  const rootOf = new Map();
  const spent = new Map();
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || t.ts < from || t.ts > now || typeof t.cwd !== 'string' || !t.cwd) continue;
    const c = costOf(t);
    if (!Number.isFinite(c)) continue;
    if (!rootOf.has(t.cwd)) rootOf.set(t.cwd, Gate.findRepo(t.cwd).root);
    const root = rootOf.get(t.cwd);
    spent.set(root, (spent.get(root) || 0) + c);
  }
  return spent;
}

/** → {root: reason} for every repo whose policy cap today's spend has reached. */
function overCaps({ rootDir, turns, now = Date.now(), costOf }) {
  const repos = {};
  for (const [root, cost] of spendByRepo({ turns, from: startOfDay(now), now, costOf })) {
    const loaded = Gate.loadFor({ rootDir, cwd: root });
    const cap = loaded.policy?.dailySpendCapUsd;
    if (cap && cost >= cap) repos[root] = `this repo's daily spend cap of ${usd(cap)} is reached (${usd(cost)} today)`;
  }
  return repos;
}

/**
 * Whether a new background task (Tasks, a recipe, a scheduled run) in `cwd` should be held:
 * the repo's policy says holdTasksAtLimit and a repo cap, or the overall daily/weekly
 * budget (`budget` = {level, which, text}), has been reached. Running sessions are never touched.
 * → null, or {text, reasons[]}
 */
function startHold({ rootDir, cwd, turns, now = Date.now(), costOf, budget = null }) {
  const loaded = Gate.loadFor({ rootDir, cwd });
  const p = loaded.policy;
  if (!p || p.holdTasksAtLimit !== true) return null;
  const reasons = [];
  if (p.dailySpendCapUsd || p.weeklySpendCapUsd) {
    const spentIn = (from) => spendByRepo({ turns, from, now, costOf }).get(loaded.root) || 0;
    const day = p.dailySpendCapUsd ? spentIn(startOfDay(now)) : 0;
    const week = p.weeklySpendCapUsd ? spentIn(Spend.startOfWeek(now)) : 0;
    if (p.dailySpendCapUsd && day >= p.dailySpendCapUsd) reasons.push(`this repo's daily cap of ${usd(p.dailySpendCapUsd)} is reached (${usd(day)} today)`);
    if (p.weeklySpendCapUsd && week >= p.weeklySpendCapUsd) reasons.push(`this repo's weekly cap of ${usd(p.weeklySpendCapUsd)} is reached (${usd(week)} this week)`);
  }
  if (budget && budget.level === 'exceeded') reasons.push(`your ${budget.which === 'week' ? 'weekly' : 'daily'} spend limit is reached${budget.text ? ` (${budget.text})` : ''}`);
  if (!reasons.length) return null;
  return { text: `New background tasks are on hold: ${reasons.join(' and ')}. Tasks already running are not affected.`, reasons };
}

function writeSpendGate(rootDir, repos, now = Date.now()) {
  const file = path.join(rootDir, Gate.SPEND_FILE);
  if (!Object.keys(repos).length) { fs.rmSync(file, { force: true }); return; }
  writeAtomic(file, JSON.stringify({ v: 1, at: now, ttlMs: SPEND_TTL_MS, repos }));
}

function pruneBlocks(rootDir, now = Date.now()) {
  const dir = path.join(rootDir, Gate.BLOCKS_DIR);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const f = path.join(dir, n);
    try { if (now - fs.statSync(f).mtimeMs > BLOCK_KEEP_MS) fs.rmSync(f, { force: true }); } catch { /* gone already */ }
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────

/** The policy a session row is under and its latest refusal, or null. */
function rowInfo(row, rootDir, { now = Date.now() } = {}) {
  if (!row || typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)) return null;
  const loaded = Gate.loadFor({ rootDir, cwd: row.cwd });
  let blocked = null;
  const id = Gate.safeId(row.sessionId);
  if (id) {
    try {
      const b = JSON.parse(fs.readFileSync(path.join(rootDir, Gate.BLOCKS_DIR, `${id}.json`), 'utf8'));
      if (b && Number.isFinite(b.at) && now - b.at < BLOCK_SHOWN_MS && typeof b.rule === 'string') {
        blocked = { text: `Blocked by policy: ${b.rule}`, tool: typeof b.tool === 'string' ? b.tool : null, at: b.at };
      }
    } catch { blocked = null; }
  }
  if (!loaded.policy && !loaded.warnings.length && !blocked) return null;
  return { name: loaded.policy ? loaded.policy.name : null, source: loaded.source, warning: loaded.warnings[0] || null, blocked };
}

// ── Wiring (src/paid-wiring.js calls register once) ─────────────────────────

function register(ctx) {
  const { rootDir, ipcMain, fromPage, log = () => {} } = ctx;
  const usage = require('../usage.js');
  const tick = async () => {
    try {
      const turns = typeof ctx.usageTurns === 'function' ? await ctx.usageTurns() : [];
      writeSpendGate(rootDir, overCaps({ rootDir, turns, costOf: usage.costOf }));
      pruneBlocks(rootDir);
    } catch (e) {
      try { writeSpendGate(rootDir, {}); } catch { /* lapses by TTL */ }
      log(`[policy] ${e?.message ?? e}`);
    }
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  setTimeout(tick, 5000).unref?.();
  ctx.onQuit?.(() => { clearInterval(timer); try { writeSpendGate(rootDir, {}); } catch { /* lapses by TTL */ } });

  const settings = (e) => { try { return !!fromPage(e, 'settings'); } catch { return false; } };
  const handle = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!settings(e)) return null;
    try { return await fn(e, ...args); } catch (err) { log(`[policy] ${channel}: ${err?.message ?? err}`); return { error: err?.message ?? String(err) }; }
  });
  ctx.setTaskStartGuard?.(async (cwd) => {
    const turns = typeof ctx.usageTurns === 'function' ? await ctx.usageTurns() : [];
    const snap = typeof ctx.spend === 'function' ? ctx.spend() : null;
    return startHold({ rootDir, cwd, turns, costOf: usage.costOf, budget: snap?.budget ? { level: snap.budget.level, which: snap.budget.which, text: snap.budgetText } : null });
  });
  handle('policy:state', () => state(rootDir));
  handle('policy:preview', (_e, req) => preview(rootDir, req || {}));
  handle('policy:apply', async (_e, req) => { const r = apply(rootDir, req || {}); if (r.ok) await tick(); return r; });
  handle('policy:pick-folder', async (e) => {
    const { dialog, BrowserWindow } = require('electron');
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || undefined, { title: 'Choose the repo', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return repoView(rootDir, Gate.findRepo(r.filePaths[0]).root);
  });
  return { tick };
}

module.exports = { register, state, preview, apply, rowInfo, overCaps, startHold, writeSpendGate, knownRepos, targetFile, pruneBlocks, packList };
