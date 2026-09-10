// Electron main script for test/cameos.test.js: draws a 400×300 test image,
// saves it through Cameos.addPhoto (the path the Lights "Save" takes) and
// prints what came out. Usage: electron cameo-cut.js <dir> <oval|rounded>
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');
const Cameos = require('../../cameos');

if (app.dock) app.dock.hide();
app.whenReady().then(() => {
  const [dir, shape] = process.argv.slice(-2);
  const w = 400;
  const h = 300;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = (y * w + x) * 4;
    buf[i] = x % 256; buf[i + 1] = y % 256; buf[i + 2] = 200; buf[i + 3] = 255;
  }
  const source = nativeImage.createFromBitmap(buf, { width: w, height: h }).toDataURL();
  const res = Cameos.addPhoto({ dir, nativeImage, source, rect: { x: 110, y: 60, size: 180 }, shape, name: 'Test Face', eyes: { x: 0.5, y: 0.42 }, mouth: { x: 0.5, y: 0.7 } });
  const file = path.join(dir, `${res.id}.png`);
  const out = nativeImage.createFromPath(file);
  const { width, height } = out.getSize();
  const bmp = out.toBitmap();
  const alpha = (x, y) => bmp[(y * width + x) * 4 + 3];
  console.log(`RESULT ${JSON.stringify({
    res, width, height,
    signature: fs.readFileSync(file).subarray(0, 8).toString('hex'),
    corners: [alpha(0, 0), alpha(width - 1, 0), alpha(0, height - 1), alpha(width - 1, height - 1)],
    centre: alpha(128, 128),
    midLeft: alpha(3, 128),
    index: JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')),
  })}`);
  app.exit(0);
});
