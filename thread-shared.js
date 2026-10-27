// A teammate's shared session as a read-only thread (T2). Builds everything from main's fixed projection
// (src/shared-thread-view.js) with textContent only; it holds no ref, id or token and has no send path.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 5000;
  const CHIP = { queued: 'Queued', accepted: 'Accepted', acknowledged: 'Received', echoed: 'Echoed', responding: 'Responding', replied: 'Done', completed: 'Done', interrupted: 'Interrupted', unconfirmed: 'Unconfirmed', failed: 'Failed', unknown: 'Unconfirmed' };
  const BANNER = 'You see messages sent since it was shared, and its current activity. Earlier history stays private.';
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const ago = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  const clock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

  let api = null, rowId = '', timer = null, reading = false, view = null, stale = false, over = false;

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
    const banner = $('th-banner'); banner.hidden = false; banner.textContent = BANNER;
    const a = v.activity;
    root.querySelector('.th-activity').textContent = stale ? 'Showing the last known state.' : a.category ? `${a.stale ? 'Last reported' : 'Now'}: ${a.category} · ${ago(a.ageMs)}` : 'No activity reported yet.';
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
    const foot = root.querySelector('.th-shared-foot');
    if (h.scope === 'interact') {
      const b = el('button', 'th-btn', 'Open in Team sessions'); b.type = 'button'; b.addEventListener('click', () => { void api.openTeam(rowId); });
      foot.replaceChildren(el('p', 'th-shared-note', 'To send, steer or interrupt, use Team sessions.'), b);
    } else foot.replaceChildren(el('p', 'th-shared-note', `Shared with you to watch only. Ask ${h.owner} to allow sending.`));
  }

  function gone(reason) {
    over = true; stop(); view = null;
    hideChat();
    $('th-more').hidden = true;
    const root = pieces();
    root.querySelector('.th-activity').textContent = ''; root.querySelector('.th-msgs').replaceChildren(); root.querySelector('.th-shared-foot').replaceChildren();
    root.querySelector('.th-shared-empty').textContent = '';
    $('th-banner').hidden = true;
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
    if (r.unavailable === true) { stale = true; if (view) render(); return; }
    stale = false; view = r; render();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  function start(threadApi, id) {
    api = threadApi; rowId = id; over = false; view = null; stale = false;
    hideChat(); pieces(); menu();
    stop(); timer = setInterval(read, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void read(); });
    window.addEventListener('pagehide', stop);
    void read();
  }
  window.ThreadShared = Object.freeze({ start, BANNER });
})();
