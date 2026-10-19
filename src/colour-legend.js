// One meaning per lamp colour, everywhere the app explains them: setup, the
// tour, Help, the menus and Preferences all read this list, so they cannot
// drift. Stuck is amber (it needs you to look) but carries its own glyph, so
// "gone quiet" never reads the same as "asked you something". Pure; loaded by
// pages with a <script> tag and by main and tests with require.
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlexiformLegend = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const STUCK_GLYPH = '⌛'; // hourglass
  const LEGEND = Object.freeze([
    Object.freeze({ id: 'working', colour: 'green', glyph: '\u25CF', label: 'Green', meaning: 'Working', detail: 'Claude is busy on what you asked.' }),
    Object.freeze({ id: 'your-turn', colour: 'amber', glyph: '\u25CF', label: 'Amber', meaning: 'Your turn', detail: 'Claude finished, or is waiting for your next message. Nothing is blocked.' }),
    Object.freeze({ id: 'stuck', colour: 'amber', glyph: STUCK_GLYPH, label: `Amber ${STUCK_GLYPH}`, meaning: 'Gone quiet', detail: 'Still working but silent for a while. It may be stuck; take a look.' }),
    Object.freeze({ id: 'needs-you', colour: 'red', glyph: '\u25A0', label: 'Red', meaning: 'Needs you now', detail: 'Claude is asking a question or permission, or something stopped it: a failed turn, no network, out of tokens or over budget.' }),
    Object.freeze({ id: 'idle', colour: 'off', glyph: '\u25CB', label: 'Off', meaning: 'Nothing running', detail: 'No AI session is open.' }),
  ]);
  // The one-line version: "Green = working · Amber = your turn · …".
  const SENTENCE = LEGEND.filter((e) => e.id !== 'idle').map((e) => `${e.label} = ${e.meaning.toLowerCase()}`).join(' · ');
  // Menu rows (Electron menu templates): read-only, one per colour.
  const menuItems = () => LEGEND.map((e) => ({ label: `${e.glyph} ${e.label}: ${e.meaning}`, enabled: false }));
  const byId = (id) => LEGEND.find((e) => e.id === id) || null;
  return { LEGEND, SENTENCE, STUCK_GLYPH, menuItems, byId };
});
