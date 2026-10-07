'use strict';

// Main-side actions behind the Sessions page's "Add sessions" panel and row
// buttons: link a repo to a board, start a tracked session, make a card from a
// session, attach a session to a card. The page holds only opaque handles; every
// path, session id and card id stays here.

const crypto = require('node:crypto');
const path = require('node:path');
const BurstHandover = require('./burst-handover.js');

// The same sentence the board's Team page shows (board/web/js/render-team.js SCOPE_RULE; a test keeps them equal).
const SCOPE_RULE = 'A session only shows once it writes into a repo linked to this board. Personal repos and sessions marked “Personal — don’t track” never show.';
// The AI tools page belongs to another build (G3). Until its id exists in buddy-window/pages.js, "Connect a tool" opens Preferences.
const AI_TOOLS_PAGE_ID = 'aitools';
const FALLBACK_PAGE_ID = 'settings';
const COMMANDS = { claude: 'claude', codex: 'codex', gemini: 'gemini' };
const PROVIDERS = new Set(['codex', 'cursor', 'gemini', 'hermes']);
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const providerOf = (row) => (row.source == null || row.source === 'claude' || row.source === 'claude-code' ? 'claude' : PROVIDERS.has(row.source) ? row.source : null);
const isLocal = (r) => r && typeof r === 'object' && !r.remote && !r.device && typeof r.sessionId === 'string' && !r.sessionId.startsWith('remote:');
const leaf = (p) => path.basename(String(p || '')).slice(0, 80) || 'folder';

