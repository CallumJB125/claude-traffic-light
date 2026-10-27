// Redesign snapshot classifier (plan-redesign §R2.6, §R3.10, §R4.4). Not a snapshot test: it checks that every
// changed baseline PNG changed only by the accent swap. The rules are in classify-lib.js.
//
// Runs on its own when the branch's test-visual/expected/<branch>.txt starts with `# classify` (an accent-flip
// PR, R0b); CLASSIFY=1 or CLASSIFY_BASE forces it on any branch, CLASSIFY=0 turns it off. Inputs (all optional):
//   CLASSIFY_BRANCH    the branch whose expected file is read (default: the checked-out branch)
//   CLASSIFY_BASE      git ref holding the old baselines and old tokens.css (default: merge-base with origin/main)
//   CLASSIFY_HEAD_DIR  a directory laid out like __screenshots__ holding the new PNGs (default: the working tree;
//                      only PNGs that differ from the base are read)
//   CLASSIFY_TOKENS    the head tokens.css (default: the working tree's)
//   CLASSIFY_ONLY      comma-separated spec dirs to limit the run (e.g. widget.spec.js,usage.spec.js)
// With no changed PNGs (R0a's own gate) it passes at once. Output: classify-report.json and one contact sheet
// per baseline with unexpected pixels (old | new | diff crops), attached to the test and written to its output dir.
// Each row counts noise (ΔE00 ≤ 1, the pre-filter), pass, unchanged, skipped, exception and unexpected separately.
const { test, expect, _electron: electron } = require('@playwright/test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lib = require('./classify-lib');
const { controls, judgeControl } = require('./classify-controls');

const ROOT = path.join(__dirname, '..');
const SHOTS = 'test-visual/__screenshots__';
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });

function baseRef() {
  return lib.resolveBase(process.env.CLASSIFY_BASE, () => git('merge-base', 'HEAD', 'origin/main').toString());
}

function asksForClassifier() {
  if (process.env.CLASSIFY === '0') return false;
  if (process.env.CLASSIFY || process.env.CLASSIFY_BASE) return true;
  let branch = process.env.CLASSIFY_BRANCH;
  if (!branch) { try { branch = git('rev-parse', '--abbrev-ref', 'HEAD').toString().trim(); } catch { return false; } }
  const file = path.join(ROOT, lib.expectedFileFor(branch));
  return fs.existsSync(file) && lib.wantsClassify(fs.readFileSync(file, 'utf8'));
}

function changedBaselines(base) {
  const only = (process.env.CLASSIFY_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const keep = (p) => p.endsWith('.png') && (!only.length || only.some((o) => p.startsWith(`${SHOTS}/${o}/`)));
  const headDir = process.env.CLASSIFY_HEAD_DIR;
  if (headDir) {
    const out = [];
    for (const spec of fs.readdirSync(headDir)) {
      const dir = path.join(headDir, spec);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        const rel = `${SHOTS}/${spec}/${f}`;
        if (keep(rel)) out.push({ rel, headFile: path.join(dir, f) });
      }
    }
    return out;
  }
  const names = git('diff', '--name-only', base, '--', SHOTS).toString().split('\n').filter(keep);
  return names.map((rel) => ({ rel, headFile: path.join(ROOT, rel) }));
}

// The app's stylesheets (CSS and HTML) at a ref, or in the working tree: the color-mix() rules come from here.
const SHEET = (f) => (f.endsWith('.css') || f.endsWith('.html')) && !f.startsWith('site/') && !f.includes('node_modules/');
function sheetsAt(ref) {
  const names = git('ls-tree', '-r', '--name-only', ref).toString().split('\n').filter(SHEET);
  return names.map((f) => git('show', `${ref}:${f}`).toString());
}
function sheetsInTree() {
  return git('ls-files', '*.css', '*.html').toString().split('\n').filter(SHEET).map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
}

// App scripts (not tests, not vendored): accent color-mixes set from JS are listed as skipped, never modelled.
function scriptsInTree() {
  return git('ls-files', '*.js', '*.mjs').toString().split('\n')
    .filter((f) => f && !f.startsWith('test') && !f.includes('node_modules/') && !f.startsWith('site/') && !f.startsWith('scripts/'))
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
}

function oldBytes(base, rel) {
  try { return git('show', `${base}:${rel}`); } catch { return null; }
}

