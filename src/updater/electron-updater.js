// Windows (NSIS) and Linux AppImage: electron-updater installs, but only what
// the signed manifest names. It never downloads or installs on its own
// (autoDownload and autoInstallOnAppQuit are off): prepare() points it at the
// manifest's folder, lets it read the feed file, and compares every file in
// its update-available info with the manifest (name, sha512, size, version,
// same server, no web-installer packages) BEFORE downloadUpdate(). It then
// checks the download against that same sha512. Downgrades are allowed only
// for the one check that the service marked as a signed rollback or a revert.
//
// electron-builder names the feed file after the version's prerelease tag
// (app-builder-lib AppInfo.channel): 1.2.0 → latest.yml, 1.2.0-beta.3 →
// beta.yml (plus -linux on Linux). The feed's channel is set from the signed
// version, never from the running one, so the file read is the one that
// release wrote.
const { UpdateError, checkUpdateInfo, parseVersion } = require('./verify.js');

// The feed file's channel for a version, as electron-builder picks it: its
// first prerelease identifier, else null ("latest").
function feedChannel(version) {
  const pre = parseVersion(version)?.pre || [];
  return pre.length ? pre[0] : null;
}

function create({
  updater = null, CancellationToken = null, platform = process.platform, log = console,
  checkTimeoutMs = 30000, stallMs = 120000, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const lib = updater ? null : require('electron-updater'); // privacy-flow: auto-update
  const au = updater || lib.autoUpdater; // privacy-flow: auto-update
  const Token = CancellationToken || lib?.CancellationToken;
  au.autoDownload = false;
  au.autoInstallOnAppQuit = false;
  au.allowDowngrade = false;
  // A web installer fetches packages the signed manifest doesn't cover.
  au.disableWebInstaller = true;
  au.logger = null;
  // Failures reach the service through the promises; an unheard 'error' event would throw.
  au.on('error', (err) => log.warn?.('[updater] update feed:', err?.message || err));

  let verified = null;

  async function prepare({ manifest, manifestUrl, rollback }) {
    verified = null;
    const base = new URL('.', manifestUrl).href;
    const channel = feedChannel(manifest.version);
    au.setFeedURL({ provider: 'generic', url: base, ...(channel ? { channel } : {}) });
    // After the feed: electron-updater turns allowDowngrade on whenever a channel is set.
    au.allowDowngrade = !!rollback;
    let announced = null;
    const onAvailable = (info) => { announced = info; };
    au.on('update-available', onAvailable);
    let result;
    let timer;
    try {
      result = await Promise.race([
        au.checkForUpdates(), // privacy-flow: auto-update
        new Promise((_, reject) => { timer = setTimer(() => reject(new UpdateError('offline', `The update feed did not answer within ${Math.round(checkTimeoutMs / 1000)} s.`)), checkTimeoutMs); }),
      ]);
    } catch (err) {
      if (err instanceof UpdateError) throw err;
      throw new UpdateError('offline', `Could not read the update feed (${err?.message || err}).`);
    } finally {
      clearTimer(timer);
      au.removeListener('update-available', onAvailable);
    }
    const infos = [announced, result?.updateInfo].filter(Boolean);
    if (!infos.length) throw new UpdateError('server', 'The update feed did not answer.');
    for (const info of infos) checkUpdateInfo(info, manifest, { base });
    if (result && result.isUpdateAvailable === false) throw new UpdateError('server', `The update feed does not offer ${manifest.version} to this version.`);
    verified = manifest.version;
  }

  async function download({ manifest, onProgress }) {
    if (verified !== manifest.version) throw new UpdateError('verify', 'This update was not checked against the signed release.');
    const token = Token ? new Token() : undefined;
    let stalled = false;
    let timer = null;
    const arm = () => {
      clearTimer(timer);
      timer = setTimer(() => { stalled = true; token?.cancel(); }, stallMs);
    };
    const onProgressEvent = (p) => { arm(); onProgress?.({ transferred: p?.transferred || 0, total: p?.total || 0 }); };
    au.on('download-progress', onProgressEvent);
    arm();
    try {
      await au.downloadUpdate(token); // privacy-flow: auto-update
    } catch (err) {
      if (stalled) throw new UpdateError('offline', `The download stalled (nothing for ${Math.round(stallMs / 1000)} s).`);
      if (/sha512|checksum/i.test(String(err?.message))) throw new UpdateError('verify', 'The download does not match the signed release.');
      if (err?.code === 'ENOSPC') throw new UpdateError('disk-full', 'Not enough disk space for the update.');
      throw new UpdateError('offline', `The download failed (${err?.message || err}).`);
    } finally {
      clearTimer(timer);
      au.removeListener('download-progress', onProgressEvent);
    }
  }

  // Silent (NSIS /S: this installer is not one-click, and the person already
  // chose to install), and start the new version afterwards.
  function install() {
    au.quitAndInstall(true, true);
  }

  return { kind: 'restart', fileKind: platform === 'win32' ? 'nsis' : 'appimage', canFetchRevert: true, prepare, download, install };
}

module.exports = { create, feedChannel };
