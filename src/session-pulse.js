'use strict';
// One present-tense line for a shared session card ("Editing files in app · 40s ago")
// and a four-step freshness: fresh, idle, stale, offline. Pure; reads only the
// directory entry the page already holds, never a provider transcript.
(function (root) {
  const FRESH_MS = 90_000;
  const STALE_MS = 10 * 60_000;
  const PHASE = Object.freeze({ Thinking: 'Thinking', 'Running a command': 'Running a command', 'Editing files': 'Editing files', 'Reading files': 'Reading files', Searching: 'Searching', 'Using a tool': 'Using a tool', 'Coordinating agents': 'Coordinating agents' });
  const STATE = Object.freeze({ Working: 'Working', Waiting: 'Waiting for a reply', 'Needs input': 'Waiting for someone to answer', 'Waiting on you': 'Waiting for someone to answer', Idle: 'Idle', Ended: 'Ended', Compacting: 'Compacting context', 'Turn stopped': 'Turn stopped', 'Turn failed': 'Last turn failed', 'Limit reached': 'Usage limit reached', 'Stuck?': 'Silent for a while' });
  const REASON = Object.freeze({
    stale: 'No report from this session for over ten minutes. Requests wait until it reports again.',
    offline: 'This session is not reporting. It ended, or its connection is gone.',
  });
  const ago = ms => ms === null ? 'time unknown' : ms < 60_000 ? `${Math.max(1, Math.floor(ms / 1000))}s ago` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m ago` : `${Math.floor(ms / 3_600_000)}h ago`;
  const text = (v, max) => typeof v === 'string' && v ? v.slice(0, max) : '';
  // entry: a directory entry; now and observedAt (when the snapshot was taken) let a
  // card age in place between refreshes.
  function pulse(entry, now = Date.now(), observedAt = now) {
    const e = entry && typeof entry === 'object' ? entry : {};
    const drift = Math.max(0, now - (Number.isFinite(observedAt) ? observedAt : now));
    const age = Number.isFinite(e.ageMs) && e.ageMs >= 0 ? e.ageMs + drift : null;
    const ended = e.state === 'Ended';
    const freshness = ended || age === null || e.freshness === 'unknown' ? 'offline' : age <= FRESH_MS ? 'fresh' : age < STALE_MS ? 'idle' : 'stale';
    const a = e.activity && typeof e.activity === 'object' ? e.activity : null;
    const label = a && Object.hasOwn(PHASE, a.label) ? PHASE[a.label] : '';
    const working = e.state === 'Working' && freshness === 'fresh';
    const kids = Array.isArray(e.children) ? e.children.filter(c => c && c.state === 'Working').length : 0;
    const where = text(e.project || e.board?.label, 60);
    let line;
    if (freshness === 'offline') line = ended ? 'Ended' : 'Not reporting';
    else if (working && label) line = `${label}${where ? ` in ${where}` : ''}${kids ? ` · ${kids} agent${kids === 1 ? '' : 's'} working` : ''}`;
    else if (working) line = `Working${where ? ` on ${where}` : ''}${kids ? ` · ${kids} agent${kids === 1 ? '' : 's'}` : ''}`;
    else line = STATE[e.state] || text(e.state, 40) || 'Status unknown';
    return { line: `${line} · ${ago(age)}`, freshness, ageMs: age, canRequest: freshness === 'fresh' || freshness === 'idle', reason: REASON[freshness] || '' };
  }
  const api = { pulse, FRESH_MS, STALE_MS, REASON };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformPulse = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
