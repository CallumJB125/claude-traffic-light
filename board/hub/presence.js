// Team presence (CONTRACT D37b): what the members' local agent sessions are
// doing, as reported by their desktop-app runners. In memory only, never
// journaled: one entry per device, dropped PRESENCE_TTL_MS after its last
// frame (a disconnect just stops the frames). A board's subscribers see only
// sessions of their own org's members in repos linked to THAT board.
// Flood bounds: a connection's non-empty frames closer than PRESENCE_MIN_MS/2
// are dropped, and a board's browsers get at most one push per
// PRESENCE_PUSH_MS (trailing edge, flushed by the reaper, so the last state
// always goes out).
//
// Second kind (team depth lane C): `presence.view {card_id}` frames from
// browsers and desktops say which card this socket's member is looking at.
// One entry per connection, same TTL, same org/board scoping, same memory-only
// rule; pushed as `board.presence` next to the runner sessions while
// `team.presence` keeps its old shape.

import { PRESENCE_TTL_MS, PRESENCE_MIN_MS, PRESENCE_PUSH_MS } from '../shared/liveness.js';
import { assertNoForeignBytes } from '../shared/scope.js';

// name, repo_short, branch and summary are untrusted text (CONTRACT §5.3):
// no C0/C1 control or bidi override/isolate is stored or pushed.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const plain = (v) => (typeof v === 'string' ? v.replace(CONTROLS, '') || null : null);
const TITLE_MAX = 120;

export class Presence {
  constructor(hub) {
    this.hub = hub;
    this.byDevice = new Map();   // device_id → {member_id, org_id, sessions, at}
    this.byConn = new Map();     // BrowserConn → {member_id, org_id, board_id, card_id, at, wall}
    this.sent = new Map();       // board_id → last board.presence JSON pushed to its subscribers
    this.sentTeam = new Map();   // board_id → last team.presence members JSON pushed
    this.pushedAt = new Map();   // board_id → mono of its last push
    this.dirty = new Set();      // board_ids whose view may have changed, push held back
  }

  /** A `presence` frame from a ready runner connection (already shape-validated). */
  update(conn, msg) {
    const now = this.hub.mono();
    if (msg.sessions.length && conn.presenceAt != null && now - conn.presenceAt < PRESENCE_MIN_MS / 2) return;
    conn.presenceAt = now;
    // Default deny on the hub too: only repos on a board of the device member's org.
    const allowed = new Set(conn.allowlist().map((r) => r.repo_id));
    // The runner's path/credential guard again: a session that trips it is dropped.
    const sessions = msg.sessions.filter((s) => allowed.has(s.repo_id)).map((s) => ({
      session_id: s.session_id, agent: s.agent, repo_id: s.repo_id, branch: plain(s.branch), state: s.state, since: s.since, summary: plain(s.summary),
    })).filter((s) => {
      try { assertNoForeignBytes(s, { repo_id: s.repo_id }); return true; } catch { return false; }
    });
    if (sessions.length) this.byDevice.set(conn.device_id, { member_id: conn.member_id, org_id: conn.member.org_id, sessions, at: now });
    else this.byDevice.delete(conn.device_id);
    this.changed(conn.member.org_id);
  }

  /**
   * A `presence.view` frame from a subscribed browser connection (already
   * shape-validated). `card_id: null` clears at once. A card not on the
   * subscribed board clears too (nothing about another board is ever kept).
   * Flood bound: a repeat of the same card closer than PRESENCE_MIN_MS/2 after
   * the connection's last accepted frame is dropped (a keepalive flood); a
   * change of card or a clear is always accepted.
   */
  updateView(conn, msg) {
    if (!conn.boardId || !conn.member) return;
    const now = this.hub.mono();
    const held = this.byConn.get(conn);
    const cardId = typeof msg.card_id === 'string' && msg.card_id ? msg.card_id : null;
    if (cardId && held && held.card_id === cardId && now - held.at < PRESENCE_MIN_MS / 2) return;
    const board = this.hub.board(conn.boardId);
    const card = cardId && board ? this.hub.db.get('SELECT id FROM cards WHERE id = ? AND board_id = ?', cardId, board.id) : null;
    if (card) this.byConn.set(conn, { member_id: conn.member.id, org_id: board.org_id, board_id: board.id, card_id: card.id, at: now, wall: new Date().toISOString() });
    else this.byConn.delete(conn);
    if (!card && !held) return;
    this.dirty.add(conn.boardId);
    this.flush();
  }

  // A browser connection closed, unsubscribed or was revoked: its view goes at once.
  dropConn(conn) {
    const e = this.byConn.get(conn);
    if (!e) return;
    this.byConn.delete(conn);
    this.dirty.add(e.board_id);
    this.flush();
  }

  // A revoked device (or a removed member's) disappears at once, not at the TTL.
  dropDevice(id) {
    const e = this.byDevice.get(id);
    if (!e) return;
    this.byDevice.delete(id);
    this.changed(e.org_id);
  }

  // Reaper pass: expire silent devices and silent viewers.
  sweep() {
    const now = this.hub.mono();
    let gone = false;
    for (const [id, e] of this.byDevice) if (now - e.at > PRESENCE_TTL_MS) { this.byDevice.delete(id); gone = true; }
    for (const [conn, e] of this.byConn) if (now - e.at > PRESENCE_TTL_MS || !this.hub.browsers.has(conn)) { this.byConn.delete(conn); this.dirty.add(e.board_id); }
    if (gone) this.changed();
    else this.flush();
  }

