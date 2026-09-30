// Sidebar renderer. Builds DOM with textContent only (no innerHTML); the page
// list comes from main (pages.js) so both sides agree on ids.
const SVG = 'http://www.w3.org/2000/svg';

// 16px grid, 1.5 stroke, same drawing style as the board's icons.js.
const ICONS = {
  board: ['M2.75 3h3v10h-3zM6.5 3h3v7h-3zM10.25 3h3v8.5h-3z'],
  sun: ['M8 5.25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5z', 'M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1'],
  tasks: ['M3 4.5l1.25 1.25L6.5 3.5M3 10.5l1.25 1.25L6.5 9.5M8.5 4.75h4.5M8.5 10.75h4.5'],
  plug: ['M6 2.5v3M10 2.5v3M4.25 5.5h7.5v2.25a3.75 3.75 0 0 1-7.5 0zM8 11.5v2.25'],
  team: ['M6 7a2.25 2.25 0 1 0 0-4.5A2.25 2.25 0 0 0 6 7zM1.75 13.25c.5-2.1 2.1-3.25 4.25-3.25s3.75 1.15 4.25 3.25M10.75 2.6a2.25 2.25 0 0 1 0 4.3M12 10.2c1.2.4 2 1.4 2.25 3.05'],
  chart: ['M2.75 13.25h10.5M4.5 11V8M8 11V4.5M11.5 11V6.5'],
  layers: ['M8 2.75l5.5 2.75L8 8.25 2.5 5.5zM2.5 8.25L8 11l5.5-2.75M2.5 11L8 13.75 13.5 11'],
  puzzle: ['M3 5.5h2.25a1.5 1.5 0 1 1 3 0H10.5v2.25a1.5 1.5 0 1 1 0 3V13H3z'],
  lights: ['M5.25 1.75h5.5v12.5h-5.5z', 'M8 4.25v.01M8 8v.01M8 11.75v.01'],
  gear: ['M8 5.75a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5z', 'M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1'],
  external: ['M9.5 2.75h3.75V6.5M13.25 2.75L7.5 8.5M11.5 9.5v3a.75.75 0 0 1-.75.75h-7.5a.75.75 0 0 1-.75-.75v-7.5a.75.75 0 0 1 .75-.75h3'],
};

function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'nav-icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] ?? []) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

const state = { selected: 'board', hub: { state: 'stopped' } };
let pages = [];
let groups = [];
const buttons = new Map();

function item(p, child = false) {
  const btn = el('button', {
    type: 'button',
    class: `nav-item${child ? ' nav-child' : ''}`,
    'data-page': p.id,
    'data-kind': p.kind,
  }, child ? null : icon(p.icon), el('span', { class: 'nav-label' }, p.title),
  p.kind === 'window' ? icon('external') : null,
  p.kind === 'soon' ? el('span', { class: 'nav-soon' }, 'soon') : null);
  if (p.kind === 'window') btn.setAttribute('aria-label', `${p.title} (opens its own window)`);
  btn.addEventListener('click', () => window.buddy.select(p.id));
  buttons.set(p.id, btn);
  return btn;
}

function build() {
  const nav = document.getElementById('nav');
  nav.textContent = '';
  buttons.clear();
  for (const g of groups) {
    const list = pages.filter((p) => p.group === g.id);
    if (!list.length) continue;
    const sec = el('section', { class: 'nav-group' });
    if (g.title) sec.append(el('h2', { class: 'nav-heading' }, g.title));
    const ul = el('ul', { class: 'nav-list' });
    for (const p of list) {
      const li = el('li', {}, item(p));
      if (p.children?.length) {
        const sub = el('ul', { class: 'nav-sub', 'aria-label': `${p.title} views` });
        for (const c of p.children) sub.append(el('li', {}, item(c, true)));
        li.append(sub);
      }
      ul.append(li);
    }
    sec.append(ul);
    nav.append(sec);
  }
  paint();
}

const HUB_TEXT = {
  starting: 'Starting the board…',
  restarting: 'Board restarting…',
  failed: 'Board unavailable',
};

function paint() {
  for (const [id, btn] of buttons) {
    const on = id === state.selected;
    if (on) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
  }
  const hub = document.getElementById('hub');
  const s = state.hub?.state;
  hub.textContent = HUB_TEXT[s] ?? (s === 'ready' ? (state.hub.mode === 'team' ? 'Team board' : 'Board on this Mac') : '');
  hub.dataset.state = s ?? 'stopped';
}

// ↑/↓ move between entries, like a native source list.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const all = [...buttons.values()];
  const i = all.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length].focus();
});

window.buddy.onState((s) => { Object.assign(state, s); paint(); });
window.buddy.pages().then((r) => { if (!r) return; pages = r.pages; groups = r.groups; build(); });
