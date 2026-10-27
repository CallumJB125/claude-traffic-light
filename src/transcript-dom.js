'use strict';
// Transcript DOM (redesign R2a, plan-redesign §R4.2 and §2.4).
// Builds the thread's transcript into a document the caller owns (the
// script-less srcdoc frame) with createElement and textContent ONLY: never
// innerHTML, insertAdjacentHTML, outerHTML, document.write or an on* attribute
// (a static test checks this file). AI text goes through TranscriptMd's tree.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./transcript-md.js'));
  else root.TranscriptDom = factory(root.TranscriptMd);
}(typeof self !== 'undefined' ? self : this, function (Md) {
  const BLOCK = new Set(['p', 'pre', 'ul', 'ol', 'li', 'blockquote', 'h3', 'h4', 'table', 'tr', 'td']);
  const INLINE = new Set(['code', 'em', 'strong']);

  function el(doc, tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // One markdown tree node → elements. Unknown types render as their text.
  function node(doc, n) {
    if (!n || typeof n !== 'object') return doc.createTextNode('');
    if (n.type === 'text') return doc.createTextNode(n.text || '');
    if (n.type === 'link') {
      // Text plus its address; no live link in the transcript (§R4.2).
      const s = el(doc, 'span', 'tx-link', n.text);
      if (n.url && n.url !== n.text) s.append(doc.createTextNode(' '), el(doc, 'span', 'tx-url', `(${n.url})`));
      return s;
    }
    if (n.type === 'pre') { const p = el(doc, 'pre'); p.append(el(doc, 'code', null, n.text || '')); return p; }
    if (n.type === 'code') return el(doc, 'code', null, n.text || '');
    if (BLOCK.has(n.type) || INLINE.has(n.type)) {
      const e = el(doc, n.type);
      for (const c of n.children || []) e.append(node(doc, c));
      return e;
    }
    return doc.createTextNode(typeof n.text === 'string' ? n.text : '');
  }

  function markdown(doc, text) {
    const f = doc.createDocumentFragment();
    for (const b of Md.parse(text)) f.append(node(doc, b));
    return f;
  }

  // ── tool steps (§2.4) ──────────────────────────────────────────────────
  const VERB = { Read: 'Read', Edit: 'Edited', MultiEdit: 'Edited', Write: 'Edited', NotebookEdit: 'Edited', Bash: 'Ran', Grep: 'Searched', Glob: 'Searched', WebFetch: 'Looked up', WebSearch: 'Looked up' };
  const NOUN = { Read: 'files', Edited: 'files', Ran: 'commands', Searched: 'searches', 'Looked up': 'pages' };
  const verbOf = (name) => VERB[name] || 'Used';
  const durationText = (ms) => (Number.isFinite(ms) && ms >= 0 ? (ms < 1000 ? '<1 s' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`) : '');

  // Consecutive tool items (no text between them) → one group.
  function groups(items) {
    const out = [];
    for (const it of items || []) {
      if (it && it.kind === 'tool') {
        const last = out[out.length - 1];
        if (last && last.kind === 'steps') last.steps.push(it); else out.push({ kind: 'steps', steps: [it] });
      } else if (it) out.push(it);
    }
    return out;
  }

  // "Read 3 files · Edited server.js · Ran npm test (2)"
  function summary(steps) {
    const order = [], by = new Map();
    for (const s of steps) {
      const v = verbOf(s.name);
      if (!by.has(v)) { by.set(v, []); order.push(v); }
      by.get(v).push(s);
    }
    return order.map((v) => {
      const list = by.get(v);
      if (v === 'Used') return list.length === 1 ? `Used ${list[0].name || 'a tool'}` : `Used ${list.length} tools`;
      if (list.length === 1) return `${v} ${list[0].summary || ''}`.trim();
      const same = list.every((s) => s.summary && s.summary === list[0].summary);
      return same ? `${v} ${list[0].summary} (${list.length})` : `${v} ${list.length} ${NOUN[v]}`;
    }).join(' · ');
  }

  const failed = (s) => s.done && s.ok === false;

  function stepsBlock(doc, group, open) {
    const box = el(doc, 'div', 'tx-steps');
    const anyFailed = group.steps.some(failed);
    if (anyFailed) box.classList.add('is-failed');
    const head = el(doc, 'div', 'tx-steps-head');
    head.append(el(doc, 'span', anyFailed ? 'tx-shape tx-stuck' : 'tx-shape', ''), el(doc, 'span', 'tx-steps-text', summary(group.steps)));
    const total = group.steps.reduce((a, s) => a + (Number.isFinite(s.durationMs) ? s.durationMs : 0), 0);
    if (total > 0) head.append(el(doc, 'span', 'tx-dur', durationText(total)));
    head.append(el(doc, 'span', 'tx-caret', open ? '▾' : '▸'));
    box.append(head);
    if (open) {
      const list = el(doc, 'ul', 'tx-step-list');
      for (const s of group.steps) {
        const li = el(doc, 'li', failed(s) ? 'tx-step is-failed' : 'tx-step');
        li.append(el(doc, 'span', 'tx-step-text', `${verbOf(s.name) === 'Used' ? `Used ${s.name || 'a tool'}` : verbOf(s.name)} ${s.summary || ''}`.trim()));
        const d = durationText(s.durationMs);
        if (d) li.append(el(doc, 'span', 'tx-dur', d));
        if (!s.done) li.append(el(doc, 'span', 'tx-running', 'running'));
        list.append(li);
      }
      box.append(list);
    }
    return box;
  }

  // The whole transcript. `opts.open` is a Set of group indexes shown expanded.
  function render(doc, { prompt = '', items = [], waiting = [], open = new Set() } = {}) {
    const f = doc.createDocumentFragment();
    const gs = groups(items);
    const firstUser = gs.find((g) => g.kind === 'text' && g.role === 'user');
    if (prompt && !(firstUser && firstUser.text.trim() === prompt.trim())) f.append(el(doc, 'div', 'tx-msg tx-user', prompt));
    gs.forEach((g, i) => {
      if (g.kind === 'steps') { const b = stepsBlock(doc, g, open.has(i)); b.dataset.group = String(i); f.append(b); return; }
      if (g.kind === 'note') { f.append(el(doc, 'div', 'tx-note', g.text)); return; }
      if (g.kind !== 'text') return;
      if (g.role === 'user') f.append(el(doc, 'div', 'tx-msg tx-user', g.text));
      else if (g.role === 'assistant') { const m = el(doc, 'div', 'tx-msg tx-ai'); m.append(markdown(doc, g.text)); f.append(m); }
      else f.append(el(doc, 'div', 'tx-note', g.text));
    });
    for (const w of waiting) {
      const m = el(doc, 'div', 'tx-msg tx-user is-waiting', w.body || '');
      m.append(el(doc, 'span', 'tx-status', 'Waiting to be delivered'));
      f.append(m);
    }
    return f;
  }

  // A terminal session's activity (main's Timeline display, already sanitised) →
  // transcript items. Tool steps carry the summary only: no output is recorded.
  const ACTIVITY_TOOL = { edit: 'Edit', read: 'Read', command: 'Bash' };
  const ACTIVITY_NOTE = new Set(['interrupted', 'end', 'limit', 'approval']);
  function itemsFromActivity(view) {
    const items = [];
    for (const e of Array.isArray(view?.events) ? view.events.slice(-1500) : []) {
      if (!e || typeof e !== 'object' || e.hidden) continue;
      const text = typeof e.text === 'string' ? e.text : '';
      if (e.kind === 'prompt' && text) items.push({ kind: 'text', role: 'user', text });
      else if (e.kind === 'turn-end') { if (text) items.push({ kind: 'text', role: 'assistant', text }); if (e.failed) items.push({ kind: 'note', text: 'Turn failed' }); }
      else if (ACTIVITY_TOOL[e.kind]) items.push({ kind: 'tool', name: ACTIVITY_TOOL[e.kind], summary: text, done: true, ok: true });
      else if (e.kind === 'tool') items.push({ kind: 'tool', name: text || 'a tool', summary: '', done: true, ok: true });
      else if (e.kind === 'failed') items.push({ kind: 'tool', name: text || 'a tool', summary: '', done: true, ok: false });
      else if (ACTIVITY_NOTE.has(e.kind) && typeof e.label === 'string') items.push({ kind: 'note', text: text && e.kind === 'approval' ? `${e.label}: ${text}` : e.label });
    }
    return items;
  }

  return { markdown, groups, summary, render, durationText, verbOf, itemsFromActivity };
}));
