// Regenerates the site's brand files from tools/brand/icon.svg (a copy of the app's
// master, assets/brand/icon.svg in the icon branch): favicon.svg, favicon-32.png,
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
const master = fs.readFileSync(path.join(here, 'brand', 'icon.svg'), 'utf8');
const square = path.join(here, 'brand', 'icon-square.svg');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-brand-'));

// the favicon is the plate only: no shadow, no margin
const flat = master
  .replace(/<g filter="url\(#shadow\)">(<rect[^>]*\/>)<\/g>/, '$1')
  .replace(/<rect x="100"[^>]*fill="url\(#sheen\)"\/>\s*<rect x="101"[^>]*\/>/, '')
  .replace('viewBox="0 0 1024 1024" width="1024" height="1024"', 'viewBox="100 100 824 824" width="824" height="824"');
fs.writeFileSync(path.join(assets, 'favicon.svg'), flat);

const browser = await chromium.launch({ channel: 'chrome' });
const png = async (svgFile, size, out) => {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0;background:transparent"><img src="file://${svgFile}" width="${size}" height="${size}" style="display:block"></body>`);
  await page.waitForTimeout(150);
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
*{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#0f0e12;color:#f6f4f0;font-family:SG,system-ui,sans-serif}
.glow{position:absolute;right:-180px;top:-200px;width:900px;height:900px;border-radius:50%;background:radial-gradient(closest-side,rgba(127,155,209,.3),transparent 70%)}
.icon{position:absolute;right:96px;top:150px;width:330px;height:330px;filter:drop-shadow(0 30px 40px rgba(0,0,0,.5))}
h1{position:absolute;left:84px;top:150px;margin:0;font-size:92px;line-height:1;letter-spacing:-.035em;font-weight:800;width:640px}
.brand{position:absolute;left:84px;top:64px;font-size:34px;font-weight:700;letter-spacing:-.01em}
.foot{position:absolute;left:84px;bottom:64px;font-size:26px;color:#a9a4b0}
</style><div class="glow"></div><div class="brand">Plexiform</div><h1>Know which coding agent needs you.</h1><img class="icon" src="file://${path.join(assets, 'favicon.svg')}"><div class="foot">Private beta · plexiform.dev</div>`;
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
