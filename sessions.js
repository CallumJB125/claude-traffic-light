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
// Local handover document (src/session-handover.js): age and actions, or the reason there is none.
function handoverRow(section, h) {
  const row = node('p', '', 'handover-row');
  row.append(document.createTextNode(`${h.updated}${h.note ? ` (${h.note})` : ''}`));
  if (h.ready) {
    for (const [label, action] of [['View', 'view'], ['Copy path', 'copy-path'], ['Copy as prompt', 'copy-prompt']]) {
      const b = node('button', label, 'link'); b.type = 'button';
      b.addEventListener('click', async () => { b.disabled = true; try { const ok = await window.sessionsApi.handover(action, h.key); b.textContent = ok ? (action === 'view' ? 'Opened' : 'Copied') : 'Unavailable'; } catch { b.textContent = 'Unavailable'; } setTimeout(() => { b.textContent = label; b.disabled = false; }, 1500); });
      row.append(document.createTextNode(' · '), b);
    }
  }
  section.append(row);
}

// ── Add sessions panel and per-row actions (src/session-actions.js) ──────────
const api = window.sessionsApi;
let setupData = null, editing = false, addTouched = false;
const field = (text, control) => { const l = node('label', text); l.append(control); return l; };
const select = (options, empty) => { const s = document.createElement('select'); if (!options.length) s.append(new Option(empty, '')); for (const o of options) { const op = new Option(o.label, o.value); op.disabled = !!o.disabled; s.append(op); } return s; };
const say = (el, text, ok) => { el.textContent = text; el.className = 'result'; el.dataset.ok = ok ? '1' : '0'; };
const button = (label, onClick) => { const b = node('button', label); b.type = 'button'; b.addEventListener('click', onClick); return b; };
async function loadSetup(force) {
  if (setupData && !force) return setupData;
  try { setupData = await api.setup(); } catch { setupData = null; }
  return setupData ?? { boards: [], repos: [], ais: [], scopeRule: '', sessionCount: 0 };
}
const repoOptions = d => d.repos.map(r => ({ value: r.handle, label: `${r.label}${r.remote ? '' : ' (no git remote)'}` }));
// Folder chooser: a select of repos seen in sessions plus "Choose a folder…". Returns { el, value() }.
function folderPicker(d, preset) {
  const opts = repoOptions(d);
  if (preset && !opts.some(o => o.value === preset.folder)) opts.unshift({ value: preset.folder, label: preset.label });
  const sel = select(opts, 'No repos seen yet'), pick = button('Choose a folder…', async () => { const f = await api.pickFolder(); if (f?.handle) { sel.querySelector('option[value=""]')?.remove(); sel.append(new Option(`${f.label}${f.remote ? '' : ' (no git remote)'}`, f.handle)); sel.value = f.handle; } });
  if (preset) sel.value = preset.folder;
  const wrap = node('div'); wrap.append(field('Repo', sel), pick);
  return { el: wrap, value: () => sel.value };
}
function linkPanel(host, preset, onDone) {
  loadSetup(true).then(d => {
    host.replaceChildren();
    const fp = folderPicker(d, preset), board = select(d.boards.map(b => ({ value: b.key, label: b.label })), 'No boards available');
    const out = node('p', '', 'result'); out.setAttribute('role', 'status');
    const go = button('Link repo', async () => {
      if (!fp.value() || !board.value) return say(out, 'Choose a repo and a board.', false);
      go.disabled = true; try { const r = await api.linkRepo(fp.value(), board.value); say(out, r?.text ?? 'Could not link.', r?.ok); if (r?.ok && onDone) onDone(); } finally { go.disabled = false; }
    });
    host.append(fp.el, field('Board', board), node('p', d.scopeRule, 'muted'), go, out);
  });
}
function startPanel(host) {
  loadSetup(true).then(d => {
    host.replaceChildren();
    const fp = folderPicker(d), ai = select(d.ais.map(a => ({ value: a.id, label: `${a.label}${a.note ? ` (${a.note})` : ''}`, disabled: !a.ready })), 'No AI detected yet. Connect a tool first.');
    const first = ai.querySelector('option:not(:disabled)'); if (first) ai.value = first.value;
    const prompt = document.createElement('textarea'); prompt.maxLength = 8000;
    const out = node('p', '', 'result'); out.setAttribute('role', 'status');
    const go = button('Start', async () => {
      if (!fp.value() || !ai.value) return say(out, 'Choose a repo and an AI.', false);
      go.disabled = true; try { const r = await api.start(fp.value(), ai.value, prompt.value); say(out, r?.text ?? 'Could not start.', r?.ok); } finally { go.disabled = false; }
    });
    host.append(fp.el, field('AI', ai), field('First prompt (optional; without one the command is copied instead)', prompt), go, out);
  });
}
function rowPanel(section, kind, item) {
  section.querySelector('.row-panel')?.remove();
  const a = item.actions, host = node('div', '', 'row-panel');
  const close = button('Close', () => { host.remove(); editing = false; });
  const out = node('p', '', 'result'); out.setAttribute('role', 'status');
  editing = true; section.append(host);
  if (kind === 'link') {
    api.linkFromSession(a.handle).then(pre => { linkPanel(host, pre, null); host.append(close); });
    return;
  }
  loadSetup(true).then(d => {
    if (kind === 'card') {
      const board = select(d.boards.map(b => ({ value: b.key, label: b.label })), 'No boards available');
      const go = button('Make card', async () => { if (!board.value) return; go.disabled = true; try { const r = await api.makeCard(a.handle, board.value); say(out, r?.text ?? 'Could not make the card.', r?.ok); } finally { go.disabled = false; } });
      host.append(field('Board for the card', board), go, out, close);
    } else {
      const q = document.createElement('input'); q.type = 'search'; const list = node('ul', '', 'found');
      const search = button('Search', async () => {
        list.replaceChildren(); say(out, 'Searching…', true);
        const found = await api.searchCards(q.value);
        say(out, found?.length ? 'Choose the card.' : 'No cards found.', !!found?.length);
        for (const c of found ?? []) { const li = node('li'); li.append(button(`${c.card_key} ${c.title} (${c.board})`, async () => { const r = await api.attach(a.handle, c.ref); say(out, r?.text ?? 'Could not attach.', r?.ok); })); list.append(li); }
      });
      q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search.click(); } });
      host.append(field('Search cards by title or key', q), search, list, out, close);
    }
  });
}
function rowActions(section, item) {
  const a = item.actions; if (!a) return;
  if (a.card) section.append(node('p', a.card.how === 'attached' ? `Attached to ${a.card.label} (saved on this computer only)` : 'A board card was made from this session', 'card-line'));
  const row = node('div', '', 'row-actions');
  row.append(button('Make a card', () => rowPanel(section, 'card', item)), button('Attach to card…', () => rowPanel(section, 'attach', item)), button('Link repo to board', () => rowPanel(section, 'link', item)));
  if (a.share) {
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = a.share.on;
    check.addEventListener('change', async () => { check.disabled = true; try { await api.share(a.handle, check.checked); } finally { check.disabled = false; } });
    const label = node('label'); label.append(check, document.createTextNode(' Share handover with team (this repo; scrubbed, off by default)')); row.append(label);
  }
  section.append(row);
}
function openRoute(which) {
  const add = document.getElementById('add'); add.open = true; addTouched = true;
  if (which === 'connect') return document.getElementById('add-connect').click();
  const panel = document.getElementById(which === 'link' ? 'panel-link' : 'panel-start');
  if (panel.hidden) document.getElementById(which === 'link' ? 'add-link' : 'add-start').click();
  add.scrollIntoView?.({ block: 'start' });
}
function emptyState() {
  const box = node('div', '', 'how');
  box.append(node('h2', 'How sessions get in'), node('p', 'Connect the tool → sessions appear here and on your widget → link the repo to share with your team → make a card to track it.'));
  const row = node('div', '', 'row-actions');
  row.append(button('Connect a tool', () => openRoute('connect')), button('Link a repo to a board', () => openRoute('link')), button('Start a session here', () => openRoute('start')));
  box.append(row); return box;
}
function togglePanel(id, fill) {
  const host = document.getElementById(id); host.hidden = !host.hidden;
  if (!host.hidden) fill(host);
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
    if (item.handover) handoverRow(section, item.handover);
    rowActions(section, item);
    content.append(section);
  }
  if (!snapshot.sessions?.length) {
    content.append(node('p', snapshot.status === 'unavailable' ? 'Local session reports are unavailable. Try Refresh.' : 'No local sessions are visible yet.', 'muted'));
    if (snapshot.status !== 'unavailable') content.append(emptyState());
  }
  // The Add sessions panel stays open while there is nothing to show and folds once sessions exist, unless the person chose.
  if (!addTouched) document.getElementById('add').open = !snapshot.sessions?.length;
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
    if (editing) return; // an open row panel would be wiped by a redraw
    render(snapshot);
  } catch {
    if (request === generation && !document.hidden) { content.replaceChildren(); activity.textContent = 'Codex activity is unavailable. Check Activity settings.'; status.textContent = 'Local activity is unavailable. Try Refresh.'; }
  }
}
document.getElementById('refresh').addEventListener('click', () => { editing = false; refresh({ clear: true }); });
document.getElementById('add').addEventListener('toggle', () => { addTouched = true; });
document.getElementById('add-connect').addEventListener('click', async () => {
  const out = document.getElementById('connect-status');
  try { const r = await api.connect(); say(out, r?.ok ? 'Opened. Connect the tool there, then come back and Refresh.' : 'Could not open it. Try again.', r?.ok); } catch { say(out, 'Could not open it. Try again.', false); }
});
document.getElementById('add-link').addEventListener('click', () => togglePanel('panel-link', host => linkPanel(host, null, null)));
document.getElementById('add-start').addEventListener('click', () => togglePanel('panel-start', startPanel));
document.getElementById('settings').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  try { if (!await window.sessionsApi.settings()) status.textContent = 'Activity settings are unavailable. Try again from Preferences.'; }
  catch { status.textContent = 'Activity settings are unavailable. Try again from Preferences.'; }
  finally { document.getElementById('settings').disabled = false; }
});
document.addEventListener('visibilitychange', () => {
  // A hidden page must not retain a status that appears current on return.
  editing = false; ++generation; content.replaceChildren(); status.textContent = 'Checking local sessions…'; activity.textContent = 'Checking local activity…';
  if (!document.hidden) void refresh();
});
setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
if (!document.hidden) void refresh();
