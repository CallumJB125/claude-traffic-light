'use strict';
// Home's task box (plan-orchestrator O4). Type a task, see who Plexiform picked and why, press Run. Nothing starts
// before Run or ⌘↩ (Callum, 2026-10-24). Main (src/compose-main.js) checks every request; this file renders with
// textContent only and sends folder handles, never paths. The pure rules are in src/compose-view.js.
(() => {
  const api = window.composeApi, CV = window.ComposeView, home = window.homeApi;
  const section = document.getElementById('compose');
  if (!api || !CV || !section) return;
  const $ = (id) => document.getElementById(id);
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const button = (label, onClick, className, id) => { const b = node('button', label, className); b.type = 'button'; if (id) b.id = id; b.addEventListener('click', onClick); return b; };
  const DRAFT_KEY = 'plexiform.compose.draft';
  const ROUTE_DELAY_MS = 400;
  const LINES_MAX = 50;

  let s = CV.initial();
  let folders = [];        // [{handle, label}]: the default and Tasks' recent ones
  let seq = 0, routeTimer = null, stopAsk = false, built = false;
  const status = (t) => { $('compose-status').textContent = t || ''; };
  const keepDraft = () => { try { sessionStorage.setItem(DRAFT_KEY, s.text); } catch { /* storage off */ } };

  // ── route and preflight (read-only) ──
  function scheduleRoute(now = false) {
    clearTimeout(routeTimer);
    if (!CV.routable(s)) { update(); return; }
    update();
    routeTimer = setTimeout(sendRoute, now ? 0 : ROUTE_DELAY_MS);
  }
  async function sendRoute() {
    if (!CV.routable(s)) return update();
    const mine = ++seq, key = CV.inputKey(s);
    s.pending = { key, seq: mine };
    update();
    let r;
    try { r = await api.route({ text: s.text, folder: s.folder.handle, ai: s.ai, permissionLevel: s.perm }); } catch { r = null; }
    if (mine !== seq) return; // a newer request owns the line (finding 8)
    s.pending = null;
    const result = r?.ok ? r.route : { decision: 'refuse', code: r?.code || 'INTERNAL', reason: r?.text || 'Could not check who should do this. Try again.', alternatives: [] };
    s.route = { key, seq: mine, result };
    if (result.decision !== 'ask') s.pick = null;
    update();
  }
  async function checkFolder() {
    const folder = s.folder?.handle;
    s.preflight = null; s.ackPeers = false;
    if (!folder || !s.connected) return update();
    update();
    let r;
    try { r = await api.preflight(folder); } catch { r = null; }
    if (s.folder?.handle !== folder) return;
    s.preflight = r?.ok ? { folder, peers: r.preflight.peers, key: r.preflight.key } : null;
    s.preflightError = r?.ok ? '' : (r?.text || 'Could not check other work in this project.');
    update();
  }

  // ── Run: the only path that starts anything ──
  async function run(overrideBudget = false) {
    const draft = CV.runDraft(s, { requestId: (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^\w-]/g, '').slice(0, 64), overrideBudget });
    if (!draft) return;
    s.busy = true; s.error = ''; update();
    let r;
    try { r = await api.run(draft); } catch { r = null; }
    s.busy = false;
    if (r?.ok) {
      s.task = { id: r.id, title: s.text.trim(), row: null, lines: [] };
      s.text = ''; s.held = null; s.route = null; s.pick = null; s.preflight = null; s.ackPeers = false; keepDraft();
      render(); $('compose-new')?.focus();
      return;
    }
    if (r?.cancelled) return update();
    if (r?.code === 'STARTED_ELSEWHERE') { s.text = ''; s.held = null; s.route = null; s.pick = null; s.preflight = null; s.ackPeers = false; s.error = ''; keepDraft(); render(); status(r.text); return; }
    if (r?.code === 'BUDGET_HELD') { s.held = { text: r.text || 'Your spend cap is reached.' }; return update(); }
    if (r?.code === 'PEERS_CHANGED' && r.preflight) { s.preflight = { folder: s.folder.handle, peers: r.preflight.peers, key: r.preflight.key }; s.ackPeers = false; s.error = r.text; return update(); }
    if (r?.code === 'CONFLICT' || r?.code === 'CONFIRM_REQUIRED') {
      // Who should do it changed since the line was shown (or it is now a tie): nothing started; look again.
      s.error = r?.text && r.code === 'CONFLICT' && /Home changed/.test(r.text) ? r.text : 'Who should do this changed. Nothing was started. Check the line again, then press Run.';
      s.route = null; s.pick = null; scheduleRoute(true); return;
    }
    s.error = r?.text || 'Could not start the task. Try again.';
    update();
  }

  // ── the form ──
  function build() {
    const body = section.querySelector('.body');
    const form = node('div', null, 'compose-form'); form.id = 'compose-form';
    const ta = node('textarea'); ta.id = 'compose-text'; ta.rows = 2; ta.placeholder = 'Give Plexiform a task…'; ta.setAttribute('aria-label', 'What should it do?'); ta.maxLength = CV.TEXT_MAX + 1000;
    ta.value = s.text;
    ta.addEventListener('input', () => { s.text = ta.value; s.error = ''; s.held = null; keepDraft(); scheduleRoute(); });
    ta.addEventListener('keydown', (e) => { if (CV.isSubmitKey(e)) { e.preventDefault(); if (CV.canRun(s)) void run(); } });
    const chips = node('div', null, 'compose-chips');
    const folder = node('select'); folder.id = 'compose-folder'; folder.setAttribute('aria-label', 'Folder');
    folder.addEventListener('change', async () => {
      if (folder.value === '__pick') {
        const f = await api.pickFolder().catch(() => null);
        if (f) { if (!folders.some((x) => x.handle === f.handle)) folders.unshift(f); s.folder = f; }
        fillFolders(); void checkFolder(); scheduleRoute(); return;
      }
      s.folder = folders.find((x) => x.handle === folder.value) || null; void checkFolder(); scheduleRoute();
    });
    const who = node('select'); who.id = 'compose-who'; who.setAttribute('aria-label', 'Who');
    who.addEventListener('change', () => { s.ai = who.value; s.pick = null; fillPerms(); scheduleRoute(); });
    const perm = node('select'); perm.id = 'compose-perm'; perm.setAttribute('aria-label', 'How much it may do');
    perm.addEventListener('change', () => { s.perm = perm.value; scheduleRoute(); });
    chips.append(folder, who, perm);
    const line = node('div', null, 'compose-route'); line.id = 'compose-route'; line.setAttribute('aria-live', 'polite');
    const peers = node('div', null, 'compose-peers'); peers.id = 'compose-peers';
    const held = node('div', null, 'compose-held'); held.id = 'compose-held';
    const foot = node('div', null, 'compose-foot');
    const go = button('Run', () => void run(), 'primary', 'compose-run');
    const more = button('More options in Tasks', () => void home?.navigate('tasks'), '', 'compose-more');
    const err = node('span', '', 'compose-error'); err.id = 'compose-error'; err.setAttribute('role', 'alert');
    foot.append(go, more, err);
    form.append(ta, chips, line, peers, held, foot);
    const card = node('div', null, 'compose-card'); card.id = 'compose-card';
    body.replaceChildren(form, card);
    built = true;
    fillFolders(); fillWho(); fillPerms();
  }
  function fillFolders() {
    const sel = $('compose-folder');
    const opts = folders.map((f) => { const o = node('option', f.label); o.value = f.handle; return o; });
    if (!s.folder) { const o = node('option', 'Choose folder…'); o.value = ''; opts.unshift(o); }
    const pick = node('option', 'Choose another folder…'); pick.value = '__pick'; opts.push(pick);
    sel.replaceChildren(...opts);
    sel.value = s.folder?.handle || '';
  }
  function fillWho() {
    const sel = $('compose-who');
    sel.replaceChildren(...CV.whoOptions(s.ais).map((w) => { const o = node('option', w.label); o.value = w.value; o.disabled = w.disabled; return o; }));
    if (!CV.whoOptions(s.ais).some((w) => w.value === s.ai && !w.disabled)) s.ai = 'auto';
    sel.value = s.ai;
  }
  function fillPerms() {
    const sel = $('compose-perm');
    const opts = CV.permOptions(s.ai);
    if (!opts.some((o) => o.value === s.perm)) s.perm = 'auto-edits';
    sel.replaceChildren(...opts.map((p) => { const o = node('option', p.label); o.value = p.value; return o; }));
    sel.value = s.perm;
  }

  function update() {
    if (!built || s.task) return;
    const v = CV.routeView(s);
    const line = $('compose-route');
    line.className = `compose-route ${v.kind}`;
    line.dataset.kind = v.kind;
    const parts = [];
    if (v.kind !== 'none') parts.push(node('span', v.text, 'compose-route-text'));
    if (v.kind === 'routed') parts.push(button('Change', () => $('compose-who').focus(), 'link', 'compose-change'));
    if (v.kind === 'ask') {
      const box = node('div', null, 'compose-choices');
      for (const c of v.choices) {
        const b = button(c.reason || c.label, () => // the router's reason already starts with the AI's name
 { s.pick = c.ai; update(); }, 'choice');
        b.setAttribute('aria-pressed', String(c.picked)); b.dataset.ai = c.ai; box.append(b);
      }
      parts.push(box);
    }
    if (v.kind === 'refused' && v.canOverride && s.ai !== 'auto') parts.push(button('Run anyway…', () => void run(true), '', 'compose-run-anyway'));
    if (v.kind === 'refused' && v.canOverride && s.ai === 'auto') parts.push(node('span', 'Pick an AI in Who to run it anyway.', 'muted'));
    line.replaceChildren(...parts);

    const p = CV.peersView(s), pe = $('compose-peers');
    pe.replaceChildren();
    if (s.folder && !s.preflight && s.preflightError) pe.append(node('span', s.preflightError, 'warning'), button('Check again', () => void checkFolder(), '', 'compose-recheck'));
    else if (p) {
      pe.append(node('span', p.text, 'warning'));
      if (!p.acknowledged) pe.append(button('Start anyway', () => { s.ackPeers = true; update(); }, '', 'compose-ack'));
      pe.append(button('Review in Tasks', () => void home?.navigate('tasks'), '', 'compose-review-peers'));
    }
    const h = $('compose-held');
    h.replaceChildren();
    if (s.held) h.append(node('span', `Over your spend cap. ${s.held.text}`, 'warning'), button('Run anyway…', () => void run(true), '', 'compose-held-anyway'), button('Spend cap settings', () => void home?.navigate('usage'), '', 'compose-cap-settings'));
    const go = $('compose-run');
    go.disabled = !CV.canRun(s);
    go.textContent = s.busy ? 'Starting…' : 'Run';
    $('compose-error').textContent = s.error || '';
    for (const id of ['compose-text', 'compose-folder', 'compose-who', 'compose-perm']) $(id).disabled = s.busy || !s.connected;
  }

  // ── the running card ──
  function renderCard() {
    const card = $('compose-card'), c = CV.cardView(s.task, Date.now());
    card.replaceChildren();
    if (!c) return;
    card.className = `compose-card ${c.tone}`;
    card.dataset.tone = c.tone;
    card.append(node('strong', c.title, 'title'), node('p', c.status, 'muted compose-card-status'));
    if (c.needsApproval) card.append(node('p', c.approval, 'warning compose-approval'));
    if (c.lines.length) { const ul = node('ul', null, 'compose-lines'); for (const l of c.lines) ul.append(node('li', l)); card.append(ul); }
    const actions = node('div', null, 'actions');
    if (c.needsApproval) actions.append(button('Review in Tasks', () => void api.openInTasks(s.task.id), 'primary', 'compose-review'));
    if (c.canStop && !stopAsk) actions.append(button('Stop', () => { stopAsk = true; renderCard(); }, '', 'compose-stop'));
    if (c.canStop && stopAsk) {
      actions.append(node('span', 'Stop this task? Its work so far is kept.', 'muted'),
        button('Yes, stop', async () => { stopAsk = false; const r = await api.stop(s.task.id, true).catch(() => null); status(r?.ok ? 'Stopping.' : r?.text || 'Could not stop it. Try from Tasks.'); renderCard(); }, '', 'compose-stop-yes'),
        button('Keep going', () => { stopAsk = false; renderCard(); }, '', 'compose-stop-no'));
    }
    if (!c.needsApproval) actions.append(button('Open in Tasks', () => void api.openInTasks(s.task.id), '', 'compose-open'));
    // The task just started is now other work in that folder: the next one checks the folder again.
    actions.append(button('New task', () => { s.task = null; stopAsk = false; render(); void checkFolder(); $('compose-text')?.focus(); }, '', 'compose-new'));
    card.append(actions);
  }

  function render() {
    if (!built) build();
    const form = $('compose-form'), card = $('compose-card');
    form.hidden = !!s.task; card.hidden = !s.task;
    if (s.task) renderCard(); else { $('compose-text').value = s.text; update(); }
  }

  async function load() {
    let info;
    try { info = await api.info(); } catch { info = null; }
    if (!info || info.hidden) { section.hidden = true; s.hidden = true; return; }
    s.hidden = false; section.hidden = false;
    s.connected = info.connected === true;
    s.ais = info.ais || [];
    folders = [...(info.folder ? [info.folder] : []), ...(info.recent || []).filter((r) => r.handle !== info.folder?.handle)];
    if (!s.folder || !folders.some((f) => f.handle === s.folder.handle)) s.folder = info.folder || null;
    if (info.task && (!s.task || s.task.id !== info.task.id)) s.task = { id: info.task.id, title: info.task.title, row: info.task.row, lines: [] };
    if (!built) { try { s.text = sessionStorage.getItem(DRAFT_KEY) || ''; } catch { s.text = ''; } }
    $('compose-hint').textContent = info.shortcut?.state === 'on' && info.shortcut.accelerator ? `${info.shortcut.accelerator} from anywhere` : '';
    if (!built) build(); else { fillFolders(); fillWho(); fillPerms(); }
    render();
    void checkFolder();
    scheduleRoute(true);
  }

  api.onFocus(() => { if (s.hidden) return; (s.task ? $('compose-new') : $('compose-text'))?.focus(); });
  api.onEvent((m) => {
    if (!s.task || !m || m.id !== s.task.id || typeof m.line !== 'string') return;
    s.task.lines.push(m.line.slice(0, 200)); if (s.task.lines.length > LINES_MAX) s.task.lines.shift();
    renderCard();
  });
  api.onTask((m) => {
    if (!s.task || !m || m.id !== s.task.id) return;
    s.task.row = m.row || null; s.connected = m.connected !== false;
    renderCard();
  });
  api.onChanged?.(() => { void load(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
  void load();
})();
