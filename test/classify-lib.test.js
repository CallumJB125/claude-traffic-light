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
  assert.equal(lib.classifyPixel(mix(hex('#e49a78'), PANEL_D, t), mix(hex('#e6e8eb'), PANEL_D, t + 0.2), [PANEL_D], FAM.members), 'pass');
  assert.equal(lib.classifyPixel(mix(hex('#a34425'), PANEL_L, 0.5), mix(hex('#24292f'), PANEL_L, 0.5), [PANEL_L], FAM.members), 'pass');
});

test('classifier: a label anti-aliased over a filled button passes as a member pair', () => {
  const old = mix(hex('#ffffff'), hex('#a34425'), 0.5);
  const head = mix(hex('#ffffff'), hex('#24292f'), 0.5);
  assert.equal(lib.classifyPixel(old, head, [hex('#a34425')], FAM.members), 'pass');
});

test('classifier: blend positions that disagree by more than 0.35 are unexpected', () => {
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
  assert.equal(lib.classifyPixel(mix(hex('#e49a78'), PANEL_D, 0.02), mix(hex('#e6e8eb'), PANEL_D, 0.25), [PANEL_D], FAM.members), 'skipped');
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
  assert.equal(lib.familiesFor(ALL, 'x/a-dark-darwin.png'), ALL.dark);
  assert.equal(lib.familiesFor(ALL, 'x/a-darwin.png'), ALL.none, 'no theme and no image: fail closed, never pooled');
  assert.deepEqual(ALL.light.surfaces.map((c) => c.join()), ['244,245,247', '255,255,255', '238,240,243']);
  assert.deepEqual(ALL.dark.surfaces.map((c) => c.join()), ['23,25,29', '32,35,41', '41,45,52']);
  // the old dark accent turning into the new dark accent passes in a dark baseline but is a theme mix-up in a light one
  const oldImg = image(4, 4, () => hex('#e49a78'));
  const newImg = image(4, 4, () => hex('#e6e8eb'));
  assert.equal(lib.classifyImage(oldImg, newImg, lib.familiesFor(ALL, 'x/a-dark-darwin.png')).pass, 16);
  assert.equal(lib.classifyImage(oldImg, newImg, lib.familiesFor(ALL, 'x/a-light-darwin.png')).unexpected, 16);
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
  const fam = lib.familiesOf(TOKENS, GRAPHITE, { old: ['x{c:color-mix(in oklab, var(--accent) 30%, var(--panel))}'], new: [] }).dark;
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
  const lone = lib.classifyImage(image(20, 20, () => PANEL_D), image(20, 20, (x, y) => (x === 10 && y === 10 ? mix(hex('#e6e8eb'), PANEL_D, 0.2) : PANEL_D)), FAM);
  assert.equal(lone.unexpected, 1);
  const beside = lib.classifyImage(
    image(20, 20, (x, y) => (x < 8 ? hex('#e49a78') : PANEL_D)),
    image(20, 20, (x, y) => (x < 8 ? hex('#e6e8eb') : x === 10 && y === 10 ? mix(hex('#e6e8eb'), PANEL_D, 0.2) : PANEL_D)), FAM);
  assert.equal(beside.unexpected, 0);
  assert.equal(beside.skipped, 1);
});

test('classifier controls: every negative control fails the gate and every positive one passes, in both themes', () => {
  const { controls, judgeControl } = require('../test-visual/classify-controls');
  const all = controls();
  assert.ok(all.filter((c) => c.expect === 'fail').length >= 16);
  for (const c of all) {
    const { failed, result } = judgeControl(c, MIXED);
    assert.equal(failed, c.expect === 'fail', `${c.name}: expected the gate to ${c.expect} (unexpected ${result.unexpected} of ${result.changed})`);
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

test('classifier (c′): an unthemed baseline takes its theme from the base image; ambiguous or contradicted fails closed', () => {
  const L = hex('#eef0f3'); const D = hex('#292d34');
  const split = (shareLight) => image(20, 20, (x) => (x < 20 * shareLight ? L : D));
  const t = (name, img) => { const r = lib.themeFor(ALL, name, img); return [r.theme, r.source]; };
  assert.deepEqual(t('x/menu-darwin.png', split(0.9)), ['light', 'image']);
  assert.deepEqual(t('x/menu-darwin.png', split(0.2)), ['dark', 'image']);
  assert.deepEqual(t('x/menu-darwin.png', split(0.6)), ['none', 'ambiguous']);
  assert.deepEqual(t('x/menu-darwin.png', image(4, 4, () => hex('#ff00ff'))), ['none', 'ambiguous']);
  assert.deepEqual(t('x/menu-dark-darwin.png', split(0.2)), ['dark', 'name']);
  assert.deepEqual(t('x/menu-dark-darwin.png', split(0.9)), ['none', 'mismatch (name dark, image light)']);
  assert.equal(lib.familiesFor(ALL, 'x/menu-darwin.png', split(0.6)), ALL.none);
  assert.equal(lib.THEME_DOMINANCE, 0.7);
  // fail closed: with `none`, an otherwise perfect accent swap is all unexpected
  const r = lib.classifyImage(image(4, 4, () => hex('#e49a78')), image(4, 4, () => hex('#e6e8eb')), ALL.none);
  assert.equal(r.unexpected, 16);
});
