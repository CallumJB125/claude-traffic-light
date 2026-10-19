'use strict';
// Home's "Team today" section (src/team-today.js decides what it holds).
// Hidden when signed out. textContent only; the only link is a PR on github.com.
(() => {
  const api = window.homeApi;
  const section = document.getElementById('teamtoday');
  if (!api || !api.teamToday || !section) return;
  const out = section.querySelector('.body');
  const meta = document.getElementById('teamtoday-updated');
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const ago = (iso) => { const ms = Date.now() - (Date.parse(iso || '') || NaN); return !(ms >= 0) ? '' : ms < 60_000 ? 'just now' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : `${Math.floor(ms / 3_600_000)} h ago`; };
  let generation = 0, busy = false, heatWindow = '24h';

  function button(label, focus, onClick, primary) {
    const b = node('button', label, primary ? 'primary' : ''); b.type = 'button'; b.dataset.focus = focus;
    b.addEventListener('click', () => void onClick(b)); return b;
  }
  function row(title, detail, tag, tone) {
    const li = node('li'), text = node('div');
    text.append(node('strong', title, 'title'), node('p', detail, 'muted'));
    li.append(text);
    if (tag) li.append(node('span', tag, `tag ${tone || ''}`));
    return li;
  }
  function list(label, items, more, make) {
    const wrap = node('div');
    wrap.append(node('h3', label));
    const ul = node('ul'); ul.setAttribute('aria-label', label);
    items.forEach((x) => ul.append(make(x)));
    wrap.append(ul);
    if (more) wrap.append(node('p', `And ${more} more.`, 'muted'));
    return wrap;
  }
  const where = (x) => [x.team, x.repo || x.board].filter(Boolean).join(' · ');
  const names = (xs) => (xs.length > 2 ? `${xs.slice(0, 2).join(', ')} +${xs.length - 2}` : xs.join(', '));

  // Compact tree: folder → hottest files, with counts and who. "2+ people" marks a file two teammates are editing.
  function heatMap(heat) {
    const h = heat?.[heatWindow];
    if (!h) return null;
    const wrap = node('div', null, 'heatmap');
    const head = node('h3', 'Where the team is working');
    const toggle = node('div', null, 'actions');
    for (const w of ['24h', '7d']) {
      const b = button(w === '24h' ? 'Last 24 h' : 'Last 7 days', `teamtoday:heat:${w}`, () => { heatWindow = w; void refresh(); });
      b.setAttribute('aria-pressed', String(w === heatWindow));
      toggle.append(b);
    }
    wrap.append(head, toggle);
    if (!h.dirs.length) { wrap.append(node('p', 'No shared file activity in this window. Files show here only when teammates share them.', 'muted')); return wrap; }
    const tree = node('ul', null, 'heat-tree'); tree.setAttribute('aria-label', 'File heat map');
    for (const d of h.dirs) {
      const li = node('li');
      li.append(node('strong', `${d.path === '.' ? '(root)' : `${d.path}/`} · ${d.count}`, 'title'), node('span', ` ${names(d.people)}`, 'muted'));
      const files = node('ul');
      for (const f of d.files) {
        const fl = node('li');
        fl.append(node('span', `${f.name} · ${f.count}`), node('span', ` ${names(f.people)}`, 'muted'));
        if (f.shared) fl.append(node('span', '2+ people', 'tag waiting'));
        files.append(fl);
      }
      if (d.more) files.append(node('li', `and ${d.more} more`, 'muted'));
      li.append(files);
      tree.append(li);
    }
    wrap.append(tree);
    if (h.more) wrap.append(node('p', `And ${h.more} more folders.`, 'muted'));
    return wrap;
  }

  function standupText(rows) {
    if (!rows.length) return 'Standup: nothing shared by the team in the last two days.';
    const part = (label, xs, none) => `  ${label}: ${xs.length ? xs.join('; ') : none}`;
    return rows.map((p) => [p.author, part('Yesterday', p.yesterday, 'nothing shared'), part('Today', p.today, 'nothing shared'), part('Blocked', p.blocked, 'nothing')].join('\n')).join('\n\n');
  }
  function standupCard(rows) {
    if (!Array.isArray(rows)) return null;
    const wrap = node('div', null, 'standup');
    wrap.append(node('h3', 'Standup'));
    if (!rows.length) wrap.append(node('p', 'Nothing shared by the team in the last two days.', 'muted'));
    for (const p of rows) {
      const dl = node('dl');
      dl.append(node('dt', p.author, 'title'));
      for (const [label, xs, none] of [['Yesterday', p.yesterday, 'Nothing shared'], ['Today', p.today, 'Nothing shared'], ['Blocked', p.blocked, 'Nothing']]) dl.append(node('dd', `${label}: ${xs.length ? xs.join('; ') : none}`, xs.length || label !== 'Blocked' ? '' : 'muted'));
      wrap.append(dl);
    }
    const copied = node('span', '', 'muted'); copied.setAttribute('role', 'status');
    const actions = node('div', null, 'actions');
    actions.append(button('Copy', 'teamtoday:standup-copy', async () => {
      try { await navigator.clipboard.writeText(standupText(rows)); copied.textContent = ' Copied.'; } catch { copied.textContent = ' Could not copy.'; }
    }), copied);
    wrap.append(actions);
    return wrap;
  }

  function render(s) {
    section.hidden = !s;
    if (!s) { meta.textContent = ''; return out.replaceChildren(); }
    const focus = document.activeElement?.dataset?.focus;
    const parts = [];
    if (s.state === 'error') {
      parts.push(node('p', s.updated_at ? `Couldn’t reach the team hub. This is what it said at ${clock(s.updated_at)}.` : 'Couldn’t reach the team hub. Check your connection; it tries again every minute.', 'warning'));
    }
    meta.textContent = s.updated_at ? `Updated ${clock(s.updated_at)}` : '';
    if (s.people) {
      parts.push(s.people.items.length
        ? list('Working now', s.people.items, s.people.more, (p) => row(`${p.author} · ${p.title}`, [where(p), p.branch, ago(p.updated_at)].filter(Boolean).join(' · '), p.status, p.status === 'Waiting' ? 'waiting' : 'working'))
        : node('p', 'No teammate is working in your linked repositories right now.', 'muted'));
      if (s.overlaps.items.length) parts.push(list('Overlaps with your work', s.overlaps.items, s.overlaps.more, (o) => row(o.text, `${o.title} · ${where(o)}`, o.level === 'high' ? 'Conflict risk' : 'Nearby', o.level === 'high' ? 'waiting' : '')));
      const sinceLabel = s.since ? `Since you were away (${new Date(s.since).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })})` : 'Since you were away';
      const changes = list(sinceLabel, s.changes.items, s.changes.more, (c) => {
        const li = row(c.text, [where(c), ago(c.at)].filter(Boolean).join(' · '));
        if (c.url) { const a = node('a', 'Open PR'); a.href = c.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; li.append(a); }
        return li;
      });
      if (!s.changes.items.length) changes.append(node('p', 'Nothing new since you last looked.', 'muted'));
      parts.push(changes);
      const stand = standupCard(s.standup); if (stand) parts.push(stand);
      const heat = heatMap(s.heat); if (heat) parts.push(heat);
      if (s.shipped?.items.length) parts.push(list('Shipped this week', s.shipped.items, s.shipped.more, (x) => row(x.text, [where(x), x.by, ago(x.at)].filter(Boolean).join(' · '), x.kind === 'merged' ? 'Merged' : x.kind === 'ship' ? 'Shipped' : 'Done', 'working')));
    }
    if (s.sharing_off?.length) parts.push(node('p', `You don’t share summaries with ${s.sharing_off.join(', ')}, so their sessions aren’t read back here.`, 'muted'));
    if (s.unreachable?.length && s.state !== 'error') parts.push(node('p', `Some of ${s.unreachable.join(', ')} could not be read just now.`, 'muted'));
    const actions = node('div', '', 'actions');
    if (s.changes?.items.length) actions.append(button('Mark as seen', 'teamtoday:seen', async (b) => { b.disabled = true; try { await api.teamTodaySeen(); } finally { void refresh(); } }));
    actions.append(button('Refresh', 'teamtoday:refresh', async (b) => { if (busy) return; busy = true; b.disabled = true; try { render(await api.teamTodayRefresh()); } catch { /* the next tick shows it */ } finally { busy = false; } }));
    parts.push(actions);
    out.replaceChildren(...parts);
    if (focus) [...out.querySelectorAll('[data-focus]')].find((el) => el.dataset.focus === focus)?.focus();
  }
  async function refresh() {
    const request = ++generation;
    let s;
    try { s = await api.teamToday(); } catch { s = null; }
    if (request !== generation || document.hidden || busy) return;
    render(s);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
  void refresh();
})();
