'use strict';
const content = document.getElementById('content'), status = document.getElementById('status');
const activity = document.getElementById('activity-status');
let generation = 0;
let selectedSessionKey = null, selectionPending = false;
function selectSession(key) { if (typeof key !== 'string' || !/^[\w.-]{1,200}$/.test(key)) return; selectedSessionKey = key; selectionPending = true; for (const id of ['session-search', 'session-provider', 'session-freshness']) { const control = document.getElementById(id); if (control) control.value = ''; } applyLocalFilters(); void refresh(); }
let selectionEventSeen = false;
window.sessionsApi.onSelection?.(key => { selectionEventSeen = true; selectSession(key); });
window.sessionsApi.selection?.().then(key => { if (!selectionEventSeen) selectSession(key); }).catch(() => {});
function focusSelectedSession() {
  const rows = [...content.querySelectorAll('[data-session-key]')], selected = rows.find(r => r.dataset.sessionKey === selectedSessionKey);
  if (!selected) { status.textContent = 'Close the open editor to load the selected session.'; return; }
  for (const row of rows) { if (row === selected) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current'); }
  selected.tabIndex = -1; selected.scrollIntoView?.({ block: 'center' }); selected.focus({ preventScroll: true }); selectionPending = false;
}
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
    row.append(document.createTextNode(' · '), continueButton(h.key));
    if (window.sessionsApi.pinAdd) row.append(document.createTextNode(' · '), pinButton(h.key));
    if (window.sessionsApi.momentMark) row.append(document.createTextNode(' · '), momentButton(h.key));
  }
  const tl = node('button', 'Timeline', 'link'); tl.type = 'button';
  tl.addEventListener('click', async () => { const ok = await window.sessionsApi.timeline(h.key).catch(() => false); if (!ok) { tl.textContent = 'Unavailable'; setTimeout(() => { tl.textContent = 'Timeline'; }, 1500); } });
  row.append(document.createTextNode(' · '), tl);
  if (h.canWrite) {
    const b = node('button', 'Write now', 'link'); b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'Writing…';
      let r = null; try { r = await window.sessionsApi.handover('write', h.key); } catch { r = null; }
      b.textContent = r?.ok ? 'Written' : r?.error || 'Could not write it';
      setTimeout(() => { b.textContent = 'Write now'; b.disabled = false; if (r?.ok) void refresh(); }, 1500);
    });
    row.append(document.createTextNode(' · '), b);
  }
  section.append(row);
}

// Continue in another tool (src/continue-in.js): launched hand-offs, from here or a board card, reply above the rows.
const continued = new Map();
const continueApi = { reply: (id, text) => window.sessionsApi.continueReply(id, text), end: (id) => window.sessionsApi.continueEnd(id) };
function continuePanel(r) { if (!continued.has(r.id)) continued.set(r.id, window.ContinueMenu.panel(r, document.getElementById('continued'), continueApi)); return continued.get(r.id); }
window.sessionsApi.onContinue(ev => { if (ev && typeof ev.id === 'string') continuePanel(ev).event(ev); });
function continueButton(key) {
  const out = node('span', '', 'continue-note'); out.setAttribute('role', 'status');
  const wrap = node('span');
  wrap.append(window.ContinueMenu.button({
    className: 'link',
    menu: () => window.sessionsApi.continueMenu(),
    handoff: async c => {
      if (c.id === 'teammate') return teammatePicker(key, wrap, out);
      out.textContent = ' Waiting for your confirmation…';
      const r = await window.sessionsApi.continueHandoff(key, c.id).catch(() => null);
      if (r?.ok && r.mode === 'launched') { out.textContent = ''; continuePanel(r); return; }
      out.textContent = r?.cancelled ? ' Cancelled. Nothing was shared.' : ` ${r?.ok ? r.note || 'Copied.' : r?.error || 'That did not work.'}`;
    },
    onOpen: () => { editing = true; }, onClose: () => { editing = false; },
    pick: async c => {
      out.textContent = ' Working…';
      const r = await window.sessionsApi.continueIn(key, c.id).catch(() => null);
      if (r?.ok && r.mode === 'launched') { out.textContent = ''; continuePanel(r); return; }
      out.textContent = ` ${r?.ok ? r.note || 'Copied.' : r?.error || 'That did not work.'}`;
    },
  }), out);
  return wrap;
}

