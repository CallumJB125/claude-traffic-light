// Writes and signs release.json: the manifest every installed app checks
// before it installs anything (src/updater/verify.js reads this format).
//
//   build <dir> --channel stable|beta [--version v] [--notes-file f] [--optional]
//       list the installers in <dir>, hash them, cross-check the latest*.yml
//       feed files, then write <dir>/release.json and <dir>/release.json.sig
//   resign <release.json> --rollback [--out <dir>]
//       the same manifest with rollback:true and a fresh issuedAt, for
//       promoting an older version: apps accept a downgrade only when it is
//       signed as one, and a fresh issuedAt gets past their replay check
//
// The key is PLEXIFORM_UPDATE_SIGNING_KEY: an Ed25519 PKCS8 PEM, base64. It
// exists only as a GitHub Actions secret. Without it, build fails unless
// --optional is given (beta dry runs), which warns and writes nothing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Verify = require('../src/updater/verify.js');

const INSTALLER = /^([A-Za-z][A-Za-z0-9 ._]*?)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(mac|win|linux)-([A-Za-z0-9_]+)\.(exe|AppImage|deb|zip|dmg)$/;
const PLATFORM = { mac: 'darwin', win: 'win32', linux: 'linux' };
const ARCH = { x64: 'x64', x86_64: 'x64', amd64: 'x64', arm64: 'arm64', aarch64: 'arm64', universal: 'universal' };
const KIND = { exe: 'nsis', AppImage: 'appimage', deb: 'deb', zip: 'mac-zip', dmg: 'dmg' };
const FEED = /^latest(?:-mac|-linux)?\.yml$/;

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

function buildManifest({ dir, channel, version = null, notes = '', issuedAt = new Date().toISOString(), rollback = false, product = Verify.PRODUCT }) {
  if (!Verify.CHANNELS.includes(channel)) throw new Error(`--channel must be one of ${Verify.CHANNELS.join(', ')}`);
  const names = fs.readdirSync(dir).sort();
  const files = [];
  for (const name of names) {
    const m = INSTALLER.exec(name);
    if (!m) continue;
    const [, , v, os, arch, ext] = m;
    if (!ARCH[arch]) throw new Error(`${name}: unknown arch ${arch}`);
    if (version && v !== version) throw new Error(`${name} is version ${v}, not ${version}`);
    version = v;
    const full = path.join(dir, name);
    files.push({ name, sha512: hashFile(full), size: fs.statSync(full).size, platform: PLATFORM[os], arch: ARCH[arch], kind: KIND[ext] });
  }
  if (!files.length) throw new Error(`no installers in ${dir}`);
  // The feed files and the manifest must name the same bytes, or the apps
  // that use electron-updater would refuse the release.
  const byName = new Map(files.map((f) => [f.name, f]));
  for (const feed of names.filter((n) => FEED.test(n))) {
    for (const e of parseFeed(fs.readFileSync(path.join(dir, feed), 'utf8'))) {
      const f = byName.get(e.url);
      if (!f) throw new Error(`${feed} names ${e.url}, which is not in ${dir}`);
      if (e.sha512 !== f.sha512) throw new Error(`${feed}: ${e.url} checksum differs from the file`);
      if (e.size != null && e.size !== f.size) throw new Error(`${feed}: ${e.url} size differs from the file`);
    }
  }
  return Verify.validateManifest({ product, channel, version, issuedAt, rollback, notes, files });
}

function keyFromEnv(env = process.env) {
  const b64 = env.PLEXIFORM_UPDATE_SIGNING_KEY;
  if (!b64) return null;
  const key = crypto.createPrivateKey(Buffer.from(b64, 'base64').toString('utf8'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('PLEXIFORM_UPDATE_SIGNING_KEY is not an Ed25519 key');
  return key;
}

// → { json: Buffer, sig: string }: the exact bytes that are published, and their signature.
function sign(manifest, key) {
  const json = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return { json, sig: crypto.sign(null, json, key).toString('base64') };
}

function write(dir, { json, sig }) {
  fs.writeFileSync(path.join(dir, 'release.json'), json);
  fs.writeFileSync(path.join(dir, 'release.json.sig'), `${sig}\n`);
}

function resign(manifest, { rollback, issuedAt = new Date().toISOString() }) {
  return Verify.validateManifest({ ...manifest, rollback: !!rollback, issuedAt });
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--optional' || a === '--rollback') out[a.slice(2)] = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function main(argv, env = process.env, log = console) {
  const a = args(argv);
  const [cmd, target] = a._;
  if (cmd === 'build') {
    const key = keyFromEnv(env);
    if (!key) {
      if (a.optional) { log.log('::warning::PLEXIFORM_UPDATE_SIGNING_KEY is not set: release.json not written; installed apps will refuse this release'); return 0; }
      throw new Error('PLEXIFORM_UPDATE_SIGNING_KEY is not set; a release without a signed manifest cannot be installed');
    }
    const notes = a['notes-file'] ? fs.readFileSync(a['notes-file'], 'utf8') : '';
    const manifest = buildManifest({ dir: target, channel: a.channel, version: a.version || null, notes });
    write(target, sign(manifest, key));
    log.log(`release.json: ${manifest.product} ${manifest.channel} ${manifest.version}, ${manifest.files.length} files, signed`);
    return 0;
  }
  if (cmd === 'resign') {
    const key = keyFromEnv(env);
    if (!key) throw new Error('PLEXIFORM_UPDATE_SIGNING_KEY is not set; a rollback must be signed');
    if (!a.rollback) throw new Error('resign needs --rollback');
    const manifest = resign(JSON.parse(fs.readFileSync(target, 'utf8')), { rollback: true });
    write(a.out || path.dirname(target), sign(manifest, key));
    log.log(`release.json: ${manifest.version} re-signed as a rollback, issued ${manifest.issuedAt}`);
    return 0;
  }
  throw new Error('usage: release-sign.js build <dir> --channel stable|beta [--version v] [--notes-file f] [--optional] | resign <release.json> --rollback [--out dir]');
}

if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))); } catch (err) { console.error(`release-sign: ${err.message}`); process.exit(1); }
}

module.exports = { buildManifest, parseFeed, sign, resign, keyFromEnv, main };
