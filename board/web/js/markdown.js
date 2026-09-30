// Handover markdown rendered as TEXT (CONTRACT §5.4, D25). Only headings,
// lists (incl. [ ] / [x] / [~] / [-] checklists), code spans and fenced code
// blocks get structure; everything else — links, emphasis, HTML — stays
// literal characters inside text nodes.
import { h } from './h.js';

export function inline(s) {
  const out = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(h('code', null, m[1]));
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

const CHECK = { x: 'done', '~': 'doing', '-': 'skipped', ' ': 'todo' };

export function renderMarkdown(md, { headingBase = 3 } = {}) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let list = null;
  let para = null;
  let i = 0;
  const flush = () => {
    if (list) { blocks.push(h('ul', { class: `md-list${list.check ? ' md-checklist' : ''}` }, list.items)); list = null; }
    if (para) { blocks.push(h('p', null, inline(para.join('\n')))); para = null; }
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```/);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(h('pre', { class: 'md-pre' }, h('code', null, body.join('\n'))));
      continue;
    }
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      flush();
      const level = Math.min(6, headingBase + head[1].length - 1);
      blocks.push(h(`h${level}`, { class: `md-h md-h${head[1].length}` }, inline(head[2])));
      i++;
      continue;
    }
    const item = line.match(/^(\s*)[-*]\s+(?:\[([ x~-])\]\s+)?(.*)$/);
    if (item) {
      if (para) { blocks.push(h('p', null, inline(para.join('\n')))); para = null; }
      if (!list) list = { items: [], check: false };
      const state = item[2] != null ? CHECK[item[2]] : null;
      if (state) list.check = true;
      const nested = item[1].length >= 2;
      list.items.push(h('li', { class: [state ? `md-check md-${state}` : null, nested ? 'md-nested' : null].filter(Boolean).join(' ') || null, 'data-check': state ?? null },
        state ? h('span', { class: 'md-box', 'aria-hidden': 'true' }) : null,
        h('span', null, inline(item[3]))));
      i++;
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    // A continuation line under a list item (e.g. an indented command tail).
    if (list && /^\s{2,}\S/.test(line)) {
      const last = list.items[list.items.length - 1];
      last.children.push(h('span', { class: 'md-cont' }, line.trim()));
      i++;
      continue;
    }
    if (list) flush();
    (para ??= []).push(line);
    i++;
  }
  flush();
  return blocks;
}
