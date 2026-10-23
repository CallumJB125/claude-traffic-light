'use strict';
// The Discover page: the community gallery from plexiform.dev (src/gallery.js
// decides everything). Tabs for what is installed and for each kind; a card
// per item, a pack once as one card with its members named; a drawer with the
// whole item before Add. Nothing is fetched until the person presses Fetch or
// Refresh; after that the list opens from the cache. Text is only ever
// textContent (a character's art is the app's own sanitised definition, drawn
// by rig.js the way the widget draws it), and the page sends main an entry id
// and the sha256 it was shown, or a kind and local id to remove, nothing else.
(() => {
  const api = window.galleryApi;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (label, cls, on) => { const b = el('button', `btn ${cls || ''}`.trim(), label); b.type = 'button'; b.addEventListener('click', (e) => { e.stopPropagation(); on(e); }); return b; };
  const root = $('cg-gallery');
  const drawer = $('cg-drawer');
  const backdrop = $('cg-backdrop');
  const TABS = [['installed', 'Installed'], ['recipe', 'Recipes'], ['character', 'Characters'], ['pack', 'Packs'], ['rules', 'Widget rules'], ['setup', 'Setups']];
  const KIND_LABEL = { recipe: 'Recipe', character: 'Character', pack: 'Pack', rules: 'Widget rules', setup: 'Setup' };
  const STACKS = [['', 'Any stack'], ['nextjs', 'Next.js'], ['python', 'Python'], ['swift', 'Swift'], ['go', 'Go'], ['rust', 'Rust'], ['node', 'Node'], ['rails', 'Rails']];
  const PREVIEW_ID = 'u-cg-preview';
  let data = null, installed = null, tab = 'recipe', stack = '', query = '', status = null, list = null, opened = null;

  const say = (text) => { if (status) status.textContent = text; };
  const by = (i) => `by ${i.author.name}${i.author.github ? ` (@${i.author.github})` : ''}, self-declared · ${i.license} · updated ${i.updated}`;
  const find = (id) => data?.items.find((x) => x.id === id) || null;
  const have = (id) => !!installed && [...installed.recipes, ...installed.characters].some((x) => x.galleryId === id);
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  async function loadInstalled() {
    const r = await api.installed().catch(() => null);
    installed = r && r.ok ? r : { ok: true, recipes: [], characters: [] };
    renderList();
  }
  async function refresh(b) {
    b.disabled = true; say('Fetching the gallery from plexiform.dev…');
    const r = await api.refresh().catch(() => null);
    b.disabled = false;
    if (!r || !r.ok) { say((r && r.error) || 'Could not fetch the gallery. Try again.'); return; }
    data = r;
    render();
    say(`Fetched ${plural(r.items.length, 'item')}.${r.dropped ? ` ${r.dropped} that did not pass the app’s checks ${r.dropped === 1 ? 'was' : 'were'} left out.` : ''}`);
  }
  async function add(item, b) {
    b.disabled = true;
    const r = await api.add(item.id, item.sha256).catch(() => null);
    b.disabled = false;
    if (r && r.ok) {
      say(r.kind === 'character' ? `Added “${item.title}” to Characters.` : r.kind === 'rules' ? `Opened “${item.title}” in Widget rules. Press Load there, then Save, to keep them.` : r.kind === 'setup' ? `Opened “${item.title}” on the Setups page. Nothing is written until you tick each file and Apply there.` : `Added “${item.title}” to My recipes.`);
      if (r.kind === 'recipe' || r.kind === 'character') await loadInstalled();
      closeDrawer();
      renderList();
      return;
    }
    say((r && r.error) || 'That was not added.');
  }
  async function addPack(item, b) {
    b.disabled = true;
    const r = await api.addPack(item.id, item.sha256).catch(() => null);
    b.disabled = false;
    if (!r || !r.ok) { say((r && r.error) || 'That pack was not added.'); return; }
    const parts = [r.added.length ? `Added ${plural(r.added.length, 'item')} from “${item.title}”.` : `Nothing new to add from “${item.title}”.`];
    if (r.present.length) parts.push(`${r.present.length} already here.`);
    if (r.failed.length) parts.push(`${r.failed.length} could not be added.`);
    if (r.separate.length) parts.push('Widget rules and setups in it open one at a time from their own cards.');
    say(parts.join(' '));
    await loadInstalled();
    closeDrawer();
    renderList();
  }
  async function remove(kind, entry, b) {
    b.disabled = true;
    const r = await api.remove(kind, entry.id).catch(() => null);
    b.disabled = false;
    if (!r || !r.ok) { say((r && r.error) || 'That was not removed.'); return; }
    say(`Removed “${entry.title}”.`);
    await loadInstalled();
    renderList();
  }
  function addButton(item) {
    const pack = item.kind === 'pack';
    const b = btn(pack ? 'Add pack' : have(item.id) ? 'Add again' : 'Add', 'small primary', () => (pack ? addPack(item, b) : add(item, b)));
    if (data.demo) { b.disabled = true; b.title = 'This is the demo: nothing is added.'; }
    return b;
  }

  function tags(item) {
    const p = el('p', 'recipe-tags');
    p.append(el('span', 'rtag', KIND_LABEL[item.kind]), ...(item.kind === 'recipe' ? [el('span', 'rtag', 'Read only')] : []), ...item.stacks.filter((s) => s !== 'any').map((s) => el('span', 'rtag', s)));
    if (have(item.id)) p.append(el('span', 'rtag installed', 'Installed'));
    return p;
  }
  // A pack is one card: its members by name, each opening its own drawer, never a second Add.
  function memberList(item) {
    const ul = el('ul', 'cg-members');
    for (const m of item.preview.members) {
      const row = el('li');
      if (m.missing) { row.append(el('span', 'recipe-cost', `${m.id} (not in the gallery)`)); ul.append(row); continue; }
      const open = btn(`${KIND_LABEL[m.kind]}: ${m.title}`, 'link cg-member', () => openDrawer(find(m.id) || item));
      row.append(open);
      if (have(m.id)) row.append(el('span', 'recipe-cost', 'installed'));
      else if (m.kind === 'rules' || m.kind === 'setup') row.append(el('span', 'recipe-cost', 'opens on its own'));
      else if (!m.addable) row.append(el('span', 'recipe-cost', 'available in a later version'));
      ul.append(row);
    }
    return ul;
  }
  function card(item) {
    const li = el('li', 'recipe cg-card');
    li.dataset.id = item.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', `${item.title}: details`);
    li.append(el('h3', null, item.title), el('p', 'recipe-what', item.summary), tags(item), el('p', 'recipe-cost', by(item)));
    const p = item.preview;
    if (item.kind === 'pack') li.append(el('p', 'recipe-cost', plural(p.members.length, 'item')), memberList(item));
    else if (item.kind === 'rules') li.append(el('p', 'recipe-cost', `${plural(p.names.length, 'widget rule')}: ${p.names.join(', ')}`));
    else if (item.kind === 'setup') li.append(el('p', 'recipe-cost', `${plural(p.files.length, 'file')} an AI will read as instructions`));
    else if (item.kind === 'character') li.append(el('p', 'recipe-cost', `A widget character named ${p.name}.`));
    else if (item.kind === 'recipe') li.append(el('p', 'recipe-cost', `Cost: ${p.cost}`));
    const row = el('div', 'recipe-actions');
    row.append(btn('Details', 'small', () => openDrawer(item)));
    if (item.addable || item.kind === 'pack') row.append(addButton(item));
    li.append(row);
    const open = (e) => { if (e.target.closest('button, a')) return; openDrawer(item); };
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } });
    return li;
  }

  // ── the drawer: everything an item contains, before Add ──────────────────
  function fact(dl, k, v) { if (v == null || v === '') return; dl.append(el('dt', null, k), el('dd', null, v)); }
  function characterStage(ch) {
    const stage = el('div', 'cg-stage');
    stage.setAttribute('role', 'img');
    stage.setAttribute('aria-label', `A preview of ${ch.name}`);
    const C = window.BuddyCharacters;
    if (!ch.character || typeof window.mountRig !== 'function' || !C) { stage.append(el('p', 'recipe-cost', 'The art is checked by the app’s sanitiser when you add it.')); return stage; }
    try {
      C.register({ ...ch.character, id: PREVIEW_ID });
      window.mountRig(stage, {}).setLook({ lamp: 'green', pose: 'none', eyes: 'default', body: PREVIEW_ID });
    } catch { stage.replaceChildren(el('p', 'recipe-cost', 'This character could not be drawn here. It is checked again when you add it.')); }
    return stage;
  }
  function drawerBody(item) {
    const p = item.preview, parts = [];
    if (item.kind === 'recipe') {
      parts.push(el('p', null, p.what), el('p', 'recipe-cost', `Read-only: it plans and reports, and never changes files. Cost: ${p.cost}`), el('h3', 'cg-sub', 'The prompt it gives your AI'), el('pre', 'cg-pre', p.prompt));
    } else if (item.kind === 'character') {
      parts.push(characterStage(p), el('p', 'recipe-cost', `A widget character named ${p.name}. Its art is checked again by the app’s sanitiser before it is saved.`));
    } else if (item.kind === 'rules') {
      parts.push(el('p', 'recipe-cost', 'They open in Widget rules as an offer. Your rules change only if you press Load there and then Save. Clicks in gallery rules never run commands, Shortcuts, links or apps.'), el('h3', 'cg-sub', plural(p.names.length, 'rule')));
      const ul = el('ul', 'cg-plain'); for (const n of p.names) ul.append(el('li', null, n)); parts.push(ul);
    } else if (item.kind === 'setup') {
      parts.push(el('p', 'recipe-cost', 'It opens on the Setups page with every file in full. Nothing is written until you tick each file and press Apply there, and a backup is saved first.'));
      if (p.note) parts.push(el('p', null, p.note));
      parts.push(el('h3', 'cg-sub', `${plural(p.files.length, 'file')} an AI will read as instructions`));
      for (const f of p.files) parts.push(el('p', 'recipe-cost', `~/${f.path}`), el('pre', 'cg-pre', f.content));
    } else if (item.kind === 'pack') {
      if (p.note) parts.push(el('p', null, p.note));
      parts.push(el('h3', 'cg-sub', `In this pack (${p.members.length})`), memberList(item), el('p', 'recipe-cost', 'Add pack adds its recipes and characters after one confirm. Widget rules and setups in it open one at a time, each with its own review.'));
    }
    return parts;
  }
  function openDrawer(item) {
    if (!item) return;
    opened = item;
    const head = el('header', 'cg-drawer-head');
    const title = el('div');
    title.append(el('p', 'recipe-cost', KIND_LABEL[item.kind]), el('h2', null, item.title));
    title.lastChild.id = 'cg-drawer-title';
    head.append(title, btn('Close', 'small cg-drawer-close', closeDrawer));
    const dl = el('dl', 'cg-facts');
    fact(dl, 'By', `${item.author.name}${item.author.github ? ` (@${item.author.github})` : ''}, self-declared`);
    fact(dl, 'License', item.license);
    fact(dl, 'Added', item.added);
    fact(dl, 'Updated', item.updated);
    fact(dl, 'Stacks', item.stacks.join(', ') || 'any');
    fact(dl, 'Tools', item.tools.join(', ') || 'any');
    fact(dl, 'Tags', item.tags.join(', ') || 'none');
    const sha = el('dd'); sha.append(el('code', null, item.sha256)); dl.append(el('dt', null, 'sha256'), sha);
    const link = el('a', 'cg-site', 'View on plexiform.dev');
    link.href = `${data.site}${item.id}`; link.target = '_blank'; link.rel = 'noopener';
    const actions = el('div', 'recipe-actions cg-drawer-actions');
    if (item.addable || item.kind === 'pack') actions.append(addButton(item));
    drawer.replaceChildren(head, el('p', 'cg-summary', item.summary), tags(item), ...drawerBody(item), dl, link, actions);
    drawer.hidden = false; backdrop.hidden = false;
    document.body.classList.add('cg-drawer-open');
    drawer.querySelector('.cg-drawer-close').focus();
  }
  function closeDrawer() {
    if (drawer.hidden) return;
    const id = opened?.id;
    opened = null;
    drawer.hidden = true; backdrop.hidden = true;
    document.body.classList.remove('cg-drawer-open');
    drawer.replaceChildren();
    const back = id && list ? list.querySelector(`[data-id="${CSS.escape(id)}"]`) : null;
    if (back) back.focus();
  }

  // ── the Installed tab: what the gallery put here, with Remove ────────────
  function renderInstalled() {
    const parts = [];
    const sect = (title, rows, kind) => {
      parts.push(el('h3', 'recipes-sub', title));
      const ul = el('ul', 'recipe-grid'); ul.setAttribute('aria-label', title);
      for (const r of rows) {
        const li = el('li', 'recipe cg-card cg-installed');
        li.dataset.local = r.id;
        const item = r.galleryId ? find(r.galleryId) : null;
        li.append(el('h3', null, r.title), el('p', 'recipe-cost', `${r.author ? `by ${r.author.name}${r.author.github ? ` (@${r.author.github})` : ''}, self-declared · ` : ''}added ${r.addedAt ? new Date(r.addedAt).toLocaleDateString() : 'earlier'}`));
        const row = el('div', 'recipe-actions');
        if (item) row.append(btn('Details', 'small', () => openDrawer(item)));
        const rm = btn('Remove', 'small', () => remove(kind, r, rm));
        if (data?.demo) rm.disabled = true;
        row.append(rm);
        li.append(row);
        ul.append(li);
      }
      parts.push(ul);
    };
    if (!installed) parts.push(el('p', 'recipes-status', 'Looking at what is installed…'));
    else {
      if (installed.recipes.length) sect(`My recipes from the gallery (${installed.recipes.length})`, installed.recipes, 'recipe');
      if (installed.characters.length) sect(`Characters from the gallery (${installed.characters.length})`, installed.characters, 'character');
      if (!installed.recipes.length && !installed.characters.length) parts.push(el('p', 'recipes-status', 'Nothing from the gallery is installed yet. Add a recipe or a character from the other tabs and it shows up here.'));
      parts.push(el('p', 'recipe-cost cg-note', 'Widget rules you loaded and setups you applied are yours now: they live in Widget rules and on the Setups page, and are not tracked here.'));
    }
    list.replaceChildren(...parts);
  }

  function renderList() {
    if (!list) return;
    // Installed is sections of its own grids; the other tabs are one grid of cards.
    list.classList.toggle('recipe-grid', tab !== 'installed');
    list.classList.toggle('cg-installed-view', tab === 'installed');
    if (tab === 'installed') { renderInstalled(); return; }
    if (!data) { list.replaceChildren(el('li', 'recipes-status', 'Fetch the gallery to see what people shared.')); return; }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = data.items.filter((i) => i.kind === tab
      && (!stack || i.stacks.includes(stack) || i.stacks.includes('any'))
      && words.every((w) => [i.title, i.summary, i.author.name, ...i.tags].join(' ').toLowerCase().includes(w)));
    list.replaceChildren(...shown.map(card));
    if (!shown.length) list.append(el('li', 'recipes-status', 'Nothing matches. Try another search or filter.'));
  }

  function render() {
    const head = el('header', 'recipes-head');
    const title = el('div');
    title.append(el('h2', null, 'Discover'), el('p', null, 'Recipes, widget characters, widget rules and setups other people shared on plexiform.dev. Gallery recipes only read: they plan and report and never change files. Open any item to see everything it contains before it is added, and nothing runs when you add it.'));
    title.firstChild.id = 'cg-title';
    // Agents have their own page (agents-find.html); this only opens it.
    if (window.findAgentsApi) {
      const go = btn('Looking for agents for Claude Code, Codex and others? Find agents →', 'link', () => window.findAgentsApi.open());
      title.append(go);
    }
    head.append(title);
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
    const tabs = el('div', 'cg-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Discover');
    const filters = el('div', 'cg-filters');
    for (const [k, label] of TABS) {
      const c = btn(label, 'small cg-chip', () => { tab = k; for (const x of tabs.querySelectorAll('.cg-chip')) x.setAttribute('aria-pressed', String(x === c)); filters.hidden = k === 'installed'; renderList(); });
      c.setAttribute('role', 'tab');
      c.dataset.tab = k;
      c.setAttribute('aria-pressed', String(k === tab));
      tabs.append(c);
    }
    const sel = el('select', 'cg-stack'); sel.setAttribute('aria-label', 'Stack');
    for (const [v, label] of STACKS) { const o = el('option', null, label); o.value = v; sel.append(o); }
    sel.value = stack;
    sel.addEventListener('change', () => { stack = sel.value; renderList(); });
    const search = el('input', 'cg-search'); search.type = 'search'; search.placeholder = 'Search'; search.value = query; search.setAttribute('aria-label', 'Search the gallery');
    search.addEventListener('input', () => { query = search.value; renderList(); });
    filters.append(sel, search);
    filters.hidden = tab === 'installed';
    list = el('ul', 'recipe-grid cg-list'); list.setAttribute('aria-label', 'Gallery items');
    root.replaceChildren(head, where, status, tabs, filters, list);
    renderList();
  }

  async function open() {
    const c = await api.cached().catch(() => null);
    if (c && c.ok) data = c;
    render();
    await loadInstalled();
  }

  backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) { e.stopImmediatePropagation(); closeDrawer(); } }, true);
  // Shown again (the page is kept alive): what is installed may have changed elsewhere.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && installed) void loadInstalled(); });
  void open();
})();
