'use strict';
const api = window.aiToolsApi;
const $ = (id) => document.getElementById(id);
const list = $('list'), status = $('status'), allBox = $('all-preview'), allBtn = $('connect-all');
const node = (tag, text, className) => { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; };
let snap = null, focusId = null, scrolled = false, busy = false;
const results = new Map();     // row id -> { ok, text }
const previews = new Map();    // row id -> preview payload

function diffBlock(file) {
  const pre = node('pre', '', 'diff');
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', `Changes to ${file.file}`);
  pre.append(node('div', file.file + (file.existed ? '' : ' (new file)'), 'gap'));
  for (const l of file.lines) pre.append(node('div', `${l.kind === 'add' ? '+ ' : '- '}${l.text}`, l.kind));
  if (file.unchanged) pre.append(node('div', `… ${file.unchanged} unchanged line${file.unchanged === 1 ? '' : 's'}`, 'gap'));
  return pre;
}
function previewBlock(row, p, onConfirm, onCancel, confirmLabel) {
  const box = node('div', '', 'preview');
  if (!p.ok) {
    box.append(node('p', p.error, 'error'));
    const again = node('button', 'Check again'); again.type = 'button'; again.addEventListener('click', onCancel);
    box.append(again);
    return box;
  }
  if (p.already) box.append(node('p', 'Already connected. Nothing to change.'));
  for (const f of p.files) {
    box.append(diffBlock(f));
    if (f.backup) box.append(node('p', `A copy of the file is saved first as ${f.backup.replace('<time>', 'the time')}. Undo restores it.`, 'muted'));
    else box.append(node('p', 'This file does not exist yet; Undo removes it again.', 'muted'));
  }
  for (const s of p.steps || []) box.append(node('p', s));
  const go = node('button', confirmLabel || 'Confirm and connect', 'primary'); go.type = 'button'; go.disabled = !!p.already;
  const no = node('button', 'Cancel'); no.type = 'button';
  go.addEventListener('click', onConfirm); no.addEventListener('click', onCancel);
  const bar = node('div', '', 'row-actions'); bar.append(go, no); box.append(bar);
  return box;
}

async function act(fn) {
  if (busy) return; busy = true;
  try { await fn(); } catch { status.textContent = 'Something went wrong. Nothing was changed.'; }
  finally { busy = false; }
}

async function run(row, action) {
  const id = row.id;
  if (action === 'install') return api.openInstall(id);
  if (action === 'copy') { const ok = await api.copy(row.command); results.set(id, { ok, text: ok ? 'Copied.' : 'Could not copy.' }); return draw(); }
  if (action === 'fix-custom') { const r = await api.fixRunner(); results.set(id, { ok: r.ok, text: r.ok ? r.message : r.error }); return refresh(); }
  if (action === 'disconnect') { const r = await api.disconnect(id); results.set(id, { ok: r.ok, text: r.ok ? r.message : r.error }); previews.delete(id); return refresh(); }
  // connect / reconnect / fix: show exactly what will be written first.
  results.delete(id);
  previews.set(id, await api.preview(id));
  draw();
}
async function confirm(row) {
  const r = await api.connect(row.id);
  previews.delete(row.id);
  results.set(row.id, { ok: r.ok, text: r.ok ? r.message : r.error });
  await refresh();
}

function rowEl(row) {
  const el = node('section', '', `tool${row.id === focusId ? ' focus' : ''}`);
  el.id = `tool-${row.id.replace(/[^a-z0-9-]/gi, '_')}`;
  const top = node('div', '', 'top');
  const name = node('div', '', 'name');
  name.append(node('h3', row.label));
  if (row.version) name.append(node('span', `v${row.version}`, 'muted'));
  name.append(node('span', { connected: 'Connected', ready: 'Not connected', reconnect: 'Needs reconnecting', fix: 'Needs a fix', missing: 'Not installed' }[row.state], `pill ${row.state}`));
  const acts = node('div', '', 'row-actions');
  const btn = node('button', row.primary.label, row.primary.action === 'connect' || row.primary.action === 'reconnect' ? 'primary' : ''); btn.type = 'button';
  btn.addEventListener('click', () => act(() => run(row, row.primary.action)));
  acts.append(btn);
  if (row.canUndo) { const u = node('button', 'Undo'); u.type = 'button'; u.addEventListener('click', () => act(async () => { const r = await api.undo(row.id); results.set(row.id, { ok: r.ok, text: r.ok ? r.message : r.error }); await refresh(); })); acts.append(u); }
  if (row.kind === 'custom') { const rm = node('button', 'Remove'); rm.type = 'button'; rm.addEventListener('click', () => act(async () => { await api.removeCustom(row.label); await refresh(); })); acts.append(rm); }
  top.append(name, acts);
  el.append(top);
  if (row.state === 'missing') { el.classList.add('compact'); return el; }
  el.append(node('p', row.detail, row.error ? 'error' : 'muted'));
  if (row.installed) el.append(node('p', `Last event: ${row.lastEvent.text}`, 'muted'));
  if (row.note) el.append(node('p', row.note, 'muted'));
  if (row.chips.length) { const ul = node('ul', '', 'chips'); ul.setAttribute('aria-label', 'What Plexiform shows for this tool'); for (const c of row.chips) ul.append(node('li', c)); el.append(ul); }
  const p = previews.get(row.id);
  if (p) el.append(previewBlock(row, p, () => act(() => confirm(row)), () => { previews.delete(row.id); row.state === 'fix' ? act(refresh) : draw(); }, row.state === 'reconnect' ? 'Confirm and reconnect' : undefined));
  const res = results.get(row.id);
  if (res) { const r = node('p', res.text, `result ${res.ok ? '' : 'error'}`); r.setAttribute('role', res.ok ? 'status' : 'alert'); el.append(r); }
  return el;
}

