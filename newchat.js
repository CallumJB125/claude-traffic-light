'use strict';
// The new-chat screen (chat-first preview, redesign R2b-2). Home's task box on a page of its own: type, see who
// Plexiform picked and why, press Send. Nothing starts before Send or ⌘↩; Enter is a newline. Main
// (src/newchat-main.js) checks every request and, once the chat has started, opens its thread itself: this page
// never names where it goes. textContent only; folder handles, never paths. The rules are src/compose-view.js.
(() => {
  const api = window.newChatApi, CV = window.ComposeView;
  const $ = (id) => document.getElementById(id);
  if (!api || !CV || !$('nc-box')) return;
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const button = (label, onClick, className, id) => { const b = node('button', label, className); b.type = 'button'; if (id) b.id = id; b.addEventListener('click', onClick); return b; };
  const DRAFT_KEY = 'plexiform.newchat.draft';
  const ROUTE_DELAY_MS = 400;
  const TEXT = {
    sending: 'Starting…',
    cancelled: 'Nothing was started.',
    changed: 'Who should do this changed. Nothing was started. Check the line again, then press Send.',
    failed: 'Could not start the chat. Try again.',
    offline: 'Plexiform’s helper isn’t running. Start it from Tasks, then try again.',
    startedHere: 'It’s running. It shows in the sidebar once Plexiform lists it.',
    checkFailed: 'Could not check other work in this project.',
  };

  // R7-1 (plan-r7 §1): the new chat stands in for Home. A summary line and up to 3 Needs-you rows (Open only), or on
  // a first run a greeting and starters. A starter only fills an empty box; Send still sends. Main (src/newchat-home-main.js)
  // gives the rows and starters and opens a row itself; this page sends back only a row id it was given.
  const HOME_POLL_MS = 5000;
  const GREETING = 'What should your AI work on?';
  const plural = (n, one, many) => (n === 1 ? one : many);
  let home = null, starters = [], startersFor = null, homeTimer = null;

  let s = CV.initial();
  let folders = [];
  let seq = 0, routeTimer = null, started = null; // started: {id} while the "Started." fallback shows
  const keepDraft = () => { try { sessionStorage.setItem(DRAFT_KEY, s.text); } catch { /* storage off */ } };
  const note = (text, tone) => { const n = $('nc-note'); n.textContent = text || ''; if (tone) n.dataset.tone = tone; else delete n.dataset.tone; };

  // ── route and preflight (read-only) ──
  function scheduleRoute(now = false) {
    clearTimeout(routeTimer);
    update();
    if (!CV.routable(s)) return;
    routeTimer = setTimeout(sendRoute, now ? 0 : ROUTE_DELAY_MS);
  }
  async function sendRoute() {
    if (!CV.routable(s)) return update();
    const mine = ++seq, key = CV.inputKey(s);
    s.pending = { key, seq: mine };
    update();
    let r;
    try { r = await api.route({ text: s.text, folder: s.folder.handle, ai: s.ai, permissionLevel: s.perm }); } catch { r = null; }
    if (mine !== seq) return;
    s.pending = null;
    const result = r?.ok ? r.route : { decision: 'refuse', code: r?.code || 'INTERNAL', reason: r?.text || 'Could not check who should do this. Try again.', alternatives: [] };
    s.route = { key, seq: mine, result };
    if (result.decision !== 'ask') s.pick = null;
    update();
  }
  async function checkFolder() {
    const folder = s.folder?.handle;
    s.preflight = null; s.ackPeers = false; s.preflightError = '';
    if (!folder || !s.connected) return update();
    update();
    let r;
    try { r = await api.preflight(folder); } catch { r = null; }
    if (s.folder?.handle !== folder) return;
    s.preflight = r?.ok ? { folder, peers: r.preflight.peers, key: r.preflight.key } : null;
    s.preflightError = r?.ok ? '' : (r?.text || TEXT.checkFailed);
    update();
  }

  // ── Send: the only path that starts anything ──
  async function send(overrideBudget = false) {
    const draft = CV.runDraft(s, { requestId: (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^\w-]/g, '').slice(0, 64), overrideBudget });
    if (!draft) return;
    s.busy = true; s.error = ''; note(''); update();
    let r;
    try { r = await api.create(draft); } catch { r = null; }
    s.busy = false;
    const clear = () => { s.text = ''; s.held = null; s.route = null; s.pick = null; s.preflight = null; s.ackPeers = false; s.error = ''; keepDraft(); $('nc-text').value = ''; };
    if (r?.ok && r.opened) { clear(); return; } // main has opened the chat's thread; this document is on its way out
    if (r?.ok) { clear(); showStarted(r.id, TEXT.startedHere); renderStarters(); return; }
    if (r?.cancelled) { note(TEXT.cancelled); return update(); }
    if (r?.code === 'STARTED_ELSEWHERE') { clear(); update(); note(r.text); void checkFolder(); return; }
    if (r?.code === 'BUDGET_HELD') { s.held = { text: r.text || 'Your spend cap is reached.' }; return update(); }
    if (r?.code === 'PEERS_CHANGED' && r.preflight) { s.preflight = { folder: s.folder.handle, peers: r.preflight.peers, key: r.preflight.key }; s.ackPeers = false; s.error = r.text; return update(); }
    if (r?.code === 'CONFLICT' || r?.code === 'CONFIRM_REQUIRED') {
      s.error = r?.text && r.code === 'CONFLICT' && /new chat changed/.test(r.text) ? r.text : TEXT.changed;
      s.route = null; s.pick = null; scheduleRoute(true); return;
    }
    s.error = r?.text || TEXT.failed;
    update();
  }

  function showStarted(id, text) {
    started = { id };
    $('nc-box').hidden = true;
    $('nc-started').hidden = false;
    $('nc-started-text').textContent = text;
    $('nc-open').focus();
  }
  function newChat() {
    started = null;
    $('nc-started').hidden = true;
    $('nc-box').hidden = false;
    note('');
    void checkFolder();
    update();
    $('nc-text').focus();
  }

  // ── the form ──
  function fillFolders() {
    const sel = $('nc-folder');
    const opts = folders.map((f) => { const o = node('option', f.label); o.value = f.handle; return o; });
    if (!s.folder) { const o = node('option', 'Choose folder…'); o.value = ''; opts.unshift(o); }
    const pick = node('option', 'Choose another folder…'); pick.value = '__pick'; opts.push(pick);
    sel.replaceChildren(...opts);
    sel.value = s.folder?.handle || '';
  }
  function fillWho() {
    const sel = $('nc-who');
    sel.replaceChildren(...CV.whoOptions(s.ais).map((w) => { const o = node('option', w.label); o.value = w.value; o.disabled = w.disabled; return o; }));
    if (!CV.whoOptions(s.ais).some((w) => w.value === s.ai && !w.disabled)) s.ai = 'auto';
    sel.value = s.ai;
  }
  function fillPerms() {
    const sel = $('nc-perm');
    const opts = CV.permOptions(s.ai);
    if (!opts.some((o) => o.value === s.perm)) s.perm = 'auto-edits';
    sel.replaceChildren(...opts.map((p) => { const o = node('option', p.label); o.value = p.value; return o; }));
    sel.value = s.perm;
  }

  // ── R7-1: summary, Needs-you rows, starters ──
  function renderHome() {
    const first = home?.firstEver === true;
    $('nc-title').textContent = first ? GREETING : 'New chat';
    const sum = $('nc-summary'), n = home?.summary?.needs ?? 0, c = home?.summary?.check ?? 0;
    const parts = [];
    if (n > 0) parts.push(`${n} ${plural(n, 'needs', 'need')} you`);
    if (c > 0) parts.push(`${c} to check`);
    sum.textContent = parts.join(' · ');
    sum.hidden = !home || parts.length === 0;
    const rows = Array.isArray(home?.rows) ? home.rows : [];
    $('nc-needs-list').replaceChildren(...rows.map((r) => {
      const li = node('li', null, 'nc-need');
      const text = node('span', null, 'nc-need-text');
      text.append(node('span', r.title));
      if (r.project) text.append(node('span', ` · ${r.project}`, 'nc-need-project'));
      const open = button('Open', async () => { open.disabled = true; const out = await api.openRow(r.id).catch(() => null); if (!out?.ok) { open.disabled = false; void loadHome(); } }, 'nc-btn');
      open.setAttribute('aria-label', `Open ${r.title}`);
      li.append(node('span', null, 'nc-need-dot'), text, open);
      return li;
    }));
    const more = $('nc-more'), m = home?.more ?? 0;
    more.textContent = m > 0 ? `+ ${m} more in the sidebar` : '';
    more.hidden = m <= 0;
    $('nc-needs').hidden = rows.length === 0;
    renderStarters();
  }
  function renderStarters() {
    const box = $('nc-starters');
    const show = home?.firstEver === true && !started && !s.text.trim() && starters.length > 0;
    box.replaceChildren(...(show ? starters.map((st) => {
      const b = button(st.label, () => fillFrom(st), 'nc-starter');
      b.dataset.starter = st.id;
      return b;
    }) : []));
    box.hidden = !show;
  }
  function fillFrom(st) {
    if (s.text.trim() || typeof st?.text !== 'string') return;
    const t = $('nc-text');
    t.value = st.text; // .value, never markup (review nit)
    s.text = st.text; s.error = ''; s.held = null; keepDraft();
    renderStarters(); scheduleRoute(); t.focus();
  }
  async function loadStarters() {
    const handle = s.folder?.handle || null;
    if (home?.firstEver !== true || !handle) { starters = []; startersFor = handle; return renderStarters(); }
    if (startersFor === handle && starters.length) return renderStarters();
    startersFor = handle;
    let r;
    try { r = await api.starters(handle); } catch { r = null; }
    if (s.folder?.handle !== handle) return;
    starters = Array.isArray(r?.starters) ? r.starters.slice(0, 3) : [];
    renderStarters();
  }
  async function loadHome() {
    let r;
    try { r = await api.home(); } catch { r = null; }
    if (r) home = r;
    renderHome();
    void loadStarters();
  }
  function pollHome() {
    clearTimeout(homeTimer);
    homeTimer = setTimeout(async () => { if (document.visibilityState === 'visible') await loadHome(); pollHome(); }, HOME_POLL_MS);
  }

  function update() {
    const v = CV.routeView(s);
    const line = $('nc-route');
    line.dataset.kind = v.kind;
    const parts = [];
    if (v.kind !== 'none') parts.push(node('span', v.text, 'nc-route-text'));
    if (v.kind === 'routed') parts.push(button('Change', () => $('nc-who').focus(), 'nc-link', 'nc-change'));
    if (v.kind === 'ask') {
      const box = node('div', null, 'nc-choices');
      for (const c of v.choices) {
        const b = button(c.reason || c.label, () => { s.pick = c.ai; update(); }, 'nc-choice');
        b.setAttribute('aria-pressed', String(c.picked)); b.dataset.ai = c.ai; box.append(b);
      }
      parts.push(box);
    }
    if (v.kind === 'refused' && v.canOverride && s.ai !== 'auto') parts.push(button('Send anyway…', () => void send(true), 'nc-btn', 'nc-send-anyway'));
    if (v.kind === 'refused' && v.canOverride && s.ai === 'auto') parts.push(node('span', 'Pick an AI in Who to send it anyway.', 'nc-muted'));
    line.replaceChildren(...parts);

    const p = CV.peersView(s), pe = $('nc-peers');
    pe.replaceChildren();
    if (s.folder && !s.preflight && s.preflightError) pe.append(node('span', s.preflightError, 'nc-warning'), button('Check again', () => void checkFolder(), 'nc-btn', 'nc-recheck'));
    else if (p) {
      pe.append(node('span', p.text, 'nc-warning'));
      if (!p.acknowledged) pe.append(button('Start anyway', () => { s.ackPeers = true; update(); }, 'nc-btn', 'nc-ack'));
    }
    const h = $('nc-held');
    h.replaceChildren();
    if (s.held) h.append(node('span', `Over your spend cap. ${s.held.text}`, 'nc-warning'), button('Send anyway…', () => void send(true), 'nc-btn', 'nc-held-anyway'));

    const go = $('nc-send');
    go.disabled = !CV.canRun(s);
    go.textContent = s.busy ? TEXT.sending : 'Send';
    if (s.error) note(s.error, 'error');
    else if (!s.connected) note(TEXT.offline);
    else if (!s.busy && $('nc-note').dataset.tone === 'error') note('');
    for (const id of ['nc-text', 'nc-folder', 'nc-who', 'nc-perm']) $(id).disabled = s.busy || !s.connected;
  }

  $('nc-text').addEventListener('input', (e) => { s.text = e.target.value; s.error = ''; s.held = null; keepDraft(); renderStarters(); scheduleRoute(); });
  $('nc-text').addEventListener('keydown', (e) => { if (CV.isSubmitKey(e)) { e.preventDefault(); if (CV.canRun(s)) void send(); } });
  $('nc-box').addEventListener('submit', (e) => { e.preventDefault(); if (CV.canRun(s)) void send(); });
  $('nc-folder').addEventListener('change', async (e) => {
    if (e.target.value === '__pick') {
      const f = await api.pickFolder().catch(() => null);
      if (f) { if (!folders.some((x) => x.handle === f.handle)) folders.unshift(f); s.folder = f; }
      fillFolders(); void checkFolder(); void loadStarters(); scheduleRoute(); return;
    }
    s.folder = folders.find((x) => x.handle === e.target.value) || null; void checkFolder(); void loadStarters(); scheduleRoute();
  });
  $('nc-who').addEventListener('change', (e) => { s.ai = e.target.value; s.pick = null; fillPerms(); scheduleRoute(); });
  $('nc-perm').addEventListener('change', (e) => { s.perm = e.target.value; scheduleRoute(); });
  $('nc-open').addEventListener('click', () => { if (started) void api.openInTasks(started.id); });
  $('nc-again').addEventListener('click', () => { newChat(); renderStarters(); });

  async function load() {
    let info;
    try { info = await api.info(); } catch { info = null; }
    s.connected = info?.connected === true;
    s.ais = info?.ais || [];
    folders = [...(info?.folder ? [info.folder] : []), ...((info?.recent) || []).filter((r) => r.handle !== info.folder?.handle)];
    if (!s.folder || !folders.some((f) => f.handle === s.folder.handle)) s.folder = info?.folder || null;
    if (info?.task && !started) showStarted(info.task.id, TEXT.startedHere);
    fillFolders(); fillWho(); fillPerms();
    $('nc').setAttribute('aria-busy', 'false');
    void checkFolder();
    void loadStarters();
    scheduleRoute(true);
  }

  try { s.text = sessionStorage.getItem(DRAFT_KEY) || ''; } catch { s.text = ''; }
  $('nc-text').value = s.text;
  api.onChanged(() => { void load(); });
  void load().then(() => { if (!started) $('nc-text').focus(); });
  void loadHome().then(pollHome);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void loadHome(); });
})();
