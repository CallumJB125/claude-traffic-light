'use strict';
// Redesign R0a/R0b: the snapshot classifier's rules (plan-redesign §R3.10, §R4.4), checked on synthetic pixels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../test-visual/classify-lib');

// The base is tokens.css as it stood before R0b (terracotta, frozen as a fixture); the head is the real tokens.css,
// so these tests check the flip R0b ships.
const TOKENS = fs.readFileSync(path.join(__dirname, 'fixtures', 'tokens-terracotta-r0a.css'), 'utf8');
const GRAPHITE = fs.readFileSync(path.join(__dirname, '..', 'tokens.css'), 'utf8');
const ALL = lib.familiesOf(TOKENS, GRAPHITE);
const FAM = ALL.both;

const hex = (h) => lib.parseColour(h).slice(0, 3);
const mix = (a, b, t) => a.map((v, i) => Math.round(v * t + b[i] * (1 - t)));
const PANEL_D = hex('#202329');
const PANEL_L = hex('#ffffff');

test('classifier: ΔE00 matches the Sharma reference pairs', () => {
  // Sharma, Wu & Dalal (2005), table 1, pairs 1 and 17.
  assert.ok(Math.abs(lib.deltaE00([50, 2.6772, -79.7751], [50, 0, -82.7485]) - 2.0425) < 1e-3);
  assert.ok(Math.abs(lib.deltaE00([50, 2.5, 0], [73, 25, -18]) - 27.1492) < 1e-3);
});

test('classifier: the families are read from tokens.css at the base and the head', () => {
  const rest = FAM.members.filter((m) => m.key === 'rest').map((m) => [m.old.join(), m.new.join()]);
  assert.deepEqual(rest.sort(), [[hex('#a34425').join(), hex('#24292f').join()], [hex('#e49a78').join(), hex('#e6e8eb').join()]].sort());
  assert.ok(FAM.members.some((m) => m.key === 'soft/--panel-2'));
  assert.ok(FAM.members.some((m) => m.key === 'ink~rest' && m.pairOld));
});

test('classifier: solid and anti-aliased accent pixels pass, at matching blend positions', () => {
  assert.equal(lib.classifyPixel(hex('#e49a78'), hex('#e6e8eb'), [PANEL_D], FAM.members), 'pass');
  const t = 0.6;
  assert.equal(lib.classifyPixel(mix(hex('#e49a78'), PANEL_D, t), mix(hex('#e6e8eb'), PANEL_D, t + 0.1), [PANEL_D], FAM.members), 'pass');
  // S5: positions further apart than T_AGREE (0.15) are not the same blend
  assert.equal(lib.classifyPixel(mix(hex('#e49a78'), PANEL_D, t), mix(hex('#e6e8eb'), PANEL_D, t + 0.25), [PANEL_D], FAM.members), 'unexpected');
  assert.equal(lib.classifyPixel(mix(hex('#a34425'), PANEL_L, 0.5), mix(hex('#24292f'), PANEL_L, 0.5), [PANEL_L], FAM.members), 'pass');
});

test('classifier: a label anti-aliased over a filled button passes as a member pair', () => {
  const old = mix(hex('#ffffff'), hex('#a34425'), 0.5);
  const head = mix(hex('#ffffff'), hex('#24292f'), 0.5);
  assert.equal(lib.classifyPixel(old, head, [hex('#a34425')], FAM.members), 'pass');
});

test('classifier: blend positions that disagree by more than T_AGREE are unexpected', () => {
  const old = mix(hex('#e49a78'), PANEL_D, 0.9);
  const head = mix(hex('#e6e8eb'), PANEL_D, 0.3);
  assert.equal(lib.classifyPixel(old, head, [PANEL_D], FAM.members), 'unexpected');
});

test('classifier: a neutral pixel that changed is unexpected, even when the result is grey', () => {
  // Grey body text moving (layout change): the old colour sits on no accent segment.
  assert.equal(lib.classifyPixel(hex('#b0b7c2'), hex('#e6e8eb'), [PANEL_D], FAM.members), 'unexpected');
  assert.equal(lib.classifyPixel(hex('#f0f1f3'), hex('#9aa3b0'), [PANEL_D], FAM.members), 'unexpected');
});

test('classifier: the neutral must be the same on both sides', () => {
  // Old accent over the panel, head accent over a different (coloured) neutral: no single N fits. A grey
  // neutral can't be told apart here, since Graphite is itself grey; that's accepted and covered by rule 1.
  const old = mix(hex('#e49a78'), PANEL_D, 0.5);
  const head = mix(hex('#e6e8eb'), hex('#e4b566'), 0.5);
  assert.equal(lib.classifyPixel(old, head, [PANEL_D], FAM.members), 'unexpected');
});

test('classifier: near-neutral blends are counted as unchanged or skipped, not passed', () => {
  assert.equal(lib.classifyPixel(mix(hex('#e49a78'), PANEL_D, 0.02), mix(hex('#e6e8eb'), PANEL_D, 0.03), [PANEL_D], FAM.members), 'unchanged');
  assert.equal(lib.classifyPixel(mix(hex('#e49a78'), PANEL_D, 0.02), mix(hex('#e6e8eb'), PANEL_D, 0.15), [PANEL_D], FAM.members), 'skipped');
  // skipped reaches t_new ≤ T_NONE + T_AGREE = 0.20, no further
  assert.equal(lib.classifyPixel(mix(hex('#e49a78'), PANEL_D, 0.02), mix(hex('#e6e8eb'), PANEL_D, 0.3), [PANEL_D], FAM.members), 'unexpected');
});

