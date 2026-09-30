// Captures the real rig's states as transparent WebP sprites for the site, so
// the page carries crisp pictures of the real character instead of mounting a
// ~1,000-node SVG per instance. Each state is rendered on black and on white;
// alpha and colour are recovered from the difference (exact for flat pixel art
// and for soft glows). Run: node site/tools/capture-sprites.js
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('@playwright/test');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'src', 'assets', 'sprites');
let SCALE = 8; // px per rig unit
let W = 76 * SCALE;
let H = 98 * SCALE;

const MIN = (status) => [{ name: 'claude', status }];
// name → [look, the moment to freeze animations at, ms]
const STATES = {
  'rig-off': [{ lamp: 'off', pose: 'none', eyes: 'default' }, 300],
  'rig-working': [{ lamp: 'green', pose: 'think', eyes: 'default', minions: MIN('working') }, 500],
  'rig-approve': [{ lamp: 'red', pose: 'banner', eyes: 'surprised', text: 'APPROVE?' }, 700],
  'rig-ready': [{ lamp: 'amber', pose: 'thumbs', eyes: 'happy', minions: MIN('done') }, 400],
  'rig-agents': [{ lamp: 'green', pose: 'think', eyes: 'default', minions: [{ name: 'claude', status: 'working' }, { name: 'codex', status: 'working' }, { name: 'cursor', status: 'waiting' }, { name: 'gemini', status: 'done' }] }, 500],
};
for (const body of ['claude', 'dog', 'cat', 'frog', 'robot', 'ghost']) {
  STATES[`char-${body}`] = [{ lamp: 'green', pose: 'none', eyes: 'default', body }, 300];
  STATES[`char-${body}-hit`] = [{ lamp: 'green', pose: 'cheer', eyes: 'star', body }, 250];
}

// Animated sheets: a strip of frames, one per column.
//   [look, frames, loopMs (or span for a one-shot), scale, { celebrate, blinkAt }]
const SHEETS = {
  'sheet-off': [{ lamp: 'off', pose: 'none', eyes: 'default' }, 16, 1600, 6, { blinkAt: 11 }],
  'sheet-working': [{ lamp: 'green', pose: 'think', eyes: 'default', minions: MIN('working') }, 16, 1600, 6, { blinkAt: 11 }],
  'sheet-approve': [{ lamp: 'red', pose: 'banner', eyes: 'surprised', text: 'APPROVE?' }, 16, 1600, 6, {}],
  'sheet-ready': [{ lamp: 'amber', pose: 'thumbs', eyes: 'happy', minions: MIN('done') }, 16, 1600, 6, {}],
  'sheet-agents': [{ lamp: 'green', pose: 'think', eyes: 'default', minions: [{ name: 'claude', status: 'working' }, { name: 'codex', status: 'working' }, { name: 'cursor', status: 'waiting' }, { name: 'gemini', status: 'done' }] }, 16, 1600, 6, { blinkAt: 11 }],
  'sheet-celebrate': [{ lamp: 'amber', pose: 'thumbs', eyes: 'happy', minions: MIN('done') }, 20, 1400, 6, { celebrate: true }],
};
for (const body of ['claude', 'dog', 'cat', 'frog', 'robot', 'ghost']) {
  SHEETS[`sheet-${body}`] = [{ lamp: 'green', pose: 'none', eyes: 'default', body }, 8, 1600, 4, { blinkAt: 5 }];
  SHEETS[`sheet-${body}-hit`] = [{ lamp: 'green', pose: 'cheer', eyes: 'star', body }, 8, 800, 4, {}];
}
const ONLY = process.argv[2] && process.argv[2] !== 'sheets-only' ? process.argv[2] : null; // optional: only names starting with this