  /** {members:[{member_id, name, sessions:[{agent, repo_short, branch?, state, since, summary?}]}]} for one board (`team.presence`, D37b shape). */
  view(boardId) {
    const board = this.hub.board(boardId);
    if (!board) return { members: [] };
    const repos = new Map(this.hub.db.all('SELECT r.id, r.short_name FROM board_repos br JOIN repos r ON r.id = br.repo_id WHERE br.board_id = ? AND r.org_id = ?', boardId, board.org_id)
      .map((r) => [r.id, plain(r.short_name) ?? '']));
    const members = new Map();
    for (const e of this.byDevice.values()) {
      if (e.org_id !== board.org_id) continue;
      const m = this.hub.activeMember(e.member_id);
      if (!m) continue;
      for (const s of e.sessions) {
        if (!repos.has(s.repo_id)) continue;
        if (!members.has(m.id)) members.set(m.id, { member_id: m.id, name: plain(m.display_name) ?? '', sessions: [] });
        members.get(m.id).sessions.push({
          agent: s.agent, repo_short: repos.get(s.repo_id), ...(s.branch ? { branch: s.branch } : {}), state: s.state, since: s.since, ...(s.summary ? { summary: s.summary } : {}),
        });
      }
    }
    return { members: [...members.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))) };
  }

  /** `[{member_id, name, card_id, key, title, at}]`: who is looking at which card of this board, latest frame first. */
  viewers(boardId) {
    const board = this.hub.board(boardId);
    if (!board) return [];
    const out = [];
    for (const e of this.byConn.values()) {
      if (e.board_id !== boardId || e.org_id !== board.org_id) continue;
      const m = this.hub.activeMember(e.member_id);
      if (!m || m.org_id !== board.org_id) continue;
      const card = this.hub.db.get('SELECT id, key, title FROM cards WHERE id = ? AND board_id = ?', e.card_id, boardId);
      if (!card) continue;
      out.push({ member_id: m.id, name: plain(m.display_name) ?? '', card_id: card.id, key: card.key, title: (plain(card.title) ?? '').slice(0, TITLE_MAX), at: e.wall, _mono: e.at });
    }
    return out.sort((a, b) => b._mono - a._mono || String(a.name).localeCompare(String(b.name))).map(({ _mono, ...v }) => v);
  }

  /** `team.presence` plus `viewing?:{card_id, since}` per member and the `viewers` list: the `board.presence` body. */
  boardView(boardId) {
    const { members } = this.view(boardId);
    const viewers = this.viewers(boardId);
    const byMember = new Map(members.map((m) => [m.member_id, m]));
    for (const v of viewers) {
      if (!byMember.has(v.member_id)) { const m = { member_id: v.member_id, name: v.name, sessions: [] }; byMember.set(v.member_id, m); members.push(m); }
      const m = byMember.get(v.member_id);
      if (!m.viewing) m.viewing = { card_id: v.card_id, since: v.at };
    }
    return { board_id: boardId, members: members.sort((a, b) => String(a.name).localeCompare(String(b.name))), viewers };
  }

  // A browser just subscribed: it gets the current view after its snapshot.
  // (It never updates `sent` for a board that already has one: a held-back
  // push must still reach the board's other browsers.)
  subscribed(conn) {
    const v = this.view(conn.boardId);
    const bv = this.boardView(conn.boardId);
    if (!this.sentTeam.has(conn.boardId)) this.sentTeam.set(conn.boardId, JSON.stringify(v.members));
    if (!this.sent.has(conn.boardId)) this.sent.set(conn.boardId, JSON.stringify(bv));
    conn.send({ type: 'team.presence', ...v });
    conn.send({ type: 'board.presence', ...bv });
  }

  // Mark the subscribed boards of orgId (all orgs when null) for a push.
  changed(orgId = null) {
    for (const boardId of new Set([...this.hub.browsers].map((b) => b.boardId).filter(Boolean))) {
      if (orgId == null || this.hub.board(boardId)?.org_id === orgId) this.dirty.add(boardId);
    }
    this.flush();
  }

  // Push to each marked board whose view changed, at most once per
  // PRESENCE_PUSH_MS per board; the rest wait for a later flush.
  // `team.presence` goes out only when the runner part changed (old shape);
  // `board.presence` whenever sessions or viewers changed.
  flush() {
    const now = this.hub.mono();
    const boards = new Set([...this.hub.browsers].map((b) => b.boardId).filter(Boolean));
    for (const boardId of this.dirty) {
      if (!boards.has(boardId)) { this.dirty.delete(boardId); continue; }
      if (now - (this.pushedAt.get(boardId) ?? -Infinity) < PRESENCE_PUSH_MS) continue;
      this.dirty.delete(boardId);
      const bv = this.boardView(boardId);
      const sig = JSON.stringify(bv);
      if ((this.sent.get(boardId) ?? '') === sig) continue;
      this.sent.set(boardId, sig);
      this.pushedAt.set(boardId, now);
      const v = this.view(boardId);
      const teamSig = JSON.stringify(v.members);
      const teamChanged = (this.sentTeam.get(boardId) ?? '[]') !== teamSig;
      this.sentTeam.set(boardId, teamSig);
      for (const b of this.hub.browsers) {
        if (b.boardId !== boardId) continue;
        if (teamChanged) b.send({ type: 'team.presence', ...v });
        b.send({ type: 'board.presence', ...bv });
      }
    }
    for (const m of [this.sent, this.sentTeam, this.pushedAt]) for (const id of m.keys()) if (!boards.has(id)) m.delete(id);
  }
}