test('classifier: the soft tint is checked against its per-surface value', () => {
  const surface = hex('#292d34');
  const old = lib.parseColour('rgba(228, 154, 120, 0.14)');
  const neu = lib.parseColour('rgba(230, 232, 235, 0.14)');
  const o = old.slice(0, 3).map((v, i) => Math.round(v * 0.14 + surface[i] * 0.86));
  const n = neu.slice(0, 3).map((v, i) => Math.round(v * 0.14 + surface[i] * 0.86));
  assert.equal(lib.classifyPixel(o, n, [surface], FAM.members), 'pass');
});

function image(w, h, fill) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) { const c = fill(i % w, Math.floor(i / w)); data.set([...c, 255], i * 4); }
  return { width: w, height: h, data };
}

test('classifier: an image flip finds the local neutral and buckets unexpected pixels into tiles', () => {
  const oldImg = image(48, 48, (x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20 ? hex('#e49a78') : x >= 30 && y >= 30 && x < 34 && y < 34 ? hex('#b0b7c2') : PANEL_D));
  const newImg = image(48, 48, (x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20 ? hex('#e6e8eb') : x >= 30 && y >= 30 && x < 34 && y < 34 ? hex('#f0f1f3') : PANEL_D));
  const r = lib.classifyImage(oldImg, newImg, FAM);
  assert.equal(r.changed, 116);
  assert.equal(r.pass, 100);
  assert.equal(r.unexpected, 16);
  assert.deepEqual(r.tiles.map((t) => [t.x, t.y, t.count]), [[24, 24, 16]]);
});

test('classifier: named exceptions apply only to their baseline', () => {
  const config = { exceptions: [{ name: 'paused', baselines: ['a.png'], old: ['#e4b566'], new: ['#9aa3b0'] }] };
  assert.equal(lib.exceptionsFor('a.png', config).length, 1);
  assert.equal(lib.exceptionsFor('b.png', config).length, 0);
  const oldImg = image(4, 4, () => hex('#e4b566'));
  const newImg = image(4, 4, () => hex('#9aa3b0'));
  assert.equal(lib.classifyImage(oldImg, newImg, FAM, { exceptions: lib.exceptionsFor('a.png', config) }).exception, 16);
  assert.equal(lib.classifyImage(oldImg, newImg, FAM, { exceptions: lib.exceptionsFor('b.png', config) }).unexpected, 16);
});

test('classifier: the gate fails on characters, on more than 0.5 % unexpected and on more than 200 crops', () => {
  const row = (baseline, unexpected, tiles = 0, changed = unexpected) => ({ baseline, total: 10000, changed, unexpected, sizeChanged: false, tiles: Array(tiles).fill({}) });
  assert.deepEqual(lib.verdictOf([row('x/usage.spec.js/a.png', 50, 3)]).failures, []);
  assert.equal(lib.verdictOf([row('x/usage.spec.js/a.png', 51, 3)]).failures.length, 1);
  assert.equal(lib.verdictOf([row('test-visual/__screenshots__/characters.spec.js/a.png', 0, 0, 1)]).failures.length, 1);
  assert.equal(lib.verdictOf([row('x/a.png', 0, 120), row('x/b.png', 0, 81)]).failures.length, 1);
});

// ── R0b additions ────────────────────────────────────────────────────────────────────────────────────────────
test('classifier (a): a change of ΔE00 ≤ 1 is noise, counted on its own and never as a pass or unexpected', () => {
  // #202329 → #212429 is ΔE00 ≈ 0.4 (render rounding); #b0b7c2 → #f0f1f3 is a real grey change.
  assert.ok(lib.deltaE00(lib.lab(hex('#202329')), lib.lab(hex('#212429'))) <= lib.DE_NOISE);
  const oldImg = image(8, 8, (x, y) => (y < 4 ? PANEL_D : hex('#b0b7c2')));
  const newImg = image(8, 8, (x, y) => (y < 4 ? hex('#212429') : hex('#f0f1f3')));
  const r = lib.classifyImage(oldImg, newImg, FAM);
  assert.equal(r.changed, 64);
  assert.equal(r.noise, 32);
  assert.equal(r.pass, 0);
  assert.equal(r.unexpected, 32);
  // just over the line is not noise
  const a = hex('#808080'); const b = hex('#838383');
  assert.ok(lib.deltaE00(lib.lab(a), lib.lab(b)) > lib.DE_NOISE);
  assert.equal(lib.classifyImage(image(2, 2, () => a), image(2, 2, () => b), FAM).noise, 0);
});

test('classifier (b): an added or removed baseline fails the gate', () => {
  assert.deepEqual(lib.verdictOf([{ baseline: 'x/a.png', added: true, tiles: [] }]).failures, ['x/a.png: added (an accent flip adds and removes no baseline)']);
  assert.equal(lib.verdictOf([{ baseline: 'x/b.png', removed: true, tiles: [] }]).failures.length, 1);
  assert.equal(lib.verdictOf([{ baseline: 'x/c.png', total: 100, changed: 0, unexpected: 0, sizeChanged: false, tiles: [] }]).failures.length, 0);
});

