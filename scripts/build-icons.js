#!/usr/bin/env node
// Rebuilds every icon from the masters in assets/brand/ (icon.svg, icon-square.svg,
// tray-template.svg, mark.svg): the macOS .icns, the Windows .ico, the Linux PNG set,
// the tray icons, the DMG window art and the installer art. Renders through Electron
// (Chromium) so gradients, clip paths and filters come out right; ImageMagick's SVG
// renderer drops them.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..');
const electron = require('electron');
const brand = (f) => path.join(root, 'assets/brand', f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-icons-'));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'ignore' });

// capturePage returns device pixels; normalise to the requested size.
const svgToPng = (svg, png, size) => {
  run(electron, [path.join(__dirname, 'render-svg.js'), svg, png, String(size)]);
  run('magick', [png, '-resize', `${size}x${size}!`, png]);
};
const pageToPng = (html, png, w, h, scale = 1) => {
  run(electron, [path.join(__dirname, 'render-page.js'), html, png, String(w), String(h)]);
  // capturePage returns device pixels (2x on a Retina screen): always normalise
  run('magick', [png, '-resize', `${w * scale}x${h * scale}!`, png]);
};
const out = (...p) => { const f = path.join(root, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); return f; };

// macOS app icon (16–512 @1x and @2x)
const iconset = path.join(tmp, 'icon.iconset');
fs.mkdirSync(iconset);
for (const s of [16, 32, 128, 256, 512]) {
  svgToPng(brand('icon.svg'), path.join(iconset, `icon_${s}x${s}.png`), s);
  svgToPng(brand('icon.svg'), path.join(iconset, `icon_${s}x${s}@2x.png`), s * 2);
}
run('iconutil', ['-c', 'icns', iconset, '-o', out('assets/icon.icns')]);

// Linux PNG set (electron-builder reads build/icons/<size>x<size>.png) and the Windows .ico
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const pngs = {};
for (const s of sizes) { pngs[s] = out('build/icons', `${s}x${s}.png`); svgToPng(brand('icon.svg'), pngs[s], s); }
run('magick', [...[16, 24, 32, 48, 64, 128, 256].map((s) => pngs[s]), out('assets/icon.ico')]);

// trays: macOS template images (black + alpha), and colour icons for Windows and Linux
for (const [name, size] of [['trayTemplate', 22], ['tray16Template', 16], ['tray18Template', 18]]) {
  svgToPng(brand('tray-template.svg'), out('assets', `${name}.png`), size);
  svgToPng(brand('tray-template.svg'), out('assets', `${name}@2x.png`), size * 2);
}
fs.copyFileSync(brand('tray-template.svg'), out('assets/trayTemplate.svg'));
svgToPng(brand('icon.svg'), out('assets/tray-win.png'), 32);
svgToPng(brand('icon.svg'), out('assets/tray-win-16.png'), 16);
svgToPng(brand('icon.svg'), out('assets/tray-linux.png'), 24);

// in-window logo
svgToPng(brand('icon.svg'), out('assets/logo.png'), 256);
svgToPng(brand('icon.svg'), out('assets/logo@2x.png'), 512);

// DMG window (540x380, and @2x) and the Windows installer art
const page = (name, w, h, body) => { const f = path.join(tmp, `${name}.html`); fs.writeFileSync(f, `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;font-family:-apple-system,'SF Pro Display','Helvetica Neue',sans-serif;background:#0f0e12;color:#eceee9}</style>${body}`); return f; };
const field = (w, h) => `<svg width="${w}" height="${h}" style="position:absolute;inset:0" viewBox="0 0 ${w} ${h}"><g stroke="#7f9bd1" stroke-opacity=".16" stroke-width="1" fill="none"><path d="M0 ${h * .72} L${w * .22} ${h * .55} L${w * .4} ${h * .8} L${w * .63} ${h * .5} L${w * .85} ${h * .7} L${w} ${h * .46}"/><path d="M${w * .22} ${h * .55} L${w * .3} ${h * .3} L${w * .63} ${h * .5}"/><path d="M${w * .4} ${h * .8} L${w * .55} ${h * .96}"/><path d="M${w * .85} ${h * .7} L${w * .92} ${h * .94}"/></g><g fill="#a3b8e0" fill-opacity=".5"><circle cx="${w * .22}" cy="${h * .55}" r="2.5"/><circle cx="${w * .3}" cy="${h * .3}" r="2"/><circle cx="${w * .4}" cy="${h * .8}" r="2.5"/><circle cx="${w * .63}" cy="${h * .5}" r="3"/><circle cx="${w * .85}" cy="${h * .7}" r="2.5"/></g></svg>`;
const dmg = page('dmg', 540, 380, `${field(540, 380)}<div style="position:absolute;left:0;right:0;top:34px;text-align:center;font-size:22px;font-weight:700;letter-spacing:-.01em">Plexiform</div><div style="position:absolute;left:0;right:0;top:66px;text-align:center;font-size:13px;color:#a9a4b0">Drag Plexiform to Applications</div><svg width="540" height="380" style="position:absolute;inset:0"><path d="M222 190 H318" stroke="#eceee9" stroke-opacity=".75" stroke-width="3" stroke-linecap="round" fill="none"/><path d="M306 177 L321 190 L306 203" stroke="#eceee9" stroke-opacity=".75" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`);
pageToPng(dmg, out('build/dmg-background.png'), 540, 380);
pageToPng(dmg, out('build/dmg-background@2x.png'), 540, 380, 2);
const side = page('side', 164, 314, `${field(164, 314)}<img src="file://${brand('icon.svg')}" width="120" style="position:absolute;left:22px;top:40px"><div style="position:absolute;left:0;right:0;top:170px;text-align:center;font-size:20px;font-weight:700">Plexiform</div><div style="position:absolute;left:0;right:0;top:200px;text-align:center;font-size:11px;color:#a9a4b0">Know which coding agent<br>needs you</div>`);
pageToPng(side, path.join(tmp, 'sidebar.png'), 164, 314);
run('magick', [path.join(tmp, 'sidebar.png'), '-background', '#0f0e12', '-alpha', 'remove', `BMP3:${out('build/installerSidebar.bmp')}`]);
const head = page('head', 150, 57, `<img src="file://${brand('icon.svg')}" width="46" style="position:absolute;right:8px;top:5px">`);
pageToPng(head, path.join(tmp, 'header.png'), 150, 57);
run('magick', [path.join(tmp, 'header.png'), '-background', '#0f0e12', '-alpha', 'remove', `BMP3:${out('build/installerHeader.bmp')}`]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('icons rebuilt');
