
'use strict';
const Overview = require('./session-overview');
const STATES = Object.freeze({ 'Working': 'working', 'Waiting on you': 'needs input', 'Ready': 'ready', 'Turn stopped': 'turn stopped', 'Idle': 'idle', 'Turn failed': 'turn failed', 'Limit reached': 'limit reached', 'Ended': 'ended', 'Unknown': 'unknown' });
const PRIORITY = ['needs input', 'limit reached', 'turn failed', 'working', 'ready', 'turn stopped', 'idle', 'ended', 'unknown', 'stale'];
// Only trusted app-owned local metadata enters this pure projection. Fixed
// labels and aggregate counts leave it; no raw source, IDs, paths or chat text.
function snapshot({ sessions = [], online = true, available = true, now = Date.now() } = {}) {
  const observed = Overview.snapshot({ sessions, available, now });
  if (observed.status === 'unavailable') return { headline: 'AI activity unavailable', detail: 'Local activity could not be read.', providers: [], omitted: observed.omitted };
  const by = new Map();
  for (const row of observed.sessions) {
    const provider = row.provider === 'Claude Code' ? 'Claude' : row.provider;
    const state = row.freshness === 'stale' ? 'stale' : row.freshness === 'unknown' ? 'unknown' : STATES[row.status];
    let entry = by.get(provider);
    if (!entry) { entry = { provider, state, sessions: 0, recent: 0, stale: 0, unknown: 0, working_agents: 0 }; by.set(provider, entry); }
    entry.sessions++; entry[row.freshness]++;
    if (row.freshness === 'recent' && row.lifecycle && row.status === 'Working') entry.working_agents += row.children.filter(child => child.status === 'Working').length;
    if (PRIORITY.indexOf(state) < PRIORITY.indexOf(entry.state)) entry.state = state;
  }
  const providers = [...by.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  let headline = providers.length ? providers.map(p => `${p.provider}: ${p.state}`).join(' · ') : 'No local AI activity reported';
  if (online === false) headline = providers.length ? `Offline — ${providers.map(p => p.provider).join(', ')} last reported` : 'Offline — no local AI activity reported';
  const detail = 'Status comes from local activity reports, not a check that work succeeded. Reports older than 90 seconds are stale; missing report times are unknown.';
  return { headline, detail, providers, omitted: observed.omitted };
}
module.exports = { snapshot };
