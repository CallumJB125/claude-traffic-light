// The Usage & cost page's cost guard callouts (src/spend-enforce.js through
// lightsApi.costGuard): the monthly receipt, the enforce switches and the
// waste findings, each with the transcript line it came from. File paths and
// project names are user data, so everything is textContent, never innerHTML.
//
//   UsageWasteView.render(container, api, { force })
(function () {
  const REFRESH_MS = 60000;
  const MAX_SHOWN = 8;
  let at = 0;
  let busy = false;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
  const range = (lo, hi) => (money(lo) === money(hi) ? money(hi) : `${money(lo)}–${money(hi)}`);
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  const where = (ev) => (ev || []).slice(0, 3).map((x) => `${x.file}:L${x.line} (turn ${x.turn})`).join(', ');

  function finding(f) {
    if (f.kind === 'reread') return `${base(f.path)} was read ${f.count} times with no edit in between${f.approxTokens ? ` (about ${f.approxTokens.toLocaleString('en-US')} tokens re-sent)` : ''}`;
    if (f.kind === 'failloop') return `${f.tool} failed the same way ${f.count} times in a row`;
    return `${f.count} of ${f.of} Opus turns${f.project ? ` in ${f.project}` : ''} looked routine: about ${range(f.saving.low, f.saving.high)} less on Sonnet`;
  }

  function receiptCard(r) {
    const card = el('section', 'mix-card cg-card');
    card.append(el('div', 'k', `Receipt · ${r.month}`), el('div', 'mix-rec cg-head', r.headline));
    if (r.teaser) {
      card.append(el('div', 'note', `Source: ${r.source}.`));
    } else {
      card.append(el('div', 'note', `${r.saved.runawaysStopped} runaway session${r.saved.runawaysStopped === 1 ? '' : 's'} stopped, ${r.saved.capsHeld} budget cap${r.saved.capsHeld === 1 ? '' : 's'} held. Source: ${r.saved.source}. ${r.saved.method}`));
      if (r.couldSave.line) card.append(el('div', 'mix-rec', r.couldSave.line), el('div', 'note', `Source: ${r.couldSave.source}. ${r.couldSave.method}`));
    }
    if (r.burst) card.append(el('div', 'mix-rec', r.burst.line), el('div', 'note', `Source: ${r.burst.source}.`));
    if (r.teaser) card.append(el('div', 'note', 'The full receipt, waste callouts and enforced caps come with Plexiform Plus.'));
    return card;
  }

  function enforceCard(e, api, rerender) {
    const card = el('section', 'mix-card cg-card');
    card.append(el('div', 'k', 'Cost guard'));
    const row = (key, label) => {
      const id = `cg-${key}`;
      const box = el('input');
      box.type = 'checkbox'; box.id = id; box.checked = !!e.settings[key];
      box.addEventListener('change', async () => {
        box.disabled = true;
        try { await api.costGuard.set({ [key]: box.checked }); } catch { box.checked = !box.checked; }
        box.disabled = false;
        rerender();
      });
      const lbl = el('label', 'cg-row');
      lbl.htmlFor = id;
      lbl.append(box, document.createTextNode(` ${label}`));
      return lbl;
    };
    card.append(row('enforceCaps', 'Enforce my limit: refuse Claude Code tool calls once the daily or weekly limit is spent'),
      row('stopRunaways', 'Stop runaway sessions: refuse their tool calls, and interrupt sessions Plexiform started'));
    const status = e.capActive ? 'Your limit is spent: tool calls are being refused.' : e.sessionsStopped ? `${e.sessionsStopped} runaway session${e.sessionsStopped === 1 ? ' is' : 's are'} being held.` : 'Nothing is being refused right now.';
    card.append(el('div', 'note', `${status} If Plexiform stops updating, Claude Code carries on as normal.`));
    return card;
  }

  function wasteCard(w) {
    const card = el('section', 'mix-card cg-card');
    card.append(el('div', 'k', `Waste · last ${w.days} days`));
    if (!w.findings.length) { card.append(el('div', 'mix-rec', `Nothing wasteful found in ${w.files} transcript${w.files === 1 ? '' : 's'}.`)); return card; }
    const list = el('ol', 'cg-list');
    for (const f of w.findings.slice(0, MAX_SHOWN)) {
      const li = el('li');
      li.append(el('div', null, finding(f)), el('div', 'note', where(f.evidence)));
      list.append(li);
    }
    card.append(list);
    if (w.findings.length > MAX_SHOWN) card.append(el('div', 'note', `${w.findings.length - MAX_SHOWN} more not shown.`));
    card.append(el('div', 'note', 'From your Claude Code transcripts on this computer. Rereads count the same file slice read 4+ times with no edit between; loops count the same call failing 3+ times in a row.'));
    return card;
  }

  async function render(container, api, { force = false } = {}) {
    if (!container || !api || !api.costGuard || busy) return;
    if (!force && Date.now() - at < REFRESH_MS) return;
    busy = true;
    at = Date.now();
    let r = null;
    try { r = await api.costGuard.report(); } catch { r = null; }
    busy = false;
    if (!r) { container.hidden = true; return; }
    const again = () => render(container, api, { force: true });
    const parts = [];
    if (r.receipt) parts.push(receiptCard(r.receipt));
    if (r.enforce && r.enforce.available) parts.push(enforceCard(r.enforce, api, again));
    if (r.waste) parts.push(wasteCard(r.waste));
    container.replaceChildren(...parts);
    container.hidden = !parts.length;
  }

  window.UsageWasteView = { render };
})();
