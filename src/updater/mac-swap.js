// macOS, unsigned (no Squirrel until there is a Developer ID): the app
// replaces its own bundle.
//   download  the signed release's <name>-mac-<arch>.zip with net (resumable),
//             verified by size and sha512 (download.js), then unpacked once
//             to check it (one real .app, this app's bundle id, the
//             manifest's version, no symlink leading out of the bundle)
//   install   check the zip's sha512 again, unpack it afresh into
//             userData/updates/staged and check that the same way, write
//             mac-swap-helper.sh to userData/updates, start it detached, and
//             quit once it has started; the helper swaps the bundles, launches
//             the new one, and rolls back if it hasn't written launched-ok
//             within 90 s
// "Revert" is not the kept bundle: it fetches the previous version's own
// signed release like any update (service.js), so a changed previous/ folder
// can't be installed. userData/updates and everything under it is 0700.
// Downloads through net carry no quarantine attribute; nothing here adds or
// strips Gatekeeper attributes.
const fs = require('fs');
const path = require('path');
const { execFile: nodeExecFile, execFileSync, spawn: nodeSpawn } = require('child_process');
const { UpdateError, parseVersion } = require('./verify.js');
const Download = require('./download.js');

const HELPER = path.join(__dirname, 'mac-swap-helper.sh');
// Written before the helper starts; a launch with --updated-from or
// --update-failed counts only while it is there and says the same version.
const PENDING = 'swap-pending.json';
const PENDING_MAX_AGE_MS = 15 * 60000;

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

// The first symlink under root that points outside it, or null. Electron's
// frameworks link inside the bundle (Versions/Current); nothing may leave it.
function escapingLink(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const target = path.resolve(dir, fs.readlinkSync(p));
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) return p;
      } else if (e.isDirectory()) stack.push(p);
    }
  }
  return null;
}

function readPending(updates) {
  try { return JSON.parse(fs.readFileSync(path.join(updates, PENDING), 'utf8')); } catch { return null; }
}

/**
 * What this launch may believe about a swap: { updatedFrom, updateFailed }.
 * Only the helper's launches count: the pending file must exist, be recent,
 * and name the same version. --update-failed is final, so it consumes it.
 */
function readLaunch({ userData, argv, now = Date.now() }) {
  const updates = path.join(userData, 'updates');
  const pending = readPending(updates);
  const drop = () => fs.rmSync(path.join(updates, PENDING), { force: true });
  const fresh = pending && typeof pending.from === 'string' && Number.isFinite(pending.at) && now - pending.at >= 0 && now - pending.at < PENDING_MAX_AGE_MS;
  if (pending && !fresh) drop();
  const arg = argv.find((a) => a.startsWith('--updated-from='));
  const from = arg ? arg.slice('--updated-from='.length) : null;
  const updatedFrom = fresh && from && from === pending.from && parseVersion(from) ? from : null;
  const updateFailed = !!(fresh && argv.includes('--update-failed'));
  if (updateFailed) drop();
  return { updatedFrom, updateFailed };
}

/**
 * opts: { fetch, userData, execPath, pid, quit, execFile?, spawn?, launch ('open'|'direct'), timeoutSec, now?, stallMs?, devOf? }
 */