function create({ sessions, repoOf, rootOf, boards, capture, links, captured = () => [], tasks, clipboard, pickFolder, openPage, pageExists = () => false }) {
  const salt = crypto.randomBytes(8).toString('hex');
  const handleOf = (row) => crypto.createHash('sha256').update(`${salt}|${providerOf(row)}|${row.sessionId}`).digest('hex').slice(0, 20);
  const folders = new Map(); // handle -> absolute path
  const cardRefs = new Map(); // ref -> card
  const roots = new Map(); // cwd -> { root, at }
  const rows = () => (sessions() || []).filter(isLocal);
  const rowOf = (handle) => rows().find((r) => providerOf(r) && handleOf(r) === handle) ?? null;
  const folder = (p) => {
    for (const [h, v] of folders) if (v === p) return h;
    if (folders.size >= 200) folders.delete(folders.keys().next().value);
    const h = crypto.randomUUID(); folders.set(h, p); return h;
  };

  // Per-row additions, synchronous from caches; the repo root is looked up in the background.
  function rowInfo(row) {
    const provider = providerOf(row);
    if (!provider) return null;
    const cached = typeof row.cwd === 'string' ? roots.get(row.cwd) : null;
    if (typeof row.cwd === 'string' && !cached) {
      roots.set(row.cwd, { root: null, at: 0 });
      Promise.resolve(rootOf(row.cwd)).then((root) => roots.set(row.cwd, { root: root || null, at: Date.now() }), () => {});
    }
    const link = links.forSession(provider, row.sessionId);
    const made = captured().find((c) => c.session_id === row.sessionId && c.provider === provider && c.card_id);
    const root = cached?.root;
    return {
      handle: handleOf(row),
      card: link ? { label: [link.card_key, link.title].filter(Boolean).join(' ') || 'a card', how: 'attached' } : made ? { label: 'a board card', how: 'made' } : null,
      share: root ? { on: links.shared()[BurstHandover.repoKey(root)] === true } : null,
    };
  }

  async function setup() {
    const seen = new Map();
    for (const r of rows().slice(0, 50)) {
      if (typeof r.cwd !== 'string' || !path.isAbsolute(r.cwd) || seen.has(r.cwd)) continue;
      const root = await rootOf(r.cwd).catch(() => null);
      const base = root || r.cwd;
      if (!seen.has(base)) seen.set(base, { handle: folder(base), label: leaf(base), canonical: root ? await repoOf(base).catch(() => null) : null });
    }
    let ais = [];
    try { ais = (await tasks().composerInfo()).ais; } catch { ais = []; }
    return {
      boards: await boards.boards().catch(() => []),
      repos: [...seen.values()].map((v) => ({ handle: v.handle, label: v.label, remote: v.canonical })).slice(0, 20),
      ais: ais.map((a) => ({ id: a.id, label: a.label, ready: a.installed && a.loggedIn !== false, note: !a.installed ? 'Not installed' : a.loggedIn === false ? 'Not signed in' : '' })),
      scopeRule: SCOPE_RULE,
      sessionCount: rows().length,
    };
  }

  async function chooseFolder() {
    const dir = await pickFolder();
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
    const root = await rootOf(dir).catch(() => null);
    const base = root || dir;
    return { handle: folder(base), label: leaf(base), remote: root ? await repoOf(base).catch(() => null) : null };
  }

  async function linkRepo({ folder: handle, board }) {
    const dir = folders.get(handle);
    if (!dir) return { ok: false, text: 'Choose a folder first.' };
    const canonical = await repoOf(dir).catch(() => null);
    if (!canonical) return { ok: false, text: 'That folder has no network git remote (origin), so it can’t be linked to a board.' };
    const r = await boards.linkRepo(board, canonical);
    return r.ok ? { ok: true, canonical, text: `Linked ${canonical}. ${SCOPE_RULE}` } : { ok: false, needsAdmin: !!r.needsAdmin, canonical, text: r.error };
  }

  async function startSession({ folder: handle, ai, prompt }) {
    const dir = folders.get(handle);
    if (!dir) return { ok: false, text: 'Choose a folder first.' };
    const text = typeof prompt === 'string' ? prompt.trim().slice(0, 8000) : '';
    const cmd = COMMANDS[ai];
    if (!cmd) return { ok: false, text: 'Plexiform can’t start that tool from here yet. Connect it first, then run it in a terminal.' };
    const copy = (why) => {
      clipboard.writeText(`cd ${q(dir)} && ${cmd}`);
      return { ok: true, copied: true, text: `${why} The command is copied: paste it in a terminal. It appears here once its hooks report.` };
    };
    if (!text) return copy('Plexiform starts a session when it has a first prompt.');
    try {
      const svc = tasks();
      const r = await svc.create({ text, folder: svc.registerFolder(dir).handle, ai, surface: 'tab' });
      if (r?.ok) return { ok: true, text: `Started ${ai} in a terminal tab in ${leaf(dir)}. It is tracked from the start.` };
    } catch { /* fall through to the command */ }
    return copy('Plexiform could not start it itself.');
  }

  async function makeCard(handle, board) {
    const row = rowOf(handle);
    if (!row) return { ok: false, text: 'That session is no longer visible. Refresh.' };
    const provider = providerOf(row);
    const attached = links.forSession(provider, row.sessionId);
    if (attached) return { ok: true, existing: true, text: `This session is already attached to ${attached.card_key || 'a card'}.` };
    const canonical = typeof row.cwd === 'string' ? await repoOf(row.cwd).catch(() => null) : null;
    const key = await boards.captureKey(board, canonical);
    if (!key) return { ok: false, needsLink: true, text: 'Link this repo to that board first (Link repo to board), then make the card.' };
    const r = await capture.captureOnce(row, key);
    if (r.ok) return { ok: true, existing: !!r.existing, text: r.existing ? 'This session already has a card.' : 'Card made from this session.' };
    const why = { not_trackable: 'This session can’t be tracked (it is a background or owned session).', repo_not_linked: 'Link this repo to that board first.', untracked: 'The board turned tracking off for this session.' }[r.reason];
    return { ok: false, text: why || 'Could not make the card. Try again.' };
  }

  async function searchCards(query) {
    const found = await boards.searchCards(query);
    cardRefs.clear();
    return found.map((c) => { const ref = crypto.randomUUID(); cardRefs.set(ref, c); return { ref, card_key: c.card_key, title: c.title, board: c.board }; });
  }

  function attach(handle, ref) {
    const row = rowOf(handle), card = cardRefs.get(ref);
    if (!row || !card) return { ok: false, text: 'Search again and pick the card.' };
    const ok = links.attach({ provider: providerOf(row), session_id: row.sessionId, card_id: card.card_id, card_key: card.card_key, title: card.title, destination: boards.destinationOf(card.boardKey) });
    return ok ? { ok: true, text: `Attached to ${card.card_key || 'the card'}. Saved on this computer only: the board has no session link, so teammates don’t see the attachment.` } : { ok: false, text: 'Could not save the attachment.' };
  }

  async function shareHandover(handle, on) {
    const row = rowOf(handle);
    const root = row && typeof row.cwd === 'string' ? await rootOf(row.cwd).catch(() => null) : null;
    return !!root && links.setShare(BurstHandover.repoKey(root), on === true);
  }

  async function linkFromSession(handle) {
    const row = rowOf(handle);
    const root = row && typeof row.cwd === 'string' ? await rootOf(row.cwd).catch(() => null) : null;
    return root ? { folder: folder(root), label: leaf(root) } : null;
  }

  const connect = () => openPage(pageExists(AI_TOOLS_PAGE_ID) ? AI_TOOLS_PAGE_ID : FALLBACK_PAGE_ID);

  return { rowInfo, setup, chooseFolder, linkRepo, startSession, makeCard, searchCards, attach, shareHandover, linkFromSession, connect };
}

module.exports = { create, SCOPE_RULE, AI_TOOLS_PAGE_ID, providerOf };
