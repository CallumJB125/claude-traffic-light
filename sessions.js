'use strict';
const content = document.getElementById('content'), status = document.getElementById('status');
const activity = document.getElementById('activity-status');
let generation = 0;
const node = (tag, text, className) => { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; };
const age = value => value == null ? 'Age unknown' : value < 60_000 ? `${Math.floor(value / 1000)}s ago` : value < 3_600_000 ? `${Math.floor(value / 60_000)}m ago` : `${Math.floor(value / 3_600_000)}h ago`;
const usd = v => `$${Math.abs(v).toFixed(2)}`;
const tok = n => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
function burstBlock(section, b) {
  if (b.compaction) {
    const c = b.compaction, net = c.netUsd >= 0 ? `net saving ${usd(c.netUsd)}` : `net cost ${usd(c.netUsd)}`;
    section.append(node('p', `Burst compaction: ${c.compactions} compaction${c.compactions === 1 ? '' : 's'} · saved ${usd(c.savedUsd)} · ${net} (API-equivalent)`, 'muted'));
  }
  if (b.context) {
    const c = b.context;
    section.append(node('p', `Context: ${tok(c.tokens)} tokens${c.pct == null ? '' : ` · ${c.pct}% of the ${tok(c.limit)} compaction limit`}`, 'muted'));
  }
  if (b.coordination?.files?.length) filesBlock(section, b.coordination);
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

// ── Context drawer, coordination files and messages (Burst, or standalone) ────
// Every change goes through main's burst-action, which shows the native consent dialog.
const done = (out, r, ok) => say(out, r?.ok ? ok : r?.cancelled ? 'Cancelled. Nothing was changed.' : r?.error || 'That did not work. Nothing was changed.', r?.ok);
async function act(btn, out, id, args, ok, after) {
  btn.disabled = true;
  try { const r = await api.burstAction(id, args); done(out, r, ok); if (r?.ok && after) after(); }
  catch { done(out, null); }
  finally { btn.disabled = false; }
}
function filesBlock(section, c) {
  const box = node('div', '', 'files'), out = node('p', '', 'result'); out.setAttribute('role', 'status');
  box.append(node('h3', 'Files'));
  const list = node('ul');
  for (const f of c.files) {
    const li = node('li');
    li.append(node('span', f.path, 'path'), node('span', f.master ? (f.others.length ? `Master · also changed by ${f.others.join(', ')}` : 'Master') : `Shared · ${f.masterName || 'another session'} is master`, 'tag'));
    if (f.master) { const b = button('Hand on', () => act(b, out, 'coord-release', { release: f.path }, 'Handed on.')); b.className = 'small'; li.append(b); }
    list.append(li);
  }
  box.append(list);
  if (c.more) box.append(node('p', `And ${c.more} more file${c.more === 1 ? '' : 's'} this session masters.`, 'muted'));
  box.append(out); section.append(box);
}
function contextGroups(host, view, item, reload) {
  const out = node('p', '', 'result'); out.setAttribute('role', 'status');
  for (const g of view.groups) {
    const d = document.createElement('details'), sum = node('summary', `${g.group} · ${tok(g.tokens)} tokens`);
    d.append(sum);
    if (g.items) {
      const list = node('ul');
      for (const it of g.items) {
        const li = node('li', `${it.name} · ${tok(it.tokens)}${it.turn ? ` · prompt ${it.turn}` : ''}${it.removed ? ' · left out' : ''}`);
        if (it.flags?.length) li.append(node('span', it.flags.join('; '), 'tag'));
        if (it.removable && it.id) {
          const b = button(it.removed ? 'Put back' : 'Leave out', () => act(b, out, 'inspect-remove', { session: item.session, id: it.id, engine: view.engine, ...(it.removed ? { restore: true } : {}) }, it.removed ? 'Put back for the next request.' : 'Left out of the next request.', reload));
          b.className = 'small'; li.append(b);
        }
        list.append(li);
      }
      if (g.more) list.append(node('li', `And ${g.more} smaller item${g.more === 1 ? '' : 's'}`, 'muted'));
      d.append(list);
    }
    host.append(d);
  }
  host.append(out);
  return out;
}
async function contextDrawer(section, item) {
  section.querySelector('.row-panel')?.remove();
  const host = node('div', '', 'row-panel context'), body = node('div');
  const close = button('Close', () => { host.remove(); editing = false; });
  host.append(node('h3', 'What’s in context'), body, close);
  editing = true; section.append(host);
  const load = async () => {
    body.replaceChildren(node('p', 'Reading…', 'muted'));
    const c = item.context;
    let view = null, from = null;
    try { const r = await api.burstView('inspect', { session: item.session, engine: c.engine }); if (r?.view) { view = r.view; from = 'burst'; } } catch { view = null; }
    if (!view && c.engine === 'claude') { try { const r = await api.contextBreakdown(item.session); if (r?.view?.groups?.length) { view = r.view; from = 'transcript'; } } catch { view = null; } }
    body.replaceChildren();
    if (!view) return body.append(node('p', c.engine === 'claude' ? 'Nothing to show yet: Burst has no request from this session and its transcript was not found on this computer.' : 'Nothing to show yet: Burst has no request from this session since it started.', 'muted'));
    if (from === 'burst') {
      body.append(node('p', `From Burst: ${tok(view.totalTokens)} tokens${view.estimate ? ' (estimated)' : ''} in this session’s latest request. Names and sizes only.`, 'muted'));
      const out = contextGroups(body, view, item, load);
      if (item.burst?.compaction) {
        const b = button('Send full history again', () => act(b, out, 'compaction-drop', { session: item.session }, 'The next request sends the whole conversation.'));
        body.append(b);
      }
    } else {
      body.append(node('p', `Estimated from this session’s transcript on this computer: ${tok(view.total.tokens)} tokens${view.estimate ? ' (about 4 bytes a token)' : ', scaled to the size Claude last reported'}. Items can be left out only when the session runs through Burst.`, 'muted'));
      contextGroups(body, view, item, load);
    }
  };
  await load();
}
function messagePanel(section, item) {
  section.querySelector('.row-panel')?.remove();
  const host = node('div', '', 'row-panel'), text = document.createElement('textarea'); text.maxLength = 500;
  const out = node('p', '', 'result'); out.setAttribute('role', 'status');
  const close = button('Close', () => { host.remove(); editing = false; });
  const go = button('Send', async () => {
    const t = text.value.trim(); if (!t) return say(out, 'Write a message first.', false);
    if (item.message === 'burst') return act(go, out, 'coord-message', { session: item.session, message: t }, 'Queued. The session sees it at its next tool call or prompt.');
    go.disabled = true;
    try { const r = await api.messageOwned(item.session, t); say(out, r?.ok ? 'Sent.' : r?.error || 'Could not send it.', r?.ok); } catch { say(out, 'Could not send it.', false); } finally { go.disabled = false; }
  });
  host.append(field(item.message === 'burst' ? 'Message (Burst passes it on; up to 500 characters)' : 'Message (up to 500 characters)', text), go, out, close);
  editing = true; section.append(host);
}
function sessionTools(section, item) {
  if (!item.context && !item.message) return;
  const row = node('div', '', 'row-actions');
  if (item.context) row.append(button('What’s in context', () => contextDrawer(section, item)));
  if (item.message) row.append(button('Message', () => messagePanel(section, item)));
  section.append(row);
}
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
  for (const t of snapshot.shared ?? []) content.append(node('p', `${t.sessions} sessions share this working tree: ${t.project}, with ${t.dirty} uncommitted file${t.dirty === 1 ? '' : 's'}. Commit, or give one session its own worktree, before they overwrite each other.`, 'banner'));
  document.getElementById('coord').hidden = !(snapshot.sessions ?? []).some(i => i.burst?.coordination);
  for (const item of snapshot.sessions ?? []) {
    const section = node('section', '', 'session');
    const heading = node('h2', `${item.provider} · ${item.project}`);
    heading.append(node('span', item.freshness === 'recent' ? 'Recent' : item.freshness === 'stale' ? 'Stale' : 'Freshness unknown', 'freshness'));
    const confidence = item.freshness === 'recent' && snapshot.status !== 'unavailable' ? 'Reported' : 'Last reported';
    section.append(heading, node('p', `${confidence}: ${item.status}${item.stuck ? ` (${item.stuck.tool ? `last tool ${item.stuck.tool}, ` : ''}since ${Math.max(1, Math.round(item.stuck.since_ms / 60000))}m)` : ''} · Last seen ${age(item.age_ms).toLowerCase()} · Reported by ${item.provider}`, 'muted'));
    if (item.children?.length) {
      const list = node('ul'); list.setAttribute('aria-label', 'Reported agents');
      for (const child of item.children) list.append(node('li', `${child.label} · ${confidence}: ${child.status}`));
      section.append(list);
    }
    if (item.sharedTree) section.append(node('p', `Shares its working tree with another live session (${item.sharedTree})`, 'warn'));
    if (item.burst) burstBlock(section, item.burst);
    if (item.handover) handoverRow(section, item.handover);
    sessionTools(section, item);
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
    : `Updated ${new Date(snapshot.observed_at).toLocaleTimeString()}. Refreshes every 5 seconds while this page is visible.${snapshot.omitted ? ` ${snapshot.omitted} additional reports exceed the display limit.` : ''}`;
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
const COORD_LABELS = { shared: 'shared', refused: 'refused', held: 'held for a commit', stopped: 'stopped with uncommitted files', errors: 'hook errors' };
async function loadCoordination() {
  const host = document.getElementById('coord-body'), days = Number(document.getElementById('coord-days').value) || 1;
  host.replaceChildren(node('p', 'Reading…', 'muted'));
  let c = null;
  try { const r = await api.burstView('coordination', { days }); c = r?.view ?? null; } catch { c = null; }
  host.replaceChildren();
  const m = c?.metrics;
  if (!m) return host.append(node('p', 'Burst is not answering with coordination figures.', 'muted'));
  host.append(node('p', Object.entries(COORD_LABELS).map(([k, label]) => `${m.totals[k] ?? 0} ${label}`).join(' · '), 'muted'));
  const open = m.issues.filter(i => !i.resolved);
  host.append(node('p', open.length ? `${m.unresolved || open.length} unresolved` : 'No unresolved issues.', open.length ? 'warn' : 'muted'));
  if (!open.length) return;
  const list = node('ul');
  for (const i of open.slice(0, 10)) list.append(node('li', `${i.at} · ${i.kind === 'stopped' ? 'Stopped with uncommitted files' : 'Hook error'}${i.pending.length ? `: ${i.pending.join(', ')}` : i.text ? `: ${i.text}` : ''}`));
  host.append(list);
}
document.getElementById('coord').addEventListener('toggle', e => { if (e.currentTarget.open) void loadCoordination(); });
document.getElementById('coord-days').addEventListener('change', () => { void loadCoordination(); });
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
