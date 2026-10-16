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
  const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
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
    && (e.notice === undefined || str(e.notice, 600)) && (e.messageContract === undefined || ['live', 'task-inbox'].includes(e.messageContract))
    && (e.deliveries === undefined || Array.isArray(e.deliveries) && e.deliveries.length <= 10 && e.deliveries.every(d => obj(d) && str(d.id, 80) && str(d.text, 4000) && (d.by === null || str(d.by, 80)) && str(d.state, 40) && str(d.response, 4000)))
    && (e.handoffs === undefined || Array.isArray(e.handoffs) && e.handoffs.length <= 10 && e.handoffs.every(h => obj(h) && ['in', 'out'].includes(h.direction) && str(h.with, 80) && str(h.state, 40) && str(h.summary, 400)));
  const valid = d => obj(d) && d.schema === 1 && ['mine', 'team'].includes(d.view) && ['complete', 'partial', 'unavailable'].includes(d.status) && Number.isFinite(d.observed_at) && str(d.notice, 600)
    && Array.isArray(d.teams) && d.teams.length <= 64 && d.teams.every(t => obj(t) && hex(t.key, 32) && str(t.name, 200) && ['hub', 'fake', 'adapter'].includes(t.source) && str(t.label, 200))
    && (d.team === null || obj(d.team) && hex(d.team.key, 32) && str(d.team.name, 200)) && Array.isArray(d.entries) && d.entries.length <= 300 && d.entries.every(validEntry) && new Set(d.entries.map(e => e.id)).size === d.entries.length;
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const set = (n, v) => { if (n.textContent !== v) n.textContent = v; };
  const button = (label, fn) => { const b = el('button', label); b.type = 'button'; b.addEventListener('click', fn); return b; };
  const OPERATIONS = ['send', 'steer', 'interrupt'];
  const ACTIVITY_LABELS = ['Thinking', 'Running a command', 'Editing files', 'Reading files', 'Searching', 'Using a tool', 'Coordinating agents'];
  const OP_LABEL = { send: 'Send a message', steer: 'Steer current turn', interrupt: 'Interrupt current turn' };
  const FINAL_LABEL = { send: 'Send message', steer: 'Steer this turn', interrupt: 'Interrupt this turn' };
  const validInspection = r => obj(r) && r.ok === true && uuid(r.selection) && obj(r.state) && obj(r.state.provider) && str(r.state.provider.label, 200)
    && str(r.state.status, 80) && Number.isSafeInteger(r.state.generation) && r.state.generation >= 0 && (r.state.activeTurn === null || uuid(r.state.activeTurn))
    && Array.isArray(r.state.deliveries) && r.state.deliveries.length <= 20 && r.state.deliveries.every(d => obj(d) && str(d.id, 100) && str(d.text, 4000) && str(d.state, 80) && str(d.response, 16000)
      && (d.by === null || d.by === undefined || str(d.by, 80)) && (d.error === null || d.error === undefined || str(d.error, 1000)) && (d.notices === undefined || Array.isArray(d.notices) && d.notices.length <= 5 && d.notices.every(n => str(n, 1000))))
    && obj(r.capabilities) && OPERATIONS.every(op => validCap(r.capabilities[op]));

  let hooks = null, view = 'mine', team = null, read = 0, received = 0, selected = null;
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
    const meta = el('p', '', 'row-meta'), badges = el('p', '', 'badges'), when = el('p', '', 'muted'), activity = el('p', '', 'dir-activity'), self = el('p', '', 'muted');
    const children = el('ul', '', 'agent-list'), handoffs = el('ul', '', 'handoffs'), deliveries = el('ol', '', 'deliveries');
    children.setAttribute('aria-label', 'Child agents'); handoffs.setAttribute('aria-label', 'Handoffs'); deliveries.setAttribute('aria-label', 'Messages and responses');
    const actions = el('div', '', 'actions'), why = el('p', '', 'reason'), notice = el('p', '', 'reason'); notice.setAttribute('role', 'status');
    const details = el('details', '', 'caps'), capList = el('ul', '', 'cap-list'); details.append(el('summary', 'What Plexiform can do with this session'), capList);
    li.append(head, meta, badges, when, activity, self, children, handoffs, deliveries, actions, why, notice, details);
    return { li, avatar, title, owner, tag, meta, badges, when, activity, self, children, handoffs, deliveries, actions, why, notice, capList, details, kind, composer: null, gone: false, entry: null };
  }
  function updateRow(v, e, data) {
    v.entry = e; v.gone = false; v.li.classList.remove('gone');
    const f = freshNow(e, data);
    set(v.avatar, e.owner.initials); v.avatar.hidden = e.owner.self && data.view === 'mine';
    set(v.title, e.task.source === 'unknown' ? `${e.provider.label} session` : e.task.title);
    if (selected?.row === v) set(selected.target, `${e.owner.name} · ${e.provider.label} · ${v.title.textContent}`);
    set(v.owner, `${e.owner.self ? 'You' : e.owner.name}${e.task.source === 'human' ? ' · task title edited by a person' : e.task.source === 'unknown' ? ' · task not reported' : ''}`);
    set(v.tag, stateText(e, f)); v.tag.className = `tag ${tone(e, f)}`;
    set(v.meta, [e.provider.label + (e.provider.kind === 'local' ? ' · local model' : ''), e.device.label + (e.device.local && e.device.label !== 'This device' ? ' (this device)' : ''), e.board.label, e.card?.key ? `Card ${e.card.key}` : ''].filter(Boolean).join(' · '));
    set(v.badges, [...e.teams.map(t => `Team: ${t.name}`), ...e.provenance.map(p => PROVENANCE[p])].join(' · '));
    set(v.when, `Last observed ${age(f.ageMs)}${f.freshness === 'stale' ? ' · stale' : f.freshness === 'unknown' ? ' · freshness unknown' : ''}`);
    set(v.activity, activityText(e.activity)); v.activity.hidden = !v.activity.textContent;
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
    if (api.followups && !v.followup) { v.followup = button('Prepare follow-up', () => void composeFollowup(v)); v.actions.append(v.followup); }
    if (v.followup) v.followup.hidden = !canMessage || !['owned', 'team'].includes(e.interact?.kind) || e.messageContract === 'task-inbox';
    if (v.kind === 'team' && !v.inspect) {
      v.inspect = button('Show activity', () => void openActivity(v));
      v.actions.prepend(v.inspect);
    }
    if (v.inspect) { v.inspect.hidden = false; v.inspect.setAttribute('aria-expanded', String(selected?.row === v)); v.inspect.setAttribute('aria-label', `Show activity: ${v.title.textContent}`); }
    set(v.why, canMessage ? e.notice || '' : e.capabilities.receive.reason || 'No supported message channel.'); v.why.hidden = canMessage && !e.notice;
    if (v.composer && (!canMessage || e.interact?.kind !== 'team')) { v.composer.box.remove(); v.composer = null; }
  }
  function tombstone(v) {
    if (v.gone) return; v.gone = true; v.li.classList.add('gone');
    if (selected?.row === v) clearActivity();
    const e = v.entry, shared = e.kind === 'shared';
    // A row that left a team view keeps no task details: it may no longer be shared.
    set(v.title, shared ? `${e.owner.name}'s ${e.provider.label} session` : v.title.textContent);
    set(v.tag, 'No longer listed'); v.tag.className = 'tag stale';
    set(v.meta, shared ? '' : v.meta.textContent);
    for (const n of [v.badges, v.activity, v.self, v.children, v.handoffs, v.deliveries, v.details]) n.hidden = true;
    set(v.activity, '');
    if (shared) for (const n of [v.children, v.handoffs, v.deliveries, v.capList]) n.replaceChildren();
    set(v.when, shared ? 'No longer shared with you, or it ended.' : 'No longer reported. It ended, or its reports stopped.');
    v.composer?.box.remove(); v.composer = null; v.message.hidden = true; v.why.hidden = true;
    v.followupDraft?.box.remove(); v.followupDraft = null; if (v.followup) v.followup.hidden = true;
    if (v.inspect) v.inspect.hidden = true;
    if (!v.dismiss) { v.dismiss = button('Dismiss', () => { v.li.remove(); for (const l of Object.values(lists)) for (const [id, x] of l.rows) if (x === v) l.rows.delete(id); }); v.actions.append(v.dismiss); }
  }
  async function interact(v) {
    const e = v.entry; if (!e || v.gone || !e.interact || !hooks) return;
    if (e.interact.kind === 'owned') { show('mine'); hooks.focusOwned(e.interact.ref); return; }
    if (e.interact.kind === 'work') { show('mine'); hooks.composeWork(e.interact.ref); return; }
    if (typeof api.teamInspect === 'function' && typeof api.teamAction === 'function') {
      const a = await openActivity(v);
      if (!a || v.gone || view !== 'team' || selected !== a) return;
      if (a?.inspection) { a.input.focus(); return; }
      // A temporary failure on a live connection must never downgrade to the
      // legacy message path and skip the inspected target review.
      if (a.inspectionStatus !== 'unsupported' && e.messageContract !== 'task-inbox') return;
      if (selected === a) clearActivity();
    }
    if (v.composer) { v.composer.input.focus(); return; }
    const box = el('div', '', 'composer'), label = el('label', `Message ${e.owner.name}'s session`), input = el('textarea');
    input.id = `team-msg-${e.id}`; label.htmlFor = input.id; input.maxLength = 4000;
    const note = el('p', e.notice || 'Sends your exact text through the team hub to this shared session only. Maximum 4,000 characters.', 'reason'); note.setAttribute('role', 'status');
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
    if (r?.ok === true) { c.input.value = ''; set(c.note, e.messageContract === 'task-inbox' ? 'Queued in this board run’s task inbox. The agent has not acknowledged it yet. Receipt and reply appear above when reported.' : 'Queued by the team hub. Its acknowledgement and reply appear above when they arrive.'); void refresh(); }
    else set(c.note, `${r?.status === 'unconfirmed' ? 'Receipt unconfirmed.' : 'Not sent.'} ${str(r?.error, 300) && r.error ? r.error : 'This session is unavailable. Refresh and try again.'}`);
    c.input.focus();
  }
  async function composeFollowup(v) {
    if (v.gone || !api.followups || !v.entry) return;
    if (v.followupDraft) { v.followupDraft.input.focus(); return; }
    const box = el('section', '', 'composer followup-composer'), label = el('label', `Follow-up for ${v.title.textContent}`), input = el('textarea');
    input.id = `followup-${v.entry.id}`; input.maxLength = 4000; label.htmlFor = input.id;
    const note = el('p', 'Prepare one new turn for this original session. Review before queuing; nothing is sent while drafting.', 'reason'); note.setAttribute('role', 'status');
    const review = el('div', '', 'followup-review'); review.hidden = true;
    const exactTarget = el('p', '', 'team-target'), exactText = el('p', '', 'delivery-text'), terms = el('p', '', 'reason');
    const d = { box, input, note, review, selection: null, busy: false, requestId: null, revision: 0 };
    const prepare = button('Review follow-up', async () => {
      const text = input.value.trim();
      if (d.busy || v.gone) return;
      if (!text || text.length > 4000 || text.includes('\0') || new Blob([text]).size > 8192) { set(note, 'Write a message of at most 4,000 characters and 8 KB.'); return; }
      d.busy = true; prepare.disabled = true;
      const revision = d.revision;
      let r; try { r = await api.followups.review({ id: v.entry.id }); } catch { r = null; }
      d.busy = false; prepare.disabled = false;
      if (v.followupDraft !== d || v.gone || revision !== d.revision) return;
      if (!r?.ok || !uuid(r.selection) || !str(r.label, 240) || !str(r.notice, 1000)) { set(note, r?.error || 'This session cannot accept a queued new turn.'); return; }
      d.selection = r.selection; d.text = text; d.requestId = crypto.randomUUID();
      set(exactTarget, r.label); set(exactText, text); set(terms, r.notice); review.hidden = false; confirm.focus();
    });
    const confirm = button('Queue next turn', async () => {
      if (d.busy || !d.selection || v.gone) return;
      d.busy = true; confirm.disabled = true; prepare.disabled = true;
      let r; try { r = await api.followups.enqueue({ selection: d.selection, requestId: d.requestId, text: d.text }); } catch { r = null; }
      d.busy = false; confirm.disabled = false; prepare.disabled = false; d.selection = null; review.hidden = true;
      if (v.followupDraft !== d) return;
      if (r?.ok) { input.value = ''; set(note, 'Queued locally. Provider acknowledgement and any blocked reason appear in Follow-ups below.'); void refreshFollowups(); }
      else set(note, r?.error || 'Could not save this follow-up. Review the original session again.');
    });
    const back = button('Back to draft', () => { d.selection = null; review.hidden = true; input.focus(); });
    const close = button('Close draft', () => { if (d.busy) return; box.remove(); v.followupDraft = null; v.followup.focus(); });
    const actions = el('div', '', 'actions'), finalActions = el('div', '', 'actions'); actions.append(prepare, close); finalActions.append(confirm, back);
    review.append(exactTarget, exactText, terms, finalActions); box.append(label, input, note, actions, review);
    input.addEventListener('input', () => { d.revision++; d.selection = null; review.hidden = true; });
    v.followupDraft = d; v.li.insertBefore(box, v.why); input.focus();
  }
  let followupPanel = null, followupRead = 0, displayedFollowupScope;
  const followupRows = new Map();
  async function refreshFollowups() {
    if (!followupPanel || document.hidden) return;
    const ticket = ++followupRead;
    let r; try { r = await api.followups.list(); } catch { r = null; }
    if (ticket !== followupRead || document.hidden) return;
    const statuses = ['queued', 'blocked', 'sending', 'acknowledged', 'unconfirmed', 'refused', 'cancelled', 'expired'];
    const validItems = r?.ok && Array.isArray(r.items) && r.items.length <= 16 && r.items.every(i => obj(i) && uuid(i.id) && str(i.label, 240) && str(i.text, 4000) && statuses.includes(i.status) && str(i.reason, 600));
    if (!validItems) { followupPanel.list.replaceChildren(); followupRows.clear(); set(followupPanel.status, str(r?.error, 1000) ? r.error : 'Follow-ups are unavailable for this account.'); return; }
    set(followupPanel.status, r.items.length ? 'Saved encrypted on this Mac. Acknowledged means the provider accepted the message; open its session for responses.' : 'No saved follow-ups on this account and board.');
    const seen = new Set();
    for (const item of r.items) {
      seen.add(item.id); let row = followupRows.get(item.id);
      if (!row) {
        const box = el('li', '', 'delivery'), title = el('strong'), state = el('span', '', 'tag'), text = el('p', '', 'delivery-text'), why = el('p', '', 'reason'), actions = el('div', '', 'actions');
        const act = async method => { if (row.busy) return; row.busy = true; cancel.disabled = true; discard.disabled = true; let result; try { result = await api.followups[method]({ id: item.id }); } catch {} row.busy = false; if (!result?.ok) set(why, result?.error || 'The action could not be confirmed.'); else await refreshFollowups(); };
        const cancel = button('Cancel follow-up', () => void act('cancel')), discard = button('Discard saved copy', () => void act('discard'));
        actions.append(cancel, discard); box.append(title, state, text, why, actions); row = { box, title, state, text, why, cancel, discard, busy: false }; followupRows.set(item.id, row);
      }
      set(row.title, item.label); set(row.state, item.status); set(row.text, item.text);
      const receipt = obj(item.receipt) && str(item.receipt.id, 100) && str(item.receipt.state, 80) ? ` Provider receipt ID: ${item.receipt.id} (${item.receipt.state}).` : '';
      const expiry = ['queued', 'blocked', 'refused'].includes(item.status) && Number.isSafeInteger(item.expiresAt) ? ` Unsent text expires ${new Date(item.expiresAt).toLocaleString()}.` : '';
      set(row.why, item.reason + receipt + expiry);
      row.cancel.hidden = !['queued', 'blocked', 'refused'].includes(item.status); row.cancel.disabled = row.busy; row.discard.disabled = row.busy || item.status === 'sending';
      row.discard.title = 'Removes only this saved copy. It cannot undo work already sent to a provider.';
    }
    for (const [id, row] of followupRows) if (!seen.has(id)) { row.box.remove(); followupRows.delete(id); }
    place(followupPanel.list, r.items.map(i => followupRows.get(i.id).box));
  }
  // One selected session at a time. Reads refresh its visible activity; the
  // final action keeps the exact main-owned preview token the person reviewed.
  // No provider/session routing identifiers are constructed in this page.
  function clearActivity() {
    const a = selected; selected = null;
    if (!a) return;
    a.read++; a.preview = null; a.inspection = null; a.input.value = '';
    a.transcript.replaceChildren(); set(a.reviewText, ''); set(a.reviewTarget, ''); set(a.activity, '');
    a.box.remove(); a.row.li.classList.remove('selected');
    a.row.inspect?.setAttribute('aria-expanded', 'false');
  }
  function activityText(activity) {
    if (!obj(activity) || !ACTIVITY_LABELS.includes(activity.label)) return '';
    const at = activity.observed_at ?? activity.observedAt;
    const stale = activity.freshness !== undefined && activity.freshness !== 'recent' || !Number.isFinite(at) || Date.now() - at > 90_000;
    return `${stale || activity.phase === 'completed' ? 'Last reported' : 'Now'}: ${activity.label}${Number.isFinite(at) ? ` · ${age(Math.max(0, Date.now() - at))}` : ''}`;
  }
  function activitySummary(a, state = null) {
    const e = a.row.entry, task = state?.reporting?.task?.title || state?.task_title;
    const activity = state?.activity ?? e.activity;
    const reported = activityText(activity);
    set(a.activity, [reported, str(task, 400) && task ? `Task: ${task}` : ''].filter(Boolean).join('\n'));
    a.activity.hidden = !a.activity.textContent;
  }
  function renderConversation(a, deliveries) {
    const sig = JSON.stringify(deliveries);
    if (a.deliverySig === sig) return;
    a.deliverySig = sig;
    const follow = a.transcript.scrollHeight - a.transcript.scrollTop - a.transcript.clientHeight < 80;
    const messages = deliveries.map(d => {
      const li = el('li', '', 'delivery'), head = el('div', '', 'delivery-head');
      head.append(el('strong', `${d.by ? `Sent by ${d.by}` : 'Message'}${d.mode === 'steer' ? ' (steer)' : ''}`), el('span', d.state, `tag ${d.state}`));
      li.append(head, el('p', d.text, 'delivery-text'));
      if (d.recorded === true) li.append(el('p', 'The provider echoed this exact message text.', 'reason'));
      else if (d.state === 'acknowledged') li.append(el('p', 'The provider accepted this message; its exact text has not been echoed yet.', 'reason'));
      if (d.response) {
        if (d.mode === 'steer') li.append(el('p', 'Turn output after this message. This does not confirm the requested change was applied.', 'reason'));
        li.append(el('p', d.response, 'delivery-response'));
      }
      else if (['acknowledged', 'recorded', 'responding'].includes(d.state)) li.append(el('p', 'Provider receipt reported; waiting for response text.', 'reason'));
      else if (['queued', 'sending'].includes(d.state)) li.append(el('p', 'Queued; the agent has not acknowledged this message yet.', 'reason'));
      else if (['unconfirmed', 'unknown'].includes(d.state)) li.append(el('p', 'Receipt unconfirmed. The agent may still act; do not resend automatically.', 'reason'));
      if (d.error) li.append(el('p', d.error, 'reason'));
      for (const n of d.notices ?? []) li.append(el('p', n, 'reason'));
      return li;
    });
    a.transcript.replaceChildren(...(messages.length ? messages : [el('li', 'No conversation messages have been reported for this shared session.', 'muted')]));
    if (follow) a.transcript.scrollTop = a.transcript.scrollHeight;
  }
  function renderActivityControls(a) {
    const r = a.inspection;
    for (const op of OPERATIONS) {
      a.buttons[op].disabled = !!a.busy || !r?.capabilities[op].available;
      const reason = r?.capabilities[op].reason;
      a.buttons[op].title = str(reason, 600) ? reason : '';
    }
    const canDraft = !!r && r.state.status !== 'ended' && r.state.capabilities?.newTurn === true;
    const mayWrite = canDraft || !!r && OPERATIONS.slice(0, 2).some(op => r.capabilities[op].available);
    if (r) a.canDraft = mayWrite;
    a.input.disabled = !!a.busy || !(r ? mayWrite : a.canDraft);
    const waitingDraft = canDraft && r.state.status === 'working' && !r.capabilities.send.available && !r.capabilities.steer.available;
    set(a.draftHint, waitingDraft ? 'Keep a draft while this turn finishes. Send becomes available when idle; drafts are not queued or sent automatically.' : '');
    a.draftHint.hidden = !waitingDraft;
    const reasons = r ? OPERATIONS.filter(op => !r.capabilities[op].available).map(op => `${OP_LABEL[op]}: ${r.capabilities[op].reason}`) : [];
    set(a.limits, reasons.join(' '));
  }
  async function inspectActivity(a) {
    if (selected !== a || view !== 'team' || document.hidden || a.row.gone || a.reading) return;
    const request = ++a.read; a.reading = true; a.recheck.disabled = true;
    let r; try { r = typeof api.teamInspect === 'function' ? await api.teamInspect({ id: a.row.entry.id }) : null; } catch { r = null; }
    a.reading = false; a.recheck.disabled = false;
    if (selected !== a || request !== a.read || view !== 'team' || document.hidden || a.row.gone) return;
    if (!validInspection(r)) {
      a.inspection = null;
      a.preview = null; a.review.hidden = true;
      a.inspectionStatus = typeof api.teamInspect !== 'function' ? 'unsupported' : str(r?.status, 80) ? r.status : 'unavailable';
      a.composer.hidden = !a.hasLive;
      if (r?.status === 'stale' || r?.status === 'forbidden') {
        tombstone(a.row); void refresh(); return;
      } else { activitySummary(a); renderConversation(a, a.row.entry.deliveries ?? []); }
      set(a.status, str(r?.error, 600) && r.error ? r.error : 'Live conversation is unavailable for this connection. Activity comes from the last directory report.');
      if (a.hasLive) set(a.note, 'Live state could not be refreshed. Your draft is kept; check activity before reviewing an action.');
      renderActivityControls(a); return;
    }
    a.inspection = r; a.inspectionStatus = 'ready'; a.hasLive = true; a.composer.hidden = false; activitySummary(a, r.state); renderConversation(a, r.state.deliveries);
    set(a.status, `${r.state.provider.label} · ${r.state.status}${r.state.activeTurn ? ' · current turn running' : ''} · checked ${new Date().toLocaleTimeString()}. Updates automatically.`);
    // A live read can invalidate a prepared action, but never silently retarget it.
    if (a.preview && (a.preview.generation !== r.state.generation || a.preview.turn !== r.state.activeTurn || !r.capabilities[a.preview.operation].available)) {
      a.preview = null; a.review.hidden = true;
      set(a.note, 'This session moved on. Your draft is kept; review it again for the current session state.');
    }
    renderActivityControls(a);
  }
  async function openActivity(v) {
    if (!v.entry || v.gone || view !== 'team') return null;
    if (selected?.row === v) { await inspectActivity(selected); return selected; }
    clearActivity();
    // A legacy task-inbox composer must not coexist with the live composer.
    v.composer?.box.remove(); v.composer = null;
    const box = el('section', '', 'team-activity'), heading = el('div', '', 'row-heading'), title = el('h4', 'Session activity');
    box.id = `team-activity-${v.entry.id}`; box.setAttribute('aria-label', `Selected session: ${v.title.textContent}`); title.tabIndex = -1;
    v.inspect?.setAttribute('aria-controls', box.id);
    const close = button('Close activity', () => { clearActivity(); v.inspect?.focus(); }), recheck = button('Check activity', () => void inspectActivity(a));
    const readActions = el('div', '', 'actions'); readActions.append(recheck, close); heading.append(title, readActions);
    const target = el('p', `${v.entry.owner.name} · ${v.entry.provider.label} · ${v.title.textContent}`, 'team-target');
    const status = el('p', 'Reading this shared session…', 'reason');
    const activity = el('p', '', 'team-current-activity');
    const transcript = el('ol', '', 'deliveries team-conversation'); transcript.setAttribute('aria-label', `Conversation: ${v.title.textContent}`); transcript.tabIndex = 0;
    const composer = el('div', '', 'composer'), label = el('label', 'Message this session'), input = el('textarea'); composer.hidden = true; input.id = `team-live-${v.entry.id}`; label.htmlFor = input.id; input.maxLength = 4000;
    const note = el('p', 'Your exact text goes to this shared session. Review the target and action before sending.', 'reason'); note.setAttribute('role', 'status');
    const draftHint = el('p', '', 'reason'); draftHint.hidden = true;
    const actions = el('div', '', 'actions'), buttons = {};
    for (const op of OPERATIONS) { buttons[op] = button(OP_LABEL[op], () => prepareAction(a, op)); actions.append(buttons[op]); }
    const limits = el('p', '', 'reason'), review = el('section', '', 'team-action-review'); review.hidden = true;
    const reviewTarget = el('p', '', 'team-target'), reviewText = el('p', '', 'delivery-text'), final = button('Confirm', () => void commitAction(a));
    const cancel = button('Back to draft', () => { a.preview = null; review.hidden = true; input.focus(); });
    const reviewActions = el('div', '', 'actions'); reviewActions.append(final, cancel); review.append(reviewTarget, reviewText, reviewActions);
    composer.append(label, input, draftHint, note, actions, limits, review); box.append(heading, target, status, activity, transcript, composer);
    const a = { row: v, box, target, status, activity, transcript, composer, input, draftHint, note, buttons, limits, review, reviewTarget, reviewText, final, cancel, recheck, read: 0, reading: false, inspection: null, inspectionStatus: null, hasLive: false, canDraft: false, preview: null, busy: false };
    selected = a; v.li.classList.add('selected'); v.inspect?.setAttribute('aria-expanded', 'true'); v.li.insertBefore(box, v.why); title.focus();
    input.addEventListener('input', () => { if (a.preview) { a.preview = null; review.hidden = true; } });
    box.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      if (a.preview && !a.busy) { a.preview = null; review.hidden = true; input.focus(); }
      else { clearActivity(); v.inspect?.focus(); }
    });
    activitySummary(a); renderActivityControls(a); await inspectActivity(a); return selected === a ? a : null;
  }
  function prepareAction(a, operation) {
    if (selected !== a || a.busy || !a.inspection?.capabilities[operation].available) return;
    const text = operation === 'interrupt' ? '' : a.input.value.trim();
    if (operation !== 'interrupt' && (!text || text.length > 4000 || text.includes('\0') || new Blob([text]).size > 8192)) { set(a.note, 'Write a message of at most 4,000 characters and 8 KB.'); a.input.focus(); return; }
    const r = a.inspection;
    a.preview = { selection: r.selection, operation, text, generation: r.state.generation, turn: r.state.activeTurn };
    set(a.reviewTarget, `${FINAL_LABEL[operation]} to ${a.row.entry.owner.name}'s ${r.state.provider.label} session: ${a.row.title.textContent}${operation !== 'send' ? ' · this current turn only' : ''}`);
    set(a.reviewText, operation === 'interrupt' ? 'Requests the provider to stop the current turn. Work already performed can remain.' : text);
    set(a.final, FINAL_LABEL[operation]); a.review.hidden = false; a.final.focus();
  }
  async function commitAction(a) {
    const p = a.preview;
    if (selected !== a || !p || a.busy || typeof api.teamAction !== 'function') return;
    a.busy = true; a.final.disabled = true; a.cancel.disabled = true; renderActivityControls(a);
    let r; try { r = await api.teamAction({ selection: p.selection, operation: p.operation, text: p.text }); } catch { r = { ok: false, status: 'unconfirmed' }; }
    if (selected !== a) return;
    a.busy = false; a.preview = null; a.review.hidden = true; a.final.disabled = false; a.cancel.disabled = false;
    if (r?.ok === true) {
      if (p.operation !== 'interrupt') a.input.value = '';
      const receipt = str(r.delivery?.state, 80) ? r.delivery.state : str(r.status, 80) ? r.status : 'accepted';
      set(a.note, p.operation === 'interrupt' ? 'Interrupt request accepted by the provider. Check its reported state below.' : `Provider result: ${receipt}. Receipt and response text are shown as they are reported.`);
    } else {
      const uncertain = r?.status === 'unconfirmed';
      set(a.note, `${uncertain ? 'Receipt unconfirmed. The agent may still act; do not resend automatically.' : 'Action refused. Your draft is kept.'}${str(r?.error, 600) && r.error ? ` ${r.error}` : ''}`);
      if (r?.status === 'forbidden') a.input.value = '';
    }
    await inspectActivity(a); void refresh();
    if (selected === a && !a.input.disabled) a.input.focus();
  }
  function renderSummary(data) {
    const c = data.entries, kids = c.flatMap(e => e.children), f = e => freshNow(e, data).freshness === 'recent';
    const metrics = [[c.length, data.view === 'mine' ? 'My sessions' : 'Shared sessions'], [c.filter(e => f(e) && e.state === 'Working').length, 'Working now'], [[...c, ...kids].filter(e => f(e) && e.input).length, data.view === 'mine' ? 'Need you' : 'Need input'], [kids.length, 'Child agents']];
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
    if (!valid(data) || data.view !== which || data.status === 'unavailable') { clearActivity(); followupRead++; if (followupPanel) { followupPanel.list.replaceChildren(); followupRows.clear(); set(followupPanel.status, 'Follow-ups are hidden while the current account cannot be verified.'); } set(status, 'Session directory is unavailable right now. Showing the last known state.'); return; }
    if (data.followupScope !== undefined && data.followupScope !== displayedFollowupScope) {
      displayedFollowupScope = data.followupScope; followupRead++;
      if (followupPanel) { followupPanel.list.replaceChildren(); followupRows.clear(); set(followupPanel.status, 'Checking follow-ups for the current account and board…'); }
      for (const l of Object.values(lists)) for (const v of l.rows.values()) if (v.followupDraft) { v.followupDraft.revision++; v.followupDraft.input.value = ''; v.followupDraft.box.remove(); v.followupDraft = null; }
    }
    // Out-of-order answers never replace a newer one.
    if (data.observed_at < received) return; received = data.observed_at;
    const l = lists[which];
    if (which === 'team' && l.data && l.data.team?.key !== data.team?.key) { clearActivity(); l.rows.clear(); l.groups?.clear(); $('team-list').replaceChildren(); }
    l.data = data;
    if (which === 'team') renderTeams(data);
    render(which);
    void refreshFollowups();
    if (which === 'team' && selected) void inspectActivity(selected);
    set(status, `Checked ${new Date(data.observed_at).toLocaleTimeString()}. Updates automatically.${data.status === 'partial' ? ' Some activity is unavailable.' : ''}`);
  }
  function show(next) {
    if (view === next) return;
    clearActivity();
    followupRead++; if (followupPanel) { followupPanel.list.replaceChildren(); followupRows.clear(); }
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
    if (api.followups && typeof api.followups.list === 'function') {
      const box = el('section', '', 'directory session-followups'), title = el('h2', 'Follow-ups on this account and board'), status = el('p', '', 'reason'), list = el('ol', '', 'deliveries');
      box.id = 'session-followups'; box.setAttribute('aria-label', 'Saved session follow-ups'); status.setAttribute('role', 'status'); list.setAttribute('aria-label', 'Follow-up queue'); box.append(title, status, list); $('mine-section').before(box); followupPanel = { box, status, list };
    }
    for (const t of ['mine', 'team']) $(`tab-${t}`).addEventListener('click', () => show(t));
    $('views').addEventListener('keydown', ev => { if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { const next = view === 'mine' ? 'team' : 'mine'; show(next); $(`tab-${next}`).focus(); } });
    $('team-pick').addEventListener('change', () => { clearActivity(); lists.team.rows.clear(); lists.team.groups?.clear(); $('team-list').replaceChildren(); team = hex($('team-pick').value, 32) ? $('team-pick').value : null; received = 0; void refresh(); });
    for (const id of ['team-group', ...TEAM_FILTERS.map(f => `team-${f}-filter`)]) $(id).addEventListener('change', () => { clearActivity(); render('team'); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && selected) { selected.preview = null; selected.review.hidden = true; } });
    if (typeof api.onDirectoryChanged === 'function') api.onDirectoryChanged(soon);
  }
  window.OverviewDirectory = Object.freeze({ start, refresh, soon, rerender: () => { render('mine'); render('team'); } });
})();
