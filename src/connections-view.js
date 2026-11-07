// The AI tools page's Connections panel: one row per tool from McpAuto's registry caps()
// (src/enrol/registry.js), worded for a person. Pure; aitools.html loads it as window.ConnectionsView.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConnectionsView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Only these states are something Fix (the bus sync) can put right; the rest need the person or another app.
  const FIXABLE = new Set(['missing', 'stale', 'mismatch']);
  const BLOCKED = new Set(['conflict', 'other-channel', 'error', 'untrusted']);
  const TIER = {
    local_attested: 'Verified sessions: see peers, send notes, hand off work',
    person: 'Verified sessions: see peers, send notes, hand off work',
    unverified_client: 'Read-only: sees peers and adds personal cards; cannot hand off work',
    headless: 'Read-only: sees peers',
  };

  // caps row → { id, label, state, status, detail, tier, hooks, fix, file, restart }
  //   state: connected | fix | blocked | off | missing
  function row(c) {
    if (!c || typeof c.id !== 'string') return null;
    const label = typeof c.label === 'string' && c.label ? c.label : c.id;
    const base = { id: c.id, label, file: c.file || null, restart: c.restart || null, tier: TIER[c.tier] || null,
      hooks: c.hooks === 'connected' ? 'Status lights on' : c.hooks === 'not-connected' ? 'Status lights off' : null };
    if (!c.installed || c.mcp === 'not-installed') return { ...base, state: 'missing', status: 'Not installed', detail: 'Not installed here.', fix: false, tier: null, hooks: null };
    if (c.mcp === 'ours') return { ...base, state: 'connected', status: 'Connected', detail: c.reason || 'Connected to Plexiform.', fix: false };
    if (c.mcp === 'off') return { ...base, state: 'off', status: 'Agent bus off', detail: c.reason || 'The agent bus is turned off in Preferences.', fix: false };
    if (FIXABLE.has(c.mcp)) return { ...base, state: 'fix', status: c.mcp === 'missing' ? 'Not connected' : 'Out of date', detail: c.reason || 'Press Fix to connect it.', fix: true };
    if (BLOCKED.has(c.mcp)) return { ...base, state: 'blocked', status: 'Needs you', detail: c.reason || 'Plexiform left its config alone.', fix: false };
    return { ...base, state: 'blocked', status: 'Unknown', detail: c.reason || 'Plexiform could not tell.', fix: false };
  }

  const ORDER = { fix: 0, blocked: 1, off: 2, connected: 3, missing: 4 };
  function rows(caps) {
    const out = (Array.isArray(caps) ? caps : []).map(row).filter(Boolean);
    return out.sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  }

  // One line for the panel head: "3 connected · 1 needs a fix".
  function summary(list) {
    const n = (s) => list.filter((r) => r.state === s).length;
    const parts = [];
    if (n('connected')) parts.push(`${n('connected')} connected`);
    if (n('fix')) parts.push(`${n('fix')} ${n('fix') === 1 ? 'needs' : 'need'} a fix`);
    if (n('blocked')) parts.push(`${n('blocked')} ${n('blocked') === 1 ? 'needs' : 'need'} you`);
    if (n('off')) parts.push('agent bus off');
    return parts.length ? parts.join(' · ') : 'No AI tools found yet.';
  }

  return { row, rows, summary, FIXABLE };
});
