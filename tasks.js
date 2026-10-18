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
      box.append(el('h2', null, 'No tasks yet'), el('p', null, 'Hand something off and it keeps going when you close this window. Quitting Plexiform stops active runs; their history and work are saved for retry.'),
        el('p', null, 'A task is a one-off hand-off. Work you want to track is a card on the Board, and Send to AI… on a card runs the AI there, on the card.'));
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
    d = { id, loading: true, tab: 'overview', tx: TV.newTranscript(), messages: [], follow: true, error: '', confirm: null, takeover: null, detail: null, shown: { dropped: 0 }, unreadMsg: 0, diff: null };
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
    for (const [id, label] of [['overview', 'Overview'], ['transcript', 'Transcript'], ['messages', 'Messages'], ['details', 'Details']]) {
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
    const overview = el('section', 'pane'); overview.id = 'pane-overview';
    root.append(overview, tx, msgs, det);
    main.append(root);
    setTab(d.tab);
  }

  function setTab(id) {
    d.tab = id;
    for (const t of ['overview', 'transcript', 'messages', 'details']) {
      $(`pane-${t}`).hidden = t !== id;
      $(`tab-${t}`).setAttribute('aria-selected', String(t === id));
    }
    if (id === 'messages') { d.unreadMsg = 0; scrollToEnd($('pane-messages')); }
    if (id === 'details') renderDetails();
    if (id === 'overview') renderOverview();
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
    if (d.integration && t.state === 'in_review') head.append(integrationReview(d.integration));
    if (d.providerChange && hasProviderChange(t)) head.append(providerChangeReview(d.providerChange));
    if (d.prDraft && t.actions.includes('openPr')) head.append(pullRequestDraft());
    if (d.pullRequest) head.append(pullRequestReview(d.pullRequest));
    const err = el('p', 'err', d.error); err.setAttribute('role', 'alert');
    head.append(err);
    renderBanners(t);
    $('send-box') && updateSendForm(t);
    if (d.tab === 'details') renderDetails();
    if (d.tab === 'overview') renderOverview();
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
    if (has('merge')) { const review = btn(d.integrating ? 'Checking integration…' : 'Review integration', 'primary', () => runAct('merge', { phase: 'preview' })); review.disabled = !!d.integrating; out.push(review); }
    if (has('openPr')) { const b=btn('Prepare draft pull request','',()=>{d.prDraft??={title:t.title||'',body:''};d.pullRequest=null;renderHead();});b.disabled=!!d.creatingPr;out.push(b); }
    if (has('retry')) { out.push(go('retry', {}, 'Retry')); out.push(go('retry', { fresh: true }, d.detail.checkpoint || d.detail.handover ? 'Restart from checkpoint' : 'Retry from scratch')); }
    if (has('switchAi')) for (const id of ['claude', 'codex']) if (id !== t.ai.id) out.push(go('switchAi', { phase: 'preview', ai: id }, `Continue with ${TV.AI_NAME[id]}`));
    if (has('pause')) out.push(go('pause', {}, TV.ACTION_LABEL.pause));
    if (has('takeover')) out.push(go('takeover', {}, TV.ACTION_LABEL.takeover));
    if (has('stop')) out.push(go('stop', {}, TV.ACTION_LABEL.stop, 'danger'));
    if (has('discard')) out.push(go('discard', {}, TV.ACTION_LABEL.discard, 'danger'));
    if (d.switching) for (const button of out) button.disabled = true;
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
    if (d.integrating || d.switching || d.creatingPr) return;
    d.error = '';
    d.takeover = null;
    const id = d.id;
    if (action === 'merge') { d.integrating = true; if (payload.phase === 'apply') d.integration = null; renderHead(); }
    else d.integration = null;
    if (action === 'switchAi') { d.switching = true; if (payload.phase === 'apply') d.providerChange = null; renderHead(); }
    else d.providerChange = null;
    if (action === 'openPr') { d.creatingPr=true; renderHead(); }
    else d.pullRequest=null;
    let r;
    try { r = await api.act({ id, action, payload, confirmed }); }
    catch { r = { ok: false, text: action === 'merge' && payload.phase === 'apply' ? 'Integration receipt unconfirmed. Inspect your branch before reviewing another integration.' : TV.errorText('INTERNAL') }; }
    if (!d || d.id !== id) return r;
    d.integrating = false;
    d.switching = false;
    d.creatingPr = false;
    if (r && r.cancelled) d.error = '';
    else if (!r || !r.ok) d.error = r?.text || TV.errorText('INTERNAL');
    else if (r.takeover) d.takeover = r.takeover;
    else if (r.integration) { d.integration = r.integration.status === 'merged' ? null : r.integration; if (r.integration.status === 'merged') d.error = 'Reviewed changes integrated. Nothing was pushed; the task worktree is kept.'; }
    else if (r.providerChange) { d.providerChange = r.providerChange.status === 'review' ? r.providerChange : null; if (r.providerChange.status === 'queued') d.error = `Reviewed handover queued for ${TV.AI_NAME[r.providerChange.to]}. Watch this task for the new session’s response.`; }
    else if (r.pullRequest) { d.pullRequest=r.pullRequest;d.prDraft=null; }
    renderHead();
    return r;
  }

  const hasProviderChange = t => t.actions.includes('switchAi');
  function pullRequestDraft() {
    const box=el('section','integration-review pr-draft'),title=el('input'),body=el('textarea');
    box.append(el('h3',null,'Prepare a GitHub draft'),el('p',null,'Commit and publish this task branch first. Plexiform checks its current GitHub destination and changes, then asks you to confirm the exact draft.'));
    title.value=d.prDraft.title;title.maxLength=120;title.setAttribute('aria-label','Pull request title');
    body.value=d.prDraft.body;body.maxLength=10000;body.rows=5;body.setAttribute('aria-label','Pull request description');
    title.disabled=body.disabled=!!d.creatingPr;
    title.addEventListener('input',()=>{d.prDraft.title=title.value;});body.addEventListener('input',()=>{d.prDraft.body=body.value;});
    const review=btn(d.creatingPr?'Checking GitHub…':'Review draft pull request','primary',()=>runAct('openPr',{phase:'preview',title:title.value,body:body.value}));review.disabled=!!d.creatingPr;
    const cancel=btn('Close draft','',()=>{d.prDraft=null;renderHead();});cancel.disabled=!!d.creatingPr;box.append(title,body,review,cancel);return box;
  }
  function pullRequestReview(r) {
    const box=el('section','integration-review pr-review');box.append(el('h3',null,r.status==='created'?`Pull request #${r.number}`:'GitHub draft review'));
    if(r.status==='created') {const link=el('a','btn','Open pull request on GitHub');link.href=r.url;link.target='_blank';link.rel='noopener noreferrer';box.append(el('p',null,r.draft?'Draft created.':'Pull request receipt recovered.'),link);if(r.changed)box.append(el('p','err','The remote branches changed. Review the current changes on GitHub before merging.'));return box;}
    if(r.status==='review') {
      box.append(el('p',null,`${r.account} · ${r.repo} · ${r.branch} → ${r.base}`),el('p','sub',`Head ${r.head} · Base ${r.baseHead}`),el('h4',null,r.title),el('pre',null,r.body),el('p',null,'Creates a draft only. Nothing is pushed. Later commits to these branches change the pull request.'));
      const diff=el('details');diff.append(el('summary',null,'Review published changes'),el('pre','diff',r.patch));box.append(diff);
      const apply=btn('Create reviewed draft…','primary',()=>runAct('openPr',{phase:'apply',review:r.review}));apply.disabled=!!d.creatingPr||Date.now()>=r.expiresAt;box.append(apply);
    } else {box.append(el('p',null,r.reason));if(r.status==='unconfirmed'){const check=btn('Check saved GitHub receipt','',()=>runAct('openPr',{phase:'receipt'}));check.disabled=!!d.creatingPr;box.append(check);}}
    const close=btn('Close pull request review','',()=>{d.pullRequest=null;renderHead();});close.disabled=!!d.creatingPr;box.append(close);return box;
  }
  function providerChangeReview(review) {
    const box = el('section', 'integration-review provider-review');
    box.append(el('h3', null, `${TV.AI_NAME[review.from]} → ${TV.AI_NAME[review.to]}`), el('p', null, `Start a new session in the same worktree on ${review.branch}, using reviewed task context v${review.contextVersion}.`),
      el('p', null, `Permission: ${review.permissionLevel} · Model: ${TV.AI_NAME[review.to]} default · ${review.budgetUsd === null ? 'No task spend cap' : `$${review.budgetUsd} task cap; $${review.spentUsd} spent`}. ${review.planFirst ? 'The new AI must submit a fresh plan.' : ''}`));
    const context = el('details'); context.append(el('summary', null, 'Task context to pass to the new AI'), el('pre', null, review.handover)); box.append(context);
    if (review.messagesText) { const messages = el('details'); messages.append(el('summary', null, 'Queued task messages to pass to the new AI'), el('pre', null, review.messagesText)); box.append(messages); }
    const changes = el('details'); changes.append(el('summary', null, `${review.files.length} changed file(s) in the worktree`), el('pre', 'diff', review.patch || 'No changes from the task’s starting revision.')); box.append(changes);
    const apply = btn(`Start reviewed ${TV.AI_NAME[review.to]} session…`, 'primary', () => runAct('switchAi', { phase: 'apply', review: review.review }));
    apply.disabled = !!d.switching || Date.now() >= review.expiresAt;
    const cancel = btn('Close handover review', '', () => { d.providerChange = null; renderHead(); }); cancel.disabled = !!d.switching;
    box.append(apply, cancel); return box;
  }

  function integrationReview(review) {
    const box = el('section', 'integration-review');
    box.append(el('h3', null, `Integration into ${review.branch}`), el('p', null, review.reason));
    if (review.coordination) {
      box.append(el('p', 'sub', `Task context v${review.coordination.decisionVersion} · ${review.coordination.observedClaims} other local task claim(s) checked. Claims report observed work; they are not filesystem locks.`));
      for (const conflict of review.coordination.conflicts) {
        const item = el('p');
        const reason = conflict.reason === 'overlap' ? `Overlapping paths: ${conflict.paths.join(', ')}` : conflict.reason === 'destination-active' ? 'This task may still edit the destination checkout.' : 'This task’s current editing paths are not fully known.';
        item.append(el('span', null, `${conflict.title} · ${conflict.state} · ${reason} `), btn('Inspect task', '', () => selectTask(conflict.taskId)));
        box.append(item);
      }
    }
    const list = el('ul');
    for (const file of review.files) list.append(el('li', null, `${file.status} · ${file.path}`));
    box.append(list);
    if (review.patch) box.append(el('pre', 'diff', review.patch));
    if (review.canApply && review.review) {
      const confirm = btn('Integrate reviewed changes…', 'primary', () => runAct('merge', { phase: 'apply', review: review.review }));
      confirm.disabled = !!d.integrating || Date.now() >= review.expiresAt;
      box.append(confirm, el('p', 'sub', 'Plexiform asks you to confirm this exact review. A changed source or checkout requires a new review.'));
    }
    const cancel = btn('Close review', '', () => { d.integration = null; renderHead(); }); cancel.disabled = !!d.integrating; box.append(cancel);
    return box;
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
    if (d.tab === 'overview') renderOverview();
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
      b.dataset.messageId = m.id; b.tabIndex = -1;
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

  // A compact landing view of this exact task. Reports never imply independent
  // verification, and all actions still go through the existing guarded flows.
  function renderCollaboration(pane, task, live) {
    const parentId = Object.hasOwn(live, 'parentId') ? live.parentId : task.parentId;
    const children = (snap?.tasks || []).filter(row => row.parentId === task.id);
    const receipts = Array.isArray(task.collaboration) ? task.collaboration.slice(-50).sort((a, b) => b.at - a.at) : [];
    if (!parentId && !children.length && !receipts.length) return;
    pane.append(el('h3', 'sect', 'Agent collaboration'));
    const family = el('div', 'box');
    const related = (id, label) => {
      const row = byId(id), line = el('p');
      line.append(el('span', null, `${label}: ${row ? `${row.title || 'Untitled task'} · ${row.label || row.state}` : 'Not available in the current task list'} `));
      if (row) { const open = btn('Open task', 'small', () => selectTask(id)); open.setAttribute('aria-label', `Open task: ${row.title || 'Untitled task'}`); line.append(open); }
      return line;
    };
    if (parentId) family.append(related(parentId, 'Requested by'));
    for (const child of children.slice(0, 20)) family.append(related(child.id, 'Helping task'));
    if (children.length > 20) family.append(el('p', 'tx-empty', `Showing 20 of ${children.length} helping tasks. All remain in the task list.`));
    if (family.childNodes.length) pane.append(family);
    if (!receipts.length) return;
    pane.append(el('p', 'tx-empty', 'Request receipts track delivery. An agent response must be checked in the conversation.'));
    const list = el('ol', 'box');
    const earlier = el('details'), olderList = el('ol', 'box');
    earlier.append(el('summary', null, `${Math.max(0, receipts.length - 5)} earlier request receipts`), olderList);
    const labels = { pending: 'Pending · no delivery confirmed', queued: 'Queued · waiting for delivery', delivered: 'Delivered · no agent response confirmed', uncertain: 'Delivery uncertain · check the conversation before retrying' };
    for (const [index, receipt] of receipts.entries()) {
      const item = el('li');
      item.append(el('strong', null, receipt.kind === 'buddy_spin_off' ? 'Delegated task' : 'Message to agent'), el('p', null, labels[receipt.state] || 'Delivery not confirmed'));
      if (Number.isFinite(receipt.at)) item.append(el('p', 'tx-empty', new Date(receipt.at).toLocaleString()));
      if (receipt.taskId) item.append(related(receipt.taskId, 'Recipient'));
      const message = receipt.messageId && d.messages.find(m => m.id === receipt.messageId);
      if (message) item.append(btn('View message', 'small', () => {
        setTab('messages');
        const bubble = [...$('thread').children].find(node => node.dataset.messageId === receipt.messageId);
        bubble?.scrollIntoView({ block: 'center' }); bubble?.focus();
      }));
      const details = el('details');
      details.append(el('summary', null, 'Delivery details'), el('p', null, `Request: ${receipt.requestId}`));
      if (receipt.messageId) details.append(el('p', null, `Message: ${receipt.messageId}`));
      item.append(details); (index < 5 ? list : olderList).append(item);
    }
    pane.append(list);
    if (receipts.length > 5) pane.append(earlier);
  }

  function renderOverview() {
    const pane = $('pane-overview');
    if (!pane || !d?.detail) return;
    const t = d.detail, live = byId(d.id) || t, p = t.checkpoint;
    pane.replaceChildren();
    if (!connected()) pane.append(el('p', 'err', 'Offline. These are the last received details; reconnect before acting.'));
    const section = (title, text) => {
      pane.append(el('h3', 'sect', title), el('pre', 'box', text || 'Nothing reported yet.'));
    };
    const links = el('div', 'd-actions');
    links.append(btn('Read conversation', '', () => setTab('transcript')), btn('Send a follow-up', '', () => { setTab('messages'); $('send-text')?.focus(); }), btn('Review saved context', '', () => setTab('details')));
    pane.append(links);
    section('Current request', t.text);
    pane.append(el('p', 'tx-empty', t.workInPlace ? 'This task edits the original folder. Coordinate other writers before continuing.' : `Separate working copy${t.branch ? ` · ${t.branch}` : ''}. Changes are combined only through a separate review.`));
    renderCollaboration(pane, t, live);
    const latest = [...d.tx.items].reverse().find(i => i.kind === 'text' && i.role === 'assistant');
    section(latest?.open ? 'Response in progress' : 'Latest reported result', (latest?.text ? (latest.text.length > 8000 ? '…' : '') + latest.text.slice(-8000) : '') || t.evidence?.summary || p?.progress);
    renderSavedOutput(pane, t, latest);
    const stat = d.diff?.stat || t.evidence?.diffStat;
    pane.append(el('h3', 'sect', 'Changes to review'));
    if (stat) pane.append(el('p', null, `${stat.files} files · +${stat.added} −${stat.removed}`));
    if (d.diff?.files?.length) {
      const files = el('ul');
      for (const f of d.diff.files.slice(0, 40)) files.append(el('li', null, `${f.status} · ${f.path}`));
      pane.append(files);
      if (d.diff.files.length > 40) pane.append(el('p', 'tx-empty', 'Showing the first 40 reported paths. Review integration for the current complete change.'));
    } else pane.append(el('p', 'tx-empty', stat ? 'Open Review integration above for the current file changes.' : 'No file changes have been reported yet.'));
    section('Checks reported by the task', [({ pass: 'Passed', fail: 'Failed', none: 'No checks reported' })[t.evidence?.tests] || '', ...(p?.reportedChecks || [])].filter(Boolean).join('\n') || 'No check results recorded.');
    pane.append(el('p', 'tx-empty', 'Reported checks are not an independent verification. Inspect the changes and check output before integrating.'));
    if (p?.decisions?.length) section('Saved decisions', p.decisions.join('\n'));
    section('Next action', p?.nextAction || (live.state === 'in_review' ? 'Review the changes above, then integrate them or prepare a draft pull request.' : live.state === 'done' ? 'Review the recorded outcome and saved context.' : live.reason || 'Read the latest response or send a follow-up to this task.'));
    if (t.pr?.url) { const link = el('a', 'btn', `Open pull request #${t.pr.number}`); link.href = t.pr.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; pane.append(link); }
    pane.append(el('p', 'tx-empty', 'This view uses the task history and saved checkpoint on this device.'));
  }

  function renderSavedOutput(pane, task, latest) {
    const output = window.TaskOutputs?.fromTask(task);
    if (!window.TaskOutputs) return;
    const card = el('section', 'box'); card.id = 'saved-output'; card.setAttribute('aria-label', 'Saved report and references');
    card.append(el('h3', 'sect', 'Saved report and references'));
    if (output) {
      const stamp = output.at ? ` · ${new Date(output.at).toLocaleString()}` : '';
      card.append(el('p', 'tx-empty', `${output.source} · version ${output.version} · ${output.author}${stamp}`));
      card.append(el('pre', null, output.text || 'No report text saved yet.'));
      if (output.artifacts.length) {
        const refs = el('ul');
        for (const a of output.artifacts) {
          const item = el('li'); item.append(`${a.kind}: `);
          if (a.href) { const link = el('a', null, a.text); link.href = a.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); }
          else item.append(el('span', null, a.text));
          refs.append(item);
        }
        card.append(refs);
      }
      card.append(el('p', 'tx-empty', 'Saved on this device and restored with the task. A checkpoint version records the report; file references point to current files. Reports can be updated as work continues.'));
    } else card.append(el('p', 'tx-empty', 'Keep a report or note with this task so it is available when you return.'));
    const edit = (response) => {
      setTab('details');
      if (!d.checkpointDraft) $('checkpoint-edit')?.click();
      const field = $('checkpoint-progress');
      if (field && typeof response === 'string') { field.value = response; field.dispatchEvent(new Event('input', { bubbles: true })); }
      field?.focus();
    };
    const actions = el('div', 'd-actions'), editButton = btn(output ? 'Edit saved report' : 'Write a report or note', '', () => edit());
    editButton.disabled = !connected() || !api.saveCheckpoint; actions.append(editButton);
    if (latest?.text && !latest.open && latest.text !== output?.text && latest.text.length <= 4000) {
      const keep = btn('Keep this response', '', () => edit(latest.text));
      keep.disabled = !connected() || !api.saveCheckpoint || !!d.checkpointDraft;
      actions.append(keep);
    } else if (latest?.text?.length > 4000) card.append(el('p', 'tx-empty', 'The latest response is longer than a saved note. Edit the report to keep a summary and add the report file to its references.'));
    card.append(actions); pane.append(card);
  }

  // ───────────────────────── details tab ─────────────────────────
  function renderDetails() {
    const pane = $('pane-details');
    if (!pane || !d) return;
    // Keep typing/caret intact while live progress refreshes the open task.
    if (d.checkpointDraft && $('checkpoint-editor')) return;
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
    const permission = t.ai.id === 'codex'
      ? (t.permissionLevel === 'plan' ? 'Workspace read only' : 'Edits files and runs commands in the worktree; command network blocked')
      : ({ plan: 'Plan only', ask: 'Asks before risky things', 'auto-edits': 'Edits files freely', auto: 'Automatic', bypass: 'Bypass (no checks)' }[t.permissionLevel] || t.permissionLevel);
    fact('Permissions', `${permission}${t.planFirst ? ' · plan review required' : ''}`);
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
    if(t.pr?.url){const link=el('a','btn','Open pull request on GitHub');link.href=t.pr.url;link.target='_blank';link.rel='noopener noreferrer';pane.append(link);}
    pane.append(el('div', 'sect', 'What you asked'), el('pre', 'box', t.text));
    const p = t.checkpoint;
    pane.append(el('div', 'sect', p ? `Checkpoint · version ${p.version}` : 'Checkpoint'));
    if (p) {
      const facts = el('dl', 'facts');
      const pair = (k, v) => facts.append(el('dt', null, k), el('dd', null, v || '—'));
      pair('Brief', p.brief); pair('Decisions', p.decisions.join('\n')); pair('Progress (reported)', p.progress); pair('Next action', p.nextAction);
      pair('Artifacts', p.artifacts.map((a) => `${a.kind}: ${a.path || a.sha || a.url}`).join('\n'));
      pair('Checks (reported)', p.reportedChecks.join('\n'));
      pair('Observed tests', { pass: 'Passed', fail: 'Failed', none: 'None ran' }[p.observed.tests] || 'Not observed');
      pair('Saved by', { human: 'You', agent: 'An authorized agent', remote: 'An authorized participant', supervisor: 'Plexiform' }[p.author.kind]);
      pane.append(facts);
    } else pane.append(t.handover ? el('pre', 'box', t.handover.markdown) : el('p', 'tx-empty', 'A checkpoint keeps the brief, decisions and next action so work can resume later.'));
    pane.append(el('p', 'tx-empty', 'Saved on this device. Resuming uses the current task permissions and requires a new plan review for a fresh session when configured.'));
    if (!d.checkpointDraft) {
      const edit = btn(p ? 'Edit checkpoint' : 'Write checkpoint', '', () => {
        d.checkpointDraft = { expectedVersion: p?.version ?? t.handover?.version ?? 0,
          brief: p?.brief ?? t.text.slice(0, 4000), decisions: (p?.decisions ?? []).join('\n'), progress: p?.progress ?? '', nextAction: p?.nextAction ?? '',
          paths: (p?.artifacts ?? []).filter((a) => a.kind === 'path').map((a) => a.path).join('\n'), otherArtifacts: (p?.artifacts ?? []).filter((a) => a.kind !== 'path'), reportedChecks: (p?.reportedChecks ?? []).join('\n'), busy: false };
        renderDetails(); $('checkpoint-brief')?.focus();
      });
      edit.id = 'checkpoint-edit'; edit.disabled = !connected() || !api.saveCheckpoint; pane.append(edit);
    } else pane.append(checkpointEditor());
  }

  function checkpointEditor() {
    const state = d.checkpointDraft, taskId = d.id;
    const form = el('form'); form.id = 'checkpoint-editor'; form.addEventListener('submit', (e) => e.preventDefault());
    for (const [key, label, max] of [['brief', 'Brief', 4000], ['decisions', 'Decisions · one per line', 10000], ['progress', 'Current progress (reported)', 4000], ['nextAction', 'Next action', 2000], ['paths', 'Files to resume with · task-relative paths', 32768], ['reportedChecks', 'Checks reported · one per line', 10000]]) {
      const field = el('div', 'field'), l = el('label', null, label), ta = el('textarea'); ta.id = `checkpoint-${key}`; l.htmlFor = ta.id;
      ta.value = state[key]; ta.maxLength = max; ta.disabled = state.busy;
      ta.addEventListener('input', () => { state[key] = ta.value; }); field.append(l, ta); form.append(field);
    }
    const error = el('p', 'err', state.error || ''); error.id = 'checkpoint-error'; error.setAttribute('role', 'alert'); form.append(error);
    const lines = (s) => s.split('\n').map((v) => v.trim()).filter(Boolean);
    const save = btn('Save checkpoint', 'primary', async () => {
      if (state.busy) return;
      state.busy = true; for (const n of form.querySelectorAll('textarea,button')) n.disabled = true;
      const data = { brief: state.brief, decisions: lines(state.decisions), progress: state.progress, nextAction: state.nextAction,
        artifacts: [...lines(state.paths).map((p) => ({ kind: 'path', path: p })), ...state.otherArtifacts], reportedChecks: lines(state.reportedChecks) };
      let r; try { r = await api.saveCheckpoint({ id: taskId, expectedVersion: state.expectedVersion, data }); } catch { r = { ok: false, text: 'Could not save the checkpoint. Try again.' }; }
      if (!d || d.id !== taskId || d.checkpointDraft !== state) return;
      state.busy = false;
      if (r?.ok) { d.detail.checkpoint = r.checkpoint; d.checkpointDraft = null; renderDetails(); }
      else { state.error = r?.code === 'CONFLICT' ? 'The checkpoint changed while you edited it. Reload the current version before saving.' : r?.text || 'Could not save the checkpoint.'; error.textContent = state.error; for (const n of form.querySelectorAll('textarea,button')) n.disabled = false; }
    });
    save.id = 'checkpoint-save';
    const reload = btn('Reload current checkpoint', '', async () => {
      let r; try { r = await api.open(taskId); } catch { r = null; }
      if (d?.id !== taskId || d.checkpointDraft !== state) return;
      if (r?.ok) { d.detail = r.detail; d.messages = [...r.detail.messages]; for (const e of r.replay || []) applyEvent(e, true); d.checkpointDraft = null; renderDetails(); syncTranscript(); syncThread(); }
      else { state.error = r?.text || 'Could not reload the checkpoint.'; error.textContent = state.error; }
    });
    const cancel = btn('Cancel', '', () => { d.checkpointDraft = null; renderDetails(); });
    for (const b of [save, reload, cancel]) b.disabled = state.busy;
    form.append(save, reload, cancel);
    return form;
  }

  // ───────────────────────── live events ─────────────────────────
  function applyEvent(e, replay = false) {
    if (e.type === 'diff') { d.diff = e; if (!replay && d.tab === 'overview') renderOverview(); return; }
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
    comp = { folder: null, recent: [], ais: [], ai: 'auto', surface: 'background', perm: 'auto-edits', planFirst: false, when: 'now', repeat: 'off', repeatTime: '22:00', repeatDay: '1', repeatEvery: '4', budget: '', canSchedule: false, busy: false, error: '', preflight: null, checking: false, reviewedPeers: false, waiting: false };
    renderList();
    renderComposer();
    const info = await api.composer();
    if (view !== 'composer' || !comp) return;
    if (info) { comp.ais = info.ais; comp.recent = info.recent; comp.canSchedule = info.canSchedule === true; renderComposer(true); }
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
    const pick = btn(comp.folder ? 'Change folder…' : 'Choose folder…', '', async () => { const owner = comp, f = await api.pickFolder(); if (f && comp === owner && view === 'composer' && !owner.busy) { comp.folder = f; comp.error = ''; comp.held = false; void checkProjectWork(); } });
    pick.id = 'c-folder-btn';
    const chosen = el('span', null, comp.folder ? `  ${comp.folder.label}` : '  None chosen'); chosen.id = 'c-folder';
    where.append(pick, chosen);
    if (comp.recent.length) {
      const chips = el('div', 'chips');
      for (const r of comp.recent) { const c = el('button', 'chip', r.label); c.type = 'button'; c.setAttribute('aria-pressed', String(comp.folder?.handle === r.handle)); c.addEventListener('click', () => { comp.folder = r; comp.error = ''; comp.held = false; void checkProjectWork(); }); chips.append(c); }
      where.append(chips);
    }
    where.append(el('div', 'sub', 'Git repositories use a separate worktree for review. A folder without git is edited in place.'));

    const aiF = el('div', 'field');
    const aiL = el('label', null, 'Which AI?'); aiL.htmlFor = 'c-ai';
    const sel = el('select'); sel.id = 'c-ai';
    const add = (v, label, disabled) => { const o = el('option', null, label); o.value = v; o.disabled = !!disabled; sel.append(o); };
    add('auto', 'Choose for me');
    for (const a of comp.ais) { const o = TV.aiOption(a); add(o.value, o.label, o.disabled); }
    if (!comp.ais.some((a) => a.id === comp.ai && !TV.aiOption(a).disabled)) comp.ai = 'auto';
    sel.value = comp.ai;
    sel.addEventListener('change', () => { comp.ai = sel.value; renderComposer(true); });
    const provider = comp.ais.find((a) => a.id === comp.ai) || comp.ais.find((a) => a.installed && a.capabilities.background && a.tasks !== false);
    const codex = provider?.id === 'codex';
    aiF.append(aiL, sel, el('div', 'sub', TV.aiNote(comp.ai)));

    // A cap for this one task, only for an AI that stops itself at one (Claude). "Choose for me" keeps it: the pick then prefers such an AI.
    const canCap = comp.ai === 'auto' ? comp.ais.some((a) => a.installed && a.capabilities.budget) : !!provider?.capabilities.budget;
    const capF = el('div', 'field');
    if (canCap) {
      const capL = el('label', null, 'Max spend for this task (optional)'); capL.htmlFor = 'c-budget';
      const cap = el('input'); cap.id = 'c-budget'; cap.type = 'number'; cap.inputMode = 'decimal'; cap.min = String(TV.LIMITS.taskBudgetMin); cap.max = String(TV.LIMITS.taskBudgetMax); cap.step = '0.5'; cap.placeholder = 'e.g. 5'; cap.value = comp.budget;
      cap.addEventListener('input', () => { comp.budget = cap.value; comp.error = ''; $('c-err').textContent = ''; });
      capF.append(capL, cap, el('div', 'sub', `In dollars at API prices, $${TV.LIMITS.taskBudgetMin} to $${TV.LIMITS.taskBudgetMax}. The task stops at the cap and is marked "Stopped at cap"; you can retry it with a higher one.`));
    } else comp.budget = '';

    const surf = el('div', 'field radios');
    surf.append(el('span', 'lbl', 'Where does it run?'));
    for (const [v, label] of [['background', 'In the background: keeps going when you close this window']]) {
      const l = el('label'); const r = el('input'); r.type = 'radio'; r.name = 'c-surface'; r.value = v; r.checked = comp.surface === v;
      r.addEventListener('change', () => { comp.surface = v; });
      l.append(r, ` ${label}`); surf.append(l);
    }

    const permF = el('div', 'field');
    const permL = el('label', null, 'How much may it do without asking?'); permL.htmlFor = 'c-perm';
    const perm = el('select'); perm.id = 'c-perm';
    const levels = codex
      ? [['plan', 'Plan only: workspace files are read only'], ['auto-edits', 'Edit files and run commands in this worktree']]
      : [['plan', 'Plan only: it writes a plan and changes nothing'], ['ask', 'Ask me before anything risky'], ['auto-edits', 'Edit files freely, ask for the rest']];
    if (!levels.some(([v]) => v === comp.perm)) comp.perm = 'auto-edits';
    for (const [v, label] of levels) { const o = el('option', null, label); o.value = v; perm.append(o); }
    perm.value = comp.perm;
    perm.addEventListener('change', () => { comp.perm = perm.value; });
    const pf = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = comp.planFirst; cb.addEventListener('change', () => { comp.planFirst = cb.checked; });
    pf.append(cb, ' Show me its plan first and wait for my go-ahead');
    permF.append(permL, perm, el('div', 'sub', codex ? 'Network access is blocked for commands. Codex runs without interactive command approvals in this sandbox. Plan review only widens a task that already has edit permission; a plan-only task stays read only.' : ''), pf);

    const whenF = el('div', 'field');
    const whenL = el('label', null, 'When should it start?'); whenL.htmlFor = 'c-when';
    const when = el('select'); when.id = 'c-when';
    for (const [v, label, off] of [['now', 'Start now'], ['reset', 'When my usage limit resets'], ['tonight', comp.canSchedule ? 'Run tonight (10 pm to 7 am)' : 'Run tonight (not on your plan)', !comp.canSchedule]]) { const o = el('option', null, label); o.value = v; o.disabled = !!off; when.append(o); }
    when.value = comp.when;
    when.addEventListener('change', () => { comp.when = when.value; renderComposer(true); });
    // Repeat: the task is kept as a recipe of your own and runs again on a schedule (Plus, with the overnight queue).
    const repF = el('div', 'field');
    const repL = el('label', null, 'Repeat it?'); repL.htmlFor = 'c-repeat';
    const rep = el('select'); rep.id = 'c-repeat';
    for (const [v, label, off] of [['off', 'No, just this once'], ['nightly', comp.canSchedule ? 'Every night' : 'Every night (not on your plan)', !comp.canSchedule], ['weekdays', comp.canSchedule ? 'Every weekday' : 'Every weekday (not on your plan)', !comp.canSchedule], ['weekly', comp.canSchedule ? 'Every week on…' : 'Every week (not on your plan)', !comp.canSchedule], ['hours', comp.canSchedule ? 'Every few hours while this Mac is awake' : 'Every few hours (not on your plan)', !comp.canSchedule]]) { const o = el('option', null, label); o.value = v; o.disabled = !!off; rep.append(o); }
    rep.value = comp.repeat;
    rep.addEventListener('change', () => { comp.repeat = rep.value; renderComposer(true); });
    repF.append(repL, rep);
    if (comp.repeat !== 'off') {
      const row = el('div', 'repeat-form');
      if (comp.repeat === 'weekly') { const day = el('select'); day.id = 'c-repeat-day'; day.setAttribute('aria-label', 'Day'); ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].forEach((n, i) => { const o = el('option', null, n); o.value = String(i); day.append(o); }); day.value = comp.repeatDay; day.addEventListener('change', () => { comp.repeatDay = day.value; }); row.append(day); }
      if (comp.repeat === 'hours') { const ev = el('select'); ev.id = 'c-repeat-every'; ev.setAttribute('aria-label', 'Every'); for (const n of [1, 2, 3, 4, 6, 8, 12]) { const o = el('option', null, n === 1 ? 'every hour' : `every ${n} hours`); o.value = String(n); ev.append(o); } ev.value = comp.repeatEvery; ev.addEventListener('change', () => { comp.repeatEvery = ev.value; }); row.append(ev); }
      else { const time = el('input'); time.type = 'time'; time.id = 'c-repeat-time'; time.setAttribute('aria-label', 'Time'); time.value = comp.repeatTime; time.addEventListener('change', () => { comp.repeatTime = time.value; }); row.append(time); }
      repF.append(row, el('div', 'sub', 'It is kept in My recipes and each run starts in the background while this Mac is awake. A run that would pass your daily spend limit is skipped. You confirm once.'));
    }
    whenF.append(whenL, when, el('div', 'sub', comp.when === 'now' ? 'It schedules your own work for when your limit resets or overnight, under your own login on this Mac.' : comp.when === 'reset' ? 'It schedules your own work for when your limit resets. If you have not hit a limit it starts straight away.' : 'It schedules your own work for tonight and keeps this Mac awake (lid open) while the queue has work. It runs only while this Mac is awake.'));

    const foot = el('div', 'foot');
    const go = btn('Start task', 'primary'); go.type = 'submit'; go.id = 'c-go'; go.disabled = !connected() || comp.busy || comp.checking || comp.waiting;
    const cancel = btn('Cancel', '', closeComposer);
    const err = el('span', 'err', comp.error); err.id = 'c-err'; err.setAttribute('role', 'alert');
    foot.append(go, cancel, err);
    if (comp.held) {
      const override = btn('Start anyway…', '', () => submitComposer(true)); override.type = 'button'; override.id = 'c-override'; override.disabled = !connected() || comp.busy;
      foot.append(override);
    }
    root.append(words, where, projectWorkPanel(), aiF, capF, surf, permF, whenF, repF, foot);
    main.append(root);
    updateCount();
    if (comp.busy) for (const control of root.querySelectorAll('input,select,textarea,button')) control.disabled = true;
    if (!keepFocus || hadFocus || !text) ta.focus();
  }

  const peerKey = value => JSON.stringify(value?.peers ?? null);
  async function checkProjectWork() {
    const owner = comp, folder = owner?.folder?.handle;
    if (!folder || owner.busy || view !== 'composer') return;
    const inspection = owner.inspection = (owner.inspection || 0) + 1;
    owner.preflight = null; owner.reviewedPeers = false; owner.checking = true; owner.waiting = false;
    renderComposer(true);
    let result; try { result = await api.preflight?.({ folder }); } catch { result = null; }
    if (comp !== owner || view !== 'composer' || comp.folder?.handle !== folder || owner.inspection !== inspection) return;
    owner.checking = false;
    owner.preflight = result?.ok ? result.preflight : null;
    owner.preflightError = owner.preflight ? '' : result?.text || 'Could not check current project work. Recheck before starting.';
    renderComposer(true);
  }
  function projectWorkPanel() {
    const box = el('section', 'field'); box.id = 'c-project-work';
    if (!comp.folder) return box;
    box.append(el('h3', null, 'Other work in this project'));
    if (comp.checking) { box.append(el('p', null, 'Checking current local tasks…')); return box; }
    const check = comp.preflight;
    if (!check) box.append(el('p', 'err', comp.preflightError || 'Check the other local work before starting.'));
    else {
      box.append(el('p', 'sub', check.note));
      if (!check.peers.length) box.append(el('p', null, 'No competing local tasks were reported.'));
      for (const peer of check.peers) {
        const row = el('details', 'box');
        row.append(el('summary', null, `${peer.title} · ${peer.state}${peer.uncertain ? ' · activity unconfirmed' : ''}`));
        if (peer.branch) row.append(el('p', null, `Branch: ${peer.branch}`));
        row.append(el('pre', null, peer.paths.length ? peer.paths.join('\n') : 'No editing paths reported yet.'));
        box.append(row);
      }
      if (check.peers.length) {
        const label = el('label'), ack = el('input'); ack.type = 'checkbox'; ack.id = 'c-work-reviewed'; ack.checked = comp.reviewedPeers;
        ack.addEventListener('change', () => { comp.reviewedPeers = ack.checked; });
        label.append(ack, ' I have reviewed the tasks above and the scope of this task.'); box.append(label);
        box.append(btn('Narrow this task', '', () => { $('c-text').focus(); }), btn('Keep draft and wait', '', () => { comp.waiting = true; comp.reviewedPeers = false; renderComposer(true); }));
      }
      box.append(el('p', 'sub', 'This checks current local work only. Scheduled work and other devices may change. Review integration before combining changes.'));
    }
    if (comp.waiting) box.append(el('p', null, 'Draft kept. Nothing will start automatically. Recheck when you are ready.'));
    const recheck = btn('Recheck project work', '', () => void checkProjectWork()); recheck.disabled = comp.busy || !connected(); box.append(recheck);
    return box;
  }

  function updateCount() {
    const n = $('c-text').value.length;
    $('c-count').textContent = `${n.toLocaleString('en')} of ${TV.LIMITS.taskText.toLocaleString('en')}`;
  }

  async function submitComposer(overrideBudget = false) {
    if (!comp || comp.busy || comp.checking || comp.waiting || !connected()) return;
    const owner = comp;
    const text = $('c-text').value;
    const v = TV.validateDraft({ text, hasFolder: !!comp.folder, budget: comp.budget });
    if (!v.ok) { comp.error = v.error; $('c-err').textContent = v.error; return; }
    if (!comp.preflight || comp.preflight.peers.length && !comp.reviewedPeers) {
      comp.error = 'Check current project work and review its scope before starting.'; renderComposer(true); return;
    }
    comp.busy = true; $('c-go').disabled = true; $('c-err').textContent = '';
    const folder = comp.folder.handle, reviewed = peerKey(comp.preflight);
    for (const control of document.querySelectorAll('.composer input,.composer select,.composer textarea,.composer button')) control.disabled = true;
    let check; try { check = await api.preflight({ folder }); } catch { check = null; }
    if (comp !== owner || view !== 'composer') return;
    if (!check?.ok || folder !== comp.folder.handle || reviewed !== peerKey(check.preflight)) {
      comp.busy = false; comp.preflight = check?.ok ? check.preflight : null; comp.reviewedPeers = false;
      comp.error = check?.ok ? 'Project work changed. Review the updated tasks before starting.' : check?.text || 'Could not refresh project work. Your draft is kept.';
      renderComposer(true); return;
    }
    if (comp.repeat !== 'off') {
      const sched = comp.repeat === 'hours' ? { kind: 'hours', every: Number(comp.repeatEvery) } : comp.repeat === 'weekly' ? { kind: 'weekly', day: Number(comp.repeatDay), time: comp.repeatTime } : { kind: comp.repeat, time: comp.repeatTime };
      const k = await window.recipesApi.keepAndSchedule({ text, ai: comp.ai, permissionLevel: comp.perm }, sched, comp.folder.handle).catch(() => null);
      if (comp !== owner || view !== 'composer') return;
      comp.busy = false;
      if (k && k.cancelled) { renderComposer(true); return; }
      if (!k || !k.ok) { comp.error = k?.error || k?.text || TV.errorText('INTERNAL'); renderComposer(true); return; }
      closeComposer();
      document.dispatchEvent(new CustomEvent('recipes:scheduled', { detail: { id: k.recipeId } }));
      return;
    }
    const r = await api.create({ text, folder: comp.folder.handle, ai: comp.ai, surface: comp.surface, permissionLevel: comp.perm, planFirst: comp.planFirst, when: comp.when, budgetUsd: comp.budget === '' ? undefined : Number(comp.budget), overrideBudget: overrideBudget === true });
    if (comp !== owner || view !== 'composer') return;
    comp.busy = false;
    if (r && r.cancelled) { renderComposer(true); return; }
    comp.held = r?.code === 'BUDGET_HELD';
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
    document.dispatchEvent(new CustomEvent('tasks:snapshot', { detail: { galleryFirst: TV.galleryFirst(s) } }));
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
