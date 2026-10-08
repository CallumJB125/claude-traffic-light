'use strict';
// Search everything: the local memory index's search page, and optionally
// the team hub's team memory beside it, each under its own heading. Text from
// transcripts and teammates is only ever set as textContent; snippet
// highlights arrive as control-character markers and become <mark> elements here.
(() => {
  const api = window.memoryApi;
  const $ = (id) => document.getElementById(id);
  const TOOL = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes', gemini: 'Gemini CLI', cursor: 'Cursor' };
  const TARGET = { codex: 'Codex', claude: 'Claude' };
  const OPEN = '\u0002', CLOSE = '\u0003';
  const DAY = 86400000;
  const STATUS = { working: 'working', waiting: 'waiting', review: 'in review', ended: 'ended', idle: 'idle', paused_limit: 'paused at a limit' };
  const SOURCE_KEY = 'plexiform.memory.source';
  const panels = new Map(); // hand-off id -> { out, reply, send, end, note }
  let info = null, timer = null, teamTimer = null, seq = 0;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const button = (label, cls, on) => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', on); return b; };
  const when = (ms) => { if (!Number.isFinite(ms)) return ''; const d = Date.now() - ms; return d < 60000 ? 'just now' : d < 3600000 ? `${Math.floor(d / 60000)}m ago` : d < DAY ? `${Math.floor(d / 3600000)}h ago` : new Date(ms).toLocaleDateString(); };

  function snippet(text) {
    const p = el('p', 'snippet');
    let open = false;
    for (const part of String(text || '').split(/([\u0002\u0003])/)) {
      if (part === OPEN) { open = true; continue; }
      if (part === CLOSE) { open = false; continue; }
      if (part) p.append(open ? el('mark', null, part) : document.createTextNode(part));
    }
    return p;
  }

  async function act(note, fn) {
    note.textContent = 'Working…';
    const r = await fn().catch(() => ({ ok: false, error: 'Something went wrong. Try again.' }));
    note.textContent = r && r.ok ? (r.note || '') : (r && r.error) || 'That did not work.';
    return r;
  }

  function handoffPanel(r, holder) {
    const box = el('div', 'handoff');
    const head = el('p', 'note', `${TARGET[r.to]} is reading the handover…`);
    const out = el('p', 'reply-text');
    const form = el('div', 'reply'); form.hidden = true;
    const text = el('textarea'); text.setAttribute('aria-label', `Reply to ${TARGET[r.to]}`); text.maxLength = 4000;
    const note = el('p', 'note');
    const send = button('Send', 'small primary', async () => {
      if (!text.value.trim()) return;
      send.disabled = true; out.textContent = '';
      const res = await act(note, () => api.reply(r.id, text.value));
      if (res.ok) { text.value = ''; head.textContent = `${TARGET[r.to]} is replying…`; } else send.disabled = false;
    });
    const end = button('End', 'small', async () => { await api.end(r.id); closed(); });
    const closed = () => { panels.delete(r.id); head.textContent = `This ${TARGET[r.to]} session has ended.`; form.hidden = true; end.disabled = true; };
    form.append(text, el('div', 'row-actions'));
    form.lastChild.append(send, note);
    box.append(head, out, form, el('div', 'row-actions'));
    box.lastChild.append(end);
    holder.replaceChildren(box);
    panels.set(r.id, { out, head, form, send, closed, to: r.to });
  }

  api.onHandoff((ev) => {
    const p = ev && panels.get(ev.id);
    if (!p) return;
    if (ev.kind === 'delta') p.out.textContent += ev.text;
    else if (ev.kind === 'message') p.out.textContent = ev.text;
    else if (ev.kind === 'refused') p.head.textContent = `${TARGET[p.to]} asked to use a tool; Plexiform-started sessions are text-only, so it was refused.`;
    else if (ev.kind === 'done') { p.head.textContent = ev.status === 'completed' ? `${TARGET[p.to]} replied. Answer below, or end it.` : `The turn ${ev.status}${ev.error ? `: ${ev.error}` : ''}.`; p.form.hidden = false; p.send.disabled = false; }
    else if (ev.kind === 'closed') p.closed();
  });

  function render(hits) {
    const list = $('results');
    list.replaceChildren();
    for (const h of hits) {
      const k = { tool: h.tool, sid: h.sid };
      const li = el('li', 'hit');
      li.append(el('h2', null, h.title || 'Untitled session'));
      const meta = [TOOL[h.tool] || h.tool, h.repo, h.branch, when(h.ts), h.matches > 1 ? `${h.matches} matching turns` : null].filter(Boolean).join(' · ');
      li.append(el('div', 'meta', meta));
      if (h.snippet) li.append(snippet(h.snippet));
      if (h.cwd) li.append(el('div', 'meta', h.cwd));
      const note = el('p', 'note');
      const panel = el('div');
      const row = el('div', 'row-actions');
      row.append(button('Open handover', 'small', () => act(note, () => api.openHandover(k))));
      row.append(button('Copy handover', 'small', async () => { const r = await act(note, () => api.copyHandover(k)); if (r.ok) note.textContent = 'Copied as a prompt. Paste it into any AI tool.'; }));
      for (const to of ['codex', 'claude']) {
        row.append(button(`Hand to ${TARGET[to]}`, 'small', async () => {
          const r = await act(note, () => api.hand(k, to));
          if (r.ok && r.mode === 'launched') { note.textContent = ''; handoffPanel(r, panel); }
        }));
      }
      li.append(row, note, panel);
      list.append(li);
    }
  }

  function renderTeam(hits) {
    const list = $('team-results');
    list.replaceChildren();
    for (const h of hits) {
      const li = el('li', 'hit team');
      li.append(el('span', 'source', `Team memory · ${h.team || 'Team'}`), el('h2', null, h.title || 'Untitled work'));
      li.append(el('div', 'meta', [h.author, TOOL[h.adapter] || h.adapter, h.repo, h.branch, STATUS[h.status], when(Date.parse(h.updated_at || ''))].filter(Boolean).join(' · ')));
      if (h.goal) li.append(el('p', null, h.goal));
      if (h.snippet) li.append(snippet(h.snippet));
      if (h.handover) li.append(el('p', 'note', `${h.author} shared a handover for this work. Ask your AI: team_memory_get ${h.record_id}`));
      list.append(li);
    }
  }

  async function teamSearch(req, mine) {
    const status = $('team-status');
    if (req.q.trim().length < 2) { $('team-results').replaceChildren(); status.textContent = 'Type at least two characters to search team memory.'; return; }
    status.textContent = 'Asking your team hub…';
    const r = await api.teamSearch(req).catch(() => null);
    if (mine !== seq) return;
    if (!r || !r.ok || !r.available) { $('team-results').replaceChildren(); status.textContent = (r && r.message) || 'Team memory is not available right now.'; return; }
    renderTeam(r.results);
    const asked = (r.teams || []).map((t) => t.team);
    const failed = (r.teams || []).filter((t) => !t.ok).map((t) => `${t.team}: ${t.message}`);
    const from = asked.length ? ` from ${asked.join(', ')}` : '';
    status.textContent = [r.results.length ? `${r.results.length} shared record${r.results.length === 1 ? '' : 's'}${from}` : `No shared work matches${from}.`, ...failed].join(' · ');
  }

  async function search() {
    const mine = ++seq;
    const days = Number($('when').value);
    const req = { q: $('q').value, tool: $('tool').value, repo: $('repo').value, from: days ? Date.now() - days * DAY : null };
    const src = $('source').value;
    $('local').hidden = src === 'team';
    $('local-head').hidden = src !== 'both';
    $('team').hidden = src === 'local';
    // The hub rate-limits team memory, so typing asks it at most every 400 ms.
    clearTimeout(teamTimer);
    if (src !== 'local') teamTimer = setTimeout(() => teamSearch(req, mine), 400);
    if (src === 'team') return;
    const r = await api.search(req).catch(() => null);
    if (mine !== seq) return;
    if (!r || !r.ok) { $('status').textContent = (r && r.error) || 'Search is not available right now.'; return; }
    render(r.hits);
    const scope = r.days ? ` in the last ${r.days} days` : '';
    $('status').textContent = r.hits.length
      ? `${r.hits.length} session${r.hits.length === 1 ? '' : 's'}${req.q.trim() ? '' : ', most recent first'}${scope} · ${Math.max(1, Math.round(r.tookMs))} ms`
      : req.q.trim() ? `No matches${scope}.` : `Nothing indexed${scope} yet.`;
  }
  const soon = () => { clearTimeout(timer); timer = setTimeout(search, 150); };

  async function refresh() {
    info = await api.status().catch(() => null);
    if (!info || !info.ok) { $('stats').textContent = 'The index is not available.'; return; }
    const s = info.stats;
    $('stats').textContent = `${s.turns.toLocaleString()} turns from ${s.sessions.toLocaleString()} sessions${s.lastPass ? ` · updated ${when(s.lastPass)}` : ''}${info.indexing ? ' · updating…' : ''}`;
    $('experimental').checked = info.experimental;
    if (info.days) {
      $('plan').hidden = false;
      $('plan').textContent = `Free plan: search covers the last ${info.days} days. Plus searches your full history and hands sessions to Codex or Claude in one click (the free plan copies the handover for you to paste).`;
      for (const o of $('when').options) if (Number(o.value) > info.days && !o.disabled) { o.disabled = true; o.textContent += ' (Plus)'; }
    }
    const f = await api.facets().catch(() => null);
    if (f && f.ok) {
      const sel = $('repo'), cur = sel.value;
      sel.replaceChildren(el('option', null, 'All repos'));
      sel.firstChild.value = '';
      for (const r of f.repos) { const o = el('option', null, r); o.value = r; sel.append(o); }
      sel.value = f.repos.includes(cur) ? cur : '';
    }
  }

  $('form').addEventListener('submit', (e) => { e.preventDefault(); search(); });
  $('q').addEventListener('input', soon);
  for (const id of ['tool', 'repo', 'when']) $(id).addEventListener('change', search);
  try { const saved = localStorage.getItem(SOURCE_KEY); if ([...$('source').options].some((o) => o.value === saved)) $('source').value = saved; } catch { /* storage unavailable: default source */ }
  $('source').addEventListener('change', () => { try { localStorage.setItem(SOURCE_KEY, $('source').value); } catch { /* not remembered */ } search(); });
  $('experimental').addEventListener('change', async (e) => { await api.setExperimental(e.target.checked); refresh(); });
  $('reindex').addEventListener('click', async () => { await api.reindex(); $('stats').textContent += ' · updating…'; setTimeout(() => refresh().then(search), 3000); });
  $('clear').addEventListener('click', async () => { await api.clear(); await refresh(); search(); });
  window.addEventListener('focus', () => { refresh(); });
  refresh().then(search);
})();
