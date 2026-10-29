'use strict';
// The new chat's own content (redesign R7-1, plan-r7 §1–2): what replaces Home with the chat preview on.
// Registered by main.js only under CHAT_PREVIEW, beside src/newchat-main.js; with the gate off nothing here exists.
//   newchat:home      read. A summary line (Needs you, Check it), up to 3 Needs-you rows, and whether this is the
//                     first run (no rows at all). Rows are the sidebar's own path-free projection, cut down further.
//   newchat:starters  read. Up to 3 starters for the folder chip's folder, named by its handle (review S1); main
//                     resolves the handle, so an unknown one reads nothing. A starter only fills the box.
//   newchat:open-row  effect. Opens one Needs-you row's thread: an id this document generation was given, still a
//                     Needs-you row in a fresh read, with the window focused (review S4). Never a fallback page.
// Every channel answers the new-chat document only (its webContents and main frame), re-checked after each await.

const CHANNELS = Object.freeze({ home: 'newchat:home', starters: 'newchat:starters', openRow: 'newchat:open-row' });
const ROW_KEYS = Object.freeze(['id', 'title', 'project']);
const MAX_ROWS = 3;
const READ_MS = 5000; // the sidebar's cadence (src/overview-main.js SIDEBAR_MIN_MS)
const OPEN_GAP_MS = 500;
const STARTER_MS = 60000; // review S2/Q2: one git read per folder a minute
const GIT_TIMEOUT_MS = 1000;
const GIT_MAX_BUFFER = 4 << 20;
const NAME_MAX = 80;
const ID = /^[0-9a-f]{64}$/;

// Starters (plan-redesign §5). The label is the button; the text is what fills the box.
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|php|cs|c|cc|cpp|h|hpp|m|scala|ex|exs)$/i;
const SKIP_DIR = /(?:^|\/)(?:node_modules|vendor|dist|build|out|target|coverage|\.[^/]+)\//;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec|specs|test-[^/]*)\/|[._-](?:test|spec)s?\.[^/]+$|(?:^|\/)test_[^/]+$/i;
const GENERATED = /\.min\.[^/]+$|\.d\.ts$|\.generated\.|\.pb\.|_pb2\.py$/i;

/** Drop control and bidirectional-override characters, collapse spaces, cap at NAME_MAX (review nit). */
function cleanName(s) {
  // eslint-disable-next-line no-control-regex
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > NAME_MAX ? `…${t.slice(t.length - NAME_MAX + 1)}` : t;
}

// What a test file covers: its name with the test marker and extension removed ("foo.test.js" → "foo").
const stem = (p) => p.split('/').pop().replace(/\.[^.]+$/, '').replace(/^test_/i, '').replace(/[._-](?:test|spec)s?$/i, '').toLowerCase();

/** `git ls-tree -r -l HEAD` output → the largest tracked source file no test file names, or null. */
function largestUntested(out) {
  const files = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(line);
    if (m) files.push({ size: Number(m[1]), path: m[2] });
  }
  const tested = new Set(files.filter((f) => TEST_FILE.test(f.path)).map((f) => stem(f.path)));
  let best = null;
  for (const f of files) {
    if (!SOURCE.test(f.path) || TEST_FILE.test(f.path) || SKIP_DIR.test(f.path) || GENERATED.test(f.path)) continue;
    if (tested.has(stem(f.path))) continue;
    if (!best || f.size > best.size || (f.size === best.size && f.path < best.path)) best = f;
  }
  return best ? best.path : null;
}

/** The starters for one folder, from its tracked files and whether its CI is red. Pure. */
function startersFor({ tree = null, ciFailed = false } = {}) {
  const out = [{ id: 'explain', label: 'Explain this repo', text: 'Explain this repo: what it does, how it is laid out, and where to start reading.' }];
  const file = tree == null ? null : largestUntested(tree);
  const name = file ? cleanName(file) : '';
  if (name) out.push({ id: 'tests', label: `Add tests for ${cleanName(file.split('/').pop())}`, text: `Add tests for ${name}. Follow the project's existing test style.` });
  if (ciFailed) out.push({ id: 'build', label: 'Fix the failing build', text: 'The latest CI run on this branch failed. Find out why and fix it.' });
  return out.slice(0, 3);
}

/** Sidebar rows (src/overview-sidebar-rows.js) → the page's reply. Oldest Needs-you first. */
function homeOf(sidebar, nowMs, midnightMs) {
  const sessions = Array.isArray(sidebar?.sessions) ? sidebar.sessions : [];
  const needs = sessions.filter((r) => r && r.bucket === 'needs' && r.thread === true && typeof r.id === 'string' && ID.test(r.id))
    .sort((a, b) => (Number(b.age_ms) || 0) - (Number(a.age_ms) || 0));
  const sinceMidnight = Math.max(0, nowMs - midnightMs);
  const check = sessions.filter((r) => r && r.bucket === 'check' && Number.isFinite(r.age_ms) && r.age_ms <= sinceMidnight).length;
  const rows = needs.slice(0, MAX_ROWS).map((r) => ({ id: r.id, title: cleanName(r.title) || 'Untitled', project: cleanName(r.project) }));
  return { summary: { needs: needs.length, check }, rows, more: Math.max(0, needs.length - rows.length), firstEver: sidebar?.status === 'complete' && sessions.length === 0 }; // an unavailable or partial read is never a first run
}

const localMidnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * deps: { ipcMain, buddy() (buddyWin), rows(alive) → Promise<sidebar payload|null> (OverviewMain.passiveSidebarRows),
 *         folderOf(handle) → path|null (the Tasks service), git(cwd, args, opts) → Promise<stdout> (src/checkpoint-git.js run),
 *         ciFailedRepos() → ['owner/name'] (github-signals' live ci-failed events), repoOf(remoteUrl) → 'owner/name'|null,
 *         now? }
 */
function createNewChatHome(deps) {
  const now = deps.now || Date.now;
  const buddy = () => deps.buddy();
  let read = null; // {key, at, pending, result}: one shared read per document generation, at the sidebar's cadence
  let given = null; // {key, ids: Set}: the row ids the last newchat:home reply gave this document generation
  let lastOpen = -Infinity;
  const starterCache = new Map(); // handle → {at, result}

  function owner() {
    const c = buddy()?.newChatContext?.();
    if (!c || !c.window || !c.contents || c.window.isDestroyed?.() || c.contents.isDestroyed?.() || !c.contents.mainFrame
      || !Number.isSafeInteger(c.generation) || !Number.isSafeInteger(c.document)) return null;
    return { window: c.window, contents: c.contents, frame: c.contents.mainFrame, generation: c.generation, document: c.document, foreground: c.foreground === true };
  }
  const keyOf = (o) => `${o.document}:${o.generation}`;
  // C4: with "Show chats" off nothing is answered (no new-chat document can be open then; this is the second lock).
  const chatsOn = () => { try { return typeof deps.chatsOn !== 'function' || deps.chatsOn() !== false; } catch { return false; } };
  const from = (e) => { if (!chatsOn()) return null; const o = owner(); return o && e?.sender === o.contents && e.senderFrame === o.frame ? o : null; };
  const same = (before) => { const o = owner(); return !!o && ['window', 'contents', 'frame', 'generation', 'document'].every((k) => o[k] === before[k]); };

  function fresh(before) {
    return Promise.resolve().then(() => deps.rows(() => same(before))).then((r) => (r && same(before) ? r : null), () => null);
  }
  function shared(before) {
    const key = keyOf(before), t = now();
    if (!(read && read.key === key && (read.pending || t - read.at < READ_MS))) {
      const r = { key, at: t, pending: true, result: null };
      r.result = fresh(before).then((v) => { r.pending = false; r.at = now(); if (!v && read === r) read = null; return v; });
      read = r;
    }
    return read.result;
  }

  async function home(e, ...args) {
    const before = from(e);
    if (!before || args.length !== 0) return null;
    const sidebar = await shared(before);
    if (!sidebar || !same(before)) return null;
    const t = now();
    const out = homeOf(sidebar, t, localMidnight(t));
    given = { key: keyOf(before), ids: new Set(out.rows.map((r) => r.id)) };
    return out;
  }

  async function openRow(e, ...args) {
    const before = from(e);
    const req = args[0];
    if (!before || args.length !== 1 || !req || typeof req !== 'object' || Array.isArray(req) || Object.keys(req).length !== 1
      || typeof req.id !== 'string' || !ID.test(req.id)) return { ok: false };
    if (!before.foreground || !given || given.key !== keyOf(before) || !given.ids.has(req.id)) return { ok: false };
    const t = now();
    if (t - lastOpen < OPEN_GAP_MS) return { ok: false };
    lastOpen = t;
    // S4: still a Needs-you row now, in a read of its own (never the cached one).
    const sidebar = await fresh(before);
    const row = sidebar?.sessions?.find?.((r) => r && r.id === req.id);
    if (!row || row.bucket !== 'needs' || row.thread !== true) return { ok: false };
    const after = owner();
    if (!same(before) || !after?.foreground) return { ok: false };
    return { ok: buddy()?.openThread?.(req.id) === true };
  }

  async function ciFor(dir) {
    // No live ci-failed event anywhere → no need to ask git which repo this is.
    const red = new Set((deps.ciFailedRepos?.() || []).filter((r) => typeof r === 'string'));
    if (!red.size) return false;
    let remotes = '';
    try { remotes = await deps.git(dir, ['remote', '-v'], { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: 64 << 10 }); } catch { return false; }
    for (const line of String(remotes).split('\n')) {
      const p = line.split(/\s+/);
      if (p[2] === '(fetch)' && red.has(deps.repoOf(p[1]))) return true;
    }
    return false;
  }

  async function starters(e, ...args) {
    const before = from(e);
    const req = args[0];
    if (!before || args.length !== 1 || !req || typeof req !== 'object' || Array.isArray(req) || Object.keys(req).length !== 1
      || typeof req.handle !== 'string' || !req.handle || req.handle.length > 200) return { starters: [] };
    let dir = null;
    try { dir = deps.folderOf(req.handle); } catch { dir = null; }
    if (typeof dir !== 'string' || !dir) return { starters: [] };
    const t = now(), hit = starterCache.get(req.handle);
    let result;
    if (hit && hit.dir === dir && t - hit.at < STARTER_MS) result = await hit.result;
    else {
      const p = (async () => {
        let tree = null;
        try { tree = await deps.git(dir, ['ls-tree', '-r', '-l', '--full-tree', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }); } catch { tree = null; }
        return startersFor({ tree, ciFailed: tree != null && await ciFor(dir) });
      })();
      starterCache.set(req.handle, { at: t, dir, result: p });
      if (starterCache.size > 50) starterCache.delete(starterCache.keys().next().value);
      result = await p;
    }
    if (!same(before)) return { starters: [] };
    return { starters: result.map((s) => ({ ...s })) };
  }

  return {
    register(ipcMain = deps.ipcMain) {
      ipcMain.handle(CHANNELS.home, home);
      ipcMain.handle(CHANNELS.starters, starters);
      ipcMain.handle(CHANNELS.openRow, openRow);
    },
  };
}

module.exports = { createNewChatHome, CHANNELS, ROW_KEYS, startersFor, largestUntested, homeOf, cleanName };
