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
    if (r?.ok) { clear(); showStarted(r.id, TEXT.startedHere); return; }
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

  $('nc-text').addEventListener('input', (e) => { s.text = e.target.value; s.error = ''; s.held = null; keepDraft(); scheduleRoute(); });
  $('nc-text').addEventListener('keydown', (e) => { if (CV.isSubmitKey(e)) { e.preventDefault(); if (CV.canRun(s)) void send(); } });
  $('nc-box').addEventListener('submit', (e) => { e.preventDefault(); if (CV.canRun(s)) void send(); });
  $('nc-folder').addEventListener('change', async (e) => {
    if (e.target.value === '__pick') {
      const f = await api.pickFolder().catch(() => null);
      if (f) { if (!folders.some((x) => x.handle === f.handle)) folders.unshift(f); s.folder = f; }
      fillFolders(); void checkFolder(); scheduleRoute(); return;
    }
    s.folder = folders.find((x) => x.handle === e.target.value) || null; void checkFolder(); scheduleRoute();
  });
  $('nc-who').addEventListener('change', (e) => { s.ai = e.target.value; s.pick = null; fillPerms(); scheduleRoute(); });
  $('nc-perm').addEventListener('change', (e) => { s.perm = e.target.value; scheduleRoute(); });
  $('nc-open').addEventListener('click', () => { if (started) void api.openInTasks(started.id); });
  $('nc-again').addEventListener('click', newChat);

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
    scheduleRoute(true);
  }

  try { s.text = sessionStorage.getItem(DRAFT_KEY) || ''; } catch { s.text = ''; }
  $('nc-text').value = s.text;
  api.onChanged(() => { void load(); });
  void load().then(() => { if (!started) $('nc-text').focus(); });
})();
