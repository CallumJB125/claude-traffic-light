// Release files on Cloudflare R2 (served at download.plexiform.dev).
//
//   stage <version> <dir>   upload every file in <dir> under <version>/.
//                           Refuses a version that was already promoted
//                           (<version>/release.json exists): re-running a tag
//                           never changes a live release
//   stage-beta <version> <dir>  the same under beta/<version>/
//   promote <version> --manifest-dir <dir>
//                           make <version> what the apps update to: copy its
//                           staged files to the bucket root, installers first,
//                           then the feed files (latest*.yml or beta*.yml),
//                           then the release.json(.sig) signed at promote
//                           time from <dir>, to <version>/ (for Revert) and
//                           last to the root
//   promote-beta <version> --manifest-dir <dir>
//                           the same from beta/<version>/ to beta/
//   fetch-live <dir> [--beta] [--version v]
//                           download the live release.json(.sig), if any;
//                           with --version, the one <version>/ was promoted
//                           with (a rollback checks its files against it)
//   fetch-staged <version> <dir> [--beta]
//                           download what <version>/ staged, to check it
//                           against the GitHub Release before signing
//
// The apps read release.json first and install only what its signature
// covers (src/updater/). Installer names carry the version, so copying a
// release to the root never overwrites another one; only the feed files and
// the manifest change.
//
// Windows files (*-win-*, latest.yml, beta.yml) are staged, fetched and
// promoted only with WINDOWS_RELEASE=true (release-sign.js says why).
//
// Uses the aws CLI (on every GitHub runner) against R2's S3 endpoint. Only
// staging tolerates missing R2 secrets (it says so and exits 0, so the
// GitHub Release still stages); every other command fails without them.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { releaseNames, windowsEnabled } = require('./release-sign.js');

const FEED = /^(?:latest|beta|alpha)(?:-mac|-linux(?:-arm64|-arm)?)?\.yml$/;
const MANIFEST = ['release.json', 'release.json.sig'];
// 0 installers, 1 feed files, 2 the manifest, then its signature
const rank = (name) => (FEED.test(name) ? 1 : MANIFEST.includes(name) ? 2 + MANIFEST.indexOf(name) : 0);
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TYPES = {
  '.yml': 'text/yaml', '.json': 'application/json', '.sig': 'text/plain', '.txt': 'text/plain',
  '.exe': 'application/vnd.microsoft.portable-executable', '.dmg': 'application/x-apple-diskimage', '.zip': 'application/zip',
  '.deb': 'application/vnd.debian.binary-package', '.AppImage': 'application/vnd.appimage', '.blockmap': 'application/octet-stream',
};
const contentType = (name) => TYPES[path.extname(name)] || 'application/octet-stream';

function config(env = process.env) {
  const missing = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_RELEASES_BUCKET'].filter((k) => !env[k]);
  if (missing.length) return { missing };
  return {
    bucket: env.R2_RELEASES_BUCKET,
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    env: { ...env, AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION: 'auto' },
  };
}

// Only names that carry a version never change; everything else (the feed
// files, the manifest, SHA256SUMS.txt) is re-read on every request.
const cacheControl = (name) => (/\d+\.\d+\.\d+/.test(name) ? 'public, max-age=31536000, immutable' : 'no-cache, max-age=0');

function aws(cfg, args, run = execFileSync, stderr = 'inherit') {
  return run('aws', ['s3', ...args, '--endpoint-url', cfg.endpoint], { env: cfg.env, stdio: ['ignore', 'pipe', stderr], encoding: 'utf8' }); // privacy-flow: release-upload (CI only, never in the app)
}

const checkVersion = (version) => { if (!VERSION.test(version || '')) throw new Error(`not a version: ${version}`); };

function stagePlan(version, files, prefix = '', windows = false) {
  checkVersion(version);
  const signed = files.filter((f) => MANIFEST.includes(f));
  if (signed.length) throw new Error(`${signed.join(', ')} in the staging folder: manifests are signed at promote time, never staged`);
  return releaseNames(files, windows).filter((f) => !f.startsWith('.')).sort((a, b) => rank(a) - rank(b)).map((name) => ({ name, key: `${prefix}${version}/${name}`, cache: cacheControl(name) }));
}

// names: what `aws s3 ls <prefix><version>/` listed. Installers, then feed
// files; the manifest is uploaded separately (it is signed at promote time).
function promotePlan(version, names, prefix = '', windows = false) {
  checkVersion(version);
  const from = `${prefix}${version}/`;
  const files = releaseNames(names, windows).filter((n) => n && !n.includes('/') && !MANIFEST.includes(n));
  if (!files.some((n) => FEED.test(n))) throw new Error(`${from} has no feed file (latest*.yml or beta*.yml) staged; stage it first`);
  return files.sort((a, b) => rank(a) - rank(b)).map((name) => ({ from: `${from}${name}`, to: `${prefix}${name}`, name, cache: cacheControl(name) }));
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || true : null;
}

