// Settings → Privacy → Your data. A file of its own so the block can move with
// the Settings split; text goes in with textContent only. Main side:
// src/data-rights-main.js.
(function () {
  const api = window.settingsApi;
  const $ = (id) => document.getElementById(id);
  const block = $('data-rights');
  if (!block || !api || !api.dataInventory) return;
  const say = (text, err) => { $('data-status').textContent = text; $('data-status').dataset.state = err ? 'err' : ''; };

  // Its own controls: the page-wide change listener must not save the config.
  block.addEventListener('change', (e) => e.stopPropagation());

  function size(n) {
    if (!n) return '0 KB';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  let stores = [];
  function render(inv) {
    stores = inv.stores.filter((s) => s.files > 0);
    const list = $('data-list');
    list.replaceChildren(...stores.map((s) => {
      const li = el('li');
      const text = el('div', 'text');
      text.append(el('div', 'name', s.label), el('div', 'what', s.problem ? `${s.detail} Left alone: the folder is ${s.problem}.` : s.detail));
      li.append(text, el('span', 'size', size(s.bytes)));
      return li;
    }));
    if (!stores.length) list.append(el('li', 'what', 'Nothing yet.'));
    $('data-total').textContent = `${stores.length} kinds of data, ${size(stores.reduce((a, s) => a + s.bytes, 0))} in all.`;
    const pick = $('data-pick');
    pick.replaceChildren(...stores.filter((s) => s.deletable).map((s) => {
      const label = el('label', 'row');
      const box = el('input');
      box.type = 'checkbox';
      box.value = s.id;
      label.append(box, el('span', 'name', s.label), el('span', 'size', size(s.bytes)));
      return label;
    }));
    const r = inv.lastReceipt;
    $('data-receipt').textContent = r && r.deletedAt ? `Last deletion: ${new Date(r.deletedAt).toLocaleString()}, ${r.stores.filter((s) => s.status === 'deleted').length} of ${r.stores.length} kinds deleted. The receipt is in the data folder.` : '';
    if (inv.pending) say('A deletion is waiting for Plexiform to restart.');
    update();
  }

  const chosen = () => [...$('data-pick').querySelectorAll('input:checked')].map((b) => b.value);
  function update() {
    $('data-delete-go').disabled = !(chosen().length && $('data-confirm').value.trim().toLowerCase() === 'delete');
  }

  async function refresh() {
    const inv = await api.dataInventory().catch(() => null);
    if (inv && Array.isArray(inv.stores)) render(inv);
  }

  $('data-pick').addEventListener('change', update);
  $('data-confirm').addEventListener('input', update);
  $('data-pick-all').addEventListener('click', () => {
    const boxes = [...$('data-pick').querySelectorAll('input')];
    const all = boxes.every((b) => b.checked);
    for (const b of boxes) b.checked = !all;
    update();
  });
  $('data-export').addEventListener('click', async () => {
    say('Exporting…');
    const r = await api.dataExport().catch((err) => ({ error: err.message }));
    say(!r ? '' : r.error ? `Could not export: ${r.error}` : r.path ? `Saved ${r.stores} kinds of data to ${r.path}. README.txt there lists what is in it.` : '', !!r?.error);
  });
  $('data-export-activity').addEventListener('click', async () => {
    const r = await api.dataExportActivity().catch((err) => ({ error: err.message }));
    say(!r ? '' : r.error ? `Could not export: ${r.error}` : r.path ? `Saved ${r.path}` : '', !!r?.error);
  });
  $('data-delete-go').addEventListener('click', async () => {
    const ids = chosen();
    $('data-delete-go').disabled = true;
    const r = await api.dataDelete({ ids, confirm: $('data-confirm').value }).catch((err) => ({ error: err.message }));
    if (!r || r.error) { say(r ? r.error : 'Could not delete.', true); update(); return; }
    $('data-confirm').value = '';
    say(r.restart ? 'Plexiform will quit, delete what you chose and start again.' : 'Recorded. It is deleted the next time Plexiform starts.');
  });
  $('data-delete').addEventListener('toggle', () => { if ($('data-delete').open) refresh(); });
  refresh();
})();
