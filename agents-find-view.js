'use strict';
// Find agents page. Builds every node with createElement/textContent: agent
// names, descriptions and prompts are third-party text and are never parsed as
// markup. The page names only an agent id, the catalogue sha it was shown,
// platform ids and an undo id; main resolves everything else
// (src/agents-find-main.js).
(() => {
  const api = window.agentsApi;
  const Search = window.PlexiformAgentSearch;
  const Prompt = window.PlexiformPromptRender;
  const Icons = window.PlexiformAgentIcons;
  const PAGE = 60;
  const SOURCE_LABEL = { agency: 'agency-agents', voltagent: 'VoltAgent', wshobson: 'wshobson', '0xfurai': '0xfurai' };
  const PROMPT_LINES = 40;

  const $page = document.getElementById('af-page');
  const $drawer = document.getElementById('af-drawer');
  const $backdrop = document.getElementById('af-backdrop');
  const $pop = document.getElementById('af-pop');

  const state = {
    list: null, index: [], categories: {}, catalogSha: null, error: null, writes: null,
    query: '', filters: { category: '', source: '', tools: '', works: '', mine: false },
    shown: PAGE, results: [], added: new Map(), opener: null,
  };

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'hidden' || k === 'disabled' || k === 'checked') n[k] = !!v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid instanceof Node ? kid : String(kid));
    return n;
  }
  const icon = (id, cls) => Icons.element(document, id, cls);
  const sourceLabel = (s) => SOURCE_LABEL[s] || s;
  const categoryLabel = (c) => state.categories[c]?.label || c;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // ── loading ───────────────────────────────────────────────────────────────
  async function load() {
    const r = api ? await api.list().catch(() => null) : null;
    if (!r || !r.ok) { state.error = r?.error || 'Find agents could not load the catalogue.'; render(); return; }
    state.list = r;
    state.catalogSha = r.catalogSha;
    state.categories = r.categories || {};
    state.writes = r.writes || { ok: true };
    state.index = Search.buildIndex(r.agents);
    await refreshStatus();
    run();
  }

  async function refreshStatus() {
    const s = api ? await api.status().catch(() => null) : null;
    state.added = new Map();
    if (s && s.ok) for (const a of s.agents || []) state.added.set(a.agentId, a.platforms || []);
  }

  function run() {
    const f = state.filters;
    const only = f.mine ? new Set(state.added.keys()) : null;
    state.results = Search.search(state.index, state.query, { category: f.category || null, source: f.source || null, tools: f.tools || null, works: f.works || null, only });
    state.shown = PAGE;
    render();
  }

  // ── page ──────────────────────────────────────────────────────────────────
  function render() {
    $page.replaceChildren();
    $page.append(header());
    if (state.error) { $page.append(el('p', { class: 'af-empty', role: 'alert', text: state.error })); return; }
    if (!state.list) { $page.append(el('p', { class: 'af-empty', text: 'Loading agents…' })); return; }
    if (state.writes && !state.writes.ok) $page.append(el('p', { class: 'af-notice', role: 'status', text: state.writes.reason }));
    $page.append(controls(), el('p', { class: 'af-count', id: 'af-count', 'aria-live': 'polite', text: countText() }), grid());
  }

  function header() {
    const n = state.list?.count;
    const sources = (state.list?.builtFrom || []).map((s) => sourceLabel(s.source));
    const sub = state.list
      ? `${n} agents from ${sources.join(', ')}, each pinned to a fixed version. Nothing is downloaded: the list ships with Plexiform.`
      : 'Ready-made agents for Claude Code, Codex, Gemini, Copilot and OpenCode.';
    return el('header', { class: 'af-head' },
      el('div', {}, el('h1', { id: 'af-title', text: 'Find agents' }), el('p', { text: sub })),
      state.list ? el('button', { type: 'button', class: 'af-btn link', onclick: (e) => openSources(e.currentTarget), text: 'Licences and sources' }) : null);
  }

  function controls() {
    const input = el('input', { id: 'af-search', class: 'af-search', type: 'search', placeholder: 'Search agents, e.g. react, security, SEO', 'aria-label': 'Search agents', autocomplete: 'off', spellcheck: 'false', maxlength: String(Search.MAX_QUERY), value: state.query });
    input.addEventListener('input', () => { state.query = input.value; run(); focusSearch(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; state.query = ''; run(); focusSearch(); } });
    const cats = Object.keys(state.categories).sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
    const sources = (state.list.builtFrom || []).map((s) => s.source);
    const worksTools = (Array.isArray(state.list.tools) ? state.list.tools : []).filter((t) => t && typeof t.platform === 'string' && typeof t.label === 'string');
    return el('div', { class: 'af-controls', role: 'search' },
      input,
      select('af-category', 'Category', 'All categories', cats.map((c) => [c, categoryLabel(c)]), 'category'),
      select('af-source', 'Source', 'All sources', sources.map((s) => [s, sourceLabel(s)]), 'source'),
      select('af-tools', 'Tools it gets', 'Any tools', [['every', 'Every tool'], ['limited', 'Limited tools']], 'tools'),
      worksTools.length ? select('af-works', 'Works with', 'Works with any tool', worksTools.map((t) => [t.platform, `Works with ${t.label}`]), 'works') : null,
      el('button', { type: 'button', class: 'af-chip', 'aria-pressed': String(state.filters.mine), onclick: () => { state.filters.mine = !state.filters.mine; run(); }, text: 'Added by me' }));
  }

  function select(id, label, any, options, key) {
    const s = el('select', { id, class: 'af-select', 'aria-label': label },
      el('option', { value: '', text: any }), options.map(([v, t]) => el('option', { value: v, text: t })));
    s.value = state.filters[key];
    s.addEventListener('change', () => { state.filters[key] = s.value; run(); document.getElementById(id)?.focus(); });
    return s;
  }

  function focusSearch() {
    const i = document.getElementById('af-search');
    if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }

  function countText() {
    const n = state.results.length;
    if (!n) return 'No agents match.';
    return state.query || Object.values(state.filters).some(Boolean) ? `${plural(n, 'agent')} match.` : `${plural(n, 'agent')}.`;
  }

  function grid() {
    if (!state.results.length) {
      return el('div', { class: 'af-empty' },
        el('p', { text: state.filters.mine && !state.added.size ? 'You haven\'t added any agents yet.' : 'No agents match. Try "react", "security" or a category.' }),
        el('button', { type: 'button', class: 'af-btn', onclick: () => { state.query = ''; state.filters = { category: '', source: '', tools: '', works: '', mine: false }; run(); focusSearch(); }, text: 'Clear search' }));
    }
    const list = el('ul', { class: 'af-grid', id: 'af-grid', 'aria-label': 'Agents' });
    for (const a of state.results.slice(0, state.shown)) list.append(card(a));
    list.addEventListener('keydown', gridKeys);
    const wrap = el('div', {}, list);
    if (state.shown < state.results.length) {
      const more = el('button', { type: 'button', class: 'af-btn af-more', text: `Show more (${state.results.length - state.shown} left)` });
      more.addEventListener('click', () => showMore(true));
      wrap.append(more);
      if ('IntersectionObserver' in window) new IntersectionObserver((es, o) => { if (es.some((x) => x.isIntersecting)) { o.disconnect(); showMore(false); } }, { rootMargin: '400px' }).observe(more);
    }
    return wrap;
  }

  function showMore(keyboard) {
    const first = state.shown;
    state.shown += PAGE;
    const g = document.getElementById('af-grid');
    const old = g?.parentElement;
    if (!old) return;
    old.replaceWith(grid());
    if (keyboard) document.querySelectorAll('.af-card-open')[first]?.focus();
  }

  function card(a) {
    const added = state.added.get(a.id) || [];
    const tile = el('span', { class: `af-tile cat-${a.category}` }, icon(a.icon));
    const open = el('button', { type: 'button', class: 'af-card-open', 'aria-label': `${a.name}, ${categoryLabel(a.category)}`, onclick: (e) => openDetail(a, e.currentTarget) },
      el('span', { class: 'af-card-top' }, tile, el('span', { class: 'af-card-name' }, el('strong', { text: a.name }), el('span', { class: 'af-muted', text: categoryLabel(a.category) }))),
      sameText(a.oneLiner, a.bestWhen) ? null : el('span', { class: 'af-card-what', text: a.oneLiner || a.description || '' }),
      el('span', { class: 'af-card-when' }, el('span', { class: 'af-label', text: 'Best used when: ' }), a.bestWhen || '(not stated by author)'),
      el('span', { class: 'af-tags' },
        el('span', { class: a.everyTool ? 'af-tag warn' : 'af-tag', text: a.everyTool ? 'Every tool' : 'Limited tools' }),
        a.flagCount ? el('span', { class: 'af-tag warn', text: 'Review' }) : null,
        el('span', { class: 'af-tag', text: `${sourceLabel(a.source)} · ${a.license}` })));
    const plus = added.length
      ? el('button', { type: 'button', class: 'af-plus done', 'aria-label': `${a.name} is added to ${plural(added.length, 'tool')}. Add to more`, onclick: (e) => openConfirm(a, e.currentTarget) }, `Added to ${added.length} ✓`)
      : el('button', { type: 'button', class: 'af-plus', 'aria-label': `Add ${a.name} to your AI tools`, disabled: state.writes && !state.writes.ok, title: state.writes && !state.writes.ok ? state.writes.reason : null, onclick: (e) => openConfirm(a, e.currentTarget) }, '+');
    return el('li', { class: 'af-card' }, open, plus);
  }

  // Many authors' one-liner *is* their "Use when…" line; show it once.
  function sameText(a, b) {
    const n = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const x = n(a), y = n(b);
    return !!x && !!y && (x.startsWith(y.slice(0, 60)) || y.startsWith(x.slice(0, 60)));
  }

  function gridKeys(e) {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const cards = [...document.querySelectorAll('.af-card-open')];
    const i = cards.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = Math.max(1, Math.round(document.getElementById('af-grid').clientWidth / cards[0].parentElement.offsetWidth));
    const j = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: cards.length - 1 }[e.key];
    if (j >= 0 && j < cards.length) { e.preventDefault(); cards[j].focus(); }
  }

  // ── detail sheet ──────────────────────────────────────────────────────────
  async function openDetail(a, opener) {
    state.opener = opener;
    const [d, t] = await Promise.all([api.detail(a.id).catch(() => null), api.targets(a.id).catch(() => null)]);
    if (!d || !d.ok) return showDrawer(el('p', { role: 'alert', text: d?.error || 'This agent could not be opened.' }), a.name);
    const body = el('div', { class: 'af-detail' },
      el('div', { class: 'af-drawer-head' },
        el('span', { class: `af-tile big cat-${d.agent.category}` }, icon(d.agent.icon)),
        el('div', {}, el('h2', { id: 'af-drawer-title', text: d.agent.name }), el('p', { class: 'af-muted', text: `${categoryLabel(d.agent.category)} · ${sourceLabel(d.agent.source)} · ${d.agent.license}` })),
        closeButton()),
      el('p', { class: 'af-summary', text: d.agent.description || d.agent.oneLiner || '' }),
      el('p', {}, el('span', { class: 'af-label', text: 'Best used when: ' }), d.agent.bestWhen || '(not stated by author)'),
      el('h3', { class: 'af-sub', text: 'What it will be able to do' }),
      el('p', { class: d.agent.everyTool ? 'af-warn' : null, text: d.agent.toolsSummary }),
      d.agent.model ? el('p', { class: 'af-muted', text: `Asks for the model: ${d.agent.model}` }) : null,
      flags(d.flags),
      el('h3', { class: 'af-sub', text: 'Where it will go' }),
      targetsList(t),
      el('p', { class: 'af-safety', text: 'This is a third-party prompt. It runs with your AI tool\'s permissions. Read it before adding.' }),
      actions(d.agent, t),
      el('h3', { class: 'af-sub', text: 'The full prompt' }),
      prompt(d.body),
      el('dl', { class: 'af-facts' },
        el('dt', { text: 'Source' }), el('dd', { text: d.upstream }),
        el('dt', { text: 'File' }), el('dd', { text: d.sourcePath }),
        el('dt', { text: 'Commit' }), el('dd', { text: d.sourceSha }),
        el('dt', { text: 'Credit' }), el('dd', { text: d.attribution }),
        d.alsoIn?.length ? [el('dt', { text: 'Also in' }), el('dd', { text: d.alsoIn.map(sourceLabel).join(', ') })] : null));
    showDrawer(body);
  }

  function flags(list) {
    const shown = (list || []).filter((f) => f.rule !== 'all-tools');
    if (!shown.length) return null;
    return el('div', { class: 'af-flags' },
      el('h3', { class: 'af-sub', text: 'Worth a look before adding' }),
      el('ul', {}, shown.map((f) => el('li', {}, el('span', { text: f.why }), f.line ? el('span', { class: 'af-muted', text: ` Line ${f.line}:` }) : null, f.excerpt ? [' ', el('code', { text: f.excerpt })] : null))));
  }

  function targetsList(t) {
    if (!t || !t.ok) return el('p', { class: 'af-muted', text: t?.error || 'Plexiform could not check your AI tools.' });
    if (!t.platforms.length) return el('p', { class: 'af-muted', text: 'No AI tools found on this computer yet.' });
    return el('ul', { class: 'af-where' }, t.platforms.map((p) => el('li', {},
      el('strong', { text: p.label }), ' ',
      p.path ? el('code', { text: p.path }) : null,
      el('span', { class: 'af-muted', text: ` ${whereText(p)}` }))));
  }

  function whereText(p) {
    if (p.choice === 'disabled' || p.choice === 'unsupported' || p.choice === 'project-only') return p.reason || 'Not supported.';
    const s = { new: 'Will be added.', ours: 'Added by Plexiform.', update: 'Added by Plexiform; a newer version is available.', missing: 'Added by Plexiform, then removed outside it.', 'already-there': p.reason, 'user-file': p.reason, 'other-agent': p.reason, modified: p.reason, refused: p.reason, unmappable: p.reason }[p.status];
    return [p.choice === 'offered' ? 'Found but not connected to Plexiform.' : null, s].filter(Boolean).join(' ');
  }

  function actions(agent, t) {
    const blocked = state.writes && !state.writes.ok;
    const n = t?.ok ? t.platforms.filter((p) => p.choice === 'default' && p.status === 'new').length : 0;
    const cursor = t?.ok && t.platforms.some((p) => p.platform === 'cursor' && p.choice === 'project-only' && p.projectEnabled);
    return el('div', { class: 'af-actions' },
      el('button', { type: 'button', class: 'af-btn primary', disabled: blocked, title: blocked ? state.writes.reason : null, onclick: (e) => openConfirm(agent, e.currentTarget), text: n ? `+ Add to ${plural(n, 'tool')}` : '+ Add…' }),
      cursor ? el('button', { type: 'button', class: 'af-btn', disabled: blocked, onclick: (e) => addToProject(agent, e.currentTarget), text: 'Add to a Cursor project…' }) : null);
  }

  function prompt(text) {
    const blocks = Prompt.render(text);
    const view = el('div', { class: 'af-prompt collapsed' }, blocks.map(block));
    const raw = el('pre', { class: 'af-raw', hidden: true, text });
    const lines = String(text).split('\n').length;
    const more = lines > PROMPT_LINES ? el('button', { type: 'button', class: 'af-btn link', 'aria-expanded': 'false', text: 'Show all' }) : null;
    if (more) more.addEventListener('click', () => { const open = view.classList.toggle('collapsed') === false; more.textContent = open ? 'Show less' : 'Show all'; more.setAttribute('aria-expanded', String(open)); });
    else view.classList.remove('collapsed');
    const toggle = el('button', { type: 'button', class: 'af-btn link', 'aria-pressed': 'false', text: 'View raw' });
    toggle.addEventListener('click', () => { const on = raw.hidden; raw.hidden = !on; view.hidden = on; if (more) more.hidden = on; toggle.setAttribute('aria-pressed', String(on)); toggle.textContent = on ? 'View formatted' : 'View raw'; });
    return el('div', {}, view, raw, el('div', { class: 'af-prompt-tools' }, more, toggle));
  }

  function runs(rs) { return rs.map((r) => (r.kind === 'code' ? el('code', { text: r.text }) : r.kind === 'strong' ? el('strong', { text: r.text }) : document.createTextNode(r.text))); }
  function block(b) {
    if (b.type === 'heading') return el(`h${Math.min(6, b.level + 3)}`, { class: 'af-ph' }, runs(b.runs));
    if (b.type === 'para') return el('p', {}, runs(b.runs));
    if (b.type === 'quote') return el('blockquote', {}, runs(b.runs));
    if (b.type === 'rule') return el('hr');
    if (b.type === 'code') return el('pre', { class: 'af-code', text: b.text });
    if (b.type === 'list') return el(b.ordered ? 'ol' : 'ul', {}, b.items.map((it) => el('li', {}, runs(it))));
    return null;
  }

  function closeButton() { return el('button', { type: 'button', class: 'af-btn', 'aria-label': 'Close', onclick: closeDrawer, text: 'Close' }); }

  function showDrawer(content, title) {
    $drawer.replaceChildren(...[title ? el('div', { class: 'af-drawer-head' }, el('h2', { id: 'af-drawer-title', text: title }), closeButton()) : null, content].filter(Boolean));
    $drawer.hidden = false;
    $backdrop.hidden = false;
    $drawer.querySelector('button')?.focus();
  }

  function closeDrawer() {
    $drawer.hidden = true;
    $backdrop.hidden = true;
    $drawer.replaceChildren();
    state.opener?.isConnected && state.opener.focus();
  }

  function openSources(opener) {
    state.opener = opener;
    const rows = state.list.builtFrom.map((s) => el('li', {},
      el('strong', { text: s.name }), el('br'),
      el('span', { class: 'af-muted', text: `${s.license} · ${s.copyright}` }), el('br'),
      el('code', { text: `${s.url} @ ${s.sha.slice(0, 12)}` })));
    showDrawer(el('div', {},
      el('p', { text: 'Every agent here is someone else\'s work, shared under an open licence. Plexiform ships a fixed copy, checked when it was built, and shows each agent\'s source and licence.' }),
      el('ul', { class: 'af-where' }, rows),
      el('p', { class: 'af-muted', text: 'Full licence texts are in THIRD_PARTY_NOTICES.md, which ships with the app.' })), 'Licences and sources');
  }

  // ── + confirm → add → result with Undo ─────────────────────────────────
  async function openConfirm(a, opener) {
    if (state.writes && !state.writes.ok) return;
    state.popOpener = opener;
    const t = await api.targets(a.id).catch(() => null);
    if (!t || !t.ok) return showPop(a, el('p', { role: 'alert', text: t?.error || 'Plexiform could not check your AI tools.' }), [el('button', { type: 'button', class: 'af-btn', onclick: closePop, text: 'Close' })]);
    const pickable = t.platforms.filter((p) => p.choice === 'default' || p.choice === 'offered');
    if (!pickable.length) {
      return showPop(a, el('p', { text: 'Connect an AI tool first. Plexiform adds agents to the tools it is connected to.' }), [
        el('button', { type: 'button', class: 'af-btn', onclick: closePop, text: 'Not now' }),
        el('button', { type: 'button', class: 'af-btn primary', 'data-confirm': '', onclick: () => { closePop(); api.openTools(); }, text: 'Open AI tools' })]);
    }
    const rows = t.platforms.map((p) => platformRow(p));
    const confirm = el('button', { type: 'button', class: 'af-btn primary', 'data-confirm': '' });
    const sync = () => {
      const picked = selected();
      confirm.textContent = picked.length ? `Add to ${plural(picked.length, 'tool')}` : 'Add';
      confirm.disabled = !picked.length;
    };
    const selected = () => [...$pop.querySelectorAll('input[data-platform]:checked')].map((i) => (i.dataset.alt === '1' ? { platform: i.dataset.platform, alt: true } : i.dataset.platform));
    confirm.addEventListener('click', () => doAdd(a, t.catalogSha, selected(), confirm));
    showPop(a, el('div', {},
      el('p', { class: t.everyTool ? 'af-warn' : null, text: t.everyTool ? 'It gets every tool your AI tool has. The author didn\'t limit it.' : `It gets: ${t.toolsSummary}` }),
      t.flagCount ? el('p', { class: 'af-muted', text: `${plural(t.flagCount, 'thing')} worth a look before adding. Open the agent to see ${t.flagCount === 1 ? 'it' : 'them'}.` }) : null,
      el('ul', { class: 'af-pick' }, rows)), [el('button', { type: 'button', class: 'af-btn', onclick: closePop, text: 'Cancel' }), confirm]);
    $pop.addEventListener('change', sync);
    sync();
    confirm.focus();
  }

  function platformRow(p) {
    const can = (p.choice === 'default' || p.choice === 'offered') && p.status === 'new';
    const alt = (p.choice === 'default' || p.choice === 'offered') && p.canAlt;
    const id = `af-p-${p.platform}`;
    const box = el('input', { type: 'checkbox', id, 'data-platform': p.platform, checked: can && p.choice === 'default', disabled: !can });
    const li = el('li', { class: can ? null : 'off' }, box, el('label', { for: id }, el('strong', { text: p.label }), el('span', { class: 'af-muted', text: ` ${can ? (p.choice === 'offered' ? 'Found but not connected to Plexiform.' : p.path) : whereText(p)}` })));
    if (alt) {
      const aid = `af-p-${p.platform}-alt`;
      li.append(el('div', { class: 'af-alt' }, el('input', { type: 'checkbox', id: aid, 'data-platform': p.platform, 'data-alt': '1' }), el('label', { for: aid, text: `Add as ${p.altName} instead` })));
    }
    return li;
  }

  function showPop(a, content, buttons) {
    $pop.replaceChildren(
      el('h2', { id: 'af-pop-title', text: `Add ${a.name}?` }),
      content,
      el('div', { class: 'af-pop-actions' }, buttons));
    $pop.hidden = false;
    $backdrop.hidden = false;
    $pop.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePop(); }
      // Enter confirms from anywhere in the popover, including a tick box.
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { const c = $pop.querySelector('[data-confirm]'); if (c && !c.disabled) { e.preventDefault(); c.click(); } }
      if (e.key === 'Tab') trap(e, $pop);
    };
    ($pop.querySelector('[data-confirm]') || $pop.querySelector('button'))?.focus();
  }

  function closePop() {
    $pop.hidden = true;
    if ($drawer.hidden) $backdrop.hidden = true;
    $pop.replaceChildren();
    $pop.onkeydown = null;
    state.popOpener?.isConnected && state.popOpener.focus();
  }

  function trap(e, root) {
    const f = [...root.querySelectorAll('button, input')].filter((x) => !x.disabled && !x.hidden);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }

  const OUTCOME = { added: 'Added', 'already-there': 'Already there', 'already-added': 'Already added', 'update-available': 'Already added (newer version available)', skipped: 'Skipped', failed: 'Failed', 'rolled-back': 'Not added', 'not-tried': 'Not added' };
  async function doAdd(a, catalogSha, platforms, btn) {
    btn.disabled = true;
    btn.textContent = 'Adding…';
    const r = await api.add(a.id, catalogSha, platforms).catch(() => null);
    if (!r || !r.ok && !r.results) return result(a, el('p', { role: 'alert', text: r?.error || 'Nothing was added.' }), null);
    await refreshStatus();
    const list = el('ul', { class: 'af-result' }, r.results.map((x) => el('li', { class: `st-${x.status}` },
      el('strong', { text: `${OUTCOME[x.status] || x.status}: ` }), x.label, x.path ? [' ', el('code', { text: x.path })] : null, x.reason ? el('span', { class: 'af-muted', text: ` ${x.reason}` }) : null)));
    result(a, list, r.opId && r.results.some((x) => x.status === 'added') ? r.opId : null);
    rerenderCard(a);
  }

  function result(a, content, opId) {
    const done = el('button', { type: 'button', class: 'af-btn primary', 'data-confirm': '', onclick: closePop, text: 'Done' });
    const undo = opId ? el('button', { type: 'button', class: 'af-btn', text: 'Undo' }) : null;
    if (undo) undo.addEventListener('click', async () => {
      undo.disabled = true;
      const u = await api.undo(opId).catch(() => null);
      await refreshStatus();
      rerenderCard(a);
      const left = u?.conflicts?.length ? el('ul', {}, u.conflicts.map((c) => el('li', {}, el('code', { text: c.path }), ` ${c.reason || 'was changed, so Plexiform left it.'}`))) : null;
      $pop.querySelector('.af-pop-body')?.replaceChildren(...[el('p', { role: 'status', text: u?.ok ? 'Undone. The files Plexiform added are gone.' : u?.error || 'Undo didn\'t work.' }), left].filter(Boolean));
      undo.remove();
      done.focus();
    });
    $pop.replaceChildren(
      el('h2', { id: 'af-pop-title', text: a.name }),
      el('div', { class: 'af-pop-body', role: 'status' }, content),
      el('div', { class: 'af-pop-actions' }, undo, done));
    done.focus();
  }

  function rerenderCard(a) {
    const btn = [...document.querySelectorAll('.af-card-open')].find((b) => b.getAttribute('aria-label').startsWith(`${a.name}, `));
    const li = btn?.closest('.af-card');
    if (li) li.replaceWith(card(a));
  }

  async function addToProject(a, btn) {
    btn.disabled = true;
    const r = await api.addToProject(a.id, state.catalogSha).catch(() => null);
    btn.disabled = false;
    if (r?.code === 'cancelled') return;
    state.popOpener = btn;
    const text = !r?.ok ? r?.error || 'Nothing was added.' : r.status === 'added' ? `Added to the project: ${r.path}` : `${OUTCOME[r.status] || 'Skipped'}: ${r.path}${r.reason ? `. ${r.reason}` : ''}`;
    showPop(a, el('p', { role: 'status', text }), [el('button', { type: 'button', class: 'af-btn primary', 'data-confirm': '', onclick: closePop, text: 'Done' })]);
    if (r?.ok && r.opId) {
      const undo = el('button', { type: 'button', class: 'af-btn', text: 'Undo' });
      undo.addEventListener('click', async () => {
        undo.disabled = true;
        const u = await api.undoProject(r.opId).catch(() => null);
        $pop.querySelector('p').textContent = u?.ok ? (u.conflicts.length ? `Kept ${u.conflicts[0].path}: ${u.conflicts[0].reason}` : 'Undone. The rule Plexiform added is gone.') : u?.error || 'Undo didn\'t work.';
        undo.remove();
        $pop.querySelector('[data-confirm]')?.focus();
      });
      $pop.querySelector('.af-pop-actions').prepend(undo);
    }
  }

  // ── keys ──────────────────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (!$pop.hidden) return;
    if (!$drawer.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); }
      else if (e.key === 'Tab') trap(e, $drawer);
      return;
    }
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); focusSearch(); }
  });
  $backdrop.addEventListener('click', () => (!$pop.hidden ? closePop() : closeDrawer()));

  render();
  void load().then(() => focusSearch());
})();
