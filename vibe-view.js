'use strict';
// The Discover page's vibe-coder loop (src/build-log-main.js decides
// everything): a unified catalogue (Starters / Skills / MCP servers), a build
// log made from your sessions with a mandatory item-by-item review before
// Export or Publish, your published logs with Unpublish, and "Start from this"
// for a pasted build log link. Text is only ever textContent; the page sends
// main session keys, item ids, its edits and the digest it was shown.
(() => {
  const api = window.vibeApi;
  if (!api) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (label, cls, on) => { const b = el('button', `btn ${cls || ''}`.trim(), label); b.type = 'button'; b.addEventListener('click', (e) => { e.preventDefault(); on(b); }); return b; };
  const gallery = document.getElementById('cg-gallery');
  const nav = el('nav', 'vb-nav'); nav.setAttribute('aria-label', 'Discover');
  const panel = el('main', 'vb-panel'); panel.id = 'vb-panel'; panel.hidden = true;
  document.body.insertBefore(nav, document.body.firstChild);
  gallery.after(panel);
  const VIEWS = [['catalogue', 'Catalogue'], ['gallery', 'Gallery'], ['buildlog', 'Build log'], ['remix', 'Start from a link']];
  let view = 'gallery', sub = 'starters', team = null, review = null;
  const status = el('p', 'vb-status'); status.setAttribute('role', 'status');
  const say = (t) => { status.textContent = t || ''; };

  function show(v) {
    view = v;
    for (const b of nav.children) b.setAttribute('aria-pressed', String(b.dataset.view === v));
    gallery.hidden = v !== 'gallery';
    panel.hidden = v === 'gallery';
    panel.replaceChildren();
    say('');
    if (v === 'catalogue') catalogue();
    if (v === 'buildlog') buildLog();
    if (v === 'remix') remix();
  }
  for (const [id, label] of VIEWS) { const b = btn(label, 'vb-tab', () => show(id)); b.dataset.view = id; nav.append(b); }

  const list = (lines) => { const u = el('ul', 'vb-list'); for (const l of lines) u.append(el('li', null, l)); return u; };

  async function catalogue() {
    panel.append(el('h1', 'vb-h', 'Discover'), el('p', 'muted', 'Starters, skills and MCP servers from the community gallery and your team. Every install shows what it does first, on the consent sheet.'));
    const tabs = el('div', 'vb-subtabs');
    const body = el('div', 'vb-cards');
    panel.append(tabs, status, body);
    const r = await api.catalog(team).catch(() => null);
    if (!r || !r.ok) { say('The catalogue could not be shown.'); return; }
    if (!r.fetched) say('Fetch the gallery on the Gallery tab first to fill this catalogue.');
    const draw = () => {
      tabs.replaceChildren(...r.tabs.map((t) => { const b = btn(`${t.label} (${t.items.length})`, 'cg-chip', () => { sub = t.id; draw(); }); b.setAttribute('aria-pressed', String(sub === t.id)); return b; }));
      const t = r.tabs.find((x) => x.id === sub) || r.tabs[0];
      body.replaceChildren(...(t.items.length ? t.items.map(card) : [el('p', 'muted', 'Nothing here yet.')]));
    };
    draw();
  }
  function card(item) {
    const c = el('article', 'vb-card');
    c.append(el('h3', null, item.title), el('p', null, item.what || ''));
    const dl = el('dl', 'vb-facts');
    for (const [k, v] of [['Cost to run', item.cost], ['Made by', item.author], ['Used', item.used]]) dl.append(el('dt', null, k), el('dd', null, v));
    c.append(dl, el('p', 'vb-label', 'What it may do'), list(item.permissions));
    const row = el('div', 'vb-row');
    if (item.source === 'gallery' && item.install) row.append(btn('Install…', 'primary', async (b) => { b.disabled = true; const r = await api.install(item.id, item.sha256, item.install).catch(() => null); b.disabled = false; say(r?.ok ? 'Installed.' : r?.error || 'Not installed.'); }));
    if (item.source === 'gallery') row.append(btn('Report…', 'ghost', async () => { const r = await api.report(item.id).catch(() => null); if (r && !r.ok && r.error) say(r.error); }));
    if (item.source === 'build-log' && item.link) row.append(btn('Remix…', 'primary', () => { show('remix'); const i = panel.querySelector('input.vb-link'); if (i) i.value = item.link; }));
    c.append(row);
    return c;
  }

  async function buildLog() {
    panel.append(el('h1', 'vb-h', 'Build log'), el('p', 'muted', 'Turn sessions into a build log. You review every item before it is saved or shared; secrets and your home folder are removed, and nothing leaves this computer until you press Publish.'), status);
    const r = await api.sessions().catch(() => null);
    const pick = el('fieldset', 'vb-pick'); pick.append(el('legend', null, 'Sessions'));
    for (const s of r?.sessions || []) { const l = el('label', 'vb-check'); const cb = el('input'); cb.type = 'checkbox'; cb.value = s.key; l.append(cb, document.createTextNode(` ${s.label}`)); pick.append(l); }
    if (!r?.sessions?.length) pick.append(el('p', 'muted', 'No sessions are listed on this computer yet.'));
    const kitL = el('label', 'vb-check'); const kit = el('input'); kit.type = 'checkbox'; kitL.append(kit, document.createTextNode(' Include a starter kit from the project (CLAUDE.md, skills, MCP servers)'));
    panel.append(pick, kitL, el('div', 'vb-row'));
    panel.lastChild.append(btn('Make a draft', 'primary', async () => {
      const keys = [...pick.querySelectorAll('input:checked')].map((x) => x.value);
      const d = await api.draft(keys, { kit: kit.checked }).catch(() => null);
      if (!d?.ok) { say(d?.error || 'No draft was made.'); return; }
      reviewScreen(d);
    }));
    published();
  }

  function reviewScreen(d) {
    review = d;
    let box = panel.querySelector('.vb-review');
    if (box) box.remove();
    box = el('section', 'vb-review'); box.setAttribute('aria-label', 'Review before sharing');
    box.append(el('h2', null, 'Review before sharing'), el('p', 'muted', 'Untick anything you do not want to share, and edit any text. The preview below is exactly what Export and Publish use.'));
    const fields = {};
    for (const [k, label] of [['title', 'Title'], ['summary', 'Summary'], ['deployed_url', 'Deployed link (https)'], ['before', 'Before'], ['after', 'After'], ['repo', 'Template repository (https)']]) {
      const l = el('label', 'vb-field', label); const i = el(k === 'summary' || k === 'before' || k === 'after' ? 'textarea' : 'input'); i.value = d.fields[k] || ''; fields[k] = i; l.append(i); box.append(l);
    }
    const sections = { timeline: 'Timeline', prompts: 'Prompts', files: 'Files changed', kit: 'Starter kit' };
    const rows = [];
    for (const [sec, label] of Object.entries(sections)) {
      const its = d.items.filter((i) => i.section === sec);
      if (!its.length) continue;
      const fs = el('fieldset', 'vb-items'); fs.append(el('legend', null, `${label} (${its.length})`));
      for (const it of its) {
        const row = el('div', 'vb-item');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = it.include; cb.setAttribute('aria-label', `Share this ${label.toLowerCase()} item`);
        row.append(cb);
        let ta = null;
        if (sec === 'files') row.append(el('code', null, `${it.path} · ${it.edits} edits`));
        else if (sec === 'kit' && it.part === 'mcp') row.append(el('code', null, `MCP ${it.name}: ${it.command ? [it.command, ...(it.args || [])].join(' ') : it.url}`));
        else { if (sec === 'kit') row.append(el('span', 'vb-label', it.part === 'skill' ? `Skill ${it.name}` : 'CLAUDE.md')); ta = el('textarea'); ta.value = it.text; ta.rows = sec === 'timeline' ? 1 : 3; row.append(ta); }
        rows.push({ id: it.id, cb, ta });
        fs.append(row);
      }
      box.append(fs);
    }
    const preview = el('div', 'vb-preview');
    const problems = el('p', 'vb-problem'); problems.setAttribute('role', 'alert');
    const teamSel = el('select', 'vb-team'); teamSel.setAttribute('aria-label', 'Team to publish to');
    const actions = el('div', 'vb-row');
    const collect = () => ({ fields: Object.fromEntries(Object.entries(fields).map(([k, i]) => [k, i.value])), items: rows.map((r) => ({ id: r.id, include: r.cb.checked, ...(r.ta ? { text: r.ta.value } : {}) })) });
    const drawPreview = (v) => {
      review = v;
      const f = v.final;
      preview.replaceChildren(el('h3', null, `Preview: ${f.title}`), list([`${f.timeline.length} timeline entries`, `${f.prompts.length} prompts`, `${f.files.length} files`, f.cost_usd != null ? `About $${f.cost_usd.toFixed(2)} in AI usage` : 'Cost not known', f.deployed_url ? `Live at ${f.deployed_url}` : 'No deployed link', ...(f.kit ? f.kit.permissions.map((p) => `Kit: ${p}`) : [])]));
      problems.textContent = v.problems.join(' ');
    };
    actions.append(
      btn('Update preview', '', async () => { const v = await api.review(collect()).catch(() => null); if (v?.ok) drawPreview(v); }),
      btn('Add a starter kit from a folder…', 'ghost', async () => { await api.review(collect()); const v = await api.kitFromFolder().catch(() => null); if (v?.ok) reviewScreen(v); else if (v?.error) say(v.error); }),
      btn('Export HTML…', '', async () => { const v = await api.review(collect()); drawPreview(v); const r = await api.exportHtml(v.digest).catch(() => null); say(r?.ok ? `Saved ${r.name}.` : r?.error || ''); }),
      teamSel,
      btn('Publish…', 'primary', async (b) => {
        const v = await api.review(collect()); drawPreview(v);
        if (!teamSel.value) { say('Choose a team first.'); return; }
        b.disabled = true; const r = await api.publish(v.digest, teamSel.value).catch(() => null); b.disabled = false;
        say(r?.ok ? `Published. Anyone with this link can read it: ${r.url}` : r?.error || 'Not published.');
        if (r?.ok) { team = teamSel.value; published(); }
      }),
    );
    box.append(preview, problems, actions);
    panel.insertBefore(box, panel.querySelector('.vb-published'));
    drawPreview(d);
    api.teams().then((t) => { teamSel.replaceChildren(el('option', null, t?.ok ? 'Choose a team' : 'Sign in to a team hub to publish')); teamSel.firstChild.value = ''; for (const x of t?.teams || []) { const o = el('option', null, x.name); o.value = x.id; teamSel.append(o); } if (team) teamSel.value = team; }).catch(() => {});
  }

  async function published() {
    let box = panel.querySelector('.vb-published');
    if (!box) { box = el('section', 'vb-published'); panel.append(box); }
    box.replaceChildren(el('h2', null, 'Published build logs'));
    if (!team) { box.append(el('p', 'muted', 'Publish a log (or choose a team when publishing) to see your team’s published logs here.')); return; }
    const r = await api.published(team).catch(() => null);
    if (!r?.ok) { box.append(el('p', 'muted', r?.error || 'Could not load them.')); return; }
    if (!r.logs.length) box.append(el('p', 'muted', 'None yet.'));
    for (const l of r.logs) {
      const row = el('div', 'vb-row');
      row.append(el('span', null, `${l.title} · ${l.remix_count} remix${l.remix_count === 1 ? '' : 'es'}${l.hidden ? ' · hidden after reports' : ''}`), el('code', null, l.url), btn('Unpublish…', 'ghost', async () => { const u = await api.unpublish(team, l.id).catch(() => null); if (u?.ok) published(); else if (u?.error) say(u.error); }));
      box.append(row);
    }
  }

  function remix() {
    panel.append(el('h1', 'vb-h', 'Start from this'), el('p', 'muted', 'Paste a build log link to see its starter kit. Nothing is installed until you confirm on the consent sheet and choose a folder; existing files are never overwritten.'), status);
    const input = el('input', 'vb-link'); input.type = 'url'; input.placeholder = 'https://…/b/…'; input.setAttribute('aria-label', 'Build log link');
    const out = el('div', 'vb-kit');
    const row = el('div', 'vb-row');
    panel.append(input, row, out);
    row.append(
      btn('Preview', 'primary', async () => {
        const r = await api.remixPreview(input.value).catch(() => null);
        out.replaceChildren();
        if (!r?.ok) { say(r?.error || 'Could not open that link.'); return; }
        say('');
        out.append(el('h2', null, r.title), el('p', 'muted', `By ${r.author} (self-declared) · ${r.remix_count} remix${r.remix_count === 1 ? '' : 'es'}`), el('p', 'vb-label', 'Installing it'), list(r.permissions));
        for (const s of r.kit.skills) { const d = el('details'); d.append(el('summary', null, `Skill ${s.name}`), el('pre', null, s.content)); out.append(d); }
        if (r.kit.claude_md) { const d = el('details'); d.append(el('summary', null, 'CLAUDE.md'), el('pre', null, r.kit.claude_md)); out.append(d); }
        out.append(btn('Install…', 'primary', async () => { const i = await api.remixInstall().catch(() => null); say(i?.ok ? `Installed ${i.written.length} file${i.written.length === 1 ? '' : 's'}${i.skipped.length ? `; left ${i.skipped.join(', ')} as they were` : ''}.` : i?.error || 'Not installed.'); }));
      }),
      btn('Report…', 'ghost', async () => { const r = await api.reportLink(input.value, 'Reported from Plexiform').catch(() => null); say(r?.ok ? 'Reported. Thank you.' : r?.error || ''); }),
    );
  }

  show('gallery');
})();
