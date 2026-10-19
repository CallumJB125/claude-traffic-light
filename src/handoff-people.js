'use strict';
// A teammate handed you a card on the team board (board/hub/api.js
// requestHandoff): it waits on Sessions as a "Needs you" card, kind `person`,
// next to the AI tool hand-offs of src/handoff-requests.js. Accept answers the
// hub and then reads the card's handover packet, shown like a hand-off the
// person started; Decline answers and tells the sender. Nothing is launched.
// Until the hub's inbox route ships (lane B), the cards come from the linked
// boards' snapshots: only card ids, keys, titles, names and the note travel
// back; nothing about this computer goes up beyond the sign-in.
const crypto = require('node:crypto');

const LIMITS = Object.freeze({ title: 200, note: 2000, name: 80, packet: 4000, keepDoneMs: 10 * 60_000, minRefreshMs: 15_000, boards: 20 });
const STATE = Object.freeze({ requested: 'pending', accepted: 'accepted', declined: 'declined', cancelled: 'cancelled' });
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const ident = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(v);

// Card payload (`card.handoff`) → directory `handoffs[]` row for Overview, as
// seen by member `me`: the sender sees "handed to <name>, waiting".
function personHandoffs(card, me = null) {
  const ho = object(card) && object(card.handoff) ? card.handoff : null;
  if (!ho || !Object.hasOwn(STATE, ho.state) || ho.state === 'cancelled') return [];
  const out = me ? ho.from === me || ho.to !== me : true;
  return [{ direction: out ? 'out' : 'in', with: text(out ? ho.to_name : ho.from_name, LIMITS.name) || 'Teammate', state: ho.state === 'requested' ? 'offered' : ho.state, summary: text(ho.note, 400) }];
}

// The packet projection the hub returns (communication.js) → bounded text the person reads before continuing.
function packetText(packet) {
  if (!object(packet)) return 'No handover packet has been written for this card yet.';
  const lines = [];
  const push = (label, v) => { const t = typeof v === 'string' ? v.trim() : ''; if (t) lines.push(`${label}: ${t.slice(0, 1200)}`); };
  const d = object(packet.data) ? packet.data : packet;
  push('Goal', d.goal ?? d.brief ?? d.title);
  push('Summary', d.summary ?? d.body);
  push('Decisions', Array.isArray(d.decisions) ? d.decisions.filter((x) => typeof x === 'string').join('; ') : d.decisions);
  push('Checks', Array.isArray(d.checks) ? d.checks.filter((x) => typeof x === 'string').join('; ') : d.checks);
  push('Next', Array.isArray(d.next) ? d.next.filter((x) => typeof x === 'string').join('; ') : d.next);
  push('Paths', Array.isArray(d.paths) ? d.paths.filter((x) => typeof x === 'string').slice(0, 40).join(', ') : d.paths);
  if (packet.version != null) lines.push(`Packet version ${packet.version}`);
  return (lines.join('\n') || 'The packet has no text sections yet.').slice(0, LIMITS.packet);
}

