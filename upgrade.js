// Upgrade page: the plan this install has, its limits, days left in the
// offline grace, and links to the hosted Checkout / billing portal (opened by
// main in the system browser). Text only via textContent.
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.plan;
  const LIMIT_NAMES = {
    'checkpoints.turns': 'Checkpoints kept (turns)', 'checkpoints.days': 'Checkpoint retention (days)', 'memory.days': 'Search history (days)',
    devices: 'Synced devices', 'sync.bytes': 'Sync storage', 'billing.months': 'Client billing history (months)', receipt: 'Monthly receipt',
  };
  const bytes = (v) => (typeof v === 'number' && v >= 1024 ** 3 ? `${Math.round(v / 1024 ** 3)} GB` : String(v));
  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  function show(s) {
    if (!s) return;
    $('plan').textContent = s.planName;
    $('banner').hidden = !s.banner;
    $('banner').textContent = s.banner || '';
    $('detail').textContent = s.plan === 'free'
      ? (s.signedIn ? 'Upgrade to Plus for unlimited checkpoints, full search history, phone control and more.' : 'Sign in to your team hub (Account) to upgrade.')
      : s.inGrace ? `Paid period ended ${day(s.periodEnd)}; ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left to confirm it.`
        : s.periodEnd ? `Paid through ${day(s.periodEnd)}.` : '';
    const paid = s.plan !== 'free';
    $('upgrade-month').hidden = paid || !s.signedIn;
    $('upgrade-year').hidden = paid || !s.signedIn;
    $('manage').hidden = !paid || !s.signedIn;
    $('refresh').hidden = !s.signedIn;
    const list = $('limits');
    list.replaceChildren();
    for (const [k, v] of Object.entries(s.limits || {})) {
      const dt = document.createElement('dt'); dt.textContent = LIMIT_NAMES[k] || k;
      const dd = document.createElement('dd'); dd.textContent = k === 'sync.bytes' ? bytes(v) : String(v);
      list.append(dt, dd);
    }
  }

  async function act(fn, note) {
    $('note').textContent = note;
    const r = await fn().catch(() => null);
    if (r && r.ok === false && r.reason === 'signed-out') $('note').textContent = 'Sign in to your team hub first.';
    else if (r && r.ok === false) $('note').textContent = "Couldn't reach your team hub. Try again later.";
    else $('note').textContent = '';
  }

  if (!api) return;
  $('upgrade-month').addEventListener('click', () => act(() => api.upgrade('month'), 'Opening checkout in your browser…'));
  $('upgrade-year').addEventListener('click', () => act(() => api.upgrade('year'), 'Opening checkout in your browser…'));
  $('manage').addEventListener('click', () => act(() => api.manage(), 'Opening billing in your browser…'));
  $('refresh').addEventListener('click', async () => { $('note').textContent = 'Checking…'; show(await api.refresh().catch(() => null)); $('note').textContent = ''; });
  window.addEventListener('focus', () => api.state().then(show).catch(() => {}));
  api.state().then(show).catch(() => {});
})();