test('classifier (c): the theme comes from the file name and picks that theme\'s surfaces and families', () => {
  assert.equal(lib.themeOf('test-visual/__screenshots__/home-compose.spec.js/routed-dark-darwin.png'), 'dark');
  assert.equal(lib.themeOf('x/settings-light-darwin.png'), 'light');
  assert.equal(lib.themeOf('x/light-dark.png'), 'both');
  assert.equal(lib.themeOf('x/widget-ask-long-command-darwin.png'), 'both');
  assert.equal(lib.themeOf('x/darkroom-darwin.png'), 'both');
  assert.equal(lib.familiesFor(ALL, 'x/a-dark-darwin.png', image(4, 4, () => hex('#202329'))), ALL.dark);
  assert.equal(lib.familiesFor(ALL, 'x/a-darwin.png'), ALL.none, 'no image: fail closed, never pooled');
  assert.deepEqual(ALL.light.surfaces.map((c) => c.join()), ['244,245,247', '255,255,255', '238,240,243']);
  assert.deepEqual(ALL.dark.surfaces.map((c) => c.join()), ['23,25,29', '32,35,41', '41,45,52']);
  // the old dark accent turning into the new dark accent passes in a dark baseline but is a theme mix-up in a light one
  const oldImg = image(4, 4, () => hex('#e49a78'));
  const newImg = image(4, 4, () => hex('#e6e8eb'));
  assert.equal(lib.classifyImage(oldImg, newImg, ALL.dark).pass, 16);
  assert.equal(lib.classifyImage(oldImg, newImg, ALL.light).unexpected, 16);
});

test('classifier (d): it runs when the branch\'s expected file starts with `# classify`', () => {
  assert.equal(lib.expectedFileFor('codex/redesign-r0b-2026-10-27'), 'test-visual/expected/codex-redesign-r0b-2026-10-27.txt');
  assert.equal(lib.wantsClassify('# classify\ntest-visual/__screenshots__/a.png\n'), true);
  assert.equal(lib.wantsClassify('# classify  \r\n'), true);
  assert.equal(lib.wantsClassify('test-visual/__screenshots__/a.png\n# classify\n'), false);
  assert.equal(lib.wantsClassify('# classify-not\n'), false);
  assert.equal(lib.wantsClassify(''), false);
  assert.equal(lib.wantsClassify(null), false);
  // this branch's own list asks for it
  const own = path.join(__dirname, '..', lib.expectedFileFor('codex/redesign-r0b-2026-10-27'));
  assert.equal(lib.wantsClassify(fs.readFileSync(own, 'utf8')), true);
});

