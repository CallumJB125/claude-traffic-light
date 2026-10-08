'use strict';
const api = window.timelineApi;
const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
const pad = n => String(n).padStart(2, '0');
const clock = iso => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const day = iso => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const when = iso => (iso ? `${day(iso)}, ${clock(iso)}` : 'Unknown');
const usd = n => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
const SOURCE = { transcript: 'From the session’s own transcript, Plexiform’s state log and checkpoints on this computer.', hooks: 'From hook events only: just the first and latest prompt and the end of the last turn have times.', state: 'From Plexiform’s own session list only: nothing else was recorded.' };
let key = null, generation = 0;

function lineCounts(f) {
  const out = node('span');
  if (f.add != null) out.append(node('span', `+${f.add}`, 'add'));
  if (f.add != null && f.del != null) out.append(' ');
  if (f.del != null) out.append(node('span', `−${f.del}`, 'del'));
  return out;
}

function render(r) {
  const v = r.view;
  $('subtitle').textContent = `${r.title}${v.branch ? ` · branch ${v.branch}` : ''}`;
  const facts = [['Status', v.status], ['Started', when(v.startedAt)], ['Last activity', when(v.lastActive)], ['Spend so far', v.spend ? `${usd(v.spend.usd)}${v.spend.partial ? '+' : ''}` : 'Not known'], ['Files edited', String(v.counts.files)], ['Commands run', String(v.counts.commands)], ['Approvals', `${v.counts.approvals} asked · ${v.counts.answered + v.counts.denied} answered`]];
  $('facts-list').replaceChildren(...facts.flatMap(([k, val]) => { const d = node('div'); d.append(node('dt', k), node('dd', val)); return [d]; }));
  $('source').textContent = `${SOURCE[v.source] || ''}${v.partial ? ' The transcript is large, so only its start and latest part were read.' : ''}${v.spend ? ' Spend is an API-equivalent estimate from the transcript’s token counts.' : ''}`;
  $('facts').hidden = false;
  const files = v.files.filter(f => f.edits || f.add || f.del);
  $('files').replaceChildren(...files.map(f => { const li = node('li'); li.append(node('code', f.path), node('span', `${f.edits} edit${f.edits === 1 ? '' : 's'}`, 'note'), lineCounts(f)); return li; }));
  $('files-box').hidden = !files.length;
  const list = [];
  let lastDay = null;
  for (const e of v.events) {
    const d = day(e.at);
    if (d !== lastDay) { list.push(node('li', d, 'day')); lastDay = d; }
    const li = node('li', null, `k-${e.kind}`), body = node('div');
    const t = node('time', clock(e.at)); t.dateTime = e.at;
    body.append(node('div', e.label, 'label'));
    if (e.text != null) body.append(node('div', e.text, e.mono ? 'mono' : 'text'));
    if (e.spend) body.append(node('div', e.spend, 'note'));
    if (e.files?.length) { const ul = node('ul'); for (const f of e.files) { const fl = node('li'); fl.append(node('code', f.path), ' ', lineCounts(f)); ul.append(fl); } body.append(ul); }
    li.append(t, body);
    list.push(li);
  }
  $('events').replaceChildren(...list);
  $('status').textContent = v.events.length ? `${v.events.length} events, oldest first.` : 'No timed events were recorded for this session.';
  if (v.commands?.length) { const li = node('li', null, 'k-command'), body = node('div'); body.append(node('div', 'Recent commands (times not recorded)', 'label'), ...v.commands.map(c => node('div', c, 'mono'))); li.append(node('time', ''), body); $('events').append(li); }
}

async function preview() {
  const s = await api.preview(key, $('prompts').checked).catch(() => null);
  $('included').replaceChildren(...(s?.included ?? []).map(x => node('li', x)));
  $('excluded').textContent = s ? `Not included: ${s.excluded.join('; ')}.` : '';
  $('save').disabled = !s;
}

async function load(next = key) {
  const g = ++generation;
  $('status').textContent = 'Reading…';
  const [list, r] = await Promise.all([api.list().catch(() => null), api.load(next).catch(() => null)]);
  if (g !== generation) return;
  const sel = $('session');
  sel.replaceChildren(...(list?.sessions ?? []).map(s => new Option(s.label, s.key)));
  if (!list?.sessions?.length) sel.append(new Option('No sessions yet', ''));
  if (!r || r.empty) {
    for (const id of ['facts', 'files-box']) $(id).hidden = true;
    $('events').replaceChildren();
    $('status').textContent = r?.empty ?? 'The timeline could not be read. Try Refresh.';
    $('save').disabled = true;
    return;
  }
  key = r.key; sel.value = key;
  render(r);
  await preview();
}

$('session').addEventListener('change', e => { if (e.target.value) void load(e.target.value); });
$('refresh').addEventListener('click', () => { void load(); });
$('prompts').addEventListener('change', () => { void preview(); });
$('save').addEventListener('click', async () => {
  const b = $('save'), out = $('save-status');
  b.disabled = true; out.textContent = '';
  try {
    const r = await api.save(key, $('prompts').checked);
    out.textContent = r?.ok ? `Saved as ${r.name}.` : r?.cancelled ? 'Not saved.' : r?.error || 'Could not save the file.';
  } catch { out.textContent = 'Could not save the file.'; } finally { b.disabled = false; }
});
api.changed(() => { key = null; $('prompts').checked = false; void load(null); });
void load(null);
