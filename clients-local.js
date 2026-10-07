'use strict';
const api = window.clientsApi;
const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined && text !== '') el.textContent = text; if (className) el.className = className; return el; };
const button = (text, onClick) => { const b = node('button', text); b.type = 'button'; b.addEventListener('click', onClick); return b; };
let snap = null, folders = [];
const UNMAPPED = '__unmapped';
const usd = (n) => `$${Number(n).toFixed(2)}`;
const iso = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const say = (el, text, bad) => { el.textContent = text; el.classList.toggle('error', !!bad); };

async function persist(store) { snap = await api.save(store); render(); }

function option(select, value, text) { const o = node('option', text); o.value = value; select.append(o); }

function render() {
  const { store } = snap;
  say($('status'), store.clients.length ? '' : 'Add a client to start.');
  const box = $('clients');
  box.replaceChildren();
  for (const c of store.clients) {
    const el = node('div', '', 'client');
    const top = node('div', '', 'top');
    top.append(node('strong', c.name), button('Remove', () => persist({ clients: store.clients.filter((x) => x.id !== c.id), mappings: store.mappings.filter((m) => m.clientId !== c.id) })));
    el.append(top);
    const ul = node('ul');
    for (const m of store.mappings.filter((x) => x.clientId === c.id)) {
      const li = node('li');
      li.append(node('code', m.path), button('Unmap', () => persist({ ...store, mappings: store.mappings.filter((x) => x !== m) })));
      ul.append(li);
    }
    if (!ul.children.length) ul.append(node('li', 'No folders yet.', 'muted'));
    el.append(ul);
    const rates = node('div', '', 'rates');
    for (const [key, label, step] of [['markupPct', 'Markup %', '1'], ['hourlyRate', 'Per hour (USD)', '0.01'], ['sessionFee', 'Per session (USD)', '0.01']]) {
      const lab = node('label', label);
      const inp = node('input'); inp.type = 'number'; inp.min = '0'; inp.step = step; inp.value = c.rate[key] || '';
      inp.disabled = !snap.rateCards;
      inp.addEventListener('change', () => persist({ ...store, clients: store.clients.map((x) => (x.id === c.id ? { ...x, rate: { ...x.rate, [key]: Number(inp.value) || 0 } } : x)) }));
      lab.append(inp); rates.append(lab);
    }
    el.append(rates);
    if (!snap.rateCards) el.append(node('p', 'Rate cards are part of the paid plan; the export shows cost with no markup.', 'muted'));
    box.append(el);
  }
  const mc = $('map-client'), fc = $('f-client'), prev = fc.value;
  mc.replaceChildren(); fc.replaceChildren();
  option(fc, '', 'All clients, with Unmapped');
  for (const c of store.clients) { option(mc, c.id, c.name); option(fc, c.id, c.name); }
  option(fc, UNMAPPED, 'Unmapped only');
  if ([...fc.options].some((o) => o.value === prev)) fc.value = prev;
  const mf = $('map-folder');
  mf.replaceChildren();
  for (const f of folders) option(mf, f, f);
  $('pdf').disabled = !snap.pdf;
  $('pdf').title = snap.pdf ? '' : 'PDF export is part of the paid plan';
  say($('plan-note'), snap.months ? `Your plan covers the current month only (CSV). Full history, PDF and rate cards are on the paid plan.` : '');
}

const request = () => ({ clientId: $('f-client').value || null, from: Date.parse(`${$('f-from').value}T00:00:00`), to: Date.parse(`${$('f-to').value}T23:59:59.999`) });

async function preview() {
  const p = await api.preview(request());
  if (!p) return;
  say($('basis'), p.basis);
  $('basis').textContent = p.basis === 'API-equivalent estimate' ? `${p.basis}: you are on a subscription, so this is not what anyone was charged` : p.basis;
  const sum = $('summary');
  sum.replaceChildren(node('p', `${p.lineCount} line${p.lineCount === 1 ? '' : 's'} · cost ${usd(p.totals.cost)} · billed ${usd(p.totals.billed)}${p.clamped ? ' · range trimmed to the current month' : ''}${p.unpricedTurns ? ` · ${p.unpricedTurns} turn(s) on unpriced models left out` : ''}`));
  for (const b of p.byClient) sum.append(node('p', `${b.name}: cost ${usd(b.cost)}, billed ${usd(b.billed)}`, 'muted'));
  const tb = $('lines').tBodies[0];
  tb.replaceChildren();
  for (const l of p.lines) {
    const tr = node('tr');
    for (const [v, n] of [[l.date], [l.client], [l.project], [l.model], [l.input + l.output + l.cache, 1], [l.cost.toFixed(2), 1], [l.billed.toFixed(2), 1]]) tr.append(node('td', String(v), n ? 'n' : ''));
    tb.append(tr);
  }
  $('lines').hidden = !p.lines.length;
}

async function exportAs(format) {
  const r = await api.export(request(), format);
  if (r?.ok) say($('export-status'), `Saved to ${r.path}`);
  else if (r?.reason === 'plan') say($('export-status'), 'PDF export is part of the paid plan.', true);
  else if (r && r.reason !== 'canceled') say($('export-status'), 'Could not export.', true);
}

$('client-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('client-name').value.trim();
  if (!name) return;
  const id = `c${Math.random().toString(36).slice(2, 10)}`;
  $('client-name').value = '';
  persist({ ...snap.store, clients: [...snap.store.clients, { id, name, rate: { markupPct: 0, hourlyRate: 0, sessionFee: 0 } }] });
});
$('map-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const path = $('map-folder').value, clientId = $('map-client').value;
  if (!path || !clientId) return;
  persist({ ...snap.store, mappings: [...snap.store.mappings.filter((m) => m.path !== path), { path, clientId }] });
});
$('map-pick').addEventListener('click', async () => {
  const p = await api.pickFolder();
  if (p) { if (!folders.includes(p)) folders.unshift(p); render(); $('map-folder').value = p; }
});
$('refresh').addEventListener('click', preview);
$('f-client').addEventListener('change', preview);
$('csv').addEventListener('click', () => exportAs('csv'));
$('pdf').addEventListener('click', () => exportAs('pdf'));

(async () => {
  const now = new Date();
  $('f-from').value = iso(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
  $('f-to').value = iso(now.getTime());
  snap = await api.state();
  if (!snap) { say($('status'), 'Not available here.', true); return; }
  folders = await api.folders() || [];
  render();
  preview();
})();