// ── R0b extensions (lead conditions): surfaces as neutrals, text on the tint, parsed color-mixes ─────────────
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const SHEETS = execFileSync('git', ['ls-files', '*.css', '*.html'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
const MIXED = lib.familiesOf(TOKENS, GRAPHITE, { old: SHEETS, new: SHEETS });

test('classifier (iii): color-mix() rules that use an accent var are parsed from the stylesheets, not listed by hand', () => {
  const specs = lib.colourMixesOf(`a { color: color-mix(in oklab, var(--accent) 30%, var(--panel)); }
    b { background: color-mix(in srgb, 35% var(--accent), transparent); }
    c { border-color: color-mix(in srgb, var(--line) 60%, var(--text)); }
    d { color: color-mix(in oklab, var(--accent-hover), white 20%); }`);
  assert.deepEqual(specs.map((s) => [s.space, s.args.map((a) => [a.colour, a.pct])]), [
    ['oklab', [['var(--accent)', 30], ['var(--panel)', null]]],
    ['srgb', [['var(--accent)', 35], ['transparent', null]]],
    ['oklab', [['var(--accent-hover)', null], ['white', 20]]],
  ]);
  assert.ok(MIXED.mixes.parsed >= 15, `found ${MIXED.mixes.parsed} accent mixes in the repo`);
  assert.ok(MIXED.light.members.some((m) => m.key.startsWith('mix color-mix(in oklab')));
});

test('classifier (iii): computeMix follows CSS Color 5 (srgb, oklab, transparent, percentages)', () => {
  const theme = { '--accent': '#ff0000', '--b': '#0000ff' };
  const at = (raw) => lib.computeMix(lib.colourMixesOf(`x{c:${raw}}`)[0], theme);
  assert.deepEqual(at('color-mix(in srgb, var(--accent) 50%, var(--b))').map((v) => Math.round(v * 1000) / 1000), [127.5, 0, 127.5, 1]);
  // the oklab midpoint of red and blue is a lighter purple than the sRGB midpoint (128-ish, 0, 128-ish); the
  // value pins this implementation (Ottosson's matrices), so a change to the conversion shows up here
  const ok = at('color-mix(in oklab, var(--accent), var(--b))').map(Math.round);
  assert.deepEqual(ok.slice(0, 3), [140, 83, 162]);
  // with transparent, the colour keeps its own channels and takes the weight as alpha
  assert.deepEqual(at('color-mix(in srgb, var(--accent) 35%, transparent)').map((v) => Math.round(v * 100) / 100), [255, 0, 0, 0.35]);
  // percentages that sum under 100 scale alpha
  assert.equal(at('color-mix(in srgb, var(--accent) 20%, var(--b) 30%)')[3], 0.5);
  assert.equal(lib.computeMix({ space: 'oklch', args: [{ colour: 'var(--accent)', pct: 50 }, { colour: 'white', pct: null }] }, theme), null);
});

test('classifier (iii): a pixel drawn in an accent mix passes, mixed with the old and the new tokens', () => {
  const tokens = lib.tokensOf(GRAPHITE).dark; const oldTokens = lib.tokensOf(TOKENS).dark;
  const spec = lib.colourMixesOf('x{c:color-mix(in oklab, var(--accent) 30%, var(--panel))}')[0];
  const sheet = 'x{c:color-mix(in oklab, var(--accent) 30%, var(--panel))}';
  const fam = lib.familiesOf(TOKENS, GRAPHITE, { old: [sheet], new: [sheet] }).dark;
  const o = lib.computeMix(spec, oldTokens).slice(0, 3).map(Math.round); const n = lib.computeMix(spec, tokens).slice(0, 3).map(Math.round);
  const r = lib.explainPixel(o, n, [hex('#17191d'), ...fam.surfaces], fam.members);
  assert.equal(r.verdict, 'pass');
  assert.match(r.key, /^mix color-mix\(in oklab, var\(--accent\) 30%/);
});

test('classifier (i): the surfaces are tried as well as the nearest unchanged pixel', () => {
  // an accent blend over --panel-2 whose nearest unchanged pixel is a text pixel, not the background
  const P2 = hex('#292d34');
  const old = mix(hex('#e49a78'), P2, 0.3); const head = mix(hex('#e6e8eb'), P2, 0.3);
  const textPx = hex('#f0f1f3');
  assert.equal(lib.classifyPixel(old, head, [textPx], ALL.dark.members), 'unexpected');
  assert.equal(lib.classifyPixel(old, head, [textPx, ...ALL.dark.surfaces], ALL.dark.members), 'pass');
});

test('classifier (ii): text anti-aliased over the selected tint passes only at the same coverage', () => {
  const surface = hex('#202329');
  const tintOld = lib.parseColour('rgba(228, 154, 120, 0.14)'); const tintNew = lib.parseColour('rgba(230, 232, 235, 0.14)');
  const over = (c, b) => b.map((v, i) => Math.round(c[i] * c[3] + v * (1 - c[3])));
  const TO = over(tintOld, surface); const TN = over(tintNew, surface); const T = hex('#b0b7c2');
  const r = lib.explainPixel(mix(T, TO, 0.5), mix(T, TN, 0.5), ALL.dark.surfaces, ALL.dark.members);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.weak, true, 'text on the tint is weak evidence');
  assert.match(r.key, /^--(text|muted|faint)~soft\//);
  // the same text at different coverage is not the tint swap
  assert.notEqual(lib.explainPixel(mix(T, TO, 0.5), mix(T, TN, 0.62), ALL.dark.surfaces, ALL.dark.members).verdict, 'pass');
});

test('classifier: members that do not change are dropped, and the light halo is weak', () => {
  assert.ok(!ALL.dark.members.some((m) => m.key === 'halo'), 'dark halo (#17191d → #17191d) explains nothing');
  assert.ok(!ALL.light.members.some((m) => m.key === 'ink'), 'light ink (#fff → #fff) explains nothing');
  assert.equal(ALL.light.members.find((m) => m.key === 'halo').weak, true);
  assert.equal(ALL.light.members.find((m) => m.key === 'rest').weak, false);
});

test('classifier: an old pixel that is a neutral is never a pass, and near-N verdicts need strong evidence nearby', () => {
  const S = hex('#292d34'); const darker = hex('#1f232a');
  assert.notEqual(lib.explainPixel(S, darker, ALL.dark.surfaces, ALL.dark.members).verdict, 'pass');
  // a lone near-N change is unexpected; beside a strong accent pass it is accepted
  const lone = lib.classifyImage(image(20, 20, () => PANEL_D), image(20, 20, (x, y) => (x === 10 && y === 10 ? mix(hex('#e6e8eb'), PANEL_D, 0.15) : PANEL_D)), FAM);
  assert.equal(lone.unexpected, 1);
  const beside = lib.classifyImage(
    image(20, 20, (x, y) => (x < 8 ? hex('#e49a78') : PANEL_D)),
    image(20, 20, (x, y) => (x < 8 ? hex('#e6e8eb') : x === 9 && y === 10 ? mix(hex('#e6e8eb'), PANEL_D, 0.15) : PANEL_D)), FAM);
  assert.equal(beside.unexpected, 0);
  assert.equal(beside.skipped, 1);
  // S1: evidence counts within 2 px only; 3 px away the same pixel is unexpected
  const far = lib.classifyImage(
    image(20, 20, (x, y) => (x < 8 ? hex('#e49a78') : PANEL_D)),
    image(20, 20, (x, y) => (x < 8 ? hex('#e6e8eb') : x === 10 && y === 10 ? mix(hex('#e6e8eb'), PANEL_D, 0.15) : PANEL_D)), FAM);
  assert.equal(lib.EVIDENCE_RADIUS, 2);
  assert.equal(far.unexpected, 1);
});

test('classifier controls: every negative control fails the gate and every positive one passes, in both themes', () => {
  const { controls, judgeControl } = require('../test-visual/classify-controls');
  const all = controls();
  assert.ok(all.filter((c) => c.expect === 'fail').length >= 38);
  for (const c of all) {
    const { failed, result, crops } = judgeControl(c, MIXED);
    assert.equal(failed, c.expect === 'fail', `${c.name}: expected the gate to ${c.expect} (unexpected ${result.unexpected} of ${result.changed})`);
    if (c.crops) assert.ok(crops > 0, `${c.name}: must produce review crops`);
  }
});

test('classifier (iii): an unresolved color-mix fails closed: it builds no member, and its pixels stay unexpected', () => {
  // a file-local var the tokens can't resolve (like burst-theme's --border), and a space the classifier doesn't model
  const sheet = 'x{c:color-mix(in srgb, var(--accent) 45%, var(--local-only))} y{c:color-mix(in oklch, var(--accent) 45%, var(--panel))}';
  const fam = lib.familiesOf(TOKENS, GRAPHITE, { old: [sheet], new: [sheet] });
  assert.equal(fam.mixes.parsed, 2);
  assert.deepEqual(fam.mixes.unresolved.sort(), ['color-mix(in oklch, var(--accent) 45%, var(--panel))', 'color-mix(in srgb, var(--accent) 45%, var(--local-only))']);
  assert.ok(!fam.dark.members.some((m) => m.key.startsWith('mix ')), 'no member from an unresolved mix');
  // A fill drawn only in that mix, with --local-only a mid grey that appears nowhere else (so no neighbour or
  // surface supplies it as N): only the mix itself could explain the change, and unresolved it stays unexpected.
  // (Where the grey IS a neighbour, rest × local N explains the blend on its own, rightly: that is rule 1.)
  const g = hex('#6b6f78');
  const o = hex('#e49a78').map((v, i) => Math.round(v * 0.45 + g[i] * 0.55));
  const n = hex('#e6e8eb').map((v, i) => Math.round(v * 0.45 + g[i] * 0.55));
  const fill = (c) => image(12, 12, () => c);
  assert.equal(lib.classifyImage(fill(o), fill(n), fam.dark).unexpected, 144);
  // the same pixels pass once the var resolves to that grey: the mix member is what lets them through
  const known = sheet.replace('var(--local-only)', '#6b6f78');
  const resolved = lib.familiesOf(TOKENS, GRAPHITE, { old: [known], new: [known] });
  assert.equal(lib.classifyImage(fill(o), fill(n), resolved.dark).unexpected, 0);
});

test('classifier (c′): the theme comes from the unchanged pixels\' lightness; mixed or contradicted fails closed', () => {
  const L = hex('#eef0f3'); const D = hex('#292d34');
  const split = (shareLight) => image(20, 20, (x) => (x < 20 * shareLight ? L : D));
  const t = (name, img, head) => { const r = lib.themeFor(ALL, name, img, head); return [r.theme, r.source]; };
  assert.deepEqual(t('x/menu-darwin.png', split(0.9)), ['light', 'image']);
  assert.deepEqual(t('x/menu-darwin.png', split(0.2)), ['dark', 'image']);
  assert.deepEqual(t('x/menu-darwin.png', split(0.6)), ['none', 'ambiguous']);
  // native chrome that is no surface token still votes: a #c3c3c3 menu is light
  assert.deepEqual(t('x/menu-darwin.png', image(10, 10, () => [195, 195, 195])), ['light', 'image']);
  assert.deepEqual(t('x/menu-darwin.png', image(4, 4, () => [119, 119, 119])), ['none', 'ambiguous']);
  assert.deepEqual(t('x/menu-dark-darwin.png', split(0.2)), ['dark', 'name+image']);
  assert.deepEqual(t('x/menu-dark-darwin.png', split(0.9)), ['none', 'mismatch (name dark, image light)']);
  assert.deepEqual(t('x/menu-light-darwin.png', split(0.6)), ['none', 'ambiguous']);
  assert.deepEqual(t('x/menu-light-darwin.png'), ['none', 'no image']);
  // only unchanged pixels vote: a light page whose dark half changed is still light
  const head = image(20, 20, (x) => (x < 12 ? L : [60, 60, 60]));
  assert.deepEqual(t('x/menu-darwin.png', split(0.6), head), ['light', 'image']);
  assert.equal(lib.familiesFor(ALL, 'x/menu-darwin.png', split(0.6)), ALL.none);
  assert.equal(lib.THEME_DOMINANCE, 0.7);
  // fail closed: with `none`, an otherwise perfect accent swap is all unexpected
  const r = lib.classifyImage(image(4, 4, () => hex('#e49a78')), image(4, 4, () => hex('#e6e8eb')), ALL.none);
  assert.equal(r.unexpected, 16);
});

test('classifier M1: a pass whose old pixel already fits the new segment is weak, so a non-token grey shift fails', () => {
  // review attack 1: greys that aren't surface tokens, no accent anywhere
  const light = lib.explainPixel([215, 214, 213], [193, 192, 191], ALL.light.surfaces, MIXED.light.members);
  const dark = lib.explainPixel([33, 34, 36], [21, 22, 24], ALL.dark.surfaces, MIXED.dark.members);
  for (const r of [light, dark]) assert.ok(r.verdict !== 'pass' || r.weak, `strong ${r.key}`);
  const shift = (o, n, fam) => lib.classifyImage(image(30, 30, (x, y) => (x > 4 && x < 26 && y > 4 && y < 26 ? o : hex('#ffffff'))),
    image(30, 30, (x, y) => (x > 4 && x < 26 && y > 4 && y < 26 ? n : hex('#ffffff'))), fam);
  assert.equal(shift([215, 214, 213], [193, 192, 191], MIXED.light).unexpected, 441);
  // the real swap is still strong: terracotta is far from the Graphite segment
  const swap = lib.explainPixel(hex('#a34425'), hex('#24292f'), ALL.light.surfaces, MIXED.light.members);
  assert.equal(swap.verdict, 'pass');
  assert.equal(swap.weak, false);
});

test('classifier S3: a zero-length segment explains nothing', () => {
  assert.deepEqual(lib.onSegment([10, 20, 30], [5, 5, 5], [5, 5, 5]), { t: 0, de: Infinity });
  // dark ink's new value equals --bg: an old ink-brown pixel that vanished into the background is not an ink pass
  const bg = hex('#17191d');
  const r = lib.explainPixel(mix(hex('#251c18'), bg, 0.8), bg, [bg], ALL.dark.members);
  assert.ok(!(r.verdict === 'pass' && r.key === 'ink'), `explained as ${r.verdict} ${r.key}`);
});

test('classifier M2: a dense shift under ΔE 1 fails (noise tiles and the 0.25 % cap); sparse edge noise does not', () => {
  const bg = hex('#eef0f3'); const nudged = [237, 239, 242];
  assert.ok(lib.deltaE00(lib.lab(bg), lib.lab(nudged)) <= lib.DE_NOISE);
  // a 60×40 region nudged one step in a 96×72 image: every pixel is noise, densely
  const dense = lib.classifyImage(image(96, 72, () => bg), image(96, 72, (x, y) => (x >= 10 && x < 70 && y >= 10 && y < 50 ? nudged : bg)), ALL.light);
  assert.equal(dense.noise, 2400);
  assert.equal(dense.unexpected, 0);
  assert.ok(dense.noiseTiles > 0);
  assert.ok(dense.tiles.some((t) => t.kind === 'noise'), 'noise tiles are in the crops');
  const failures = lib.verdictOf([{ baseline: 'x/a-light-darwin.png', ...dense }]).failures;
  assert.ok(failures.some((f) => /noise \(cap 0.25 %\)/.test(f)) && failures.some((f) => /tile\(s\) at least 50 % noise/.test(f)), failures.join('; '));
  // sparse: one noisy pixel every 8th column on a single row, as anti-aliased edges are (12 px = 0.17 %)
  const sparse = lib.classifyImage(image(96, 72, () => bg), image(96, 72, (x, y) => (y === 30 && x % 8 === 0 ? nudged : bg)), ALL.light);
  assert.equal(sparse.noiseTiles, 0);
  assert.deepEqual(lib.verdictOf([{ baseline: 'x/a-light-darwin.png', ...sparse }]).failures, []);
  assert.equal(lib.CAPS.noiseRatio, 0.0025);
  assert.equal(lib.NOISE_TILE_SHARE, 0.5);
});

test('classifier mixes: base and head are never pooled, and the unmodelled cases are listed', () => {
  const both = 'a{c:color-mix(in oklab, var(--accent) 30%, var(--panel))}';
  const onlyHead = 'b{c:color-mix(in oklab, var(--accent) 12%, var(--bg))}';
  const fam = lib.familiesOf(TOKENS, GRAPHITE, { old: [both], new: [both, onlyHead] });
  assert.equal(fam.mixes.parsed, 1);
  assert.deepEqual(fam.mixes.onlyHead, ['color-mix(in oklab, var(--accent) 12%, var(--bg))']);
  assert.ok(!fam.dark.members.some((m) => m.key.includes('12%')), 'a head-only mix gets no made-up old colour');
  const sheet = `:root{--sel: var(--accent);}
    .f{c:color-mix(in srgb, var(--accent, #c00) 40%, white)}
    .a{c:color-mix(in srgb, var(--sel) 40%, white)}
    .n{c:color-mix(in srgb, color-mix(in srgb, var(--accent) 50%, white) 40%, black)}`;
  const js = "el.style.background = 'color-mix(in srgb, var(--accent) 20%, transparent)';";
  const listed = lib.familiesOf(TOKENS, GRAPHITE, { old: [sheet], new: [sheet], js: [js] }).mixes.skipped.map((x) => x.why).sort();
  assert.deepEqual(listed, ['alias', 'fallback', 'js', 'nested']);
});

test('classifier (iii): an unresolved color-mix fails closed in the light theme too', () => {
  const sheet = 'x{c:color-mix(in srgb, var(--accent) 45%, var(--local-only))}';
  const fam = lib.familiesOf(TOKENS, GRAPHITE, { old: [sheet], new: [sheet] });
  assert.deepEqual(fam.mixes.unresolved, ['color-mix(in srgb, var(--accent) 45%, var(--local-only))']);
  assert.ok(!fam.light.members.some((m) => m.key.startsWith('mix ')));
  const g = hex('#9aa0a8');
  const o = hex('#a34425').map((v, i) => Math.round(v * 0.45 + g[i] * 0.55));
  const n = hex('#24292f').map((v, i) => Math.round(v * 0.45 + g[i] * 0.55));
  const fill = (c) => image(12, 12, () => c);
  assert.equal(lib.classifyImage(fill(o), fill(n), fam.light).unexpected, 144);
  const known = sheet.replace('var(--local-only)', '#9aa0a8');
  assert.equal(lib.classifyImage(fill(o), fill(n), lib.familiesOf(TOKENS, GRAPHITE, { old: [known], new: [known] }).light).unexpected, 0);
});

test('classifier: the idle exception is the dark #726c62 → #7c766b pair only', () => {
  const config = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'test-visual', 'classify.config.json'), 'utf8'));
  const idle = config.exceptions.find((e) => e.name === 'idle');
  assert.deepEqual([idle.old, idle.new, idle.theme], [['#726c62'], ['#7c766b'], 'dark']);
  assert.ok(Array.isArray(idle.baselines), 'an explicit list, never a wildcard');
  assert.match(idle.reason, /R0b contrast fix, §R2\.2/);
  const listed = { exceptions: [{ ...idle, baselines: ['x/any-darwin.png'] }] };
  const dark = lib.exceptionsFor('x/any-darwin.png', listed, 'dark');
  assert.deepEqual(dark.map((e) => e.key), ['exception:idle']);
  assert.deepEqual(lib.exceptionsFor('x/other-darwin.png', listed, 'dark'), []);
  assert.deepEqual(lib.exceptionsFor('x/any-darwin.png', listed, 'light'), []);
  assert.deepEqual(lib.exceptionsFor('x/any-darwin.png', listed, 'none'), []);
  assert.deepEqual(lib.exceptionsFor('x/any-darwin.png', { exceptions: [{ ...idle, baselines: '*' }] }, 'dark'), [], 'a wildcard matches nothing');
  const fill = (c) => image(6, 6, () => c);
  const ok = lib.classifyImage(fill(hex('#726c62')), fill(hex('#7c766b')), ALL.dark, { exceptions: dark });
  assert.equal(ok.exception, 36);
  assert.equal(ok.unexpected, 0);
  // any other grey change stays unexpected
  const other = lib.classifyImage(fill(hex('#726c62')), fill(hex('#8a8478')), ALL.dark, { exceptions: dark });
  assert.equal(other.unexpected, 36);
  // listed baselines still work
  assert.equal(lib.exceptionsFor('a.png', { exceptions: [{ name: 'n', baselines: ['a.png'], old: ['#000'], new: ['#111'] }] }).length, 1);
  assert.equal(lib.exceptionsFor('b.png', { exceptions: [{ name: 'n', baselines: ['a.png'], old: ['#000'], new: ['#111'] }] }).length, 0);
});

