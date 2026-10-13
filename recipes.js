'use strict';
// The Tasks page's Recipes block (src/recipes.js decides everything): a
// gallery over the task pane with Run now, Run tonight, Save as my own, and
// sharing your own recipes as a file. It opens by itself while there are no
// tasks yet and the helper is up. Text is only ever textContent; the page sends recipe ids and the
// folder handle main gave it.
(() => {
  const api = window.recipesApi;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (label, cls, on) => { const b = el('button', `btn ${cls || ''}`.trim(), label); b.type = 'button'; b.addEventListener('click', on); return b; };
  const root = $('recipes');
  let data = null, folder = null, closedByPerson = false;

  function show(on) { root.hidden = !on; document.body.classList.toggle('recipes-open', on); $('recipes-open').setAttribute('aria-expanded', String(on)); }
  const say = (text) => { const s = root.querySelector('.recipes-status'); if (s) s.textContent = text; };

  async function chooseFolder() {
    const f = await api.pickFolder().catch(() => null);
    if (f) { folder = f; render(); }
    return f;
  }
  async function run(r, when, b) {
    if (!folder && !(await chooseFolder())) return;
    b.disabled = true; say(`Starting “${r.title}”…`);
    const res = await api.run(r.id, folder.handle, when).catch(() => null);
    b.disabled = false;
    if (res && res.ok) { say(when === 'tonight' ? `“${r.title}” is queued for tonight. It is in your task list.` : `“${r.title}” started. It is in your task list.`); return; }
    say((res && (res.error || res.text)) || 'That did not start. Try again.');
  }
  async function act(fn, ok) {
    const res = await fn().catch(() => null);
    if (res && res.ok) { say(ok(res)); await load(); } else say((res && res.error) || 'That did not work.');
  }

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const REPEATS = [['off', 'Does not repeat'], ['nightly', 'Every night'], ['weekdays', 'Every weekday'], ['weekly', 'Every week on…'], ['hours', 'Every few hours while awake']];
  const scheduleOf = (id) => (data.schedules || []).find((x) => x.id === id) || null;

  // The repeat controls on a card: a repeat, a time (or a day and time, or an
  // hours gap), then Save. What is saved shows as its next run and last runs.
  function scheduleBlock(r) {
    const cur = scheduleOf(r.id);
    const box = el('div', 'recipe-repeat');
    if (cur) {
      box.append(el('p', 'repeat-now', `${cur.label}. ${cur.next}. Works in: ${cur.folderLabel}`));
      if (cur.history.length) {
        const h = el('ul', 'repeat-history'); h.setAttribute('aria-label', 'Last runs');
        for (const x of cur.history) h.append(el('li', `repeat-${x.result}`, `${x.when}: ${x.result === 'started' ? 'ran' : x.result === 'skipped' ? 'skipped' : 'did not start'}${x.note ? ` (${x.note})` : ''}`));
        box.append(h);
      }
      const row = el('div', 'recipe-actions');
      row.append(
        btn(cur.paused ? 'Resume' : 'Pause', 'small', () => act(() => api.pauseSchedule(r.id, !cur.paused), () => (cur.paused ? 'Resumed.' : 'Paused. Nothing runs until you resume it.'))),
        ...(cur.paused ? [] : [btn('Skip next', 'small', () => act(() => api.skipNext(r.id), (x) => `Skipped. ${x.entry.next}.`))]),
        btn('Stop repeating', 'small', () => act(() => api.schedule(r.id, { kind: 'off' }, null), () => 'It no longer repeats.')),
      );
      box.append(row);
      return box;
    }
    const d = el('details', 'repeat-set');
    const sum = el('summary', null, data.canSchedule ? 'Repeat…' : 'Repeat… (not on your plan)');
    d.append(sum);
    if (!data.canSchedule || data.demo) { d.append(el('p', 'sub', data.demo ? 'This is the demo: nothing runs.' : 'Repeating recipes come with the overnight queue on Plus.')); return d; }
    const form = el('div', 'repeat-form');
    const kind = el('select'); kind.setAttribute('aria-label', 'Repeat');
    for (const [v, label] of REPEATS) { const o = el('option', null, label); o.value = v; kind.append(o); }
    const day = el('select'); day.setAttribute('aria-label', 'Day'); DAYS.forEach((n, i) => { const o = el('option', null, n); o.value = String(i); day.append(o); }); day.value = '1';
    const time = el('input'); time.type = 'time'; time.value = '22:00'; time.setAttribute('aria-label', 'Time');
    const every = el('select'); every.setAttribute('aria-label', 'Every'); for (const n of [1, 2, 3, 4, 6, 8, 12]) { const o = el('option', null, n === 1 ? 'every hour' : `every ${n} hours`); o.value = String(n); every.append(o); } every.value = '4';
    const sync = () => { day.hidden = kind.value !== 'weekly'; time.hidden = !['nightly', 'weekdays', 'weekly'].includes(kind.value); every.hidden = kind.value !== 'hours'; };
    kind.addEventListener('change', sync); sync();
    const save = btn('Save', 'small primary', async () => {
      if (kind.value === 'off') return;
      if (!folder && !(await chooseFolder())) return;
      const sched = kind.value === 'hours' ? { kind: 'hours', every: Number(every.value) } : kind.value === 'weekly' ? { kind: 'weekly', day: Number(day.value), time: time.value } : { kind: kind.value, time: time.value };
      await act(() => api.schedule(r.id, sched, folder.handle), (x) => `“${r.title}” repeats: ${x.entry.label}. ${x.entry.next}.`);
    });
    form.append(kind, day, time, every, save);
    d.append(form, el('p', 'sub', 'Each run starts in the background while this Mac is awake, under your own login. A run that would pass your daily spend limit is skipped. You confirm once.'));
    return d;
  }

  // The Tasks sidebar's one-line view of what runs next.
  function renderNext() {
    const strip = $('recipes-next');
    if (!strip) return;
    const live = (data?.schedules || []).filter((x) => !x.paused && x.nextRunAtMs !== null).sort((a, b) => a.nextRunAtMs - b.nextRunAtMs);
    strip.hidden = !live.length;
    strip.textContent = live.length ? `${live.length === 1 ? 'Next repeat' : 'Next repeats'}: ${live.slice(0, 2).map((x) => `${x.next.replace(/^Next run /, '')} ${titleOf(x.id)}`).join(' · ')}${live.length > 2 ? ` · and ${live.length - 2} more` : ''}` : '';
  }
  const titleOf = (id) => [...(data?.mine || []), ...(data?.builtIn || [])].find((r) => r.id === id)?.title || id;

  function card(r) {
    const li = el('li', 'recipe');
    li.append(el('h3', null, r.title), el('p', 'recipe-what', r.what));
    const tags = el('p', 'recipe-tags');
    tags.append(el('span', `rtag ${r.edits ? 'edits' : ''}`, r.edits ? 'Changes files, in its own worktree' : 'Read only'), el('span', 'rtag', r.toolLabel), ...(r.mine ? [el('span', 'rtag', 'Mine')] : []));
    li.append(tags, el('p', 'recipe-cost', r.cost));
    const prompt = el('details', 'recipe-prompt');
    prompt.append(el('summary', null, 'See the prompt'), el('pre', null, r.prompt));
    li.append(prompt);
    const row = el('div', 'recipe-actions');
    const now = btn('Run now', 'small primary', () => run(r, 'now', now));
    const tonight = btn('Run tonight', 'small', () => run(r, 'tonight', tonight));
    if (data.demo) { now.disabled = true; tonight.disabled = true; now.title = tonight.title = 'This is the demo: nothing runs.'; }
    else if (!data.canSchedule) { tonight.disabled = true; tonight.title = 'Running overnight is not on your plan.'; }
    row.append(now, tonight);
    row.append(r.mine
      ? btn('Delete', 'small', () => act(() => api.deleteMine(r.id), () => 'Deleted your copy.'))
      : btn('Save as my own', 'small', () => act(() => api.saveMine(r.id), () => `Saved a copy to My recipes. Share it with Share my recipes.`)));
    // Gallery items are read-only prompts anyone can add; main refuses one that edits or came from the gallery.
    if (r.mine && window.galleryPublish) row.append(btn('Share to gallery…', 'small', () => window.galleryPublish.open({ kind: 'recipe', ref: r.id, onDone: (d) => say(d.error ? d.error : d.opened ? `Opened GitHub with “${r.title}” filled in. Press Propose changes there to open the pull request.` : '') })));
    li.append(row, scheduleBlock(r));
    return li;
  }

  function render() {
    if (!data) return;
    const head = el('header', 'recipes-head');
    const title = el('div');
    title.append(el('h2', null, 'Recipes'), el('p', null, 'Ready-made tasks people run every week. Each runs as a task in the background. Anything that changes files runs in its own git worktree, so your checkout is untouched. You confirm before anything starts.'));
    title.firstChild.id = 'recipes-title';
    head.append(title, btn('Close', 'small', () => { closedByPerson = true; show(false); }));
    const where = el('div', 'recipes-where');
    where.append(el('span', null, folder ? `Works in: ${folder.label}` : 'Works in: no folder chosen yet'), btn(folder ? 'Change folder…' : 'Choose folder…', 'small', chooseFolder));
    const share = el('div', 'recipes-share');
    share.append(btn('Share my recipes…', 'small', () => act(() => api.exportMine(), (r) => `Saved ${r.count} recipe${r.count === 1 ? '' : 's'} to a file. It imports here or on the Setups page.`)),
      btn('Import recipes…', 'small', () => act(() => api.importFile(), (r) => `Added ${r.added.length} recipe${r.added.length === 1 ? '' : 's'} to My recipes.`)));
    where.append(share);
    const status = el('p', 'recipes-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const parts = [head, where, status];
    if (data.mine.length) { const l = el('ul', 'recipe-grid'); l.setAttribute('aria-label', 'My recipes'); data.mine.forEach((r) => l.append(card(r))); parts.push(el('h3', 'recipes-sub', 'My recipes'), l); }
    const l = el('ul', 'recipe-grid'); l.setAttribute('aria-label', 'Recipes'); data.builtIn.forEach((r) => l.append(card(r)));
    parts.push(...(data.mine.length ? [el('h3', 'recipes-sub', 'Ready-made')] : []), l);
    const keep = status.textContent;
    root.replaceChildren(...parts);
    status.textContent = keep;
  }

  async function load() {
    const r = await api.list().catch(() => null);
    if (!r || !r.ok) { root.replaceChildren(el('p', 'recipes-status', 'Recipes are unavailable right now.')); return; }
    data = r;
    render();
    renderNext();
  }

  document.addEventListener('gallery:added', () => { void load(); });
  api.onSchedulesChanged?.(() => { void load(); });
  // A repeat set on the New task form: open Recipes on the recipe it made.
  document.addEventListener('recipes:scheduled', () => { show(true); void load().then(() => say('It repeats. It is in My recipes with its next run.')); });
  // A repeat set on the New task form: open Recipes on the recipe it made.
  document.addEventListener('recipes:scheduled', () => { show(true); void load().then(() => say('It repeats. It is in My recipes with its next run.')); });
  if (api.onChanged) api.onChanged(() => { void load(); });
  // Browse the gallery opens the Discover page, where everything from plexiform.dev lives.
  $('cg-open').addEventListener('click', () => { void window.galleryApi?.openDiscover(); });
  $('recipes-open').addEventListener('click', () => { show(root.hidden); if (!root.hidden) void load(); });
  $('new-task').addEventListener('click', () => show(false));
  $('list').addEventListener('click', () => show(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden) { closedByPerson = true; show(false); } });
  // With no tasks yet and the helper up, the gallery is the first thing to see; a down helper keeps its notice visible.
  let galleryFirst = false;
  document.addEventListener('tasks:snapshot', (e) => {
    galleryFirst = !!e.detail?.galleryFirst;
    if (!galleryFirst) show(false); else if (!closedByPerson) show(true);
  });
  void load();
})();
