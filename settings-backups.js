// Preferences → Backups. A separate file so the page's inline script does
// not grow, and so it runs under a CSP that forbids inline script. Text goes
// in with textContent only.
(function () {
  const api = window.settingsApi;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const REASON = { save: 'saved automatically', daily: 'daily check', manual: 'you asked for it', 'before-restore': 'kept before a restore' };
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const when = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const size = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const say = (text, bad) => { const s = $('backups-status'); s.textContent = text; s.dataset.state = bad ? 'err' : ''; };
  const SHOWN = 8;
  let showAll = false;
  let open = null; // the snapshot whose differences are showing

  function button(text, fn, cls) {
    const b = el('button', cls || 'secondary', text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  // Two clicks, like the other destructive buttons here: the first says what happens.
  function armed(text, armedText, fn, onArm) {
    const b = button(text, async () => {
      if (!b.dataset.armed && onArm) await onArm();
      if (b.dataset.armed) { clearTimeout(b._t); delete b.dataset.armed; b.textContent = text; b.disabled = true; await fn(); b.disabled = false; return; }
      b.dataset.armed = '1';
      b.textContent = armedText;
      b.classList.add('armed');
      b._t = setTimeout(() => { delete b.dataset.armed; b.textContent = text; b.classList.remove('armed'); }, 4000);
    });
    return b;
  }

  async function restore(s, pick) {
    const r = await api.backupsRestore(s.id, pick);
    if (r.error) { say(r.error, true); return; }
    const what = r.restored.length + r.configKeys.length;
    say(`Restored from ${when(s.createdAt)} (${what} item${what === 1 ? '' : 's'}). Your previous settings were kept as a backup, so this can be undone.${r.relaunch ? ' Plexiform restarts in a moment to load your usage history.' : ''}`);
    open = null;
    await refresh(true);
  }

  // Click actions run commands, so a backup that would add some says so in words, in both the diff and the confirmation.
  const commandsNote = (cmds) => el('div', 'bk-note bk-bad bk-commands', `This backup's rules would run: ${cmds.join('; ')}`);

  async function showDiff(s, holder) {
    holder.replaceChildren(el('div', 'bk-note', 'Comparing…'));
    const d = await api.backupsDiff(s.id);
    if (d.error) { holder.replaceChildren(el('div', 'bk-note bk-bad', d.error)); return; }
    if (d.same) { holder.replaceChildren(el('div', 'bk-note', 'Nothing is different: your current settings match this backup.'), button('Close', () => { open = null; holder.replaceChildren(); })); return; }
    const picks = [];
    const row = (text, pick) => {
      const label = el('label', 'bk-pick');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      label.append(cb, el('span', null, text));
      picks.push({ cb, ...pick });
      return label;
    };
    const list = el('div', 'bk-diff');
    list.append(el('div', 'bk-note', 'Tick what to bring back. Anything you leave out, and anything added since this backup, stays as it is now.'));
    for (const f of d.files) {
      if (f.name === 'config.json' && d.configKeys.length) {
        list.append(el('div', 'bk-head', 'Your settings and rules'));
        for (const k of d.configKeys) {
          list.append(k.status === 'only-now' ? el('div', 'bk-note', k.say) : row(k.say, { key: k.key }));
          if (k.key === 'rules' && d.commands.length) list.append(commandsNote(d.commands));
        }
      } else if (f.status === 'only-now') {
        list.append(el('div', 'bk-note', f.say));
      } else list.append(row(f.say, { file: f.name }));
    }
    const actions = el('div', 'row wrap');
    actions.append(
      button('Restore selected', async () => {
        const chosen = picks.filter((p) => p.cb.checked);
        if (!chosen.length) { say('Tick at least one thing to restore.', true); return; }
        await restore(s, { files: chosen.filter((p) => p.file).map((p) => p.file), configKeys: chosen.filter((p) => p.key).map((p) => p.key) });
      }),
      button('Close', () => { open = null; holder.replaceChildren(); }, 'secondary'),
    );
    holder.replaceChildren(list, actions);
  }

  function item(s) {
    const li = el('li', 'bk-item');
    li.dataset.id = s.id;
    li.dataset.damaged = s.damaged ? '1' : '';
    const head = el('div', 'bk-title', s.damaged ? `Damaged backup from ${when(s.createdAt)}` : `Restore your settings from ${when(s.createdAt)}`);
    const meta = el('div', 'bk-meta', s.damaged
      ? `Plexiform will not restore this one: ${s.problems[0] || 'it is incomplete'}. It is removed automatically once it is over 30 days old or the backup folder needs the room.`
      : `${s.reason ? REASON[s.reason] : 'unknown'} · ${size(s.size)}`);
    const holder = el('div', 'bk-holder');
    li.append(head, meta);
    if (!s.damaged) {
      const acts = el('div', 'row wrap');
      acts.append(
        button("See what's different", () => { open = s.id; showDiff(s, holder); }),
        armed('Restore everything', 'Click again to restore everything', () => restore(s, undefined), async () => {
          const d = await api.backupsDiff(s.id);
          holder.querySelector('.bk-confirm')?.remove();
          if (d && d.commands && d.commands.length) holder.prepend(el('div', 'bk-note bk-bad bk-confirm', `Restoring everything also brings back rules that would run: ${d.commands.join('; ')}`));
        }),
      );
      acts.lastChild.setAttribute('aria-label', `Restore everything from ${when(s.createdAt)}`);
      li.append(acts);
    }
    li.append(holder);
    if (open === s.id && !s.damaged) showDiff(s, holder);
    return li;
  }

  async function refresh(keepStatus) {
    const r = await api.backupsList();
    if (r.error) { $('backups-list').replaceChildren(); $('backups-summary').textContent = r.error; return; }
    const good = r.snapshots.filter((s) => !s.damaged);
    $('backups-summary').textContent = r.snapshots.length
      ? `${good.length} backup${good.length === 1 ? '' : 's'}${r.snapshots.length > good.length ? `, ${r.snapshots.length - good.length} damaged` : ''}. Latest: ${good.length ? when(good[0].createdAt) : 'none that can be restored'}.`
      : 'No backups yet. One is made the next time you change a setting.';
    const rows = showAll ? r.snapshots : r.snapshots.slice(0, SHOWN);
    $('backups-list').replaceChildren(...rows.map(item));
    const more = $('backups-more');
    more.hidden = r.snapshots.length <= SHOWN;
    more.textContent = showAll ? 'Show fewer' : `Show ${r.snapshots.length - SHOWN} older`;
    if (!keepStatus) say('');
  }

  $('backups-now').addEventListener('click', async () => {
    const r = await api.backupsNow();
    if (r.error) say(`Could not back up: ${r.error}`, true);
    else if (r.taken) say(`Backed up at ${when(new Date().toISOString())}.`);
    else say(r.why === 'unchanged' ? 'Already backed up: nothing has changed since the last backup.' : 'There is nothing to back up yet.');
    await refresh(true);
  });
  $('backups-more').addEventListener('click', () => { showAll = !showAll; refresh(true); });
  $('backups-folder').addEventListener('click', () => api.backupsOpenFolder());
  $('backups-recheck').addEventListener('click', () => refresh());

  $('backups').addEventListener('toggle', () => { if ($('backups').open) refresh(); });
  $('feedback-open').addEventListener('click', () => api.openFeedback());
  api.onShowSection((id) => { if (id === 'backups') { $('backups').open = true; $('backups').scrollIntoView({ block: 'start' }); } });
})();