function create({ fetch, userData, execPath, pid = process.pid, quit = () => {}, execFile = nodeExecFile, spawn = nodeSpawn, launch = 'open', timeoutSec = 90, now = Date.now, stallMs, devOf = (p) => fs.statSync(p).dev }) {
  const appPath = bundleOf(execPath);
  const updates = path.join(userData, 'updates');
  const partialDir = path.join(updates, 'partial');
  const zipDir = path.join(updates, 'downloads');
  const stagedDir = path.join(updates, 'staged');
  const previousDir = path.join(updates, 'previous');
  let zip = null;

  // A staged bundle from an earlier run was never installed; install re-makes it from the verified zip.
  fs.rmSync(stagedDir, { recursive: true, force: true });
  Download.cleanPartials(partialDir);

  function preflight() {
    if (!appPath) return new UpdateError('unknown', 'Plexiform is not running from an app bundle.');
    if (isTranslocated(appPath)) return new UpdateError('translocated', 'macOS is running Plexiform from a temporary copy, so it can\'t update itself. Move Plexiform to your Applications folder and open it from there, or download the .dmg.');
    const dir = path.dirname(appPath);
    if (!writable(dir) || !writable(appPath)) return new UpdateError('not-writable', `Plexiform can't replace itself in ${dir} (no permission to write there). Download the .dmg and drag it in, or move Plexiform to a folder you can write to.`);
    // The swap is two renames; across disks each would be a slow copy that a
    // crash can leave half done.
    try {
      fs.mkdirSync(userData, { recursive: true });
      if (devOf(dir) !== devOf(userData)) return new UpdateError('not-writable', `Plexiform is on a different disk from its data folder, so it can't replace itself safely. Download the .dmg and drag it into ${dir}, or move Plexiform to your Applications folder.`);
    } catch { /* unreadable: the helper reports what fails */ }
    return null;
  }

  function unzip(file, dest) {
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/ditto', ['-x', '-k', file, dest], (err) => (err ? reject(new UpdateError(/No space/i.test(String(err.message)) ? 'disk-full' : 'verify', `Could not unpack the update: ${err.message}`)) : resolve())); // privacy-flow: auto-update
    });
  }

  // Unpacks the verified zip into a fresh staged/ and checks what came out. → the .app
  async function unpack(manifest) {
    fs.rmSync(stagedDir, { recursive: true, force: true });
    Download.privateDir(stagedDir);
    await unzip(zip, stagedDir);
    const apps = fs.readdirSync(stagedDir).filter((n) => n.endsWith('.app'));
    if (apps.length !== 1) throw new UpdateError('verify', `The update holds ${apps.length} apps, not one.`);
    const candidate = path.join(stagedDir, apps[0]);
    if (!fs.lstatSync(candidate).isDirectory()) throw new UpdateError('verify', 'The update\'s app is a link, not an app.');
    const leak = escapingLink(candidate);
    if (leak) throw new UpdateError('verify', `The update links outside itself (${path.relative(stagedDir, leak)}).`);
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
    return candidate;
  }

  async function download({ manifest, entry, url, onProgress }) {
    zip = null;
    Download.cleanPartials(partialDir, { keepName: entry.name });
    try { for (const n of fs.readdirSync(zipDir)) if (n !== entry.name) fs.rmSync(path.join(zipDir, n), { force: true }); } catch { /* none yet */ }
    Download.privateDir(updates);
    zip = await Download.download({ fetch, url, entry, dir: partialDir, dest: path.join(zipDir, entry.name), onProgress, stallMs });
    await unpack(manifest);
    fs.rmSync(stagedDir, { recursive: true, force: true });
  }

  async function install({ manifest, entry, currentVersion }) {
    const pre = preflight();
    if (pre) throw pre;
    if (!parseVersion(currentVersion) || !/^\d+$/.test(String(pid))) throw new UpdateError('unknown', 'Plexiform could not tell which version is running.');
    if (!zip || !(await Download.isVerified(zip, entry))) throw new UpdateError('verify', 'The downloaded update changed after it was checked; check again to download it afresh.');
    const source = await unpack(manifest);
    Download.privateDir(updates);
    const helper = path.join(updates, 'swap.sh');
    // read + write, not copy: HELPER is inside app.asar in a packaged app
    fs.writeFileSync(helper, fs.readFileSync(HELPER), { mode: 0o700 });
    fs.chmodSync(helper, 0o700);
    const pendingFile = path.join(updates, PENDING);
    fs.writeFileSync(pendingFile, JSON.stringify({ from: currentVersion, to: manifest.version, at: now() }), { mode: 0o600 });
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', [helper, String(pid), appPath, source, previousDir, updates, currentVersion, String(timeoutSec), launch], { detached: true, stdio: 'ignore' }); // privacy-flow: auto-update
        child.once('error', reject);
        child.once('spawn', resolve);
        child.unref();
      });
    } catch (err) {
      fs.rmSync(pendingFile, { force: true });
      throw new UpdateError('unknown', `Couldn't start the update (${err?.code || err?.message || err}).`);
    }
    quit();
    return { helper };
  }

  return { kind: 'swap', fileKind: 'mac-zip', canFetchRevert: true, preflight, download, install, appPath };
}

// The new app, started by the helper (readLaunch said so): its pid now, so a
// failed start can be stopped, and launched-ok once it has been up for a while.
function markLaunched({ userData, updatedFrom, pid = process.pid, afterMs = 10000, setTimer = setTimeout }) {
  if (!updatedFrom) return false;
  const updates = path.join(userData, 'updates');
  try {
    Download.privateDir(updates);
    fs.writeFileSync(path.join(updates, 'launched-pid'), String(pid));
  } catch { /* the helper then just waits out its timeout */ }
  setTimer(() => { try { fs.writeFileSync(path.join(updates, 'launched-ok'), new Date().toISOString()); } catch { /* same */ } }, afterMs);
  return true;
}

module.exports = { create, bundleOf, isTranslocated, readBundleInfo, readLaunch, markLaunched, escapingLink, HELPER, PENDING };
