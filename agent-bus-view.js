'use strict';
// Sessions' "Agent bus" panel (board/AGENT-BUS.md): the local audit of what AI
// tools handed each other on this Mac (offers, starts, results, refusals,
// stop/resume), and the person's Stop and Resume. Titles only, never bodies;
// textContent only. Hidden until the Tasks helper has bus activity to show.
(() => {
  const api = window.sessionsApi;
  const section = document.getElementById('agent-bus');
  if (!api || !api.busList || !section) return;
  const out = section.querySelector('.body');
  const status = document.getElementById('agent-bus-status');
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', bus: 'Plexiform' };
  const name = (id) => NAME[id] || id || 'an AI';
  const WHY = { HALTED: 'the bus is stopped', SPEND_CAP: 'the daily spend cap is used up', LOOP: 'it would loop back', RATE: 'too many handoffs', TIER_NOT_ACCEPTED: 'sessions can hand off to this Mac only',
    NO_ELIGIBLE_AGENT: 'this repository is not turned on', NO_LOCAL_CHECKOUT: 'no checkout of that repository here' };
  const LINE = {
    'handoff.offer': (e) => `${name(e.provider)} handed “${e.title || 'work'}” to ${name(e.to)}`,
    'handoff.refused': (e) => `Refused “${e.title || 'a handoff'}”: ${WHY[e.reason] || e.reason}`,
    'claim.started': () => 'Started in its own worktree',
    'claim.denied': (e) => `Could not start (${e.reason || 'error'})`,
    'claim.lost': () => 'Lost track of the run',
    'result.done': (e) => `Finished${e.cost_usd ? ` · about $${e.cost_usd.toFixed(2)}` : ''}`,
    'result.failed': () => 'Did not finish',
    'result.outcome_unknown': () => 'Ended with no known outcome (not retried)',
    'result.expired': () => 'Expired before it started',
    'control.halt': () => 'You stopped the agent bus',
    'control.resume': () => 'You resumed the agent bus',
  };
  let busy = false, generation = 0;

  async function act(button, fn, ok) {
    if (busy) return;
    busy = true; button.disabled = true;
    let r;
    try { r = await fn(); } catch { r = null; }
    busy = false; button.disabled = false;
    status.textContent = r && r.ok ? ok : 'That did not work. Try again.';
    void refresh();
  }

  function render(r) {
    const rows = (r?.events || []).filter((e) => LINE[e.kind]).slice(0, 30);
    section.hidden = !r || r.available === false || (!rows.length && !r.halted);
    if (section.hidden) return out.replaceChildren();
    const head = node('div', null, 'row-actions');
    head.append(node('span', r.halted ? 'Stopped: nothing new starts until you resume.' : 'Running: handoffs start on their own in the repositories you turned on.', 'muted'));
    const b = node('button', r.halted ? 'Resume agent bus' : 'Stop agent bus', r.halted ? 'primary' : '');
    b.type = 'button';
    b.addEventListener('click', () => void (r.halted ? act(b, api.busResume, 'Resumed.') : act(b, api.busHalt, 'Stopped. Every handed-off run was stopped.')));
    head.append(b);
    const list = node('ul', null, 'mail-list');
    for (const e of rows) {
      const li = node('li', null, 'mail-item');
      li.append(node('p', LINE[e.kind](e)));
      const meta = [e.card_id ? `Card ${e.card_id}` : '', e.hop ? `hop ${e.hop}` : ''].filter(Boolean).join(' · ');
      if (meta) li.append(node('p', meta, 'muted'));
      list.append(li);
    }
    out.replaceChildren(head, list);
  }

  async function refresh() {
    const request = ++generation;
    let r;
    try { r = await api.busList(); } catch { r = null; }
    if (request !== generation || busy) return;
    render(r);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
  void refresh();
})();
