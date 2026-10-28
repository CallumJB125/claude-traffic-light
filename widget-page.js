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
    $('snap').value = c.widgetSnap || 'corners';
    $('wsize').value = c.widgetSize || 'normal';
    if (document.activeElement !== $('shortcut')) $('shortcut').value = c.widgetShortcut || '';
    // The task box's shortcut (off unless turned on): main says what it registered and why not.
    if (document.activeElement !== $('compose-shortcut')) $('compose-shortcut').value = c.composeShortcut || '';
    if (s.compose) {
      $('compose-shortcut-on').textContent = `Turn on ${s.compose.suggestedLabel}`;
      $('compose-shortcut-on').hidden = !!c.composeShortcut;
      $('compose-shortcut-hint').textContent = `${s.compose.editorNote} Home and the menu bar's New task… work without it.`;
      $('compose-shortcut-note').textContent = s.compose.line || '';
    }
    // QoL3a: the next-waiting key (off unless set); main says why it isn't registered.
    if (document.activeElement !== $('next-shortcut')) $('next-shortcut').value = c.nextShortcut || '';
    if (s.next) $('next-shortcut-note').textContent = s.next.line || '';
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
  $('snap').addEventListener('change', () => send(api.set({ widgetSnap: $('snap').value }), 'where-note'));
  $('wsize').addEventListener('change', () => send(api.set({ widgetSize: $('wsize').value }), 'size-note'));
  const composeSaved = (r) => { $('compose-shortcut-note').textContent = r && r.ok ? (r.state?.compose?.line || '') : 'That shortcut is not one the system accepts. Try something like CmdOrCtrl+Shift+Space.'; };
  $('compose-shortcut-save').addEventListener('click', () => send(api.set({ composeShortcut: $('compose-shortcut').value.trim() }), 'compose-shortcut-note').then(composeSaved));
  $('compose-shortcut-on').addEventListener('click', () => { if (st?.compose) send(api.set({ composeShortcut: st.compose.suggested }), 'compose-shortcut-note').then(composeSaved); });
  $('next-shortcut-save').addEventListener('click', () => send(api.set({ nextShortcut: $('next-shortcut').value.trim() }), 'next-shortcut-note').then((r) => {
    $('next-shortcut-note').textContent = r && r.ok ? (r.state?.next?.line || '') : 'That shortcut is not one the system accepts. Try something like CmdOrCtrl+Shift+J.';
  }));
  $('shortcut-save').addEventListener('click', () => send(api.set({ widgetShortcut: $('shortcut').value.trim() }), 'where-note').then((r) => {
    if (r && !r.ok) $('where-note').textContent = 'That shortcut is not one the system accepts. Try something like CmdOrCtrl+Shift+Space.';
  }));

  // One swatch per project a session has run in lately; main lists them.
  let coloursKey = null;
  function paintColours(list) {
    const key = JSON.stringify(list);
    if (key === coloursKey) return;
    coloursKey = key;
    const box = $('colours');
    $('colours-empty').hidden = list.length > 0;
    box.replaceChildren(...list.map((p) => {
      const label = document.createElement('label');
      const pick = document.createElement('input');
      pick.type = 'color';
      pick.value = p.colour || '#7a7a85';
      pick.setAttribute('aria-label', `Colour for ${p.name}`);
      pick.addEventListener('change', () => send(api.set({ projectColours: { [p.name]: pick.value } }), 'colours-note').then(loadColours));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;
      label.append(pick, name);
      if (p.colour) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'link';
        clear.textContent = 'Clear';
        clear.addEventListener('click', (e) => { e.preventDefault(); send(api.set({ projectColours: { [p.name]: null } }), 'colours-note').then(loadColours); });
        label.append(clear);
      }
      return label;
    }));
  }
  const loadColours = () => (api.recentProjects ? api.recentProjects() : Promise.resolve([])).then((l) => paintColours(Array.isArray(l) ? l : [])).catch(() => {});
  $('lights').addEventListener('click', () => api.open('lights'));
  $('prefs').addEventListener('click', () => api.open('settings'));

  // Only while the page is on screen: the preview is a capture of the widget's window.
  function sync() {
    for (const t of timers) clearInterval(t);
    timers = [];
    if (document.hidden) return;
    refresh().then(shoot);
    loadColours();
    timers = [setInterval(refresh, STATE_MS), setInterval(shoot, PREVIEW_MS)];
  }
  document.addEventListener('visibilitychange', sync);
  sync();
  // In the Settings sheet (preview): a link back, and a fresh read when the sheet shows this page again (another pane may have changed a setting).
  if (new URLSearchParams(location.search).get('sheet') === '1') {
    $('back-settings').hidden = false;
    $('back-settings').addEventListener('click', () => api.goPane?.('widget'));
    api.onShown?.(() => { refresh(); loadColours(); });
  }
})();
