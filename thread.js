// The chat-first thread page (redesign R2a, plan-r2.md §3). It shows one row's
// chat (a Plexiform task) or one terminal session's activity. R2b-1: a chat can be replied to
// (thread:message: the row and the text only; main picks the task and the action). R4-1a: every pending
// approval and the one open question render stacked, each with its own 600 ms arm, its own state and its
// own result; Allow once, Deny, an answer, a resume choice and Stop go through thread:act. Main checks
// everything again (src/thread-main.js). Everything reaches the DOM
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
  // R2a's read-only card stays for a request this chat can't act on (the task offers no approve, deny or answer).
  function renderWaiting() {
    const w = kind === 'task' && !requestsOf(detail).length ? waitingOf(detail) : null;
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

  // ── requests, stacked (R4-1a, plan-r4 §4 and §11) ─────────────────────────
  const ARM_MS = 600, MAX_APPROVALS = 10;
  // key ('approval:<id>' | 'ask:<id>') → { sig, armedUntil, state: idle|sending|sent|gone, text, above, confirm }
  const cards = new Map();
  let acting = null; // the one key whose act is in flight; every other control waits for it
  let armTimer = null;
  let bound = null; // the reply box as an answer: { askId, armedUntil }
  let stopAsk = null; // Stop's second step: { armedUntil }
  let stopNote = '';
  const has = (a) => Array.isArray(detail?.actions) && detail.actions.includes(a);
  const asksTwice = (a) => Array.isArray(detail?.confirm) && detail.confirm.includes(a);
  // What this chat can act on now, in the engine's order; at most 10 approvals (as main relays) and one ask.
  function requestsOf(d) {
    if (!d || kind !== 'task') return [];
    const out = [];
    const ok = Array.isArray(d.actions) && (d.actions.includes('approve') || d.actions.includes('deny'));
    if (ok) for (const a of (Array.isArray(d.openApprovals) ? d.openApprovals : []).slice(0, MAX_APPROVALS)) {
      if (a && typeof a.approvalId === 'string' && a.approvalId) out.push({ key: `approval:${a.approvalId}`, kind: 'approval', a, sig: JSON.stringify([a.tool, a.inputSummary]) });
    }
    const k = d.openAsk;
    if (k && typeof k.askId === 'string' && k.askId) {
      const all = Array.isArray(k.choices) ? k.choices : [];
      const choices = all.filter((c) => Array.isArray(d.actions) && d.actions.includes(c.action));
      const answer = !all.length && Array.isArray(d.actions) && d.actions.includes('answer');
      if (choices.length || answer) out.push({ key: `ask:${k.askId}`, kind: 'ask', k, choices, answer, sig: JSON.stringify([k.text, k.options || [], all.map((c) => [c.id, c.label, c.action])]) });
    }
    return out;
  }
  // A card arms when it first appears, when what it shows changes, and when anything above it changed (it moved).
  function syncCards(reqs) {
    const t = Date.now(), live = new Set();
    let above = '';
    for (const r of reqs) {
      live.add(r.key);
      let c = cards.get(r.key);
      if (!c || c.sig !== r.sig) { c = { sig: r.sig, armedUntil: t + ARM_MS, state: 'idle', text: '', above, confirm: null }; cards.set(r.key, c); }
      else if (c.above !== above) { c.above = above; c.armedUntil = Math.max(c.armedUntil, t + ARM_MS); }
      above += `${r.key}:${c.state === 'sent' || c.state === 'gone' ? 1 : 0};`;
    }
    for (const k of [...cards.keys()]) if (!live.has(k)) cards.delete(k);
    const ask = reqs.find((r) => r.kind === 'ask' && r.answer);
    if (!ask) bound = null;
    else if (!bound || bound.askId !== ask.k.askId || bound.sig !== ask.sig) bound = { askId: ask.k.askId, sig: ask.sig, armedUntil: t + ARM_MS };
  }
  function rearmAll() {
    const t = Date.now() + ARM_MS;
    for (const c of cards.values()) { c.armedUntil = Math.max(c.armedUntil, t); if (c.confirm) c.confirm.armedUntil = Math.max(c.confirm.armedUntil, t); }
    if (bound) bound.armedUntil = Math.max(bound.armedUntil, t);
    if (stopAsk) stopAsk.armedUntil = Math.max(stopAsk.armedUntil, t);
  }
  // Wake once when the next arm runs out, so a disabled button comes back by itself.
  function wakeAt(until) {
    const wait = until - Date.now();
    if (wait <= 0 || armTimer) return;
    armTimer = setTimeout(() => { armTimer = null; renderCards(); renderReply(); renderStop(); }, wait);
  }
  const ready = (until) => { if (Date.now() >= until) return true; wakeAt(until); return false; };
  function cardBtn(label, cls, c, on) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `th-btn${cls ? ` ${cls}` : ''}`; b.textContent = label;
    const can = !acting && (c.state === 'idle') && ready(c.armedUntil);
    b.disabled = !can;
    b.addEventListener('click', () => { if (!b.disabled) on(); });
    return b;
  }
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const RECEIPT = { approve: 'Allowed once', deny: 'Denied', answer: 'Answer sent', choose: 'Sent' };
  function renderCards() {
    const box = $('th-cards');
    const reqs = requestsOf(detail);
    syncCards(reqs);
    const focusKey = document.activeElement?.closest?.('.th-card')?.dataset.key, focusLabel = document.activeElement?.textContent;
    box.replaceChildren();
    box.hidden = !reqs.length;
    const ai = headView().ai, approvals = reqs.filter((r) => r.kind === 'approval').length;
    for (const r of reqs) {
      const c = cards.get(r.key), card = el('section', 'th-card');
      card.dataset.key = r.key; card.dataset.state = c.state;
      if (c.state === 'sent' || c.state === 'gone') {
        // Collapsed in place until the next detail drops it, so the cards below don't jump under the pointer.
        card.classList.add('th-card-done');
        card.append(el('p', 'th-card-receipt', c.text));
        box.append(card);
        continue;
      }
      if (r.kind === 'approval') {
        const a = r.a;
        if (a.tool === 'StartTask') {
          card.append(el('h2', 'th-card-title', 'Waiting for you to accept this task'), el('p', 'th-card-what', a.inputSummary || ''),
            el('p', 'th-card-sub', 'Starting a new task is accepted on the Tasks page for now.'));
          const row = el('div', 'th-card-btns');
          const go = el('button', 'th-btn th-primary', 'Open in Tasks'); go.type = 'button'; go.addEventListener('click', () => api.openInTasks(rowId));
          row.append(go); card.append(row);
        } else {
          card.append(el('h2', 'th-card-title', `${ai} wants to use ${a.tool || 'a tool'}`));
          if (a.inputSummary) card.append(el('p', 'th-card-what', a.inputSummary));
          if (detail.where) card.append(el('p', 'th-card-sub', `In ${detail.where}`));
          const row = el('div', 'th-card-btns');
          if (has('approve')) row.append(cardBtn('Allow once', 'th-primary', c, () => choose(r.key, { action: 'approve', approvalId: a.approvalId, scope: 'once' })));
          if (has('deny')) row.append(cardBtn('Deny', 'th-danger', c, () => choose(r.key, { action: 'deny', approvalId: a.approvalId })));
          card.append(row);
        }
      } else {
        const k = r.k;
        card.append(el('h2', 'th-card-title', r.answer ? `${ai} has a question` : `${ai} needs you to choose`), el('p', 'th-card-text', k.text || ''));
        const row = el('div', 'th-card-btns');
        if (r.answer) for (const o of (k.options || [])) row.append(cardBtn(o, '', c, () => choose(r.key, { action: 'answer', askId: k.askId, answer: o })));
        let elsewhere = false;
        for (const ch of r.choices) {
          if (ch.action === 'resume') row.append(cardBtn(ch.label, '', c, () => choose(r.key, { action: 'choose', askId: k.askId, choiceId: ch.id })));
          else elsewhere = true;
        }
        if (elsewhere) { const go = el('button', 'th-btn', 'Open in Tasks'); go.type = 'button'; go.addEventListener('click', () => api.openInTasks(rowId)); row.append(go); }
        if (row.childNodes.length) card.append(row);
        if (r.answer && approvals) card.append(el('p', 'th-card-sub', 'Or type your answer in the box below.'));
      }
      if (c.confirm) {
        const q = el('div', 'th-card-confirm');
        q.append(el('p', 'th-card-ask', c.confirm.question));
        const yes = el('button', 'th-btn th-primary', c.confirm.yes); yes.type = 'button';
        yes.disabled = !!acting || !ready(c.confirm.armedUntil);
        yes.addEventListener('click', () => { if (yes.disabled) return; const req = { ...c.confirm.req, confirmed: true }; c.confirm = null; runAct(r.key, req); });
        const no = el('button', 'th-btn', c.confirm.no); no.type = 'button';
        no.addEventListener('click', () => { c.confirm = null; renderCards(); });
        q.append(yes, no); card.append(q);
      }
      if (c.text) card.append(el('p', 'th-card-note', c.text));
      box.append(card);
    }
    if (focusKey) { const card = [...box.children].find((n) => n.dataset.key === focusKey); const again = card && [...card.querySelectorAll('button')].find((b) => b.textContent === focusLabel && !b.disabled); if (again) again.focus(); }
  }
  // A task's own task.confirm asks twice, on the card (plan-r4 §2.6); anything else goes straight to main.
  const TWICE = { approve: ['Allow this request?', 'Allow', 'Keep it waiting'], deny: ['Deny this request?', 'Deny', 'Keep it waiting'], answer: ['Send this answer?', 'Send', 'Not yet'] };
  function choose(key, req) {
    const c = cards.get(key);
    if (!c || acting || c.state !== 'idle' || Date.now() < c.armedUntil) return;
    if (TWICE[req.action] && asksTwice(req.action)) {
      const [question, yes, no] = TWICE[req.action];
      c.confirm = { req, question, yes, no, armedUntil: Date.now() + ARM_MS };
      renderCards();
      return;
    }
    return runAct(key, req);
  }
  // One act at a time; its result lands on its own card only, and a late one for a card that's gone is dropped.
  async function runAct(key, req) {
    const c = cards.get(key);
    if (acting || !c) return null;
    const sig = c.sig;
    acting = key; c.state = 'sending'; c.text = '';
    renderCards(); renderReply(); renderStop();
    let r = null;
    try { r = await api.act(rowId, req); } catch { r = null; }
    acting = null;
    rearmAll();
    const now = cards.get(key);
    if (now && now.sig === sig) {
      if (r && r.ok === true) { now.state = 'sent'; now.text = RECEIPT[req.action] || 'Sent'; }
      else if (r && (r.code === 'ALREADY_ANSWERED' || r.code === 'NOT_FOUND')) { now.state = 'gone'; now.text = 'Already answered'; refresh(); }
      else { now.state = 'idle'; now.text = r && r.cancelled ? '' : ((r && r.text) || 'That wasn’t sent. Try again.'); now.armedUntil = Math.max(now.armedUntil, Date.now() + ARM_MS); }
    }
    renderCards(); renderReply(); renderStop();
    return r;
  }

  // ── Stop, in the open chat only (R4-1a): two steps, the second armed for 600 ms ──
  function renderStop() {
    const bar = $('th-stop'), show = kind === 'task' && !gone && !!detail && has('stop') && chatState() !== 'ended';
    bar.hidden = !show;
    if (!show) { stopAsk = null; return; }
    $('th-stop-btn').hidden = !!stopAsk;
    $('th-stop-btn').disabled = !!acting;
    $('th-stop-confirm').hidden = !stopAsk;
    $('th-stop-yes').disabled = !stopAsk || !!acting || !ready(stopAsk.armedUntil);
    $('th-stop-note').textContent = stopNote;
  }
  async function stopNow() {
    if (!stopAsk || acting || Date.now() < stopAsk.armedUntil) return;
    stopAsk = null; acting = 'stop'; stopNote = '';
    renderStop(); renderCards(); renderReply();
    let r = null;
    try { r = await api.act(rowId, { action: 'stop', confirmed: true }); } catch { r = null; }
    acting = null;
    rearmAll();
    stopNote = r && r.ok === true ? 'Stopping…' : ((r && r.text) || 'That wasn’t sent. Try again.');
    renderStop(); renderCards(); renderReply();
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
    // R4-1a (plan-r4 §11.4): an open question owns the box, bound to its askId, whatever else is open.
    const reqs = requestsOf(detail), approvals = reqs.filter((r) => r.kind === 'approval').length;
    if (reqs.some((r) => r.kind === 'ask' && r.answer)) return { state: 'answer', placeholder: approvals ? 'Type your answer to the question above' : 'Pick an option above, or type an answer' };
    if (approvals) return draft ? { state: 'wait', placeholder: approvals > 1 ? 'Allow or deny the requests above to continue' : 'Allow or deny the request above to continue' } : null;
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
    const answering = v.state === 'answer';
    $('th-reply-label').textContent = v.state === 'on' ? v.placeholder.replace(/…$/, '') : answering ? 'Your answer' : 'Reply';
    const live = v.state === 'on' || answering;
    text.disabled = !live || !!acting;
    $('th-send').disabled = !live || sending || !!acting || !text.value.trim() || (answering && (!bound || !ready(bound.armedUntil)));
    $('th-send').textContent = sending || (answering && acting && acting.startsWith('ask:')) ? 'Sending…' : answering ? 'Send answer' : 'Send';
  }
  function note(text, tone) { const n = $('th-reply-note'); n.textContent = text || ''; if (tone) n.dataset.tone = tone; else delete n.dataset.tone; }
  async function send() {
    const v = replyView(), text = $('th-reply-text'), body = text.value;
    if (v && v.state === 'answer') return sendAnswer(body);
    if (sending || acting || !v || v.state !== 'on' || !body.trim()) return;
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

  // The box as the open question's answer: sent with the askId it was bound to, never another.
  async function sendAnswer(body) {
    const text = $('th-reply-text');
    if (!bound || acting || sending || !body.trim() || Date.now() < bound.armedUntil) return;
    const key = `ask:${bound.askId}`, req = { action: 'answer', askId: bound.askId, answer: body };
    if (asksTwice('answer')) { choose(key, req); return; }
    note('');
    const r = await runAct(key, req);
    if (r && r.ok === true) { if (text.value === body) text.value = ''; note(''); }
    else note((r && r.text) || 'That answer wasn’t sent. Try again.', 'error');
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
    $('th-cards').hidden = true;
    $('th-stop').hidden = true;
    $('th-banner').hidden = true;
    $('th-primary').hidden = true;
    $('th-reply').hidden = true;
    $('th-ended').hidden = true;
    $('th-title').textContent = 'This chat has ended or moved';
    $('th-meta').textContent = '';
    $('th-bucket').textContent = '';
    showEmpty('This chat has ended or moved', `It is no longer listed on this ${MACHINE}. Your Board still has everything that was saved.`, true);
  }

  function renderAll() { renderHead(); renderBanner(); renderCards(); renderWaiting(); renderReply(); renderStop(); renderTranscript(); $('th').setAttribute('aria-busy', 'false'); }

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
    // Cards are built only from a detail (sent after main relayed it, S5); a state event never shows one.
    if (e.type === 'detail' && e.detail) { detail = e.detail; renderHead(); renderCards(); renderWaiting(); renderReply(); renderStop(); renderTranscript(); return; }
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
  // A request this chat can't act on (R2a's card): "Open to answer" hands it to the Tasks page.
  $('th-answer').addEventListener('click', () => api.openInTasks(rowId));
  $('th-board').addEventListener('click', () => api.board());
  // Provisional, awaiting Callum (plan-r2b-auth §7 item 3): Resume goes to the chat in Tasks.
  $('th-resume').addEventListener('click', () => api.openInTasks(rowId));
  $('th-reply').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('th-stop-btn').addEventListener('click', () => { if (acting) return; stopNote = ''; stopAsk = { armedUntil: Date.now() + ARM_MS }; renderStop(); $('th-stop-no').focus(); });
  $('th-stop-yes').addEventListener('click', stopNow);
  $('th-stop-no').addEventListener('click', () => { stopAsk = null; renderStop(); $('th-stop-btn').focus(); });
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

  // Coming back into view re-arms every choice (R3.4), then refreshes.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { rearmAll(); renderCards(); renderReply(); renderStop(); refresh(); } });
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
