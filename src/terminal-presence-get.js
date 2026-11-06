'use strict';
// "Get Plexiform Terminal": download the release named in
// terminal-presence-release.json, check its SHA-256, unpack it with ditto,
// check the bundle, then put it in /Applications (or ~/Applications when
// /Applications is not writable) and open it. Opening the installed app opens
// that exact path, never a name LaunchServices resolves.
// Node built-ins only: test/surface-boundary.test.js pins what this may require.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const APP_NAME = 'Plexiform Terminal.app';
const BUNDLE_ID = 'dev.plexiform.terminal';
const MAX_BYTES = 400 * 1024 * 1024;
// Only this repository's terminal-v* release assets.
const URL_RE = /^https:\/\/github\.com\/CallumJB125\/claude-traffic-light\/releases\/download\/terminal-v[0-9A-Za-z.+-]{1,40}\/[0-9A-Za-z._-]{1,120}\.zip$/;

function readManifest(file = path.join(__dirname, 'terminal-presence-release.json'), fsImpl = fs) {
  let m;
  try { m = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return null; }
  if (!m || typeof m !== 'object' || typeof m.url !== 'string' || !URL_RE.test(m.url)) return null;
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return null;
  return { version: typeof m.version === 'string' ? m.version.slice(0, 40) : null, url: m.url, sha256: m.sha256 };
}

const run = (file, args, timeout = 120000) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)); // privacy-flow: terminal-get
});

// Streams the body to `dest`, hashing as it goes; the size cap holds whatever Content-Length says.
async function download(url, dest, { fetchImpl = globalThis.fetch, fsImpl = fs } = {}) { // privacy-flow: terminal-get
  const res = await fetchImpl(url, { redirect: 'follow' }); // privacy-flow: terminal-get
  if (!res.ok || !res.body) throw Object.assign(new Error(`The download failed (HTTP ${res.status}).`), { code: 'DOWNLOAD' });
  if (typeof res.url === 'string' && res.url && !res.url.startsWith('https://')) throw Object.assign(new Error('The download left HTTPS.'), { code: 'DOWNLOAD' });
  const hash = crypto.createHash('sha256');
  const fd = fsImpl.openSync(dest, 'wx', 0o600);
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) throw Object.assign(new Error('The download is larger than expected.'), { code: 'DOWNLOAD' });
      hash.update(chunk);
      fsImpl.writeSync(fd, chunk);
    }
  } finally { fsImpl.closeSync(fd); }
  return hash.digest('hex');
}

function create({ home = os.homedir(), platform = process.platform, manifest = () => readManifest(), fetchImpl = globalThis.fetch, exec = run, // privacy-flow: terminal-get
  readPlist = async (p) => JSON.parse(await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', p], 5000)), fsImpl = fs, // privacy-flow: terminal-get
  tempDir = os.tmpdir(), appDirs = ['/Applications', path.join(home, 'Applications')] } = {}) {
  let inflight = null;

  async function install() {
    if (platform !== 'darwin') return { ok: false, code: 'UNSUPPORTED_PLATFORM', text: 'Plexiform Terminal is for macOS.' };
    const m = manifest();
    if (!m) return { ok: false, code: 'NO_RELEASE', text: 'No Plexiform Terminal release is published for this version of Plexiform yet.' };
    const work = fsImpl.mkdtempSync(path.join(tempDir, 'plexiform-terminal-get-'));
    fsImpl.chmodSync(work, 0o700);
    try {
      const zip = path.join(work, 'terminal.zip'), out = path.join(work, 'out');
      const digest = await download(m.url, zip, { fetchImpl, fsImpl });
      if (digest !== m.sha256) return { ok: false, code: 'CHECKSUM', text: 'The download did not match its published checksum, so nothing was installed.' };
      fsImpl.mkdirSync(out, { mode: 0o700 });
      await exec('/usr/bin/ditto', ['-x', '-k', zip, out]); // privacy-flow: terminal-get
      const entries = fsImpl.readdirSync(out).filter((n) => n !== '__MACOSX');
      const staged = path.join(out, APP_NAME);
      if (entries.length !== 1 || entries[0] !== APP_NAME || fsImpl.lstatSync(staged).isSymbolicLink()) return { ok: false, code: 'BAD_ARCHIVE', text: 'The download did not contain Plexiform Terminal, so nothing was installed.' };
      const info = await readPlist(path.join(staged, 'Contents', 'Info.plist')).catch(() => null);
      if (!info || info.CFBundleIdentifier !== BUNDLE_ID) return { ok: false, code: 'BAD_ARCHIVE', text: 'The download did not contain Plexiform Terminal, so nothing was installed.' };
      let lastError = null;
      for (const dir of appDirs) {
        try { return { ok: true, path: await place(staged, dir), version: typeof info.CFBundleShortVersionString === 'string' ? info.CFBundleShortVersionString.slice(0, 40) : m.version }; } catch (e) { lastError = e; }
      }
      return { ok: false, code: 'INSTALL', text: `Plexiform Terminal could not be put in Applications (${String(lastError?.code || 'error').slice(0, 20)}).` };
    } catch (e) {
      return { ok: false, code: e?.code === 'DOWNLOAD' ? 'DOWNLOAD' : 'INSTALL', text: e?.code === 'DOWNLOAD' ? String(e.message) : 'Plexiform Terminal could not be installed.' };
    } finally {
      try { fsImpl.rmSync(work, { recursive: true, force: true }); } catch { /* temporary residue */ }
    }
  }

  // An existing copy is moved aside first and put back if the copy fails, so a failed Get never leaves no Terminal.
  async function place(staged, dir) {
    if (dir !== '/Applications') fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.accessSync(dir, fs.constants.W_OK);
    const dest = path.join(dir, APP_NAME), aside = path.join(dir, `.${APP_NAME}.old-${process.pid}`);
    const had = fsImpl.existsSync(dest);
    if (had) fsImpl.renameSync(dest, aside);
    try { await exec('/usr/bin/ditto', [staged, dest]); } catch (e) { // privacy-flow: terminal-get
      try { fsImpl.rmSync(dest, { recursive: true, force: true }); if (had) fsImpl.renameSync(aside, dest); } catch { /* left as is */ }
      throw e;
    }
    if (had) try { fsImpl.rmSync(aside, { recursive: true, force: true }); } catch { /* removed later */ }
    return dest;
  }

  return {
    available: () => platform === 'darwin' && !!manifest(),
    // One Get at a time; a second click while one runs joins it.
    get: () => (inflight ||= install().finally(() => { inflight = null; })),
    busy: () => !!inflight,
    open: async (appPath) => {
      if (platform !== 'darwin' || typeof appPath !== 'string' || !appDirs.some((d) => appPath === path.join(d, APP_NAME))) return { ok: false, code: 'NOT_INSTALLED' };
      try { await exec('/usr/bin/open', [appPath], 10000); return { ok: true }; } catch { return { ok: false, code: 'CANT_OPEN' }; }
    },
  };
}

module.exports = { create, readManifest, download, URL_RE, APP_NAME };
