// Release files on Cloudflare R2 (served at download.plexiform.dev).
//
//   stage <version> <dir>   upload every file in <dir> under <version>/
//   stage-beta <version> <dir>  the same under beta/<version>/ (dry runs; the
//                           live feed and beta/ feed files are never touched)
//   promote <version> [--manifest-dir <dir>]
//                           make <version> what the apps update to: copy its
//                           files to the bucket root, installers first, then
//                           the latest*.yml feed files, then release.json and
//                           its .sig. --manifest-dir uploads a re-signed
//                           release.json(.sig) from <dir> instead of the
//                           staged ones (a rollback: release-sign.js resign)
//   promote-beta <version> [--manifest-dir <dir>]
//                           the same from beta/<version>/ to beta/
//   fetch-manifest <version> <dir> [--beta]
//                           download the staged release.json, to re-sign it
//
// The apps read release.json first and install only what its signature
// covers (src/updater/). A version with no signed release.json staged is
// refused here rather than promoted into a feed every app would reject.
// Installer names carry the version, so copying a release to the root never
// overwrites another one; only the feed files and the manifest change. A
// rollback is promoting the older version with a manifest re-signed as one.
//
// Uses the aws CLI (on every GitHub runner) against R2's S3 endpoint. With no
// R2 secrets set it says so and exits 0, so the GitHub Release still stages.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FEED = /^latest(?:-mac|-linux)?\.yml$/;
const MANIFEST = ['release.json', 'release.json.sig'];
// 0 installers, 1 feed files, 2 the manifest, then its signature
const rank = (name) => (FEED.test(name) ? 1 : MANIFEST.includes(name) ? 2 + MANIFEST.indexOf(name) : 0);
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function config(env = process.env) {
  const missing = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_RELEASES_BUCKET'].filter((k) => !env[k]);
  if (missing.length) return { missing };
  return {
    bucket: env.R2_RELEASES_BUCKET,
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    env: { ...env, AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION: 'auto' },
  };
}

// Feed files must never be cached past a promote; installers never change.
const cacheControl = (name) => (rank(name) > 0 ? 'no-cache, max-age=0' : 'public, max-age=31536000, immutable');

function aws(cfg, args, run = execFileSync) {
  return run('aws', ['s3', ...args, '--endpoint-url', cfg.endpoint], { env: cfg.env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }); // privacy-flow: release-upload (CI only, never in the app)
}

function stagePlan(version, files, prefix = '') {
  if (!VERSION.test(version)) throw new Error(`not a version: ${version}`);
  return files.filter((f) => !f.startsWith('.')).sort((a, b) => rank(a) - rank(b)).map((name) => ({ name, key: `${prefix}${version}/${name}`, cache: cacheControl(name) }));
}

function promotePlan(version, keys, prefix = '') {
  if (!VERSION.test(version)) throw new Error(`not a version: ${version}`);
  const from = `${prefix}${version}/`;
  const names = keys.filter((k) => k.startsWith(from)).map((k) => k.slice(from.length)).filter((n) => n && !n.includes('/'));
  if (!names.some((n) => FEED.test(n))) throw new Error(`${from} has no latest*.yml staged; stage it first`);
  const missing = MANIFEST.filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`${from} has no ${missing.join(' or ')}: the apps would refuse it (sign it with PLEXIFORM_UPDATE_SIGNING_KEY and stage again)`);
  // Installers, then feed files, then the manifest: an app never reads a
  // feed or a manifest that names a file not there yet.
  return names.sort((a, b) => rank(a) - rank(b)).map((name) => ({ from: `${from}${name}`, to: `${prefix}${name}`, cache: cacheControl(name) }));
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || true : null;
}

function main(argv, run) {
  const [cmd, version, dir] = argv;
  const cfg = config();
  if (cfg.missing) {
    console.log(`R2: skipped (${cfg.missing.join(', ')} not set); the GitHub Release is the feed.`);
    return;
  }
  if (cmd === 'stage' || cmd === 'stage-beta') {
    for (const f of stagePlan(version, fs.readdirSync(dir), cmd === 'stage-beta' ? 'beta/' : '')) {
      console.log(`R2: ${f.key}`);
      aws(cfg, ['cp', path.join(dir, f.name), `s3://${cfg.bucket}/${f.key}`, '--cache-control', f.cache, '--only-show-errors'], run);
    }
  } else if (cmd === 'promote' || cmd === 'promote-beta') {
    const prefix = cmd === 'promote-beta' ? 'beta/' : '';
    const local = flag(argv, '--manifest-dir');
    const listing = aws(cfg, ['ls', `s3://${cfg.bucket}/${prefix}${version}/`], run);
    const keys = listing.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean).map((n) => `${prefix}${version}/${n}`);
    for (const c of promotePlan(version, keys, prefix)) {
      const name = c.to.slice(prefix.length);
      if (local && MANIFEST.includes(name)) {
        console.log(`R2: ${path.join(local, name)} → ${c.to} (re-signed)`);
        aws(cfg, ['cp', path.join(local, name), `s3://${cfg.bucket}/${c.to}`, '--cache-control', c.cache, '--only-show-errors'], run);
      } else {
        console.log(`R2: ${c.from} → ${c.to}`);
        aws(cfg, ['cp', `s3://${cfg.bucket}/${c.from}`, `s3://${cfg.bucket}/${c.to}`, '--cache-control', c.cache, '--metadata-directive', 'REPLACE', '--only-show-errors'], run);
      }
    }
  } else if (cmd === 'fetch-manifest') {
    if (!VERSION.test(version)) throw new Error(`not a version: ${version}`);
    const prefix = argv.includes('--beta') ? 'beta/' : '';
    for (const name of MANIFEST) aws(cfg, ['cp', `s3://${cfg.bucket}/${prefix}${version}/${name}`, path.join(dir, name), '--only-show-errors'], run);
  } else {
    throw new Error('usage: release-r2.js stage|stage-beta <version> <dir> | promote|promote-beta <version> [--manifest-dir <dir>] | fetch-manifest <version> <dir> [--beta]');
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) { console.error(`R2: ${err.message}`); process.exit(1); }
}

module.exports = { stagePlan, promotePlan, cacheControl, config, main };
