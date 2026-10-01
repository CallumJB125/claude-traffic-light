// The starter six: a rubber duck, an octopus, a CRT monitor, a blob, a
// capybara and a cactus. Each is a different shape on purpose (no hands, many
// hands, a screen for a face, no legs, a low hat line, tall and thin), so the
// contract is exercised by real characters and not only by test probes.
//
// Drawn as pixel art on the rig's grid, one pixel = 2 units, from rows of
// letters (see px() below). Each has a small palette of base, shade and
// highlight, light from the upper left, and no outlines. The rig draws the
// eyes, mouth, costumes and hands at the anchors, so no face is baked in.
// Original designs, not any company's mascot.
(function (root, factory) {
  const C = typeof module === 'object' && module.exports ? require('../contract.js') : root.BuddyCharacters;
  const defs = factory();
  for (const d of defs) C.register(d, { builtin: true });
  C.sealBuiltins();
  if (typeof module === 'object' && module.exports) module.exports = defs;
})(typeof self !== 'undefined' ? self : this, function () {
  const U = 2;
  // rows of letters -> merged rects. '.' is empty; a palette entry is a colour,
  // or [colour, class] for a part the rig animates (a leg, a tentacle). The
  // left edge is centred on x = 32 for a drawing `cols` pixels wide.
  function px(rows, pal, oy, cols = rows[0].length) {
    const ox = 32 - (cols * U) / 2;
    const out = [];
    rows.forEach((row, r) => {
      if (row.length !== cols) throw new Error(`pixel row ${r} is ${row.length} wide, expected ${cols}: ${row}`);
      let c = 0;
      while (c < cols) {
        const ch = row[c];
        if (ch === '.') { c += 1; continue; }
        let e = c;
        while (e < cols && row[e] === ch) e += 1;
        const p = pal[ch];
        if (!p) throw new Error(`no colour for "${ch}" in row ${r}`);
        const [fill, cls] = Array.isArray(p) ? p : [p];
        out.push(`<rect x="${ox + c * U}" y="${oy + r * U}" width="${(e - c) * U}" height="${U}" fill="${fill}"${cls ? ` class="${cls}"` : ''} />`);
        c = e;
      }
    });
    return `<g shape-rendering="crispEdges">${out.join('')}</g>`;
  }

  // ── rubber duck: no hands (the sign floats), the bill is the mouth, waddles ──
  const DUCK = [
    '....HHYYYYYY....',
    '..HHYYYYYYYYYY..',
    '..HYYYYYYYYYYS..',
    '..YYYYYYYYYYYS..',
    '..YYYYYYYYYYYS..',
    '..YYYYYYYYYYSS..',
    '..YYYOOOOOOYYS..',
    '..YYYYDDDDYYYS..',
    '.HYYYYYYYYYYYYS.',
    '.YYYYBBBBBBYYYS.',
    '.YYYYBBBBBBYYYS.',
    '.YYYYYBBBBYYYYS.',
    '..SYYYYYYYYYYS..',
    '...SSSSSSSSSS...',
    '..aaaa....bbbb..',
    '.aaaaaa..bbbbbb.',
  ];
  const duckPal = { H: '#ffe98a', Y: '#f6c935', S: '#d9a11c', B: '#ffe9a6', O: '#f28c28', D: '#c9661a', a: ['#f28c28', 'cp-leg-a'], b: ['#f28c28', 'cp-leg-b'] };

  // ── octopus: many hands. One tentacle holds the sign, the rest are its legs ──
  const OCTO = [
    '.......HHYYYYYYYY.......',
    '.....HHYYYYYYYYYYYY.....',
    '....HYYYYYYYYYYYYYYS....',
    '...YYYYYYYYYYYYYYYYYS...',
    '...YYYYYYYYYYYYYYYYYS...',
    'YY.YYYYYYYYYYYYYYYYYS...',
    'YY.YYYYYYYYYYYYYYYYYSYY.',
    'YYYYYYYYYYYYYYYYYYYYSSYY',
    '.YYYYYYYYYYYYYYYYYYYYSY.',
    'aaaa.bbbb.aaaa.bbbb.aaaa',
    'aaaa.bbbb.aaaa.bbbb.aaaa',
    'asaa.bsbb.asaa.bsbb.asaa',
    'aaaa.bbbb.aaaa.bbbb.aaaa',
    'asaa.bsbb.asaa.bsbb.asaa',
    'aaaa.bbbb.aaaa.bbbb.aaaa',
    '.aa...bb...aa...bb...aa.',
  ];
  const octoPal = { H: '#c0a6f5', Y: '#8f6bd6', S: '#6b49ac', a: ['#8f6bd6', 'cp-leg-a'], b: ['#8f6bd6', 'cp-leg-b'], s: '#d9c9fa' };

  // ── CRT monitor: not alive. The face goes on the screen; one eye ──
  const CRT = [
    '..HHHHHHHHHHHHHHHHHHHHHH..',
    '.HCCCCCCCCCCCCCCCCCCCCCCS.',
    '.HCCCCCCCCCCCCCCCCCCCCCCS.',
    '.HCCEEEEEEEEEEEEEEEEEECCS.',
    '.HCCEggggggggggggggggECCS.',
    '.HCCEgGGGGGGGGGGGGGGGECCS.',
    '.HCCEgGGGGGGGGGGGGGGGECCS.',
    '.HCCEgGGGGGGGGGGGGGGGECCS.',
    '.HCCEgGGGGGGGGGGGGGGGECCS.',
    '.HCCEgGGGGGGGGGGGGGGGECCS.',
    '.HCCEEEEEEEEEEEEEEEEEECCS.',
    '.HCCCCCCCCCCCCCCCCCCCaCCS.',
    '..SSSSSSSSSSSSSSSSSSSSSS..',
    '.........CCCCCCCC.........',
    '......dddddddddddddd......',
    '....dddddddddddddddddd....',
  ];

  // ── blob: no legs, fully round, squashes and stretches ──
  const BLOB = [
    '...........HHHH...........',
    '.........HHYYYYYY.........',
    '.......HHYYYYYYYYYY.......',
    '......HYYYYYYYYYYYYYS.....',
    '.....HYYYYYYYYYYYYYYYYS...',
    '....HYYYYYYYYYYYYYYYYYS...',
    '....YYYYYYYYYYYYYYYYYYYS..',
    '...YYYYYYYYYYYYYYYYYYYYS..',
    '...YYYYYYYYYYYYYYYYYYYYYS.',
    '..YYYYYYYYYYYYYYYYYYYYYYS.',
    '..YYYYYYYYYYYYYYYYYYYYYYS.',
    '.YYYYYYYYYYYYYYYYYYYYYYYYS',
    '.YYYYYYYYYYYYYYYYYYYYYYYSS',
    '.SYYYYYYYYYYYYYYYYYYYYYSS.',
    '..SSSSSSSSSSSSSSSSSSSSSS..',
    '....SS.....SS.....SS......',
  ];

  // ── capybara: wide and relaxed, low hat line ──
  const CAPY = [
    '....SS..............SS....',
    '....SYY............YYS....',
    '...HYYYYYYYYYYYYYYYYYYS...',
    '..HYYYYYYYYYYYYYYYYYYYYS..',
    '..YYYYYYYYYYYYYYYYYYYYYS..',
    '..YYYYYYYYYYYYYYYYYYYYYS..',
    '..YYYYYYYYYYYYYYYYYYYYYS..',
    '..YYYYYYYNnNNNNnNYYYYYYS..',
    '..YYYYYYNNNNNNNNNNYYYYYS..',
    '..YYYYYYNNNNNNNNNNYYYYYS..',
    '.SYYYYYYYNmmmmmmNYYYYYYSS.',
    'AAYYYYYYYYYYYYYYYYYYYYYYBB',
    'AAYYYYYYYYYYYYYYYYYYYYYYBB',
    '.SYYYYYYYYYYYYYYYYYYYYYSS.',
    '..aaaa..bbbb..aaaa..bbbb..',
    '..aaaa..bbbb..aaaa..bbbb..',
  ];
  const capyPal = { H: '#cfa575', Y: '#b08454', S: '#8a6339', N: '#d7b48a', n: '#4f3522', m: '#7a5634', A: '#b08454', B: '#b08454', a: ['#8a6339', 'cp-leg-a'], b: ['#8a6339', 'cp-leg-b'] };

  // ── cactus: tall and thin, two arms up, spikes ──
  const CAC = [
    '.......PP.......',
    '....HHYYYYSS....',
    '....HYYYYYYS....',
    'GGG.HYYKYYYS.GGG',
    'GgG.HYYYYYYS.GgG',
    'GgG.HYYYYKYS.GgG',
    'GgG.HYKYYYYS.GgG',
    'GgG.HYYYYYYS.GgG',
    'GGGGGYYYKYYSGGGG',
    '.GGGGYYYYYYSGGG.',
    '....HYYYYYYS....',
    '....HYYYYYKS....',
    '..RRRRRRRRRRRR..',
    '...RTTTTTTTTRR..',
    '....RRRRRRRRR...',
  ];
  const cacPal = { P: '#f06fa0', H: '#6fcf7a', Y: '#3fae55', S: '#2d8643', G: '#3fae55', g: '#6fcf7a', K: '#f4f0c0', R: '#c9714a', r: '#c9714a', T: '#e08a5f' };

  const frame = (over) => ({ contract: 1, ...over });
  return [
    frame({
      id: 'duck', name: 'Rubber duck', legs: true,
      anchors: {
        head: { x: 20, y: 36, w: 24, h: 16 }, hatLine: 36, ground: 68,
        eyes: { left: { x: 25, y: 44 }, right: { x: 39, y: 44 } }, mouth: { x: 32, y: 50 }, hands: null,
        faceBox: { x: 22, y: 36, w: 20, h: 16 }, skinParts: [],
      },
      sprite: { body: px(DUCK, duckPal, 36) },
    }),
    frame({
      id: 'octopus', name: 'Octopus', legs: true,
      anchors: {
        head: { x: 14, y: 36, w: 36, h: 16 }, hatLine: 36, ground: 68,
        eyes: { left: { x: 25, y: 46 }, right: { x: 39, y: 46 } }, mouth: { x: 32, y: 51 },
        hands: { left: { x: 8, y: 40 }, right: { x: 53, y: 50 } },
        faceBox: { x: 18, y: 36, w: 28, h: 18 }, skinParts: [],
      },
      sprite: { body: px(OCTO, octoPal, 36) },
    }),
    frame({
      id: 'crt', name: 'CRT monitor', legs: false,
      anchors: {
        head: { x: 8, y: 36, w: 48, h: 26 }, hatLine: 36, ground: 68,
        eyes: { single: { x: 32, y: 47 } }, mouth: { x: 32, y: 54 },
        hands: { left: { x: 7, y: 44 }, right: { x: 57, y: 50 } },
        faceBox: { x: 16, y: 42, w: 32, h: 16 }, skinParts: [],
      },
      sprite: { body: px(CRT, { H: '#f1ecde', C: '#d3ccbb', S: '#a9a28f', E: '#6e685a', g: '#7fae7f', G: '#b9e4b3', a: '#e8a02a', d: '#a9a28f' }, 36) },
    }),
    frame({
      id: 'blob', name: 'Blob', legs: false,
      anchors: {
        head: { x: 8, y: 40, w: 48, h: 24 }, hatLine: 36, ground: 68,
        eyes: { left: { x: 24, y: 48 }, right: { x: 40, y: 48 } }, mouth: { x: 32, y: 54 }, hands: null,
        faceBox: { x: 16, y: 40, w: 32, h: 24 }, skinParts: [],
      },
      sprite: { body: px(BLOB, { H: '#b9f6ec', Y: '#4fcfc0', S: '#2b9aa0' }, 36) },
    }),
    frame({
      id: 'capybara', name: 'Capybara', legs: true,
      anchors: {
        head: { x: 8, y: 40, w: 48, h: 22 }, hatLine: 40, ground: 68,
        eyes: { left: { x: 22, y: 46 }, right: { x: 42, y: 46 } }, mouth: { x: 32, y: 56 },
        hands: { left: { x: 6, y: 56 }, right: { x: 55, y: 54 } },
        faceBox: { x: 16, y: 40, w: 32, h: 22 }, skinParts: [],
      },
      sprite: { body: px(CAPY, capyPal, 36) },
    }),
    frame({
      id: 'cactus', name: 'Cactus', legs: false,
      anchors: {
        head: { x: 24, y: 38, w: 16, h: 14 }, hatLine: 38, ground: 68,
        eyes: { left: { x: 29, y: 46 }, right: { x: 36, y: 46 } }, mouth: { x: 32.5, y: 51 },
        hands: null,
        faceBox: { x: 24, y: 38, w: 16, h: 14 }, skinParts: [],
      },
      sprite: { body: px(CAC, cacPal, 36) },
    }),
  ];
});
