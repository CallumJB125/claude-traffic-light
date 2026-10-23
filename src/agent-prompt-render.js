'use strict';
// Turns an agent's markdown prompt into plain blocks for the Find agents page,
// which builds them with textContent only. Nothing here produces HTML: a
// <script> in a prompt is just text, and links come out as "text (url)" so
// the reader sees where they point and nothing is clickable.
(function (root) {
  const MAX_BLOCKS = 4000;

  // Inline runs: [{ kind: 'text'|'code'|'strong', text }]. Links and images
  // become plain text with the URL in brackets.
  function inline(s) {
    const out = [];
    let buf = '';
    const push = (kind, text) => { if (text) out.push({ kind, text }); };
    const flush = () => { push('text', buf); buf = ''; };
    // Next index of a token at or after `from`, cached so a line of unclosed
    // brackets or backticks stays linear rather than rescanning to the end.
    const cache = new Map();
    const next = (tok, from) => {
      const c = cache.get(tok);
      if (c !== undefined && (c === -1 || c >= from)) return c;
      const at = s.indexOf(tok, from);
      cache.set(tok, at);
      return at;
    };
    for (let i = 0; i < s.length;) {
      const c = s[i];
      if (c === '`') {
        const end = next('`', i + 1);
        if (end > i + 1) { flush(); push('code', s.slice(i + 1, end)); i = end + 1; continue; }
      }
      if (c === '*' && s[i + 1] === '*') {
        const end = next('**', i + 2);
        if (end > i + 2) { flush(); push('strong', s.slice(i + 2, end)); i = end + 2; continue; }
      }
      if (c === '[' || (c === '!' && s[i + 1] === '[')) {
        const open = c === '!' ? i + 1 : i;
        const close = next('](', open + 1);
        const end = close > 0 ? next(')', close + 2) : -1;
        if (close > open && end > close) {
          buf += `${s.slice(open + 1, close)} (${s.slice(close + 2, end)})`;
          i = end + 1;
          continue;
        }
      }
      buf += c;
      i++;
    }
    flush();
    return out;
  }

  const heading = (line) => { let n = 0; while (line[n] === '#' && n < 7) n++; return n >= 1 && n <= 6 && line[n] === ' ' ? n : 0; };
  const bullet = (line) => { const t = line.trimStart(); return (t[0] === '-' || t[0] === '*' || t[0] === '+') && t[1] === ' ' ? t.slice(2) : null; };
  const numbered = (line) => { const t = line.trimStart(); let n = 0; while (n < t.length && t[n] >= '0' && t[n] <= '9') n++; return n > 0 && n < 10 && (t[n] === '.' || t[n] === ')') && t[n + 1] === ' ' ? t.slice(n + 2) : null; };
  const isRule = (line) => { const t = line.replace(/ /g, ''); return t.length >= 3 && (/^-+$/.test(t) || /^\*+$/.test(t) || /^_+$/.test(t)); };

  // Blocks: heading {level, runs}, para {runs}, list {ordered, items: [runs]},
  // code {lang, text}, quote {runs}, rule.
  function render(markdown) {
    const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let para = [];
    const endPara = () => { if (para.length) { blocks.push({ type: 'para', runs: inline(para.join(' ')) }); para = []; } };
    for (let i = 0; i < lines.length && blocks.length < MAX_BLOCKS; i++) {
      const line = lines[i];
      const fence = line.trimStart().startsWith('```') ? '```' : line.trimStart().startsWith('~~~') ? '~~~' : null;
      if (fence) {
        endPara();
        const lang = line.trimStart().slice(3).trim().slice(0, 32);
        const body = [];
        for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence); i++) body.push(lines[i]);
        blocks.push({ type: 'code', lang, text: body.join('\n') });
        continue;
      }
      if (!line.trim()) { endPara(); continue; }
      const h = heading(line);
      if (h) { endPara(); blocks.push({ type: 'heading', level: h, runs: inline(line.slice(h + 1).trim()) }); continue; }
      if (isRule(line)) { endPara(); blocks.push({ type: 'rule' }); continue; }
      if (line.startsWith('>')) {
        endPara();
        const q = [];
        for (; i < lines.length && lines[i].startsWith('>'); i++) q.push(lines[i].slice(1).trimStart());
        i--;
        blocks.push({ type: 'quote', runs: inline(q.join(' ')) });
        continue;
      }
      const b = bullet(line), o = b == null ? numbered(line) : null;
      if (b != null || o != null) {
        endPara();
        const ordered = b == null;
        const items = [];
        for (; i < lines.length; i++) {
          const item = ordered ? numbered(lines[i]) : bullet(lines[i]);
          if (item != null) { items.push(item); continue; }
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += ` ${lines[i].trim()}`; continue; }
          break;
        }
        i--;
        blocks.push({ type: 'list', ordered, items: items.map(inline) });
        continue;
      }
      para.push(line.trim());
    }
    endPara();
    return blocks;
  }

  const api = Object.freeze({ render, inline });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformPromptRender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
