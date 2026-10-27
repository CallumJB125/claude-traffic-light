// "Your Claude limit" on the Usage page (src/spend-safety-main.js). On Pro or
// Max it shows an estimate of the 5-hour and weekly windows and hides the
// dollar sections, unless "Show what this would cost on the API" is ticked.
// Also: the projected-today line, project caps and retry loops. All text is
// set with textContent.
(() => {
  const api = window.lightsApi && window.lightsApi.spendSafety ? window.lightsApi.spendSafety : null;
  const before = document.getElementById('mix-loading');
  if (!api || !before) return;
  const sec = document.createElement('section');
  sec.id = 'usage-limit-estimate';
  sec.hidden = true;
  sec.setAttribute('aria-label', 'Your Claude limit');
  before.before(sec);
  const style = document.createElement('style');
  style.textContent = 'body.subscriber-view #budget-bar, body.subscriber-view #usage-where, body.subscriber-view #usage-work, body.subscriber-view #usage-waste, body.subscriber-view #mix-today-cost, body.subscriber-view #mix-week-cost { display: none !important; }'
    + ' #usage-limit-estimate .bar { height: 8px; border-radius: 4px; background: var(--line, #ddd); overflow: hidden; max-width: 320px; }'
    + ' #usage-limit-estimate .bar > i { display: block; height: 100%; background: #2fae3e; }'
    + ' #usage-limit-estimate .bar > i.amber { background: #e0a020; } #usage-limit-estimate .bar > i.red { background: #e2231a; }';
  document.head.append(style);
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };

  function meter(r) {
    const wrap = el('div');
    const bar = el('div', null, 'bar');
    const fill = el('i', null, r.band);
    fill.style.width = `${Math.min(100, r.percent)}%`;
    bar.append(fill);
    bar.setAttribute('role', 'meter');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(Math.min(100, r.percent)));
    bar.setAttribute('aria-label', r.text);
    wrap.append(el('div', `${r.text} (estimate)`), bar);
    return wrap;
  }

  function draw(v) {
    document.body.classList.toggle('subscriber-view', !!(v && v.subscriber && !v.showDollars));
    sec.hidden = !v;
    if (!v) return;
    const kids = [];
    if (v.subscriber && v.limits) {
      kids.push(el('h3', `How close you are to your ${v.limits.label} limit`), meter(v.limits.fiveHour), meter(v.limits.week), el('div', v.limits.note, 'note'));
      const lab = el('label', null, 'row');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = v.settings.showApiPrices;
      box.addEventListener('change', async () => { await api.set({ showApiPrices: box.checked }); load(); });
      lab.append(box, document.createTextNode(' Show what this would cost on the API'));
      kids.push(lab);
    }
    if (v.unknownPlan) {
      // Never a guessed plan's limit (A10): ask instead.
      const pick = el('button', 'Choose your plan', 'btn ghost');
      pick.type = 'button';
      pick.addEventListener('click', () => window.lightsApi.openPreferences && window.lightsApi.openPreferences());
      const line = el('div', 'Plexiform can’t tell which Claude plan you’re on, so it shows no plan limit. ', 'stats-sub');
      line.append(pick);
      kids.push(line);
    }
    if (v.showDollars && v.projected && v.projected.ready) kids.push(el('div', v.projected.text, 'stats-sub'));
    const over = v.projects.filter((p) => p.level);
    if (over.length) { const ul = el('ul'); for (const p of over) ul.append(el('li', p.text, p.level === 'over' ? 'limited' : null)); kids.push(el('div', 'Project caps', 'k'), ul); }
    if (v.loops.length) { const ul = el('ul'); for (const l of v.loops) ul.append(el('li', l.text, 'limited')); kids.push(el('div', 'Possible retry loops', 'k'), ul); }
    sec.hidden = !kids.length;
    sec.replaceChildren(...kids);
  }

  async function load() {
    if (document.hidden) return;
    try { draw(await api.get()); } catch { draw(null); }
  }
  document.addEventListener('visibilitychange', load);
  setInterval(load, 30000);
  load();
})();
