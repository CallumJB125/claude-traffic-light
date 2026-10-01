// Writes and signs release.json: the manifest every installed app checks
// before it installs anything (src/updater/verify.js reads this format).
//
// Nothing is signed when a tag builds. The promote workflow signs, from the
// GitHub Release's own assets, at the moment a version goes live:
//
//   version <dir>
//       print the one version of the installers in <dir>
//   check <dir> --channel stable|beta --version v
//       list the installers in <dir>, hash them, cross-check the feed files
//       (latest*.yml or beta*.yml); writes nothing (the stage job's early check)
//   build <dir> --channel c --version v [--notes-file f] [--live <dir>]
//         [--rollback [--rollback-from v1,v2]] [--out <dir>]
//       the same, then write release.json and release.json.sig with a fresh
//       issuedAt and expiresAt = issuedAt + 30 days. --live is a folder with
//       the feed's current release.json(.sig): verified with this repo's key,
//       it stops promoting an older version without --rollback, and a
//       rollback names it (and what it rolled back from) in rollbackFrom
//   resign <release.json> --channel c --version v [--rollback [--rollback-from ...]]
//          [--check-dir <dir>] [--out <dir>]
//       a manifest that already verifies with this repo's key for that
//       channel, for exactly that version, signed again with only rollback,
//       rollbackFrom, issuedAt and expiresAt changed; --check-dir also
//       requires every file in it to match (e.g. the GitHub Release assets)
//   verify-files <release.json> <dir>
//       every file the (signed) manifest names is in <dir> with its size and
//       sha512 (the promote job's check of what R2 staged)
//
// The keys are PLEXIFORM_UPDATE_SIGNING_KEY (stable) and
// PLEXIFORM_UPDATE_SIGNING_KEY_BETA (beta): Ed25519 PKCS8 PEMs, base64,
// secrets of the GitHub `release` environment. A key that doesn't match the
// public key this repo ships for its channel is refused.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Verify = require('../src/updater/verify.js');

const INSTALLER = /^([A-Za-z][A-Za-z0-9 ._]*?)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(mac|win|linux)-([A-Za-z0-9_]+)\.(exe|AppImage|deb|zip|dmg)$/;
const PLATFORM = { mac: 'darwin', win: 'win32', linux: 'linux' };
const ARCH = { x64: 'x64', x86_64: 'x64', amd64: 'x64', arm64: 'arm64', aarch64: 'arm64', universal: 'universal' };
const KIND = { exe: 'nsis', AppImage: 'appimage', deb: 'deb', zip: 'mac-zip', dmg: 'dmg' };
// electron-builder names the feed after the version's prerelease tag:
// latest*.yml for 1.2.0, beta*.yml for 1.2.0-beta.3 (app-builder-lib).
const FEED = /^(?:latest|beta|alpha)(?:-mac|-linux(?:-arm64|-arm)?)?\.yml$/;
const KEY_ENV = { stable: 'PLEXIFORM_UPDATE_SIGNING_KEY', beta: 'PLEXIFORM_UPDATE_SIGNING_KEY_BETA' };
const EXPIRES_DAYS = 30;

// The files: entries of an electron-builder latest*.yml, without a YAML dependency.
function parseFeed(text) {
  const out = [];
  let cur = null;
  const val = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /^\s*-\s+url:\s*(.+)$/.exec(line))) out.push(cur = { url: val(m[1]) });
    else if (cur && (m = /^\s+sha512:\s*(.+)$/.exec(line))) cur.sha512 = val(m[1]);
    else if (cur && (m = /^\s+size:\s*(\d+)\s*$/.exec(line))) cur.size = Number(m[1]);
    else if (/^\S/.test(line)) cur = null;
  }
  return out;
}

