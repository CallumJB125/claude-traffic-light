'use strict';
// Follow a teammate's shared session: this viewer is told once when it needs
// input, finishes or fails. Follows are per viewer and keyed like pins. Only
// entries the directory already shows (explicitly shared with this viewer) can
// be followed; transitions are derived from consecutive directory snapshots and
// deduplicated by session key + transition + the state's own observation time.
(function (root) {
  const MAX_FOLLOWS = 30, MAX_EVENTS = 40, EVENT_MAX_AGE_MS = 3 * 86_400_000;
  const str = (v, max) => typeof v === 'string' && v.length <= max ? v : '';
  const keyOf = e => e && typeof e === 'object' ? [str(e.owner?.name, 200), str(e.provider?.id, 120), str(e.board?.label, 200), str(e.task?.title, 400)].join('\u001f') : '';
  const TRANSITIONS = Object.freeze({ attention: 'needs input', finished: 'finished', failed: 'failed' });
  const transitionOf = e => e.input ? 'attention' : e.state === 'Ended' ? 'finished' : e.state === 'Turn failed' ? 'failed' : null;
  const empty = () => ({ follows: [], events: [] });
  function parse(raw) {
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return empty();
      const follows = Array.isArray(v.follows) ? [...new Set(v.follows.filter(k => typeof k === 'string' && k.length <= 1000 && k.split('\u001f').length === 4))].slice(0, MAX_FOLLOWS) : [];
      const events = Array.isArray(v.events) ? v.events.filter(x => x && typeof x === 'object' && str(x.key, 1000) && Object.hasOwn(TRANSITIONS, x.transition) && Number.isSafeInteger(x.at) && str(x.title, 400) && str(x.owner, 200))
        .map(x => ({ key: x.key, transition: x.transition, at: x.at, title: x.title, owner: x.owner, seen: x.seen === true })).slice(0, MAX_EVENTS) : [];
      return { follows, events };
    } catch { return empty(); }
  }
  const serialize = s => JSON.stringify({ follows: s.follows.slice(0, MAX_FOLLOWS), events: s.events.slice(0, MAX_EVENTS) });
  const following = (s, e) => s.follows.includes(keyOf(e));
  function toggle(s, e) {
    const k = keyOf(e); if (!k || k === '\u001f\u001f\u001f') return s;
    return { ...s, follows: s.follows.includes(k) ? s.follows.filter(x => x !== k) : [k, ...s.follows].slice(0, MAX_FOLLOWS) };
  }
  // previous/current: arrays of directory entries (already the viewer's permitted
  // set). A transition fires when a followed entry's derived state changes into
  // attention/finished/failed; an entry that leaves the list is treated as
  // finished. Re-observing the same transition never fires again.
  function observe(s, previous, current, now = Date.now()) {
    const before = new Map(previous.map(e => [keyOf(e), e])), after = new Map(current.map(e => [keyOf(e), e]));
    const events = s.events.filter(x => now - x.at < EVENT_MAX_AGE_MS);
    const have = (k, t) => events.some(x => x.key === k && x.transition === t && now - x.at < 60 * 60_000);
    const fresh = [];
    for (const k of s.follows) {
      const prev = before.get(k), next = after.get(k);
      if (!prev) continue;
      const t = next ? transitionOf(next) : 'finished';
      const was = transitionOf(prev);
      if (!t || t === was || have(k, t)) continue;
      const src = next || prev;
      fresh.push({ key: k, transition: t, at: now, title: str(src.task?.title, 400) || 'Shared session', owner: str(src.owner?.name, 200) || 'Teammate', seen: false });
    }
    return { state: { ...s, events: [...fresh, ...events].slice(0, MAX_EVENTS) }, fresh };
  }
  const markSeen = s => ({ ...s, events: s.events.map(x => ({ ...x, seen: true })) });
  const unseen = s => s.events.filter(x => !x.seen);
  const describe = x => `${x.owner}'s "${x.title}" ${TRANSITIONS[x.transition]}`;
  const api = { keyOf, parse, serialize, following, toggle, observe, markSeen, unseen, describe, transitionOf, empty, TRANSITIONS, MAX_FOLLOWS, MAX_EVENTS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformFollow = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
