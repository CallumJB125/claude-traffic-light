'use strict';
// Sessions' "Hand-off requests" panel (src/handoff-requests.js): a running AI
// asked to hand its work to another tool on this Mac. Nothing happens until
// Confirm here, which opens the native preview of the exact packet; the other
// tool's outcome is written back on the same card. textContent only.
(() => {
  const api = window.sessionsApi;
  const section = document.getElementById('handoffs');
  if (!api || !api.handoffRequests || !section) return;
  const out = section.querySelector('.body');
  const status = document.getElementById('handoffs-status');
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const btn = (label, onClick, primary) => { const b = node('button', label, primary ? 'primary' : ''); b.type = 'button'; b.addEventListener('click', () => void onClick(b)); return b; };
  const NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', cursor: 'Cursor', hermes: 'Hermes' };
  const name = (id) => NAME[id] || id || 'an AI';
  const STATE = { started: 'Running', copied: 'Copied to paste in', done: 'Finished', failed: 'Did not finish', expired: 'Expired, not confirmed in time', dismissed: 'Dismissed' };
  let busy = false, generation = 0;

  async function run(control, fn, ok) {
    if (busy) return;
    busy = true; control.disabled = true;
    let r;
    try { r = await fn(); } catch { r = { ok: false, error: 'That did not work. Try again.' }; }
    busy = false; control.disabled = false;
    status.textContent = r && r.ok === false ? (r.cancelled ? 'Cancelled. Nothing was started.' : r.error || 'That did not work. Try again.') : (r && r.note) || ok || '';
    void refresh();
  }

  function item(r) {
    const li = node('li', null, 'mail-item');
    li.append(node('h3', `${name(r.from)} asks to hand off to ${r.label || name(r.to)}`));
    if (r.reason) li.append(node('p', `Why: ${r.reason}`, 'muted'));
    li.append(node('pre', [`Goal: ${r.goal}`, r.files.length ? `Files: ${r.files.join(', ')}` : ''].filter(Boolean).join('\n'), 'mail-body'));
    if (r.state === 'pending') {
      const actions = node('div', null, 'row-actions');
      actions.append(
        btn('Confirm…', (b) => run(b, () => api.handoffConfirm(r.id), `${r.label || name(r.to)} is starting. Its replies show above the session rows.`), true),
        btn('Dismiss', (b) => run(b, () => api.handoffDismiss(r.id), 'Dismissed. Nothing was started.')),
      );
      li.append(node('p', 'Confirm shows exactly what the other tool is given before anything starts.', 'muted'), actions);
    } else {
      li.append(node('p', `${STATE[r.state] || r.state}${r.note ? `: ${r.note}` : ''}`, 'muted'));
    }
    return li;
  }

  function render(rows) {
    section.hidden = !rows.length;
    if (section.hidden) return out.replaceChildren();
    const list = node('ul', null, 'mail-list');
    for (const r of rows) list.append(item(r));
    out.replaceChildren(list);
  }

  async function refresh() {
    const request = ++generation;
    let r;
    try { r = await api.handoffRequests(); } catch { r = null; }
    if (request !== generation || busy) return;
    render(r && r.ok ? r.requests : []);
  }

  if (api.onHandoffRequests) api.onHandoffRequests(() => void refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  void refresh();
})();
