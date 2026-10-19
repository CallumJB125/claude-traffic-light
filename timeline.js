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
let key = null, generation = 0, previewGeneration = 0, rendered = null;
const KINDS = { results: ['turn-end'], subagents: ['delegation', 'delegation-result'], changes: ['edit', 'read', 'checkpoint', 'command'], approvals: ['approval', 'failed', 'interrupted', 'limit'] };

function lineCounts(f) {
  const out = node('span');
  if (f.add != null) out.append(node('span', `+${f.add}`, 'add'));
  if (f.add != null && f.del != null) out.append(' ');
  if (f.del != null) out.append(node('span', `−${f.del}`, 'del'));
  return out;
}

function render(r) {
  rendered = r;
  const v = r.view;
  $('subtitle').textContent = `${r.title}${v.branch ? ` · branch ${v.branch}` : ''}${typeof v.model === 'string' && v.model ? ` · model ${v.model}` : ''}`;
  const facts = [['Status', v.status], ['Started', when(v.startedAt)], ['Last activity', when(v.lastActive)], ['Spend so far', v.spend ? `${usd(v.spend.usd)}${v.spend.partial ? '+' : ''}` : 'Not known'], ['Files edited', String(v.counts.files)], ['Commands run', String(v.counts.commands)], ['Approvals', `${v.counts.approvals} asked · ${v.counts.answered + v.counts.denied} answered`]];
  $('facts-list').replaceChildren(...facts.flatMap(([k, val]) => { const d = node('div'); d.append(node('dt', k), node('dd', val)); return [d]; }));
  $('source').textContent = `${SOURCE[v.source] || ''}${v.partial ? ' The transcript is large, so only its start and latest part were read.' : ''}${v.spend ? ' Spend is an API-equivalent estimate from the transcript’s token counts.' : ''}`;
  $('facts').hidden = false;
  const files = v.files.filter(f => f.edits || f.add || f.del);
  $('files').replaceChildren(...files.map(f => { const li = node('li'); li.append(node('code', f.path), node('span', `${f.edits} edit${f.edits === 1 ? '' : 's'}`, 'note'), lineCounts(f)); return li; }));
  $('files-box').hidden = !files.length;
  renderEvents(v);
}

function renderEvents(v) {
  const list = [], query = $('event-search').value.trim().toLocaleLowerCase(), kinds = KINDS[$('event-kind').value];
  const matches = e => (!kinds || kinds.includes(e.kind)) && (!query || [e.label, e.text, ...(e.files || []).map(f => f.path)].filter(Boolean).join('\n').toLocaleLowerCase().includes(query));
  const visible = v.events.filter(matches);
  let lastDay = null;
  for (const e of visible) {
    const d = day(e.at);
    if (d !== lastDay) { list.push(node('li', d, 'day')); lastDay = d; }
    const li = node('li', null, `k-${e.kind}`), body = node('div');
    const t = node('time', clock(e.at)); t.dateTime = e.at;
    body.append(node('div', e.label, 'label'));
    if (e.text != null) {
      if (['turn-end', 'delegation', 'delegation-result'].includes(e.kind) && e.text.length > 500) {
        const detail = node('details'); detail.append(node('summary', `${e.text.slice(0, 140).replace(/\s+/g, ' ')}…`), node('div', e.text, 'text')); body.append(detail);
      } else body.append(node('div', e.text, e.mono ? 'mono' : 'text'));
    }
    if (e.spend) body.append(node('div', e.spend, 'note'));
    if (e.files?.length) { const ul = node('ul'); for (const f of e.files) { const fl = node('li'); fl.append(node('code', f.path), ' ', lineCounts(f)); ul.append(fl); } body.append(ul); }
    li.append(t, body);
    list.push(li);
  }
  $('events').replaceChildren(...list);
  $('status').textContent = v.events.length ? `${visible.length} of ${v.events.length} events, oldest first.${visible.length ? '' : ' No activity matches these filters.'}` : 'No timed events were recorded for this session.';
  const commands = (!kinds || kinds.includes('command')) ? (v.commands || []).filter(c => !query || c.toLocaleLowerCase().includes(query)) : [];
  if (commands.length) { const li = node('li', null, 'k-command'), body = node('div'); body.append(node('div', 'Recent commands (times not recorded)', 'label'), ...commands.map(c => node('div', c, 'mono'))); li.append(node('time', ''), body); $('events').append(li); }
}

async function preview() {
  const selected = key, g = generation, p = ++previewGeneration;
  $('save').disabled = true;
  const s = await api.preview(selected, $('prompts').checked).catch(() => null);
  if (p !== previewGeneration || g !== generation || selected !== key) return;
  $('included').replaceChildren(...(s?.included ?? []).map(x => node('li', x)));
  $('excluded').textContent = s ? `Not included: ${s.excluded.join('; ')}.` : '';
  $('save').disabled = !s;
}

async function load(next = key) {
  const g = ++generation;
  previewGeneration++; rendered = null;
  $('save').disabled = true;
  $('included').replaceChildren(); $('excluded').textContent = ''; $('save-status').textContent = '';
  $('status').textContent = 'Reading…';
  const [list, r] = await Promise.all([api.list().catch(() => null), api.load(next).catch(() => null)]);
  if (g !== generation) return;
  const sel = $('session');
  sel.replaceChildren(...(list?.sessions ?? []).map(s => new Option(s.label, s.key)));
  if (!list?.sessions?.length) sel.append(new Option('No sessions yet', ''));
  if (!r || r.empty) {
    key = null;
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
for (const id of ['event-search', 'event-kind']) $(id).addEventListener(id === 'event-search' ? 'input' : 'change', () => { if (rendered) renderEvents(rendered.view); });
$('save').addEventListener('click', async () => {
  const b = $('save'), out = $('save-status');
  const selected = key, g = generation;
  b.disabled = true; out.textContent = '';
  try {
    const r = await api.save(selected, $('prompts').checked);
    if (g !== generation || selected !== key) return;
    out.textContent = r?.ok ? `Saved as ${r.name}.` : r?.cancelled ? 'Not saved.' : r?.error || 'Could not save the file.';
  } catch { if (g === generation && selected === key) out.textContent = 'Could not save the file.'; } finally { if (g === generation && selected === key) void preview(); }
});
if (typeof api.canShare === 'function') api.canShare().then(ok => { const sec = $('share-section'); if (sec) sec.hidden = ok !== true; }).catch(() => {});
$('share')?.addEventListener('click', async () => {
  const b = $('share'), out = $('share-status');
  const selected = key, g = generation;
  b.disabled = true; out.textContent = 'Sharing…';
  try {
    const r = await api.share(selected);
    if (g !== generation || selected !== key) return;
    out.textContent = r?.ok ? `Posted to the team card (${r.date}).` : r?.error || 'Could not share this summary.';
  } catch { if (g === generation && selected === key) out.textContent = 'Could not share this summary.'; } finally { b.disabled = false; }
});
api.changed(() => { key = null; $('prompts').checked = false; void load(null); });
void load(null);
