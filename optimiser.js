// Draws the view model main pushes. textContent only; no HTML from anywhere.
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.optimiserApi;
  if (!api) return;

  function render(s) {
    const empty = s.mode === 'empty';
    $('loading').hidden = empty;
    $('empty').hidden = !empty;
    $('chip').hidden = !s.chip;
    if (s.chip) { $('chip').dataset.tone = s.chip.tone; $('chip-text').textContent = s.chip.label; }
    $('browser').hidden = !s.canBrowser;
    if (!empty) return;
    $('headline').textContent = s.headline;
    $('detail').textContent = s.detail;
    $('docs').hidden = !s.docs;
    const box = $('actions');
    box.textContent = '';
    for (const a of s.actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      b.addEventListener('click', async () => {
        const r = await api.act(a.kind).catch(() => ({ ok: false, error: 'Something went wrong.' }));
        $('note').textContent = r && r.cancelled ? 'Cancelled. Nothing changed.' : r && r.ok ? 'Started in Terminal. This page updates when Burst answers.' : (r && r.error) || '';
      });
      box.append(b);
    }
  }

  $('refresh').addEventListener('click', () => { $('note').textContent = ''; api.refresh(); });
  $('browser').addEventListener('click', () => { api.openBrowser(); });
  $('docs').addEventListener('click', () => api.openDocs());
  api.onState(render);
  api.ready();
})();
