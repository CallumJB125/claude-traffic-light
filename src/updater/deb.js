// Linux .deb: an app cannot replace a package itself, so it downloads the
// new .deb, verifies it against the signed release, and only then puts it in
// ~/Downloads; "install" opens it in the software installer (xdg-open). The
// partial lives in userData, so an unverified file never sits in Downloads.
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');
const Download = require('./download.js');

function create({ fetch, userData, downloadsDir, spawn = nodeSpawn }) {
  let file = null;

  async function download({ entry, url, onProgress }) {
    file = null;
    Download.cleanPartials(path.join(userData, 'updates', 'partial'), { keepName: entry.name });
    file = await Download.download({ fetch, url, entry, dir: path.join(userData, 'updates', 'partial'), dest: path.join(downloadsDir, entry.name), onProgress });
  }

  function install() {
    if (!file) throw new Error('nothing downloaded');
    const child = spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }); // privacy-flow: auto-update
    child.on?.('error', () => {});
    child.unref?.();
    return { stay: true, file };
  }

  return { kind: 'deb-manual', fileKind: 'deb', download, install, get file() { return file; } };
}

module.exports = { create };