async function decode(page, bytes) {
  return page.evaluate(async (b64) => {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    // The baselines are Display P3 PNGs (macOS screenshots carry an iCCP profile), so the bytes on disk aren't
    // the CSS hexes: #a34425 is stored as #974a2e. Decoding through the embedded profile into an sRGB canvas puts
    // pixels back in the space tokens.css is written in; untagged PNGs are already sRGB.
    const bmp = await createImageBitmap(new Blob([raw], { type: 'image/png' }), { colorSpaceConversion: 'default', premultiplyAlpha: 'none' });
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let s = '';
    for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    return { width: bmp.width, height: bmp.height, b64: btoa(s) };
  }, bytes.toString('base64')).then((r) => ({ width: r.width, height: r.height, data: Buffer.from(r.b64, 'base64') }));
}

// Draws old | new | diff for each crop (scaled ×3), at most 40 crops per sheet.
async function contactSheet(page, oldPng, newPng, tiles) {
  return page.evaluate(async ({ a, b, tiles: ts }) => {
    const load = async (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }), { colorSpaceConversion: 'default' });
    const [A, B] = await Promise.all([load(a), load(b)]);
    const S = 3; const cell = 24 * S; const gap = 6;
    const rows = ts.slice(0, 40);
    const canvas = new OffscreenCanvas(cell * 3 + gap * 4, rows.length * (cell + gap) + gap);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scratch = new OffscreenCanvas(24, 24).getContext('2d', { willReadFrequently: true });
    rows.forEach((t, r) => {
      const y = gap + r * (cell + gap);
      ctx.drawImage(A, t.x, t.y, t.w, t.h, gap, y, t.w * S, t.h * S);
      ctx.drawImage(B, t.x, t.y, t.w, t.h, gap * 2 + cell, y, t.w * S, t.h * S);
      scratch.clearRect(0, 0, 24, 24);
      scratch.drawImage(A, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
      const pa = scratch.getImageData(0, 0, t.w, t.h);
      scratch.drawImage(B, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
      const pb = scratch.getImageData(0, 0, t.w, t.h);
      for (let i = 0; i < pa.data.length; i += 4) {
        const d = Math.abs(pa.data[i] - pb.data[i]) + Math.abs(pa.data[i + 1] - pb.data[i + 1]) + Math.abs(pa.data[i + 2] - pb.data[i + 2]);
        pb.data[i] = d ? 255 : 0; pb.data[i + 1] = d ? 0 : 0; pb.data[i + 2] = d ? 255 : 0; pb.data[i + 3] = 255;
      }
      scratch.putImageData(pb, 0, 0);
      ctx.drawImage(scratch.canvas, 0, 0, t.w, t.h, gap * 3 + cell * 2, y, t.w * S, t.h * S);
    });
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, { a: oldPng.toString('base64'), b: newPng.toString('base64'), tiles }).then((b64) => Buffer.from(b64, 'base64'));
}

test('classifier: every changed baseline changed only by the accent swap', async ({}, testInfo) => {
  // Only an accent-flip PR (R0b) asks every changed PNG to be an accent swap; it says so with `# classify` on the
  // first line of its expected list. Other PRs re-baseline on purpose and are checked by that list instead.
  test.skip(!asksForClassifier(), 'the branch\'s expected list does not start with `# classify` (or set CLASSIFY=1)');
  test.setTimeout(30 * 60 * 1000);
  const base = baseRef();
  const work = changedBaselines(base);
  const report = { base, baselines: [], mixes: null };
  if (!work.length) {
    await testInfo.attach('classify-report.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    return;
  }
  const oldCss = git('show', `${base}:tokens.css`).toString();
  const newCss = fs.readFileSync(process.env.CLASSIFY_TOKENS || path.join(ROOT, 'tokens.css'), 'utf8');
  const families = lib.familiesOf(oldCss, newCss, { old: sheetsAt(base), new: sheetsInTree(), js: scriptsInTree() });
  report.mixes = families.mixes;
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'classify.config.json'), 'utf8'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-ud-'));
  const browser = await electron.launch({ args: [path.join(__dirname, 'classify-main.js'), '-ApplePersistenceIgnoreState', 'YES', `--user-data-dir=${userData}`] });
  try {
    const page = await browser.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    for (const { rel, headFile } of work) {
      const oldPng = oldBytes(base, rel);
      const newPng = fs.existsSync(headFile) ? fs.readFileSync(headFile) : null;
      if (!oldPng || !newPng) { report.baselines.push({ baseline: rel, added: !oldPng, removed: !newPng, tiles: [] }); continue; }
      if (oldPng.equals(newPng)) continue;
      const oldImg = await decode(page, oldPng); const newImg = await decode(page, newPng);
      const th = lib.themeFor(families, rel, oldImg, newImg, config);
      // Δα ≤ 2 on edges only in the windows that are transparent by construction (the config's widget list)
      const r = lib.classifyImage(oldImg, newImg, th.families, { exceptions: lib.exceptionsFor(rel, config, th.theme), alphaEdge: !!lib.themeFromConfig(rel, config) });
      const row = { baseline: rel, theme: th.theme, themeSource: th.source, themeShare: th.share, ...r, unexpectedPct: +(100 * r.unexpected / r.total).toFixed(4) };
      report.baselines.push(row);
      if (r.tiles.length) {
        const sheet = await contactSheet(page, oldPng, newPng, r.tiles);
        const name = `${rel.split('/').slice(-2).join('__').replace(/\.png$/, '')}-review.png`;
        fs.writeFileSync(testInfo.outputPath(name), sheet);
        await testInfo.attach(name, { body: sheet, contentType: 'image/png' });
      }
    }
  } finally {
    await browser.close();
  }
  const verdict = lib.verdictOf(report.baselines, config);
  report.crops = verdict.crops;
  const sum = (k) => report.baselines.reduce((n, b) => n + (b[k] || 0), 0);
  report.totals = Object.fromEntries(['changed', 'noise', 'pass', 'unchanged', 'skipped', 'exception', 'unexpected'].map((k) => [k, sum(k)]));
  report.failures = verdict.failures;
  const body = JSON.stringify(report, (k, v) => (k === 'tiles' ? v.length : v), 2);
  fs.writeFileSync(testInfo.outputPath('classify-report.json'), body);
  await testInfo.attach('classify-report.json', { body, contentType: 'application/json' });
  for (const b of report.baselines) {
    if (b.added || b.removed) console.log(`classify ${b.baseline}: ${b.added ? 'added' : 'removed'}`);
    else console.log(`classify ${b.baseline} [${b.theme} by ${b.themeSource}, ${b.themeShare}]: changed ${b.changed}, noise ${b.noise} (dense tiles ${b.noiseTiles}, max tile ${b.maxNoiseTileShare}), pass ${b.pass}, unchanged ${b.unchanged}, skipped ${b.skipped}, exception ${b.exception}, unexpected ${b.unexpected} (${b.unexpectedPct} %)`);
  }
  console.log(`classify totals: ${JSON.stringify(report.totals)}, crops ${report.crops}`);
  const mx = report.mixes;
  console.log(`classify mixes: ${mx.parsed} modelled (base ${mx.base}, head ${mx.head}); only base ${mx.onlyBase.length}, only head ${mx.onlyHead.length}; unresolved ${mx.unresolved.length}: ${mx.unresolved.join(' | ')}`);
  console.log(`classify mixes skipped (not modelled, fail closed): ${mx.skipped.length ? mx.skipped.map((x) => `${x.why}: ${x.raw}`).join(' | ') : 'none'}`);
  expect(verdict.failures, 'classifier failures').toEqual([]);
});

// Integration: the controls as real PNGs, encoded here and decoded in Electron exactly like the baselines, then
// classified and gated. Every negative control must fail the gate and every positive one pass. Always runs.
test('classifier controls: synthetic PNG pairs through the real decode and gate', async ({}, testInfo) => {
  const { PNG } = require('playwright-core/lib/utilsBundle');
  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'tokens-terracotta-r0a.css'), 'utf8');
  const sheets = sheetsInTree();
  const families = lib.familiesOf(fixture, fs.readFileSync(path.join(ROOT, 'tokens.css'), 'utf8'), { old: sheets, new: sheets });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-ud-'));
  const browser = await electron.launch({ args: [path.join(__dirname, 'classify-main.js'), `--user-data-dir=${userData}`] });
  const rows = [];
  try {
    const page = await browser.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const png = (img) => { const p = new PNG({ width: img.width, height: img.height }); img.data.copy(p.data); return PNG.sync.write(p); };
    for (const c of controls()) {
      const decoded = { ...c, old: await decode(page, png(c.old)), new: await decode(page, png(c.new)) };
      const { failed, result, crops } = judgeControl(decoded, families);
      rows.push({ name: c.name, expect: c.expect, gate: failed ? 'fail' : 'pass', changed: result.changed, unexpected: result.unexpected, crops, wantCrops: !!c.crops });
    }
  } finally {
    await browser.close();
  }
  await testInfo.attach('classify-controls.json', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' });
  expect(rows.filter((r) => r.gate !== r.expect), 'controls whose gate result is wrong').toEqual([]);
  expect(rows.filter((r) => r.wantCrops && !r.crops), 'controls that must produce crops').toEqual([]);
  expect(rows.filter((r) => r.expect === 'fail').length).toBeGreaterThanOrEqual(38);
});