// What is under key. `aws s3 ls` exits 1, and says nothing, for an empty
// prefix; any other failure (credentials, network, bucket) throws with its
// stderr, so a broken listing is never read as "nothing there".
const listNames = (cfg, key, run) => {
  let out;
  try {
    out = aws(cfg, ['ls', `s3://${cfg.bucket}/${key}`], run, 'pipe');
  } catch (err) {
    const stderr = String(err?.stderr || '').trim();
    if (err?.status === 1 && !stderr && !String(err?.stdout || '').trim()) return [];
    throw new Error(`aws s3 ls s3://${cfg.bucket}/${key} failed${err?.status != null ? ` (exit ${err.status})` : ''}: ${stderr || err?.message || err}`);
  }
  return out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('PRE ')).map((l) => l.split(/\s+/).slice(3).join(' ')).filter(Boolean);
};

function main(argv, run, log = console.log, env = process.env) {
  const [cmd, version, dir] = argv;
  const cfg = config(env);
  if (cfg.missing) {
    if (cmd === 'stage' || cmd === 'stage-beta') {
      log(`R2: skipped (${cfg.missing.join(', ')} not set); the GitHub Release is the only copy.`);
      return;
    }
    throw new Error(`${cfg.missing.join(', ')} not set: ${cmd} needs R2`);
  }
  const windows = windowsEnabled(env);
  const prefix = cmd === 'stage-beta' || cmd === 'promote-beta' || argv.includes('--beta') ? 'beta/' : '';
  const put = (file, key, name) => aws(cfg, ['cp', file, `s3://${cfg.bucket}/${key}`, '--cache-control', cacheControl(name), '--content-type', contentType(name), '--only-show-errors'], run);
  if (cmd === 'stage' || cmd === 'stage-beta') {
    const plan = stagePlan(version, fs.readdirSync(dir), prefix, windows);
    if (listNames(cfg, `${prefix}${version}/`, run).includes('release.json')) throw new Error(`${prefix}${version}/ was already promoted; a published release is never staged again (bump the version)`);
    for (const f of plan) {
      log(`R2: ${f.key}`);
      put(path.join(dir, f.name), f.key, f.name);
    }
  } else if (cmd === 'promote' || cmd === 'promote-beta') {
    const local = flag(argv, '--manifest-dir');
    if (typeof local !== 'string') throw new Error('promote needs --manifest-dir <dir> with the release.json signed for this promote');
    for (const n of MANIFEST) if (!fs.existsSync(path.join(local, n))) throw new Error(`${path.join(local, n)} is missing`);
    for (const c of promotePlan(version, listNames(cfg, `${prefix}${version}/`, run), prefix, windows)) {
      log(`R2: ${c.from} → ${c.to}`);
      aws(cfg, ['cp', `s3://${cfg.bucket}/${c.from}`, `s3://${cfg.bucket}/${c.to}`, '--cache-control', c.cache, '--content-type', contentType(c.name), '--metadata-directive', 'REPLACE', '--only-show-errors'], run);
    }
    for (const where of [`${prefix}${version}/`, prefix]) {
      for (const n of MANIFEST) {
        log(`R2: ${path.join(local, n)} → ${where}${n} (signed now)`);
        put(path.join(local, n), `${where}${n}`, n);
      }
    }
  } else if (cmd === 'fetch-live') {
    const out = version;
    const v = flag(argv, '--version');
    if (v !== null) checkVersion(v);
    const from = v ? `${prefix}${v}/` : prefix;
    fs.mkdirSync(out, { recursive: true });
    const live = listNames(cfg, from, run);
    if (!MANIFEST.every((n) => live.includes(n))) { log(`R2: no release.json at ${from || 'the root'}`); return; }
    for (const n of MANIFEST) aws(cfg, ['cp', `s3://${cfg.bucket}/${from}${n}`, path.join(out, n), '--only-show-errors'], run);
  } else if (cmd === 'fetch-staged') {
    checkVersion(version);
    fs.mkdirSync(dir, { recursive: true });
    for (const n of releaseNames(listNames(cfg, `${prefix}${version}/`, run), windows)) {
      if (MANIFEST.includes(n)) continue;
      aws(cfg, ['cp', `s3://${cfg.bucket}/${prefix}${version}/${n}`, path.join(dir, n), '--only-show-errors'], run);
    }
  } else {
    throw new Error('usage: release-r2.js stage|stage-beta <version> <dir> | promote|promote-beta <version> --manifest-dir <dir> | fetch-live <dir> [--beta] [--version v] | fetch-staged <version> <dir> [--beta]');
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) { console.error(`R2: ${err.message}`); process.exit(1); }
}

module.exports = { stagePlan, promotePlan, cacheControl, contentType, config, main, FEED };
