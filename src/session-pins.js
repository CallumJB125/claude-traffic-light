'use strict';
// Per-viewer pins and saved filters for the team sessions overview. A pin names
// work by who, which AI, which board and which task, so it survives a session's
// opaque id changing across restarts. Pinning changes only this viewer's order;
// it never shares or unshares anything. Pure over a plain state object; the page
// persists the serialised form.
(function (root) {
  const MAX_PINS = 30, MAX_FILTERS = 12, MAX_COLLECTIONS = 12, MAX_COLLECTION_KEYS = 30, FILTER_KEYS = ['person', 'project', 'task', 'platform', 'device', 'status', 'search', 'focus', 'group'];
  const str = (v, max) => typeof v === 'string' && v.length <= max ? v : '';
  const Organise = root.PlexiformWorkOrganise || (typeof module === 'object' && module.exports ? require('./work-organise.js') : null);
  const BUCKET_IDS = ['needs', 'working', 'check', 'stuck', 'idle'];
  // A status filter is a bucket id. Ones saved before that hold the old state words
  // ("Needs input", "Working", "Ended"); they map once to the bucket those words now
  // fall in, and a bucket id maps to itself, so loading again changes nothing.
  const statusId = v => BUCKET_IDS.includes(v) ? v : Organise ? Organise.bucketOf(v) : v;
  const keyOf = e => e && typeof e === 'object' ? [str(e.owner?.name, 200), str(e.provider?.id, 120), str(e.board?.label, 200), str(e.task?.title, 400)].join('\u001f') : '';
  const empty = () => ({ pins: [], filters: [], collections: [] });
  const validKey = k => typeof k === 'string' && k.length <= 1000 && k.split('\u001f').length === 4 && k !== '\u001f\u001f\u001f';
  const collName = v => typeof v === 'string' ? v.trim().slice(0, 60) : '';
  const sameName = (a, b) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
  const findCollection = (state, name) => state.collections.find(c => sameName(c.name, name));
  function parseCollections(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const c of v) {
      if (!c || typeof c !== 'object' || typeof c.name !== 'string' || c.name.length > 60) continue;
      const name = collName(c.name); if (!name || out.some(x => sameName(x.name, name))) continue;
      const keys = Array.isArray(c.keys) ? [...new Set(c.keys.filter(validKey))].slice(0, MAX_COLLECTION_KEYS) : [];
      out.push({ name, keys });
      if (out.length === MAX_COLLECTIONS) break;
    }
    return out;
  }
  function parse(raw) {
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return empty();
      const pins = Array.isArray(v.pins) ? v.pins.filter(k => typeof k === 'string' && k.length <= 1000 && k.split('\u001f').length === 4).slice(0, MAX_PINS) : [];
      const collections = parseCollections(v.collections);
      let upgraded = false;
      const filters = Array.isArray(v.filters) ? v.filters.filter(f => f && typeof f === 'object' && str(f.name, 60) && f.values && typeof f.values === 'object').slice(0, MAX_FILTERS)
        .map(f => ({ name: f.name, values: Object.fromEntries(FILTER_KEYS.filter(k => str(f.values[k], 400)).map(k => {
          if (k !== 'status') return [k, f.values[k]];
          const id = statusId(f.values[k]); if (id !== f.values[k]) upgraded = true;
          return [k, id];
        })) })) : [];
      return { pins: [...new Set(pins)], filters, collections, ...(upgraded ? { upgraded } : {}) };
    } catch { return empty(); }
  }
  const serialize = state => JSON.stringify({ pins: state.pins.slice(0, MAX_PINS), filters: state.filters.slice(0, MAX_FILTERS), collections: (state.collections ?? []).slice(0, MAX_COLLECTIONS).map(c => ({ name: c.name, keys: c.keys.slice(0, MAX_COLLECTION_KEYS) })) });
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
  // Collections: a viewer's named grouping of sessions. Local only, like pins.
  function addToCollection(state, name, e) {
    const n = collName(name), k = keyOf(e); if (!n || !validKey(k)) return state;
    const existing = findCollection(state, n);
    if (!existing && state.collections.length >= MAX_COLLECTIONS) return state;
    if (existing && existing.keys.includes(k)) return state;
    const updated = { name: existing ? existing.name : n, keys: [k, ...(existing ? existing.keys : [])].slice(0, MAX_COLLECTION_KEYS) };
    const collections = existing ? state.collections.map(c => c === existing ? updated : c) : [...state.collections, updated];
    return { ...state, collections };
  }
  function removeFromCollection(state, name, e) {
    const k = keyOf(e), existing = findCollection(state, collName(name)); if (!existing || !existing.keys.includes(k)) return state;
    return { ...state, collections: state.collections.map(c => c === existing ? { name: c.name, keys: c.keys.filter(x => x !== k) } : c) };
  }
  const removeCollection = (state, name) => ({ ...state, collections: state.collections.filter(c => !sameName(c.name, collName(name))) });
  const collectionsOf = (state, e) => { const k = keyOf(e); return state.collections.filter(c => c.keys.includes(k)).map(c => c.name); };
  const inCollection = (state, name, e) => { const c = findCollection(state, collName(name)); return !!c && c.keys.includes(keyOf(e)); };
  const api = { BUCKET_IDS, keyOf, parse, serialize, pinned, togglePin, order, saveFilter, removeFilter, addToCollection, removeFromCollection, removeCollection, collectionsOf, inCollection, empty, MAX_PINS, MAX_FILTERS, MAX_COLLECTIONS, MAX_COLLECTION_KEYS, FILTER_KEYS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformPins = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
