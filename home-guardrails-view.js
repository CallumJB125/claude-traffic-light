'use strict';
// Home's "Project safety" section (src/guardrails-main.js decides what it holds):
// leaked keys, secrets the browser would get, open database rules, .env files
// git would share, and commands waiting for you that can't be taken back.
// Cards carry an opaque id; main resolves it and asks before restoring files.
(() => {
  const api = window.homeApi;
  const section = document.getElementById('guardrails');
  if (!api || !api.guardrails || !section) return;
  const out = section.querySelector('.body');
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  let busy = false, generation = 0, note = '';

  async function act(id, action, control) {
    if (busy) return;
    busy = true; control.disabled = true;
    let r;
    try { r = await api.guardrailsAct(id, action); } catch { r = { ok: false }; }
    busy = false; control.disabled = false;
    note = r && r.note ? r.note : r && !r.ok && !r.cancelled ? r.error || 'That card has changed. Home refreshes in a moment.' : '';
    void refresh();
  }
  function card(c, lines, buttons) {
    const li = node('li');
    if (c.status === 'resolved') li.className = 'resolved';
    const text = node('div');
    text.append(node('strong', c.status === 'resolved' ? `Fixed: ${c.title}` : c.title, 'title'));
    for (const [t, cls] of lines) if (t) text.append(node(cls === 'code' ? 'code' : 'p', t, cls === 'code' ? '' : 'muted'));
    const actions = node('div', '', 'actions');
    for (const [label, action, primary] of buttons) {
      const b = node('button', label, primary ? 'primary' : ''); b.type = 'button'; b.dataset.focus = `${c.id}:${action}`;
      b.addEventListener('click', () => void act(c.id, action, b));
      actions.append(b);
    }
    li.append(text, actions);
    return li;
  }
  function render(s) {
    const findings = (s && s.findings) || [], offers = (s && s.offers) || [], careful = (s && s.careful) || [];
    section.hidden = !findings.length && !offers.length && !careful.length;
    if (section.hidden) return out.replaceChildren();
    const focus = document.activeElement?.dataset?.focus;
    const list = node('ul'); list.setAttribute('aria-label', 'Project safety warnings');
    for (const c of careful) list.append(card(c, [[`Project: ${c.project}. What it affects: ${c.target}`], [c.note]], []));
    for (const c of findings) {
      const buttons = c.status === 'resolved' ? [['Hide', 'dismiss']] : [
        ...(c.canRotate ? [['Make a new key', 'rotate', true]] : []),
        ...(c.canRestore ? [['Undo this turn', 'restore']] : []),
        ['Check again', 'recheck'], ['Dismiss', 'dismiss'],
      ];
      list.append(card(c, [[`Project: ${c.project}`], [c.preview, 'code'], [c.status === 'resolved' ? '' : c.fix]], buttons));
    }
    for (const c of offers) list.append(card(c, [[c.fix]], [['Check database rules', 'db-on', true], ['No thanks', 'db-off']]));
    out.replaceChildren(list);
    if (note) { const p = node('p', note, 'muted'); p.setAttribute('role', 'status'); out.append(p); }
    if (focus) [...out.querySelectorAll('[data-focus]')].find((el) => el.dataset.focus === focus)?.focus();
  }
  async function refresh() {
    const request = ++generation;
    let s;
    try { s = await api.guardrails(); } catch { s = null; }
    if (request !== generation || document.hidden || busy) return;
    render(s);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
  void refresh();
})();
