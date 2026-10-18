'use strict';
// Per-viewer pins and saved filters for the team sessions overview. A pin names
// work by who, which AI, which board and which task, so it survives a session's
// opaque id changing across restarts. Pinning changes only this viewer's order;
// it never shares or unshares anything. Pure over a plain state object; the page
// persists the serialised form.
(function (root) {
  const MAX_PINS = 30, MAX_FILTERS = 12, FILTER_KEYS = ['person', 'project', 'task', 'platform', 'device', 'status', 'search', 'focus', 'group'];
  const str = (v, max) => typeof v === 'string' && v.length <= max ? v : '';
  const keyOf = e => e && typeof e === 'object' ? [str(e.owner?.name, 200), str(e.provider?.id, 120), str(e.board?.label, 200), str(e.task?.title, 400)].join('\u001f') : '';
  const empty = () => ({ pins: [], filters: [] });
  function parse(raw) {
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return empty();
      const pins = Array.isArray(v.pins) ? v.pins.filter(k => typeof k === 'string' && k.length <= 1000 && k.split('\u001f').length === 4).slice(0, MAX_PINS) : [];
      const filters = Array.isArray(v.filters) ? v.filters.filter(f => f && typeof f === 'object' && str(f.name, 60) && f.values && typeof f.values === 'object').slice(0, MAX_FILTERS)
        .map(f => ({ name: f.name, values: Object.fromEntries(FILTER_KEYS.filter(k => str(f.values[k], 400)).map(k => [k, f.values[k]])) })) : [];
      return { pins: [...new Set(pins)], filters };
    } catch { return empty(); }
  }
  const serialize = state => JSON.stringify({ pins: state.pins.slice(0, MAX_PINS), filters: state.filters.slice(0, MAX_FILTERS) });
  const pinned = (state, e) => state.pins.includes(keyOf(e));
  function togglePin(state, e) {
    const k = keyOf(e); if (!k || k === '\u001f\u001f\u001f') return state;
    const pins = state.pins.includes(k) ? state.pins.filter(x => x !== k) : [k, ...state.pins].slice(0, MAX_PINS);
    return { ...state, pins };
  }
  // Pinned first (most recently pinned on top), then the given order.
  function order(state, entries) {
    const rank = new Map(state.pins.map((k, i) => [k, i]));
    return entries.map((e, i) => ({ e, i, r: rank.has(keyOf(e)) ? rank.get(keyOf(e)) : Infinity })).sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.e);
  }
  function saveFilter(state, name, values) {
    const n = str(name, 60).trim(); if (!n) return state;
    const clean = Object.fromEntries(FILTER_KEYS.filter(k => str(values?.[k], 400)).map(k => [k, values[k]]));
    if (!Object.keys(clean).length) return state;
    return { ...state, filters: [{ name: n, values: clean }, ...state.filters.filter(f => f.name !== n)].slice(0, MAX_FILTERS) };
  }
  const removeFilter = (state, name) => ({ ...state, filters: state.filters.filter(f => f.name !== name) });
  const api = { keyOf, parse, serialize, pinned, togglePin, order, saveFilter, removeFilter, empty, MAX_PINS, MAX_FILTERS, FILTER_KEYS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformPins = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
