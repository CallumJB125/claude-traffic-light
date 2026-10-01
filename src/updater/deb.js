// Linux .deb: an app cannot replace a package itself, so it downloads the
// new .deb, verifies it against the signed release, and only then puts it in
// ~/Downloads; "install" checks it once more (Downloads is writable by
// anything running as you) and opens it in the software installer
// (xdg-open). The partial lives in userData, so an unverified file never sits
// in Downloads.
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');
const Download = require('./download.js');
const { UpdateError } = require('./verify.js');

function create({ fetch, userData, downloadsDir, spawn = nodeSpawn, stallMs }) {
  let file = null;
  const partialDir = path.join(userData, 'updates', 'partial');

  async function download({ entry, url, onProgress }) {
    file = null;
    Download.cleanPartials(partialDir, { keepName: entry.name });
    Download.privateDir(path.join(userData, 'updates'));
    file = await Download.download({ fetch, url, entry, dir: partialDir, dest: path.join(downloadsDir, entry.name), onProgress, privateDest: false, stallMs });
  }

  async function install({ entry }) {
    if (!file) throw new UpdateError('unknown', 'Nothing downloaded; check again.');
    if (!(await Download.isVerified(file, entry))) {
      file = null;
      throw new UpdateError('verify', `${entry.name} in Downloads changed after it was checked; check again to download it afresh.`);
    }
    const opened = file;
    await new Promise((resolve, reject) => {
      let child;
      const failed = (err) => reject(new UpdateError('unknown', `Couldn't open the software installer (${err?.code || err?.message || err}). Open ${opened} yourself to install it.`));
      try {
        child = spawn('xdg-open', [opened], { detached: true, stdio: 'ignore' }); // privacy-flow: auto-update
      } catch (err) {
        failed(err);
        return;
      }
      child.once('error', failed);
      child.once('spawn', resolve);
      child.unref();
    });
    return { stay: true, file: opened };
  }

  return { kind: 'deb-manual', fileKind: 'deb', download, install, get file() { return file; } };
}

module.exports = { create };
