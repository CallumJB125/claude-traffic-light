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
  let generation = 0, busy = false;

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
