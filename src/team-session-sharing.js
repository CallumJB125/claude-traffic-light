'use strict';
// Main-only automatic sharing. Association comes from the workspace recorded
// when a session starts, never from renderer-supplied team IDs or a folder name.
function createTeamSessionSharing({ host, origin, sessions, association, now = Date.now, onChange = () => {} }) {
  let active = null, stopped = false;
  const blocked = new Map();
  async function pass() {
    const h = host(), base = origin();
    if (!h || !base) { for (const [key, record] of owned) { record.host.stopSharing(record.id); owned.delete(key); onChange(); } return; }
    if (!h.connected()) return;
    const catalog = await h.listShares();
    if (stopped || host() !== h || origin() !== base || !catalog?.ok) return;
    const permitted = new Set(catalog.teams.map(t => t.id));
    const desired = new Map();
    for (const { state } of sessions().slice(0, 64)) {
      if (state.status === 'ended' || (state.ownership !== 'plexiform-owned' && state.provider?.id !== 'claude-channel')) continue;
      const a = association(state.board);
      if (a && a.origin === base && permitted.has(a.team)) desired.set(`${state.session}\n${a.team}`, { session: state.session, team: a.team, board: state.board, generation: state.generation, ownership: state.ownership, provider: state.provider?.id });
    }
    // This reconciler owns only shares it created. Manual shares are retained.
    for (const [key, record] of [...owned]) {
      const live = h.shared().find(s => s.id === record.id);
      if (record.host !== h || !live) { record.host.stopSharing(record.id); owned.delete(key); blocked.set(key, Infinity); continue; }
      if (!desired.has(key)) { h.stopSharing(record.id); owned.delete(key); onChange(); }
    }
    for (const [key, d] of desired) {
      if (stopped || host() !== h || origin() !== base) return;
      const a = association(d.board);
      if (!a || a.origin !== base || a.team !== d.team || !sessions().some(x => x.state.session === d.session && x.state.status !== 'ended')) continue;
      if (owned.has(key) || (blocked.get(key) ?? 0) > now()) continue;
      // An explicit manual watch share takes precedence over automatic control.
      if (h.shared().some(s => s.session === d.session && s.team.id === d.team)) continue;
      blocked.set(key, now() + 60_000);
      const result = await h.shareSession({ session: d.session, team: d.team, scope: 'interact' });
      const current = association(d.board);
      if (result?.ok) {
        const session = sessions().find(x => x.state.session === d.session)?.state;
        if (stopped || host() !== h || origin() !== base || !current || current.origin !== base || current.team !== d.team || !session || session.status === 'ended' || session.generation !== d.generation || session.ownership !== d.ownership || session.provider?.id !== d.provider) h.stopSharing(result.share.id);
        else { owned.set(key, { host: h, id: result.share.id }); onChange(); }
      }
    }
    const liveSessions = new Set(sessions().filter(x => x.state.status !== 'ended').map(x => x.state.session));
    for (const key of blocked.keys()) if (!liveSessions.has(key.split('\n')[0])) blocked.delete(key);
    // Never evict a live explicit revocation to make room for a new share.
    if (blocked.size > 256) for (const [key, until] of blocked) { if (blocked.size <= 256) break; if (until !== Infinity && until <= now() && !desired.has(key)) blocked.delete(key); }
  }
  const owned = new Map();
  return {
    sync() { if (stopped) return Promise.resolve(); if (!active) active = pass().finally(() => { active = null; }); return active; },
    stop() { stopped = true; for (const r of owned.values()) r.host.stopSharing(r.id); owned.clear(); },
  };
}
module.exports = { createTeamSessionSharing };
