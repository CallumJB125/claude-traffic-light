'use strict';
// The DEMO banner (src/demo-mode.js): shown on every page that loads this
// while the demo is on, with the one way out. Exit reloads the real view.
(() => {
  const api = window.demoApi;
  if (!api) return;
  const bar = document.createElement('div');
  bar.className = 'demo-banner';
  bar.setAttribute('role', 'status');
  bar.hidden = true;
  const label = document.createElement('strong');
  label.textContent = 'DEMO';
  const text = document.createElement('span');
  text.textContent = 'Sample data only. These sessions, prompts, costs and cards are made up. Nothing is saved and nothing is sent.';
  const exit = document.createElement('button');
  exit.type = 'button';
  exit.textContent = 'Exit demo';
  exit.addEventListener('click', async () => { exit.disabled = true; await api.exit().catch(() => null); location.reload(); });
  bar.append(label, text, exit);
  document.body.prepend(bar);
  let was = null;
  async function check() {
    const s = await api.state().catch(() => null);
    const on = !!(s && s.active);
    bar.hidden = !on;
    document.body.classList.toggle('demo-on', on);
    if (was !== null && was !== on) location.reload();
    was = on;
  }
  window.addEventListener('focus', () => void check());
  setInterval(() => { if (!document.hidden) void check(); }, 3000);
  void check();
})();
