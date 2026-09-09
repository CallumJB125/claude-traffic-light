#!/usr/bin/env node
// Rebuilds assets/icon.icns and the tray template PNGs from the SVG sources.
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
render(path.join(root, 'assets/trayTemplate.svg'), path.join(root, 'assets/trayTemplate.png'), 22);
render(path.join(root, 'assets/trayTemplate.svg'), path.join(root, 'assets/trayTemplate@2x.png'), 44);
fs.rmSync(out, { recursive: true, force: true });
console.log('icons rebuilt');
