'use strict';
// The Tasks page's community gallery (src/gallery.js decides everything):
// browse recipes, characters and packs from plexiform.dev and add a recipe or
// a character. Nothing is fetched until the person presses Fetch or Refresh;
// after that the list opens from the cache. Text is only ever textContent, and
// the page sends main an entry id and the sha256 it was shown, nothing else.
(() => {
  const api = window.galleryApi;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (label, cls, on) => { const b = el('button', `btn ${cls || ''}`.trim(), label); b.type = 'button'; b.addEventListener('click', on); return b; };
  const root = $('cg-gallery');
  const KINDS = [['', 'All'], ['recipe', 'Recipes'], ['character', 'Characters'], ['pack', 'Packs'], ['rules', 'Widget rules'], ['setup', 'Setups']];
  const KIND_LABEL = { recipe: 'Recipe', character: 'Character', pack: 'Pack', rules: 'Widget rules', setup: 'Setup' };
  const STACKS = [['', 'Any stack'], ['nextjs', 'Next.js'], ['python', 'Python'], ['swift', 'Swift'], ['go', 'Go'], ['rust', 'Rust'], ['node', 'Node'], ['rails', 'Rails']];
  let data = null, kind = '', stack = '', query = '', status = null, list = null;

  function show(on) { root.hidden = !on; document.body.classList.toggle('cg-open', on); $('cg-open').setAttribute('aria-expanded', String(on)); }
  const say = (text) => { if (status) status.textContent = text; };
  const by = (i) => `by ${i.author.name}${i.author.github ? ` (@${i.author.github})` : ''}, self-declared · ${i.license} · updated ${i.updated}`;

  async function refresh(b) {
    b.disabled = true; say('Fetching the gallery from plexiform.dev…');
    const r = await api.refresh().catch(() => null);
    b.disabled = false;
    if (!r || !r.ok) { say((r && r.error) || 'Could not fetch the gallery. Try again.'); return; }
    data = r;
    render();
    say(`Fetched ${r.items.length} item${r.items.length === 1 ? '' : 's'}.${r.dropped ? ` ${r.dropped} that did not pass the app’s checks ${r.dropped === 1 ? 'was' : 'were'} left out.` : ''}`);
  }
  async function add(item, b) {
    b.disabled = true;
    const r = await api.add(item.id, item.sha256).catch(() => null);
    b.disabled = false;
    if (r && r.ok) {
      say(r.kind === 'character' ? `Added “${item.title}” to Characters.` : r.kind === 'rules' ? `Opened “${item.title}” in Widget configuration. Press Load there, then Save, to keep them.` : r.kind === 'setup' ? `Opened “${item.title}” on the Setups page. Nothing is written until you tick each file and Apply there.` : `Added “${item.title}” to My recipes.`);
      if (r.kind === 'recipe') document.dispatchEvent(new CustomEvent('gallery:added'));
      return;
    }
    say((r && r.error) || 'That was not added.');
  }
  function addButton(item) {
    const b = btn('Add', 'small primary', () => add(item, b));
    if (data.demo) { b.disabled = true; b.title = 'This is the demo: nothing is added.'; }
    return b;
  }

  function card(item) {
    const li = el('li', 'recipe cg-card');
    li.dataset.id = item.id;
    const tags = el('p', 'recipe-tags');
    tags.append(el('span', 'rtag', KIND_LABEL[item.kind]), ...(item.kind === 'recipe' ? [el('span', 'rtag', 'Read only')] : []), ...item.stacks.filter((s) => s !== 'any').map((s) => el('span', 'rtag', s)));
    li.append(el('h3', null, item.title), el('p', 'recipe-what', item.summary), tags, el('p', 'recipe-cost', by(item)));
    const p = item.preview;
    const more = el('details', 'recipe-prompt');
    if (item.kind === 'recipe') { more.append(el('summary', null, 'See the prompt'), el('p', 'recipe-cost', `${p.what} Cost: ${p.cost}`), el('pre', null, p.prompt)); li.append(more); }
    else if (item.kind === 'character') li.append(el('p', 'recipe-cost', `A widget character named ${p.name}. Its art is checked again before it is saved.`));
    else if (item.kind === 'setup') { more.append(el('summary', null, `${p.files.length} file${p.files.length === 1 ? '' : 's'} an AI will read as instructions`)); for (const f of p.files) more.append(el('p', 'recipe-cost', `~/${f.path}`), el('pre', null, f.content)); if (p.note) more.append(el('p', 'recipe-cost', p.note)); li.append(more); }
    else if (item.kind === 'rules') { more.append(el('summary', null, `${p.names.length} widget rule${p.names.length === 1 ? '' : 's'}`), el('p', 'recipe-cost', 'They open in Widget configuration, and replace your rules only when you press Load and then Save there.')); const ul = el('ul', 'cg-members'); for (const n of p.names) ul.append(el('li', null, n)); more.append(ul); li.append(more); }
    else if (item.kind === 'pack') {
      more.open = true;
      more.append(el('summary', null, `${p.members.length} items, each added on its own`));
      const ul = el('ul', 'cg-members');
      for (const m of p.members) {
        const row = el('li');
        row.append(el('span', null, m.missing ? `${m.id} (not in the gallery)` : `${KIND_LABEL[m.kind]}: ${m.title}`));
        const full = !m.missing && data.items.find((x) => x.id === m.id);
        if (full && m.addable) row.append(addButton(full));
        else if (!m.missing) row.append(el('span', 'recipe-cost', 'Available in a later version'));
        ul.append(row);
      }
      if (p.note) more.append(el('p', 'recipe-cost', p.note));
      more.append(ul);
      li.append(more);
    } else li.append(el('p', 'recipe-cost', 'Available in a later version.'));
    const row = el('div', 'recipe-actions');
    if (item.addable) row.append(addButton(item));
    li.append(row);
    return li;
  }

  function renderList() {
    if (!list || !data) return;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = data.items.filter((i) => (!kind || i.kind === kind)
      && (!stack || i.stacks.includes(stack) || i.stacks.includes('any'))
      && words.every((w) => [i.title, i.summary, i.author.name, ...i.tags].join(' ').toLowerCase().includes(w)));
    list.replaceChildren(...shown.map(card));
    if (!shown.length) list.append(el('li', 'recipes-status', 'Nothing matches. Try another search or filter.'));
  }

  function render() {
    const head = el('header', 'recipes-head');
    const title = el('div');
    title.append(el('h2', null, 'Community gallery'), el('p', null, 'Recipes, widget characters, widget rules and setups other people shared on plexiform.dev. Gallery recipes only read: they plan and report and never change files. You see everything an item contains before it is added, and nothing runs when you add it.'));
    title.firstChild.id = 'cg-title';
    head.append(title, btn('Back to recipes', 'small', () => show(false)));
    const where = el('div', 'recipes-where');
    if (data) {
      where.append(el('span', `cg-provenance ${data.signed ? 'signed' : 'unsigned'}`, data.provenance), el('span', 'recipe-cost', data.fetchedAt ? `Fetched ${new Date(data.fetchedAt).toLocaleString()}` : 'Fetched earlier'));
      const r = btn('Refresh', 'small', () => refresh(r));
      where.append(r);
    } else {
      where.append(el('span', null, 'The gallery list comes from plexiform.dev. Nothing about you or your work is sent.'));
      const f = btn('Fetch the gallery', 'small primary', () => refresh(f));
      where.append(f);
    }
    status = el('p', 'recipes-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const parts = [head, where, status];
    if (data) {
      const filters = el('div', 'cg-filters');
      for (const [k, label] of KINDS) {
        const c = btn(label, 'small cg-chip', () => { kind = k; for (const x of filters.querySelectorAll('.cg-chip')) x.setAttribute('aria-pressed', String(x === c)); renderList(); });
        c.setAttribute('aria-pressed', String(k === kind));
        filters.append(c);
      }
      const sel = el('select', 'cg-stack'); sel.setAttribute('aria-label', 'Stack');
      for (const [v, label] of STACKS) { const o = el('option', null, label); o.value = v; sel.append(o); }
      sel.value = stack;
      sel.addEventListener('change', () => { stack = sel.value; renderList(); });
      const search = el('input', 'cg-search'); search.type = 'search'; search.placeholder = 'Search'; search.value = query; search.setAttribute('aria-label', 'Search the gallery');
      search.addEventListener('input', () => { query = search.value; renderList(); });
      filters.append(sel, search);
      list = el('ul', 'recipe-grid'); list.setAttribute('aria-label', 'Gallery items');
      parts.push(filters, list);
    }
    root.replaceChildren(...parts);
    renderList();
  }

  async function open() {
    show(true);
    if (!data) { const c = await api.cached().catch(() => null); if (c && c.ok) data = c; }
    render();
  }

  $('cg-open').addEventListener('click', () => { if (root.hidden) void open(); else show(false); });
  // Recipes while the gallery covers it goes back to it rather than toggling it shut.
  $('recipes-open').addEventListener('click', (e) => { if (root.hidden) return; show(false); if (!$('recipes').hidden) e.stopImmediatePropagation(); }, true);
  for (const id of ['new-task', 'list']) $(id).addEventListener('click', () => show(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) { e.stopImmediatePropagation(); show(false); } }, true);
})();
