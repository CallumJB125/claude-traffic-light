'use strict';
// Home Inbox: one list of what needs a person, composed in the page from the
// parts main already sends Home (src/attention-inbox.js), plus events from
// sessions this viewer follows. Also the first-run teammate tour and ⌘K.
(() => {
  const api = window.homeApi, Inbox = window.PlexiformInbox, Tour = window.PlexiformTour, Follow = window.PlexiformFollow;
  const $ = id => document.getElementById(id), section = $('inbox');
  if (!api || !Inbox || !section) return;
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; };
  const button = (label, fn, cls) => { const b = node('button', label, cls); b.type = 'button'; b.addEventListener('click', fn); return b; };
  const store = { read(k, parse) { try { return parse(localStorage.getItem(k)); } catch { return parse(null); } }, write(k, v) { try { localStorage.setItem(k, v); } catch { /* unavailable */ } } };
  const ago = ms => ms == null ? '' : ms < 60_000 ? 'just now' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : `${Math.floor(ms / 3_600_000)} h ago`;
  let state = null, alerts = null, teamToday = null, team = [], busy = false;
  const body = section.querySelector('.body'), count = $('inbox-count'), status = $('inbox-status');

  async function act(row) {
    const a = row.action;
    if (a.kind === 'navigate') { void api.navigate(a.destination); return; }
    if (a.kind === 'burst' && typeof api.alertAct === 'function') {
      const r = await api.alertAct('burst', 'act', a.op);
      status.textContent = r?.ok ? (r.note || (r.retried ? 'Checked again.' : 'Started.')) : r?.cancelled ? 'Cancelled. Nothing changed.' : (r?.error || 'Burst could not do that. Open Usage & Burst to see why.');
      await load();
      return;
    }
    if (a.kind === 'alert' && typeof api.alertAct === 'function') {
      const r = await api.alertAct(a.alert, a.op, a.handle);
      status.textContent = r?.ok ? (r.note || '') : (r?.error || 'That card has changed. Home refreshes in a moment.');
      await load();
    }
  }
  function render() {
    const follow = Follow ? Follow.unseen(store.read('plexiform.follows', Follow.parse)) : [];
    const r = Inbox.compose({ needs: state?.needs, alerts, morning: state?.morning, teamToday, follow, team, now: Date.now() });
    section.hidden = false;
    count.textContent = r.total ? `${r.total} item${r.total === 1 ? '' : 's'}` : '';
    if (!r.items.length) { body.replaceChildren(node('p', 'Nothing needs a person right now. Approvals, questions, blockers, failures and teammates’ handoffs land here with one action each.', 'muted')); return; }
    const list = node('ul'); list.setAttribute('aria-label', 'Inbox');
    for (const row of r.items) {
      const li = node('li'), text = node('div'); li.dataset.kind = row.kind;
      if (row.dimmed === true) li.classList.add('dimmed');
      text.append(node('strong', row.title, 'title'), node('p', [row.meta, ago(row.ageMs)].filter(Boolean).join(' · '), 'muted'));
      const tag = node('span', r.label(row.kind), `tag ${['approval', 'question', 'blocker', 'failed', 'burst'].includes(row.kind) ? 'waiting' : row.kind === 'finished' ? 'working' : Inbox.TEAM_KINDS?.includes(row.kind) && row.read ? 'team' : ''}`);
      const actions = node('div', '', 'actions');
      if (row.options?.length && typeof api.answerInput === 'function') {
        for (const [i, opt] of row.options.entries()) actions.append(button(opt.label, async () => {
          for (const b of actions.querySelectorAll('button')) b.disabled = true;
          const r = await api.answerInput(row.requestId, opt.id);
          status.textContent = r?.ok ? 'Answered.' : (r?.error || 'Could not answer. Open the Waiting page.');
          await load();
        }, `quick-option${i === 0 && /^(allow|accept|yes|approve)/i.test(opt.id) ? ' primary' : ''}`));
      }
      actions.append(button(row.action.label, () => void act(row), row.kind === 'approval' && !row.options?.length ? 'primary' : ''));
      if (row.read?.kind === 'inbox-read' && typeof api.inboxRead === 'function') actions.append(button('Mark read', async () => {
        for (const b of actions.querySelectorAll('button')) b.disabled = true;
        const r = await api.inboxRead(row.read.ids);
        status.textContent = r?.ok ? '' : (r?.error || 'Could not mark that read. Home refreshes in a moment.');
        await load();
      }, 'quiet'));
      li.append(text, tag, actions); list.append(li);
    }
    body.replaceChildren(list);
    if (follow.length) body.append(button('Mark followed sessions as seen', () => { if (Follow) store.write('plexiform.follows', Follow.serialize(Follow.markSeen(store.read('plexiform.follows', Follow.parse)))); render(); }));
  }
  async function load() {
    if (busy || document.hidden) return; busy = true;
    try { [alerts, teamToday, team] = await Promise.all([api.alerts?.().catch(() => null) ?? null, api.teamToday?.().catch(() => null) ?? null, api.teamInbox?.().catch(() => []) ?? []]); } finally { busy = false; }
    if (!Array.isArray(team)) team = [];
    render();
  }
  document.addEventListener('home:state', ev => { state = ev.detail; render(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
  setInterval(() => { if (!document.hidden) void load(); }, 5000);
  void load();

  // ⌘K anywhere on Home opens the shared sessions page, where the palette lives.
  document.addEventListener('keydown', ev => { if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'k') { ev.preventDefault(); void api.navigate('overview'); } });

  // First-run tour, once per signed-in account (falls back to this computer when Home has no account id).
  if (!Tour) return;
  const account = () => state?.team?.account || state?.team?.user || null;
  let tourState = store.read('plexiform.tour', Tour.parse), shown = null, settled = false;
  const remember = () => { tourState = Tour.dismiss(tourState, account()); store.write('plexiform.tour', Tour.serialize(tourState)); };
  // Every Home state until it is decided: wait for the team answer and for the widget tour to end;
  // if that tour starts while this one is open, this one steps aside and comes back after.
  function onState(home) {
    if (settled) return;
    const d = Tour.decide(tourState, home, account());
    if (d === 'wait') { if (shown && home?.firstRunTour === 'running') { shown.remove(); shown = null; } return; }
    if (d === 'done') { settled = true; return; }
    if (d === 'dismiss') { settled = true; shown?.remove(); shown = null; remember(); return; }
    if (!shown) showTour();
  }
  function showTour() {
    const host = node('div', '', 'tour'), dialog = node('div', '', 'tour-dialog'), title = node('h2'), text = node('p'), steps = node('p', '', 'muted tour-steps'), actions = node('div', '', 'actions');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'tour-title'); title.id = 'tour-title';
    let i = 0; const opener = document.activeElement;
    const finish = () => { settled = true; remember(); host.remove(); shown = null; opener?.focus?.(); };
    const next = button('Next', () => { if (i === Tour.STEPS.length - 1) { finish(); return; } i = Tour.next(i); paint(); }, 'primary'), skip = button('Skip tour', finish);
    const paint = () => { const s = Tour.STEPS[i]; title.textContent = s.title; text.textContent = s.text; steps.textContent = `Step ${i + 1} of ${Tour.STEPS.length}`; next.textContent = i === Tour.STEPS.length - 1 ? 'Done' : 'Next'; next.focus(); };
    actions.append(next, skip); dialog.append(title, text, steps, actions); host.append(dialog); document.body.append(host); shown = host;
    dialog.addEventListener('keydown', ev => { if (ev.key === 'Escape') finish(); else if (ev.key === 'Tab') { const f = [next, skip]; const at = f.indexOf(document.activeElement); ev.preventDefault(); f[(at + (ev.shiftKey ? f.length - 1 : 1)) % f.length].focus(); } });
    paint();
  }
  document.addEventListener('home:state', ev => onState(ev.detail));
})();
