'use strict';

// Display-layer title cleanup for records captured before tagged system text
// was skipped: stored titles are never rewritten, only shown cleaned.

const FALLBACK = 'Untitled session';
const BLOCK = /<([A-Za-z][\w:.-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g;
const TAG = /<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/g;

function cleanTitle(v, max = 120, fallback = FALLBACK) {
  let t = typeof v === 'string' ? v : '';
  if (t.includes('<')) {
    for (let prev; prev !== t;) { prev = t; t = t.replace(BLOCK, ' '); }
    t = t.replace(TAG, ' ');
  }
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return fallback;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

module.exports = { cleanTitle, FALLBACK };
