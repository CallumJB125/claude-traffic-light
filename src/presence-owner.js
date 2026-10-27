'use strict';
// One presence slot per person per team on the hub. Each surface that shows a
// session (Overview's details panels, later a shared-session thread) registers
// as a named viewer; main sends the most recently opened live viewer's card,
// and only the viewer that set a card can clear it. Fixed viewer tags only.
function createPresenceOwner({ presenceView = () => 0 } = {}) {
  const viewers = new Map(); // tag -> { team, card, seq }
  const sent = new Map(); // team -> card id last sent
  let seq = 0;
  function send(team, card) {
    try { presenceView({ team, card_id: card }); } catch { /* presence is best effort */ }
  }
  function settle(teams) {
    for (const team of teams) {
      let best = null;
      for (const v of viewers.values()) if (v.team === team && (!best || v.seq > best.seq)) best = v;
      const want = best ? best.card : null;
      const had = sent.get(team) ?? null;
      if (want === had) continue;
      if (want === null) sent.delete(team); else sent.set(team, want);
      send(team, want);
    }
  }
  return {
    // set(tag, {team, card}) opens; set(tag, null) clears only what this tag set.
    // Returns true when the hub was told something new.
    set(tag, value) {
      const prev = viewers.get(tag) ?? null;
      const teams = new Set();
      if (prev) teams.add(prev.team);
      if (value && typeof value.team === 'string' && value.team && typeof value.card === 'string' && value.card) {
        viewers.set(tag, { team: value.team, card: value.card, seq: ++seq });
        teams.add(value.team);
      } else viewers.delete(tag);
      const before = JSON.stringify([...sent]);
      settle(teams);
      return JSON.stringify([...sent]) !== before;
    },
    clearAll() {
      viewers.clear();
      const teams = [...sent.keys()];
      sent.clear();
      for (const team of teams) send(team, null);
    },
  };
}

module.exports = { createPresenceOwner };
