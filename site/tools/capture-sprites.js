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
const SCALE = 8; // px per rig unit
const W = 76 * SCALE;
const H = 98 * SCALE;

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
  for (const [name, [look, freeze]] of Object.entries(STATES)) {
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
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ width: W, height: H, unit: SCALE, canvas: { w: 76, h: 98 }, origin: { x: 6, y: 10 }, frame: { w: 64, h: 82 }, sprites: report }, null, 1));
  await app.close();
  console.log(JSON.stringify(report));
}
main().catch((e) => { console.error(e); process.exit(1); });
