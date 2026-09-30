// usage: electron render-page.js in.html out.png width height
// Renders an HTML file at width x height CSS px (1x) and saves it as a PNG.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const [,, input, output, w, h] = process.argv;
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: Number(w), height: Number(h), show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadFile(input);
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: Number(w), height: Number(h) });
  fs.writeFileSync(output, img.toPNG());
  app.quit();
});
