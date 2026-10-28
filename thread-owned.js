// One of my own Plexiform-held sessions as a read-only thread (T4a, plan-t4a §3): a session Overview started or
// connected, shown with T2's layout (activity, the messages sent to it with their receipts and replies). Built from
// main's fixed projection (src/owned-thread-view.js) with textContent only; it holds no session or route id.
// No prompt box or Stop: messaging it stays in Overview. T4's owner controls (thread-owner.js) share it from the ⋯ menu.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 5000;
  const CHIP = { queued: 'Queued', accepted: 'Accepted', acknowledged: 'Received', echoed: 'Echoed', responding: 'Responding', replied: 'Done', completed: 'Done', interrupted: 'Interrupted', unconfirmed: 'Unconfirmed', failed: 'Failed', unknown: 'Unconfirmed' };
  const FOOT = 'Started from Overview. To message it, use Overview.';
  const FOOT_CHANNEL = 'Connected from Overview. To message it, use Overview.';
  const GONE = { overview: 'This session ended when Overview reloaded.', ended: 'This session has ended.', account: 'This session belongs to the account you switched from.' };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const ago = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  let api = null, rowId = '', timer = null, reading = false, view = null, over = false;

  function pieces() {
    let root = $('th-owned');
    if (root) return root;
    root = el('section', 'th-shared th-owned'); root.id = 'th-owned';
    const foot = el('div', 'th-shared-foot');
    const go = el('button', 'th-btn', 'Open in Overview'); go.type = 'button'; go.id = 'th-ow-overview';
    go.addEventListener('click', () => { void api.openOverview(rowId); });
    foot.append(el('p', 'th-shared-note', FOOT), go);
    root.append(el('p', 'th-activity'), el('ul', 'th-msgs'), el('p', 'th-shared-empty'), foot);
    $('th-tx').before(root);
    return root;
  }
  function hideChat() {
    for (const id of ['th-tx', 'th-waiting', 'th-cards', 'th-hooks', 'th-reply', 'th-stop', 'th-ended', 'th-empty', 'th-primary', 'th-tasks', 'th-terminal', 'th-copy', 'th-banner']) { const n = $(id); if (n) n.hidden = true; }
    $('th-bucket').textContent = '';
    $('th-dot').hidden = true;
    // The ⋯ menu holds only Share with team… (T4) when main offers it: an owned row has no Copy link (its id is per Overview document).
    const share = $('th-share');
    $('th-more').hidden = !share || share.hidden;
    $('th').classList.add('is-shared', 'is-owned');
  }

  function render() {
    const root = pieces(), v = view;
    hideChat();
    $('th').setAttribute('aria-busy', 'false');
    if (!v) return;
    const h = v.header;
    document.title = h.title;
    $('th-title').textContent = h.title;
    $('th-meta').textContent = h.channel ? 'Claude Code in your terminal · Connected from Overview' : `${h.provider} session · Started from Overview`;
    const a = v.activity;
    root.querySelector('.th-activity').textContent = v.status === 'working' && !a.category ? 'Working.' : a.category ? `${a.stale ? 'Last reported' : 'Now'}: ${a.category} · ${ago(a.ageMs)}` : 'No activity reported yet.';
    const items = v.deliveries.map((d) => {
      const li = el('li', 'th-msg');
      li.append(el('p', 'th-msg-by', d.by ? `Sent by ${d.by}` : 'Sent from Overview'), el('p', 'th-msg-text', d.text));
      const chip = el('span', 'th-chip', CHIP[d.state] || 'Unconfirmed'); chip.dataset.state = d.state;
      li.append(chip);
      if (d.state === 'unconfirmed' || d.state === 'unknown') li.append(el('p', 'th-msg-note', 'Receipt unconfirmed. The agent may still act; do not resend automatically.'));
      if (d.response) li.append(el('p', 'th-msg-reply', d.response));
      return li;
    });
    root.querySelector('.th-msgs').replaceChildren(...items);
    root.querySelector('.th-shared-empty').textContent = items.length ? '' : 'No messages have been sent to it yet.';
    root.querySelector('.th-shared-note').textContent = h.channel ? FOOT_CHANNEL : FOOT;
  }

  function gone(reason) {
    over = true; stop(); view = null;
    if (window.ThreadOwner) window.ThreadOwner.end();
    hideChat();
    const root = pieces();
    root.hidden = true;
    const text = GONE[reason] || GONE.ended;
    $('th-title').textContent = text; $('th-meta').textContent = '';
    document.title = text;
    const e = $('th-empty'); e.hidden = false; $('th-empty-title').textContent = text; $('th-empty-text').textContent = 'Nothing from it is kept here.';
    $('th-board').hidden = false;
    $('th').setAttribute('aria-busy', 'false');
  }

  async function read() {
    if (over || reading || document.hidden) return;
    reading = true;
    let r = null;
    try { r = await api.ownedState(rowId); } catch { r = null; }
    reading = false;
    if (over || !r || typeof r !== 'object') return;
    if (r.gone === true) { gone(r.reason); return; }
    view = r; render();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  function start(threadApi, id) {
    api = threadApi; rowId = id; over = false; view = null;
    hideChat(); pieces();
    stop(); timer = setInterval(read, POLL_MS);
    if (window.ThreadOwner) window.ThreadOwner.start(api, rowId);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void read(); });
    window.addEventListener('pagehide', stop);
    void read();
  }
  window.ThreadOwned = Object.freeze({ start, FOOT, FOOT_CHANNEL, GONE });
})();
