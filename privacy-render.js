// Renders PRIVACY.md (the single source) into the Preferences Privacy section.
// Handles only what that file uses: headings, paragraphs, bullet lists,
// blockquotes, **bold**, `code`. Input is escaped first, so it can't inject.
(function (root) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  function render(md) {
    const out = [];
    let list = false;
    let para = [];
    const flush = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
    const closeList = () => { if (list) out.push('</ul>'); list = false; };
    for (const line of String(md).split('\n')) {
      let m;
      if (!line.trim()) { flush(); closeList(); continue; }
      if ((m = line.match(/^(#{1,3}) (.*)/))) {
        flush(); closeList();
        if (m[1].length === 1) continue; // the page title: Preferences already has its own
        out.push(`<h${m[1].length + 1} class="pv-h">${inline(m[2])}</h${m[1].length + 1}>`);
      } else if ((m = line.match(/^> (.*)/))) { flush(); closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
      else if ((m = line.match(/^- (.*)/))) { flush(); if (!list) out.push('<ul>'); list = true; out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = line.match(/^\d+\. (.*)/))) { flush(); if (!list) out.push('<ul>'); list = true; out.push(`<li>${inline(m[1])}</li>`); }
      else { closeList(); para.push(line.trim()); }
    }
    flush(); closeList();
    return out.join('\n');
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { render };
  else root.renderPrivacy = render;
})(typeof window !== 'undefined' ? window : globalThis);
