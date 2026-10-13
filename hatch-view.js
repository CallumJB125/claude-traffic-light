// The Hatch window: choices on the left, a live rig on the right. Every change
// asks main for a fresh character (the page only ever sends choices), registers
// it for the preview, and Save asks main to keep the one it last made.
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.hatch;
  const C = window.BuddyCharacters;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = { name: 'Hatchling', shape: 'round', size: 'medium', arms: 'two', accessory: 'none', color: '#e0885f' };
  let token = null;
  let currentId = 'claude';
  let rig = null;
  let seq = 0;
  let timer = null;
  const status = (text, ok) => { $('status').textContent = text || ''; $('status').className = ok ? 'ok' : ''; };

  function segmented(name, options) {
    const host = $(name);
    for (const o of options) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = name; input.value = o; input.checked = state[name] === o;
      input.addEventListener('change', () => { state[name] = o; refresh(); });
      const span = document.createElement('span');
      span.textContent = o;
      label.append(input, span);
      host.appendChild(label);
    }
  }
  function sync() {
    $('name').value = state.name; $('color').value = state.color;
    for (const k of ['shape', 'size', 'arms', 'accessory']) for (const i of document.querySelectorAll(`input[name="${k}"]`)) i.checked = i.value === state[k];
  }

  const LOOKS = [
    { lamp: 'green', pose: 'none', eyes: 'default' },
    { lamp: 'amber', pose: 'thumbs', eyes: 'happy' },
    { lamp: 'red', pose: 'banner', eyes: 'surprised', text: 'HELLO' },
    { lamp: 'green', pose: 'wave', eyes: 'heart' },
    { lamp: 'green', pose: 'none', eyes: 'default', costume: 'partyhat' },
  ];
  let look = 0;
  function show(id) {
    if (!rig) rig = window.mountRig($('stage'), {});
    rig.setLook({ ...LOOKS[look], body: id });
  }

  async function refresh() {
    const mine = ++seq;
    status('');
    let r;
    try { r = await api.generate({ ...state }); } catch { status('Could not make that one.'); return; }
    if (mine !== seq) return;
    if (!r || !r.character) { status('Could not make that one.'); return; }
    token = r.token;
    try { C.register(r.character); } catch { /* a saved character with this id shadows it in this window only */ }
    currentId = r.character.id;
    show(currentId);
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 120); };

  async function save() {
    $('save').disabled = true;
    try {
      const r = await api.save(token);
      if (r && r.ok) { status(`Saved as ${r.name}. Pick it in Lights, under Body, or share it to the gallery below.`, true); await loadShareList(r.id); }
      else status((r && r.error) || 'Could not save it.');
    } catch { status('Could not save it.'); }
    $('save').disabled = false;
  }

  // "Share to the gallery…": the saved characters (main's validated list) to pick from; the one just saved is selected.
  async function loadShareList(preferId) {
    if (!window.galleryPublish || !window.userCharacters) return;
    let list = [];
    try { list = (await window.userCharacters.list()) || []; } catch { list = []; }
    const pick = $('share-pick');
    pick.replaceChildren(...list.map((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; return o; }));
    if (preferId && list.some((c) => c.id === preferId)) pick.value = preferId;
    $('share-row').hidden = $('share-hint').hidden = !list.length;
  }

  async function describe() {
    const description = $('desc').value.trim();
    if (!description) { status('Write a short description first.'); $('desc').focus(); return; }
    $('describe').disabled = true;
    status(`Hatching with ${aiLabel}… this can take a minute.`);
    let r;
    try { r = await api.describe({ ...state, description }); } catch { r = { error: 'Could not hatch it.' }; }
    $('describe').disabled = false;
    if (!r || !r.character) { status((r && r.error) || 'Could not hatch it.'); return; }
    seq += 1;
    token = r.token;
    try { C.register(r.character); } catch { /* a saved character with this id shadows it in this window only */ }
    currentId = r.character.id;
    show(currentId);
    status(`${aiLabel} hatched it. Save to keep it; changing a choice below swaps it back to a drawn one.`, true);
  }

  let aiLabel = 'the AI';
  async function start() {
    const o = await api.options();
    segmented('shape', o.shapes); segmented('size', o.sizes); segmented('arms', o.arms); segmented('accessory', o.accessories);
    if (o.ai) {
      aiLabel = o.aiLabel || aiLabel;
      $('desc').disabled = false;
      $('desc-hint').textContent = `Sent to ${aiLabel} on this computer when you press the button. You are asked first.`;
      $('describe').textContent = `Describe it to ${aiLabel}`;
      $('describe-row').hidden = false;
      $('describe').addEventListener('click', describe);
    } else if (o.aiReason) $('desc-hint').textContent = o.aiReason;
    $('name').addEventListener('input', () => { state.name = $('name').value; later(); });
    $('color').addEventListener('input', () => { state.color = $('color').value; later(); });
    $('surprise').addEventListener('click', async () => { Object.assign(state, await api.surprise()); sync(); refresh(); });
    $('form').addEventListener('submit', (e) => { e.preventDefault(); save(); });
    $('close').textContent = new URLSearchParams(location.search).get('embedded') === '1' ? 'Back to widget configuration' : 'Close';
    $('close').addEventListener('click', () => api.close());
    $('share-gallery').addEventListener('click', () => {
      const id = $('share-pick').value;
      if (!id) return;
      window.galleryPublish.open({ kind: 'character', ref: id, onDone: (d) => { if (d.error) status(d.error); else if (d.opened) status('Opened GitHub with your character filled in. Press Propose changes there to open the pull request.', true); } });
    });
    await loadShareList();
    await refresh();
    if (!reduce) setInterval(() => { if (document.hidden) return; look = (look + 1) % LOOKS.length; if (token) show(currentId); }, 2600);
  }
  start();
})();
