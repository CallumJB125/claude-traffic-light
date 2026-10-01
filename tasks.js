// The Tasks page: a list of every task on the left, the open task (or the
// composer) on the right. Everything comes from main already sanitised; every
// string reaches the DOM through textContent. The page has no path, token or
// socket of its own: a folder is an opaque handle main gave it.
(function () {
  const api = window.tasksApi;
  const TV = window.TasksView;
  if (new URLSearchParams(location.search).get('embedded') !== '1') document.body.classList.add('standalone');

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const btn = (label, cls, onClick) => { const b = el('button', `btn ${cls || ''}`.trim(), label); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

  let snap = null;                 // { conn, tasks }
  let selectedId = null;
  let view = 'detail';             // 'detail' | 'composer'
  let d = null;                    // the open task's page state, see openTask()
  let comp = null;                 // composer state
  let pendingSelect = null;        // a task just created, selected when it shows in the list

  const byId = (id) => snap?.tasks.find((t) => t.id === id) || null;
  const connected = () => snap?.conn.status === 'connected';

  // ───────────────────────── list ─────────────────────────
  function renderList() {
    const list = $('list');
    const focusId = document.activeElement?.dataset?.id;
    list.replaceChildren();
    const note = $('conn-note');
    const empty = $('list-empty');
    const tasks = snap?.tasks || [];
    note.hidden = !snap || connected() || snap.conn.status === 'connecting' || !tasks.length;
    note.textContent = 'Not connected to the background helper. Showing what it last reported.';
    empty.hidden = tasks.length > 0;
    empty.textContent = !snap || snap.conn.status === 'connecting' ? 'Connecting…' : connected() ? 'No tasks yet.' : '';
    const now = Date.now();
    for (const t of tasks) {
      const r = TV.rowView(t, now);
      const li = el('li');
      const b = el('button', `row${r.stale ? ' stale' : ''}`);
      b.type = 'button';
      b.dataset.id = r.id;
      b.setAttribute('aria-current', String(r.id === selectedId && view === 'detail'));
      const dot = el('span', `dot ${r.green ? 'green' : r.tone}`);
      dot.setAttribute('aria-hidden', 'true');
      const title = el('span', 't', r.title);
      if (r.unread) { const u = el('span', 'badge', String(r.unread)); u.setAttribute('aria-label', `${r.unread} unread`); title.append(u); }
      b.append(dot, title, el('span', 'age', r.age), el('span', 'why', `${r.label}${r.reason ? ` · ${r.reason}` : ''}`), el('span', 'meta', [r.ai, r.where, r.board ? 'board card' : ''].filter(Boolean).join(' · ')));
      b.addEventListener('click', () => selectTask(r.id));
      li.append(b);
      list.append(li);
    }
    if (focusId) list.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus();
  }

  // ───────────────────────── main pane ─────────────────────────
  function renderMain() {
    const main = $('main');
    if (view === 'composer') { renderComposer(); return; }
    if (selectedId && d && d.id === selectedId) { if (d.loading) return; if (!main.querySelector('.detail')) buildDetail(); renderHead(); return; }
    d = null;
    main.replaceChildren(emptyState());
  }

  function emptyState() {
    const box = el('div', 'center');
    if (!snap || snap.conn.status === 'connecting') { box.append(el('h2', null, 'Connecting…')); return box; }
    if (!connected()) {
      box.append(el('h2', null, snap.conn.title), el('p', null, snap.conn.hint));
      box.append(btn('Try again now', '', () => api.retry()));
      return box;
    }
    if (!snap.tasks.length) {
      box.append(el('h2', null, 'No tasks yet'), el('p', null, 'Hand something off and it keeps going in the background, even if you quit Plexiform.'));
      const b = btn('New task', 'primary', openComposer);
      box.append(b, el('p', null, ''), (() => { const p = el('p'); p.append('Shortcut: ', Object.assign(el('kbd'), { textContent: '⌥⌘T' })); return p; })());
      return box;
    }
    box.append(el('h2', null, 'Pick a task'), el('p', null, 'Choose one on the left to see what it is doing, or start a new one.'));
    return box;
  }

  async function selectTask(id) {
    view = 'detail';
    selectedId = id;
    renderList();
    await openTask(id);
  }

  // ───────────────────────── detail ─────────────────────────
  async function openTask(id) {
    const my = id;
    d = { id, loading: true, tab: 'transcript', tx: TV.newTranscript(), messages: [], follow: true, error: '', confirm: null, takeover: null, detail: null, shown: { dropped: 0 }, unreadMsg: 0 };
    $('main').replaceChildren(Object.assign(el('div', 'center'), {}));
    $('main').firstChild.append(el('h2', null, 'Opening…'));
    const r = await api.open(id);
    if (selectedId !== my || !d || d.id !== my) return;
    if (!r || !r.ok) {
      $('main').replaceChildren();
      const box = el('div', 'center');
      box.append(el('h2', null, 'Could not open that task'), el('p', null, r?.text || TV.errorText('INTERNAL')));
      $('main').append(box);
      d = null;
      return;
    }
    d.loading = false;
    d.detail = r.detail;
    d.messages = [...r.detail.messages];
    for (const e of r.replay) applyEvent(e, true);
    buildDetail();
    renderHead();
    syncTranscript();
    syncThread();
    scrollToEnd($('pane-transcript'));
  }

  function buildDetail() {
    const main = $('main');
    main.replaceChildren();
    const root = el('div', 'detail');
    root.append(el('div', 'd-head'), el('div', null), el('div', 'tabs'));
    root.children[0].id = 'd-head';
    root.children[1].id = 'd-banners';
    const tabs = root.children[2];
    tabs.setAttribute('role', 'tablist');
    for (const [id, label] of [['transcript', 'Transcript'], ['messages', 'Messages'], ['details', 'Details']]) {
      const t = el('button', 'tab', label);
      t.type = 'button'; t.id = `tab-${id}`; t.setAttribute('role', 'tab');
      t.addEventListener('click', () => setTab(id));
      tabs.append(t);
    }
    const tx = el('section', 'pane'); tx.id = 'pane-transcript';
    const txBox = el('div', 'tx'); txBox.id = 'tx';
    const jump = btn('Jump to latest', 'small jump', () => { d.follow = true; scrollToEnd(tx); jump.hidden = true; }); jump.hidden = true; jump.id = 'jump';
    tx.append(txBox, jump);
    tx.addEventListener('scroll', () => { d.follow = tx.scrollHeight - tx.scrollTop - tx.clientHeight < 40; $('jump').hidden = d.follow; });
    const msgs = el('section', 'pane'); msgs.id = 'pane-messages';
    const thread = el('div', 'thread'); thread.id = 'thread';
    msgs.append(thread, buildSendForm());
    const det = el('section', 'pane'); det.id = 'pane-details';
    root.append(tx, msgs, det);
    main.append(root);
    setTab(d.tab);
  }

  function setTab(id) {
    d.tab = id;
    for (const t of ['transcript', 'messages', 'details']) {
      $(`pane-${t}`).hidden = t !== id;
      $(`tab-${t}`).setAttribute('aria-selected', String(t === id));
    }
    if (id === 'messages') { d.unreadMsg = 0; scrollToEnd($('pane-messages')); }
    if (id === 'details') renderDetails();
    updateTabBadge();
  }
  function updateTabBadge() {
    const t = $('tab-messages');
    if (t) t.textContent = d.unreadMsg ? `Messages (${d.unreadMsg} new)` : 'Messages';
  }

  function renderHead() {
    const t = byId(d.id) || d.detail;
    const head = $('d-head');
    if (!head) return;
    head.replaceChildren();
    head.append(el('h2', 'd-title', t.title || 'Untitled task'));
    const st = el('div', 'd-state');
    const dot = el('span', `dot ${t.green ? 'green' : t.tone}`); dot.setAttribute('aria-hidden', 'true');
    st.append(dot, el('span', null, t.label));
    head.append(st);
    if (t.reason) head.append(el('p', 'd-reason', t.reason));
    const bits = [TV.AI_NAME[t.ai.id] || 'AI', t.where || t.repo?.name, t.branch, t.cost.usd ? `$${t.cost.usd.toFixed(2)}${t.cost.budgetUsd != null ? ` of $${t.cost.budgetUsd.toFixed(2)}` : ''}` : ''].filter(Boolean);
    head.append(el('p', 'd-meta', bits.join(' · ')));
    const actions = el('div', 'd-actions');
    head.append(actions);
    for (const a of actionButtons(t)) actions.append(a);
    if (d.confirm) head.append(confirmBar(t));
    const err = el('p', 'err', d.error); err.setAttribute('role', 'alert');
    head.append(err);
    renderBanners(t);
    $('send-box') && updateSendForm(t);
    if (d.tab === 'details') renderDetails();
  }

  // Actions the supervisor allows right now, minus the ones with their own control (message, approve/deny/answer).
  function actionButtons(t) {
    const out = [];
    const has = (a) => t.actions.includes(a);
    const go = (action, payload, label, cls) => {
      // discard, openPr and takeover are confirmed by main in a native dialog; the lighter ones by the bar below.
      const needs = !TV.NATIVE_CONFIRM.includes(action) && (TV.CONFIRM_ACTIONS.includes(action) || t.confirm.includes(action));
      return btn(label, cls, () => (needs ? askConfirm({ action, payload, label }) : runAct(action, payload)));
    };
    if (has('resume')) {
      out.push(go('resume', { when: 'now' }, 'Resume now', 'primary'));
      if (t.parkReason === 'limit') out.push(go('resume', { when: 'reset' }, 'Resume when the limit resets'));
    }
    if (has('handback')) out.push(go('handback', {}, TV.ACTION_LABEL.handback, 'primary'));
    if (has('merge')) out.push(go('merge', { strategy: 'merge' }, 'Merge into your branch', 'primary'));
    if (has('openPr')) out.push(go('openPr', {}, TV.ACTION_LABEL.openPr));
    if (has('retry')) { out.push(go('retry', {}, 'Retry')); out.push(go('retry', { fresh: true }, 'Retry from scratch')); }
    if (has('switchAi')) for (const id of Object.keys(TV.AI_NAME)) if (id !== t.ai.id) out.push(go('switchAi', { ai: id }, `Continue with ${TV.AI_NAME[id]}`));
    if (has('pause')) out.push(go('pause', {}, TV.ACTION_LABEL.pause));
    if (has('takeover')) out.push(go('takeover', {}, TV.ACTION_LABEL.takeover));
    if (has('stop')) out.push(go('stop', {}, TV.ACTION_LABEL.stop, 'danger'));
    if (has('discard')) out.push(go('discard', {}, TV.ACTION_LABEL.discard, 'danger'));
    return out;
  }

  const ARM_MS = 500;
  function askConfirm(c) { d.confirm = { ...c, armedAt: Date.now() + ARM_MS }; d.error = ''; renderHead(); $('d-head').querySelector('.confirm .btn:last-child')?.focus(); }
  function confirmBar() {
    const box = el('div', 'confirm');
    box.setAttribute('role', 'alertdialog');
    box.append(el('p', null, TV.CONFIRM_TEXT[d.confirm.action] || 'Are you sure?'));
    const yes = btn(`Yes, ${d.confirm.label.toLowerCase()}`, d.confirm.action === 'stop' ? 'danger' : 'primary', () => { const c = d.confirm; if (Date.now() < c.armedAt) return; d.confirm = null; runAct(c.action, c.payload, true); });
    // A click that lands the instant the bar appears must not confirm; focus starts on Cancel.
    const wait = d.confirm.armedAt - Date.now();
    if (wait > 0) { yes.disabled = true; setTimeout(() => { yes.disabled = false; }, wait); }
    box.append(yes, btn('Cancel', '', () => { d.confirm = null; renderHead(); }));
    return box;
  }

  async function runAct(action, payload, confirmed = false) {
    d.error = '';
    d.takeover = null;
    const id = d.id;
    const r = await api.act({ id, action, payload, confirmed });
    if (!d || d.id !== id) return r;
    if (r && r.cancelled) d.error = '';
    else if (!r || !r.ok) d.error = r?.text || TV.errorText('INTERNAL');
    else if (r.takeover) d.takeover = r.takeover;
    renderHead();
    return r;
  }

  // Permission requests, questions and the supervisor's own choices (wait for the limit, switch AI…).
  function renderBanners(t) {
    const box = $('d-banners');
    box.replaceChildren();
    const det = d.detail;
    const has = (a) => t.actions.includes(a);
    if (has('approve') || has('deny')) {
      for (const a of det.openApprovals) {
        const c = el('div', 'ask');
        if (a.tool === 'StartTask') {
          c.append(el('h3', null, 'Waiting for you to accept this task'));
          // Plexiform's own facts first; the summary below is the sender's words.
          const facts = el('dl', 'facts');
          for (const [k, v] of [['Runs in', det.where || det.repo?.name], ['AI', TV.AI_NAME[det.ai.id]], ['Permissions', det.permissionLevel], ['Source', { cli: 'the buddy command', mcp: 'another AI session', board: 'a teammate', phone: 'a phone', slack: 'Slack', voice: 'voice' }[det.source] || det.source]]) if (v) facts.append(el('dt', null, k), el('dd', null, v));
          c.append(el('p', 'sub', 'Checked by Plexiform:'), facts, el('p', 'sub', `From ${det.source}: (untrusted)`), el('p', null, a.inputSummary));
        } else c.append(el('h3', null, `Wants to use ${a.tool}`), el('p', null, a.inputSummary));
        const b = el('div', 'btns');
        if (has('approve')) { b.append(btn(a.tool === 'StartTask' ? 'Accept and start' : 'Allow once', 'primary', () => runAct('approve', { approvalId: a.approvalId, scope: 'once' }))); if (a.tool !== 'StartTask') b.append(btn('Allow for this task', '', () => runAct('approve', { approvalId: a.approvalId, scope: 'task' }))); }
        if (has('deny')) b.append(btn('Deny', 'danger', () => runAct('deny', { approvalId: a.approvalId })));
        c.append(b);
        box.append(c);
      }
    }
    const ask = det.openAsk;
    if (ask && (ask.choices?.length || has('answer'))) {
      const c = el('div', 'ask');
      c.append(el('h3', null, 'Needs your answer'), el('p', null, ask.text));
      if (ask.choices?.length) {
        const b = el('div', 'btns');
        for (const ch of ask.choices) if (has(ch.action)) b.append(btn(ch.label, '', () => (TV.CONFIRM_ACTIONS.includes(ch.action) ? askConfirm({ action: ch.action, payload: ch.payload, label: ch.label }) : runAct(ch.action, ch.payload))));
        c.append(b);
      }
      if (has('answer') && !ask.choices?.length) {
        if (ask.options?.length) {
          const b = el('div', 'btns');
          for (const o of ask.options) b.append(btn(o, '', () => runAct('answer', { askId: ask.askId, answer: o })));
          c.append(b);
        }
        const ta = el('textarea'); ta.setAttribute('aria-label', 'Your answer'); ta.maxLength = TV.LIMITS.answer;
        const send = btn('Send answer', 'primary', async () => { if (ta.value.trim()) { send.disabled = true; await runAct('answer', { askId: ask.askId, answer: ta.value }); } });
        c.append(ta, send);
      }
      box.append(c);
    }
    if (d.takeover) {
      const c = el('div', 'takeover');
      c.append(el('strong', null, 'Run this in your terminal to carry on'), (() => { const p = el('pre', null, d.takeover.command); return p; })());
      if (d.takeover.note) c.append(el('p', null, d.takeover.note));
      const copied = el('span', null, '');
      c.append(btn('Copy command', '', async () => { copied.textContent = (await api.copyTakeover(d.id)) ? ' Copied.' : ' Could not copy.'; }), copied);
      box.append(c);
    }
  }

  // ───────────────────────── transcript ─────────────────────────
  let rafPending = false;
  function syncSoon() { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; syncTranscript(); }); }

  function syncTranscript() {
    const box = $('tx');
    if (!box || !d) return;
    const t = d.tx;
    for (; d.shown.dropped < t.dropped; d.shown.dropped++) box.firstElementChild?.remove();
    t.items.forEach((it, i) => {
      let n = box.children[i];
      const sig = `${it.kind}:${it.text?.length ?? it.summary?.length}:${it.done}:${it.ok}`;
      if (n && n.dataset.sig === sig) return;
      const fresh = renderItem(it);
      fresh.dataset.sig = sig;
      if (n) n.replaceWith(fresh); else box.append(fresh);
    });
    if (!t.items.length && !box.querySelector('.tx-empty')) box.append(el('p', 'tx-empty', 'Nothing yet. What the AI says and does shows up here as it works.'));
    else if (t.items.length) box.querySelector('.tx-empty')?.remove();
    if (d.follow) scrollToEnd($('pane-transcript'));
  }
  function renderItem(it) {
    if (it.kind === 'text') return el('div', `msg ${it.role}`, it.text);
    if (it.kind === 'tool') {
      const dur = it.durationMs != null ? ` · ${(it.durationMs / 1000).toFixed(1)}s` : '';
      return el('div', `tool${it.done && it.ok === false ? ' bad' : ''}`, `${it.done ? (it.ok === false ? '✗' : '✓') : '…'} ${it.name}${it.summary ? ` · ${it.summary}` : ''}${dur}`);
    }
    return el('div', 'note', it.text);
  }
  function scrollToEnd(n) { if (n) n.scrollTop = n.scrollHeight; }

  // ───────────────────────── messages ─────────────────────────
  function syncThread() {
    const box = $('thread');
    if (!box || !d) return;
    const stick = $('pane-messages').scrollHeight - $('pane-messages').scrollTop - $('pane-messages').clientHeight < 60;
    box.replaceChildren();
    if (!d.messages.length) box.append(el('p', 'tx-empty', 'No messages yet. Anything you send, or another task sends, is kept here.'));
    for (const m of d.messages) {
      const mine = TV.isMine(m);
      const b = el('div', `bubble ${mine ? 'out' : 'in'}${m.quarantined ? ' flagged' : ''}`);
      const peer = !mine && m.direction === 'in';
      b.append(el('div', 'who', mine ? 'You' : m.direction === 'out' ? `This task to ${TV.partyText(m.to)}` : `From ${TV.partyText(m.from)}${peer ? ' (untrusted)' : ''}`));
      b.append(el('div', 'body', m.body));
      const status = TV.messageStatus(m);
      if (status) b.append(el('div', 'st', status));
      box.append(b);
    }
    if (stick) scrollToEnd($('pane-messages'));
  }

  function buildSendForm() {
    const f = el('div', 'send'); f.id = 'send-box';
    const ta = el('textarea'); ta.id = 'send-text'; ta.setAttribute('aria-label', 'Message to this task'); ta.placeholder = 'Message this task…';
    const row = el('div', 'row2');
    const hint = el('span', 'hint'); hint.id = 'send-hint';
    const send = btn('Send', 'primary'); send.id = 'send-btn';
    row.append(hint, send);
    const err = el('p', 'err'); err.id = 'send-err'; err.setAttribute('role', 'alert');
    f.append(ta, row, err);
    const go = async () => {
      const v = TV.validateMessage(ta.value);
      if (!v.ok) { err.textContent = v.error; return; }
      send.disabled = true; err.textContent = '';
      const r = await api.act({ id: d.id, action: 'message', payload: { body: ta.value } });
      send.disabled = false;
      if (!r || !r.ok) err.textContent = r?.text || TV.errorText('INTERNAL'); else ta.value = '';
      updateSendForm(byId(d.id) || d.detail);
    };
    send.addEventListener('click', go);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } });
    ta.addEventListener('input', () => { err.textContent = ''; updateSendForm(byId(d.id) || d.detail); });
    return f;
  }
  function updateSendForm(t) {
    const ta = $('send-text'); const send = $('send-btn'); const hint = $('send-hint');
    if (!ta) return;
    const can = t.actions.includes('message');
    ta.disabled = !can;
    send.disabled = !can || !ta.value.trim();
    const bytes = new TextEncoder().encode(ta.value).length;
    hint.textContent = can ? (bytes > TV.LIMITS.message * 0.8 ? `${bytes.toLocaleString('en')} of ${TV.LIMITS.message.toLocaleString('en')} bytes · ` : '') + '⌘↵ to send' : `You can't message this task while it is "${t.label}".`;
  }

  // ───────────────────────── details tab ─────────────────────────
  function renderDetails() {
    const pane = $('pane-details');
    if (!pane || !d) return;
    const t = d.detail; const live = byId(d.id) || t;
    pane.replaceChildren();
    const dl = el('dl', 'facts');
    const fact = (k, v) => { if (v == null || v === '') return; dl.append(el('dt', null, k), el('dd', null, v)); };
    const ai = TV.AI_NAME[t.ai.id] || 'AI';
    fact('AI', `${ai}${t.ai.model ? ` (${t.ai.model})` : ''}${t.ai.reason ? ` · ${t.ai.reason}` : ''}`);
    fact('Folder', t.where || t.repo?.name);
    fact('Branch', t.branch ? `${t.branch}${t.baseBranch ? ` (from ${t.baseBranch})` : ''}` : t.workInPlace ? 'Working directly in your folder' : null);
    fact('Worktree', t.worktree);
    fact('Runs', { background: 'In the background', tmux: 'In tmux', tab: 'In a terminal tab' }[t.surface]);
    fact('Permissions', `${{ plan: 'Plan only', ask: 'Asks before risky things', 'auto-edits': 'Edits files freely', auto: 'Automatic', bypass: 'Bypass (no checks)' }[t.permissionLevel] || t.permissionLevel}${t.planFirst ? ' · plan reviewed first' : ''}`);
    fact('Started from', { local: 'This Mac', cli: 'The buddy command', mcp: 'Another AI session spun it off', board: 'A teammate', phone: 'Your phone', slack: 'Slack', voice: 'Voice' }[t.source] || null);
    if (t.hub) fact('Board card', t.hub.cardKey);
    fact('Cost', live.cost.usd ? `$${live.cost.usd.toFixed(2)}${live.cost.budgetUsd != null ? ` of $${live.cost.budgetUsd.toFixed(2)} budget` : ''}` : null);
    if (t.evidence) {
      fact('Tests', { pass: 'Passed', fail: 'Failed', none: 'None ran' }[t.evidence.tests] || t.evidence.tests);
      if (t.evidence.diffStat) fact('Changes', `${t.evidence.diffStat.files} file${t.evidence.diffStat.files === 1 ? '' : 's'}, +${t.evidence.diffStat.added} −${t.evidence.diffStat.removed}`);
      fact('Summary', t.evidence.summary);
    }
    if (t.pr) fact('Pull request', `#${t.pr.number} (${t.pr.state})`);
    pane.append(dl);
    pane.append(el('div', 'sect', 'What you asked'), el('pre', 'box', t.text));
    pane.append(el('div', 'sect', t.handover ? `Handover (version ${t.handover.version}, ${t.handover.provenance.replace(/_/g, ' ')})` : 'Handover'));
    pane.append(t.handover ? el('pre', 'box', t.handover.markdown) : el('p', 'tx-empty', 'No handover saved yet. One is written as the task works, so it can be picked up later.'));
  }

  // ───────────────────────── live events ─────────────────────────
  function applyEvent(e, replay = false) {
    if (e.type === 'transcript' || e.type === 'tool' || e.type === 'error') { if (TV.addEvent(d.tx, e) && !replay) syncSoon(); return; }
    if (e.type === 'message' || e.type === 'message-state') {
      const changed = TV.mergeMessage(d.messages, e);
      if (changed && !replay) {
        if (e.type === 'message' && e.direction === 'in' && !TV.isMine(e) && d.tab !== 'messages') { d.unreadMsg += 1; updateTabBadge(); }
        syncThread();
      }
      return;
    }
    if (e.type === 'detail') { d.detail = e.detail; renderHead(); return; }
    if (e.type === 'state' || e.type === 'cost') return; // the list snapshot carries these
  }

  // ───────────────────────── composer ─────────────────────────
  async function openComposer() {
    if (view === 'composer') { $('c-text')?.focus(); return; }
    view = 'composer';
    d && api.close();
    d = null;
    comp = { folder: null, recent: [], ais: [], ai: 'auto', surface: 'background', perm: 'auto-edits', planFirst: false, busy: false, error: '' };
    renderList();
    renderComposer();
    const info = await api.composer();
    if (view !== 'composer' || !comp) return;
    if (info) { comp.ais = info.ais; comp.recent = info.recent; renderComposer(true); }
  }

  function closeComposer() {
    view = 'detail'; comp = null;
    renderList();
    if (selectedId) openTask(selectedId); else renderMain();
  }

  function renderComposer(keepFocus = false) {
    const main = $('main');
    const text = $('c-text')?.value ?? '';
    const hadFocus = keepFocus && document.activeElement === $('c-text');
    main.replaceChildren();
    const root = el('form', 'composer');
    root.addEventListener('submit', (e) => { e.preventDefault(); submitComposer(); });
    root.append(el('h2', null, 'New task'));
    if (!connected()) {
      root.append(el('p', 'err', 'The background helper is not running, so a task cannot be started yet.'));
    }
    const words = el('div', 'field');
    const lbl = el('label', null, 'What should it do?'); lbl.htmlFor = 'c-text';
    const ta = el('textarea'); ta.id = 'c-text'; ta.value = text; ta.placeholder = 'Describe the job in your own words…';
    const count = el('div', 'sub'); count.id = 'c-count';
    ta.addEventListener('input', () => { updateCount(); comp.error = ''; $('c-err').textContent = ''; });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitComposer(); } });
    words.append(lbl, ta, count);

    const where = el('div', 'field');
    where.append(el('span', 'lbl', 'Which folder?'));
    const pick = btn(comp.folder ? 'Change folder…' : 'Choose folder…', '', async () => { const f = await api.pickFolder(); if (f) { comp.folder = f; comp.error = ''; renderComposer(true); } });
    pick.id = 'c-folder-btn';
    const chosen = el('span', null, comp.folder ? `  ${comp.folder.label}` : '  None chosen'); chosen.id = 'c-folder';
    where.append(pick, chosen);
    if (comp.recent.length) {
      const chips = el('div', 'chips');
      for (const r of comp.recent) { const c = el('button', 'chip', r.label); c.type = 'button'; c.setAttribute('aria-pressed', String(comp.folder?.handle === r.handle)); c.addEventListener('click', () => { comp.folder = r; comp.error = ''; renderComposer(true); }); chips.append(c); }
      where.append(chips);
    }
    where.append(el('div', 'sub', 'The task works on its own copy (a git worktree), so your files stay untouched until you review and merge.'));

    const aiF = el('div', 'field');
    const aiL = el('label', null, 'Which AI?'); aiL.htmlFor = 'c-ai';
    const sel = el('select'); sel.id = 'c-ai';
    const add = (v, label, disabled) => { const o = el('option', null, label); o.value = v; o.disabled = !!disabled; sel.append(o); };
    add('auto', 'Choose for me');
    for (const a of comp.ais) add(a.id, `${a.label}${!a.installed ? ' (not installed)' : a.loggedIn === false ? ' (logged out)' : ''}`, !a.installed || a.loggedIn === false);
    if (!comp.ais.some((a) => a.id === comp.ai)) comp.ai = 'auto';
    sel.value = comp.ai;
    sel.addEventListener('change', () => { comp.ai = sel.value; });
    aiF.append(aiL, sel, el('div', 'sub', 'Choosing for you picks an AI that is installed, logged in and not at its limit, and tells you why.'));

    const surf = el('div', 'field radios');
    surf.append(el('span', 'lbl', 'Where does it run?'));
    for (const [v, label] of [['background', 'In the background (recommended): keeps going if you quit the app'], ['tab', 'In a terminal tab, so you can watch and type'], ['tmux', 'In tmux']]) {
      const l = el('label'); const r = el('input'); r.type = 'radio'; r.name = 'c-surface'; r.value = v; r.checked = comp.surface === v;
      r.addEventListener('change', () => { comp.surface = v; });
      l.append(r, ` ${label}`); surf.append(l);
    }

    const permF = el('div', 'field');
    const permL = el('label', null, 'How much may it do without asking?'); permL.htmlFor = 'c-perm';
    const perm = el('select'); perm.id = 'c-perm';
    for (const [v, label] of [['plan', 'Plan only: it writes a plan and changes nothing'], ['ask', 'Ask me before anything risky'], ['auto-edits', 'Edit files freely, ask for the rest']]) { const o = el('option', null, label); o.value = v; perm.append(o); }
    perm.value = comp.perm;
    perm.addEventListener('change', () => { comp.perm = perm.value; });
    const pf = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = comp.planFirst; cb.addEventListener('change', () => { comp.planFirst = cb.checked; });
    pf.append(cb, ' Show me its plan first and wait for my go-ahead');
    permF.append(permL, perm, el('div', 'sub'), pf);

    const foot = el('div', 'foot');
    const go = btn('Start task', 'primary'); go.type = 'submit'; go.id = 'c-go'; go.disabled = !connected() || comp.busy;
    const cancel = btn('Cancel', '', closeComposer);
    const err = el('span', 'err', comp.error); err.id = 'c-err'; err.setAttribute('role', 'alert');
    foot.append(go, cancel, err);
    root.append(words, where, aiF, surf, permF, foot);
    main.append(root);
    updateCount();
    if (!keepFocus || hadFocus || !text) ta.focus();
  }

  function updateCount() {
    const n = $('c-text').value.length;
    $('c-count').textContent = `${n.toLocaleString('en')} of ${TV.LIMITS.taskText.toLocaleString('en')}`;
  }

  async function submitComposer() {
    if (!comp || comp.busy || !connected()) return;
    const text = $('c-text').value;
    const v = TV.validateDraft({ text, hasFolder: !!comp.folder });
    if (!v.ok) { comp.error = v.error; $('c-err').textContent = v.error; return; }
    comp.busy = true; $('c-go').disabled = true; $('c-err').textContent = '';
    const r = await api.create({ text, folder: comp.folder.handle, ai: comp.ai, surface: comp.surface, permissionLevel: comp.perm, planFirst: comp.planFirst });
    if (!comp) return;
    comp.busy = false;
    if (!r || !r.ok) { comp.error = r?.text || TV.errorText('INTERNAL'); renderComposer(true); return; }
    comp = null; view = 'detail'; selectedId = r.id; pendingSelect = r.id;
    renderList();
    if (byId(r.id)) { pendingSelect = null; openTask(r.id); } else $('main').replaceChildren(Object.assign(el('div', 'center'), {}));
  }

  // ───────────────────────── snapshots ─────────────────────────
  function onSnapshot(s) {
    if (!s) return;
    const was = connected();
    snap = s;
    if (!connected()) comp && view === 'composer' && renderComposer(true);
    renderList();
    if (pendingSelect && byId(pendingSelect)) { const id = pendingSelect; pendingSelect = null; openTask(id); return; }
    if (view === 'detail') {
      if (selectedId && !byId(selectedId) && connected()) { selectedId = null; d = null; api.close(); }
      if (!d) renderMain();
      else if (d.id === selectedId && !d.loading) renderHead();
      // a reconnect hands us a fresh stream: reopen the task so nothing is missed
      if (!was && connected() && selectedId && d && !d.loading) openTask(selectedId);
      if (view === 'detail' && d && !connected()) renderHead();
    } else if (comp && !was && connected()) renderComposer(true);
  }

  $('new-task').addEventListener('click', openComposer);
  document.addEventListener('keydown', (e) => {
    // In-window only: no global hotkey.
    if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyT') { e.preventDefault(); openComposer(); return; }
    if (e.key === 'Escape') {
      if (d?.confirm) { d.confirm = null; renderHead(); } else if (view === 'composer') closeComposer();
    }
  });
  api.onChanged(onSnapshot);
  api.onEvent((m) => {
    if (!d || m.id !== d.id || d.loading) return;
    if (m.event.type === 'reset') { openTask(d.id); return; }
    applyEvent(m.event);
  });
  setInterval(() => { if (document.visibilityState === 'visible' && snap) renderList(); }, 30000);
  api.state().then((s) => { onSnapshot(s); if (!snap) renderMain(); });
  renderMain();
})();
