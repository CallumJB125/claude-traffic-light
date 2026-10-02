'use strict';
// Team sharing for one Plexiform-owned session card in Overview. Off by
// default: a session is shared only after its owner picks a team, a scope
// and an expiry here and presses Share. "Watch only" lets that team's
// members read the session's messages and responses sent from then on (never
// earlier ones); "Watch and send" also lets members who are not team viewers
// send, steer and interrupt (their messages show as "Sent by <name>" and run
// on the owner's provider account). Stop sharing ends it at once. Everything goes through
// overviewApi.interaction (main → this Mac's remote host → the team hub);
// hub text is shown with textContent only. overview.js calls mount() once
// per card.
(() => {
  const ix = window.overviewApi && window.overviewApi.interaction;
  if (!ix || typeof ix.shareList !== 'function') return;
  const EXPIRY = [['3600', 'For 1 hour'], ['28800', 'For 8 hours'], ['86400', 'For 1 day'], ['604800', 'For 7 days'], ['', 'Until I stop it']];
  const SCOPE = { watch: 'Watch only', interact: 'Watch and send' };
  const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v, max = 200) => typeof v === 'string' && v.length <= max;
  const validTeam = t => obj(t) && str(t.id, 100) && str(t.name);
  const validShare = s => obj(s) && str(s.id, 100) && str(s.session, 100) && validTeam(s.team) && Object.hasOwn(SCOPE, s.scope)
    && (s.expiresAt === null || Number.isFinite(s.expiresAt)) && Array.isArray(s.members) && s.members.every(m => obj(m) && str(m.name));
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (label, fn) => { const b = el('button', label); b.type = 'button'; b.addEventListener('click', fn); return b; };
  const select = (label, options) => {
    const wrap = el('label', label), s = document.createElement('select');
    for (const [value, text] of options) { const o = el('option', text); o.value = value; s.append(o); }
    wrap.append(s); return [wrap, s];
  };
  const until = ms => { const d = new Date(ms); return `until ${d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`; };
  const who = s => {
    if (!s.members.length) return 'No other members in this team yet';
    const send = s.members.filter(m => m.canSend === true).map(m => m.name), watch = s.members.filter(m => m.canSend !== true).map(m => m.name);
    return [send.length ? `${send.join(', ')} can watch and send` : '', watch.length ? `${watch.join(', ')} can watch` : ''].filter(Boolean).join('; ');
  };

  function mount(card, session) {
    if (!card || !str(session, 100)) return;
    const box = el('div', '', 'share'), status = el('p', '', 'reason'), panel = el('div', '', 'share-panel');
    status.setAttribute('role', 'status'); panel.hidden = true;
    const toggle = button('Share…', () => { panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden)); render(); if (!panel.hidden) void refresh(); });
    toggle.setAttribute('aria-expanded', 'false');
    box.append(toggle, status, panel);
    card.append(box);
    let teams = [], mine = [], busy = false, note = '';

    function render() {
      toggle.textContent = mine.length ? 'Sharing…' : 'Share…';
      status.textContent = (!panel.hidden && note) || (mine.length ? `Shared with ${mine.map(s => `${s.team.name} (${SCOPE[s.scope]})`).join(', ')}.` : '');
      const parts = [];
      if (mine.length) {
        const list = el('ul', '', 'share-list');
        list.setAttribute('aria-label', 'Who has access');
        for (const s of mine) {
          const li = el('li');
          li.append(el('strong', s.team.name), el('span', ` · ${SCOPE[s.scope]} · ${s.expiresAt === null ? 'until you stop it' : until(s.expiresAt)}`), el('p', who(s), 'reason'));
          const stop = button('Stop sharing', () => void stopShare(s.id)); stop.disabled = busy;
          li.append(stop); list.append(li);
        }
        parts.push(list);
      }
      if (teams.length) {
        const [teamL, team] = select('Team', teams.map(t => [t.id, t.name]));
        const [scopeL, scope] = select('They can', Object.entries(SCOPE));
        const [expL, exp] = select('For how long', EXPIRY);
        const go = button(busy ? 'Sharing…' : 'Share', () => void share(team.value, scope.value, exp.value)); go.disabled = busy;
        const form = el('div', '', 'actions'); form.append(teamL, scopeL, expL, go);
        parts.push(form, el('p', 'Members of that team see this session\'s messages and the provider\'s replies from the moment you share it (not earlier ones), through your team hub, and whether this computer is online. "Watch and send" also lets them send, steer and interrupt (team viewers can only watch); their messages show who sent them. What they send runs on your provider account and uses your quota (the provider sign-in or local model endpoint this session runs on), and you are responsible for it. Only you can close it.', 'reason'));
      } else parts.push(el('p', 'You are not in a team you can share with.', 'reason'));
      panel.replaceChildren(...parts);
    }
    async function refresh() {
      let r; try { r = await ix.shareList(); } catch { r = null; }
      if (!obj(r)) return;
      if (r.ok !== true) { note = str(r.error, 300) ? r.error : 'Sharing is unavailable right now.'; teams = []; render(); return; }
      teams = Array.isArray(r.teams) ? r.teams.filter(validTeam) : [];
      mine = Array.isArray(r.shares) ? r.shares.filter(s => validShare(s) && s.session === session) : [];
      note = ''; render();
    }
    async function share(team, scope, expiry) {
      if (busy) return;
      busy = true; note = ''; render();
      let r; try { r = await ix.shareCreate({ session, team, scope, expiresInS: expiry ? Number(expiry) : null }); } catch { r = null; }
      busy = false;
      note = r && r.ok === true ? '' : `Not shared. ${r && str(r.error, 300) ? r.error : 'Try again.'}`;
      await refresh(); render();
    }
    async function stopShare(id) {
      if (busy) return;
      busy = true; render();
      let r; try { r = await ix.shareStop({ share: id }); } catch { r = null; }
      busy = false;
      note = r && r.ok === true ? 'Stopped sharing. Teammates can no longer see or send to this session.' : `${r && str(r.error, 300) ? r.error : 'Could not stop sharing. Try again.'}`;
      mine = mine.filter(s => s.id !== id || !(r && r.ok === true));
      render(); void refresh().then(() => { if (r && r.ok === true) { note = 'Stopped sharing. Teammates can no longer see or send to this session.'; render(); } });
    }
    render(); void refresh();
  }
  window.OverviewShare = Object.freeze({ mount });
})();