test('classifier N2: an exception is strong only at its core; a grey moved along its direction fails', () => {
  const config = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'test-visual', 'classify.config.json'), 'utf8'));
  const idle = config.exceptions.find((e) => e.name === 'idle');
  const ex = lib.exceptionsFor('x/a-darwin.png', { exceptions: [{ ...idle, baselines: ['x/a-darwin.png'] }] }, 'dark');
  assert.equal(ex.length, 1);
  // labfix-review round 2: a 160×80 element on --panel, no accent and no Idle dot anywhere
  const P = hex('#202329');
  for (const [o, n] of [[[30, 30, 30], [39, 39, 39]], [[60, 58, 55], [67, 65, 62]], [[90, 86, 80], [99, 95, 89]]]) {
    const el = (x, y) => x >= 20 && x < 180 && y >= 20 && y < 100;
    const r = lib.classifyImage(image(200, 120, (x, y) => (el(x, y) ? o : P)), image(200, 120, (x, y) => (el(x, y) ? n : P)), ALL.dark, { exceptions: ex });
    assert.equal(r.exception, 0, `${o} → ${n}`);
    assert.equal(r.unexpected, 12800, `${o} → ${n}`);
  }
  // a blend on the idle segment two pixels from the core is accepted; a lone one is not
  const blend = mix(hex('#726c62'), P, 0.5); const blendN = mix(hex('#7c766b'), P, 0.5);
  const near = lib.classifyImage(image(10, 10, (x) => (x < 3 ? hex('#726c62') : x === 4 ? blend : P)), image(10, 10, (x) => (x < 3 ? hex('#7c766b') : x === 4 ? blendN : P)), ALL.dark, { exceptions: ex });
  assert.equal(near.unexpected, 0);
  const lone = lib.classifyImage(image(10, 10, (x) => (x === 6 ? blend : P)), image(10, 10, (x) => (x === 6 ? blendN : P)), ALL.dark, { exceptions: ex });
  assert.equal(lone.unexpected, lone.changed);
});

