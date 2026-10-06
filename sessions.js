'use strict';
const content = document.getElementById('content'), status = document.getElementById('status');
const activity = document.getElementById('activity-status');
let generation = 0;
const node = (tag, text, className) => { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; };
const age = value => value == null ? 'Age unknown' : value < 60_000 ? `${Math.floor(value / 1000)}s ago` : value < 3_600_000 ? `${Math.floor(value / 60_000)}m ago` : `${Math.floor(value / 3_600_000)}h ago`;
const usd = v => `$${Math.abs(v).toFixed(2)}`;
function burstBlock(section, b) {
  if (b.compaction) {
    const c = b.compaction, net = c.netUsd >= 0 ? `net saving ${usd(c.netUsd)}` : `net cost ${usd(c.netUsd)}`;
    section.append(node('p', `Burst compaction: ${c.compactions} compaction${c.compactions === 1 ? '' : 's'} · saved ${usd(c.savedUsd)} · ${net} (API-equivalent)`, 'muted'));
  }
  if (!b.handover) return;
  const h = b.handover, box = node('div', '', 'handover');
  box.append(node('h3', `Handover (${h.source}${h.date ? `, ${h.date}` : ''})`), node('pre', h.text));
  const label = node('label'), check = document.createElement('input');
  check.type = 'checkbox'; check.checked = h.shared;
  check.addEventListener('change', async () => { check.disabled = true; try { await window.sessionsApi.burstShare(h.repo, check.checked); } finally { check.disabled = false; } });
  label.append(check, document.createTextNode(' Share Burst handover with team (this repository; scrubbed, off by default)'));
  box.append(label); section.append(box);
}
function render(snapshot) {
  content.replaceChildren();
  const a = snapshot.activity;
  activity.textContent = a?.observed ? `A Codex lifecycle event was received ${age(a.latest_age_ms).toLowerCase()}.`
    : a?.configured === true ? 'Hooks are configured. No local lifecycle event is visible yet. Review the Plexiform hooks through Codex /hooks, then start a fresh turn.'
      : a?.configured === false ? 'Codex activity is not configured for this copy of Plexiform. Open Activity settings to configure it, then review the hooks in Codex.'
        : 'Codex hook configuration is unavailable. Check Activity settings.';
  for (const item of snapshot.sessions ?? []) {
    const section = node('section', '', 'session');
    const heading = node('h2', `${item.provider} · ${item.project}`);
    heading.append(node('span', item.freshness === 'recent' ? 'Recent' : item.freshness === 'stale' ? 'Stale' : 'Freshness unknown', 'freshness'));
    const confidence = item.freshness === 'recent' && snapshot.status !== 'unavailable' ? 'Reported' : 'Last reported';
    section.append(heading, node('p', `${confidence}: ${item.status}${item.stuck ? ` (${item.stuck.tool ? `last tool ${item.stuck.tool}, ` : ''}since ${Math.max(1, Math.round(item.stuck.since_ms / 60000))}m)` : ''} · Last seen ${age(item.age_ms).toLowerCase()} · ${item.lifecycle ? 'Lifecycle report' : 'Local report'}`, 'muted'));
    if (item.children?.length) {
      const list = node('ul'); list.setAttribute('aria-label', 'Reported agents');
      for (const child of item.children) list.append(node('li', `${child.label} · ${confidence}: ${child.status}`));
      section.append(list);
    }
    if (item.burst) burstBlock(section, item.burst);
    content.append(section);
  }
  if (!snapshot.sessions?.length) content.append(node('p', snapshot.status === 'unavailable' ? 'Local session reports are unavailable. Try Refresh.' : 'No local sessions are visible. Start activity in a connected tool, then Refresh.', 'muted'));
  status.textContent = snapshot.status === 'unavailable' ? 'Local activity is unavailable. Try Refresh.'
    : `Observed ${new Date(snapshot.observed_at).toLocaleTimeString()}. Refreshes every 5 seconds while this page is visible.${snapshot.omitted ? ` ${snapshot.omitted} additional reports exceed the display limit.` : ''}`;
}
async function refresh({ clear = false } = {}) {
  const request = ++generation;
  if (clear) { content.replaceChildren(); status.textContent = 'Checking local sessions…'; activity.textContent = 'Checking local activity…'; }
  try {
    let timer;
    const snapshot = await Promise.race([window.sessionsApi.state(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('unavailable')), 4500);
    })]).finally(() => clearTimeout(timer));
    if (request !== generation || document.hidden) return;
    if (!snapshot) throw new Error('unavailable');
    render(snapshot);
  } catch {
    if (request === generation && !document.hidden) { content.replaceChildren(); activity.textContent = 'Codex activity is unavailable. Check Activity settings.'; status.textContent = 'Local activity is unavailable. Try Refresh.'; }
  }
}
document.getElementById('refresh').addEventListener('click', () => refresh({ clear: true }));
document.getElementById('settings').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  try { if (!await window.sessionsApi.settings()) status.textContent = 'Activity settings are unavailable. Try again from Preferences.'; }
  catch { status.textContent = 'Activity settings are unavailable. Try again from Preferences.'; }
  finally { document.getElementById('settings').disabled = false; }
});
document.addEventListener('visibilitychange', () => {
  // A hidden page must not retain a status that appears current on return.
  ++generation; content.replaceChildren(); status.textContent = 'Checking local sessions…'; activity.textContent = 'Checking local activity…';
  if (!document.hidden) void refresh();
});
setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
if (!document.hidden) void refresh();
