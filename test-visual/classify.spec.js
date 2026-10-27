// Redesign snapshot classifier (plan-redesign §R2.6, §R3.10, §R4.4). Not a snapshot test: it checks that every
// changed baseline PNG changed only by the accent swap. The rules are in classify-lib.js.
//
// Run with CLASSIFY=1. Inputs (all optional):
//   CLASSIFY_BASE      git ref holding the old baselines and old tokens.css (default: merge-base with origin/main)
//   CLASSIFY_HEAD_DIR  a directory laid out like __screenshots__ holding the new PNGs (default: the working tree;
//                      only PNGs that differ from the base are read)
//   CLASSIFY_TOKENS    the head tokens.css (default: the working tree's)
//   CLASSIFY_ONLY      comma-separated spec dirs to limit the run (e.g. widget.spec.js,usage.spec.js)
// With no changed PNGs (R0a's own gate) it passes at once. Output: classify-report.json and one contact sheet
// per baseline with unexpected pixels (old | new | diff crops), attached to the test and written to its output dir.
const { test, expect, _electron: electron } = require('@playwright/test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lib = require('./classify-lib');

const ROOT = path.join(__dirname, '..');
const SHOTS = 'test-visual/__screenshots__';
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });

function baseRef() {
  if (process.env.CLASSIFY_BASE) return process.env.CLASSIFY_BASE;
  try { return git('merge-base', 'HEAD', 'origin/main').toString().trim(); } catch { return 'HEAD'; }
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
  // Opt-in: only an accent-flip PR (R0b) asks every changed PNG to be an accent swap. Other PRs re-baseline on
  // purpose and are checked by their test-visual/expected/<branch>.txt list instead.
  test.skip(!process.env.CLASSIFY && !process.env.CLASSIFY_BASE, 'set CLASSIFY=1 (or CLASSIFY_BASE) to run the accent classifier');
  test.setTimeout(30 * 60 * 1000);
  const base = baseRef();
  const work = changedBaselines(base);
  const report = { base, baselines: [] };
  if (!work.length) {
    await testInfo.attach('classify-report.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    return;
  }
  const oldCss = git('show', `${base}:tokens.css`).toString();
  const newCss = fs.readFileSync(process.env.CLASSIFY_TOKENS || path.join(ROOT, 'tokens.css'), 'utf8');
  const families = lib.familiesOf(oldCss, newCss);
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'classify.config.json'), 'utf8'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-ud-'));
  const browser = await electron.launch({ args: [path.join(__dirname, 'classify-main.js'), `--user-data-dir=${userData}`] });
  try {
    const page = await browser.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    for (const { rel, headFile } of work) {
      const oldPng = oldBytes(base, rel);
      const newPng = fs.existsSync(headFile) ? fs.readFileSync(headFile) : null;
      if (!oldPng || !newPng) { report.baselines.push({ baseline: rel, added: !oldPng, removed: !newPng, tiles: [] }); continue; }
      if (oldPng.equals(newPng)) continue;
      const r = lib.classifyImage(await decode(page, oldPng), await decode(page, newPng), families, { exceptions: lib.exceptionsFor(rel, config) });
      const row = { baseline: rel, ...r, unexpectedPct: +(100 * r.unexpected / r.total).toFixed(4) };
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
  const verdict = lib.verdictOf(report.baselines);
  report.crops = verdict.crops;
  report.failures = verdict.failures;
  const body = JSON.stringify(report, (k, v) => (k === 'tiles' ? v.length : v), 2);
  fs.writeFileSync(testInfo.outputPath('classify-report.json'), body);
  await testInfo.attach('classify-report.json', { body, contentType: 'application/json' });
  for (const b of report.baselines) {
    if (b.added || b.removed) console.log(`classify ${b.baseline}: ${b.added ? 'added' : 'removed'}`);
    else console.log(`classify ${b.baseline}: changed ${b.changed}, pass ${b.pass}, unchanged ${b.unchanged}, skipped ${b.skipped}, exception ${b.exception}, unexpected ${b.unexpected} (${b.unexpectedPct} %)`);
  }
  expect(verdict.failures, 'classifier failures').toEqual([]);
});