async function captureSheets(page, app, tmp) {
  const report = {};
  for (const [name, [look, frames, span, scale, opt]] of Object.entries(SHEETS)) {
    if (ONLY && !name.startsWith(ONLY)) continue;
    SCALE = scale; W = 76 * SCALE; H = 98 * SCALE;
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [W, H]);
    await page.evaluate((s) => { document.getElementById('frame').style.setProperty('--s', `${s}px`); }, SCALE);
    await page.evaluate(([l, ms, c]) => window.prepLoop(l, ms, c), [look, span, !!opt.celebrate]);
    const files = [];
    for (let k = 0; k < frames; k += 1) {
      const t = opt.celebrate ? (k / (frames - 1)) * span : (k / frames) * span;
      await page.evaluate(([tt, b]) => window.pinFrame(tt, b), [t, opt.blinkAt === k]);
      const shot = async (bg) => { await page.evaluate((c) => window.setBg(c), bg); await page.waitForTimeout(25); const f = path.join(tmp, `${name}-${k}-${bg.slice(1)}.png`); await page.locator('#frame').screenshot({ path: f }); return f; };
      files.push([await shot('#000000'), await shot('#ffffff')]);
    }
    const strip = path.join(tmp, `${name}.png`);
    execFileSync('python3', ['-c', `
import sys, json, numpy as np
from PIL import Image
pairs = json.loads(sys.argv[1])
cols = []
for bf, wf in pairs:
    b = np.asarray(Image.open(bf).convert('RGB'), dtype=np.float64)
    w = np.asarray(Image.open(wf).convert('RGB'), dtype=np.float64)
    a = np.clip(1.0 - (w - b).mean(axis=2) / 255.0, 0, 1)
    with np.errstate(divide='ignore', invalid='ignore'):
        c = np.where(a[..., None] > 1e-3, b / a[..., None], 0)
    cols.append(np.dstack([np.clip(c, 0, 255), a * 255]).astype(np.uint8))
Image.fromarray(np.concatenate(cols, axis=1), 'RGBA').save(sys.argv[2])
`, JSON.stringify(files), strip]);
    const webp = path.join(OUT, `${name}.webp`);
    execFileSync('cwebp', ['-quiet', '-lossless', '-z', '9', '-exact', strip, '-o', webp]);
    report[name] = { frames, ms: span, w: W, h: H, bytes: fs.statSync(webp).size, oneShot: !!opt.celebrate };
  }
  return report;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const app = await electron.launch({ args: [path.join(ROOT, 'test-visual', 'matrix', 'main.js')] });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [W, H]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`file://${path.join(__dirname, 'sprites.html')}`);
  await page.setViewportSize({ width: W, height: H }).catch(() => {});
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sprites-'));
  const report = {};
  if (process.argv[2] !== 'sheets-only') for (const [name, [look, freeze]] of Object.entries(STATES)) {
    if (ONLY && !name.startsWith(ONLY)) continue;
    await page.evaluate(([l, f]) => window.showLook(l, f), [look, freeze]);
    const shot = async (bg) => { await page.evaluate((c) => window.setBg(c), bg); await page.waitForTimeout(60); const f = path.join(tmp, `${name}-${bg.slice(1)}.png`); await page.locator('#frame').screenshot({ path: f }); return f; };
    const black = await shot('#000000');
    const white = await shot('#ffffff');
    const png = path.join(tmp, `${name}.png`);
    execFileSync('python3', ['-c', `
import sys, numpy as np
from PIL import Image
b = np.asarray(Image.open(sys.argv[1]).convert('RGB'), dtype=np.float64)
w = np.asarray(Image.open(sys.argv[2]).convert('RGB'), dtype=np.float64)
a = 1.0 - (w - b).mean(axis=2) / 255.0
a = np.clip(a, 0, 1)
with np.errstate(divide='ignore', invalid='ignore'):
    c = np.where(a[..., None] > 1e-3, b / a[..., None], 0)
rgba = np.dstack([np.clip(c, 0, 255), a * 255]).astype(np.uint8)
Image.fromarray(rgba, 'RGBA').save(sys.argv[3])
`, black, white, png]);
    const webp = path.join(OUT, `${name}.webp`);
    execFileSync('cwebp', ['-quiet', '-lossless', '-z', '9', '-exact', png, '-o', webp]);
    report[name] = fs.statSync(webp).size;
  }
  const sheets = await captureSheets(page, app, tmp);
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ canvas: { w: 76, h: 98 }, origin: { x: 6, y: 10 }, frame: { w: 64, h: 82 }, sprites: report, sheets }, null, 1));
  await app.close();
  console.log(JSON.stringify(sheets));
}
main().catch((e) => { console.error(e); process.exit(1); });
