'use strict';
// The Usage tab strip (redesign R7-2, chat-first preview only): Today · Spend · Stats · Burst · Client billing. Each tab
// is its own page; this document only names which one to show. Arrow keys, Home and End move between tabs (Tab can't
// cross into the page below, which is another view).
(() => {
  const api = window.usageTabs;
  const tabs = [...document.querySelectorAll('.ut-tab')];
  if (!api || !tabs.length) return;
  let selected = null;
  function paint() {
    const current = tabs.find((t) => t.dataset.id === selected) ?? tabs[0];
    for (const t of tabs) {
      const on = t.dataset.id === selected;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = t === current ? 0 : -1;
    }
  }
  function go(t) { if (!t || t.dataset.id === selected) return; selected = t.dataset.id; paint(); api.select(t.dataset.id); }
  for (const t of tabs) t.addEventListener('click', () => go(t));
  document.getElementById('ut').addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const t = tabs[(to + tabs.length) % tabs.length];
    t.focus();
    go(t);
  });
  api.onState((s) => { selected = s.selected; paint(); });
  paint();
})();
