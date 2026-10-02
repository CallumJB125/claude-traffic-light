'use strict';
// Overview "My sessions" / "Team sessions": renders main's session directory
// (src/session-directory.js). Main decides what this page may see; this file
// only validates, renders with textContent and keeps rows keyed and updated
// in place. A row that disappears stays as a dimmed "no longer listed" entry
// (team rows lose their task details) until dismissed. overview.js calls
// start() once with the hooks it owns (owned card focus, work composer).
(() => {
  const api = window.overviewApi;
  if (!api || typeof api.directory !== 'function') return;
  const $ = id => document.getElementById(id);
  const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v, max = 1000) => typeof v === 'string' && v.length <= max;
  const hex = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
  const CAPS = ['discovery', 'telemetry', 'taskReporting', 'receive', 'reply', 'resume', 'steer', 'interrupt', 'remoteControl'];
  const CAP_LABEL = { discovery: 'Discovery', telemetry: 'Activity reports', taskReporting: 'Task reporting', receive: 'Receive messages', reply: 'Reply', resume: 'Resume', steer: 'Steer a running turn', interrupt: 'Interrupt', remoteControl: 'Use from other devices or teammates' };
  const PROVENANCE = { owned: 'Started by Plexiform', observed: 'Observed from activity hooks', 'self-reported': 'Self-reported by the agent', shared: 'Shared with this team by its owner', board: 'Board run', 'plexiform-tasks': 'Plexiform Tasks' };
  const FRESH = ['recent', 'stale', 'unknown'];
  const age = v => v === null ? 'report time unknown' : v < 60_000 ? `${Math.floor(v / 1000)}s ago` : v < 3_600_000 ? `${Math.floor(v / 60_000)}m ago` : `${Math.floor(v / 3_600_000)}h ago`;
  const validTime = v => v === null || Number.isFinite(v) && v >= 0;
  const validTask = t => obj(t) && str(t.title, 400) && ['human', 'board', 'reported', 'unknown'].includes(t.source);
  const validCap = c => obj(c) && typeof c.available === 'boolean' && str(c.reason, 600);
  const validChild = c => obj(c) && hex(c.id, 40) && str(c.label, 200) && str(c.state, 80) && typeof c.input === 'boolean' && validTask(c.task) && FRESH.includes(c.freshness) && validTime(c.ageMs) && validTime(c.observedAt) && (c.selfReported === null || obj(c.selfReported) && str(c.selfReported.state, 80) && validTime(c.selfReported.at));
  const validEntry = e => obj(e) && hex(e.id, 40) && ['owned', 'observed', 'board', 'task', 'shared'].includes(e.kind) && obj(e.owner) && str(e.owner.name, 200) && typeof e.owner.self === 'boolean' && str(e.owner.initials, 8)
    && ['personal', 'team'].includes(e.scope) && Array.isArray(e.teams) && e.teams.length <= 20 && e.teams.every(t => obj(t) && hex(t.key, 32) && str(t.name, 200))
    && obj(e.board) && str(e.board.label, 200) && obj(e.provider) && str(e.provider.id, 120) && str(e.provider.label, 200) && obj(e.device) && str(e.device.label, 200) && typeof e.device.local === 'boolean'
    && validTask(e.task) && str(e.state, 80) && typeof e.input === 'boolean' && FRESH.includes(e.freshness) && validTime(e.ageMs) && validTime(e.observedAt)
    && (e.selfReported === null || obj(e.selfReported) && str(e.selfReported.state, 80) && validTime(e.selfReported.at))
    && Array.isArray(e.provenance) && e.provenance.every(p => Object.hasOwn(PROVENANCE, p)) && obj(e.capabilities) && CAPS.every(k => validCap(e.capabilities[k]))
    && (e.interact === null || obj(e.interact) && ['owned', 'work', 'team'].includes(e.interact.kind) && str(e.interact.ref, 200))
    && Array.isArray(e.children) && e.children.length <= 64 && e.children.every(validChild)
    && (e.deliveries === undefined || Array.isArray(e.deliveries) && e.deliveries.length <= 10 && e.deliveries.every(d => obj(d) && str(d.id, 80) && str(d.text, 4000) && (d.by === null || str(d.by, 80)) && str(d.state, 40) && str(d.response, 4000)))
    && (e.handoffs === undefined || Array.isArray(e.handoffs) && e.handoffs.length <= 10 && e.handoffs.every(h => obj(h) && ['in', 'out'].includes(h.direction) && str(h.with, 80) && str(h.state, 40) && str(h.summary, 400)));
  const valid = d => obj(d) && d.schema === 1 && ['mine', 'team'].includes(d.view) && ['complete', 'partial', 'unavailable'].includes(d.status) && Number.isFinite(d.observed_at) && str(d.notice, 600)
    && Array.isArray(d.teams) && d.teams.length <= 64 && d.teams.every(t => obj(t) && hex(t.key, 32) && str(t.name, 200) && ['hub', 'fake', 'adapter'].includes(t.source) && str(t.label, 200))
    && (d.team === null || obj(d.team) && hex(d.team.key, 32) && str(d.team.name, 200)) && Array.isArray(d.entries) && d.entries.length <= 300 && d.entries.every(validEntry) && new Set(d.entries.map(e => e.id)).size === d.entries.length;
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const set = (n, v) => { if (n.textContent !== v) n.textContent = v; };
  const button = (label, fn) => { const b = el('button', label); b.type = 'button'; b.addEventListener('click', fn); return b; };

  let hooks = null, view = 'mine', team = null, read = 0, received = 0;
  const lists = { mine: { rows: new Map(), data: null }, team: { rows: new Map(), data: null } };
  const TEAM_FILTERS = ['person', 'task', 'platform', 'device', 'status'];
  const keyOf = (e, f) => f === 'person' ? e.owner.name : f === 'task' ? e.task.title : f === 'platform' ? e.provider.label : f === 'device' ? e.device.label : e.state;
  const freshNow = (e, data) => {
    if (e.freshness !== 'recent' || e.ageMs === null) return { freshness: e.freshness, ageMs: e.ageMs };
    const a = e.ageMs + Math.max(0, Date.now() - data.observed_at);
    return { freshness: a > 90_000 ? 'stale' : 'recent', ageMs: a };
  };
  const stateText = (e, f) => f.freshness === 'recent' ? e.state : `${e.state} · ${f.freshness === 'stale' ? 'Stale' : 'Freshness unknown'}`;
  const tone = (e, f) => f.freshness !== 'recent' ? f.freshness : e.input ? 'waiting' : e.state === 'Working' ? 'working' : '';

  function rowView(kind) {
    const li = el('li', '', 'dir-entry'), head = el('div', '', 'row-heading'), who = el('div', '', 'dir-who');
    const avatar = el('span', '', 'avatar'); avatar.setAttribute('aria-hidden', 'true');
    const titles = el('div'), title = el('h3'), owner = el('p', '', 'muted'), tag = el('span', '', 'tag');
    titles.append(title, owner); who.append(avatar, titles); head.append(who, tag);
    const meta = el('p', '', 'row-meta'), badges = el('p', '', 'badges'), when = el('p', '', 'muted'), self = el('p', '', 'muted');
    const children = el('ul', '', 'agent-list'), handoffs = el('ul', '', 'handoffs'), deliveries = el('ol', '', 'deliveries');
    children.setAttribute('aria-label', 'Child agents'); handoffs.setAttribute('aria-label', 'Handoffs'); deliveries.setAttribute('aria-label', 'Messages and responses');
    const actions = el('div', '', 'actions'), why = el('p', '', 'reason'), notice = el('p', '', 'reason'); notice.setAttribute('role', 'status');
    const details = el('details', '', 'caps'), capList = el('ul', '', 'cap-list'); details.append(el('summary', 'What Plexiform can do with this session'), capList);
    li.append(head, meta, badges, when, self, children, handoffs, deliveries, actions, why, notice, details);
    return { li, avatar, title, owner, tag, meta, badges, when, self, children, handoffs, deliveries, actions, why, notice, capList, details, kind, composer: null, gone: false, entry: null };
  }
  function updateRow(v, e, data) {
    v.entry = e; v.gone = false; v.li.classList.remove('gone');
    const f = freshNow(e, data);
    set(v.avatar, e.owner.initials); v.avatar.hidden = e.owner.self && data.view === 'mine';
    set(v.title, e.task.source === 'unknown' ? `${e.provider.label} session` : e.task.title);
    set(v.owner, `${e.owner.self ? 'You' : e.owner.name}${e.task.source === 'human' ? ' · task title edited by a person' : e.task.source === 'unknown' ? ' · task not reported' : ''}`);
    set(v.tag, stateText(e, f)); v.tag.className = `tag ${tone(e, f)}`;
    set(v.meta, [e.provider.label + (e.provider.kind === 'local' ? ' · local model' : ''), e.device.label + (e.device.local ? ' (this device)' : ''), e.board.label, e.card?.key ? `Card ${e.card.key}` : ''].filter(Boolean).join(' · '));
    set(v.badges, [...e.teams.map(t => `Team: ${t.name}`), ...e.provenance.map(p => PROVENANCE[p])].join(' · '));
    set(v.when, `Last observed ${age(f.ageMs)}${f.freshness === 'stale' ? ' · stale' : f.freshness === 'unknown' ? ' · freshness unknown' : ''}`);
    set(v.self, e.selfReported ? `Self-reported: ${e.selfReported.state}${e.selfReported.at !== null ? ` at ${new Date(e.selfReported.at).toLocaleTimeString()}` : ''} (not verified)` : ''); v.self.hidden = !e.selfReported;
    const kids = e.children.map(c => { const cf = freshNow(c, data), li = el('li', '', 'agent'), h = el('div', '', 'row-heading'); h.append(el('h4', c.task.source === 'unknown' ? c.label : `${c.label}: ${c.task.title}`), el('span', stateText(c, cf), `tag ${tone(c, cf)}`)); li.append(h, el('p', `Last observed ${age(cf.ageMs)}${c.selfReported ? ' · self-reported, not verified' : ''}`, 'muted')); return li; });
    const sig = JSON.stringify(e.children.map(c => [c.id, c.state, c.task.title, freshNow(c, data).freshness, Math.floor((freshNow(c, data).ageMs ?? -1) / 1000)]));
    if (v.childSig !== sig) { v.childSig = sig; v.children.replaceChildren(...kids); }
    v.children.hidden = !kids.length;
    const hs = (e.handoffs ?? []).map(h => el('li', `${h.direction === 'out' ? 'Handoff to' : 'Handoff from'} ${h.with} · ${h.state}${h.summary ? ` · ${h.summary}` : ''}`));
    const hsig = JSON.stringify(e.handoffs ?? []); if (v.hsig !== hsig) { v.hsig = hsig; v.handoffs.replaceChildren(...hs); } v.handoffs.hidden = !hs.length;
    const ds = (e.deliveries ?? []).map(d => { const li = el('li', '', 'delivery'), h = el('div', '', 'delivery-head'); h.append(el('strong', d.by ? `Sent by ${d.by}` : 'You'), el('span', d.state, `tag ${d.state}`)); li.append(h, el('p', d.text, 'delivery-text')); if (d.response) li.append(el('p', d.response, 'delivery-response')); return li; });
    const dsig = JSON.stringify(e.deliveries ?? []); if (v.dsig !== dsig) { v.dsig = dsig; v.deliveries.replaceChildren(...ds); } v.deliveries.hidden = !ds.length;
    const csig = JSON.stringify(CAPS.map(k => [k, e.capabilities[k]]));
    if (v.csig !== csig) { v.csig = csig; v.capList.replaceChildren(...CAPS.map(k => el('li', `${CAP_LABEL[k]}: ${e.capabilities[k].available ? 'available' : `unavailable. ${e.capabilities[k].reason}`}`, e.capabilities[k].available ? '' : 'muted'))); }
    // One primary action: message where a permitted, supported channel exists; otherwise the exact reason.
    const canMessage = e.interact !== null && e.capabilities.receive.available;
    if (!v.message) { v.message = button('Message', () => void interact(v)); v.actions.append(v.message); }
    v.message.hidden = !canMessage; v.message.disabled = !!v.busy;
    v.message.textContent = e.interact?.kind === 'team' ? 'Message' : e.interact?.kind === 'owned' ? 'Open conversation' : 'Message';
    v.message.setAttribute('aria-label', `${v.message.textContent}: ${v.title.textContent}`);
    set(v.why, canMessage ? '' : e.capabilities.receive.reason || 'No supported message channel.'); v.why.hidden = canMessage;
    if (v.composer && (!canMessage || e.interact?.kind !== 'team')) { v.composer.box.remove(); v.composer = null; }
  }
  function tombstone(v) {
    if (v.gone) return; v.gone = true; v.li.classList.add('gone');
    const e = v.entry, shared = e.kind === 'shared';
    // A row that left a team view keeps no task details: it may no longer be shared.
    set(v.title, shared ? `${e.owner.name}'s ${e.provider.label} session` : v.title.textContent);
    set(v.tag, 'No longer listed'); v.tag.className = 'tag stale';
    set(v.meta, shared ? '' : v.meta.textContent);
    for (const n of [v.badges, v.self, v.children, v.handoffs, v.deliveries, v.details]) n.hidden = true;
    if (shared) for (const n of [v.children, v.handoffs, v.deliveries, v.capList]) n.replaceChildren();
    set(v.when, shared ? 'No longer shared with you, or it ended.' : 'No longer reported. It ended, or its reports stopped.');
    v.composer?.box.remove(); v.composer = null; v.message.hidden = true; v.why.hidden = true;
    if (!v.dismiss) { v.dismiss = button('Dismiss', () => { v.li.remove(); for (const l of Object.values(lists)) for (const [id, x] of l.rows) if (x === v) l.rows.delete(id); }); v.actions.append(v.dismiss); }
  }
  async function interact(v) {
    const e = v.entry; if (!e || v.gone || !e.interact || !hooks) return;
    if (e.interact.kind === 'owned') { show('mine'); hooks.focusOwned(e.interact.ref); return; }
    if (e.interact.kind === 'work') { show('mine'); hooks.composeWork(e.interact.ref); return; }
    if (v.composer) { v.composer.input.focus(); return; }
    const box = el('div', '', 'composer'), label = el('label', `Message ${e.owner.name}'s session`), input = el('textarea');
    input.id = `team-msg-${e.id}`; label.htmlFor = input.id; input.maxLength = 4000;
    const note = el('p', 'Sends your exact text through the team hub to this shared session only. Maximum 4,000 characters.', 'reason'); note.setAttribute('role', 'status');
    const send = button('Send', () => void sendTeam(v)), cancel = button('Cancel', () => { box.remove(); v.composer = null; v.message.focus(); });
    const row = el('div', '', 'actions'); row.append(send, cancel); box.append(label, input, note, row);
    v.composer = { box, input, note, send }; v.li.insertBefore(box, v.why); input.focus();
  }
  async function sendTeam(v) {
    const c = v.composer, e = v.entry; if (!c || v.busy || !e) return;
    const text = c.input.value.trim();
    if (!text || text.length > 4000 || text.includes('\0') || new Blob([text]).size > 8192) { set(c.note, 'Write a message of at most 4,000 characters and 8 KB.'); return; }
    v.busy = true; c.send.disabled = true; set(c.send, 'Sending…');
    let r; try { r = await api.teamMessage({ id: e.id, text }); } catch { r = null; }
    v.busy = false;
    if (!v.composer) return;
    c.send.disabled = false; set(c.send, 'Send');
    if (r?.ok === true) { c.input.value = ''; set(c.note, 'Queued by the team hub. Its acknowledgement and reply appear above when they arrive.'); void refresh(); }
    else set(c.note, `Not sent. ${str(r?.error, 300) && r.error ? r.error : 'This session is unavailable. Refresh and try again.'}`);
    c.input.focus();
  }
  function renderSummary(data) {
    const c = data.entries, kids = c.flatMap(e => e.children), f = e => freshNow(e, data).freshness === 'recent';
    const metrics = [[c.length, data.view === 'mine' ? 'My sessions' : 'Shared sessions'], [c.filter(e => f(e) && e.state === 'Working').length, 'Working now'], [[...c, ...kids].filter(e => f(e) && e.input).length, data.view === 'mine' ? 'Waiting on you' : 'Need input'], [kids.length, 'Child agents']];
    return metrics.map(([n, l]) => { const m = el('div', '', 'metric'); m.append(el('strong', String(n)), el('span', l)); return m; });
  }
  function teamFilters(data) {
    for (const f of TEAM_FILTERS) {
      const s = $(`team-${f}-filter`), prev = s.value, values = [...new Set(data.entries.map(e => keyOf(e, f)))].sort((a, b) => a.localeCompare(b));
      s.replaceChildren(Object.assign(el('option', `All`), { value: '' }), ...values.map(x => Object.assign(el('option', x), { value: x })));
      if (prev && !values.includes(prev)) s.append(Object.assign(el('option', `${prev} · none now`), { value: prev }));
      s.value = prev;
    }
  }
  const matches = e => TEAM_FILTERS.every(f => !$(`team-${f}-filter`).value || keyOf(e, f) === $(`team-${f}-filter`).value);
  // Keyed, in-place: an element moves only when its position must change.
  function place(container, nodes) {
    let prev = null;
    for (const n of nodes) { const want = prev ? prev.nextSibling : container.firstChild; if (want !== n) container.insertBefore(n, want); prev = n; }
    while (prev ? prev.nextSibling : container.firstChild) (prev ? prev.nextSibling : container.firstChild).remove();
  }
  function render(which) {
    const l = lists[which], data = l.data; if (!data) return;
    const seen = new Set();
    for (const e of data.entries) { seen.add(e.id); let v = l.rows.get(e.id); if (!v) { v = rowView(which); l.rows.set(e.id, v); } updateRow(v, e, data); }
    for (const [id, v] of l.rows) if (!seen.has(id)) tombstone(v);
    const all = [...l.rows.values()];
    if (which === 'mine') {
      $('mine-summary').replaceChildren(...renderSummary(data));
      place($('mine-list'), all.map(v => v.li));
      set($('mine-count'), `${data.entries.length} ${data.entries.length === 1 ? 'session' : 'sessions'}`);
      $('mine-empty').hidden = all.length > 0;
      return;
    }
    teamFilters(data);
    $('team-summary').replaceChildren(...renderSummary(data));
    const group = $('team-group').value || 'person', groups = new Map();
    for (const v of all) { if (!v.gone && !matches(v.entry)) continue; const k = v.gone ? 'No longer listed' : keyOf(v.entry, group); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(v); }
    if (!l.groups) l.groups = new Map();
    const blocks = [...groups.keys()].sort((a, b) => a === 'No longer listed' ? 1 : b === 'No longer listed' ? -1 : a.localeCompare(b)).map(k => {
      let g = l.groups.get(k); if (!g) { g = { box: el('section', '', 'dir-group'), head: el('h3', k), list: el('ul', '', 'dir-list') }; g.box.append(g.head, g.list); l.groups.set(k, g); }
      g.list.setAttribute('aria-label', k); place(g.list, groups.get(k).map(v => v.li)); return g.box;
    });
    for (const [k, g] of l.groups) if (!groups.has(k)) l.groups.delete(k);
    place($('team-list'), blocks);
    const shown = [...groups.values()].flat().filter(v => !v.gone).length;
    set($('team-count'), `${shown} of ${data.entries.length} shared ${data.entries.length === 1 ? 'session' : 'sessions'}`);
    $('team-empty').hidden = data.entries.length > 0;
  }
  function renderTeams(data) {
    const pick = $('team-pick'), prev = team;
    pick.replaceChildren(...data.teams.map(t => Object.assign(el('option', `${t.name}${t.source === 'fake' ? ` · ${t.label || 'fake team hub'}` : ''}`), { value: t.key })));
    pick.disabled = !data.teams.length;
    if (data.team) { pick.value = data.team.key; team = data.team.key; } else if (prev && data.teams.some(t => t.key === prev)) pick.value = prev;
    set($('team-notice'), data.notice); $('team-notice').hidden = !data.notice;
  }
  async function refresh() {
    if (document.hidden) return;
    const which = view, request = ++read, req = which === 'mine' ? { view: 'mine' } : { view: 'team', team };
    let data; try { data = await api.directory(req); } catch { data = null; }
    if (request !== read || document.hidden || which !== view) return;
    const status = $(`${which}-status`);
    if (!valid(data) || data.view !== which || data.status === 'unavailable') { set(status, 'Session directory is unavailable right now. Showing the last known state.'); return; }
    // Out-of-order answers never replace a newer one.
    if (data.observed_at < received) return; received = data.observed_at;
    const l = lists[which];
    if (which === 'team' && l.data && l.data.team?.key !== data.team?.key) { l.rows.clear(); l.groups?.clear(); $('team-list').replaceChildren(); }
    l.data = data;
    if (which === 'team') renderTeams(data);
    render(which);
    set(status, `Checked ${new Date(data.observed_at).toLocaleTimeString()}. Updates automatically.${data.status === 'partial' ? ' Some activity is unavailable.' : ''}`);
  }
  function show(next) {
    if (view === next) return;
    view = next; read++;
    for (const t of ['mine', 'team']) { const on = t === next; $(`tab-${t}`).setAttribute('aria-selected', String(on)); $(`tab-${t}`).tabIndex = on ? 0 : -1; $(`${t}-section`).hidden = !on; }
    for (const n of document.querySelectorAll('[data-view="mine"]')) n.classList.toggle('view-hidden', next !== 'mine');
    void refresh();
  }
  let pending = null;
  const soon = () => { if (pending) return; pending = setTimeout(() => { pending = null; void refresh(); }, 250); };
  function start(given) {
    hooks = given;
    $('views').hidden = false; $('mine-section').hidden = false;
    for (const t of ['mine', 'team']) $(`tab-${t}`).addEventListener('click', () => show(t));
    $('views').addEventListener('keydown', ev => { if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { const next = view === 'mine' ? 'team' : 'mine'; show(next); $(`tab-${next}`).focus(); } });
    $('team-pick').addEventListener('change', () => { team = hex($('team-pick').value, 32) ? $('team-pick').value : null; received = 0; void refresh(); });
    for (const id of ['team-group', ...TEAM_FILTERS.map(f => `team-${f}-filter`)]) $(id).addEventListener('change', () => render('team'));
    if (typeof api.onDirectoryChanged === 'function') api.onDirectoryChanged(soon);
  }
  window.OverviewDirectory = Object.freeze({ start, refresh, soon, rerender: () => { render('mine'); render('team'); } });
})();
