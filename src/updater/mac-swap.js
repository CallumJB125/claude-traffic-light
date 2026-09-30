// macOS, unsigned (no Squirrel until there is a Developer ID): the app
// replaces its own bundle.
//   download  the signed release's <name>-mac-<arch>.zip with net (resumable),
//             verified by size and sha512 (download.js)
//   unpack    /usr/bin/ditto -x -k into userData/updates/staged, then check it
//             is one .app with this app's bundle id and the manifest's version
//   install   write mac-swap-helper.sh to userData/updates, start it detached,
//             quit; the helper swaps the bundles, launches the new one, and
//             rolls back if it hasn't written launched-ok within 90 s
// The previous bundle stays in userData/updates/previous for "Revert".
// Downloads through net carry no quarantine attribute; nothing here adds or
// strips Gatekeeper attributes.
const fs = require('fs');
const path = require('path');
const { execFile: nodeExecFile, execFileSync, spawn: nodeSpawn } = require('child_process');
const { UpdateError } = require('./verify.js');
const Download = require('./download.js');

const HELPER = path.join(__dirname, 'mac-swap-helper.sh');

// /Applications/Plexiform.app/Contents/MacOS/Plexiform → /Applications/Plexiform.app
function bundleOf(execPath) {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath || '');
  return m ? m[1] : null;
}

// Gatekeeper runs a quarantined app from a random read-only mount.
const isTranslocated = (appPath) => /\/AppTranslocation\//.test(appPath || '');

function plistValue(xml, key) {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return m ? m[1] : null;
}

// → { id, version, build } from Contents/Info.plist (XML, or binary through plutil).
function readBundleInfo(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  let xml = fs.readFileSync(plist, 'utf8');
  if (!xml.trimStart().startsWith('<')) xml = execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', plist], { encoding: 'utf8' }); // privacy-flow: auto-update
  return { id: plistValue(xml, 'CFBundleIdentifier'), version: plistValue(xml, 'CFBundleShortVersionString'), build: plistValue(xml, 'CFBundleVersion') };
}

function writable(p) {
  try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; }
}

/**
 * opts: { fetch, userData, execPath, pid, quit, execFile?, spawn?, launch ('open'|'direct'), timeoutSec }
 */
