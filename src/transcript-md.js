'use strict';
// Transcript markdown → a small tree (redesign R2a, plan-redesign §R4.2).
// Pure and dependency-free. The tree uses a fixed set of node types; anything
// this doesn't recognise stays text. It never produces HTML: transcript-dom.js
// builds elements from the tree with createElement/textContent only.
//
// Blocks: p, pre (fenced code), h3/h4 (from #..####), blockquote, ul/ol/li, table/tr/td.
// Inline: code, strong, em, link {text, url}: a link is shown as its text and
// address, never as a live <a> (§R4.2: no href in the transcript frame).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TranscriptMd = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const MAX_CHARS = 200000;
  const MAX_DEPTH = 4;
  const FENCE = /^ {0,3}(```|~~~)/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const QUOTE = /^ {0,3}>\s?(.*)$/;
  const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
  const ORDERED = /^ {0,3}\d{1,9}[.)]\s+(.*)$/;
  const TABLE_ROW = /^\s*\|.*\|\s*$/;
  const TABLE_RULE = /^\s*\|(\s*:?-{1,}:?\s*\|)+\s*$/;
  const BLANK = /^\s*$/;

  // ── inline ──────────────────────────────────────────────────────────────
  // A link's address is kept only if it is plain http(s); anything else is
  // dropped and the link reads as its text.
  const safeUrl = (u) => (/^https?:\/\/[^\s<>"'`]+$/i.test(u) ? u : null);

  function inline(text) {
    const out = [];
    let buf = '';
    const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '`') {
        const end = text.indexOf('`', i + 1);
        if (end > i + 1) { flush(); out.push({ type: 'code', text: text.slice(i + 1, end) }); i = end + 1; continue; }
      }
      if ((c === '*' || c === '_') && text[i + 1] === c) {
        const end = text.indexOf(c + c, i + 2);
        if (end > i + 2) { flush(); out.push({ type: 'strong', children: inline(text.slice(i + 2, end)) }); i = end + 2; continue; }
      }
      if (c === '*' || c === '_') {
        const end = text.indexOf(c, i + 1);
        // `_` inside a word (snake_case) stays text.
        const wordy = c === '_' && /\w/.test(text[i - 1] || '');
        if (end > i + 1 && !wordy && !/\s/.test(text[i + 1])) { flush(); out.push({ type: 'em', children: inline(text.slice(i + 1, end)) }); i = end + 1; continue; }
      }
      if (c === '[') {
        const close = text.indexOf('](', i + 1);
        const end = close > i ? text.indexOf(')', close + 2) : -1;
        if (close > i && end > close) {
          flush();
          const label = text.slice(i + 1, close), url = safeUrl(text.slice(close + 2, end).trim());
          out.push(url ? { type: 'link', text: label || url, url } : { type: 'text', text: label });
          i = end + 1; continue;
        }
      }
      buf += c; i += 1;
    }
    flush();
    return out;
  }

  // ── blocks ──────────────────────────────────────────────────────────────
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => ({ type: 'td', children: inline(c.trim()) }));

  function blocks(lines, depth) {
    const out = [];
    let i = 0;
    const para = [];
    const endPara = () => { if (para.length) { out.push({ type: 'p', children: inline(para.join(' ')) }); para.length = 0; } };
    while (i < lines.length) {
      const line = lines[i];
      if (BLANK.test(line)) { endPara(); i += 1; continue; }
      const fence = line.match(FENCE);
      if (fence) {
        endPara();
        const body = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) { body.push(lines[i]); i += 1; }
        i += 1; // the closing fence (or the end)
        out.push({ type: 'pre', text: body.join('\n') });
        continue;
      }
      const h = line.match(HEADING);
      if (h) { endPara(); out.push({ type: h[1].length >= 4 ? 'h4' : 'h3', children: inline(h[2]) }); i += 1; continue; }
      if (QUOTE.test(line)) {
        endPara();
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) { body.push(lines[i].match(QUOTE)[1]); i += 1; }
        out.push(depth < MAX_DEPTH ? { type: 'blockquote', children: blocks(body, depth + 1) } : { type: 'p', children: inline(body.join(' ')) });
        continue;
      }
      const listRe = BULLET.test(line) ? BULLET : ORDERED.test(line) ? ORDERED : null;
      if (listRe) {
        endPara();
        const items = [];
        while (i < lines.length && listRe.test(lines[i])) { items.push({ type: 'li', children: inline(lines[i].match(listRe)[1]) }); i += 1; }
        out.push({ type: listRe === BULLET ? 'ul' : 'ol', children: items });
        continue;
      }
      if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] || '')) {
        endPara();
        const rows = [{ type: 'tr', children: cells(line) }];
        i += 2;
        while (i < lines.length && TABLE_ROW.test(lines[i])) { rows.push({ type: 'tr', children: cells(lines[i]) }); i += 1; }
        out.push({ type: 'table', children: rows });
        continue;
      }
      para.push(line.trim());
      i += 1;
    }
    endPara();
    return out;
  }

  function parse(text) {
    if (typeof text !== 'string' || !text) return [];
    const src = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
    return blocks(src.replace(/\r\n?/g, '\n').split('\n'), 0);
  }

  const TYPES = Object.freeze(['p', 'pre', 'code', 'ul', 'ol', 'li', 'em', 'strong', 'blockquote', 'h3', 'h4', 'table', 'tr', 'td', 'text', 'link']);
  return { parse, TYPES, MAX_CHARS };
}));
