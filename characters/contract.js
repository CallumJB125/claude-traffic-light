// The character contract: what a character provides so costumes, cameos, eye
// moods, mouth items, poses and minions can find its head, eyes, mouth and
// hands instead of assuming Claude's. Plain script for the renderers
// (window.BuddyCharacters) and a CommonJS module for Node (rules tests, the
// validator, `buddy add`).
//
// A character, on the rig's 64×82 grid:
//   {
//     id, name, contract: 1,
//     sprite: { back, body, front, face },   // SVG markup; body is required
//     color: '#b07a4a',                      // fill for layers not in skinParts
//     anchors: {
//       head: { x, y, w, h }, hatLine, ground,
//       eyes: { left: {x,y}, right: {x,y} } | { single: {x,y} } | 'none',
//       mouth: { x, y } | null,
//       hands: { left: {x,y}, right: {x,y}, extra?: [{x,y}…] } | null,
//       faceBox: { x, y, w, h },             // where a photo cameo goes
//       skinParts: ['body', …],              // layers that take --body-color
//     },
//     legs: true | false,
//     offsets?: { [costume]: { dx, dy, s } }, // per-costume nudges
//     mini?: [[tag, attrs], …],              // agent-chip sprite, 6.9×7.5 box
//     css?: '…',                             // built-ins only; never imported
//   }
//
// Claude's own numbers are the reference frame: every rig part is drawn for
// them, and a character whose anchors differ is fitted by offsetting those
// parts (see anchorVars) rather than redrawing them.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BuddyCharacters = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CONTRACT_VERSION = 1;
  const VIEWBOX = { x: 0, y: 0, w: 64, h: 82 };
  const LAYERS = ['back', 'body', 'front', 'face'];

  const REF = Object.freeze({
    head: Object.freeze({ x: 17, y: 39, w: 30, h: 13 }),
    hatLine: 39,
    ground: 68,
    eyes: Object.freeze({ left: Object.freeze({ x: 24.25, y: 45.75 }), right: Object.freeze({ x: 39.75, y: 45.75 }) }),
    mouth: Object.freeze({ x: 32, y: 50 }),
    // left holds the sign; right is where held props (thumbs, fist, phone) sit
    hands: Object.freeze({ left: Object.freeze({ x: 4.5, y: 34 }), right: Object.freeze({ x: 53.5, y: 49 }) }),
    faceBox: Object.freeze({ x: 17, y: 30, w: 30, h: 30 }),
  });
  const EYE_GAP = REF.eyes.right.x - REF.eyes.left.x;

  // Installed and hatched characters live under u-<id> (validate.js adds the
  // prefix), so they can never take a built-in's id, today's or a future one's.
  const USER_PREFIX = 'u-';
  const registry = new Map();
  const builtins = new Set();
  const revs = new Map();
  let sealed = false;
  const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
  // Built-ins register from their own scripts, then the set is sealed;
  // anything else must have been through characters/validate.js first.
  function register(def, { builtin = false } = {}) {
    if (!def || typeof def.id !== 'string') throw new Error('character needs an id');
    if (builtin && sealed) throw new Error('built-in characters are sealed');
    if (!builtin && (builtins.has(def.id) || !def.id.startsWith(USER_PREFIX))) throw new Error(`"${def.id}" is not an installed character id (${USER_PREFIX}…)`);
    registry.set(def.id, deepFreeze(def));
    if (builtin) builtins.add(def.id);
    // a re-import under the same id bumps its revision, so a rig wearing it redraws
    revs.set(def.id, (revs.get(def.id) || 0) + 1);
    return def;
  }
  const sealBuiltins = () => { sealed = true; };
  const isBuiltin = (id) => builtins.has(id);
  const revision = (id) => revs.get(id) || 0;
  const get = (id) => registry.get(id) || null;
  const has = (id) => registry.has(id);
  const ids = () => Array.from(registry.keys());
  const list = () => Array.from(registry.values());

  function eyeMode(anchors) {
    const e = anchors && anchors.eyes;
    if (e === 'none') return 'none';
    if (e && e.single) return 'single';
    return 'pair';
  }
  function capabilities(def) {
    const a = def.anchors || {};
    return { hands: !!a.hands, handCount: a.hands ? 2 + (Array.isArray(a.hands.extra) ? a.hands.extra.length : 0) : 0, mouth: !!a.mouth, eyes: eyeMode(a), legs: def.legs !== false };
  }

  const r2 = (n) => Math.round(n * 100) / 100;
  // CSS custom properties that move Claude-frame parts onto a character's
  // anchors. `fitted` is false when every offset is nil: the rig then leaves
  // those parts exactly where they were drawn.
  function anchorVars(def) {
    const a = (def && def.anchors) || REF;
    const v = {};
    const mode = eyeMode(a);
    let eye = { x: 32, y: (REF.eyes.left.y + REF.eyes.right.y) / 2 }, eyeS = 1;
    if (mode === 'pair') {
      eye = { x: (a.eyes.left.x + a.eyes.right.x) / 2, y: (a.eyes.left.y + a.eyes.right.y) / 2 };
      eyeS = Math.abs(a.eyes.right.x - a.eyes.left.x) / EYE_GAP;
    }
    // one eye: the left eye of each drawing lands on it (the right is clipped)
    const from = mode === 'single' ? REF.eyes.left : { x: 32, y: 45.75 };
    if (mode === 'single') eye = { x: a.eyes.single.x, y: a.eyes.single.y };
    v['--eye-dx'] = r2(eye.x - from.x);
    v['--eye-dy'] = r2(eye.y - from.y);
    v['--eye-s'] = r2(eyeS);
    const m = a.mouth || REF.mouth;
    v['--mouth-dx'] = r2(m.x - REF.mouth.x);
    v['--mouth-dy'] = r2(m.y - REF.mouth.y);
    const head = a.head || REF.head;
    const hatLine = Number.isFinite(a.hatLine) ? a.hatLine : head.y;
    v['--hat-dx'] = r2(head.x + head.w / 2 - 32);
    v['--hat-dy'] = r2(hatLine - REF.hatLine);
    v['--hat-s'] = r2(head.w / REF.head.w);
    // drawn cameos are faces: Claude's face box onto the character's
    const face = a.faceBox || REF.faceBox;
    v['--face-dx'] = r2(face.x + face.w / 2 - (REF.faceBox.x + REF.faceBox.w / 2));
    v['--face-dy'] = r2(face.y + face.h / 2 - (REF.faceBox.y + REF.faceBox.h / 2));
    v['--face-s'] = r2(Math.min(face.w / REF.faceBox.w, face.h / REF.faceBox.h));
    const hands = a.hands || REF.hands;
    v['--hand-l-dx'] = r2(hands.left.x - REF.hands.left.x);
    v['--hand-l-dy'] = r2(hands.left.y - REF.hands.left.y);
    v['--hand-r-dx'] = r2(hands.right.x - REF.hands.right.x);
    v['--hand-r-dy'] = r2(hands.right.y - REF.hands.right.y);
    const fitted = Object.entries(v).some(([k, n]) => (k.endsWith('-s') ? n !== 1 : n !== 0));
    const css = {};
    for (const [k, n] of Object.entries(v)) css[k] = k.endsWith('-s') ? String(n) : `${n}px`;
    return { fitted, vars: v, css };
  }

  // The rig's class for a character's body layer. Claude's layer keeps the
  // name rig.css has always styled it by.
  const layerClass = (id) => (id === 'claude' ? 'body-default' : `body-${id}`);

  // Markup for one layer, wrapped so it takes the character's colour: skin
  // layers follow --body-color (a rule's tint), the rest keep def.color.
  function layerMarkup(def, layer) {
    const inner = def.sprite && def.sprite[layer];
    if (!inner) return '';
    const skin = Array.isArray(def.anchors && def.anchors.skinParts) && def.anchors.skinParts.includes(layer);
    const fill = skin ? ' fill="var(--body-color, #da7756)"' : def.color ? ` fill="${def.color}"` : '';
    const cls = layer === 'body' ? `body ${layerClass(def.id)}` : `char-${layer}-part`;
    return `<g class="${cls}"${fill}>${inner}</g>`;
  }

  return { CONTRACT_VERSION, VIEWBOX, LAYERS, REF, USER_PREFIX, register, sealBuiltins, isBuiltin, revision, get, has, ids, list, eyeMode, capabilities, anchorVars, layerClass, layerMarkup };
});
