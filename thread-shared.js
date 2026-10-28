// A teammate's shared session as a thread (T2), with send, steer, stop and propose on an interact share (T3).
// Builds everything from main's fixed projection (src/shared-thread-view.js) and main's review cards, with
// textContent only. It holds no ref or id; the only token it holds is main's opaque selection for the card on
// screen, and confirm sends back just that and the exact text.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 5000;
  const CHIP = { queued: 'Queued', accepted: 'Accepted', acknowledged: 'Received', echoed: 'Echoed', responding: 'Responding', replied: 'Done', completed: 'Done', interrupted: 'Interrupted', unconfirmed: 'Unconfirmed', failed: 'Failed', unknown: 'Unconfirmed' };
  const BANNER = 'You see messages sent since it was shared, and its current activity. Earlier history stays private.';
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const ago = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  const clock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

  const WATCH = 'Shared with you to watch only. The owner can choose Allow sending.';
  // L32: the owner can see who has their shared session open. Said from the first paint, before main sends anything
  // (main starts only after sharedPainted), and taken down when main says the hub isn't taking it (watching:'off').
  // After 'off' or a hide, a line shown again is confirmed again: main beats only after it (D-S2).
  const SEEN = (owner) => `${owner} can see you're watching.`;
  const PROPOSALS_MS = 10000, QUEUE_MS = 4000;
  const STATUS_CHIP = { awaiting: 'Awaiting', approved: 'Approved', expired: 'Expired', rejected: 'Rejected', sending: 'Sending', sent: 'Sent', refused: 'Refused', unconfirmed: 'Unconfirmed' };
  let painted = false;
  let api = null, rowId = '', timer = null, reading = false, view = null, stale = false, over = false, offline = '', signIn = false;
  // T3: the composer's own state. The draft lives in the textarea itself and survives every re-render.
  let sticky = '', windowEnds = 0, askEach = false, layout = '', chosen = null, cardOn = null, cardTimer = null, busy = false, proposalsAt = 0, proposalsReading = false, myProposals = [], myQueue = [], queueAt = 0, queueReading = false;

  function pieces() {
    let root = $('th-shared');
    if (root) return root;
    root = el('section', 'th-shared'); root.id = 'th-shared';
    root.append(el('p', 'th-activity'), el('ul', 'th-msgs'), el('p', 'th-shared-empty'), el('div', 'th-shared-foot'));
    $('th-tx').before(root);
    return root;
  }
  function hideChat() {
    for (const id of ['th-tx', 'th-waiting', 'th-cards', 'th-hooks', 'th-reply', 'th-stop', 'th-ended', 'th-empty', 'th-primary', 'th-tasks', 'th-terminal', 'th-copy']) { const n = $(id); if (n) n.hidden = true; }
    $('th-bucket').textContent = '';
    $('th-dot').hidden = true;
    $('th').classList.add('is-shared');
  }
  function menu() {
    let item = $('th-team');
    if (!item) {
      item = el('button', 'th-menu-item', 'Team overview'); item.type = 'button'; item.id = 'th-team'; item.setAttribute('role', 'menuitem');
      item.addEventListener('click', () => { $('th-menu').hidden = true; $('th-more').setAttribute('aria-expanded', 'false'); void api.openTeam(rowId); });
      $('th-menu').prepend(item);
    }
    item.hidden = false;
  }

  function render() {
    const root = pieces(), v = view;
    hideChat(); menu();
    $('th').setAttribute('aria-busy', 'false');
    if (!v) return;
    const h = v.header;
    document.title = h.title;
    $('th-title').textContent = h.title;
    $('th-meta').textContent = `${h.owner}'s ${h.provider} session · ${h.scope === 'interact' ? 'Watch and send' : 'Shared with you to watch'}${h.expiresAt ? ` · until ${clock(h.expiresAt)}` : ''}${h.fake ? ' (test data)' : ''}`;
    const banner = $('th-banner'); banner.hidden = false;
    const seen = v.watching !== 'off';
    if (!seen) painted = false;
    const watch = el('span', 'th-watch', SEEN(h.owner)); watch.id = 'th-watch'; watch.hidden = !seen;
    banner.replaceChildren(el('span', '', BANNER), ' ', watch);
    if (seen && !painted) {
      painted = true;
      // Once it is on screen: a hidden document never paints, so it never starts the beat.
      const go = () => { if (!over && typeof api.sharedPainted === 'function') void Promise.resolve(api.sharedPainted(rowId)).catch(() => {}); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(go)); else go();
    }
    const a = v.activity;
    root.querySelector('.th-activity').textContent = stale ? (offline ? `${offline}'s computer is offline. Showing the last known state.` : signIn ? 'Sign in again to refresh. Showing the last known state.' : 'Showing the last known state.') : a.category ? `${a.stale ? 'Last reported' : 'Now'}: ${a.category} · ${ago(a.ageMs)}` : 'No activity reported yet.';
    const list = root.querySelector('.th-msgs'), items = v.deliveries.map((d) => {
      const li = el('li', 'th-msg');
      li.append(el('p', 'th-msg-by', d.by ? `Sent by ${d.by}` : 'Sent through this share'), el('p', 'th-msg-text', d.text));
      const chip = el('span', 'th-chip', CHIP[d.state] || 'Unconfirmed'); chip.dataset.state = d.state;
      li.append(chip);
      if (d.state === 'unconfirmed' || d.state === 'unknown') li.append(el('p', 'th-msg-note', 'Receipt unconfirmed. The agent may still act; do not resend automatically.'));
      if (d.response) li.append(el('p', 'th-msg-reply', d.response));
      return li;
    });
    list.replaceChildren(...items);
    root.querySelector('.th-shared-empty').textContent = items.length ? '' : 'No messages have been sent through this share yet.';
    renderFoot(root.querySelector('.th-shared-foot'), v);
  }

  // ── T3: the interact layout ──
  const OPTIONS = (owner) => [
    { op: 'send', label: 'Send', sub: '' },
    { op: 'steer', label: 'Steer this turn', sub: '' },
    { op: 'queue', label: 'Queue for when idle', sub: 'Sent once, when the session is idle.' },
    { op: 'propose', label: `Propose to ${owner}`, sub: `${owner} reviews this exact text before it runs.` },
  ];
  const capOf = (v, op) => (op === 'steer' ? v.controls.steer : op === 'propose' ? v.controls.propose : op === 'queue' ? v.controls.queue : v.controls.send);
  // Only these can skip the card inside T3b's window; a queued message and a proposal always get one.
  const WINDOW_OPS = ['send', 'steer', 'stop'];
  // Send when idle, otherwise Steer where it's available, otherwise nothing (plan-t3 M2).
  const defaultOp = (v) => (v.controls.send.available ? 'send' : v.controls.steer.available ? 'steer' : null);
  function clearDraft() { const t = $('th-sh-text'); if (t) t.value = ''; }
  function note(text, tone) { const n = $('th-sh-note'); if (!n) return; n.textContent = text || ''; if (tone) n.dataset.tone = tone; else delete n.dataset.tone; }
  function renderFoot(foot, v) {
    const h = v.header;
    if (h.scope !== 'interact' || !v.controls) {
      // The box itself goes, so no private text stays in a box that can no longer send.
      if (layout === 'interact') { closeCard(); myProposals = []; myQueue = []; }
      if (layout !== 'watch') { layout = 'watch'; foot.replaceChildren(el('p', 'th-shared-note', WATCH)); }
      return;
    }
    if (layout !== 'interact') { layout = 'interact'; foot.replaceChildren(buildComposer(h)); }
    const owner = h.owner;
    const opt = chosen && capOf(v, chosen).available ? chosen : defaultOp(v);
    chosen = opt;
    const t = $('th-sh-text'), go = $('th-sh-go'), chip = $('th-sh-chip');
    const label = OPTIONS(owner).find((o) => o.op === opt)?.label;
    chip.textContent = label ? `${label} ▾` : 'Send ▾';
    // Queue can be the way in even when Send and Steer are not (a working session that can't be steered).
    chip.disabled = !OPTIONS(owner).some((o) => capOf(v, o.op).available) || busy;
    t.disabled = !opt || busy;
    t.placeholder = `Message ${owner}'s session`;
    // T3b: after one accepted card, send/steer/stop go straight through until main says the window ends.
    const direct = winOn() && WINDOW_OPS.includes(opt);
    go.textContent = direct ? (opt === 'steer' ? 'Steer' : 'Send') : 'Review';
    go.disabled = !opt || busy || !!cardOn;
    const wl = $('th-sh-window');
    wl.hidden = !winOn();
    wl.textContent = winOn() ? `Messages to ${owner}'s session send straight away for 30 minutes.` : '';
    $('th-sh-ask').checked = askEach;
    if (!opt) note(v.controls.send.reason);
    else if ($('th-sh-note').dataset.tone !== 'error' && !busy) note(sticky || (opt === 'propose' ? `${owner} reviews this exact text before it runs.` : opt === 'queue' ? `Sent once, when ${owner}'s session is idle.` : ''));
    $('th-sh-quota').textContent = `Runs on ${owner}'s ${h.provider} account and quota.`;
    const items = $('th-sh-menu');
    items.replaceChildren(...OPTIONS(owner).map((o) => {
      const cap = capOf(v, o.op), b = el('button', 'th-menu-item'); b.type = 'button'; b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(o.op === opt)); b.dataset.op = o.op;
      b.append(document.createTextNode(o.label));
      const sub = cap.available ? o.sub : cap.reason;
      if (sub) b.append(el('span', 'th-menu-sub', sub));
      if (!cap.available) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
      b.addEventListener('click', () => { if (!capOf(view, o.op).available) return; chosen = o.op; items.hidden = true; chip.setAttribute('aria-expanded', 'false'); note(''); renderFoot(foot, view); t.focus(); });
      return b;
    }));
    const stop = $('th-sh-stop');
    stop.hidden = !v.controls.interrupt.available;
    stop.disabled = busy || !!cardOn;
    renderProposals(v);
    renderQueue(v);
  }
  function buildComposer(h) {
    const wrap = el('div', 'th-sh');
    const form = el('form', 'th-reply th-sh-box'); form.id = 'th-sh-form'; form.setAttribute('aria-label', `Message ${h.owner}'s session`);
    const lab = el('label', 'th-sr', `Message ${h.owner}'s session`); lab.htmlFor = 'th-sh-text';
    const t = el('textarea', 'th-reply-text'); t.id = 'th-sh-text'; t.rows = 2; t.maxLength = 4000; t.setAttribute('aria-describedby', 'th-sh-note');
    const row = el('div', 'th-reply-row');
    const chipWrap = el('div', 'th-more-wrap th-sh-chip-wrap');
    const chip = el('button', 'th-btn th-sh-chip'); chip.type = 'button'; chip.id = 'th-sh-chip'; chip.setAttribute('aria-haspopup', 'menu'); chip.setAttribute('aria-expanded', 'false'); chip.setAttribute('aria-controls', 'th-sh-menu');
    const menu = el('div', 'th-menu th-sh-menu'); menu.id = 'th-sh-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
    chip.addEventListener('click', () => { menu.hidden = !menu.hidden; chip.setAttribute('aria-expanded', String(!menu.hidden)); });
    chipWrap.append(chip, menu);
    const n = el('p', 'th-reply-note'); n.id = 'th-sh-note'; n.setAttribute('aria-live', 'polite');
    const go = el('button', 'th-btn th-primary', 'Review'); go.type = 'submit'; go.id = 'th-sh-go';
    row.append(chipWrap, n, go);
    form.append(lab, t, row);
    form.addEventListener('submit', (ev) => { ev.preventDefault(); if (chosen) void startReview(chosen, t.value); });
    t.addEventListener('input', () => { sticky = ''; });
    t.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.metaKey) { ev.preventDefault(); form.requestSubmit(); } });
    const win = el('p', 'th-sh-window'); win.id = 'th-sh-window'; win.hidden = true; win.setAttribute('aria-live', 'polite');
    const askRow = el('label', 'th-sh-ask-row'); const ask = el('input'); ask.type = 'checkbox'; ask.id = 'th-sh-ask'; askRow.append(ask, document.createTextNode(' Ask me each time'));
    ask.addEventListener('change', async () => {
      const on = ask.checked; let r = null;
      try { r = await api.sharedAskEach(rowId, on); } catch { r = null; }
      if (over) return;
      if (r && r.ok === true) { askEach = r.askEach === true; windowEnds = Number(r.window) || 0; } else ask.checked = askEach;
      if (view) renderFoot(pieces().querySelector('.th-shared-foot'), view);
    });
    const quota = el('p', 'th-sh-quota'); quota.id = 'th-sh-quota';
    const stop = el('button', 'th-btn th-sh-stop', 'Stop turn'); stop.type = 'button'; stop.id = 'th-sh-stop'; stop.hidden = true;
    stop.addEventListener('click', () => { void startReview('stop', ''); });
    const cardHost = el('div', 'th-sh-card-host'); cardHost.id = 'th-sh-card';
    const props = el('ul', 'th-msgs th-sh-proposals'); props.id = 'th-sh-proposals'; props.setAttribute('aria-label', 'Your proposals');
    const queue = el('div', 'th-sh-queue'); queue.id = 'th-sh-queue'; queue.hidden = true;
    const qList = el('ul', 'th-msgs th-sh-queue-list'); qList.id = 'th-sh-queue-list'; qList.setAttribute('aria-label', 'Queued messages');
    queue.append(el('p', 'th-sh-queue-head', 'Queued'), qList);
    wrap.append(queue, props, cardHost, form, win, askRow, quota, stop);
    return wrap;
  }
  async function startReview(op, text) {
    if (busy || cardOn) return;
    busy = true; sticky = ''; note(''); if (view) renderFoot(pieces().querySelector('.th-shared-foot'), view);
    let r = null;
    const seen = winOn() && WINDOW_OPS.includes(op) && view ? { generation: view.generation, turn: view.turn ?? null } : null;
    try { r = await api.sharedReview(rowId, op, text, seen); } catch { r = null; }
    if (r) windowEnds = Number(r.window) || 0;
    if (r && r.ok === true && r.status === 'direct' && typeof r.selection === 'string') {
      // No card: main said this one goes straight through. The same confirm, the same exact text.
      let d = null;
      try { d = await api.sharedConfirm(rowId, r.selection, text); } catch { d = null; }
      busy = false;
      if (d) windowEnds = Number(d.window) || 0;
      if (over) return;
      finished(op, d, true);
      return;
    }
    busy = false;
    if (over) return;
    if (r && r.ok === true && r.card && typeof r.selection === 'string') showCard(r.card, r.selection, op === 'stop' ? '' : text);
    else { note(failure(r), 'error'); if (r && r.status === 'forbidden') { void read(); } }
    if (view) renderFoot(pieces().querySelector('.th-shared-foot'), view);
  }
  const failure = (r) => (r && typeof r.error === 'string' && r.error ? r.error : 'This action is unavailable right now.');
  function arm(btn, ms) {
    btn.disabled = true;
    if (cardTimer) clearTimeout(cardTimer);
    cardTimer = setTimeout(() => { btn.disabled = false; cardTimer = null; }, Math.max(ms || 600, 600));
  }
  function showCard(c, selection, text) {
    const host = $('th-sh-card'); if (!host) return;
    cardOn = { selection, text, op: c.op, armMs: c.armMs };
    const card = el('section', 'th-card th-review th-sh-review'); card.setAttribute('role', 'group'); card.setAttribute('aria-labelledby', 'th-sh-card-title');
    const title = el('h2', 'th-card-title', c.title); title.id = 'th-sh-card-title';
    card.append(title);
    if (c.text) card.append(el('p', 'th-card-text', c.text));
    card.append(el('p', 'th-card-sub', c.target));
    for (const n of Array.isArray(c.notes) ? c.notes : []) card.append(el('p', 'th-card-sub', n));
    const btns = el('div', 'th-card-btns');
    const yes = el('button', c.op === 'stop' || c.op === 'withdraw' ? 'th-btn th-danger' : 'th-btn th-primary', c.confirm); yes.type = 'button'; yes.id = 'th-sh-yes';
    const back = el('button', 'th-btn', c.op === 'stop' || c.op === 'send-approved' || c.op === 'withdraw' ? 'Cancel' : 'Back to draft'); back.type = 'button';
    yes.addEventListener('click', () => { void confirmCard(); });
    back.addEventListener('click', () => { closeCard(); if (view) renderFoot(pieces().querySelector('.th-shared-foot'), view); $('th-sh-text')?.focus(); });
    btns.append(yes, back);
    card.append(btns);
    host.replaceChildren(card);
    arm(yes, c.armMs);
    yes.focus();
  }
  function closeCard() { cardOn = null; if (cardTimer) { clearTimeout(cardTimer); cardTimer = null; } const host = $('th-sh-card'); if (host) host.replaceChildren(); }
  async function confirmCard() {
    if (!cardOn || busy) return;
    const { selection, text, op } = cardOn;
    busy = true; const yes = $('th-sh-yes'); if (yes) yes.disabled = true;
    let r = null;
    try { r = await api.sharedConfirm(rowId, selection, text); } catch { r = null; }
    busy = false;
    if (over) return;
    if (r && r.status === 'not-ready') { if (yes) arm(yes, 600); return; }
    closeCard();
    if (r) windowEnds = Number(r.window) || 0;
    finished(op, r, false);
  }
  const winOn = () => !askEach && windowEnds > Date.now();
  function finished(op, r, direct) {
    if (r && r.ok === true) {
      if (op === 'send' || op === 'steer' || op === 'propose' || op === 'queue') clearDraft();
      const to = view?.header?.owner ? `Sent to ${view.header.owner}.` : 'Sent.';
      sticky = op === 'queue' ? `Queued. It sends once ${view?.header?.owner ? `${view.header.owner}'s` : 'the'} session is idle.` : op === 'propose' ? 'Proposal sent. It waits for the owner to review it.' : op === 'stop' ? 'Stop requested.' : op === 'withdraw' ? 'Proposal withdrawn.' : r.note || (direct ? to : 'Sent. Its receipt appears with the messages.');
      note(sticky);
      proposalsAt = 0; queueAt = 0;
    } else note(failure(r), 'error');
    if (view) renderFoot(pieces().querySelector('.th-shared-foot'), view);
    void read();
  }
  function renderProposals(v) {
    const list = $('th-sh-proposals'); if (!list) return;
    const owner = v.header.owner, idle = v.controls.send.available;
    list.replaceChildren(...myProposals.map((p) => {
      const li = el('li', 'th-msg th-sh-proposal');
      li.append(el('p', 'th-msg-by', p.title || 'Your proposal'), el('p', 'th-msg-text', p.text));
      const word = p.status === 'awaiting' ? `Awaiting ${owner}` : p.status === 'approved' ? `Approved, one send${p.expiresAt ? ` until ${clock(p.expiresAt)}` : ''}` : STATUS_CHIP[p.status] || 'Unconfirmed';
      const chip = el('span', 'th-chip', word); chip.dataset.state = p.status; li.append(chip);
      if (p.action && p.status === 'approved') {
        const b = el('button', 'th-btn th-primary', 'Send approved message'); b.type = 'button';
        b.disabled = !idle || !!cardOn || busy;
        if (!idle) li.append(el('p', 'th-msg-note', `Waiting for ${owner}'s session to be idle.`));
        b.addEventListener('click', () => { if (!cardOn) showCard(p.action.card, p.action.selection, ''); });
        li.append(b);
      } else if (p.action && p.status === 'awaiting') {
        const b = el('button', 'th-btn', 'Withdraw'); b.type = 'button'; b.disabled = !!cardOn || busy;
        b.addEventListener('click', () => { if (!cardOn) showCard(p.action.card, p.action.selection, ''); });
        li.append(b);
      }
      return li;
    }));
  }
  const QUEUE_WORD = { queued: 'Queued', sending: 'Sending…', received: 'Received', unconfirmed: 'Unconfirmed', 'not-sent': 'Not sent' };
  function renderQueue(v) {
    const host = $('th-sh-queue'), list = $('th-sh-queue-list'); if (!host || !list) return;
    host.hidden = myQueue.length === 0;
    list.replaceChildren(...myQueue.map((q) => {
      const li = el('li', 'th-msg th-sh-queued'); li.dataset.state = q.state;
      li.append(el('p', 'th-msg-text', q.text));
      const chip = el('span', 'th-chip', QUEUE_WORD[q.state] || 'Unconfirmed'); chip.dataset.state = q.state; li.append(chip);
      if (q.state === 'queued') {
        const days = q.expiresAt ? Math.max(0, Math.ceil((q.expiresAt - Date.now()) / 86400000)) : null;
        li.append(el('p', 'th-msg-note', `Waiting for ${v.header.owner}'s session to be idle.${days === null ? '' : ` Expires in ${days}d.`}`));
      } else if (q.reason && (q.state === 'not-sent' || q.state === 'unconfirmed')) li.append(el('p', 'th-msg-note', q.reason));
      if (q.state !== 'sending') {
        const op = q.state === 'queued' ? 'cancel' : 'discard';
        const b = el('button', 'th-btn', op === 'cancel' ? 'Cancel' : 'Discard'); b.type = 'button'; b.disabled = busy;
        b.addEventListener('click', async () => {
          b.disabled = true; let r = null;
          try { r = await api.sharedQueueRemove(rowId, q.key, op); } catch { r = null; }
          if (over) return;
          if (!r || r.ok !== true) note(failure(r), 'error');
          queueAt = 0; void readQueue();
        });
        li.append(b);
      }
      return li;
    }));
  }
  async function readQueue() {
    if (over || queueReading || layout !== 'interact' || Date.now() - queueAt < QUEUE_MS) return;
    queueReading = true; queueAt = Date.now();
    let r = null;
    try { r = await api.sharedQueue(rowId); } catch { r = null; }
    queueReading = false;
    if (over || layout !== 'interact') return;
    if (r && r.ok === true && Array.isArray(r.items)) { myQueue = r.items; if (view) renderQueue(view); }
  }
  async function readProposals() {
    if (over || proposalsReading || layout !== 'interact' || Date.now() - proposalsAt < PROPOSALS_MS || cardOn) return;
    proposalsReading = true; proposalsAt = Date.now();
    let r = null;
    try { r = await api.sharedProposals(rowId); } catch { r = null; }
    proposalsReading = false;
    if (over || layout !== 'interact' || cardOn) return;
    if (r && r.ok === true && Array.isArray(r.proposals)) { myProposals = r.proposals; if (view) renderProposals(view); }
  }

  function gone(reason) {
    over = true; stop(); view = null;
    hideChat();
    $('th-more').hidden = true;
    const root = pieces();
    root.querySelector('.th-activity').textContent = ''; root.querySelector('.th-msgs').replaceChildren(); root.querySelector('.th-shared-foot').replaceChildren();
    root.querySelector('.th-shared-empty').textContent = '';
    $('th-banner').hidden = true;
    clearDraft(); closeCard(); myProposals = []; myQueue = []; layout = '';
    const text = reason === 'ended' ? 'This session has ended.' : 'This session is no longer shared with you.';
    $('th-title').textContent = text; $('th-meta').textContent = '';
    const e = $('th-empty'); e.hidden = false; $('th-empty-title').textContent = text; $('th-empty-text').textContent = 'Nothing from it is kept here.';
    $('th-board').hidden = false;
    $('th').setAttribute('aria-busy', 'false');
  }

  async function read() {
    if (over || reading || document.hidden) return;
    reading = true;
    let r = null;
    try { r = await api.sharedState(rowId); } catch { r = null; }
    reading = false;
    if (over || !r || typeof r !== 'object') return;
    if (r.gone === true) { gone(r.reason); return; }
    if (r.unavailable === true) {
      stale = true; offline = r.offline === true && typeof r.owner === 'string' ? r.owner : ''; signIn = r.signIn === true;
      if (view) render();
      else if (signIn) { const n = pieces().querySelector('.th-activity'); if (n) n.textContent = 'Sign in again to see this session.'; }
      else if (offline) { const n = pieces().querySelector('.th-activity'); if (n) n.textContent = `${offline}'s computer is offline. This will update when they are back.`; }
      return;
    }
    stale = false; offline = ''; signIn = false; view = r; windowEnds = Number(r.window) || 0; askEach = r.askEach === true; render();
    void readProposals(); void readQueue();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  function start(threadApi, id) {
    api = threadApi; rowId = id; over = false; view = null; stale = false; offline = ''; signIn = false; painted = false;
    windowEnds = 0; askEach = false; layout = ''; chosen = null; cardOn = null; busy = false; proposalsAt = 0; myProposals = []; myQueue = []; queueAt = 0; queueReading = false;
    hideChat(); pieces(); menu();
    stop(); timer = setInterval(read, POLL_MS);
    // Coming back into view re-arms an open card (as R4 does), then refreshes.
    document.addEventListener('visibilitychange', () => { if (document.hidden) painted = false; if (!document.hidden) { const yes = $('th-sh-yes'); if (cardOn && yes) arm(yes, cardOn.armMs); void read(); } });
    window.addEventListener('pagehide', stop);
    void read();
  }
  window.ThreadShared = Object.freeze({ start, BANNER, WATCH, SEEN });
})();
