'use strict';
// Home's "Start with a pack" card (src/starter-pack-main.js decides what it
// holds). Shown once, after an AI tool is connected, for the stack seen in
// recent repos. The page only ever sends an action word; the gallery list
// is fetched on the first click, the pack is added after a native confirm,
// and the first recipe runs after another click. textContent only.
(() => {
  const api = window.homeApi;
  const section = document.getElementById('starter');
  if (!api || !api.starter || !section) return;
  const out = section.querySelector('.body');
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  let busy = false, generation = 0, run = null, note = '';

  function button(label, action, primary) {
    const b = node('button', label, primary ? 'primary' : ''); b.type = 'button'; b.dataset.focus = `starter:${action}`;
    b.addEventListener('click', () => void act(action, b));
    return b;
  }
  async function act(action, control) {
    if (busy) return;
    busy = true; control.disabled = true;
    let r;
    try { r = await api.starterAct(action); } catch { r = { ok: false, error: 'That did not work. Try again.' }; }
    busy = false; control.disabled = false;
    if (r && r.ok && action === 'add') { run = r.run; note = r.note || ''; render(null); return; }
    if (r && r.ok && action === 'run') { run = null; note = r.note || ''; render(null); return; }
    if (r && r.ok && action === 'look' && 'suggestion' in r) { note = ''; render(r.suggestion); return; }
    if (r && r.ok && action === 'dismiss') { section.hidden = true; return; }
    note = r && !r.ok && !r.cancelled ? r.error || 'That did not work.' : '';
    void refresh();
  }

  function render(s) {
    const parts = [];
    if (run) {
      parts.push(node('p', `${note} Run “${run.recipe.title}” on ${run.folder}? It only reads and reports.`));
      const actions = node('div', '', 'actions');
      actions.append(button('Run it now', 'run', true), button('Not now', 'dismiss'));
      parts.push(actions);
    } else if (!s) {
      if (!note) { section.hidden = true; out.replaceChildren(); return; }
      parts.push(node('p', note, 'muted'));
    } else if (s.stage === 'look') {
      parts.push(node('p', `${s.folder} looks like a ${s.stackLabel} project. The gallery has a starter pack of read-only recipes for it.`));
      const actions = node('div', '', 'actions');
      actions.append(button('Look it up', 'look', true), button('No thanks', 'dismiss'));
      parts.push(actions);
    } else {
      parts.push(node('p', `${s.folder} looks like a ${s.stackLabel} project. ${s.pack.title}: ${s.pack.summary}`));
      const list = node('ul', null, 'starter-list'); list.setAttribute('aria-label', 'What the pack contains');
      for (const m of s.pack.members) list.append(node('li', `${m.title} (${m.kind})`));
      parts.push(list);
      const actions = node('div', '', 'actions');
      actions.append(button('Add the pack', 'add', true), button('No thanks', 'dismiss'));
      parts.push(actions);
      if (note) parts.push(node('p', note, 'muted'));
    }
    section.hidden = false;
    out.replaceChildren(...parts);
  }

  async function refresh() {
    if (run) return;
    const request = ++generation;
    let s;
    try { s = await api.starter(); } catch { s = null; }
    if (request !== generation) return;
    render(s);
  }
  setInterval(() => { if (!document.hidden) void refresh(); }, 60000);
  void refresh();
})();
