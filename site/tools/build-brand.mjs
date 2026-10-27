// Regenerates the site's brand files from the app's assets/brand/ masters:
// favicon.svg, favicon-32.png,
// favicon.ico, apple-touch-icon.png and the OG image. Needs Chrome and ImageMagick.
//   node site/tools/build-brand.mjs
import { chromium } from '../../node_modules/@playwright/test/index.mjs';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, '..', 'src', 'assets');
const source = path.resolve(here, '..', '..', 'assets', 'brand');
for (const name of ['icon.svg', 'icon-square.svg']) fs.copyFileSync(path.join(source, name), path.join(here, 'brand', name));
const master = fs.readFileSync(path.join(source, 'icon.svg'), 'utf8');
const square = path.join(here, 'brand', 'icon-square.svg');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-brand-'));

// The favicon fills its canvas; keep app-icon padding only on desktop assets.
const flat = master
  .replace('viewBox="0 0 1024 1024" width="1024" height="1024"', 'viewBox="96 96 832 832" width="832" height="832"');
fs.writeFileSync(path.join(assets, 'favicon.svg'), flat);

const browser = await chromium.launch({ channel: 'chrome' });
const png = async (svgFile, size, out) => {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const svg = Buffer.from(fs.readFileSync(svgFile)).toString('base64');
  await page.setContent(`<body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${svg}" width="${size}" height="${size}" style="display:block"></body>`);
  await page.locator('img').evaluate((img) => img.decode());
  await page.screenshot({ path: out, omitBackground: true });
  await page.close();
};
await png(path.join(assets, 'favicon.svg'), 32, path.join(assets, 'favicon-32.png'));
await png(path.join(assets, 'favicon.svg'), 16, path.join(tmp, 'f16.png'));
await png(path.join(assets, 'favicon.svg'), 48, path.join(tmp, 'f48.png'));
execFileSync('magick', [path.join(tmp, 'f16.png'), path.join(assets, 'favicon-32.png'), path.join(tmp, 'f48.png'), path.join(assets, 'favicon.ico')]);
await png(square, 180, path.join(assets, 'apple-touch-icon.png'));

// OG image, 1200x630
const font = `file://${path.join(assets, 'fonts', 'schibsted-grotesk.woff2')}`;
const og = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:SG;src:url('${font}');font-weight:400 900}
*{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#17191d;color:#f4f5f7;font-family:SG,system-ui,sans-serif}
.glow{position:absolute;right:-180px;top:-200px;width:900px;height:900px;border-radius:50%;background:radial-gradient(closest-side,rgba(228,154,120,.16),transparent 70%)}
.icon{position:absolute;right:96px;top:150px;width:330px;height:330px;filter:drop-shadow(0 30px 40px rgba(0,0,0,.5))}
h1{position:absolute;left:84px;top:177px;margin:0;font-size:78px;line-height:1.06;letter-spacing:-.035em;font-weight:700;width:640px}
.brand{position:absolute;left:84px;top:64px;font-size:34px;font-weight:700;letter-spacing:-.01em}
.foot{position:absolute;left:84px;bottom:64px;font-size:26px;color:#a7abb3}
</style><div class="glow"></div><div class="brand">Plexiform</div><h1>Your team.<br>Your AIs.<br>Working together.</h1><img class="icon" src="file://${path.join(assets, 'favicon.svg')}"><div class="foot">plexiform.dev</div>`;
const ogFile = path.join(tmp, 'og.html');
fs.writeFileSync(ogFile, og);
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(`file://${ogFile}`);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(assets, 'og.png') });
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('brand files rebuilt');
