'use strict';
// Home's "Stuck and limits" section (src/home-alerts.js decides what it holds).
// Each card carries an opaque handle; main resolves it and asks before queueing a task.
(() => {
  const api = window.homeApi;
  const section = document.getElementById('alerts');
  if (!api || !api.alerts || !section) return;
  const out = section.querySelector('.body');
  const status = document.getElementById('status');
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  let busy = false, generation = 0, note = '';

  async function act(kind, action, handle, control) {
    if (busy) return;
    busy = true; control.disabled = true;
    let r;
    try { r = await api.alertAct(kind, action, handle); } catch { r = { ok: false, error: 'That did not work. Try again.' }; }
    busy = false; control.disabled = false;
    note = r && r.note ? r.note : r && !r.ok && !r.cancelled ? r.error || 'That card has changed. Home refreshes in a moment.' : '';
    if (note) status.textContent = note;
    void refresh();
  }
  function card(kind, c, at, buttons) {
    const li = node('li');
    const text = node('div'); text.append(node('strong', c.title, 'title'), node('p', c.meta, 'muted'));
    const actions = node('div', '', 'actions');
    for (const [label, action, primary] of buttons) {
      const b = node('button', label, primary ? 'primary' : ''); b.type = 'button'; b.dataset.focus = `${kind}:${at}:${action}`;
      b.addEventListener('click', () => void act(kind, action, c.handle, b));
      actions.append(b);
    }
    li.append(text, actions);
    return li;
  }
  function render(s) {
    const stuck = (s && s.stuck) || [], limits = (s && s.limits) || [];
    section.hidden = !stuck.length && !limits.length;
    if (section.hidden) return out.replaceChildren();
    const focus = document.activeElement?.dataset?.focus;
    const list = node('ul'); list.setAttribute('aria-label', 'Stuck sessions and usage limits');
    stuck.forEach((c, at) => list.append(card('stuck', c, at, [...(c.canOpen ? [['Open session', 'open', true]] : []), ...(c.canHand ? [['Hand to another AI', 'handoff']] : []), ['Dismiss', 'dismiss']])));
    limits.forEach((c, at) => list.append(card('limit', c, at, [...(c.canResume ? [['Resume this at reset', 'resume', true]] : []), ['Dismiss', 'dismiss']])));
    out.replaceChildren(list);
    if (note) { const p = node('p', note, 'muted'); p.setAttribute('role', 'status'); out.append(p); }
    if (focus) [...out.querySelectorAll('[data-focus]')].find((el) => el.dataset.focus === focus)?.focus();
  }
  async function refresh() {
    const request = ++generation;
    let s;
    try { s = await api.alerts(); } catch { s = null; }
    if (request !== generation || document.hidden || busy) return;
    render(s);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
  void refresh();
})();
