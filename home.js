'use strict';
// Home: connect banner, then Needs you, Running now, Today and (on a team)
// Your cards. Main (src/home-main.js) decides what each part holds; this file
// renders with textContent only and gives every empty part one next step.
(() => {
  const api = window.homeApi;
  const $ = id => document.getElementById(id);
  let generation = 0;
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const money = v => (v >= 100 ? `$${Math.round(v)}` : `$${Number(v).toFixed(2)}`);
  const ago = ms => ms == null ? 'time unknown' : ms < 60_000 ? 'just now' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : `${Math.floor(ms / 3_600_000)} h ago`;
  const minutes = ms => ms < 60_000 ? 'under a minute' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min` : `${Math.floor(ms / 3_600_000)} h ${Math.floor(ms / 60_000) % 60} min`;
  function go(destination) { void api.navigate(destination); }
  function button(label, onClick, focus, className) {
    const b = node('button', label, className); b.type = 'button'; b.dataset.focus = focus;
    b.addEventListener('click', onClick); return b;
  }
  const goButton = (label, destination, focus, primary = false) => button(label, () => go(destination), focus, primary ? 'primary' : '');
  function empty(text, action) { const el = node('div', '', 'empty'); el.append(node('p', text, 'muted'), action); return el; }
  const body = id => $(id).querySelector('.body');
  const unavailable = id => empty('Couldn’t read this just now. It tries again every few seconds.', button('Refresh', () => void refresh(), `${id}:refresh`));
  function item(title, meta, tag, tone) {
    const text = node('div'); text.append(node('strong', title, 'title'), node('p', meta, 'muted'));
    const li = node('li'); li.append(text); if (tag) li.append(node('span', tag, `tag ${tone || ''}`)); return li;
  }

  function renderBanner(b) {
    const el = $('banner');
    el.hidden = !b;
    if (!b) { el.replaceChildren(); return; }
    el.replaceChildren(node('p', b.text), goButton(b.action.label, b.action.destination, 'banner', true));
  }

  function renderNeeds(n) {
    const out = body('needs');
    $('needs-count').textContent = n?.total ? `${n.total} waiting` : '';
    if (!n) return out.replaceChildren(unavailable('needs'));
    if (!n.total) return out.replaceChildren(empty('Nothing needs you right now. Questions and permission requests from your AI tools show up here.', goButton('Alert settings', 'settings', 'needs:settings')));
    const list = node('ul'); list.setAttribute('aria-label', 'Needs you');
    n.items.forEach((i, at) => {
      const li = item(i.headline, `${i.kind} · ${i.project}${i.age ? ` · ${i.age}` : ''}`, i.late ? 'Long wait' : null, 'waiting');
      li.append(goButton('Answer', 'waiting', `needs:${at}`)); list.append(li);
    });
    out.replaceChildren(list);
    if (n.total > n.items.length) out.append(node('p', `And ${n.total - n.items.length} more.`, 'muted'));
  }

  function renderRunning(r, banner) {
    const out = body('running');
    $('running-count').textContent = r?.items.length ? `${r.items.length} live` : '';
    if (!r) return out.replaceChildren(unavailable('running'));
    if (!r.items.length) {
      return out.replaceChildren(banner?.kind === 'none'
        ? empty('Nothing running. Connect an AI tool to see its sessions here.', goButton('Connect AI tools', banner.action.destination, 'running:connect'))
        : empty(r.quiet ? `Nothing running right now. ${r.quiet} quiet ${r.quiet === 1 ? 'session' : 'sessions'}.` : 'Nothing running right now. Start a prompt in a connected AI tool and it shows up here.', goButton(r.quiet ? 'See all sessions' : 'Start a session', 'sessions', 'running:sessions')));
    }
    const list = node('ul'); list.setAttribute('aria-label', 'Running now');
    r.items.forEach((s, at) => {
      const li = item(`${s.provider} · ${s.project}`, `Last update ${ago(s.age_ms)}`, s.status, s.status === 'Waiting on you' ? 'waiting' : s.status === 'Working' ? 'working' : '');
      const open = button('', () => go('sessions'), `running:${at}`, 'row-link');
      open.setAttribute('aria-label', `${s.provider} in ${s.project}: ${s.status}. Open sessions`);
      open.append(li.firstChild); li.prepend(open); list.append(li);
    });
    out.replaceChildren(list);
    if (r.quiet) { const more = node('div', '', 'actions'); more.append(node('p', `${r.quiet} quiet ${r.quiet === 1 ? 'session' : 'sessions'}`, 'muted'), goButton('See all sessions', 'sessions', 'running:all')); out.append(more); }
  }

  function metric(value, label, className) { const el = node('div', '', 'metric'); el.append(node('strong', value, className), node('span', label)); return el; }
  function renderToday(t, r) {
    const out = body('today');
    if (!t) return out.replaceChildren(unavailable('today'));
    const s = t.spend, strip = node('div', '', 'strip');
    const eq = s?.equivalent ? ' (API-price equivalent)' : '';
    strip.append(
      s ? metric(money(s.spent), s.budget > 0 ? `of ${money(s.budget)} daily limit${eq}` : `spent today, no daily limit${eq}`, s.level || '') : metric('–', 'No spend recorded yet'),
      metric(String(r?.items.length ?? 0), 'running now'),
      metric(t.longestWaitMs == null ? 'None' : minutes(t.longestWaitMs), 'longest wait for you'),
    );
    const actions = node('div', '', 'actions');
    actions.append(s && s.budget > 0 ? goButton('See usage', 'usage', 'today:usage') : s ? goButton('Set a daily limit', 'settings', 'today:limit') : goButton('See usage', 'usage', 'today:usage'));
    out.replaceChildren(strip, actions);
  }

  async function openCard(handle, control) {
    control.disabled = true;
    try { if (!await api.openCard(handle)) $('status').textContent = 'That card changed or is no longer yours. Home refreshes in a moment.'; }
    catch { $('status').textContent = 'That card could not be opened. Try again.'; }
    finally { control.disabled = false; }
  }
  function cardList(rows, label, describe, prefix) {
    const list = node('ul'); list.setAttribute('aria-label', label);
    rows.forEach((c, at) => {
      const li = item(`${c.key ? `${c.key} · ` : ''}${c.title}`, describe(c));
      const open = button('', () => void openCard(c.handle, open), `${prefix}:${at}`, 'row-link');
      open.append(li.firstChild); li.prepend(open); list.append(li);
    });
    return list;
  }
  function renderCards(c) {
    const section = $('cards'), out = body('cards');
    section.hidden = !c;
    if (!c) return out.replaceChildren();
    out.replaceChildren();
    if (c.unavailable) out.append(node('p', 'Some team boards could not be read. Check your connection and sign-in.', 'muted'));
    if (!c.cards.length && !c.decisions.length) return out.append(empty('No cards assigned to you.', goButton('Open the board', 'board', 'cards:board')));
    if (c.cards.length) out.append(cardList(c.cards, 'Your cards', x => `${x.team} · ${x.board} · ${x.state}${x.due_date ? ` · Due ${x.due_date}` : ''}`, 'card'));
    else out.append(node('p', 'No cards assigned to you.', 'muted'));
    if (c.decisions.length) out.append(node('h3', 'Team decisions'), cardList(c.decisions, 'Team decisions', x => `${x.kind} · ${x.summary} · ${x.board}`, 'decision'));
  }

  function render(s) {
    const focus = document.activeElement?.dataset?.focus;
    renderBanner(s.banner); renderNeeds(s.needs); renderRunning(s.running, s.banner); renderToday(s.today, s.running); renderCards(s.team);
    if (focus) [...document.querySelectorAll('[data-focus]')].find(el => el.dataset.focus === focus)?.focus();
    $('status').textContent = `Updated ${new Date(s.observed_at).toLocaleTimeString()}. Refreshes every 5 seconds.`;
  }
  async function refresh() {
    const request = ++generation;
    let s;
    try { s = await api.state(); } catch { s = null; }
    if (request !== generation || document.hidden) return;
    if (!s || typeof s !== 'object') { $('status').textContent = 'Home is unavailable right now. It tries again in a few seconds.'; return; }
    render(s);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
  void refresh();
})();