function draw() {
  if (!snap) return;
  list.replaceChildren(...[...snap.rows].sort((a, b) => (a.state === 'missing') - (b.state === 'missing')).map(rowEl));
  const found = snap.rows.filter((r) => r.kind === 'tool' && r.installed);
  const names = found.map((r) => r.label);
  allBtn.hidden = !snap.pending.length;
  status.textContent = !found.length ? 'No AI tools found on this Mac yet. Install one below, then check again.'
    : snap.pending.length ? `Found ${names.join(', ')}. ${snap.pending.length} not connected yet.` : `Found ${names.join(', ')}. All connected.`;
  if (focusId && !scrolled) { scrolled = true; document.getElementById(`tool-${focusId}`)?.scrollIntoView({ block: 'center' }); }
}

async function refresh() { snap = await api.scan(); draw(); }

allBtn.addEventListener('click', () => act(async () => {
  const boxes = [];
  for (const id of snap.pending) {
    const row = snap.rows.find((r) => r.id === id);
    boxes.push([row, await api.preview(id)]);
  }
  allBox.replaceChildren(node('h2', 'Connect all detected'), node('p', 'This is exactly what will be added. Nothing is written until you confirm.', 'muted'));
  for (const [row, p] of boxes) { allBox.append(node('h3', row.label)); allBox.append(p.ok ? (() => { const d = node('div'); for (const f of p.files) d.append(diffBlock(f)); for (const s of p.steps || []) d.append(node('p', s)); return d; })() : node('p', p.error, 'error')); }
  const go = node('button', `Confirm and connect ${boxes.length}`, 'primary'); go.type = 'button';
  const no = node('button', 'Cancel'); no.type = 'button';
  no.addEventListener('click', () => { allBox.hidden = true; });
  go.addEventListener('click', () => act(async () => {
    go.disabled = true;
    const r = await api.connectAll();
    allBox.hidden = true;
    for (const x of r.results) results.set(x.id, { ok: x.ok, text: x.ok ? x.message : x.error });
    const summary = r.results.map((x) => `${snap.rows.find((q) => q.id === x.id)?.label || x.id}: ${x.ok ? 'connected' : 'not connected'}`).join(' · ');
    snap = await api.scan(); draw();
    status.textContent = summary;
  }));
  const bar = node('div', '', 'row-actions'); bar.append(go, no); allBox.append(bar);
  allBox.hidden = false;
  allBox.scrollIntoView({ block: 'nearest' });
}));

$('refresh').addEventListener('click', () => act(async () => { previews.clear(); results.clear(); await refresh(); }));
$('custom-form').addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => {
    const r = await api.addCustom($('custom-name').value, $('custom-command').value);
    const out = $('custom-status');
    out.className = r.ok ? 'muted' : 'error';
    out.textContent = r.ok ? `Added. Run it as: ${r.command}${r.onPath ? '' : ' (add ~/.local/bin to your PATH to type just plexiform-run)'}` : r.error;
    if (r.ok) { $('custom-name').value = ''; $('custom-command').value = ''; await refresh(); }
  });
});

async function takeFocus() {
  const f = await api.focus();
  if (!f) return;
  if (f === 'all') { if (snap?.pending.length) allBtn.click(); return; }
  focusId = f; scrolled = false; draw();
}
api.onChanged(() => { if (!busy && !previews.size) refresh().catch(() => {}); });
window.addEventListener('focus', () => { takeFocus().catch(() => {}); });
refresh().then(takeFocus).catch(() => { status.textContent = 'Could not look for tools. Try Check again.'; });
