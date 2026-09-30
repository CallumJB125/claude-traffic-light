const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Characters = require('../characters/contract.js');
const CORE = require('../characters/builtin/core.js');
const { validateCharacter, sanitizeSvg, checkGeometry } = require('../characters/validate.js');
const Rules = require('../rules.js');

const ROOT = path.join(__dirname, '..');
const clone = (v) => JSON.parse(JSON.stringify(v));
const claude = () => clone(Characters.get('claude'));

// ── registry and anchors ──────────────────────────────────────────────────

test('characters: the built-ins are registered, and rules offers exactly them', () => {
  assert.deepEqual(Characters.ids(), ['claude', 'dog', 'cat', 'frog', 'robot', 'ghost']);
  assert.deepEqual(Rules.BODIES, Characters.ids());
  assert.equal(CORE.length, Characters.ids().length);
});

test('characters: every page that mounts the rig loads the contract, then the built-ins, before rig.js', () => {
  const pages = ['index.html', 'lights.html', 'tray.html', 'tools/tuning.html', 'test-visual/matrix/matrix.html'];
  for (const page of pages) {
    const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const at = (f) => src.search(new RegExp(`<script src="(\\.\\./)*${f.replace(/[./]/g, '\\$&')}"`));
    const [contract, core, rig] = ['characters/contract.js', 'characters/builtin/core.js', 'rig.js'].map(at);
    assert.ok(contract > 0 && contract < core && core < rig, `${page} loads contract < core < rig`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('characters/**/*'), 'characters ship in the app');
});

test('characters: Claude and the original bodies need no fitting (their rig is drawn for them)', () => {
  for (const def of Characters.list()) {
    const fit = Characters.anchorVars(def);
    assert.equal(fit.fitted, false, def.id);
    assert.equal(fit.css['--eye-s'], '1');
    assert.equal(fit.css['--hat-dy'], '0px');
  }
});

test('characters: anchors that differ become offsets from Claude’s frame', () => {
  const def = claude();
  def.anchors.eyes = { left: { x: 20, y: 40 }, right: { x: 51, y: 40 } };
  def.anchors.mouth = { x: 35, y: 48 };
  def.anchors.head = { x: 12, y: 30, w: 45, h: 20 };
  def.anchors.hatLine = 29;
  def.anchors.hands = { left: { x: 6.5, y: 30 }, right: { x: 50, y: 52 } };
  const { fitted, vars, css } = Characters.anchorVars(def);
  assert.equal(fitted, true);
  assert.deepEqual(vars, {
    '--eye-dx': 3.5, '--eye-dy': -5.75, '--eye-s': 2,
    '--mouth-dx': 3, '--mouth-dy': -2,
    '--hat-dx': 2.5, '--hat-dy': -10, '--hat-s': 1.5,
    '--hand-l-dx': 2, '--hand-l-dy': -4, '--hand-r-dx': -3.5, '--hand-r-dy': 3,
  });
  assert.equal(css['--eye-dx'], '3.5px');
  assert.equal(css['--hat-s'], '1.5');
});

test('characters: a single eye centres the eyes on it; no eyes or hands are capabilities, not errors', () => {
  const def = claude();
  def.anchors.eyes = { single: { x: 32, y: 44 } };
  assert.equal(Characters.anchorVars(def).vars['--eye-dy'], -1.75);
  assert.equal(Characters.capabilities(def).eyes, 'single');
  def.anchors.eyes = 'none';
  def.anchors.hands = null;
  def.anchors.mouth = null;
  def.legs = false;
  assert.deepEqual(Characters.capabilities(def), { hands: false, handCount: 0, mouth: false, eyes: 'none', legs: false });
  assert.deepEqual(Characters.capabilities(Characters.get('ghost')), { hands: false, handCount: 0, mouth: true, eyes: 'pair', legs: false });
});

test('characters: layers wrap in the rig’s classes; skin layers follow --body-color, others keep their colour', () => {
  assert.match(Characters.layerMarkup(Characters.get('claude'), 'body'), /^<g class="body body-default" fill="var\(--body-color, #da7756\)">/);
  assert.match(Characters.layerMarkup(Characters.get('dog'), 'body'), /^<g class="body body-dog" fill="#b07a4a">/);
  assert.equal(Characters.layerMarkup(Characters.get('dog'), 'face'), '');
  const def = { ...claude(), id: 'test', sprite: { body: '<rect />', front: '<rect />' } };
  assert.match(Characters.layerMarkup(def, 'front'), /^<g class="char-front-part">/);
});

// ── the sanitiser ─────────────────────────────────────────────────────────

const clean = (markup) => sanitizeSvg(markup).svg;

test('sanitiser: allowed shapes and attributes survive, re-serialised', () => {
  const r = sanitizeSvg('<g fill="#fff"><rect x="1" y="2" width="3" height="4" rx="1"/><circle cx="5" cy="5" r="2" class="skin"></circle></g><!-- a note --><path d="M0 0 l4 4 z" stroke="var(--body-color, #da7756)" stroke-linecap="round" />');
  assert.equal(r.ok, true);
  assert.deepEqual(r.removed, []);
  assert.equal(r.svg, '<g fill="#fff"><rect x="1" y="2" width="3" height="4" rx="1" /><circle cx="5" cy="5" r="2" class="skin" /></g><path d="M0 0 l4 4 z" stroke="var(--body-color, #da7756)" stroke-linecap="round" />');
  assert.equal(clean(r.svg), r.svg, 'sanitising twice changes nothing');
});

test('sanitiser: scripts, foreign content, links and animation are removed with everything inside them', () => {
  const cases = [
    '<script>alert(1)</script>',
    '<SCRIPT>alert(1)</SCRIPT>',
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"></div></foreignObject>',
    '<a href="javascript:alert(1)"><rect width="9" height="9" /></a>',
    '<use href="#lamp-square" />',
    '<image href="https://evil.example/t.png" />',
    '<style>.rig{display:none}</style>',
    '<set attributeName="href" to="javascript:alert(1)" />',
    '<animate attributeName="fill" values="red" />',
    '<g><text>hi</text></g>',
    '<iframe src="https://evil.example"></iframe>',
    '<svg onload="alert(1)"><rect /></svg>',
    '<symbol id="lamp-square"><rect /></symbol>',
    '<filter id="x"><feImage href="https://evil.example" /></filter>',
  ];
  for (const c of cases) {
    const r = sanitizeSvg(c);
    const out = r.svg.toLowerCase();
    for (const bad of ['script', 'href', 'onload', 'onerror', 'style', 'foreign', 'iframe', 'use', 'image', 'set ', 'animate', 'symbol', 'filter', 'evil']) {
      assert.ok(!out.includes(bad), `${c} → ${r.svg} contains ${bad}`);
    }
  }
  assert.equal(sanitizeSvg('<g><text>hi</text></g>').ok, false, 'text content is refused, not passed through');
});

test('sanitiser: dangerous attributes and values are dropped from allowed elements', () => {
  const r = sanitizeSvg('<rect onclick="alert(1)" style="fill:url(https://e.example)" id="lamp-square" href="#x" xlink:href="#x" fill="url(#g)" stroke="javascript:alert(1)" class="costume-crown" transform="translate(1,2) url(x)" width="10" height="10" x="1e3" />');
  assert.equal(r.ok, true);
  assert.equal(r.svg, '<rect width="10" height="10" />');
  assert.equal(r.removed.length, 10);
  const d = sanitizeSvg('<path d="M0 0 L10 10 url(#x)" /><path d="M0 0 &#76;10 10" /><polygon points="0,0 1,1 expression(1)" />');
  assert.equal(d.svg, '<path /><path /><polygon />');
});

test('sanitiser: entities, doctype, CDATA and processing instructions are refused outright', () => {
  for (const c of ['<!DOCTYPE svg [<!ENTITY x "y">]><rect />', '<![CDATA[<script>]]>', '<?xml version="1.0"?><rect />', '<rect fill="&#35;fff" />']) {
    const r = sanitizeSvg(c);
    assert.ok(!r.svg.includes('&') && !r.svg.includes('<!') && !r.svg.includes('<?'), c);
  }
  assert.equal(sanitizeSvg('<!DOCTYPE svg><rect />').ok, false);
});

test('sanitiser: malformed markup fails instead of being guessed at', () => {
  for (const c of ['<rect', '<g><rect /></rect>', '<g>', '</g>', '<rect x=1 />', '<rect x="1"y="2" />', '<rect x="1" x="2" />', 'text', '<rect x="<" />', '<<rect />']) {
    assert.equal(sanitizeSvg(c).ok, false, c);
    assert.equal(sanitizeSvg(c).svg, '', c);
  }
});

test('sanitiser: size, element count and depth are capped', () => {
  assert.equal(sanitizeSvg(`<g>${'<rect />'.repeat(9000)}</g>`).ok, false);
  assert.equal(sanitizeSvg('<rect />'.repeat(1501)).errors[0].code, 'svg-too-big');
  assert.equal(sanitizeSvg(`${'<g>'.repeat(20)}${'</g>'.repeat(20)}`).errors[0].code, 'svg-too-deep');
  assert.equal(sanitizeSvg(42).ok, false);
});

test('sanitiser: fuzzed input never yields markup outside the allowlist', () => {
  const bits = ['<g>', '</g>', '<rect x="1" width="2" height="2" />', '<script>', '</script>', ' onload="x"', '"', "'", '<', '>', '&amp;', 'href="#a"', '<path d="M1 1" />', '<a>', '</a>', 'fill="#fff"', '/>', '<!--', '-->', '<circle r="1" />', 'javascript:', 'url(', '<![CDATA[', ' '];
  let seed = 12345;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const TAG = /<\/?([a-zA-Z]+)/g;
  for (let n = 0; n < 3000; n += 1) {
    const src = Array.from({ length: 1 + Math.floor(rnd() * 14) }, () => bits[Math.floor(rnd() * bits.length)]).join('');
    const r = sanitizeSvg(src);
    if (!r.ok) { assert.equal(r.svg, ''); continue; }
    for (const m of r.svg.matchAll(TAG)) assert.ok(['g', 'rect', 'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline'].includes(m[1]), `${src} → ${r.svg}`);
    for (const bad of ['script', 'href', 'onload', 'javascript', 'url(', '&', '<!', '<a']) assert.ok(!r.svg.includes(bad), `${src} → ${r.svg}`);
    assert.equal(clean(r.svg), r.svg);
  }
});

// ── the validator ─────────────────────────────────────────────────────────

const importable = (over = {}) => ({ ...claude(), id: 'otter', name: 'Otter', ...over });

test('validator: every built-in passes as a built-in (edge warnings allowed)', () => {
  for (const def of Characters.list()) {
    const r = validateCharacter(clone(def), { source: 'builtin' });
    assert.deepEqual(r.errors, [], def.id);
    assert.equal(r.ok, true);
  }
});

test('validator: an import may not take a built-in id or carry CSS', () => {
  const taken = validateCharacter(importable({ id: 'claude' }));
  assert.equal(taken.ok, false);
  assert.equal(taken.errors[0].code, 'id-taken');
  const css = validateCharacter(importable({ css: '.rig { display: none }' }));
  assert.deepEqual(css.errors.map((e) => e.code), ['css-not-allowed']);
  assert.equal(css.character, null);
});

test('validator: the result is a fresh object of known fields with sanitised markup', () => {
  const input = JSON.parse(`{"__proto__": {"polluted": true}, "id": "otter", "name": "Otter<script>", "contract": 1, "legs": true, "evil": "x",
    "anchors": ${JSON.stringify(Characters.REF)},
    "sprite": { "body": "<rect x=\\"17\\" y=\\"39\\" width=\\"30\\" height=\\"13\\" onclick=\\"x\\" />", "extra": "<script />" }}`);
  const r = validateCharacter(input);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const c = r.character;
  assert.equal(c.name, 'Otterscript');
  assert.equal(c.evil, undefined);
  assert.equal(c.sprite.extra, undefined);
  assert.equal(c.sprite.body, '<rect x="17" y="39" width="30" height="13" />');
  assert.equal({}.polluted, undefined);
  assert.deepEqual(r.warnings.map((w) => w.code).sort(), ['svg-removed', 'unknown-layer']);
});

test('validator: schema errors name the field', () => {
  const bad = importable({ id: 'Bad Id', name: '', contract: 2, color: 'red', legs: 'yes', sprite: {} });
  bad.anchors = { ...bad.anchors, head: { x: 0, y: 0, w: -1, h: 5 }, eyes: 'three', mouth: 'here', hands: 7, skinParts: ['tail'], ground: 10 };
  const paths = validateCharacter(bad).errors.map((e) => e.path);
  for (const p of ['id', 'name', 'contract', 'color', 'legs', 'anchors.head', 'anchors.eyes', 'anchors.mouth', 'anchors.hands', 'anchors.skinParts', 'anchors.ground', 'sprite.body']) assert.ok(paths.includes(p), p);
  assert.equal(validateCharacter(null).ok, false);
  assert.equal(validateCharacter([]).ok, false);
});

test('validator: geometry — eyes and mouth in the face box, hats on the head, held things on the grid', () => {
  const codes = (over) => validateCharacter(importable({ anchors: { ...claude().anchors, ...over } })).errors.map((e) => e.code);
  assert.deepEqual(codes({ eyes: { left: { x: 2, y: 45 }, right: { x: 39, y: 45 } } }), ['eye-outside-face']);
  assert.deepEqual(codes({ mouth: { x: 32, y: 70 } }), ['mouth-outside-face']);
  assert.deepEqual(codes({ hatLine: 10 }), ['hat-off-head']);
  assert.deepEqual(codes({ hands: { left: { x: 1, y: 34 }, right: { x: 53.5, y: 49 } } }), ['held-outside']);
  assert.deepEqual(codes({ hands: { left: { x: 4.5, y: 34 }, right: { x: 62, y: 49 } } }), ['held-outside']);
  assert.deepEqual(codes({ faceBox: { x: 50, y: 0, w: 10, h: 10 }, eyes: 'none', mouth: null }), ['face-off-head']);
  assert.deepEqual(codes({ hands: null, eyes: 'none', mouth: null }), [], 'a limbless, faceless blob is valid');
});

test('validator: a sprite past the grid is clipped (error) or at its edge (warning)', () => {
  const far = validateCharacter(importable({ sprite: { body: '<rect x="17" y="39" width="60" height="13" />' } }));
  assert.deepEqual(far.errors.map((e) => e.code), ['sprite-clipped']);
  const edge = validateCharacter(importable({ sprite: { body: '<path d="M17 39 h49 v5 z" />' } }));
  assert.equal(edge.ok, true);
  assert.deepEqual(edge.warnings.map((w) => w.code), ['sprite-edge']);
  const deep = validateCharacter(importable({ sprite: { body: '<circle cx="32" cy="76" r="3" />' } }));
  assert.deepEqual(deep.warnings.map((w) => w.code), ['below-ground']);
});

test('validator: a mini sprite is sanitised parts inside the chip box', () => {
  const ok = validateCharacter(importable({ mini: [['rect', { x: 0.5, y: 0.5, width: 5, height: 6, fill: 'currentColor' }], ['circle', { cx: 2, cy: 2, r: 0.5, fill: '#211f1c' }]] }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.character.mini, [['rect', { x: '0.5', y: '0.5', width: '5', height: '6', fill: 'currentColor' }], ['circle', { cx: '2', cy: '2', r: '0.5', fill: '#211f1c' }]]);
  assert.deepEqual(validateCharacter(importable({ mini: [['rect', { width: 40, height: 40 }]] })).errors.map((e) => e.code), ['mini-size']);
  assert.deepEqual(validateCharacter(importable({ mini: [['image', { href: 'https://e.example' }]] })).errors.map((e) => e.code), ['mini-part']);
  assert.deepEqual(validateCharacter(importable({ mini: [['rect', { width: 1, height: 1, fill: 'url(#x)' }]] })).errors.map((e) => e.code), ['svg-removed']);
  // the tag and attribute names are data, never markup
  assert.deepEqual(validateCharacter(importable({ mini: [['rect x="1"/><rect x="2"/><rect', { y: 1 }]] })).errors.map((e) => e.code), ['mini-part']);
  assert.deepEqual(validateCharacter(importable({ mini: [['rect', { width: 5, height: 5, transform: 'scale(200)' }]] })).errors.map((e) => e.code), ['mini-part']);
  const smuggled = validateCharacter(importable({ mini: [['rect', { onload: 'x"><script>' }]] }));
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.character, null);
});

test('validator: per-costume offsets are bounded numbers', () => {
  const ok = validateCharacter(importable({ offsets: { tophat: { dy: -3 }, crown: { dx: 1, dy: 0, s: 0.8 } } }));
  assert.deepEqual({ ...ok.character.offsets }, { tophat: { dx: 0, dy: -3, s: 1 }, crown: { dx: 1, dy: 0, s: 0.8 } });
  assert.deepEqual(validateCharacter(importable({ offsets: JSON.parse('{"constructor": {"dy": 1}}') })).errors.map((e) => e.code), ['offset']);
  assert.deepEqual(validateCharacter(importable({ offsets: { tophat: { dy: 900 } } })).errors.map((e) => e.code), ['offset']);
});

test('checkGeometry: runs on a built-in without a sprite extent', () => {
  assert.deepEqual(checkGeometry(claude()), []);
});

// ── regressions from the sanitiser security review ────────────────────────

test('security: an unclosed transform full of spaces is rejected quickly (no ReDoS)', () => {
  for (const pad of [' ', '\t']) {
    const t = Date.now();
    const r = sanitizeSvg(`<rect transform="scale(${pad.repeat(500)}" />`);
    assert.ok(Date.now() - t < 50, 'linear time');
    assert.equal(r.svg, '<rect />');
    assert.equal(sanitizeSvg(`<rect transform="scale(${pad.repeat(65000)}" />`).svg, '<rect />');
  }
});

test('security: character classes cannot name a rig hook such as the body slot', () => {
  assert.equal(clean('<g class="char-body"><rect /></g>'), '<g><rect /></g>');
  assert.equal(clean('<rect class="skin cp-leg-a" />'), '<rect class="skin cp-leg-a" />');
});

test('security: transforms count toward geometry, and may not blow a part up', () => {
  const huge = validateCharacter(importable({ sprite: { body: '<g transform="scale(256)"><g transform="scale(256)"><rect width="1" height="1" /></g></g>' } }));
  assert.ok(huge.errors.some((e) => e.code === 'svg-scale'));
  assert.ok(huge.errors.some((e) => e.code === 'sprite-clipped') || huge.errors.some((e) => e.code === 'svg-scale'));
  const moved = validateCharacter(importable({ sprite: { body: '<g transform="translate(200 0)"><rect x="17" y="39" width="30" height="13" /></g>' } }));
  assert.deepEqual(moved.errors.map((e) => e.code), ['sprite-clipped']);
  const rotated = validateCharacter(importable({ sprite: { body: '<rect x="17" y="39" width="30" height="13" transform="rotate(10 32 45)" />' } }));
  assert.equal(rotated.ok, true, JSON.stringify(rotated.errors));
});

test('security: names lose control, bidi, zero-width and markup characters', () => {
  const r = validateCharacter(importable({ name: 'Ot‮ter​<b>&"`' }));
  assert.equal(r.character.name, 'Otterb');
});
