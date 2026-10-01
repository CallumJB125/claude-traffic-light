// Wave 2: an owl, a penguin, a fox, a bee, an axolotl and a mushroom. Same
// craft as the starter six (see starter.js): pixel art at 2 units a pixel, a
// base, shade and highlight each, light from the upper left, no baked-in eyes
// or mouth (the rig draws those at the anchors). Original designs, art only.
// Registers before starter.js, which holds the seal.
(function (root, factory) {
  const C = typeof module === 'object' && module.exports ? require('../contract.js') : root.BuddyCharacters;
  const defs = factory(C);
  for (const d of defs) C.register(d, { builtin: true });
  if (typeof module === 'object' && module.exports) module.exports = defs;
})(typeof self !== 'undefined' ? self : this, function (C) {
  const { px, run: R } = C;
  const frame = (over) => ({ contract: 1, ...over });

  // ── owl: wings instead of hands, big eyes on pale face discs ──
  const OWL = [
    R(['.', 3], ['S', 2], ['.', 10], ['S', 2], ['.', 3]),
    R(['.', 2], ['H', 2], ['Y', 12], ['S', 2], ['.', 2]),
    R(['.', 1], ['H', 2], ['Y', 14], ['S', 2], ['.', 1]),
    R(['.', 1], ['Y', 3], ['d', 4], ['Y', 4], ['d', 4], ['Y', 2], ['S', 1], ['.', 1]),
    R(['.', 1], ['Y', 3], ['d', 4], ['Y', 4], ['d', 4], ['Y', 2], ['S', 1], ['.', 1]),
    R(['.', 1], ['Y', 3], ['d', 4], ['Y', 1], ['O', 2], ['Y', 1], ['d', 4], ['Y', 2], ['S', 1], ['.', 1]),
    R(['.', 1], ['Y', 4], ['d', 3], ['Y', 1], ['O', 2], ['Y', 1], ['d', 3], ['Y', 3], ['S', 1], ['.', 1]),
    R(['.', 1], ['W', 3], ['B', 12], ['W', 3], ['.', 1]),
    R(['.', 1], ['W', 3], ['B', 2], ['s', 1], ['B', 2], ['s', 1], ['B', 2], ['s', 1], ['B', 3], ['W', 3], ['.', 1]),
    R(['.', 1], ['W', 3], ['B', 12], ['W', 3], ['.', 1]),
    R(['.', 1], ['W', 3], ['s', 1], ['B', 2], ['s', 1], ['B', 2], ['s', 1], ['B', 2], ['s', 1], ['B', 2], ['W', 3], ['.', 1]),
    R(['.', 2], ['W', 2], ['B', 12], ['W', 2], ['.', 2]),
    R(['.', 3], ['S', 14], ['.', 3]),
    R(['.', 4], ['S', 12], ['.', 4]),
    R(['.', 4], ['a', 3], ['.', 6], ['b', 3], ['.', 4]),
    R(['.', 3], ['a', 5], ['.', 4], ['b', 5], ['.', 3]),
  ];
  const owlPal = { S: '#6a4c33', H: '#b08c66', Y: '#8b6a4a', d: '#e9d8b8', O: '#e8a03a', W: '#6a4c33', B: '#e6d3b0', s: '#c9b08a', a: ['#e8a03a', 'cp-leg-a'], b: ['#e8a03a', 'cp-leg-b'] };

  // ── penguin: a black cap, white face and belly, orange beak and feet ──
  const PENGUIN = [
    R(['.', 6], ['H', 2], ['K', 4], ['.', 6]),
    R(['.', 3], ['H', 2], ['K', 8], ['k', 2], ['.', 3]),
    R(['.', 2], ['H', 1], ['K', 12], ['k', 2], ['.', 1]),
    R(['.', 2], ['K', 2], ['W', 10], ['K', 2], ['.', 2]),
    R(['.', 2], ['K', 2], ['W', 10], ['K', 2], ['.', 2]),
    R(['.', 2], ['K', 2], ['W', 4], ['O', 2], ['W', 4], ['K', 2], ['.', 2]),
    R(['.', 2], ['K', 3], ['W', 3], ['O', 2], ['W', 3], ['K', 3], ['.', 2]),
    R(['F', 2], ['K', 1], ['W', 12], ['K', 1], ['F', 2]),
    R(['F', 2], ['K', 1], ['W', 10], ['V', 2], ['K', 1], ['F', 2]),
    R(['F', 2], ['K', 1], ['W', 10], ['V', 2], ['K', 1], ['F', 2]),
    R(['F', 2], ['K', 1], ['W', 10], ['V', 2], ['K', 1], ['F', 2]),
    R(['.', 2], ['K', 1], ['W', 10], ['V', 2], ['K', 1], ['.', 2]),
    R(['.', 3], ['K', 1], ['W', 8], ['V', 2], ['K', 1], ['.', 3]),
    R(['.', 4], ['K', 10], ['.', 4]),
    R(['.', 3], ['a', 4], ['.', 4], ['b', 4], ['.', 3]),
    R(['.', 2], ['a', 6], ['.', 2], ['b', 6], ['.', 2]),
  ];
  const penguinPal = { H: '#4d586b', K: '#2c3340', k: '#1e2430', F: '#2c3340', W: '#f5f7fb', V: '#d6dce8', O: '#f2992e', a: ['#f2992e', 'cp-leg-a'], b: ['#f2992e', 'cp-leg-b'] };

  // ── fox: a bushy tail that flicks, white cheeks, dark socks ──
  const FOX = [
    R(['.', 4], ['S', 2], ['.', 12], ['S', 2], ['.', 4]),
    R(['.', 3], ['S', 1], ['Y', 3], ['.', 10], ['Y', 3], ['S', 1], ['.', 3]),
    R(['.', 2], ['H', 2], ['Y', 16], ['S', 2], ['.', 2]),
    R(['.', 2], ['H', 1], ['Y', 18], ['S', 2], ['.', 1]),
    R(['.', 1], ['H', 1], ['Y', 20], ['S', 2]),
    R(['.', 1], ['Y', 4], ['W', 2], ['Y', 12], ['W', 2], ['Y', 1], ['S', 2]),
    R(['.', 2], ['Y', 3], ['W', 6], ['N', 2], ['W', 6], ['Y', 3], ['S', 2]),
    R(['.', 3], ['S', 2], ['Y', 2], ['W', 10], ['Y', 2], ['S', 2], ['.', 3]),
    R(['.', 4], ['H', 1], ['Y', 2], ['W', 10], ['Y', 2], ['S', 1], ['.', 4]),
    R(['.', 4], ['H', 1], ['Y', 2], ['W', 10], ['Y', 2], ['S', 1], ['.', 4]),
    R(['.', 4], ['H', 1], ['Y', 2], ['W', 10], ['Y', 2], ['S', 1], ['.', 4]),
    R(['.', 4], ['H', 1], ['Y', 2], ['W', 10], ['Y', 2], ['S', 1], ['.', 4]),
    R(['.', 4], ['S', 1], ['Y', 14], ['S', 1], ['.', 4]),
    R(['.', 5], ['S', 14], ['.', 5]),
    R(['.', 5], ['a', 3], ['.', 8], ['b', 3], ['.', 5]),
    R(['.', 4], ['a', 5], ['.', 6], ['b', 5], ['.', 4]),
  ];
  const foxPal = { S: '#c0561e', H: '#f7a866', Y: '#e8803a', W: '#fbf0e0', N: '#2b2420', a: ['#3a2a24', 'cp-leg-a'], b: ['#3a2a24', 'cp-leg-b'] };
  const FOX_TAIL = ['....YY', '...YYY', '..YYYS', '.YYYYS', 'YYYYS.', 'YWWW..'];
  const foxTailPal = { Y: '#e8803a', S: '#c0561e', W: '#fbf0e0' };

  // ── bee: hovers, buzzing wings, no ground line ──
  const BEE = [
    R(['.', 4], ['A', 1], ['.', 8], ['A', 1], ['.', 4]),
    R(['.', 5], ['A', 1], ['.', 6], ['A', 1], ['.', 5]),
    R(['.', 3], ['H', 2], ['Y', 8], ['S', 2], ['.', 3]),
    R(['.', 2], ['H', 1], ['Y', 12], ['S', 2], ['.', 1]),
    R(['.', 2], ['Y', 13], ['S', 2], ['.', 1]),
    R(['.', 2], ['Y', 13], ['S', 2], ['.', 1]),
    R(['.', 1], ['K', 16], ['.', 1]),
    R(['.', 1], ['H', 1], ['Y', 14], ['S', 1], ['.', 1]),
    R(['.', 1], ['Y', 15], ['S', 1], ['.', 1]),
    R(['.', 1], ['K', 16], ['.', 1]),
    R(['.', 2], ['Y', 12], ['S', 2], ['.', 2]),
    R(['.', 2], ['Y', 12], ['S', 2], ['.', 2]),
    R(['.', 4], ['K', 10], ['.', 4]),
    R(['.', 7], ['K', 2], ['.', 9]),
  ];
  const beePal = { A: '#2b2b2b', H: '#ffe27a', Y: '#f5c518', S: '#d09a0c', K: '#2b2b2b' };
  const BEE_WING_L = ['..WWW.', '.WWWWW', 'WWWWWW', '.WWWWW', '..WW..'];
  const BEE_WING_R = ['.WWW..', 'WWWWW.', 'WWWWWW', 'WWWWW.', '..WW..'];
  const beeWingPal = { W: '#dff1ff' };

  // ── axolotl: wide flat head, frilly gills, a paddle tail ──
  const AXO = [
    R(['.', 7], ['H', 2], ['Y', 6], ['S', 2], ['.', 7]),
    R(['g', 2], ['.', 2], ['H', 2], ['Y', 12], ['S', 2], ['.', 2], ['g', 2]),
    R(['g', 3], ['.', 1], ['H', 2], ['Y', 12], ['S', 2], ['.', 1], ['g', 3]),
    R(['g', 2], ['G', 1], ['H', 1], ['Y', 16], ['S', 1], ['G', 1], ['g', 2]),
    R(['.', 1], ['g', 2], ['G', 1], ['Y', 16], ['G', 1], ['g', 2], ['.', 1]),
    R(['.', 2], ['g', 1], ['G', 1], ['Y', 16], ['G', 1], ['g', 1], ['.', 2]),
    R(['.', 4], ['Y', 16], ['.', 4]),
    R(['.', 4], ['H', 1], ['Y', 14], ['S', 1], ['.', 4]),
    R(['.', 3], ['H', 1], ['Y', 16], ['S', 1], ['.', 3]),
    R(['.', 3], ['Y', 17], ['S', 1], ['.', 3]),
    R(['.', 3], ['Y', 6], ['B', 6], ['Y', 5], ['S', 1], ['.', 3]),
    R(['.', 3], ['Y', 6], ['B', 6], ['Y', 5], ['S', 1], ['.', 3]),
    R(['.', 4], ['S', 1], ['Y', 14], ['S', 1], ['.', 4]),
    R(['.', 5], ['S', 14], ['.', 5]),
    R(['.', 4], ['a', 4], ['.', 8], ['b', 4], ['.', 4]),
    R(['.', 4], ['a', 4], ['.', 8], ['b', 4], ['.', 4]),
  ];
  const axoPal = { H: '#ffd0dc', Y: '#f4a6b8', S: '#d4748f', B: '#ffe3ea', g: '#e0566f', G: '#f07a92', a: ['#d4748f', 'cp-leg-a'], b: ['#d4748f', 'cp-leg-b'] };
  const AXO_TAIL = ['YYY...', 'YYYYY.', '.YYYYS', '..SSS.'];
  const axoTailPal = { Y: '#f4a6b8', S: '#d4748f' };

  // ── mushroom: the cap is the hat line, the face is on the stem ──
  const MUSH = [
    R(['.', 6], ['H', 2], ['C', 6], ['c', 2], ['.', 6]),
    R(['.', 4], ['H', 2], ['C', 3], ['P', 2], ['C', 5], ['c', 2], ['.', 4]),
    R(['.', 2], ['H', 1], ['C', 2], ['P', 3], ['C', 6], ['P', 2], ['C', 3], ['c', 2], ['.', 1]),
    R(['.', 1], ['H', 1], ['C', 4], ['P', 2], ['C', 6], ['P', 3], ['C', 3], ['c', 2]),
    R(['.', 1], ['C', 3], ['P', 3], ['C', 10], ['P', 2], ['C', 2], ['c', 1]),
    R(['.', 1], ['R', 20], ['.', 1]),
    R(['.', 3], ['U', 16], ['.', 3]),
    R(['.', 6], ['M', 8], ['m', 2], ['.', 6]),
    R(['.', 6], ['M', 8], ['m', 2], ['.', 6]),
    R(['.', 6], ['M', 8], ['m', 2], ['.', 6]),
    R(['.', 6], ['M', 8], ['m', 2], ['.', 6]),
    R(['.', 6], ['M', 8], ['m', 2], ['.', 6]),
    R(['.', 6], ['M', 8], ['m', 2], ['.', 6]),
    R(['.', 5], ['M', 10], ['m', 2], ['.', 5]),
    R(['.', 4], ['M', 12], ['m', 2], ['.', 4]),
    R(['.', 4], ['a', 5], ['.', 4], ['b', 5], ['.', 4]),
  ];
  const mushPal = { H: '#f27a5e', C: '#d4452e', c: '#a82f1e', P: '#fbeed2', R: '#a82f1e', U: '#e9d3a6', M: '#f1e4c8', m: '#d9c7a3', a: ['#d9c7a3', 'cp-leg-a'], b: ['#d9c7a3', 'cp-leg-b'] };

  return [
    frame({
      id: 'owl', name: 'Owl', legs: true,
      anchors: {
        head: { x: 16, y: 38, w: 32, h: 16 }, hatLine: 38, ground: 68,
        eyes: { left: { x: 24, y: 45 }, right: { x: 40, y: 45 } }, mouth: { x: 32, y: 50 }, hands: null,
        faceBox: { x: 18, y: 40, w: 28, h: 14 }, skinParts: [],
      },
      sprite: { body: px(OWL, owlPal, 36) },
    }),
    frame({
      id: 'penguin', name: 'Penguin', legs: true,
      anchors: {
        head: { x: 18, y: 36, w: 28, h: 14 }, hatLine: 36, ground: 68,
        eyes: { left: { x: 25, y: 44 }, right: { x: 39, y: 44 } }, mouth: { x: 32, y: 49 }, hands: null,
        faceBox: { x: 22, y: 42, w: 20, h: 10 }, skinParts: [],
      },
      sprite: { body: px(PENGUIN, penguinPal, 36) },
    }),
    frame({
      id: 'fox', name: 'Fox', legs: true,
      anchors: {
        head: { x: 10, y: 40, w: 44, h: 12 }, hatLine: 40, ground: 68,
        eyes: { left: { x: 23, y: 45 }, right: { x: 41, y: 45 } }, mouth: { x: 32, y: 52 },
        hands: { left: { x: 8, y: 54 }, right: { x: 54, y: 54 } },
        faceBox: { x: 18, y: 40, w: 28, h: 14 }, skinParts: [],
      },
      sprite: {
        back: `<g class="fox-tail">${px(FOX_TAIL, foxTailPal, 50, 44)}</g>`,
        body: px(FOX, foxPal, 36),
      },
    }),
    frame({
      id: 'bee', name: 'Bee', legs: false,
      anchors: {
        head: { x: 16, y: 40, w: 32, h: 10 }, hatLine: 40, ground: 68,
        eyes: { left: { x: 25, y: 45 }, right: { x: 39, y: 45 } }, mouth: { x: 32, y: 48 }, hands: null,
        faceBox: { x: 18, y: 40, w: 28, h: 10 }, skinParts: [],
      },
      sprite: {
        back: `<g class="bee-wing bee-wing-l" opacity="0.85">${px(BEE_WING_L, beeWingPal, 38, 6)}</g><g class="bee-wing bee-wing-r" opacity="0.85">${px(BEE_WING_R, beeWingPal, 38, 46)}</g>`,
        body: `<g class="bee-hover">${px(BEE, beePal, 36)}</g>`,
      },
    }),
    frame({
      id: 'axolotl', name: 'Axolotl', legs: true,
      anchors: {
        head: { x: 16, y: 36, w: 32, h: 14 }, hatLine: 36, ground: 68,
        eyes: { left: { x: 23, y: 45 }, right: { x: 41, y: 45 } }, mouth: { x: 32, y: 50 }, hands: null,
        faceBox: { x: 18, y: 38, w: 28, h: 14 }, skinParts: [],
      },
      sprite: {
        back: `<g class="axo-tail">${px(AXO_TAIL, axoTailPal, 54, 50)}</g>`,
        body: px(AXO, axoPal, 36),
      },
    }),
    frame({
      id: 'mushroom', name: 'Mushroom', legs: true,
      anchors: {
        head: { x: 12, y: 36, w: 40, h: 20 }, hatLine: 36, ground: 68,
        eyes: { left: { x: 27, y: 54 }, right: { x: 37, y: 54 } }, mouth: { x: 32, y: 59 }, hands: null,
        faceBox: { x: 24, y: 50, w: 16, h: 16 }, skinParts: [],
      },
      sprite: { body: px(MUSH, mushPal, 36) },
    }),
  ];
});