function create({ fetch, userData, execPath, pid = process.pid, quit = () => {}, execFile = nodeExecFile, spawn = nodeSpawn, launch = 'open', timeoutSec = 90 }) {
  const appPath = bundleOf(execPath);
  const updates = path.join(userData, 'updates');
  const partialDir = path.join(updates, 'partial');
  const zipDir = path.join(updates, 'downloads');
  const stagedDir = path.join(updates, 'staged');
  const previousDir = path.join(updates, 'previous');
  const previousApp = appPath ? path.join(previousDir, path.basename(appPath)) : null;
  let staged = null;
  let revertFrom = null;
  let prevInfo;

  // A staged bundle from an earlier run was never installed; it is re-made from the verified zip.
  fs.rmSync(stagedDir, { recursive: true, force: true });
  Download.cleanPartials(partialDir);

  function preflight() {
    if (!appPath) return new UpdateError('unknown', 'Plexiform is not running from an app bundle.');
    if (isTranslocated(appPath)) return new UpdateError('translocated', 'macOS is running Plexiform from a temporary copy, so it can\'t update itself. Move Plexiform to your Applications folder and open it from there, or download the .dmg.');
    const dir = path.dirname(appPath);
    if (!writable(dir) || !writable(appPath)) return new UpdateError('not-writable', `Plexiform can't replace itself in ${dir} (no permission to write there). Download the .dmg and drag it in, or move Plexiform to a folder you can write to.`);
    return null;
  }

  function unzip(zip, dest) {
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/ditto', ['-x', '-k', zip, dest], (err) => (err ? reject(new UpdateError(/No space/i.test(String(err.message)) ? 'disk-full' : 'verify', `Could not unpack the update: ${err.message}`)) : resolve())); // privacy-flow: auto-update
    });
  }

  async function download({ manifest, entry, url, onProgress }) {
    staged = null;
    revertFrom = null;
    Download.cleanPartials(partialDir, { keepName: entry.name });
    try { for (const n of fs.readdirSync(zipDir)) if (n !== entry.name) fs.rmSync(path.join(zipDir, n), { force: true }); } catch { /* none yet */ }
    const zip = await Download.download({ fetch, url, entry, dir: partialDir, dest: path.join(zipDir, entry.name), onProgress });
    fs.rmSync(stagedDir, { recursive: true, force: true });
    fs.mkdirSync(stagedDir, { recursive: true });
    await unzip(zip, stagedDir);
    const apps = fs.readdirSync(stagedDir).filter((n) => n.endsWith('.app'));
    if (apps.length !== 1) throw new UpdateError('verify', `The update holds ${apps.length} apps, not one.`);
    const candidate = path.join(stagedDir, apps[0]);
    let info;
    let mine;
    try {
      info = readBundleInfo(candidate);
      mine = readBundleInfo(appPath);
    } catch (err) {
      throw new UpdateError('verify', `Could not read the app's Info.plist: ${err.message}`);
    }
    if (!info.id || info.id !== mine.id) throw new UpdateError('verify', `The update is ${info.id}, not ${mine.id}.`);
    if (info.version !== manifest.version && info.build !== manifest.version) throw new UpdateError('verify', `The update's app is version ${info.version}, the signed release is ${manifest.version}.`);
    staged = candidate;
  }

  function revertInfo() {
    if (prevInfo === undefined) {
      prevInfo = null;
      try { if (previousApp && fs.existsSync(previousApp)) prevInfo = readBundleInfo(previousApp); } catch { /* unreadable: no revert */ }
    }
    return { canRevert: !!prevInfo, previousVersion: prevInfo?.version || null };
  }

  // The kept bundle is this app's own earlier self; check it is still that app.
  async function revertLocal() {
    const { canRevert, previousVersion } = revertInfo();
    if (!canRevert) throw new UpdateError('unknown', 'There is no previous version to go back to.');
    if (prevInfo.id !== readBundleInfo(appPath).id) throw new UpdateError('verify', 'The kept previous version is a different app.');
    staged = null;
    revertFrom = previousApp;
    return { version: previousVersion };
  }

  function install({ currentVersion }) {
    const pre = preflight();
    if (pre) throw pre;
    let source = staged;
    if (revertFrom) {
      // The helper moves the running app into previous/, so the old one moves out first.
      fs.rmSync(stagedDir, { recursive: true, force: true });
      fs.mkdirSync(stagedDir, { recursive: true });
      source = path.join(stagedDir, path.basename(revertFrom));
      fs.renameSync(revertFrom, source);
    }
    if (!source || !fs.existsSync(source)) throw new UpdateError('unknown', 'The update is no longer staged; check again.');
    fs.mkdirSync(updates, { recursive: true });
    const helper = path.join(updates, 'swap.sh');
    // read + write, not copy: HELPER is inside app.asar in a packaged app
    fs.writeFileSync(helper, fs.readFileSync(HELPER));
    fs.chmodSync(helper, 0o755);
    const child = spawn('/bin/sh', [helper, String(pid), appPath, source, previousDir, updates, currentVersion, String(timeoutSec), launch], { detached: true, stdio: 'ignore' }); // privacy-flow: auto-update
    child.unref?.();
    prevInfo = undefined;
    quit();
    return { helper };
  }

  return { kind: 'swap', fileKind: 'mac-zip', preflight, download, install, revertInfo, revertLocal, appPath };
}

// The new app, started by the helper with --updated-from: its pid now, so a
// failed start can be stopped, and launched-ok once it has been up for a while.
function markLaunched({ userData, argv, pid = process.pid, afterMs = 10000, setTimer = setTimeout }) {
  if (!argv.some((a) => a.startsWith('--updated-from='))) return false;
  const updates = path.join(userData, 'updates');
  try {
    fs.mkdirSync(updates, { recursive: true });
    fs.writeFileSync(path.join(updates, 'launched-pid'), String(pid));
  } catch { /* the helper then just waits out its timeout */ }
  setTimer(() => { try { fs.writeFileSync(path.join(updates, 'launched-ok'), new Date().toISOString()); } catch { /* same */ } }, afterMs);
  return true;
}

module.exports = { create, bundleOf, isTranslocated, readBundleInfo, markLaunched, HELPER };
