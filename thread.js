// The chat-first thread page (redesign R2a, plan-r2.md §3). Read-only: it shows
// one row's chat (a Plexiform task) or one terminal session's activity, and
// hands anything to decide to the Tasks page. Everything reaches the DOM
// through textContent; the transcript is built into the script-less srcdoc
// frame by TranscriptDom.
(function () {
  'use strict';
  const api = window.threadApi;
  const TV = window.TasksView, Dom = window.TranscriptDom;
  const $ = (id) => document.getElementById(id);

  const BUCKET = { needs: 'Needs you', working: 'Working on it', check: 'Finished — check it', stuck: 'Stuck or failed', idle: 'Idle' };
  const AI = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
  const POLL_MS = 5000;
  const MACHINE = window.Brand ? window.Brand.machine() : 'computer';

  let rowId = '', kind = null, header = null, detail = null, tx = TV.newTranscript(), activity = null, origin = null;
  let gone = false, poll = null, renderQueued = false;
  const open = new Set();

  // ── header ───────────────────────────────────────────────────────────────
  // A task the latest list hasn't seen yet has no header from main: the task detail fills it in.
  function taskBucket(d) {
    if (!d) return 'idle';
    if ((d.openApprovals && d.openApprovals.length) || d.openAsk || (Array.isArray(d.actions) && (d.actions.includes('approve') || d.actions.includes('answer')))) return 'needs';
    if (d.state === 'running' || d.state === 'queued') return 'working';
    if (d.state === 'in_review' || d.state === 'done') return 'check';
    if (d.state === 'failed' || d.state === 'blocked') return 'stuck';
    return 'idle';
  }
  function headView() {
    const h = header || {};
    const d = detail;
    const ai = h.ai || (d && AI[d.ai?.id]) || 'AI';
    const title = d?.title || h.title || `${ai} chat`;
    const project = h.project || d?.repo?.name || '';
    const branch = d?.branch || '';
    // An open approval or question is the person's, whatever the list last said.
    const bucket = kind === 'task' && d && taskBucket(d) === 'needs' ? 'needs' : (h.bucket || (kind === 'task' ? taskBucket(d) : 'idle'));
    return { title, ai, meta: [project, branch, ai].filter(Boolean).join(' · '), bucket };
  }
  function renderHead() {
    const v = headView();
    $('th-title').textContent = v.title;
    document.title = v.title;
    $('th-meta').textContent = v.meta;
    $('th-dot').dataset.bucket = v.bucket;
    $('th-bucket').dataset.bucket = v.bucket;
    $('th-bucket').textContent = BUCKET[v.bucket] || BUCKET.idle;
    const primary = $('th-primary');
    // Provisional, awaiting Callum (plan-r2.md §7 item 1): "Open to answer" hands a decision to the Tasks page.
    if (kind === 'task' && waitingOf(detail)) { primary.hidden = false; primary.textContent = 'Open to answer'; primary.dataset.act = 'tasks'; }
    else if (kind === 'session' && origin) { primary.hidden = false; primary.textContent = 'Go to it'; primary.dataset.act = 'terminal'; }
    else { primary.hidden = true; delete primary.dataset.act; }
  }

  // ── what the person is asked ─────────────────────────────────────────────
  function waitingOf(d) {
    if (!d) return null;
    const a = Array.isArray(d.openApprovals) ? d.openApprovals[0] : null;
    if (a) return { title: `${headView().ai} is waiting for you`, what: a.inputSummary ? `${a.tool}: ${a.inputSummary}` : `Wants to use ${a.tool || 'a tool'}`, where: d.where ? `In ${d.where}` : '' };
    if (d.openAsk) return { title: `${headView().ai} has a question`, what: d.openAsk.text || '', where: d.where ? `In ${d.where}` : '' };
    return null;
  }
  function renderWaiting() {
    const w = kind === 'task' ? waitingOf(detail) : null;
    $('th-waiting').hidden = !w;
    if (!w) return;
    $('th-waiting-title').textContent = w.title;
    $('th-waiting-what').textContent = w.what;
    $('th-waiting-where').textContent = w.where;
    $('th-waiting-where').hidden = !w.where;
  }

  function renderBanner() {
    const b = $('th-banner');
    b.replaceChildren();
    if (kind !== 'session') { b.hidden = true; return; }
    b.hidden = false;
    const text = document.createElement('span');
    text.textContent = origin ? `Running in ${origin}` : `Running in a terminal on this ${MACHINE}`;
    b.append(text);
    if (activity?.view?.status) { const s = document.createElement('span'); s.className = 'th-banner-status'; s.textContent = activity.view.status; b.append(s); }
  }

  // ── transcript (inside the frame) ────────────────────────────────────────
  function frameDoc() { try { return $('th-tx').contentDocument; } catch { return null; } }
  function itemsNow() {
    if (kind === 'session') return Dom.itemsFromActivity(activity?.view);
    return tx.items;
  }
  function waitingMessages() {
    if (kind !== 'task' || !detail) return [];
    return (detail.messages || []).filter((m) => TV.isMine(m) && m.deliveredAt == null).slice(-5).map((m) => ({ body: m.body || '' }));
  }
  function renderTranscript() {
    renderQueued = false;
    const doc = frameDoc(), main = doc?.getElementById('tx');
    if (!main) return;
    const stick = doc.scrollingElement ? doc.scrollingElement.scrollHeight - doc.scrollingElement.scrollTop - doc.scrollingElement.clientHeight < 40 : true;
    const items = itemsNow();
    main.replaceChildren(Dom.render(doc, { prompt: kind === 'task' ? (detail?.text || '') : '', items, waiting: waitingMessages(), open }));
    const empty = !items.length && !(kind === 'task' && detail?.text);
    $('th-tx').hidden = empty;
    if (empty && !gone) showEmpty('Nothing here yet', kind === 'session' ? 'Activity from this session shows up here as it happens.' : 'The conversation shows up here as soon as it starts.', false);
    else if (!gone) $('th-empty').hidden = true;
    if (stick && doc.scrollingElement) doc.scrollingElement.scrollTop = doc.scrollingElement.scrollHeight;
  }
  const renderSoon = () => { if (!renderQueued) { renderQueued = true; requestAnimationFrame(renderTranscript); } };

  // Expand or collapse a group of steps: the frame runs no script, so the page listens on it.
  function wireFrame() {
    const doc = frameDoc();
    if (!doc || doc.__wired) return;
    doc.__wired = true;
    doc.addEventListener('click', (e) => {
      const head = e.target.closest?.('.tx-steps-head');
      const box = head?.closest('.tx-steps');
      if (!box) return;
      const i = Number(box.dataset.group);
      if (open.has(i)) open.delete(i); else open.add(i);
      renderTranscript();
    });
  }

  function showEmpty(title, text, board) {
    $('th-empty').hidden = false;
    $('th-empty-title').textContent = title;
    $('th-empty-text').textContent = text;
    $('th-board').hidden = !board;
  }
  function showGone() {
    gone = true;
    stopPoll();
    kind = null;
    $('th-tx').hidden = true;
    $('th-waiting').hidden = true;
    $('th-banner').hidden = true;
    $('th-primary').hidden = true;
    $('th-title').textContent = 'This chat has ended or moved';
    $('th-meta').textContent = '';
    $('th-bucket').textContent = '';
    showEmpty('This chat has ended or moved', `It is no longer listed on this ${MACHINE}. Your Board still has everything that was saved.`, true);
  }

  function renderAll() { renderHead(); renderBanner(); renderWaiting(); renderTranscript(); $('th').setAttribute('aria-busy', 'false'); }

  // ── reads ────────────────────────────────────────────────────────────────
  function apply(r) {
    if (!r) return false;
    if (r.gone) { showGone(); return true; }
    kind = r.kind;
    if (r.header !== undefined) header = r.header;
    if (r.kind === 'session') { origin = r.origin || null; activity = r.activity && !r.activity.empty ? r.activity : null; if (r.activity?.empty) $('th-status').textContent = r.activity.empty; }
    if (r.kind === 'task' && r.detail) {
      detail = r.detail;
      tx = TV.newTranscript();
      for (const e of r.replay || []) TV.addEvent(tx, e);
    }
    if (r.kind === 'task' && r.error) $('th-status').textContent = typeof r.error === 'string' ? r.error : TV.errorText(r.error.code);
    return true;
  }

  async function load() {
    // The document may still be finishing; main answers null until it is on screen and settled.
    for (let i = 0; i < 4; i++) {
      const r = await api.open(rowId);
      if (apply(r)) { if (!gone) { renderAll(); startPoll(); } return; }
      await new Promise((res) => setTimeout(res, 250));
    }
  }
  async function refresh() {
    if (gone || document.hidden) return;
    const r = await api.state(rowId);
    if (!r) return;
    if (r.gone) { showGone(); return; }
    if (r.header !== undefined) header = r.header;
    if (r.kind === 'session') { origin = r.origin || null; activity = r.activity && !r.activity.empty ? r.activity : activity; }
    renderAll();
  }
  function startPoll() { stopPoll(); poll = setInterval(refresh, POLL_MS); }
  function stopPoll() { if (poll) clearInterval(poll); poll = null; }

  // Live changes for an open task (main routes only this document's slot here).
  api.onEvent((m) => {
    if (!m || m.id !== rowId || kind !== 'task' || gone) return;
    const e = m.event;
    if (!e || typeof e !== 'object') return;
    if (e.type === 'reset') { load(); return; }
    if (e.type === 'detail' && e.detail) { detail = e.detail; renderHead(); renderWaiting(); renderTranscript(); return; }
    if (e.type === 'transcript' || e.type === 'tool' || e.type === 'error') { if (TV.addEvent(tx, e)) renderSoon(); return; }
    if ((e.type === 'message' || e.type === 'message-state') && detail) { if (TV.mergeMessage(detail.messages || (detail.messages = []), e)) renderSoon(); }
  });

  // ── actions (navigation only) ────────────────────────────────────────────
  $('th-primary').addEventListener('click', async () => {
    const act = $('th-primary').dataset.act;
    if (act === 'tasks') await api.openInTasks(rowId);
    else if (act === 'terminal') {
      const r = await api.goToTerminal(rowId);
      $('th-status').textContent = r && r.ok === false && r.note ? r.note : '';
    }
  });
  $('th-answer').addEventListener('click', () => api.openInTasks(rowId));
  $('th-board').addEventListener('click', () => api.board());

  // The ⋯ menu: Copy link only.
  const more = $('th-more'), menu = $('th-menu');
  function setMenu(show) {
    menu.hidden = !show;
    more.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) $('th-copy').focus();
  }
  more.addEventListener('click', () => setMenu(menu.hidden));
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenu(false); more.focus(); } });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.th-more-wrap')) setMenu(false); });
  $('th-copy').addEventListener('click', async () => {
    const ok = await api.copyLink(rowId);
    setMenu(false);
    more.focus();
    $('th-status').textContent = ok ? 'Link copied' : 'Could not copy the link';
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('pagehide', () => { stopPoll(); if (rowId) api.close(rowId); });

  $('th-tx').addEventListener('load', () => { wireFrame(); renderTranscript(); });
  wireFrame();

  api.onReady((id) => {
    if (!id || (rowId && id !== rowId)) return;
    const first = !rowId;
    rowId = id;
    if (first) load();
  });
})();