function hashFile(file) {
  const h = crypto.createHash('sha512');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let n;
  try { while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('base64');
}

const expiry = (issuedAt, days = EXPIRES_DAYS) => new Date(Date.parse(issuedAt) + days * Verify.DAY_MS).toISOString();

function listVersions(s) {
  if (!s) return [];
  const out = String(s).split(',').map((v) => v.trim()).filter(Boolean);
  for (const v of out) if (!Verify.parseVersion(v)) throw new Error(`not a version: ${JSON.stringify(v)}`);
  return out;
}

function buildManifest({ dir, channel, version, notes = '', issuedAt = new Date().toISOString(), rollback = false, rollbackFrom = [], product = Verify.PRODUCT }) {
  if (!Verify.CHANNELS.includes(channel)) throw new Error(`--channel must be one of ${Verify.CHANNELS.join(', ')}`);
  if (!Verify.parseVersion(version)) throw new Error(`--version must be a version (got ${JSON.stringify(version)})`);
  const names = fs.readdirSync(dir).sort();
  const files = [];
  for (const name of names) {
    const m = INSTALLER.exec(name);
    if (!m) continue;
    const [, , v, os, arch, ext] = m;
    if (!ARCH[arch]) throw new Error(`${name}: unknown arch ${arch}`);
    if (v !== version) throw new Error(`${name} is version ${v}, not ${version}`);
    const full = path.join(dir, name);
    files.push({ name, sha512: hashFile(full), size: fs.statSync(full).size, platform: PLATFORM[os], arch: ARCH[arch], kind: KIND[ext] });
  }
  if (!files.length) throw new Error(`no installers in ${dir}`);
  // The feed files and the manifest must name the same bytes, or the apps
  // that use electron-updater would refuse the release.
  const byName = new Map(files.map((f) => [f.name, f]));
  const feeds = names.filter((n) => FEED.test(n));
  for (const feed of feeds) {
    for (const e of parseFeed(fs.readFileSync(path.join(dir, feed), 'utf8'))) {
      const f = byName.get(e.url);
      if (!f) throw new Error(`${feed} names ${e.url}, which is not in ${dir}`);
      if (e.sha512 !== f.sha512) throw new Error(`${feed}: ${e.url} checksum differs from the file`);
      if (e.size != null && e.size !== f.size) throw new Error(`${feed}: ${e.url} size differs from the file`);
    }
  }
  const m = { product, channel, version, issuedAt, expiresAt: expiry(issuedAt), rollback: !!rollback, notes, files };
  if (rollback) m.rollbackFrom = rollbackFrom;
  return Verify.validateManifest(m);
}

// The private key for a channel, checked against the public key this repo ships for it.
function keyFromEnv(channel, env = process.env, keyring = require('../src/updater/index.js').loadShippedKeys()) {
  const name = KEY_ENV[channel];
  if (!name) throw new Error(`no signing key for channel ${channel}`);
  const b64 = env[name];
  if (!b64) return null;
  const key = crypto.createPrivateKey(Buffer.from(b64, 'base64').toString('utf8'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${name} is not an Ed25519 key`);
  const probe = Buffer.from('plexiform key check');
  if (!Verify.verifySignature(probe, crypto.sign(null, probe, key).toString('base64'), keyring[channel] || [])) {
    throw new Error(`${name} does not match build/${channel === 'beta' ? 'update-key-beta.pub.pem' : 'update-key.pub.pem'}`);
  }
  return key;
}

// → { json: Buffer, sig: string }: the exact bytes that are published, and their signature.
function sign(manifest, key) {
  const json = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return { json, sig: crypto.sign(null, json, key).toString('base64') };
}

function write(dir, { json, sig }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'release.json'), json);
  fs.writeFileSync(path.join(dir, 'release.json.sig'), `${sig}\n`);
}

// A manifest file and its .sig next to it, verified for this channel. null when absent.
function openFile(file, { channel, keyring }) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  const sig = fs.readFileSync(`${file}.sig`, 'utf8');
  return Verify.openManifest(bytes, sig, keyring, { channel });
}

// Every file the manifest names is in dir with exactly its size and sha512.
function verifyFiles(manifest, dir) {
  for (const f of manifest.files) {
    const full = path.join(dir, f.name);
    if (!fs.existsSync(full)) throw new Error(`${f.name} is missing from ${dir}`);
    if (fs.statSync(full).size !== f.size || hashFile(full) !== f.sha512) throw new Error(`${f.name} in ${dir} is not the file the release names`);
  }
  return true;
}

/**
 * The order rules for making `version` live, given what is live now.
 * → rollbackFrom (for a rollback) or undefined. Throws when it must not happen.
 */
function promoteCheck({ live, version, rollback, rollbackFrom = [] }) {
  if (live && !rollback && Verify.compareVersions(version, live.version) < 0) {
    throw new Error(`${version} is older than the live ${live.version}: tick rollback to go back to it`);
  }
  if (!rollback) return undefined;
  if (live && Verify.compareVersions(version, live.version) >= 0) throw new Error(`a rollback must be older than the live ${live.version}`);
  const from = [...rollbackFrom];
  if (live) from.push(live.version, ...(live.rollbackFrom || []));
  const unique = [...new Set(from)].filter((v) => Verify.compareVersions(v, version) > 0);
  if (!unique.length) throw new Error('a rollback needs the versions it rolls back from (nothing newer is live): pass --rollback-from');
  return unique.sort(Verify.compareVersions);
}

function resign(manifest, { channel, version, rollback, rollbackFrom, issuedAt = new Date().toISOString() }) {
  if (manifest.version !== version) throw new Error(`the manifest is for ${manifest.version}, not ${version}`);
  if (manifest.channel !== channel) throw new Error(`the manifest is for the ${manifest.channel} channel, not ${channel}`);
  const m = { ...manifest, rollback: !!rollback, issuedAt, expiresAt: expiry(issuedAt) };
  delete m.rollbackFrom;
  if (rollback) m.rollbackFrom = rollbackFrom;
  return Verify.validateManifest(m);
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rollback') out.rollback = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function main(argv, env = process.env, log = console, keyring = null) {
  const a = args(argv);
  const [cmd, target] = a._;
  const ring = () => keyring || require('../src/updater/index.js').loadShippedKeys();
  const needKey = () => {
    const key = keyFromEnv(a.channel, env, ring());
    if (!key) throw new Error(`${KEY_ENV[a.channel]} is not set; a release must be signed (run this in the release environment)`);
    return key;
  };
  if (cmd === 'version') {
    const found = new Set(fs.readdirSync(target).map((n) => INSTALLER.exec(n)?.[2]).filter(Boolean));
    if (found.size !== 1) throw new Error(`${target} holds ${found.size ? [...found].join(', ') : 'no installers'}, not one version`);
    log.log([...found][0]);
    return 0;
  }
  if (cmd === 'check') {
    const m = buildManifest({ dir: target, channel: a.channel, version: a.version });
    log.log(`release files: ${m.channel} ${m.version}, ${m.files.length} installers, feed files match`);
    return 0;
  }
  if (cmd === 'build') {
    const key = needKey();
    const live = a.live ? openFile(path.join(a.live, 'release.json'), { channel: a.channel, keyring: ring() }) : null;
    const rollbackFrom = promoteCheck({ live, version: a.version, rollback: !!a.rollback, rollbackFrom: listVersions(a['rollback-from']) });
    const notes = a['notes-file'] ? fs.readFileSync(a['notes-file'], 'utf8') : '';
    const manifest = buildManifest({ dir: target, channel: a.channel, version: a.version, notes, rollback: !!a.rollback, rollbackFrom });
    write(a.out || target, sign(manifest, key));
    log.log(`release.json: ${manifest.product} ${manifest.channel} ${manifest.version}${manifest.rollback ? ` (rollback from ${manifest.rollbackFrom.join(', ')})` : ''}, ${manifest.files.length} files, signed, issued ${manifest.issuedAt}`);
    return 0;
  }
  if (cmd === 'resign') {
    const key = needKey();
    const old = openFile(target, { channel: a.channel, keyring: ring() });
    if (!old) throw new Error(`${target} does not exist`);
    if (a['check-dir']) verifyFiles(old, a['check-dir']);
    const rollbackFrom = a.rollback ? listVersions(a['rollback-from']) : undefined;
    const manifest = resign(old, { channel: a.channel, version: a.version, rollback: !!a.rollback, rollbackFrom });
    write(a.out || path.dirname(target), sign(manifest, key));
    log.log(`release.json: ${manifest.version} re-signed${manifest.rollback ? ' as a rollback' : ''}, issued ${manifest.issuedAt}`);
    return 0;
  }
  if (cmd === 'verify-files') {
    const m = openFile(target, { channel: a.channel, keyring: ring() });
    if (!m) throw new Error(`${target} does not exist`);
    verifyFiles(m, a._[2]);
    log.log(`${m.files.length} files in ${a._[2]} match release.json ${m.version}`);
    return 0;
  }
  throw new Error('usage: release-sign.js check|build <dir> --channel stable|beta --version v [...] | resign <release.json> --channel c --version v [...] | verify-files <release.json> <dir> --channel c');
}

if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))); } catch (err) { console.error(`release-sign: ${err.message}`); process.exit(1); }
}

module.exports = { buildManifest, parseFeed, sign, resign, keyFromEnv, promoteCheck, verifyFiles, openFile, main, FEED, KEY_ENV, EXPIRES_DAYS };
