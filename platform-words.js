'use strict';
// Shortcut hints in a page's own HTML say the platform's keys (A2): the HTML
// carries the Mac form, <kbd data-combo="K">⌘K</kbd>, and this rewrites it
// to Ctrl+K elsewhere. Load it after brand.js.
for (const el of document.querySelectorAll('[data-combo]')) el.textContent = window.Brand.keys().combo(el.dataset.combo);
