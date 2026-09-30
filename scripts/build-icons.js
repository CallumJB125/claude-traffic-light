#!/usr/bin/env node
// Rebuilds assets/icon.icns, the Linux build/icons/ set, and the tray template PNGs from the SVG sources.
// Renders through Electron (Chromium) so gradients, clip paths and filters
// come out right; ImageMagick's SVG renderer drops them.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const electron = require('electron');
const out = path.join(root, 'build-icons.iconset');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
const render = (svg, png, size) => {
  execFileSync(electron, [path.join(__dirname, 'render-svg.js'), svg, png, String(size)], { stdio: 'ignore' });
  // capturePage returns device pixels; normalise to the requested size.
  execFileSync('magick', [png, '-resize', `${size}x${size}!`, png]);
};
for (const s of [16, 32, 128, 256, 512]) {
  render(path.join(root, 'assets/icon.svg'), path.join(out, `icon_${s}x${s}.png`), s);
  render(path.join(root, 'assets/icon.svg'), path.join(out, `icon_${s}x${s}@2x.png`), s * 2);
}
execFileSync('iconutil', ['-c', 'icns', out, '-o', path.join(root, 'assets/icon.icns')]);
// Linux: a folder of NxN.png (electron-builder.config.js linux.icon).
const linux = path.join(root, 'build/icons');
fs.mkdirSync(linux, { recursive: true });
for (const s of [16, 32, 128, 256, 512]) fs.copyFileSync(path.join(out, `icon_${s}x${s}.png`), path.join(linux, `${s}x${s}.png`));
fs.copyFileSync(path.join(out, 'icon_32x32@2x.png'), path.join(linux, '64x64.png'));
fs.copyFileSync(path.join(out, 'icon_512x512@2x.png'), path.join(linux, '1024x1024.png'));
for (const s of [24, 48]) render(path.join(root, 'assets/icon.svg'), path.join(linux, `${s}x${s}.png`), s);
render(path.join(root, 'assets/trayTemplate.svg'), path.join(root, 'assets/trayTemplate.png'), 22);
render(path.join(root, 'assets/trayTemplate.svg'), path.join(root, 'assets/trayTemplate@2x.png'), 44);
fs.rmSync(out, { recursive: true, force: true });
console.log('icons rebuilt');
