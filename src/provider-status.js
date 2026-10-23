
'use strict';
const Overview = require('./session-overview');
const Organise = require('./work-organise');
// A provider's state is the most urgent bucket among its sessions, named with the bucket
// heading; a stale or unreported session counts as Idle (work-organise.js). Urgency is not
// the display order of the buckets: a failed or limited session outranks one still working.
const PRIORITY = ['needs', 'stuck', 'working', 'check', 'idle'];
// Only trusted app-owned local metadata enters this pure projection. Fixed
// labels and aggregate counts leave it; no raw source, IDs, paths or chat text.
function snapshot({ sessions = [], online = true, available = true, now = Date.now() } = {}) {
  const observed = Overview.snapshot({ sessions, available, now });
  if (observed.status === 'unavailable') return { headline: 'AI activity unavailable', detail: 'Local activity could not be read.', providers: [], omitted: observed.omitted, available: false, online: online !== false, latest_age_ms: null };
  const by = new Map();
  for (const row of observed.sessions) {
    const provider = row.provider === 'Claude Code' ? 'Claude' : row.provider;
    const bucket = row.freshness === 'recent' ? row.bucket : 'idle';
    let entry = by.get(provider);
    if (!entry) { entry = { provider, bucket, state: Organise.headingOf(bucket), sessions: 0, recent: 0, stale: 0, unknown: 0, working_agents: 0 }; by.set(provider, entry); }
    entry.sessions++; entry[row.freshness]++;
    if (row.freshness === 'recent' && row.lifecycle && row.bucket === 'working') entry.working_agents += row.children.filter(child => Organise.bucketOf(child.status) === 'working').length;
    if (PRIORITY.indexOf(bucket) < PRIORITY.indexOf(entry.bucket)) Object.assign(entry, { bucket, state: Organise.headingOf(bucket) });
  }
  const providers = [...by.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  let headline = providers.length ? providers.map(p => `${p.provider}: ${p.state}`).join(' · ') : 'No local AI activity reported';
  if (online === false) headline = providers.length ? `Offline — ${providers.map(p => p.provider).join(', ')} last reported` : 'Offline — no local AI activity reported';
  const detail = 'Status comes from local activity reports, not a check that work succeeded. Reports older than 90 seconds are stale; missing report times are unknown.';
  const ages = observed.sessions.map(row => row.age_ms).filter(age => Number.isFinite(age) && age >= 0);
  return { headline, detail, providers, omitted: observed.omitted, available: true, online: online !== false, latest_age_ms: ages.length ? Math.min(...ages) : null };
}
module.exports = { snapshot };
