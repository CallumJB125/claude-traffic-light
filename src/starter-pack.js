'use strict';

// The "Start with a pack" card on Home: once an AI tool is connected, the
// repos the person worked in recently say what stack they use, and the
// gallery pack for that stack is offered once. Pure: main passes the recent
// folders, the verified gallery entries (src/gallery.js) and what is already
// installed; this file never reads the network. The gallery index itself is
// fetched only on the person's click, never from here.
//
// Stack markers are read with lstat and a bounded read, inside the folder
// only. The card goes away for good when it is dismissed or once anything
// from the gallery is installed, and the decision is kept in a small file.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STACKS = ['nextjs', 'python', 'swift', 'go', 'rust', 'node', 'rails'];
const LABEL = { nextjs: 'Next.js', python: 'Python', swift: 'Swift', go: 'Go', rust: 'Rust', node: 'Node', rails: 'Rails' };
const RECENT_MAX = 20;
const PACKAGE_MAX_BYTES = 256 * 1024;
const STORE_FILE = 'starter-pack.json';

const isFile = (p, fsApi) => { try { return fsApi.lstatSync(p).isFile(); } catch { return false; } };
const isDir = (p, fsApi) => { try { return fsApi.lstatSync(p).isDirectory(); } catch { return false; } };

// Whether package.json names Next.js: a bounded read, parsed, nothing else.
function hasNext(file, fsApi) {
  try {
    if (fsApi.statSync(file).size > PACKAGE_MAX_BYTES) return false;
    const pkg = JSON.parse(fsApi.readFileSync(file, 'utf8'));
    return !!(pkg?.dependencies?.next || pkg?.devDependencies?.next);
  } catch { return false; }
}

// → the stacks one folder is built with, most specific first (nextjs before node).
function stacksOf(dir, fsApi = fs) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || !isDir(dir, fsApi)) return [];
  const at = (name) => path.join(dir, name);
  const out = [];
  if (isFile(at('package.json'), fsApi)) { if (hasNext(at('package.json'), fsApi)) out.push('nextjs'); out.push('node'); }
  if (isFile(at('pyproject.toml'), fsApi) || isFile(at('requirements.txt'), fsApi)) out.push('python');
  let names = [];
  try { names = fsApi.readdirSync(dir); } catch { names = []; }
  if (isFile(at('Package.swift'), fsApi) || names.some((n) => n.endsWith('.xcodeproj'))) out.push('swift');
  if (isFile(at('go.mod'), fsApi)) out.push('go');
  if (isFile(at('Cargo.toml'), fsApi)) out.push('rust');
  if (isFile(at('Gemfile'), fsApi)) out.push('rails');
  return out;
}

// Distinct folders, most recent first, from usage turns ({cwd, ts}) and
// session rows ({cwd, updatedAt}). Remote sessions and relative paths are left out.
function recentFolders({ turns = [], sessions = [], max = RECENT_MAX } = {}) {
  const seen = new Map();
  const note = (cwd, at) => {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !Number.isFinite(at)) return;
    const key = cwd.replace(/[\\/]+$/, '');
    if (!key) return;
    if (!seen.has(key) || seen.get(key) < at) seen.set(key, at);
  };
  for (const t of Array.isArray(turns) ? turns : []) if (t) note(t.cwd, t.ts);
  for (const s of Array.isArray(sessions) ? sessions : []) if (s && !s.remote) note(s.cwd, Date.parse(s.updatedAt));
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([cwd, at]) => ({ cwd, at }));
}

// → [{cwd, folder, at, stacks}] for the folders that have a known stack.
function detect(folders, fsApi = fs) {
  const out = [];
  for (const f of Array.isArray(folders) ? folders : []) {
    const stacks = stacksOf(f.cwd, fsApi);
    if (stacks.length) out.push({ cwd: f.cwd, folder: path.basename(f.cwd), at: f.at, stacks });
  }
  return out;
}

// The pack whose stacks match the most recent stack seen. Among packs for
// the same stack the first by id wins, so the choice is stable between reads.
function matchPack(entries, detected) {
  const packs = (Array.isArray(entries) ? entries : []).filter((e) => e && e.kind === 'pack' && Array.isArray(e.stacks)).sort((a, b) => a.id.localeCompare(b.id));
  for (const repo of Array.isArray(detected) ? detected : []) {
    for (const stack of repo.stacks) {
      const pack = packs.find((p) => p.stacks.includes(stack));
      if (pack) return { pack, repo, stack };
    }
  }
  return null;
}

const firstRecipe = (pack, byId) => (pack.payload?.members || []).map((id) => byId.get(id)).find((m) => m && m.kind === 'recipe') || null;

// What the card shows, or null when there is nothing to suggest. Without the
// gallery list (not fetched yet) the card still names the stack and offers to
// look the pack up, which fetches on that click.
function suggestion({ detected = [], entries = null, dismissed = false, installed = false, connected = false } = {}) {
  if (dismissed || installed || !connected) return null;
  const repos = Array.isArray(detected) ? detected : [];
  if (!repos.length) return null;
  if (!Array.isArray(entries)) {
    const repo = repos[0], stack = repo.stacks[0];
    return { stage: 'look', stack, stackLabel: LABEL[stack] || stack, folder: repo.folder, pack: null, recipe: null };
  }
  const m = matchPack(entries, repos);
  if (!m) return null;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const members = (m.pack.payload?.members || []).map((id) => byId.get(id)).filter(Boolean);
  const recipe = firstRecipe(m.pack, byId);
  return {
    stage: 'add', stack: m.stack, stackLabel: LABEL[m.stack] || m.stack, folder: m.repo.folder,
    pack: { id: m.pack.id, sha256: m.pack.sha256, title: m.pack.title, summary: m.pack.summary, members: members.map((e) => ({ kind: e.kind, title: e.title })) },
    recipe: recipe ? { id: recipe.id, title: recipe.title } : null,
  };
}

// {dismissed, added} in one small file; a missing or odd file means neither.
function createStore({ dir, fsApi = fs, now = Date.now }) {
  const file = path.join(dir, STORE_FILE);
  const read = () => {
    try {
      const v = JSON.parse(fsApi.readFileSync(file, 'utf8'));
      return { dismissed: v?.dismissed === true, added: typeof v?.added === 'string' ? v.added : null };
    } catch { return { dismissed: false, added: null }; }
  };
  const write = (v) => {
    fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    fsApi.writeFileSync(tmp, JSON.stringify({ ...v, at: now() }), { mode: 0o600 });
    fsApi.renameSync(tmp, file);
  };
  return {
    get: read,
    dismiss() { write({ ...read(), dismissed: true }); },
    markAdded(packId) { write({ ...read(), added: String(packId).slice(0, 64) }); },
  };
}

module.exports = { stacksOf, recentFolders, detect, matchPack, suggestion, createStore, STACKS, LABEL, STORE_FILE };
