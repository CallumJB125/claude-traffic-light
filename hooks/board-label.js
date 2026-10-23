'use strict';
// A board name is a team's own text that reaches an AI inside Plexiform's quotes (the Plexiform line,
// hooks/awareness.js; bus_peers, src/agent-awareness.js). One function for both, so main and the hook can never
// differ (PR B review points 14-16). An allowlist, not a denylist: NFKC does not fold curly quotes, guillemets or
// corner brackets, and default-ignorable characters outside \p{C} (Hangul fillers, variation selectors, CGJ) can
// make a name blank or deceptive. So only letters, numbers, a few combining marks and plain punctuation stay.
const BOARD_NAME_MAX = 60;
const MARKS_PER_BASE = 2;
const KEEP = /[^\p{L}\p{N}\p{M} .,\-_&+/#():!]/gu;
// \p{L} includes modifier letters that look like quotes (U+02BA, U+02BB, U+02BC, U+02EE, U+A78B/A78C saltillo).
// The Spacing Modifier Letters block and the saltillo range go; CJK modifier letters such as U+30FC stay.
const QUOTE_LIKE = /[\u02B0-\u02FF\uA788-\uA78C]/gu;

function boardLabel(value) {
  if (typeof value !== 'string') return '';
  const s = value.slice(0, 1000).normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/[\p{Z}\s]/gu, ' ')
    .replace(KEEP, '')
    .replace(QUOTE_LIKE, '');
  // Zalgo: at most two combining marks after a base character, none after a space or at the start.
  let out = '';
  let marks = 0;
  let base = false;
  for (const ch of s) {
    if (/\p{M}/u.test(ch)) { if (base && marks < MARKS_PER_BASE) { out += ch; marks += 1; } continue; }
    base = ch !== ' ';
    marks = 0;
    out += ch;
  }
  const label = Array.from(out.replace(/ {2,}/g, ' ').trim()).slice(0, BOARD_NAME_MAX).join('').trim();
  // Belt and braces: whatever the steps above let through, a quote or a line break never reaches the line.
  return /["\r\n\u2028\u2029]/.test(label) ? '' : label;
}

module.exports = { boardLabel, BOARD_NAME_MAX, MARKS_PER_BASE };
