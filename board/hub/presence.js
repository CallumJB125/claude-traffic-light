// Team presence (CONTRACT D37b): what the members' local agent sessions are
// doing, as reported by their desktop-app runners. In memory only, never
// journaled: one entry per device, dropped PRESENCE_TTL_MS after its last
// frame (a disconnect just stops the frames). A board's subscribers see only
// sessions of their own org's members in repos linked to THAT board.

import { PRESENCE_TTL_MS } from '../shared/liveness.js';

export class Presence {
  constructor(hub) {
    this.hub = hub;
    this.byDevice = new Map();   // device_id → {member_id, org_id, sessions, at}
    this.sent = new Map();       // board_id → last members JSON pushed to its subscribers
  }

  /** A `presence` frame from a ready runner connection (already shape-validated). */
  update(conn, msg) {
    // Default deny on the hub too: only repos on a board of the device member's org.
    const allowed = new Set(conn.allowlist().map((r) => r.repo_id));
    const sessions = msg.sessions.filter((s) => allowed.has(s.repo_id)).map((s) => ({
      session_id: s.session_id, agent: s.agent, repo_id: s.repo_id, branch: s.branch ?? null, state: s.state, since: s.since, summary: s.summary ?? null,
    }));
    if (sessions.length) this.byDevice.set(conn.device_id, { member_id: conn.member_id, org_id: conn.member.org_id, sessions, at: this.hub.mono() });
    else this.byDevice.delete(conn.device_id);
    this.changed();
  }

  // Reaper pass: expire silent devices.
  sweep() {
    const now = this.hub.mono();
    let gone = false;
    for (const [id, e] of this.byDevice) if (now - e.at > PRESENCE_TTL_MS) { this.byDevice.delete(id); gone = true; }
    if (gone) this.changed();
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
  subscribed(conn) {
    const v = this.view(conn.boardId);
    this.sent.set(conn.boardId, JSON.stringify(v.members));
    conn.send({ type: 'team.presence', ...v });
  }

  // Push team.presence to each subscribed board whose view changed.
  changed() {
    const boards = new Set([...this.hub.browsers].map((b) => b.boardId).filter(Boolean));
    for (const boardId of boards) {
      const v = this.view(boardId);
      const sig = JSON.stringify(v.members);
      if ((this.sent.get(boardId) ?? '[]') === sig) continue;
      this.sent.set(boardId, sig);
      for (const b of this.hub.browsers) if (b.boardId === boardId) b.send({ type: 'team.presence', ...v });
    }
    for (const id of this.sent.keys()) if (!boards.has(id)) this.sent.delete(id);
  }
}
