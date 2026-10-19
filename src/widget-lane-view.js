// The widget's notification lane: the last few things that happened (needs
// you, finished, stuck, a teammate collision, CI failed, a teammate asking),
// each fading out after a few seconds. Pure: no Electron, no DOM. Plain script
// for the widget (window.WidgetLaneView) and CommonJS for Node and main.
// Event text comes from session names, repos and teammates, so the renderer
// only ever puts it in textContent.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WidgetLaneView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const KINDS = Object.freeze(['needs-you', 'finished', 'stuck', 'collision', 'ci-failed', 'teammate', 'deployed']);
  const MAX = 3;
  const TTL_MS = 8000;
  // The last stretch of a row's life, when the CSS fade runs.
  const FADE_MS = 1500;
  const TEXT_MAX = 90;

  const clip = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX) : '');
  const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  // A well-formed event or null. `id` is main's own counter; `sessionId` is
  // the dedupe handle (one live row per session and kind).
  function normalize(ev, now) {
    if (!ev || typeof ev !== 'object' || !KINDS.includes(ev.kind)) return null;
    const text = clip(ev.text);
    if (!text) return null;
    const at = finite(ev.at) ?? now;
    return {
      id: typeof ev.id === 'string' || Number.isSafeInteger(ev.id) ? String(ev.id) : `${ev.kind}:${at}`,
      kind: ev.kind,
      sessionId: typeof ev.sessionId === 'string' && ev.sessionId ? ev.sessionId.slice(0, 200) : null,
      inputId: typeof ev.inputId === 'string' && ev.inputId ? ev.inputId.slice(0, 200) : null,
      text,
      at,
    };
  }

  // Live events only: a row is gone once its ttl has passed.
  function expire(list, now, ttlMs = TTL_MS) {
    return (Array.isArray(list) ? list : []).filter((e) => e && finite(e.at) !== null && now - e.at < ttlMs);
  }

  // → a new list with `ev` added: the same (kind, sessionId) replaces the
  // older row, the list never grows past `max` (oldest drops), newest last.
  function pushEvent(list, ev, now, { max = MAX, ttlMs = TTL_MS } = {}) {
    const e = normalize(ev, now);
    const live = expire(list, now, ttlMs);
    if (!e) return live;
    const same = (x) => x.kind === e.kind && (e.sessionId ? x.sessionId === e.sessionId : x.id === e.id || x.text === e.text);
    const out = live.filter((x) => !same(x));
    out.push(e);
    return out.slice(Math.max(0, out.length - max));
  }

  // The rows to draw, newest first: {id, kind, text, age, fading, sessionId, inputId}.
  function laneModel(list, { now, max = MAX, ttlMs = TTL_MS, fadeMs = FADE_MS } = {}) {
    const t = finite(now) ?? Date.now();
    return expire(list, t, ttlMs)
      .slice()
      .sort((a, b) => b.at - a.at)
      .slice(0, max)
      .map((e) => {
        const age = Math.max(0, t - e.at);
        return { id: e.id, kind: e.kind, text: e.text, age, fading: age >= ttlMs - fadeMs, sessionId: e.sessionId || null, inputId: e.inputId || null };
      });
  }

  // How long until the model next changes (a row starts fading or leaves), or null when empty.
  function nextChangeMs(list, { now, ttlMs = TTL_MS, fadeMs = FADE_MS } = {}) {
    const t = finite(now) ?? Date.now();
    let best = null;
    for (const e of expire(list, t, ttlMs)) {
      const age = t - e.at;
      const next = age < ttlMs - fadeMs ? ttlMs - fadeMs - age : ttlMs - age;
      if (best === null || next < best) best = next;
    }
    return best === null ? null : Math.max(16, best);
  }

  return { KINDS, MAX, TTL_MS, FADE_MS, TEXT_MAX, normalize, expire, pushEvent, laneModel, nextChangeMs };
});
