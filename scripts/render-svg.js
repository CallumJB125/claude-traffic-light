// usage: electron render-svg.js in.svg out.png size
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const [,, input, output, sizeArg] = process.argv;
const size = Number(sizeArg);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const svg = fs.readFileSync(input, 'utf8');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}" width="${size}" height="${size}" style="display:block"></body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  fs.writeFileSync(output, img.toPNG());
  app.quit();
});