test('classifier: noise allowance is per named baseline only, with a reason', () => {
  const config = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'test-visual', 'classify.config.json'), 'utf8'));
  const routed = 'test-visual/__screenshots__/home-compose.spec.js/routed-light-darwin.png';
  const entry = config.noise.find((n) => n.baseline === routed);
  assert.ok(entry && /focus-halo/.test(entry.reason));
  assert.equal(lib.noiseCapFor(routed, config), 0.0075);
  assert.equal(lib.noiseCapFor('test-visual/__screenshots__/home-compose.spec.js/routed-dark-darwin.png', config), lib.CAPS.noiseRatio);
  const row = (baseline, noise) => ({ baseline, total: 10000, changed: noise, noise, unexpected: 0, sizeChanged: false, tiles: [], noiseTiles: 0 });
  assert.deepEqual(lib.verdictOf([row(routed, 70)], config).failures, []);
  assert.equal(lib.verdictOf([row(routed, 80)], config).failures.length, 1);
  assert.equal(lib.verdictOf([row('x/other.png', 30)], config).failures.length, 1);
  assert.deepEqual(lib.verdictOf([row('x/other.png', 25)], config).failures, []);
});

test('classifier: widget baselines take dark from index.html, which must still pin it', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const root = path.join(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'test-visual', 'classify.config.json'), 'utf8'));
  const [entry] = config.themes;
  assert.equal(entry.theme, 'dark');
  assert.equal(entry.source, 'index.html:2');
  // the cited source line: if index.html stops pinning dark, this mapping is stale and must be revisited
  assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8').split('\n')[1], /^<html\b[^>]*\bdata-theme="dark"/);
  // every listed baseline is shot from the index.html window
  for (const b of entry.baselines) {
    const spec = b.split('/')[2];
    const text = fs.readFileSync(path.join(root, 'test-visual', spec), 'utf8');
    assert.match(text, /windowByFile\([^,]+, 'index\.html'\)/, `${b}: its spec must shoot the index.html widget`);
    assert.ok(fs.existsSync(path.join(root, b)), b);
  }
  assert.ok(!entry.baselines.some((b) => /widget-compose-taken/.test(b)), 'widget-page.html is not index.html');
  // listed: dark without a vote; unlisted: the vote still decides and still fails closed
  const L = hex('#eef0f3'); const D = hex('#292d34');
  const mixed = image(20, 20, (x) => (x < 12 ? L : D));
  const listed = lib.themeFor(ALL, entry.baselines[0], mixed, mixed, config);
  assert.deepEqual([listed.theme, listed.source], ['dark', 'config (index.html:2)']);
  assert.equal(lib.themeFor(ALL, 'x/other-darwin.png', mixed, mixed, config).theme, 'none');
});

