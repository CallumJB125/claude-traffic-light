// The chat-first thread page (redesign R2a, plan-r2.md §3). It shows one row's
// chat (a Plexiform task) or one terminal session's activity, and hands
// anything to decide to the Tasks page. R2b-1: a chat can be replied to
// (thread:message: the row and the text only; main picks the task and the action). Everything reaches the DOM
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
  let gone = false, poll = null, renderQueued = false, sending = false;
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
    // A chat's decision has one button, on its waiting card (no second copy up here).
    if (kind === 'session' && origin) { primary.hidden = false; primary.textContent = 'Go to it'; primary.dataset.act = 'terminal'; }
    else { primary.hidden = true; delete primary.dataset.act; }
    // ⋯: a chat can go to Tasks; opening it in a terminal is the Tasks page's (R6a), so it says why not, or goes there.
    const chat = kind === 'task';
    $('th-tasks').hidden = !chat;
    const o = header && header.openInTerminal, term = $('th-terminal');
    term.hidden = !chat || !o;
    if (chat && o) {
      if (o.available) { term.removeAttribute('aria-disabled'); $('th-terminal-why').textContent = 'From the Tasks page'; }
      else { term.setAttribute('aria-disabled', 'true'); $('th-terminal-why').textContent = NO_TERMINAL[o.reason] || 'Not available for this chat.'; }
    }
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
    // The state is the header's bucket; the Timeline's own wording could disagree with it.
    b.append(text);
  }

  // ── the reply box (R2b-1) ────────────────────────────────────────────────
  // Why a chat can't open in a terminal (PR 0s openInTerminal reasons), in the person's words.
  const NO_TERMINAL = {
    'no-repo': 'It isn’t in a project folder.', 'in-place': 'It works directly in your folder.', hub: 'It runs on a board.',
    provider: 'Only Claude and Codex chats open in a terminal.', budgeted: 'It has a spending limit.', 'quick-chat': 'Quick chats stay here.',
  };
  function chatState() {
    if (header && header.chatState) return header.chatState;
    if (!detail) return null;
    if (detail.state === 'done') return 'ended';
    if (detail.state === 'handing_over' || detail.state === 'handed_over') return 'in-terminal';
    return null;
  }
  // What the box can do now: 'on' (reply), 'wait' (a decision first), 'off' (with a reason), or null (no box).
  // No dead control: with nothing to send and nothing to say, there is no box; an open decision
  // is the waiting card's, and the box stays only to keep a draft the person had already typed.
  function replyView() {
    if (kind !== 'task' || gone || !detail) return null;
    const state = chatState(), ai = headView().ai, draft = !!$('th-reply-text').value.trim();
    if (state === 'ended') return null;
    if (waitingOf(detail)) return draft ? { state: 'wait', placeholder: 'Allow or deny the request above to continue' } : null;
    if (state === 'in-terminal') return { state: 'off', placeholder: 'This chat is in your terminal. Reply there.' };
    if (Array.isArray(detail.actions) && detail.actions.includes('message')) return { state: 'on', placeholder: `Reply to ${ai}…` };
    return draft ? { state: 'off', placeholder: `${ai} can’t take a message right now.` } : null;
  }
  function renderReply() {
    const form = $('th-reply'), text = $('th-reply-text'), v = replyView();
    const ended = kind === 'task' && !gone && !!detail && chatState() === 'ended';
    $('th-ended').hidden = !ended;
    if (ended) $('th-ended-text').textContent = 'You can pick it up again from Tasks.';
    form.hidden = !v;
    if (!v) return;
    form.dataset.state = v.state;
    text.placeholder = v.placeholder;
    $('th-reply-label').textContent = v.state === 'on' ? v.placeholder.replace(/…$/, '') : 'Reply';
    text.disabled = v.state !== 'on';
    $('th-send').disabled = v.state !== 'on' || sending || !text.value.trim();
    $('th-send').textContent = sending ? 'Sending…' : 'Send';
  }
  function note(text, tone) { const n = $('th-reply-note'); n.textContent = text || ''; if (tone) n.dataset.tone = tone; else delete n.dataset.tone; }
  async function send() {
    const v = replyView(), text = $('th-reply-text'), body = text.value;
    if (sending || !v || v.state !== 'on' || !body.trim()) return;
    sending = true; note(''); renderReply();
    let r = null;
    try { r = await api.message(rowId, body); } catch { r = null; }
    sending = false;
    if (r && r.ok === true) { if (text.value === body) text.value = ''; note(''); }
    else if (r && r.code === 'ILLEGAL_TRANSITION' && waitingOf(detail)) note('Allow or deny the request above to continue.', 'error');
    else note((r && r.text) || 'That message wasn’t sent. Try again.', 'error');
    renderReply();
    text.focus();
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
    $('th-reply').hidden = true;
    $('th-ended').hidden = true;
    $('th-title').textContent = 'This chat has ended or moved';
    $('th-meta').textContent = '';
    $('th-bucket').textContent = '';
    showEmpty('This chat has ended or moved', `It is no longer listed on this ${MACHINE}. Your Board still has everything that was saved.`, true);
  }

  function renderAll() { renderHead(); renderBanner(); renderWaiting(); renderReply(); renderTranscript(); $('th').setAttribute('aria-busy', 'false'); }

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
    if (e.type === 'detail' && e.detail) { detail = e.detail; renderHead(); renderWaiting(); renderReply(); renderTranscript(); return; }
    if (e.type === 'transcript' || e.type === 'tool' || e.type === 'error') { if (TV.addEvent(tx, e)) renderSoon(); return; }
    if ((e.type === 'message' || e.type === 'message-state') && detail) { if (TV.mergeMessage(detail.messages || (detail.messages = []), e)) renderSoon(); }
  });

  // ── actions (navigation only) ────────────────────────────────────────────
  $('th-primary').addEventListener('click', async () => {
    const act = $('th-primary').dataset.act;
    if (act === 'terminal') {
      const r = await api.goToTerminal(rowId);
      $('th-status').textContent = r && r.ok === false && r.note ? r.note : '';
    }
  });
  // Provisional, awaiting Callum (plan-r2.md §7 item 1): "Open to answer" hands a decision to the Tasks page.
  $('th-answer').addEventListener('click', () => api.openInTasks(rowId));
  $('th-board').addEventListener('click', () => api.board());
  // Provisional, awaiting Callum (plan-r2b-auth §7 item 3): Resume goes to the chat in Tasks.
  $('th-resume').addEventListener('click', () => api.openInTasks(rowId));
  $('th-reply').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('th-reply-text').addEventListener('input', renderReply);
  // Provisional, awaiting Callum (plan-r2b-auth §7 item 2): ⌘↩ sends, Enter is a newline.
  $('th-reply-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); send(); } });

  // The ⋯ menu: Copy link only.
  const more = $('th-more'), menu = $('th-menu');
  function setMenu(show) {
    menu.hidden = !show;
    more.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) (menu.querySelector('.th-menu-item:not([hidden])') || $('th-copy')).focus();
  }
  more.addEventListener('click', () => setMenu(menu.hidden));
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenu(false); more.focus(); } });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.th-more-wrap')) setMenu(false); });
  $('th-tasks').addEventListener('click', () => { setMenu(false); api.openInTasks(rowId); });
  $('th-terminal').addEventListener('click', () => { if ($('th-terminal').getAttribute('aria-disabled') === 'true') return; setMenu(false); api.openInTasks(rowId); });
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
