// Windows (NSIS) and Linux AppImage: electron-updater installs, but only what
// the signed manifest names. It never downloads on its own
// (autoDownload=false): prepare() points it at the manifest's folder, lets it
// read latest*.yml, and compares every file in its update-available info with
// the manifest (name, sha512, size, version) BEFORE downloadUpdate(). It then
// checks the download against that same sha512. Downgrades are allowed only
// for the one check that the service marked as a signed rollback or a revert.
const { UpdateError, checkUpdateInfo } = require('./verify.js');

function create({ updater = null, platform = process.platform, log = console } = {}) {
  const au = updater || require('electron-updater').autoUpdater; // privacy-flow: auto-update
  au.autoDownload = false;
  // A verified download the person didn't restart for installs when they quit.
  au.autoInstallOnAppQuit = true;
  au.allowDowngrade = false;
  au.logger = null;
  // Failures reach the service through the promises; an unheard 'error' event would throw.
  au.on('error', (err) => log.warn?.('[updater] update feed:', err?.message || err));

  let verified = null;

  async function prepare({ manifest, manifestUrl, rollback }) {
    verified = null;
    au.setFeedURL({ provider: 'generic', url: new URL('.', manifestUrl).href });
    au.allowDowngrade = !!rollback;
    let announced = null;
    const onAvailable = (info) => { announced = info; };
    au.on('update-available', onAvailable);
    let result;
    try {
      result = await au.checkForUpdates(); // privacy-flow: auto-update
    } catch (err) {
      throw new UpdateError('offline', `Could not read the update feed (${err?.message || err}).`);
    } finally {
      au.removeListener('update-available', onAvailable);
    }
    const infos = [announced, result?.updateInfo].filter(Boolean);
    if (!infos.length) throw new UpdateError('server', 'The update feed did not answer.');
    for (const info of infos) checkUpdateInfo(info, manifest);
    if (result && result.isUpdateAvailable === false) throw new UpdateError('server', `The update feed does not offer ${manifest.version} to this version.`);
    verified = manifest.version;
  }

  async function download({ manifest, onProgress }) {
    if (verified !== manifest.version) throw new UpdateError('verify', 'This update was not checked against the signed release.');
    const onProgressEvent = (p) => onProgress?.({ transferred: p?.transferred || 0, total: p?.total || 0 });
    au.on('download-progress', onProgressEvent);
    try {
      await au.downloadUpdate(); // privacy-flow: auto-update
    } catch (err) {
      if (/sha512|checksum/i.test(String(err?.message))) throw new UpdateError('verify', 'The download does not match the signed release.');
      if (err?.code === 'ENOSPC') throw new UpdateError('disk-full', 'Not enough disk space for the update.');
      throw new UpdateError('offline', `The download failed (${err?.message || err}).`);
    } finally {
      au.removeListener('download-progress', onProgressEvent);
    }
  }

  function install() {
    au.quitAndInstall(false, true);
  }

  return { kind: 'restart', fileKind: platform === 'win32' ? 'nsis' : 'appimage', canFetchRevert: true, prepare, download, install };
}

module.exports = { create };
