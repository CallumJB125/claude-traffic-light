// Owner controls in my own thread (T4, plan-t4 §3): the live share under the title, ⋯ → Share with team…, and a
// teammate's proposal as a card. Built from main's thread:owner-state with textContent only. It holds no share,
// team or proposal id: only main's opaque keys, and the selection for the review card on screen.
// Share, Allow sending and Approve go through main's review card (armed 600 ms in main); Stop sharing, Reject and
// Revoke only narrow access and take one click, as in Overview.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 5000;
  const SCOPE = { watch: 'Watch only', interact: 'Watch and send' };
  // Overview's choices (overview-share.js EXPIRY); main checks the same list.
  const EXPIRY = [['3600', 'For 1 hour'], ['28800', 'For 8 hours'], ['86400', 'For 1 day'], ['604800', 'For 7 days'], ['', 'Until you stop it']];
  const STATUS = { sending: 'Sending', sent: 'Sent', expired: 'Expired', rejected: 'Rejected', refused: 'Refused', unconfirmed: 'Unconfirmed' };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const button = (cls, text, fn) => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; };
  const clock = (ms) => { const d = new Date(ms); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  const until = (ms) => (ms === null ? 'until you stop it' : `until ${clock(ms)}`);
  let api = null, rowId = '', timer = null, reading = false, view = null, over = false, busy = false;
  let sheet = false, cardOn = null, cardTimer = null, noteText = '', noteKind = '';

  function parts() {
    let line = $('th-owner-line');
    if (!line) { line = el('div', 'th-own-line'); line.id = 'th-owner-line'; $('th-meta').after(line); }
    let root = $('th-owner');
    if (!root) {
      root = el('section', 'th-own'); root.id = 'th-owner'; root.setAttribute('aria-label', 'Sharing');
      const n = el('p', 'th-own-note'); n.id = 'th-own-note'; n.setAttribute('role', 'status'); n.setAttribute('aria-live', 'polite');
      const host = el('div', 'th-own-card-host'); host.id = 'th-own-card';
      const sh = el('div', 'th-own-sheet-host'); sh.id = 'th-own-sheet';
      const props = el('div', 'th-own-proposals'); props.id = 'th-own-proposals'; props.setAttribute('role', 'group'); props.setAttribute('aria-label', 'Proposals from your team');
      root.append(n, sh, host, props);
      $('th-status').after(root);
    }
    let item = $('th-share');
    if (!item) {
      item = el('button', 'th-menu-item', 'Share with team…'); item.type = 'button'; item.id = 'th-share'; item.setAttribute('role', 'menuitem'); item.hidden = true;
      item.addEventListener('click', () => { $('th-menu').hidden = true; $('th-more').setAttribute('aria-expanded', 'false'); openSheet(); });
      $('th-menu').prepend(item);
    }
    return { line, root, item };
  }
  function note(text, kind = '') { noteText = text || ''; noteKind = kind; const n = $('th-own-note'); if (n) { n.textContent = noteText; n.dataset.kind = noteKind; } }

  function render() {
    const { line, item } = parts(), v = view;
    const on = !!v && v.shareable === true;
    item.hidden = !on;
    // My own thread's ⋯: shown when it has Share with team… (an owned row's ⋯ has nothing else).
    if (on) $('th-more').hidden = false;
    else if ($('th').classList.contains('is-owned')) $('th-more').hidden = true;
    const rows = [];
    if (v && v.shareable === false && v.reason) rows.push(el('p', 'th-own-share', v.reason));
    const shares = on && Array.isArray(v.shares) ? v.shares : [];
    for (const s of shares.slice(0, 3)) {
      const row = el('div', 'th-own-share');
      const scope = SCOPE[s.scope] || SCOPE.watch;
      const text = s.automatic ? `Shared automatically with ${s.team} (team workspace) · ${scope}` : `Shared with ${s.team} · ${scope} · ${until(s.expiresAt)} · ${s.members} ${s.members === 1 ? 'member' : 'members'}`;
      row.append(el('span', 'th-own-share-text', text));
      if (s.scope === 'watch') { const b = button('th-btn th-own-btn', 'Allow sending', () => { void review({ op: 'allow-sending', share: s.key }); }); b.disabled = busy; row.append(b); }
      const stop = button('th-btn th-own-btn', 'Stop sharing', () => { void act('stop', s.key); }); stop.disabled = busy; row.append(stop);
      rows.push(row);
    }
    if (shares.length > 3) rows.push(el('p', 'th-own-share', `+${shares.length - 3} more`));
    line.replaceChildren(...rows);
    line.hidden = !rows.length;
    renderProposals();
    renderSheet();
    note(noteText, noteKind);
  }

  // Rev 4: one card per teammate per session. Main groups them; the page keeps only main's keys.
  function renderProposals() {
    const host = $('th-own-proposals'), v = view;
    const on = v && v.shareable === true;
    const groups = on && Array.isArray(v.groups) ? v.groups : [], others = on && Array.isArray(v.others) ? v.others : [];
    const cards = groups.map((g) => {
      const p = g.latest;
      const c = el('section', 'th-card th-own-proposal'); c.setAttribute('role', 'group');
      c.append(el('h2', 'th-card-title', `${g.requester} proposes a message`), el('p', 'th-card-text', p.text), el('p', 'th-card-sub', `Decision version ${p.version}`));
      const btns = el('div', 'th-card-btns');
      const yes = button('th-btn th-primary', 'Approve one send · 10 min', () => { void review({ op: 'approve', proposal: p.key }); }); yes.disabled = busy || !!cardOn;
      const no = button('th-btn th-danger-outline', 'Reject', () => { void act('reject', p.key); }); no.disabled = busy;
      btns.append(yes, no);
      c.append(btns);
      const earlier = Array.isArray(g.earlier) ? g.earlier : [];
      // C-S1: main's Reject all snapshot holds every pending one from this teammate, the carded one included, so the
      // button says so and sits with Reject, not inside the fold of earlier ones.
      if (earlier.length && g.rejectAll) { const all = button('th-btn th-own-btn', `Reject all ${earlier.length + (g.more || 0) + 1} from ${g.requester}`, () => { void act('reject-all', g.rejectAll); }); all.disabled = busy; btns.append(all); }
      if (earlier.length) {
        const n = earlier.length + (g.more || 0);
        const more = el('details', 'th-own-earlier');
        more.append(el('summary', '', `${n} earlier from ${g.requester}`));
        const list = el('ul', 'th-own-earlier-list');
        for (const x of earlier) list.append(el('li', 'th-card-sub', x.text));
        if (g.more) list.append(el('li', 'th-card-sub', `+${g.more} more`));
        more.append(list);
        c.append(more);
      }
      return c;
    });
    for (const p of others) {
      if (p.status === 'approved') {
        const c = el('div', 'th-own-done');
        c.append(el('span', 'th-card-sub', `${p.requester}: approved for one send${p.expiresAt ? ` until ${clock(p.expiresAt)}` : ''}`));
        const rv = button('th-btn th-own-btn', 'Revoke', () => { void act('revoke', p.key); }); rv.disabled = busy;
        c.append(rv);
        cards.push(c);
      } else cards.push(el('p', 'th-card-sub th-own-done', `${p.requester}: ${STATUS[p.status] || 'Unconfirmed'}`));
    }
    host.replaceChildren(...cards);
  }

  // ── Share with team… ──
  function openSheet() { if (cardOn) return; sheet = true; note(''); renderSheet(); const f = $('th-own-team') || $('th-own-cancel'); if (f) f.focus(); }
  function renderSheet() {
    const host = $('th-own-sheet');
    if (!host) return;
    if (!sheet || !view || view.shareable !== true) { host.replaceChildren(); return; }
    if (host.firstChild) return; // keep the person's choices across re-reads
    const box = el('section', 'th-card th-review th-own-sheet'); box.setAttribute('role', 'group'); box.setAttribute('aria-labelledby', 'th-own-sheet-title');
    const title = el('h2', 'th-card-title', 'Share with team'); title.id = 'th-own-sheet-title';
    box.append(title);
    const cancel = button('th-btn', 'Cancel', () => { sheet = false; renderSheet(); }); cancel.id = 'th-own-cancel';
    if (view.available !== true || !view.teams.length) {
      box.append(el('p', 'th-card-sub', view.reason || 'Sharing is unavailable right now.'));
      const btns = el('div', 'th-card-btns'); btns.append(cancel); box.append(btns);
      host.replaceChildren(box); return;
    }
    const pick = (label, id, options) => {
      const wrap = el('label', 'th-card-sub', label), s = document.createElement('select'); s.id = id;
      for (const [value, text] of options) { const o = el('option', '', text); o.value = value; s.append(o); }
      wrap.append(s); return [wrap, s];
    };
    const [tl, team] = pick('Team', 'th-own-team', view.teams.map((t) => [t.key, t.name]));
    // Watch only first, and selected (T0).
    const [sl, scope] = pick('They can', 'th-own-scope', [['watch', SCOPE.watch], ['interact', SCOPE.interact]]);
    const [el2, exp] = pick('For how long', 'th-own-expiry', EXPIRY);
    scope.value = 'watch';
    const go = button('th-btn th-primary', 'Continue', () => { void review({ op: 'share', team: team.value, scope: scope.value, expiry: exp.value }); }); go.id = 'th-own-continue';
    const btns = el('div', 'th-card-btns'); btns.append(go, cancel);
    box.append(tl, sl, el2, el('p', 'th-card-sub', 'Members see this session from the moment you share it, not earlier messages.'), btns);
    host.replaceChildren(box);
  }

  // ── review card ──
  async function review(req) {
    if (busy || cardOn) return;
    busy = true; note(''); render();
    let r = null;
    try { r = await api.ownerReview(rowId, req); } catch { r = null; }
    busy = false;
    if (over) return;
    if (r && r.ok === true && r.card && typeof r.selection === 'string') { sheet = false; renderSheet(); showCard(r.card, r.selection); }
    else note(failure(r), 'error');
    render();
  }
  const failure = (r) => (r && typeof r.error === 'string' && r.error ? r.error : 'This action is unavailable right now.');
  function showCard(c, selection) {
    const host = $('th-own-card'); if (!host) return;
    cardOn = { selection, op: c.op };
    const card = el('section', 'th-card th-review th-own-review'); card.setAttribute('role', 'group'); card.setAttribute('aria-labelledby', 'th-own-card-title');
    const title = el('h2', 'th-card-title', c.title); title.id = 'th-own-card-title';
    card.append(title);
    if (c.text) card.append(el('p', 'th-card-text', c.text));
    if (c.scope) card.append(el('p', 'th-card-sub', c.scope));
    for (const n of Array.isArray(c.notes) ? c.notes : []) card.append(el('p', 'th-card-sub', n));
    if (Object.hasOwn(c, 'keeps')) card.append(el('p', 'th-card-sub', `Keeps the time left: ${until(c.keeps)}`));
    const btns = el('div', 'th-card-btns');
    const yes = el('button', 'th-btn th-primary', c.confirm); yes.type = 'button'; yes.id = 'th-own-yes';
    const back = button('th-btn', 'Cancel', () => { closeCard(); render(); });
    yes.addEventListener('click', () => { void confirmCard(); });
    btns.append(yes, back);
    card.append(btns);
    host.replaceChildren(card);
    arm(yes, c.armMs);
    yes.focus();
  }
  function arm(btn, ms) {
    btn.disabled = true;
    if (cardTimer) clearTimeout(cardTimer);
    cardTimer = setTimeout(() => { btn.disabled = false; cardTimer = null; }, Math.max(ms || 600, 600));
  }
  function closeCard() { cardOn = null; if (cardTimer) { clearTimeout(cardTimer); cardTimer = null; } const host = $('th-own-card'); if (host) host.replaceChildren(); }
  async function confirmCard() {
    if (!cardOn || busy) return;
    const { selection } = cardOn;
    busy = true; const yes = $('th-own-yes'); if (yes) yes.disabled = true;
    let r = null;
    try { r = await api.ownerConfirm(rowId, selection); } catch { r = null; }
    busy = false;
    if (over) return;
    if (r && r.status === 'not-ready') { if (yes) arm(yes, 600); return; }
    closeCard();
    note(r && r.ok === true ? r.note || 'Done.' : failure(r), r && r.ok === true ? '' : 'error');
    void read(true);
  }

  // ── one click: stop, reject, revoke ──
  async function act(op, key) {
    if (busy) return;
    busy = true; note(''); render();
    let r = null;
    try { r = await api.ownerAct(rowId, op, key); } catch { r = null; }
    busy = false;
    if (over) return;
    note(r && r.ok === true ? r.note || 'Done.' : failure(r), r && r.ok === true ? '' : 'error');
    void read(true);
  }

  async function read() {
    if (over || reading || document.hidden) return;
    reading = true;
    let r = null;
    try { r = await api.ownerState(rowId); } catch { r = null; }
    reading = false;
    if (over || !r || typeof r !== 'object') return;
    view = { shareable: r.shareable === true, available: r.available === true, reason: typeof r.reason === 'string' ? r.reason : '', teams: Array.isArray(r.teams) ? r.teams : [], shares: Array.isArray(r.shares) ? r.shares : [], groups: Array.isArray(r.groups) ? r.groups : [], others: Array.isArray(r.others) ? r.others : [] };
    if (!view.shareable) { sheet = false; closeCard(); }
    render();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  // The thread ended or moved: the controls go with it.
  function end() { over = true; stop(); view = null; sheet = false; closeCard(); const l = $('th-owner-line'); if (l) l.replaceChildren(); const r = $('th-owner'); if (r) r.hidden = true; const i = $('th-share'); if (i) i.hidden = true; }

  function start(threadApi, id) {
    if (!threadApi || typeof threadApi.ownerState !== 'function') return;
    api = threadApi; rowId = id; over = false; view = null;
    parts();
    stop(); timer = setInterval(read, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void read(); });
    window.addEventListener('pagehide', stop);
    void read();
  }
  window.ThreadOwner = Object.freeze({ start, end, SCOPE, EXPIRY });
})();
