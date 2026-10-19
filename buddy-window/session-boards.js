'use strict';

// Main-side broker for the Sessions page: which boards exist (the personal one
// and each signed-in team's), linking a repository to one, finding a card, and
// the opt-in handover share's send. A renderer only ever holds opaque keys.

const crypto = require('node:crypto');

const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_HUBS = 8;
const MAX_CARDS = 20;
const keyOf = (b) => crypto.createHash('sha256').update(JSON.stringify([b.kind, b.hub ?? null, b.team_id ?? null, b.board_id ?? null])).digest('hex').slice(0, 24);
const FORBIDDEN = 'Only a team owner or admin can link a repository. Ask one of them, or choose My board.';

// hubs(): signed-in hub origins. local: { localRequest }. getRoutes: work-capture's catalog read.
function createSessionBoards({ hubs, clientFor, userOf, local, getRoutes, routeKey, log = () => {} }) {
  const known = new Map(); // key -> board

  async function boards() {
    known.clear();
    const out = [];
    const add = (b, label) => { const key = keyOf(b); known.set(key, b); out.push({ key, label, kind: b.kind }); };
    let mine = null;
    try {
      const me = await local.localRequest('GET', '/api/me');
      mine = me.ok ? (me.boards ?? []).find((b) => !b.archived_at && b.name === 'My board') ?? (me.boards ?? []).find((b) => !b.archived_at) : null;
    } catch { mine = null; }
    add({ kind: 'local', board_id: mine && ID.test(mine.id) ? mine.id : null }, 'My board (stays on this computer)');
    for (const hub of hubs().slice(0, MAX_HUBS)) {
      let r; try { r = await clientFor(hub).me(); } catch { continue; }
      if (!r?.ok || !Array.isArray(r.teams)) continue;
      for (const t of r.teams.slice(0, 32)) {
        if (!ID.test(t?.id ?? '') || !['owner', 'admin', 'member', 'viewer'].includes(t.role)) continue;
        for (const b of (Array.isArray(t.boards) ? t.boards : []).slice(0, 32)) {
          if (!ID.test(b?.id ?? '')) continue;
          add({ kind: 'team', hub, team_id: t.id, board_id: b.id, role: t.role, user_id: userOf(hub)?.id ?? null }, `${String(t.name ?? 'Team').slice(0, 60)} / ${String(b.name ?? 'Board').slice(0, 60)}${t.role === 'viewer' ? ' (read only)' : ''}`);
        }
      }
    }
    return out;
  }
  const lookup = async (key) => { if (!known.has(key)) await boards(); return known.get(key) ?? null; };

  // Link a repository (its canonical name, e.g. github.com/org/app) to a board.
  async function linkRepo(key, canonical) {
    const b = await lookup(key);
    if (!b || typeof canonical !== 'string') return { ok: false, error: 'That board is no longer available. Try again.' };
    const url = `https://${canonical}`;
    try {
      if (b.kind === 'local') {
        if (!b.board_id) return { ok: false, error: 'The personal board is not ready yet. Try again in a moment.' };
        let repo = await local.localRequest('POST', '/api/repos', { request_id: crypto.randomUUID(), url });
        let id = repo.ok ? repo.repo?.id : null;
        if (!id) { const all = await local.localRequest('GET', '/api/repos'); id = (all.repos ?? []).find((r) => r.canonical_url === canonical)?.id ?? null; }
        if (!id) return { ok: false, error: 'Could not add this repository to My board.' };
        const added = await local.localRequest('POST', `/api/boards/${b.board_id}/repos`, { repo_id: id });
        return added.ok ? { ok: true } : { ok: false, error: 'Could not link this repository to My board.' };
      }
      if (b.role === 'viewer') return { ok: false, needsAdmin: true, error: FORBIDDEN };
      const c = clientFor(b.hub);
      const listed = await c.listRepos(b.team_id);
      let id = listed.ok ? (listed.repos ?? []).find((r) => r.canonical_url === canonical)?.id ?? null : null;
      if (!id) {
        const made = await c.createRepo(b.team_id, url);
        if (made.status === 403 || made.code === 'FORBIDDEN') return { ok: false, needsAdmin: true, error: FORBIDDEN };
        id = made.ok ? made.repo?.id : null;
        if (!id) return { ok: false, error: made.error || 'Could not add this repository to the team.' };
      }
      const added = await c.addBoardRepo(b.team_id, b.board_id, id);
      if (added.status === 403 || added.code === 'FORBIDDEN') return { ok: false, needsAdmin: true, error: FORBIDDEN };
      return added.ok ? { ok: true } : { ok: false, error: added.error || 'Could not link this repository to the board.' };
    } catch (e) { log('[session-boards] link failed', e && e.code); return { ok: false, error: 'Could not reach the board. Try again.' }; }
  }

  // The work-capture route key for (board, repo): present only when the repo is linked to that team board.
  async function captureKey(key, canonical) {
    const b = await lookup(key);
    if (!b) return null;
    if (b.kind === 'local') return 'local';
    const { routes, complete } = await getRoutes();
    const r = complete ? routes.find((x) => x.hub === b.hub && x.team_id === b.team_id && x.board_id === b.board_id && x.canonical_url === canonical) : null;
    return r ? routeKey(r) : null;
  }

  // Cards on every reachable board whose title or key matches. Opaque card refs only.
  async function searchCards(query) {
    const q = String(query ?? '').trim().toLowerCase().slice(0, 80);
    const out = [];
    const list = await boards();
    for (const bk of list) {
      if (out.length >= MAX_CARDS) break;
      const b = known.get(bk.key);
      let snap = null;
      try {
        snap = b.kind === 'local' ? (b.board_id ? await local.localRequest('GET', `/api/boards/${b.board_id}`) : null)
          : await clientFor(b.hub).nativeBoard('snapshot', { team: b.team_id, board: b.board_id });
      } catch { snap = null; }
      if (!snap?.ok) continue;
      for (const c of Array.isArray(snap.cards) ? snap.cards : []) {
        if (c.archived || !ID.test(c.id ?? '')) continue;
        const title = String(c.title ?? '').slice(0, 120), ckey = String(c.key ?? '').slice(0, 40);
        if (q && !title.toLowerCase().includes(q) && !ckey.toLowerCase().includes(q)) continue;
        out.push({ card_id: c.id, card_key: ckey, title, board: bk.label, boardKey: bk.key });
        if (out.length >= MAX_CARDS) break;
      }
    }
    return out;
  }

  const destinationOf = (key) => { const b = known.get(key); return b?.kind === 'team' ? { kind: 'team', hub: b.hub, team_id: b.team_id, board_id: b.board_id } : { kind: 'local' }; };

  return { boards, linkRepo, captureKey, searchCards, destinationOf, lookup };
}

module.exports = { createSessionBoards, FORBIDDEN };
