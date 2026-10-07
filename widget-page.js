// Widget page: draws what main reports and sends back only fixed requests. No state of its own.
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.widgetPageApi;
  if (!api) return;

  const STATE_MS = 2000;
  const PREVIEW_MS = 1000;
  let st = null;
  let timers = [];
  let dragging = false;

  function paint(s) {
    if (!s) return;
    st = s;
    const c = s.config;
    $('chip').dataset.tone = s.visible ? 'green' : '';
    $('chip-text').textContent = s.visible ? 'On screen' : c.showWidget ? 'Starting…' : 'Hidden';
    $('toggle').textContent = c.showWidget ? 'Hide widget' : 'Show widget';
    $('toggle').className = c.showWidget ? '' : 'primary';
    for (const box of document.querySelectorAll('input[data-key]')) box.checked = !!c[box.dataset.key];
    for (const box of document.querySelectorAll('input[data-kind]')) { box.checked = !!c.agentKinds[box.dataset.kind]; box.disabled = !c.showAgents; }
    $('chips').value = c.agentChipSize;
    const size = $('size');
    size.min = String(s.limits.minWidth);
    size.max = String(s.limits.maxWidth);
    size.disabled = s.width === null || s.held;
    if (!dragging && s.width !== null) size.value = String(s.width);
    $('size-label').textContent = s.width === null ? '' : `${dragging ? size.value : s.width} px`;
    for (const b of document.querySelectorAll('.corner')) { b.setAttribute('aria-pressed', String(b.dataset.corner === s.corner)); b.disabled = !s.visible || s.held; }
    if (!s.visible) showShot(null);
  }

  function showShot(url) {
    const stage = $('stage');
    let img = stage.querySelector('img');
    $('off').hidden = !!url;
    $('off').textContent = st && st.config.showWidget ? 'The widget is starting.' : 'The widget is hidden. Show it to see it here.';
    if (!url) { if (img) img.remove(); return; }
    if (!img) { img = document.createElement('img'); img.alt = 'The floating widget as it looks now'; stage.prepend(img); }
    if (img.src !== url) img.src = url;
  }

  const refresh = () => api.state().then(paint).catch(() => {});
  const shoot = () => { if (st && st.visible) api.preview().then(showShot).catch(() => {}); };

  async function send(p, note) {
    const r = await p.catch(() => ({ ok: false, error: 'Something went wrong.' }));
    if (r && r.state) paint(r.state);
    $(note).textContent = r && r.ok ? '' : (r && r.error) || '';
    return r;
  }

  $('toggle').addEventListener('click', () => { if (st) send(api.set({ showWidget: !st.config.showWidget }), 'where-note').then(() => setTimeout(refresh, 400)); });
  for (const box of document.querySelectorAll('input[data-key]')) box.addEventListener('change', () => send(api.set({ [box.dataset.key]: box.checked }), box.dataset.key === 'menuBarMode' ? 'where-note' : 'shows-note'));
  for (const box of document.querySelectorAll('input[data-kind]')) box.addEventListener('change', () => send(api.set({ agentKinds: { [box.dataset.kind]: box.checked } }), 'shows-note'));
  $('chips').addEventListener('change', () => send(api.set({ agentChipSize: $('chips').value }), 'size-note'));
  $('size').addEventListener('input', () => { dragging = true; $('size-label').textContent = `${$('size').value} px`; });
  $('size').addEventListener('change', () => { dragging = false; send(api.size(Number($('size').value)), 'size-note'); });
  for (const b of document.querySelectorAll('.corner')) b.addEventListener('click', () => send(api.move(b.dataset.corner), 'where-note'));
  $('lights').addEventListener('click', () => api.open('lights'));
  $('prefs').addEventListener('click', () => api.open('settings'));

  // Only while the page is on screen: the preview is a capture of the widget's window.
  function sync() {
    for (const t of timers) clearInterval(t);
    timers = [];
    if (document.hidden) return;
    refresh().then(shoot);
    timers = [setInterval(refresh, STATE_MS), setInterval(shoot, PREVIEW_MS)];
  }
  document.addEventListener('visibilitychange', sync);
  sync();
})();