test('classifier: the pale-tint exceptions are exact pairs, scoped to their baselines', () => {
  const config = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'test-visual', 'classify.config.json'), 'utf8'));
  const tints = config.exceptions.filter((e) => e.name.startsWith('tint-'));
  assert.deepEqual(tints.map((e) => e.baselines.length), [1, 1, 1]);
  for (const e of tints) {
    assert.match(e.reason, /terracotta 0\.08 → Graphite 0\.14/);
    const ex = lib.exceptionsFor(e.baselines[0], config, 'light');
    assert.deepEqual(ex.map((x) => x.key).filter((k) => k === `exception:${e.name}`).length, e.pairs.length, 'pairs are not crossed');
    assert.deepEqual(lib.exceptionsFor(e.baselines[0], config, 'dark'), []);
  }
  const W = tints[0].baselines[0];
  const ex = lib.exceptionsFor(W, config, 'light');
  const fill = (c) => image(30, 30, () => hex(c));
  // the measured pair passes as its core; a near-white grey darkening the same amount does not
  assert.equal(lib.classifyImage(fill('#f7f1ef'), fill('#e0e1e2'), ALL.light, { exceptions: ex }).unexpected, 0);
  assert.equal(lib.classifyImage(fill('#f4f4f4'), fill('#dedfe0'), ALL.light, { exceptions: ex }).unexpected, 900);
  // crossed pairs (old of one, new of another) are not explained
  assert.equal(lib.classifyImage(fill('#f7f1ef'), fill('#d7d8db'), ALL.light, { exceptions: ex }).unexpected, 900);
  assert.equal(lib.exceptionsFor('x/elsewhere-darwin.png', config, 'light').length, 0);
});

