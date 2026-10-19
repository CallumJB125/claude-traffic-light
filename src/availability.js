'use strict';
// One availability badge per person on the Team sessions overview: active, idle,
// away or offline, folded from that person's directory entries. Pure; reads only
// what the page already holds (the entries' state, age and freshness). Nothing is
// sent anywhere, and no provider transcript is read.
(function (root) {
  const FRESH_MS = 90_000;
  const STALE_MS = 10 * 60_000;
  const LEVELS = Object.freeze(['active', 'idle', 'away', 'offline']);
  const LABEL = Object.freeze({ active: 'Active', idle: 'Idle', away: 'Away', offline: 'Offline' });
  const ago = ms => ms < 60_000 ? `${Math.max(1, Math.floor(ms / 1000))}s ago` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m ago` : `${Math.floor(ms / 3_600_000)}h ago`;
  // entries: one person's directory entries; now and observedAt (when the snapshot
  // was taken) let the badge age in place between refreshes.
  function availability(entries, now = Date.now(), observedAt = now) {
    const list = Array.isArray(entries) ? entries.filter(e => e && typeof e === 'object') : [];
    const drift = Math.max(0, now - (Number.isFinite(observedAt) ? observedAt : now));
    let working = 0, fresh = 0, idle = 0, known = 0, latest = null;
    for (const e of list) {
      const age = Number.isFinite(e.ageMs) && e.ageMs >= 0 ? e.ageMs + drift : null;
      if (e.state === 'Ended' || age === null || e.freshness === 'unknown') continue;
      known++;
      if (latest === null || age < latest) latest = age;
      if (age <= FRESH_MS) { fresh++; if (e.state === 'Working') working++; }
      else if (age < STALE_MS) idle++;
    }
    const level = working ? 'active' : fresh || idle ? 'idle' : known ? 'away' : 'offline';
    const last = latest === null ? '' : ` · last report ${ago(latest)}`;
    const detail = level === 'active' ? `Working in ${working} ${working === 1 ? 'session' : 'sessions'}${last}`
      : level === 'offline' ? 'Not reporting' : `${LABEL[level]}${last}`;
    return { level, label: LABEL[level], detail };
  }
  const api = { availability, LEVELS, FRESH_MS, STALE_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformAvailability = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
