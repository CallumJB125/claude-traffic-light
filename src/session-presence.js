'use strict';
// Who is looking at a shared session right now. A tracker keeps heartbeats
// per session key and viewer; a viewer disappears 60 s after its last beat.
// Only sessions the caller marks shared are tracked, so a private session can
// never show viewers. Transport is injected: the team hub publishes beats when
// it supports presence; without that support nothing is shown.
(function (root) {
  const TTL_MS = 60_000, BEAT_MS = 20_000, MAX_SESSIONS = 300, MAX_VIEWERS = 20;
  const str = (v, max) => typeof v === 'string' && v && v.length <= max ? v : '';
  function createPresence({ now = Date.now, shared = () => true } = {}) {
    const beats = new Map();
    function beat(sessionKey, viewer, at = now()) {
      const k = str(sessionKey, 1000), name = str(viewer?.name, 200);
      if (!k || !name || shared(k) !== true) return false;
      if (!beats.has(k)) { if (beats.size >= MAX_SESSIONS) beats.delete(beats.keys().next().value); beats.set(k, new Map()); }
      const m = beats.get(k);
      m.set(name, { name, initials: str(viewer.initials, 8) || name.slice(0, 2).toUpperCase(), at });
      while (m.size > MAX_VIEWERS) m.delete(m.keys().next().value);
      return true;
    }
    function leave(sessionKey, viewerName) { beats.get(str(sessionKey, 1000))?.delete(str(viewerName, 200)); }
    function viewers(sessionKey, at = now()) {
      const m = beats.get(str(sessionKey, 1000)); if (!m) return [];
      for (const [name, v] of m) if (at - v.at >= TTL_MS) m.delete(name);
      if (!m.size) beats.delete(str(sessionKey, 1000));
      return [...m.values()].sort((a, b) => b.at - a.at).map(v => ({ name: v.name, initials: v.initials }));
    }
    return { beat, leave, viewers };
  }
  const validViewers = list => Array.isArray(list) && list.length <= MAX_VIEWERS && list.every(v => v && typeof v === 'object' && str(v.name, 200) && str(v.initials, 8));
  const api = { createPresence, validViewers, TTL_MS, BEAT_MS, MAX_VIEWERS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformPresence = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
