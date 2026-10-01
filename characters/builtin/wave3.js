// Wave 3: a tamagotchi egg, a toaster, a cloud, an astronaut, a sloth, a
// T-rex and a cyclops. Same craft as the starter six and wave 2: pixel art at
// 2 units a pixel, a base, shade and highlight each, light from the upper
// left, no baked-in eyes or mouth (the rig draws those at the anchors, except
// the cyclops, whose white eye is part of the drawing and whose rig eye is the
// pupil). Original designs, art only. Registers before starter.js, which holds
// the seal.
(function (root, factory) {
  const C = typeof module === 'object' && module.exports ? require('../contract.js') : root.BuddyCharacters;
  const defs = factory(C);
  for (const d of defs) C.register(d, { builtin: true });
  if (typeof module === 'object' && module.exports) module.exports = defs;
})(typeof self !== 'undefined' ? self : this, function (C) {
  const { px, run: R } = C;
  const frame = (over) => ({ contract: 1, ...over });

  // ── a shape from a rule, shaded from the upper left: for the round ones ──
  function solid(w, h, inside) {
    const g = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (inside(x + 0.5, y + 0.5) ? 'Y' : '.')));
    const at = (x, y) => (y >= 0 && y < h && x >= 0 && x < w ? g[y][x] : '.');
    return g.map((row, y) => row.map((c, x) => {
      if (c !== 'Y') return c;
      if (at(x, y + 1) === '.' || at(x + 1, y) === '.') return 'S';
      if (at(x, y - 1) === '.' || at(x - 1, y) === '.') return 'H';
      return 'Y';
    }));
  }
  const rows = (g, edits = []) => {
    const out = g.map((r) => r.slice());
    for (const [x, y, ch] of edits) if (out[y] && out[y][x] && out[y][x] !== '.') out[y][x] = ch;
    return out.map((r) => r.join(''));
  };

  // ── egg: no limbs, speckled, a hairline crack ──
  const EGG_G = solid(16, 14, (x, y) => { const half = 7.4 * (0.62 + 0.38 * Math.sin(Math.min(1, (y + 0.5) / 7) * (Math.PI / 2))); return Math.abs(x - 8) <= half && y > 0.2 && y < 13.9 && ((y - 6.8) / 6.9) ** 2 + ((x - 8) / (half + 0.4)) ** 2 <= 1.02; });
  const EGG = rows(EGG_G, [[4, 3, 'P'], [10, 2, 'P'], [11, 5, 'P'], [3, 6, 'P'], [12, 8, 'P'], [5, 9, 'P'], [3, 10, 'k'], [4, 10, 'k'], [5, 11, 'k'], [6, 10, 'k'], [7, 11, 'k'], [8, 10, 'k'], [9, 11, 'k'], [10, 10, 'k'], [12, 10, 'k']]);
  const eggPal = { H: '#fffaf0', Y: '#f4ecdf', S: '#d4c7b0', P: '#9fc5e8', k: '#b8a98e' };

  // ── toaster: silver, two slices poking out, a lever; the face is on the front ──
  const TOASTER = [
    R(['.', 5], ['t', 1], ['T', 4], ['t', 1], ['.', 2], ['t', 1], ['T', 4], ['t', 1], ['.', 5]),
    R(['.', 5], ['t', 1], ['T', 4], ['t', 1], ['.', 2], ['t', 1], ['T', 4], ['t', 1], ['.', 5]),
    R(['.', 5], ['t', 6], ['.', 2], ['t', 6], ['.', 5]),
    R(['.', 2], ['K', 20], ['.', 2]),
    ...Array.from({ length: 3 }, () => R(['.', 1], ['H', 1], ['Y', 20], ['S', 2])),
    R(['.', 1], ['H', 1], ['Y', 20], ['S', 1], ['L', 1]),
    R(['.', 1], ['H', 1], ['Y', 20], ['S', 1], ['L', 1]),
    ...Array.from({ length: 3 }, () => R(['.', 1], ['H', 1], ['Y', 20], ['S', 2])),
    R(['.', 1], ['S', 22], ['.', 1]),
    R(['.', 3], ['K', 18], ['.', 3]),
    R(['.', 3], ['a', 4], ['.', 10], ['b', 4], ['.', 3]),
  ];
  const toasterPal = { T: '#e0a84e', t: '#b9792f', K: '#4f545c', H: '#eef1f5', Y: '#c8ccd2', S: '#9aa0a8', L: '#d4483a', a: ['#4f545c', 'cp-leg-a'], b: ['#4f545c', 'cp-leg-b'] };

  // ── cloud: no outline, no legs ──
  const CLOUD_G = solid(26, 12, (x, y) => {
    const d = (cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    return d(7, 6.4, 4.8) || d(13, 4.6, 5.4) || d(19.2, 6.4, 4.8) || (x > 3.2 && x < 22.8 && y > 6 && y < 11.2 && !((x < 4.6 || x > 21.4) && y > 10));
  });
  const CLOUD = rows(CLOUD_G);
  const cloudPal = { H: '#ffffff', Y: '#e9f0f8', S: '#b9c8dc' };

  // ── astronaut: the visor is the face; a pale glass so the eyes read ──
  const ASTRO = [
    R(['.', 6], ['H', 2], ['Y', 6], ['.', 6]),
    R(['.', 4], ['H', 2], ['Y', 8], ['S', 2], ['.', 4]),
    R(['.', 2], ['H', 1], ['Y', 1], ['E', 12], ['Y', 1], ['S', 1], ['.', 2]),
    R(['.', 2], ['H', 1], ['Y', 1], ['E', 1], ['W', 2], ['V', 8], ['E', 1], ['Y', 1], ['S', 1], ['.', 2]),
    R(['.', 2], ['H', 1], ['Y', 1], ['E', 1], ['V', 10], ['E', 1], ['Y', 1], ['S', 1], ['.', 2]),
    R(['.', 2], ['H', 1], ['Y', 1], ['E', 1], ['V', 10], ['E', 1], ['Y', 1], ['S', 1], ['.', 2]),
    R(['.', 2], ['H', 1], ['Y', 1], ['E', 1], ['V', 10], ['E', 1], ['Y', 1], ['S', 1], ['.', 2]),
    R(['.', 2], ['H', 1], ['Y', 1], ['E', 12], ['Y', 1], ['S', 1], ['.', 2]),
    R(['.', 3], ['Y', 13], ['S', 1], ['.', 3]),
    R(['G', 3], ['H', 1], ['Y', 3], ['R', 2], ['Y', 1], ['B', 2], ['Y', 4], ['S', 1], ['G', 3]),
    R(['G', 3], ['H', 1], ['Y', 12], ['S', 1], ['G', 3]),
    R(['.', 3], ['H', 1], ['Y', 12], ['S', 1], ['.', 3]),
    R(['.', 4], ['S', 12], ['.', 4]),
    R(['.', 5], ['a', 4], ['.', 2], ['b', 4], ['.', 5]),
    R(['.', 5], ['a', 4], ['.', 2], ['b', 4], ['.', 5]),
    R(['.', 4], ['a', 5], ['.', 2], ['b', 5], ['.', 4]),
  ];
  const astroPal = { Y: '#f1f4f8', H: '#ffffff', S: '#c3ccd8', V: '#a9d8ff', W: '#ffffff', E: '#6b7686', R: '#e2433a', B: '#3a7bd5', G: '#cfd8e3', a: ['#6b7686', 'cp-leg-a'], b: ['#6b7686', 'cp-leg-b'] };

  // ── sloth: long arms hanging down, dark eye patches ──
  const SLOTH = [
    R(['.', 5], ['H', 2], ['Y', 8], ['S', 2], ['.', 5]),
    R(['.', 3], ['H', 2], ['Y', 12], ['S', 2], ['.', 3]),
    R(['.', 2], ['H', 1], ['Y', 15], ['S', 2], ['.', 2]),
    R(['.', 2], ['Y', 2], ['M', 14], ['S', 2], ['.', 2]),
    R(['.', 2], ['Y', 3], ['D', 4], ['M', 4], ['D', 4], ['Y', 1], ['S', 2], ['.', 2]),
    R(['.', 2], ['Y', 3], ['D', 4], ['M', 4], ['D', 4], ['Y', 1], ['S', 2], ['.', 2]),
    R(['.', 2], ['Y', 3], ['M', 12], ['Y', 1], ['S', 2], ['.', 2]),
    R(['.', 2], ['Y', 4], ['M', 4], ['K', 2], ['M', 4], ['Y', 2], ['S', 2], ['.', 2]),
    ...Array.from({ length: 5 }, () => R(['A', 3], ['.', 1], ['H', 1], ['Y', 12], ['S', 1], ['.', 1], ['A', 3])),
    R(['C', 3], ['.', 3], ['a', 4], ['.', 4], ['b', 4], ['.', 1], ['C', 3]),
    R(['.', 6], ['a', 4], ['.', 4], ['b', 4], ['.', 4]),
    R(['.', 5], ['a', 5], ['.', 3], ['b', 5], ['.', 4]),
  ];
  const slothPal = { Y: '#b59a7a', H: '#d3bda0', S: '#8d7458', A: '#a08463', M: '#e6d8c0', D: '#5b4632', K: '#3a2d20', C: '#f1ead9', a: ['#8d7458', 'cp-leg-a'], b: ['#8d7458', 'cp-leg-b'] };

  // ── T-rex: a big head, tiny arms, teeth ──
  const TREX = [
    R(['.', 7], ['H', 2], ['Y', 6], ['S', 1], ['.', 6]),
    R(['.', 4], ['H', 2], ['Y', 10], ['S', 2], ['.', 4]),
    R(['.', 3], ['H', 1], ['Y', 14], ['S', 2], ['.', 2]),
    R(['.', 3], ['Y', 15], ['S', 2], ['.', 2]),
    R(['.', 3], ['Y', 15], ['S', 2], ['.', 2]),
    R(['.', 3], ['Y', 15], ['S', 2], ['.', 2]),
    R(['.', 3], ['Y', 15], ['S', 2], ['.', 2]),
    R(['.', 3], ['W', 1], ['K', 1], ['W', 1], ['K', 1], ['W', 1], ['K', 1], ['W', 1], ['K', 1], ['W', 1], ['K', 1], ['W', 1], ['K', 1], ['W', 1], ['K', 1], ['W', 1], ['.', 4]),
    R(['.', 4], ['H', 1], ['Y', 12], ['S', 2], ['.', 3]),
    R(['.', 5], ['H', 1], ['Y', 3], ['B', 6], ['Y', 3], ['S', 1], ['.', 3]),
    R(['.', 3], ['Y', 2], ['Y', 1], ['Y', 3], ['B', 6], ['Y', 3], ['S', 1], ['Y', 2], ['.', 1]),
    R(['.', 5], ['H', 1], ['Y', 3], ['B', 6], ['Y', 3], ['S', 1], ['.', 3]),
    R(['.', 5], ['S', 14], ['.', 3]),
    R(['.', 5], ['a', 5], ['.', 4], ['b', 5], ['.', 3]),
    R(['.', 5], ['a', 5], ['.', 4], ['b', 5], ['.', 3]),
    R(['.', 4], ['a', 6], ['.', 3], ['b', 6], ['.', 3]),
  ];
  const trexPal = { H: '#b6d27a', Y: '#8aa84a', S: '#617a30', B: '#d8e6a8', W: '#fbfbf2', K: '#3b4a1c', a: ['#617a30', 'cp-leg-a'], b: ['#617a30', 'cp-leg-b'] };
  const TREX_TAIL = ['..YYYY', '.YYYYS', 'YYYSS.'];
  const trexTailPal = { Y: '#8aa84a', S: '#617a30' };

  // ── cyclops: one big white eye; the rig's eye is its pupil ──
  const CYCLOPS = [
    R(['.', 3], ['N', 2], ['.', 2], ['Y', 6], ['.', 2], ['N', 2], ['.', 3]),
    R(['.', 3], ['H', 2], ['Y', 10], ['S', 2], ['.', 3]),
    R(['.', 2], ['H', 1], ['Y', 13], ['S', 2], ['.', 2]),
    R(['.', 2], ['Y', 4], ['W', 6], ['Y', 4], ['S', 2], ['.', 2]),
    R(['.', 2], ['Y', 3], ['W', 8], ['Y', 3], ['S', 2], ['.', 2]),
    R(['.', 2], ['Y', 3], ['W', 8], ['Y', 3], ['S', 2], ['.', 2]),
    R(['.', 2], ['Y', 3], ['W', 8], ['Y', 3], ['S', 2], ['.', 2]),
    R(['.', 2], ['Y', 4], ['W', 6], ['Y', 4], ['S', 2], ['.', 2]),
    R(['.', 2], ['Y', 5], ['K', 6], ['Y', 3], ['S', 2], ['.', 2]),
    R(['.', 3], ['H', 1], ['Y', 12], ['S', 2], ['.', 2]),
    R(['.', 3], ['H', 1], ['Y', 12], ['S', 2], ['.', 2]),
    R(['.', 3], ['H', 1], ['Y', 12], ['S', 2], ['.', 2]),
    R(['.', 3], ['S', 14], ['.', 3]),
    R(['.', 5], ['a', 3], ['.', 4], ['b', 3], ['.', 5]),
    R(['.', 4], ['a', 5], ['.', 2], ['b', 5], ['.', 4]),
  ];
  const cyclopsPal = { N: '#f2e9c9', H: '#9aa6f0', Y: '#6f7fe0', S: '#4c5bb8', W: '#fbfbff', K: '#2f3a80', a: ['#4c5bb8', 'cp-leg-a'], b: ['#4c5bb8', 'cp-leg-b'] };

  return [
    frame({
      id: 'egg', name: 'Egg', legs: false,
      anchors: {
        head: { x: 20, y: 40, w: 24, h: 18 }, hatLine: 40, ground: 68,
        eyes: { left: { x: 27, y: 51 }, right: { x: 37, y: 51 } }, mouth: { x: 32, y: 57 }, hands: null,
        faceBox: { x: 22, y: 44, w: 20, h: 18 }, skinParts: [],
      },
      sprite: { body: px(EGG, eggPal, 40) },
    }),
    frame({
      id: 'toaster', name: 'Toaster', legs: true,
      anchors: {
        head: { x: 10, y: 46, w: 44, h: 18 }, hatLine: 44, ground: 68,
        eyes: { left: { x: 24, y: 54 }, right: { x: 40, y: 54 } }, mouth: { x: 32, y: 59 }, hands: null,
        faceBox: { x: 16, y: 47, w: 32, h: 16 }, skinParts: [],
      },
      sprite: { body: px(TOASTER, toasterPal, 40) },
    }),
    frame({
      id: 'cloud', name: 'Cloud', legs: false,
      anchors: {
        head: { x: 10, y: 44, w: 44, h: 20 }, hatLine: 44, ground: 68,
        eyes: { left: { x: 26, y: 56 }, right: { x: 38, y: 56 } }, mouth: { x: 32, y: 61 }, hands: null,
        faceBox: { x: 18, y: 48, w: 28, h: 16 }, skinParts: [],
      },
      sprite: { body: px(CLOUD, cloudPal, 44) },
    }),
    frame({
      id: 'astronaut', name: 'Astronaut', legs: true,
      anchors: {
        head: { x: 16, y: 36, w: 32, h: 18 }, hatLine: 36, ground: 68,
        eyes: { left: { x: 25, y: 46 }, right: { x: 39, y: 46 } }, mouth: { x: 32, y: 51 },
        hands: { left: { x: 8, y: 56 }, right: { x: 53, y: 56 } },
        faceBox: { x: 22, y: 42, w: 20, h: 12 }, skinParts: [],
      },
      sprite: { body: px(ASTRO, astroPal, 36) },
    }),
    frame({
      id: 'sloth', name: 'Sloth', legs: true,
      anchors: {
        head: { x: 14, y: 36, w: 36, h: 16 }, hatLine: 36, ground: 68,
        eyes: { left: { x: 24, y: 45 }, right: { x: 40, y: 45 } }, mouth: { x: 32, y: 52 },
        hands: { left: { x: 8, y: 60 }, right: { x: 54, y: 60 } },
        faceBox: { x: 20, y: 40, w: 24, h: 14 }, skinParts: [],
      },
      sprite: { body: px(SLOTH, slothPal, 36) },
    }),
    frame({
      id: 'trex', name: 'T-rex', legs: true,
      anchors: {
        head: { x: 16, y: 36, w: 36, h: 18 }, hatLine: 36, ground: 68,
        eyes: { left: { x: 25, y: 44 }, right: { x: 39, y: 44 } }, mouth: { x: 32, y: 51 }, hands: null,
        faceBox: { x: 20, y: 38, w: 24, h: 14 }, skinParts: [],
      },
      sprite: {
        back: px(TREX_TAIL, trexTailPal, 54, 46),
        body: px(TREX, trexPal, 36),
      },
    }),
    frame({
      id: 'cyclops', name: 'Cyclops', legs: true,
      anchors: {
        head: { x: 14, y: 38, w: 32, h: 20 }, hatLine: 38, ground: 68,
        eyes: { single: { x: 31, y: 49 } }, mouth: { x: 31, y: 56 }, hands: null,
        faceBox: { x: 20, y: 42, w: 24, h: 16 }, skinParts: [],
      },
      sprite: { body: px(CYCLOPS, cyclopsPal, 38) },
    }),
  ];
});
