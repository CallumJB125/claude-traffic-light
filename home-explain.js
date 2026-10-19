'use strict';
// Home's "What did my AI just do?" card and stuck help (src/explain-main.js).
// Hidden unless Explain mode is on in Settings. Recap text comes from the
// session's transcript: textContent only. Buttons send opaque handles.
(() => {
  const api = window.homeApi && window.homeApi.explain;
  const section = document.getElementById('explain');
  if (!api || !section) return;
  const out = section.querySelector('.body');
  const status = section.querySelector('.explain-status');
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const button = (label, onClick) => { const b = node('button', label); b.type = 'button'; b.addEventListener('click', onClick); return b; };
  const ago = (at) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

  function render(v) {
    section.hidden = !v || !v.on;
    if (section.hidden) return;
    const parts = [];
    for (const h of v.help || []) {
      const card = node('div', null, 'explain-help');
      card.appendChild(node('p', `${h.project}: ${h.why}`, 'explain-why'));
      const row = node('div', null, 'actions');
      for (const p of h.prompts) row.appendChild(button(p.label, async () => {
        let r; try { r = await api.copy(p.handle); } catch { r = null; }
        status.textContent = r && r.ok ? 'Copied. Paste it into your AI’s chat.' : 'Couldn’t copy that.';
      }));
      card.appendChild(row);
      parts.push(card);
    }
    for (const r of v.recaps || []) {
      const card = node('article', null, 'explain-recap');
      card.appendChild(node('h3', r.headline));
      card.appendChild(node('p', ago(r.at), 'muted'));
      const ul = node('ul');
      for (const l of r.lines) ul.appendChild(node('li', l));
      card.appendChild(ul);
      if (r.risky && r.risky.length) {
        card.appendChild(node('p', 'Worth a look:', 'explain-risky-title'));
        const rl = node('ul', null, 'explain-risky');
        for (const l of r.risky) rl.appendChild(node('li', l));
        card.appendChild(rl);
      }
      if (r.test) card.appendChild(button(r.test.label, () => { void api.openTest(r.test.handle); }));
      parts.push(card);
    }
    if (!parts.length) parts.push(node('p', 'When a session finishes, a plain-English recap shows here.', 'muted'));
    out.replaceChildren(...parts);
  }

  let seq = 0;
  async function refresh() {
    const my = ++seq;
    let v; try { v = await api.recaps(); } catch { v = null; }
    if (my === seq) render(v);
  }
  setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  void refresh();
})();