test('classifier: exception guards — no old colour near a surface or text token; soft pairs recomputed from tokens', () => {
  const fs = require('node:fs'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
  const root = path.join(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'test-visual', 'classify.config.json'), 'utf8'));
  const head = lib.tokensOf(fs.readFileSync(path.join(root, 'tokens.css'), 'utf8'));
  const de = (a, b) => lib.deltaE00(lib.lab(lib.parseColour(a).slice(0, 3)), lib.lab(lib.parseColour(b).slice(0, 3)));
  const NEUTRAL = ['--bg', '--panel', '--panel-2', '--text', '--muted', '--faint'];
  for (const e of config.exceptions) {
    assert.ok(e.theme === 'light' || e.theme === 'dark', `${e.name}: needs a theme scope`);
    const pairs = e.pairs || (e.old || []).flatMap((o) => (e.new || []).map((n) => [o, n]));
    for (const [o] of pairs) for (const k of NEUTRAL) assert.ok(de(o, head[e.theme][k]) > 2, `${e.name}: old ${o} is within ΔE 2 of ${e.theme} ${k} (an exception must not explain a neutral)`);
  }
  // soft-tint pairs: old = base --accent-soft over `over`, new = head --accent-soft over `over` (ΔE ≤ 1)
  let base;
  try { base = lib.tokensOf(execFileSync('git', ['show', 'origin/main:tokens.css'], { cwd: root, encoding: 'utf8' })); }
  catch { base = lib.tokensOf(fs.readFileSync(path.join(__dirname, 'fixtures', 'tokens-terracotta-r0a.css'), 'utf8')); }
  const over = (soft, g) => { const s = lib.parseColour(soft); const G = lib.parseColour(g); return s.slice(0, 3).map((v, i) => v * s[3] + G[i] * (1 - s[3])); };
  const tints = config.exceptions.filter((e) => e.name.startsWith('tint-'));
  assert.equal(tints.length, 3);
  for (const e of tints) {
    assert.equal(e.theme, 'light');
    assert.equal(e.baselines.length, 1);
    for (const [o, n, g] of e.pairs) {
      assert.ok(g, `${e.name}: ${o} needs its measured surface`);
      const surface = ['--bg', '--panel', '--panel-2'].some((k) => de(g, head.light[k]) === 0);
      const [L, A, B] = lib.lab(lib.parseColour(g).slice(0, 3));
      assert.ok(surface || (L >= 95 && Math.hypot(A, B) <= 1), `${e.name}: ${g} is neither a light surface nor a neutral near-white`);
      const po = over(base.light['--accent-soft'], g); const pn = over(head.light['--accent-soft'], g);
      assert.ok(lib.deltaE00(lib.lab(po), lib.lab(lib.parseColour(o).slice(0, 3))) <= 1, `${e.name}: ${o} is not base soft over ${g}`);
      assert.ok(lib.deltaE00(lib.lab(pn), lib.lab(lib.parseColour(n).slice(0, 3))) <= 1, `${e.name}: ${n} is not head soft over ${g}`);
    }
  }
  assert.deepEqual(tints.map((e) => e.baselines[0].split('/').pop()).sort(), ['lights-template-minimal-darwin.png', 'lights-templates-menu-darwin.png', 'lights-window-darwin.png']);
});

test('classifier: the widget dark mapping — no app script writes data-theme; a contradicting image fails closed', () => {
  const fs = require('node:fs'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
  const root = path.join(__dirname, '..');
  const files = execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.html'], { cwd: root, encoding: 'utf8' }).split('\n')
    .filter((f) => f && !f.startsWith('test/') && !f.startsWith('test-visual/') && !f.includes('node_modules/'));
  const writers = files.filter((f) => /dataset\.theme\s*=|setAttribute\(\s*['"`]data-theme|removeAttribute\(\s*['"`]data-theme|\[['"`]data-theme['"`]\]\s*=/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  // the board's mock server is a separate web app; index.html never loads it
  assert.deepEqual(writers, ['board/tasks-api/mock-server.js'], 'a script now writes data-theme: the index.html → dark mapping may be stale');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'test-visual', 'classify.config.json'), 'utf8'));
  const b = config.themes[0].baselines[0];
  const light = image(20, 20, () => hex('#eef0f3'));
  assert.deepEqual([lib.themeFor(ALL, b, light, light, config).theme, lib.themeFor(ALL, b, light, light, config).source], ['none', 'mismatch (config dark, image light)']);
  const mixed = image(20, 20, (x) => (x < 12 ? hex('#eef0f3') : hex('#292d34')));
  assert.equal(lib.themeFor(ALL, b, mixed, mixed, config).theme, 'dark');
});