// Pin to project: one link, command, convention or priority onto the team board this folder is linked to.
function momentButton(key) {
  const wrap = node('span'), out = node('span', '', 'continue-note'); out.setAttribute('role', 'status');
  const open = node('button', 'Mark a moment', 'link'); open.type = 'button';
  open.addEventListener('click', () => {
    if (wrap.querySelector('.moment-pick')) return;
    const box = node('span', '', 'moment-pick teammate-pick');
    const kind = node('select'); kind.setAttribute('aria-label', 'What kind of moment');
    for (const [k, l] of [['ship', 'Shipped'], ['decision', 'Decision'], ['demo', 'Demo'], ['moment', 'Moment']]) { const o = node('option', l); o.value = k; kind.append(o); }
    const label = node('input'); label.type = 'text'; label.maxLength = 120; label.placeholder = 'What happened'; label.setAttribute('aria-label', 'Moment');
    const note = node('input'); note.type = 'text'; note.maxLength = 500; note.placeholder = 'Note for the team (optional)'; note.setAttribute('aria-label', 'Moment note');
    const go = button('Mark', async () => { go.disabled = true; const r = await window.sessionsApi.momentMark(key, kind.value, label.value, note.value).catch(() => null); out.textContent = ` ${r?.ok ? `Marked on the project board (${r.count} moments).` : r?.error || 'That did not work.'}`; if (r?.ok) { box.remove(); if (r.moment_id && window.sessionsApi.commentAdd) wrap.append(momentCommentBox(key, r.moment_id, out)); } else go.disabled = false; }); go.className = 'small primary';
    const cancel = button('Cancel', () => { box.remove(); out.textContent = ''; }); cancel.className = 'small';
    box.append(kind, label, note, go, cancel); wrap.append(box); label.focus();
  });
  wrap.append(open, out);
  return wrap;
}
// The follow-up after a moment is marked: one comment on it (the hub turns @name into a mention for that teammate).
function momentCommentBox(key, momentId, out) {
  const box = node('span', '', 'moment-comment teammate-pick');
  const text = node('input'); text.type = 'text'; text.maxLength = 500; text.placeholder = 'Add a comment (@name mentions a teammate)'; text.setAttribute('aria-label', 'Comment on the moment');
  const go = button('Comment', async () => {
    go.disabled = true;
    const r = await window.sessionsApi.commentAdd(key, { moment_id: momentId }, text.value).catch(() => null);
    out.textContent = ` ${r?.ok ? (r.mentions ? `Commented and mentioned ${r.mentions} teammate${r.mentions === 1 ? '' : 's'}.` : 'Commented on the moment.') : r?.error || 'That did not work.'}`;
    if (r?.ok) box.remove(); else go.disabled = false;
  }); go.className = 'small primary';
  const skip = button('Skip', () => box.remove()); skip.className = 'small';
  box.append(text, go, skip); text.focus();
  return box;
}
function pinButton(key) {
  const wrap = node('span'), out = node('span', '', 'continue-note'); out.setAttribute('role', 'status');
  const open = node('button', 'Pin to project', 'link'); open.type = 'button';
  open.addEventListener('click', () => {
    if (wrap.querySelector('.pin-pick')) return;
    const box = node('span', '', 'pin-pick teammate-pick');
    const kind = node('select'); kind.setAttribute('aria-label', 'What kind of pin');
    for (const [k, l] of [['link', 'Link'], ['command', 'Command'], ['note', 'Convention'], ['priority', 'Priority']]) { const o = node('option', l); o.value = k; kind.append(o); }
    const label = node('input'); label.type = 'text'; label.maxLength = 80; label.placeholder = 'Label'; label.setAttribute('aria-label', 'Pin label');
    const value = node('input'); value.type = 'text'; value.maxLength = 500; value.placeholder = 'https://… or a command or note'; value.setAttribute('aria-label', 'Pin value');
    const go = button('Pin', async () => { go.disabled = true; const r = await window.sessionsApi.pinAdd(key, kind.value, label.value, value.value).catch(() => null); out.textContent = ` ${r?.ok ? `Pinned to the project board (${r.count} pinned).` : r?.error || 'That did not work.'}`; if (r?.ok) box.remove(); else go.disabled = false; }); go.className = 'small primary';
    const cancel = button('Cancel', () => { box.remove(); out.textContent = ''; }); cancel.className = 'small';
    box.append(kind, label, value, go, cancel); wrap.append(box); label.focus();
  });
  wrap.append(open, out);
  return wrap;
}

