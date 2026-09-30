// Team presence (CONTRACT D37b): what the members' local agent sessions are
// doing, as reported by their desktop-app runners. In memory only, never
// journaled: one entry per device, dropped PRESENCE_TTL_MS after its last
// frame (a disconnect just stops the frames). A board's subscribers see only
// sessions of their own org's members in repos linked to THAT board.
// Flood bounds: a connection's non-empty frames closer than PRESENCE_MIN_MS/2
// are dropped, and a board's browsers get at most one push per
// PRESENCE_PUSH_MS (trailing edge, flushed by the reaper, so the last state
// always goes out).

import { PRESENCE_TTL_MS, PRESENCE_MIN_MS, PRESENCE_PUSH_MS } from '../shared/liveness.js';

export class Presence {
  constructor(hub) {
    this.hub = hub;
    this.byDevice = new Map();   // device_id → {member_id, org_id, sessions, at}
    this.sent = new Map();       // board_id → last members JSON pushed to its subscribers
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
    const sessions = msg.sessions.filter((s) => allowed.has(s.repo_id)).map((s) => ({
      session_id: s.session_id, agent: s.agent, repo_id: s.repo_id, branch: s.branch ?? null, state: s.state, since: s.since, summary: s.summary ?? null,
    }));
    if (sessions.length) this.byDevice.set(conn.device_id, { member_id: conn.member_id, org_id: conn.member.org_id, sessions, at: now });
    else this.byDevice.delete(conn.device_id);
    this.changed(conn.member.org_id);
  }

  // A revoked device (or a removed member's) disappears at once, not at the TTL.
  dropDevice(id) {
    const e = this.byDevice.get(id);
    if (!e) return;
    this.byDevice.delete(id);
    this.changed(e.org_id);
  }

  // Reaper pass: expire silent devices.
  sweep() {
    const now = this.hub.mono();
    let gone = false;
    for (const [id, e] of this.byDevice) if (now - e.at > PRESENCE_TTL_MS) { this.byDevice.delete(id); gone = true; }
    if (gone) this.changed();
    else this.flush();
  }

  /** {members:[{member_id, name, sessions:[{agent, repo_short, branch?, state, since, summary?}]}]} for one board. */
  view(boardId) {
    const board = this.hub.board(boardId);
    if (!board) return { members: [] };
    const repos = new Map(this.hub.db.all('SELECT r.id, r.short_name FROM board_repos br JOIN repos r ON r.id = br.repo_id WHERE br.board_id = ? AND r.org_id = ?', boardId, board.org_id)
      .map((r) => [r.id, r.short_name]));
    const members = new Map();
    for (const e of this.byDevice.values()) {
      if (e.org_id !== board.org_id) continue;
      const m = this.hub.activeMember(e.member_id);
      if (!m) continue;
      for (const s of e.sessions) {
        if (!repos.has(s.repo_id)) continue;
        if (!members.has(m.id)) members.set(m.id, { member_id: m.id, name: m.display_name, sessions: [] });
        members.get(m.id).sessions.push({
          agent: s.agent, repo_short: repos.get(s.repo_id), ...(s.branch ? { branch: s.branch } : {}), state: s.state, since: s.since, ...(s.summary ? { summary: s.summary } : {}),
        });
      }
    }
    return { members: [...members.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))) };
  }

  // A browser just subscribed: it gets the current view after its snapshot.
  // (It never updates `sent` for a board that already has one: a held-back
  // push must still reach the board's other browsers.)
  subscribed(conn) {
    const v = this.view(conn.boardId);
    if (!this.sent.has(conn.boardId)) this.sent.set(conn.boardId, JSON.stringify(v.members));
    conn.send({ type: 'team.presence', ...v });
  }

  // Mark the subscribed boards of orgId (all orgs when null) for a push.
  changed(orgId = null) {
    for (const boardId of new Set([...this.hub.browsers].map((b) => b.boardId).filter(Boolean))) {
      if (orgId == null || this.hub.board(boardId)?.org_id === orgId) this.dirty.add(boardId);
    }
    this.flush();
  }

  // Push team.presence to each marked board whose view changed, at most once
  // per PRESENCE_PUSH_MS per board; the rest wait for a later flush.
  flush() {
    const now = this.hub.mono();
    const boards = new Set([...this.hub.browsers].map((b) => b.boardId).filter(Boolean));
    for (const boardId of this.dirty) {
      if (!boards.has(boardId)) { this.dirty.delete(boardId); continue; }
      if (now - (this.pushedAt.get(boardId) ?? -Infinity) < PRESENCE_PUSH_MS) continue;
      this.dirty.delete(boardId);
      const v = this.view(boardId);
      const sig = JSON.stringify(v.members);
      if ((this.sent.get(boardId) ?? '[]') === sig) continue;
      this.sent.set(boardId, sig);
      this.pushedAt.set(boardId, now);
      for (const b of this.hub.browsers) if (b.boardId === boardId) b.send({ type: 'team.presence', ...v });
    }
    for (const m of [this.sent, this.pushedAt]) for (const id of m.keys()) if (!boards.has(id)) m.delete(id);
  }
}
