// Claude and the original five bodies. They were drawn as swaps of Claude's
// sprite, so they share Claude's head, eyes, mouth and face box; what differs
// is which limbs they have. Their animations (wag, antenna, tail, float) are
// in rig.css.
(function (root, factory) {
  const C = typeof module === 'object' && module.exports ? require('../contract.js') : root.BuddyCharacters;
  const defs = factory(C.REF);
  for (const d of defs) C.register(d, { builtin: true });
  if (typeof module === 'object' && module.exports) module.exports = defs;
})(typeof self !== 'undefined' ? self : this, function (REF) {
  const claudeShaped = (over = {}) => ({ ...REF, skinParts: [], ...over });
  return [
    {
      id: 'claude', name: 'Claude', contract: 1, legs: true,
      anchors: claudeShaped({ skinParts: ['body'] }),
      sprite: { body: `
      <rect x="17" y="39" width="30" height="13" />
      <rect x="4" y="52" width="56" height="7" />
      <rect x="15" y="59" width="7" height="9" />
      <rect x="28.5" y="59" width="7" height="9" />
      <rect x="42" y="59" width="7" height="9" />
    ` },
    },
    {
      id: 'dog', name: 'Dog', contract: 1, legs: true, color: '#b07a4a',
      anchors: claudeShaped(),
      sprite: { body: `
      <rect x="17" y="39" width="30" height="13" /><rect x="4" y="52" width="56" height="7" />
      <rect x="15" y="59" width="7" height="9" /><rect x="28.5" y="59" width="7" height="9" /><rect x="42" y="59" width="7" height="9" />
      <rect x="11" y="38" width="6" height="13" rx="3" fill="#7d5230" /><rect x="47" y="38" width="6" height="13" rx="3" fill="#7d5230" />
      <rect x="27" y="47.5" width="10" height="4.5" rx="2" fill="#e8c9a8" /><rect x="30.5" y="46.5" width="3" height="2" rx="1" fill="#211f1c" />
      <rect class="wag" x="59" y="52" width="7" height="2.2" rx="1" fill="#7d5230" />
    ` },
    },
    {
      id: 'cat', name: 'Cat', contract: 1, legs: true, color: '#8c8c96',
      anchors: claudeShaped(),
      sprite: { body: `
      <rect x="17" y="39" width="30" height="13" /><rect x="4" y="52" width="56" height="7" />
      <rect x="15" y="59" width="7" height="9" /><rect x="28.5" y="59" width="7" height="9" /><rect x="42" y="59" width="7" height="9" />
      <polygon points="18,40 21,31 26,39" /><polygon points="38,39 43,31 46,40" />
      <polygon points="20,38 21.5,34 24,38" fill="#f4a7c0" /><polygon points="40,38 42.5,34 44,38" fill="#f4a7c0" />
      <rect x="30.5" y="47" width="3" height="2" rx="1" fill="#f4a7c0" />
      <rect x="15" y="48.5" width="6" height="0.7" fill="#211f1c" /><rect x="43" y="48.5" width="6" height="0.7" fill="#211f1c" />
      <path class="cat-tail" d="M60 56 q7 -4 4 -10" fill="none" stroke="#8c8c96" stroke-width="2.2" stroke-linecap="round" />
    ` },
    },
    {
      id: 'frog', name: 'Frog', contract: 1, legs: true, color: '#5fbf5a',
      anchors: claudeShaped(),
      sprite: { body: `
      <rect x="17" y="41" width="30" height="11" rx="3" /><rect x="4" y="52" width="56" height="7" />
      <rect x="13" y="59" width="9" height="9" rx="2" /><rect x="42" y="59" width="9" height="9" rx="2" />
      <circle cx="24" cy="40" r="4.5" /><circle cx="40" cy="40" r="4.5" />
      <rect x="24" y="49" width="16" height="1.2" rx="0.6" fill="#2d6b2a" />
    ` },
    },
    {
      id: 'robot', name: 'Robot', contract: 1, legs: true, color: '#9aa3ad',
      anchors: claudeShaped(),
      sprite: { body: `
      <rect x="17" y="39" width="30" height="13" /><rect x="4" y="52" width="56" height="7" />
      <rect x="13" y="59" width="38" height="9" rx="4" fill="#5c646d" />
      <rect x="31" y="32" width="2" height="7" fill="#5c646d" /><circle class="antenna" cx="32" cy="31" r="2" fill="#e2231a" />
      <rect x="19" y="41" width="26" height="9" fill="#5c646d" />
      <circle cx="8" cy="55.5" r="1" fill="#5c646d" /><circle cx="56" cy="55.5" r="1" fill="#5c646d" />
      <rect x="27" y="47.5" width="10" height="1.4" fill="#38bdf8" />
    ` },
    },
    {
      // a sheet with no arms or legs: it floats
      id: 'ghost', name: 'Ghost', contract: 1, legs: false, color: '#eef0f5',
      anchors: claudeShaped({ hands: null }),
      sprite: { body: `
      <path d="M17 39 h30 v27 l-5 -4 l-5 4 l-5 -4 l-5 4 l-5 -4 l-5 4 z" />
    ` },
    },
  ];
});