// Hand off to a teammate: a small inline picker (names from the team hub for this session's folder), then the
// same native preview-and-confirm as a tool hand-off, and the packet goes through agent mail.
async function teammatePicker(key, wrap, out) {
  wrap.querySelector('.teammate-pick')?.remove();
  out.textContent = ' Finding your teammates…';
  const r = await window.sessionsApi.mailTeammates(key).catch(() => null);
  if (!r?.ok || !r.teammates.length) { out.textContent = ` ${r?.error || (r?.ok ? 'No teammates on the board this folder is linked to.' : 'Teammates could not be listed.')}`; return; }
  out.textContent = '';
  const box = node('span', '', 'teammate-pick');
  const pick = node('select'); pick.setAttribute('aria-label', 'Which teammate');
  for (const t of r.teammates) { const o = node('option', t.name); o.value = t.user_id; pick.append(o); }
  const q = node('input'); q.type = 'text'; q.maxLength = 500; q.placeholder = 'What should they look at?'; q.setAttribute('aria-label', 'What should they look at?'); q.className = 'look-question';
  const look = button('Can you look at this?', async () => {
    if (!q.value.trim()) { q.focus(); out.textContent = ' Write what they should look at.'; return; }
    look.disabled = true; out.textContent = ' Sending your request…';
    const res = await window.sessionsApi.mailLook?.(key, pick.value, q.value).catch(() => null);
    out.textContent = ` ${res?.ok ? res.note || 'Asked.' : res?.error || 'That did not work.'}`;
    box.remove();
  }); look.className = 'small';
  const go = button('Hand off…', async () => {
    go.disabled = true; out.textContent = ' Waiting for your confirmation…';
    const res = await window.sessionsApi.mailHandoff(key, pick.value).catch(() => null);
    out.textContent = ` ${res?.ok ? res.note || 'Handed off.' : res?.cancelled ? 'Cancelled. Nothing was sent.' : res?.error || 'That did not work.'}`;
    box.remove();
  }); go.className = 'small primary';
  const cancel = button('Cancel', () => { box.remove(); out.textContent = ''; }); cancel.className = 'small';
  box.append(pick, q, look, go, cancel);
  wrap.append(box);
  pick.focus();
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
// Organised views PR 7: where each live session's project's new work goes, with the first-time question, Change
// and Link. main words every row (src/work-routing-view.js); the page only shows them and sends back opaque keys.
// PR 3: each row carries its project's group key from main, and sits in that project's header; a row with no
// header to go to (Group by Status or AI tool, or a project whose sessions have gone) stays in the strip.
// The first fetch waits for the first list, so it asks with that list's projects already known.
let routingGeneration = 0, routingTimer = null, routingStarted = false;
let routingAsked = new Set(), repoKeysNow = new Set();
const routingNodes = new Map(); // repo → {li, key, status}: owned here, never by #content
const routingBox = () => document.getElementById('routing');
const routingControls = () => [...routingNodes.values()].flatMap(n => [...n.li.querySelectorAll('button, select')]);
// Focus in a routing line, or a picker the person opened: a refresh must not move or replace it.
const routingFocused = () => { const a = document.activeElement; return !!(a && a !== document.body && [...routingNodes.values()].some(n => n.li.contains(a))); };
const routingBusy = () => routingFocused() || [...routingNodes.values()].some(n => n.li.querySelector('.routing-pick[data-opened]:not([hidden])'));
const routingStatus = repo => { const n = routingNodes.get(repo); return n && !routingBox().contains(n.li) ? n.status : document.getElementById('routing-status'); };
function placeRouting() {
  const box = routingBox(), strip = box.querySelector('.body'), into = new Map(), left = [];
  for (const n of routingNodes.values()) {
    const g = groupBy === 'project' && typeof n.key === 'string' ? groupNodes.get(n.key) : null;
    if (g && content.contains(g.section)) { if (!into.has(g)) into.set(g, []); into.get(g).push(n.li); } else left.push(n.li);
  }
  for (const g of groupNodes.values()) { const lis = into.get(g) ?? []; place(g.routing, lis); g.routing.hidden = !lis.length; }
  place(strip, left);
  box.hidden = !left.length;
}
function routingItem(row) {
  const li = node('li', '', `routing-row routing-${row.state}`);
  const status = node('p', '', 'result routing-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const sayRow = (text, ok) => { const t = routingStatus(row.repo); say(t, text, ok); if (t.id !== 'routing-status') t.className = 'result routing-status'; };
  const act = async (run) => {
    for (const b of routingControls()) b.disabled = true;
    let r = null; try { r = await run(); } catch { r = null; }
    if (r?.ok) { await loadRouting({ force: true }); if (r.text) sayRow(r.text, true); }
    else { for (const b of routingControls()) b.disabled = false; sayRow(r?.text || 'Could not save. Try again.', false); }
  };
  // The sentence as shown, and as read out: "goes to" for the arrow (#62 review).
  const text = node('p', '', 'routing-text'), seen = node('span', row.text), heard = node('span', row.label || row.text, 'sr-only');
  seen.setAttribute('aria-hidden', 'true'); text.append(seen, heard); li.append(text);
  if (row.note) li.append(node('p', row.note, 'muted'));
  const actions = node('div', '', 'routing-actions');
  const choices = (row.choices ?? []).map(c => button(c.label, () => act(() => api.routeChoose(row.repo, c.key))));
  // An unlinked project an admin can link: the Link picker first, "Keep on My board" after it (#62 review).
  const linkFirst = row.state === 'unlinked' && !!row.link?.length;
  if (!linkFirst) actions.append(...choices);
  // A board picker revealed by one button: Change (new work goes elsewhere) or Link (admins: put it on a team board).
  const picker = (label, options, go, goLabel) => {
    const sel = select(options.map(o => ({ value: o.key, label: o.label })), 'Nothing to choose');
    const cur = options.find(o => o.current); if (cur) sel.value = cur.key;
    const wrap = node('div', '', 'routing-pick'); wrap.hidden = true;
    wrap.append(field(label, sel), button(goLabel, () => act(() => go(sel.value))));
    return wrap;
  };
  const reveal = (wrap) => { wrap.hidden = !wrap.hidden; if (wrap.hidden) delete wrap.dataset.opened; else wrap.dataset.opened = '1'; };
  if (!row.choices && row.change?.length) {
    const pick = picker('New work goes to', row.change, key => api.routeChoose(row.repo, key), 'Save');
    actions.append(button('Change', () => reveal(pick)), pick);
  }
  if (row.link?.length) {
    const pick = picker('Team board', row.link, key => api.routeLink(row.repo, key), 'Link');
    if (row.note) pick.hidden = false; else actions.append(button('Put on a team board…', () => reveal(pick)));
    actions.append(pick);
    if (linkFirst) actions.append(...choices);
  }
  // Ask an admin (a plain member): the team to ask, then one button; main says what was sent.
  if (row.ask?.length) {
    const team = select(row.ask.map(t => ({ value: t.key, label: t.label })), 'No team');
    const wrap = node('div', '', 'routing-pick routing-ask'); wrap.hidden = !row.note;
    const go = button('Ask an admin', async () => {
      for (const b of routingControls()) b.disabled = true;
      let r = null; try { r = await api.routeAsk(row.repo, team.value); } catch { r = null; }
      for (const b of routingControls()) b.disabled = false;
      sayRow(r?.text || 'Could not ask. Try again.', !!r?.ok);
    });
    if (row.ask.length > 1) wrap.append(field('Team', team));
    wrap.append(go);
    if (!row.note) actions.append(button('Ask an admin…', () => reveal(wrap)));
    actions.append(wrap);
  }
  if (actions.childNodes.length) li.append(actions);
  li.append(status);
  return { li, key: typeof row.key === 'string' ? row.key : null, status };
}
async function loadRouting({ force = false } = {}) {
  if (!force && routingBusy()) return;
  const mine = ++routingGeneration;
  routingAsked = new Set(repoKeysNow);
  let data = null, failed = false;
  try { data = await api.routing?.(); } catch { failed = true; }
  if (mine !== routingGeneration) return;
  // A fetch that failed keeps the lines on screen; signed out, no team or no routes clears them.
  if (failed || data?.reason === 'error') return;
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  for (const n of routingNodes.values()) n.li.remove();
  routingNodes.clear();
  for (const row of rows) routingNodes.set(row.repo, routingItem(row));
  document.getElementById('routing-status').textContent = '';
  placeRouting();
}
// A project whose first session started after the page opened gets its line without a reload.
function routingFollow() {
  if (![...repoKeysNow].some(k => !routingAsked.has(k)) || routingTimer) return;
  routingTimer = setTimeout(() => { routingTimer = null; if (!routingBusy()) void loadRouting(); }, 1000);
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
  if (kind === 'ticket') {
    say(out, 'Drafting from the handover…', true); host.append(out, close);
    api.ticketDraft(a.handle).then(d => {
      if (!d?.ok) return say(out, d?.text ?? 'Could not draft the issue.', false);
      const where = select(d.targets.map(t => ({ value: t.ref, label: t.label })), 'No connection');
      const title = document.createElement('input'); title.type = 'text'; title.maxLength = 200; title.value = d.title;
      const body = document.createElement('textarea'); body.maxLength = 8000; body.rows = 10; body.value = d.description;
      const link = node('a', '', 'issue-link'); link.hidden = true;
      const go = button('Create', async () => {
        if (!where.value || !title.value.trim()) return say(out, 'Choose where, and give it a title.', false);
        go.disabled = true;
        try {
          const r = await api.ticketCreate(where.value, title.value, body.value);
          say(out, r?.text ?? 'Could not create the issue.', r?.ok);
          if (r?.ok && r.url) { link.href = r.url; link.textContent = r.url; link.target = '_blank'; link.rel = 'noopener'; link.hidden = false; } else if (!r?.ok) go.disabled = false;
        } catch { go.disabled = false; }
      });
      host.replaceChildren(field('Create in', where), field('Title', title), field('Description (edit before sending; only this text leaves your computer)', body), go, out, link, close);
    });
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
  if (a.ticket?.length) row.append(button(`Create ${a.ticket.join(' / ')} issue…`, () => rowPanel(section, 'ticket', item)));
  if (a.share) {
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = a.share.on;
    check.addEventListener('change', async () => { check.disabled = true; try { await api.share(a.handle, check.checked); } finally { check.disabled = false; } });
    const label = node('label'); label.append(check, document.createTextNode(' Share handover with team (this repo; scrubbed, off by default)')); row.append(label);
  }
  section.append(row);
}
function emptyState() {
  const box = node('div', '', 'how');
  box.append(node('h2', 'How sessions get in'), node('p', 'Connect the tool → sessions appear here and on your widget → link the repo to share with your team → make a card to track it.'));
  return box;
}
function togglePanel(id, fill) {
  const host = document.getElementById(id); host.hidden = !host.hidden;
  if (!host.hidden) fill(host);
}

// ── Organised views PR 3: project → bucket groups ─────────────────────────────
// main gives each row group {key, heading, sub} (never a path); the page groups with src/work-organise.js.
// Group nodes live in a Map outside #content, so a refresh that rebuilds the session rows moves nothing a
// person is using: headers and the routing lines in them are reused in place, and focus is put back by key.
const Organise = window.PlexiformWorkOrganise;
const BY = ['project', 'bucket', 'provider'];
const GROUP_STORE = 'plexiform.sessions.groups.v1', BY_STORE = 'plexiform.sessions.groupBy.v1', STORE_MAX = 200;
const STORED_KEY = /^(?:(repo|git|dir|name)-[0-9a-z]{1,7}|other)(?:\/(needs|working|check|stuck|idle))?$/;
const storage = { get(k) { try { return window.localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* unavailable */ } } };
// Only explicit toggles, only in Project mode, only for keys that pass the pattern; anything else is dropped on read.
function readClosed() {
  let raw = null; try { raw = JSON.parse(storage.get(GROUP_STORE) || 'null'); } catch { raw = null; }
  const out = new Map();
  if (raw && typeof raw === 'object' && raw.closed && typeof raw.closed === 'object') for (const [k, v] of Object.entries(raw.closed)) if (STORED_KEY.test(k) && typeof v === 'boolean' && out.size < STORE_MAX) out.set(k, v);
  return out;
}
const savedClosed = readClosed();
function saveClosed(key, closed) {
  savedClosed.delete(key); savedClosed.set(key, closed);
  while (savedClosed.size > STORE_MAX) savedClosed.delete(savedClosed.keys().next().value);
  storage.set(GROUP_STORE, JSON.stringify({ v: 1, closed: Object.fromEntries(savedClosed) }));
}
let groupBy = (() => { const v = storage.get(BY_STORE); return BY.includes(v) ? v : 'project'; })();
const memClosed = new Map(); // `${by}|${key}` → bool: every toggle this page has seen, saved or not
const groupNodes = new Map(); // key → header and bucket nodes, for the current Group by
const pendingKeys = new Set(); // groups whose rows git has not placed yet: toggles stay in memory
function isClosed(key, fallback) {
  const mem = memClosed.get(`${groupBy}|${key}`);
  if (mem !== undefined) return mem;
  if (groupBy === 'project' && !pendingKeys.has(key.split('/')[0]) && savedClosed.has(key)) return savedClosed.get(key);
  return fallback;
}
function setClosed(key, closed) {
  memClosed.set(`${groupBy}|${key}`, closed);
  if (groupBy === 'project' && !pendingKeys.has(key.split('/')[0]) && STORED_KEY.test(key)) saveClosed(key, closed);
}
const bucketHeading = id => Organise.BUCKETS.find(b => b.id === id).heading;
// "Needs you 2 · Working on it 3", worded from BUCKETS and read as "Needs you 2, Working on it 3".
function countParts(host, counts) {
  host.replaceChildren();
  const parts = Organise.BUCKETS.filter(b => counts[b.id] > 0);
  parts.forEach((b, i) => {
    if (i) { host.append(node('span', ',', 'sr-only')); const dot = node('span', ' · '); dot.setAttribute('aria-hidden', 'true'); host.append(dot); }
    host.append(document.createTextNode(`${b.heading} ${counts[b.id]}`));
  });
}
const domKey = key => key.replace(/[^\w-]/g, '_');
function groupNode(key) {
  let g = groupNodes.get(key);
  if (g) return g;
  const id = `grp-${domKey(key)}`;
  const section = node('section', '', 'group'), h2 = node('h2', '', 'group-head'), btn = node('button', '', 'group-toggle');
  section.dataset.groupKey = key; section.setAttribute('aria-labelledby', `${id}-title`);
  h2.id = `${id}-title`; btn.type = 'button'; btn.dataset.focusKey = `grp:${key}`; btn.setAttribute('aria-controls', id);
  const name = node('span', '', 'group-name'), counts = node('span', '', 'group-counts');
  btn.append(name, node('span', ': ', 'sr-only'), counts); h2.append(btn);
  const sub = node('p', '', 'group-sub muted'), routing = node('ul', '', 'group-routing'), region = node('div', '', 'group-body');
  sub.hidden = true; routing.hidden = true; region.id = id;
  btn.addEventListener('click', () => { const closed = !region.hidden; region.hidden = closed; btn.setAttribute('aria-expanded', String(!closed)); setClosed(key, closed); });
  section.append(h2, sub, routing, region);
  g = { key, section, btn, name, counts, sub, routing, region, buckets: new Map() };
  groupNodes.set(key, g);
  return g;
}
function bucketNode(g, id) {
  let b = g.buckets.get(id);
  if (b) return b;
  const details = document.createElement('details'), summary = node('summary', '', 'bucket-head'), list = node('div', '', 'bucket-body');
  details.className = 'bucket'; details.id = `grp-${domKey(g.key)}-${id}`; details.dataset.bucket = id;
  summary.dataset.focusKey = `grp:${g.key}/${id}`;
  // A person's click (or Enter/Space, which clicks) is the only toggle saved; opening one for a selected row is not.
  summary.addEventListener('click', () => setClosed(`${g.key}/${id}`, details.open));
  details.append(summary, list);
  b = { details, summary, list };
  g.buckets.set(id, b);
  return b;
}
// The rows' groups for the chosen Group by: [{key, heading, sub, rows, groups?}] from work-organise.
function grouped(items) {
  const rows = items.map(item => ({ item, project: item.group && typeof item.group.key === 'string' ? item.group : { key: 'other', heading: Organise.FALLBACK, sub: null }, bucket: item.bucket, status: item.status, provider: item.provider }));
  return groupBy === 'bucket' ? Organise.group(rows, 'bucket') : Organise.group(rows, groupBy, { then: 'bucket' });
}
// Fill each group from fresh session nodes; returns the group sections in order.
function placeGroups(items, nodes, selected) {
  pendingKeys.clear();
  for (const item of items) if (item.groupPending && item.group) pendingKeys.add(item.group.key);
  const out = [];
  for (const grp of grouped(items)) {
    const g = groupNode(grp.key);
    g.name.textContent = grp.heading;
    g.sub.textContent = grp.sub || ''; g.sub.hidden = !grp.sub;
    const fallback = groupBy === 'bucket' ? !!grp.collapsed : false;
    const holds = rows => !!selected && rows.some(r => r.item === selected);
    const open = holds(grp.rows) || !isClosed(grp.key, fallback);
    g.region.hidden = !open; g.btn.setAttribute('aria-expanded', String(open));
    if (groupBy === 'bucket') {
      for (const b of g.buckets.values()) b.details.remove();
      g.buckets.clear();
      g.region.replaceChildren(...grp.rows.map(r => nodes.get(r.item)));
    } else {
      const seen = [];
      for (const inner of grp.groups) {
        const b = bucketNode(g, inner.key), bkey = `${grp.key}/${inner.key}`;
        b.details.open = holds(inner.rows) || !isClosed(bkey, !!inner.collapsed);
        b.list.replaceChildren(...inner.rows.map(r => nodes.get(r.item)));
        seen.push(b.details);
      }
      for (const [id, b] of g.buckets) if (!seen.includes(b.details)) { b.details.remove(); g.buckets.delete(id); }
      place(g.region, seen);
    }
    out.push(g.section);
  }
  for (const [key, g] of groupNodes) if (!out.includes(g.section)) { g.section.remove(); groupNodes.delete(key); }
  return out;
}
// Counts and visibility from what the filters leave showing, so the numbers match the screen.
function countGroups() {
  for (const g of groupNodes.values()) {
    const rows = [...g.region.querySelectorAll('.session')], shown = rows.filter(r => !r.hidden);
    const counts = Object.fromEntries(Organise.BUCKETS.map(b => [b.id, 0]));
    for (const r of shown) if (Object.hasOwn(counts, r.dataset.bucket)) counts[r.dataset.bucket]++;
    if (groupBy === 'bucket') g.counts.textContent = `${shown.length} ${shown.length === 1 ? 'session' : 'sessions'}`;
    else countParts(g.counts, counts);
    for (const [id, b] of g.buckets) { b.summary.textContent = `${bucketHeading(id)} (${counts[id]})`; b.details.hidden = !counts[id]; }
    g.section.hidden = !shown.length;
  }
}
// Keyed, in-place: an element moves only when its position must change.
function place(container, nodes) {
  let prev = null;
  for (const n of nodes) { const want = prev ? prev.nextSibling : container.firstChild; if (want !== n) container.insertBefore(n, want); prev = n; }
  while (prev ? prev.nextSibling : container.firstChild) (prev ? prev.nextSibling : container.firstChild).remove();
}
// A rebuild can detach what had focus (a bucket's summary, a header); put focus back on the same control.
function keepFocus(run) {
  const active = document.activeElement, key = active && content.contains(active) ? active.closest('[data-focus-key]')?.dataset.focusKey : null;
  run();
  if (key && !content.contains(document.activeElement)) [...content.querySelectorAll('[data-focus-key]')].find(e => e.dataset.focusKey === key)?.focus({ preventScroll: true });
}

let lastSnapshot = null;
function render(snapshot) {
  lastSnapshot = snapshot;
  const before = [], nodes = new Map(), items = snapshot.sessions ?? [];
  let selectedItem = null;
  const a = snapshot.activity;
  activity.textContent = a?.observed ? `A Codex lifecycle event was received ${age(a.latest_age_ms).toLowerCase()}.`
    : a?.configured === true ? 'Hooks are configured. No local lifecycle event is visible yet. Review the Plexiform hooks through Codex /hooks, then start a fresh turn.'
      : a?.configured === false ? 'Codex is not connected to this copy of Plexiform. Connect it on the AI tools page, then review the hooks in Codex.'
        : 'Codex hook configuration could not be read. Check Codex on the AI tools page.';
  for (const t of snapshot.shared ?? []) before.push(node('p', `${t.sessions} sessions share this working tree: ${t.project}, with ${t.dirty} uncommitted file${t.dirty === 1 ? '' : 's'}. Commit, or give one session its own worktree, before they overwrite each other.`, 'banner'));
  document.getElementById('coord').hidden = !(snapshot.sessions ?? []).some(i => i.burst?.coordination);
  for (const item of items) {
    const section = node('section', '', 'session');
    section.dataset.bucket = typeof item.bucket === 'string' ? item.bucket : Organise.bucketOf(item.status);
    section.dataset.search = `${item.provider} ${item.project}`.toLocaleLowerCase(); section.dataset.provider = item.provider; section.dataset.freshness = item.freshness;
    if (item.handover?.key) section.dataset.sessionKey = item.handover.key;
    const selected = item.handover?.key === selectedSessionKey;
    if (selected) { section.setAttribute('aria-current', 'true'); section.tabIndex = -1; selectedItem = item; }
    const heading = node('h2', `${item.provider} · ${item.project}`);
    heading.append(node('span', item.freshness === 'recent' ? 'Recent' : item.freshness === 'stale' ? 'Stale' : 'Freshness unknown', 'freshness'));
    if (item.policy?.name) heading.append(node('span', `Policy: ${item.policy.name}`, 'freshness policy'));
    const confidence = item.freshness === 'recent' && snapshot.status !== 'unavailable' ? 'Reported' : 'Last reported';
    section.append(heading, node('p', `${confidence}: ${item.status}${item.detail && !item.stuck ? ` (${String(item.detail).toLowerCase()})` : ''}${item.stuck ? ` (${item.stuck.tool ? `last tool ${item.stuck.tool}, ` : ''}since ${Math.max(1, Math.round(item.stuck.since_ms / 60000))}m)` : ''} · Last seen ${age(item.age_ms).toLowerCase()} · Reported by ${item.provider}`, 'muted'));
    if (item.children?.length) {
      const list = node('ul'); list.setAttribute('aria-label', 'Reported agents');
      for (const child of item.children) list.append(node('li', `${child.label} · ${confidence}: ${child.status}`));
      section.append(list);
    }
    if (item.policy?.blocked) section.append(node('p', `${item.policy.blocked.text}${item.policy.blocked.tool && item.policy.blocked.tool !== 'prompt' ? ` (${item.policy.blocked.tool})` : ''}`, 'warn'));
    if (item.policy?.warning) section.append(node('p', item.policy.warning, 'muted'));
    if (item.sharedTree) section.append(node('p', `Shares its working tree with another live session (${item.sharedTree})`, 'warn'));
    for (const c of item.collisions ?? []) {
      const line = node('p', `Collision: ${c.text}. `, 'warn');
      line.append(button('Open the other session', async () => { const r = await api.openRecord(c.other).catch(() => null); if (!r?.ok) status.textContent = 'That session could not be opened. The collision may have ended.'; }));
      section.append(line);
    }
    if (item.burst) burstBlock(section, item.burst);
    if (item.handover) handoverRow(section, item.handover);
    sessionTools(section, item);
    rowActions(section, item);
    nodes.set(item, section);
  }
  const after = [];
  if (!items.length) {
    after.push(node('p', snapshot.status === 'unavailable' ? 'Local session reports are unavailable. Try Refresh.' : 'No local sessions are visible yet.', 'muted'));
    if (snapshot.status !== 'unavailable') after.push(emptyState());
  }
  keepFocus(() => { place(content, [...before, ...placeGroups(items, nodes, selectionPending ? selectedItem : null), ...after]); placeRouting(); });
  if (selectedItem && selectionPending) { selectionPending = false; const section = nodes.get(selectedItem); section.scrollIntoView?.({ block: 'center' }); section.focus({ preventScroll: true }); }
  repoKeysNow = new Set(items.map(i => i.group?.key).filter(k => typeof k === 'string' && k.startsWith('repo-')));
  if (!routingStarted) { routingStarted = true; void loadRouting(); } else routingFollow();
  updateLocalFilters(snapshot.sessions ?? []);
  // The Add sessions panel stays open while there is nothing to show and folds once sessions exist, unless the person chose.
  if (!addTouched) document.getElementById('add').open = !snapshot.sessions?.length;
  status.textContent = snapshot.status === 'unavailable' ? 'Local activity is unavailable. Try Refresh.'
    : `Updated ${new Date(snapshot.observed_at).toLocaleTimeString()}. Refreshes every 5 seconds while this page is visible.${snapshot.omitted ? ` ${snapshot.omitted} additional reports exceed the display limit.` : ''}`;
}
function applyLocalFilters() {
  const query = document.getElementById('session-search').value.trim().toLocaleLowerCase();
  const provider = document.getElementById('session-provider').value, freshness = document.getElementById('session-freshness').value;
  const rows = [...content.querySelectorAll('.session')]; let shown = 0;
  for (const row of rows) {
    row.hidden = !!(query && !row.dataset.search.includes(query) || provider && row.dataset.provider !== provider || freshness && row.dataset.freshness !== freshness);
    if (!row.hidden) shown++;
  }
  document.getElementById('session-count').textContent = `${shown} of ${rows.length} ${rows.length === 1 ? 'session' : 'sessions'}`;
  document.getElementById('session-filter-empty').hidden = !rows.length || shown > 0;
  countGroups();
}
function updateLocalFilters(sessions) {
  const provider = document.getElementById('session-provider'), previous = provider.value;
  const values = [...new Set(sessions.map(s => s.provider))].sort((a, b) => a.localeCompare(b));
  provider.replaceChildren(new Option('All tools', ''), ...values.map(v => new Option(v, v)));
  if (previous && !values.includes(previous)) provider.append(new Option(`${previous} · none now`, previous));
  provider.value = previous; applyLocalFilters();
}
function resetLocalFilters() {
  for (const id of ['session-search', 'session-provider', 'session-freshness']) document.getElementById(id).value = '';
  applyLocalFilters();
}
// Empty the session rows. A routing line someone is using stays where it is; otherwise the headers go and their
// lines return to the strip, so a failed refresh never drops them.
function clearRows() {
  if (routingFocused()) { for (const r of content.querySelectorAll('.session')) r.remove(); for (const n of [...content.children]) if (!n.classList.contains('group')) n.remove(); countGroups(); return; }
  placeGroups([], new Map(), null); content.replaceChildren(); placeRouting();
}
async function refresh({ clear = false } = {}) {
  const request = ++generation;
  if (clear) { clearRows(); updateLocalFilters([]); status.textContent = 'Checking local sessions…'; activity.textContent = 'Checking local activity…'; }
  try {
    let timer;
    const snapshot = await Promise.race([window.sessionsApi.state(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('unavailable')), 4500);
    })]).finally(() => clearTimeout(timer));
    if (request !== generation || document.hidden) return;
    if (!snapshot) throw new Error('unavailable');
    if (editing) { if (selectionPending) focusSelectedSession(); return; } // preserve an open editor while navigating to an existing row
    if (routingFocused()) return; // a header's routing control has focus: the next tick redraws
    render(snapshot);
  } catch {
    if (request === generation && !document.hidden && !routingStarted) { routingStarted = true; void loadRouting(); }
    if (request === generation && !document.hidden) { clearRows(); updateLocalFilters([]); activity.textContent = 'Codex activity is unavailable. Check Codex on the AI tools page.'; status.textContent = 'Local activity is unavailable. Try Refresh.'; }
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
document.getElementById('session-search').addEventListener('input', applyLocalFilters);
for (const id of ['session-provider', 'session-freshness']) document.getElementById(id).addEventListener('change', applyLocalFilters);
// Group by: Project (with a bucket inside each), Status, or AI tool. The choice is remembered on this Mac.
{
  const pick = document.getElementById('session-group');
  pick.value = groupBy;
  pick.addEventListener('change', () => {
    if (!BY.includes(pick.value)) { pick.value = groupBy; return; }
    groupBy = pick.value; storage.set(BY_STORE, groupBy);
    for (const g of groupNodes.values()) g.section.remove();
    groupNodes.clear();
    if (lastSnapshot) { render(lastSnapshot); applyLocalFilters(); } else placeRouting();
  });
}
for (const id of ['session-reset', 'session-empty-reset']) document.getElementById(id).addEventListener('click', resetLocalFilters);
document.getElementById('start-session-shortcut').addEventListener('click', () => { const add = document.getElementById('add'), host = document.getElementById('panel-start'); add.open = true; addTouched = true; host.hidden = false; startPanel(host); host.scrollIntoView?.({ block: 'center' }); });
document.getElementById('refresh').addEventListener('click', () => { editing = false; refresh({ clear: true }); void loadRouting(); });
document.getElementById('add').addEventListener('toggle', () => { addTouched = true; });
document.getElementById('add-connect').addEventListener('click', async () => {
  const out = document.getElementById('connect-status');
  try { const r = await api.connect(); say(out, r?.ok ? 'Opened. Connect the tool there, then come back and Refresh.' : 'Could not open it. Try again.', r?.ok); } catch { say(out, 'Could not open it. Try again.', false); }
});
document.getElementById('add-link').addEventListener('click', () => togglePanel('panel-link', host => linkPanel(host, null, null)));
document.getElementById('add-start').addEventListener('click', () => togglePanel('panel-start', startPanel));
document.getElementById('codex-aitools').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  try { if (!await window.sessionsApi.aiTools()) status.textContent = 'The AI tools page could not be opened. Open it from Settings in the sidebar.'; }
  catch { status.textContent = 'The AI tools page could not be opened. Open it from Settings in the sidebar.'; }
  finally { document.getElementById('codex-aitools').disabled = false; }
});
document.addEventListener('visibilitychange', () => {
  // A hidden page must not retain a status that appears current on return.
  editing = false; ++generation; clearRows(); updateLocalFilters([]); status.textContent = 'Checking local sessions…'; activity.textContent = 'Checking local activity…';
  if (!document.hidden) void refresh();
});
setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
if (!document.hidden) void refresh();
