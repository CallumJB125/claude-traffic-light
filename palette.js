'use strict';
// ⌘K palette on the Sessions page. Searches only what the directory already
// showed this viewer (src/command-palette.js); Enter asks the directory to
// open the exact row, or applies a teammate/project filter. No network, no
// provider identifiers.
(() => {
  const P = window.PlexiformPalette, $ = id => document.getElementById(id);
  if (!P) return;
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const host = el('div', '', 'palette'), dialog = el('div', '', 'palette-dialog'), input = el('input'), list = el('ul', '', 'palette-list'), hint = el('p', 'Type a teammate, project or task. Enter opens the exact session. Esc closes.', 'palette-hint');
  host.hidden = true; host.id = 'palette';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', 'Find a teammate, project or shared session');
  input.type = 'search'; input.id = 'palette-input'; input.placeholder = 'Find a teammate, project or session…'; input.autocomplete = 'off'; input.setAttribute('aria-label', 'Search'); input.setAttribute('aria-controls', 'palette-list'); input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'true');
  list.id = 'palette-list'; list.setAttribute('role', 'listbox');
  dialog.append(input, list, hint); host.append(dialog); document.body.append(host);
  let items = [], active = 0, opener = null;
  const index = () => window.OverviewDirectory?.index?.() ?? [];
  function render() {
    items = P.search(index(), input.value);
    active = Math.min(active, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((it, i) => {
      const li = el('li', '', 'palette-item'); li.setAttribute('role', 'option'); li.id = `palette-opt-${i}`; li.setAttribute('aria-selected', String(i === active));
      li.append(el('span', P.KINDS[it.kind], 'palette-kind'), el('strong', it.title), el('span', it.subtitle || '', 'muted'));
      li.addEventListener('mousemove', () => { if (active !== i) { active = i; mark(); } });
      li.addEventListener('click', () => choose(i));
      return li;
    }));
    if (!items.length) list.append(el('li', input.value.trim() ? 'No shared work matches.' : 'Nothing shared yet.', 'palette-empty'));
    mark();
  }
  function mark() { for (const [i, li] of [...list.children].entries()) if (li.classList.contains('palette-item')) li.setAttribute('aria-selected', String(i === active)); input.setAttribute('aria-activedescendant', items.length ? `palette-opt-${active}` : ''); list.children[active]?.scrollIntoView?.({ block: 'nearest' }); }
  function choose(i) { const it = items[i]; if (!it) return; close(); if (it.kind === 'command') { if (it.id === 'search-sessions') void window.overviewApi?.openSearch?.(); return; } window.OverviewDirectory?.openFromPalette?.(it); }
  function open() { if (!host.hidden) { input.focus(); return; } opener = document.activeElement; host.hidden = false; input.value = ''; active = 0; render(); input.focus(); }
  function close() { if (host.hidden) return; host.hidden = true; if (opener && typeof opener.focus === 'function') opener.focus(); opener = null; }
  input.addEventListener('input', () => { active = 0; render(); });
  dialog.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); active = Math.min(items.length - 1, active + 1); mark(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); active = Math.max(0, active - 1); mark(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); choose(active); }
    else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    else if (ev.key === 'Tab') { ev.preventDefault(); input.focus(); }
  });
  host.addEventListener('mousedown', ev => { if (ev.target === host) close(); });
  document.addEventListener('keydown', ev => { if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'k') { ev.preventDefault(); open(); } });
  window.PlexiformPaletteUI = Object.freeze({ open, close });
})();
