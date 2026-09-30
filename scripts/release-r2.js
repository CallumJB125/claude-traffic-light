// Release files on Cloudflare R2 (served at download.plexiform.dev).
//
//   stage <version> <dir>   upload every file in <dir> under <version>/
//   stage-beta <version> <dir>  the same under beta/<version>/ (dry runs; the
//                           live feed and beta/ feed files are never touched)
//   promote <version>       make <version> what the apps update to: copy its
//                           files to the bucket root, the feed files last
//
// electron-updater's generic provider reads latest.yml / latest-mac.yml /
// latest-linux.yml at the root and fetches the file each one names from the
// root too. Installer names carry the version, so copying a release to the
// root never overwrites another one; only the three feed files change. So
// rolling back is promoting the older version (the app allows downgrades).
//
// Uses the aws CLI (on every GitHub runner) against R2's S3 endpoint. With no
// R2 secrets set it says so and exits 0, so the GitHub Release still stages.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FEED = /^latest(?:-mac|-linux)?\.yml$/;
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
const cacheControl = (name) => (FEED.test(name) ? 'no-cache, max-age=0' : 'public, max-age=31536000, immutable');

function aws(cfg, args, run = execFileSync) {
  return run('aws', ['s3', ...args, '--endpoint-url', cfg.endpoint], { env: cfg.env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }); // privacy-flow: release-upload (CI only, never in the app)
}

function stagePlan(version, files, prefix = '') {
  if (!VERSION.test(version)) throw new Error(`not a version: ${version}`);
  return files.filter((f) => !f.startsWith('.')).sort((a, b) => FEED.test(a) - FEED.test(b)).map((name) => ({ name, key: `${prefix}${version}/${name}`, cache: cacheControl(name) }));
}

function promotePlan(version, keys) {
  if (!VERSION.test(version)) throw new Error(`not a version: ${version}`);
  const names = keys.filter((k) => k.startsWith(`${version}/`)).map((k) => k.slice(version.length + 1)).filter((n) => n && !n.includes('/'));
  const feed = names.filter((n) => FEED.test(n));
  if (!feed.length) throw new Error(`${version} has no latest*.yml staged; stage it first`);
  // Installers first, feed files last: an app never reads a feed that names
  // a file not there yet.
  return [...names.filter((n) => !FEED.test(n)), ...feed].map((name) => ({ from: `${version}/${name}`, to: name, cache: cacheControl(name) }));
}

function main([cmd, version, dir], run) {
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
  } else if (cmd === 'promote') {
    const listing = aws(cfg, ['ls', `s3://${cfg.bucket}/${version}/`], run);
    const keys = listing.split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean).map((n) => `${version}/${n}`);
    for (const c of promotePlan(version, keys)) {
      console.log(`R2: ${c.from} → ${c.to}`);
      aws(cfg, ['cp', `s3://${cfg.bucket}/${c.from}`, `s3://${cfg.bucket}/${c.to}`, '--cache-control', c.cache, '--metadata-directive', 'REPLACE', '--only-show-errors'], run);
    }
  } else {
    throw new Error('usage: release-r2.js stage <version> <dir> | stage-beta <version> <dir> | promote <version>');
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) { console.error(`R2: ${err.message}`); process.exit(1); }
}

module.exports = { stagePlan, promotePlan, cacheControl, config, main };
