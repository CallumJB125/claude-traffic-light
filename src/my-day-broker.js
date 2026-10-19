'use strict';
const crypto = require('node:crypto');
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_ITEMS = 500;
// Sources and identities are registered in main. The renderer supplies only
// a short-lived opaque handle; it cannot choose an origin, account or card.
function createMyDayBroker({ sources, now = Date.now }) {
  let generation = 0, handles = new Map();
  return {
    invalidate() { generation++; handles.clear(); },
    async snapshot() {
      const token = ++generation; handles.clear();
      const registered = await sources();
      if (token !== generation) return { status: 'changed', sources: [] };
      const freshHandles = new Map();
      const results = await Promise.all(registered.slice(0, 9).map(async source => {
        let data; try { data = await source.read(); } catch { /* unavailable */ }
        if (token !== generation || !source.current()) return { name: source.name, status: 'changed' };
        if (!data?.ok || !['complete', 'partial'].includes(data.status) || !data.principal || (source.userId && data.principal.user_id !== source.userId) || !Array.isArray(data.cards) || !Array.isArray(data.decisions) || !Array.isArray(data.agents) || [data.cards, data.decisions, data.agents].some(rows => rows.length > MAX_ITEMS)) return { name: source.name, status: 'unavailable' };
        const allow = row => ID.test(row?.card?.id ?? row?.card_id ?? '') && ID.test(row?.board_id ?? '') && ID.test(row?.member_id ?? '');
        const wrap = row => {
          const handle = crypto.randomUUID();
          freshHandles.set(handle, { source, row, expires: now() + 45_000 });
          return { ...row, handle };
        };
        return { name: source.name, status: data.status, cards: data.cards.filter(allow).map(wrap), decisions: data.decisions.filter(allow).map(wrap), agents: data.agents.filter(allow).map(wrap) };
      }));
      if (token !== generation || registered.slice(0, 9).some(source => !source.current())) return { status: 'changed', sources: [] };
      handles = freshHandles;
      return { status: registered.length > 9 || results.some(s => s.status !== 'complete') ? 'partial' : 'complete', sources: results };
    },
    async open(handle) {
      if (typeof handle !== 'string' || handle.length > 100) return false;
      const entry = handles.get(handle), token = generation;
      if (!entry || entry.expires < now() || !entry.source.current()) return false;
      // Re-read current own/decision scope; stale handles cannot navigate old account work.
      let data; try { data = await entry.source.read(); } catch { return false; }
      if (token !== generation || !entry.source.current() || !data?.ok || (entry.source.userId && data.principal?.user_id !== entry.source.userId)) return false;
      const id = entry.row.card?.id ?? entry.row.card_id;
      const present = [...(data.cards ?? []), ...(data.decisions ?? []), ...(data.agents ?? [])].some(row => (row.card?.id ?? row.card_id) === id && row.board_id === entry.row.board_id && row.member_id === entry.row.member_id);
      return present ? !!await entry.source.open(entry.row, () => entry.source.current()) : false;
    },
  };
}
module.exports = { createMyDayBroker };
