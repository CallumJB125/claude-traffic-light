// Automatic updates where an unsigned app can install them itself: Windows
// (the NSIS install) and Linux AppImage. macOS stays notify-and-download
// (src/update-check.js): Gatekeeper will not let an unsigned app swap itself.
// A .deb updates through apt or a new download, so it is notify-only too.
//
// It reports through UpdateCheck (builder-2's notify layer) so there is one
// poller, one tray item and one health status: 'available' → 'downloading'
// → 'ready' ("Restart to update to X.Y"). It never restarts on its own; an
// update the person does not restart for installs when they next quit.
//
// The feed is app-update.yml, which electron-builder writes from the publish
// URL in electron-builder.config.js (brand.js). Downgrades are allowed so a
// release can be rolled back by promoting the previous version.
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 30 * 1000;

// Whether this install can update itself.
function supported({ platform = process.platform, env = process.env, packaged }) {
  if (!packaged) return false;
  if (platform === 'win32') return true;
  if (platform === 'linux') return !!env.APPIMAGE;
  return false;
}

/**
 * deps: { app, updateCheck?, updater? (electron-updater's autoUpdater; injected in tests),
 *         platform?, env?, setTimer?, log? }
 * Returns { check, stop } or null when this install cannot update itself.
 */
function start({ app, updateCheck = null, updater = null, platform = process.platform, env = process.env, setTimer = setTimeout, setRepeat = setInterval, log = console }) {
  if (!supported({ platform, env, packaged: app.isPackaged })) return null;
  const au = updater || require('electron-updater').autoUpdater;
  au.autoDownload = true;
  au.autoInstallOnAppQuit = true;
  au.allowDowngrade = true;
  au.logger = null;

  const report = (status) => { try { updateCheck?.report(status); } catch (err) { log.warn?.('[update] report failed:', err.message); } };
  updateCheck?.useExternalSource?.();
  updateCheck?.onRestart?.(() => au.quitAndInstall(false, true));

  au.on('checking-for-update', () => {});
  au.on('update-not-available', () => report({ state: 'current', version: app.getVersion() }));
  au.on('update-available', (info) => report({ state: 'downloading', version: info?.version, progress: 0 }));
  au.on('download-progress', (p) => report({ state: 'downloading', progress: Math.round(p?.percent || 0) }));
  au.on('update-downloaded', (info) => report({ state: 'ready', version: info?.version }));
  au.on('error', (err) => report({ state: 'error', detail: String(err?.message || err).slice(0, 200) }));

  let busy = false;
  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      await au.checkForUpdates(); // privacy-flow: auto-update
    } catch (err) {
      report({ state: 'error', detail: String(err?.message || err).slice(0, 200) });
    } finally {
      busy = false;
    }
  };
  const first = setTimer(check, FIRST_CHECK_MS);
  const every = setRepeat(check, CHECK_EVERY_MS);
  first?.unref?.();
  every?.unref?.();
  return { check, stop: () => { clearTimeout(first); clearInterval(every); } };
}

module.exports = { start, supported, CHECK_EVERY_MS };
