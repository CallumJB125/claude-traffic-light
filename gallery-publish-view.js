// "Share to gallery…" dialog, used by the Tasks page (a recipe of mine), Widget
// configuration (a preset or the current rules) and Hatch (a saved character).
// Main builds and checks the item (src/gallery-publish.js); this only shows
// the form, the exact JSON that would be published and the validator's
// answer, then asks main to open the pull request page or copy the JSON by
// token. Everything here is textContent; nothing from main is treated as HTML.
(() => {
  const api = window.galleryPublishApi;
  if (!api) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const field = (label, input, hint) => { const w = el('label', 'gp-field'); w.append(el('span', 'gp-label', label), input); if (hint) w.append(el('small', 'gp-hint', hint)); return w; };
  const KIND_NOUN = { recipe: 'recipe', character: 'character', rules: 'widget rules' };
  let dialog = null;

  // kind: recipe | character | rules; ref: what main needs to find it (an id, { preset } or { rules }).
  async function open({ kind, ref, onDone }) {
    const b = await api.begin(kind, ref).catch(() => null);
    if (!b || !b.ok) { if (onDone) onDone({ error: (b && b.error) || 'That cannot be shared right now.' }); return; }
    close();
    dialog = el('dialog', 'gp-dialog');
    dialog.setAttribute('aria-label', 'Share to the gallery');
    const form = el('form', 'gp-form');
    form.method = 'dialog';
    const h = el('h2', null, `Share ${KIND_NOUN[kind] || 'this'} to the gallery`);
    const intro = el('p', 'gp-intro', 'Anyone can add what you share, and the owner reads every item before it is listed. Nothing is sent until you open the pull request page in your browser, signed in as yourself.');
    const title = el('input'); title.type = 'text'; title.maxLength = 80; title.value = b.defaults.title || ''; title.required = true;
    const summary = el('input'); summary.type = 'text'; summary.maxLength = 300; summary.value = b.defaults.summary || ''; summary.required = true;
    const tags = el('input'); tags.type = 'text'; tags.value = (b.defaults.tags || []).join(', ');
    const stacks = el('select'); stacks.multiple = true; stacks.size = 4;
    for (const s of b.stacks) { const o = el('option', null, s); o.value = s; o.selected = (b.defaults.stacks || ['any']).includes(s); stacks.append(o); }
    const name = el('input'); name.type = 'text'; name.maxLength = 60; name.value = b.defaults.authorName || ''; name.required = true;
    const github = el('input'); github.type = 'text'; github.maxLength = 39; github.value = b.defaults.authorGithub || ''; github.placeholder = 'optional';
    const license = el('select');
    for (const l of b.licenses) { const o = el('option', null, l === 'CC0-1.0' ? 'CC0-1.0 (public domain, the default)' : l); o.value = l; o.selected = l === b.defaults.license; license.append(o); }
    const grid = el('div', 'gp-grid');
    grid.append(field('Title', title), field('One-line summary', summary), field('Tags', tags, 'lowercase words, separated by commas'), field('Stacks', stacks, 'hold ⌘ to pick several'), field('Your name', name, 'shown with the item'), field('GitHub handle', github, 'shown as self-declared; not checked'), field('License', license));
    const check = el('p', 'gp-check'); check.setAttribute('role', 'status'); check.setAttribute('aria-live', 'polite');
    const problems = el('ul', 'gp-problems');
    const preview = el('details', 'gp-preview');
    const pre = el('pre');
    const pathLine = el('summary', null, 'Exactly what would be published');
    preview.append(pathLine, pre);
    const row = el('div', 'gp-actions');
    const openBtn = el('button', 'btn primary', 'Open a pull request'); openBtn.type = 'button'; openBtn.disabled = true;
    const copyBtn = el('button', 'btn', 'Copy JSON'); copyBtn.type = 'button'; copyBtn.disabled = true;
    const cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button';
    row.append(openBtn, copyBtn, cancel);
    const note = el('p', 'gp-note', 'Open a pull request fills in GitHub’s new-file page for you; you still press “Propose changes” there. Copy JSON is for adding the file yourself.');
    form.append(h, intro, grid, check, problems, preview, row, note);
    dialog.append(form);
    document.body.append(dialog);

    let token = null, timer = null;
    const meta = () => ({ title: title.value, summary: summary.value, tags: tags.value, stacks: [...stacks.selectedOptions].map((o) => o.value), authorName: name.value, authorGithub: github.value, license: license.value });
    async function refresh() {
      const d = await api.draft(kind, ref, meta()).catch(() => null);
      if (!dialog) return;
      if (!d || !d.ok) { token = null; check.textContent = (d && d.error) || 'Could not build the item.'; problems.replaceChildren(); pre.textContent = ''; openBtn.disabled = copyBtn.disabled = true; return; }
      token = d.token;
      pre.textContent = d.text;
      pathLine.textContent = `Exactly what would be published: ${d.path}`;
      problems.replaceChildren(...d.problems.map((p) => el('li', null, p)));
      check.textContent = d.problems.length ? `${d.problems.length} thing${d.problems.length === 1 ? '' : 's'} to fix before it can be listed:` : 'Passes the gallery check (the same one the pull request runs).';
      check.classList.toggle('gp-bad', d.problems.length > 0);
      openBtn.disabled = !d.canOpen;
      openBtn.title = d.problems.length ? 'Fix the problems first' : d.canOpen ? '' : 'Too big for a prefilled page: copy the JSON instead';
      copyBtn.disabled = false;
    }
    const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 200); };
    for (const i of [title, summary, tags, stacks, name, github, license]) i.addEventListener('input', later);
    openBtn.addEventListener('click', async () => {
      openBtn.disabled = true;
      const r = await api.open(token).catch(() => null);
      if (r && r.ok) { close(); if (onDone) onDone({ ok: true, opened: true }); return; }
      check.textContent = (r && r.error) || 'Could not open the page.'; openBtn.disabled = false;
    });
    copyBtn.addEventListener('click', async () => {
      const r = await api.copy(token).catch(() => null);
      check.textContent = r && r.ok ? `Copied. Add it as ${r.path} in a pull request.` : (r && r.error) || 'Could not copy it.';
    });
    cancel.addEventListener('click', () => { close(); if (onDone) onDone({ cancelled: true }); });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); if (onDone) onDone({ cancelled: true }); });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) { close(); if (onDone) onDone({ cancelled: true }); } });
    form.addEventListener('submit', (e) => e.preventDefault());
    dialog.showModal();
    title.focus();
    void refresh();
  }
  function close() { if (dialog) { dialog.close(); dialog.remove(); dialog = null; } }

  window.galleryPublish = { open, close };
})();