// links() → [{route:{hub, board_id, team_id, user_id}, token()}] (buddy-window teamMemoryLinks); fetch: net.fetch.
function create({ links = async () => [], fetch, now = Date.now, onChange = () => {}, notify = () => {}, log = () => {} } = {}) {
  const items = new Map(); // handoff id -> { id, kind:'person', hub, board, team, card, from, to, note, state, direction, packet, created_at, ended_at, token }
  const me = new Map(); // `${hub}\n${team}` -> member id
  let last = 0, inflight = null;

  const headers = (tok, team) => ({ accept: 'application/json', authorization: `Bearer ${tok}`, ...(team ? { 'x-board-team': team } : {}) });
  async function call(link, method, path, body) {
    const tok = typeof link.token === 'function' ? link.token() : null;
    if (!tok) return { status: 401, json: null };
    const res = await fetch(`${link.route.hub}${path}`, { method, headers: { ...headers(tok, link.route.team_id), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error' }); // privacy-flow: team-hub
    let json = null; try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }
  const view = (r) => ({ id: r.id, kind: 'person', from: r.from, to: r.to, label: r.from, reason: r.note, goal: r.card.title, files: [], state: r.state, note: r.packet, direction: r.direction,
    card: { ...r.card }, board: r.board, created_at: r.created_at, ended_at: r.ended_at ?? null });
  const prune = () => { const t = now(); for (const r of items.values()) if (r.state !== 'pending' && t - (r.ended_at || r.created_at) > LIMITS.keepDoneMs) items.delete(r.id); };

  async function refresh({ force = false } = {}) {
    if (inflight) return inflight;
    if (!force && now() - last < LIMITS.minRefreshMs) return false;
    inflight = (async () => {
      let rows = [];
      try { rows = (await links()) || []; } catch { rows = []; }
      const seen = new Set();
      let changed = false;
      const fresh = new Set();
      for (const link of rows.slice(0, LIMITS.boards)) {
        const r = link?.route;
        if (!r || !ident(r.board_id) || typeof r.hub !== 'string' || seen.has(`${r.hub}\n${r.board_id}`)) continue;
        seen.add(`${r.hub}\n${r.board_id}`);
        const mk = `${r.hub}\n${r.team_id ?? ''}`;
        try {
          if (!me.has(mk)) {
            const who = await call(link, 'GET', '/api/me');
            if (who.status !== 200 || !ident(who.json?.member?.id)) continue;
            me.set(mk, who.json.member.id);
          }
          const myId = me.get(mk);
          const board = await call(link, 'GET', `/api/boards/${encodeURIComponent(r.board_id)}`);
          if (board.status !== 200 || !Array.isArray(board.json?.cards)) continue;
          for (const card of board.json.cards.slice(0, 500)) {
            const ho = object(card) && object(card.handoff) ? card.handoff : null;
            if (!ho || !ident(ho.id) || !Object.hasOwn(STATE, ho.state) || !ident(card.id)) continue;
            const mine = ho.to === myId, sent = ho.from === myId;
            if (!mine && !sent) continue;
            fresh.add(ho.id);
            const prev = items.get(ho.id);
            const state = STATE[ho.state];
            if (prev) {
              if (prev.state !== state && prev.state !== 'accepted' && prev.state !== 'declined') { prev.state = state; prev.ended_at = state === 'pending' ? null : now(); changed = true; }
              continue;
            }
            const row = { id: ho.id, kind: 'person', link, hub: r.hub, board: r.board_id, team: r.team_id ?? null, direction: mine ? 'in' : 'out',
              card: { id: card.id, key: text(card.key, 80), title: text(card.title, LIMITS.title) || 'Untitled card' },
              from: text(ho.from_name, LIMITS.name) || 'A teammate', to: text(ho.to_name, LIMITS.name) || 'A teammate', note: text(ho.note, LIMITS.note),
              state, packet: null, created_at: now(), ended_at: state === 'pending' ? null : now() };
            items.set(ho.id, row);
            changed = true;
            if (mine && state === 'pending') notify(view(row));
          }
        } catch (e) { log(`[handoff-people] refresh failed ${e && e.code ? e.code : ''}`); }
      }
      // A request that left the board (cancelled, answered elsewhere) stops waiting here.
      for (const r of items.values()) if (r.state === 'pending' && !fresh.has(r.id) && seen.has(`${r.hub}\n${r.board}`)) { r.state = 'cancelled'; r.ended_at = now(); changed = true; }
      prune();
      last = now();
      if (changed) onChange();
      return changed;
    })();
    try { return await inflight; } finally { inflight = null; }
  }

  function list() { prune(); return [...items.values()].sort((a, b) => b.created_at - a.created_at).map(view); }
  const pending = () => [...items.values()].filter((r) => r.state === 'pending' && r.direction === 'in').length;

  async function answer(id, verb) {
    const r = items.get(String(id));
    if (!r || r.state !== 'pending') return { ok: false, error: 'That hand-off is no longer waiting.' };
    if (r.direction !== 'in') return { ok: false, error: 'Only the person it was handed to can answer.' };
    let res;
    try { res = await call(r.link, 'POST', `/api/cards/${encodeURIComponent(r.card.id)}/handoffs/${encodeURIComponent(r.id)}/${verb}`, { request_id: crypto.randomUUID() }); }
    catch (e) { log(`[handoff-people] ${verb} failed ${e && e.code ? e.code : ''}`); return { ok: false, error: 'The team hub could not be reached. Try again.' }; }
    if (res.status === 409) { r.state = 'cancelled'; r.ended_at = now(); onChange(); return { ok: false, error: 'That hand-off was already answered or taken back.' }; }
    if (res.status !== 200) return { ok: false, error: res.json?.error?.message || 'The team hub refused that answer.' };
    r.state = verb === 'accept' ? 'accepted' : 'declined'; r.ended_at = now();
    if (verb === 'accept') {
      try {
        const p = await call(r.link, 'GET', `/api/cards/${encodeURIComponent(r.card.id)}/packet`);
        r.packet = p.status === 200 ? packetText(p.json?.packet) : 'The handover packet could not be read; open the card on the board.';
      } catch { r.packet = 'The handover packet could not be read; open the card on the board.'; }
    }
    onChange();
    return { ok: true, request: r.id, state: r.state, packet: r.packet, note: verb === 'accept' ? `${r.card.key || 'The card'} is yours. The handover is shown on this card.` : `Declined. ${r.from} is told.` };
  }

  return { refresh, list, pending, accept: (id) => answer(id, 'accept'), decline: (id) => answer(id, 'decline'), LIMITS };
}

module.exports = { create, personHandoffs, packetText, LIMITS };
