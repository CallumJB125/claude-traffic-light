'use strict';
const content = document.getElementById('content'), status = document.getElementById('status');
let generation = 0;
const node = (tag, text, className) => { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; };
const age = value => value == null ? 'freshness unknown' : value < 60000 ? `${Math.floor(value / 1000)}s ago` : `${Math.floor(value / 60000)}m ago`;
function row(item, description) {
  const el = node('li');
  const open = node('button', `${item.key ?? item.name} · ${item.title ?? item.state ?? ''}`, 'work-link');
  open.type = 'button'; open.addEventListener('click', async () => { open.disabled = true; try { if (!await window.myDayApi.open(item.handle)) status.textContent = 'This item changed or is unavailable. Refresh your work.'; } finally { open.disabled = false; } });
  el.append(open, node('p', description, 'muted')); return el;
}
function section(title, entries, empty) {
  const el = node('section'); el.append(node('h2', title));
  if (entries.length) { const list = node('ul'); list.append(...entries); el.append(list); } else el.append(node('p', empty, 'muted'));
  return el;
}
function render(snapshot) {
  content.replaceChildren();
  const cards = [], decisions = [], agents = [];
  for (const source of snapshot.sources ?? []) {
    if (source.status !== 'complete') content.append(node('p', `${source.name}: ${source.status === 'partial' ? 'Some work was omitted by the display limit.' : 'Current work is unavailable. Check your connection and sign-in.'}`, 'source-note'));
    for (const item of source.cards ?? []) cards.push(row(item, `${item.team} · ${item.board} · ${item.state}${item.due_date ? ` · Due ${item.due_date}` : ' · No due date'}${item.start_date ? ` · Starts ${item.start_date}` : ''}`));
    for (const item of source.decisions ?? []) decisions.push(row(item, `${item.kind} · ${item.summary} · ${item.board}`));
    for (const item of source.agents ?? []) agents.push(row(item, `${item.name} · ${item.live ? 'Verified live at observation' : 'Live activity unverified'} · heartbeat ${age(item.observed)} at observation`));
  }
  for (const item of snapshot.reported ?? []) {
    const el = node('li'); el.append(node('strong', `${item.name} · ${item.label}`), node('p', `Reported ${item.signal || 'activity'} · ${item.freshness} · ${age(item.age_ms)}. This report does not verify completion.`, 'muted')); agents.push(el);
  }
  content.append(section('Waiting on you', decisions, 'No current requests you can answer in the available boards.'), section('Your cards', cards, 'No own cards in the available boards.'), section('Your agents', agents, 'No own runs or reported local agents observed.'));
  const a = snapshot.availability;
  if (a?.state === 'busy' || a?.state === 'free') content.append(node('p', a.state === 'busy' ? 'You are busy right now.' : 'You are free right now.', 'muted'));
  if (a?.can_enable) {
    const ask = node('p', 'My day can tell when you are in a meeting. It reads busy or free only, never event details. ', 'muted'), button = node('button', 'Show my meetings');
    button.type = 'button';
    button.addEventListener('click', async () => { button.disabled = true; try { await window.myDayApi.showMeetings(); } finally { refresh(); } });
    ask.append(button); content.append(ask);
  }
  status.textContent = snapshot.status === 'complete' ? `Observed ${new Date(snapshot.observed_at).toLocaleTimeString()}. Refreshes every 15 seconds.` : snapshot.status === 'changed' ? 'The current account or board context changed. Refreshing…' : 'Some sources are unavailable or exceed the display limit. The work shown is current.';
}
async function refresh({ clear = false } = {}) {
  const request = ++generation;
  if (clear) { content.replaceChildren(); status.textContent = 'Checking your current work…'; }
  try { const snapshot = await window.myDayApi.state(); if (request === generation && snapshot) render(snapshot); }
  catch { if (request === generation) { content.replaceChildren(); status.textContent = 'Current work is unavailable. Try Refresh.'; } }
}
document.getElementById('refresh').addEventListener('click', () => refresh({ clear: true }));
window.myDayApi.changed(() => refresh({ clear: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh({ clear: true }); });
setInterval(() => { if (!document.hidden) void refresh({ clear: true }); }, 15000);
void refresh();
