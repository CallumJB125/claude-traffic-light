const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'site', 'src', 'install.sh');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// minimal stored (uncompressed) zip: entries are [name, Buffer]
function zip(entries) {
  const parts = []; const central = []; let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(zlib.crc32(data), 14);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(zlib.crc32(data), 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    parts.push(h, n, data); central.push(c, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const appZip = (marker) => zip([
  ['Plexiform.app/Contents/Info.plist', Buffer.from('CFBundleIdentifier=dev.plexiform.app\n')],
  ['Plexiform.app/Contents/MacOS/Plexiform', Buffer.from(marker)],
]);

// Serves /releases?per_page=1 (newest, maybe a pre-release) and /releases/latest (stable).
async function fixture(t, { badSums = false, sumsMissing = false } = {}) {
  const files = {
    '/dl/beta/Plexiform-2.0.0-beta.1-mac-arm64.zip': appZip('beta-arm'),
    '/dl/beta/Plexiform-2.0.0-beta.1-mac-x64.zip': appZip('beta-x64'),
    '/dl/beta/Plexiform-2.0.0-beta.1-linux-x86_64.AppImage': Buffer.from('beta-appimage'),
    '/dl/stable/Plexiform-1.0.1-mac-arm64.zip': appZip('stable-arm'),
  };
  const sumsFor = (dir) => Buffer.from(Object.entries(files).filter(([k]) => k.startsWith(dir))
    .map(([k, v]) => `${badSums ? '0'.repeat(64) : sha(v)}  ${path.basename(k)}`).join('\n') + '\n');
  files['/dl/beta/SHA256SUMS.txt'] = sumsFor('/dl/beta');
  files['/dl/stable/SHA256SUMS.txt'] = sumsFor('/dl/stable');
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const base = `http://127.0.0.1:${server.address().port}`;
    const release = (dir) => ({ draft: false, assets: Object.keys(files)
      .filter((k) => k.startsWith(dir) && !(sumsMissing && k.endsWith('SHA256SUMS.txt')))
      .map((k) => ({ name: path.basename(k), browser_download_url: base + k })) });
    if (req.url === '/releases?per_page=1') return res.end(JSON.stringify([release('/dl/beta')]));
    if (req.url === '/releases/latest') return res.end(JSON.stringify(release('/dl/stable')));
    if (files[req.url]) return res.end(files[req.url]);
    res.statusCode = 404; res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-install-'));
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const shims = path.join(root, 'shims'); fs.mkdirSync(shims);
  const shim = (name, body) => { fs.writeFileSync(path.join(shims, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  const log = path.join(root, 'calls.log');
  const realCurl = require('child_process').execFileSync('/bin/sh', ['-c', 'command -v curl']).toString().trim();
  // curl may only talk to the fake server
  shim('curl', `for a in "$@"; do case "$a" in http*) case "$a" in http://127.0.0.1:*) ;; *) echo "BLOCKED $a" >> "${log}"; exit 7;; esac;; esac; done\nexec ${realCurl} "$@"`);
  shim('uname', 'if [ "$1" = -s ]; then echo "$FAKE_OS"; else echo "$FAKE_CPU"; fi');
  shim('osascript', `echo "osascript $*" >> "${log}"`);
  shim('open', `echo "open $*" >> "${log}"`);
  shim('pgrep', 'exit 1');
  shim('codesign', 'exit 0');
  shim('xattr', `echo "xattr $*" >> "${log}"`);
  shim('plutil', 'sed -n "s/^CFBundleIdentifier=//p" "$6"');
  shim('ditto', 'if [ "$1" = -x ]; then unzip -q "$3" -d "$4"; else cp -R "$1" "$2"; fi');
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home), { recursive: true });
  const apps = path.join(root, 'Applications');
  const run = (env = {}) => new Promise((resolve) => {
    execFile('/bin/sh', [SCRIPT], {
      env: { PATH: `${shims}:/usr/bin:/bin`, HOME: home, TMPDIR: root, PLEXIFORM_API_BASE: `http://127.0.0.1:${server.address().port}`,
        PLEXIFORM_APPLICATIONS_DIR: apps, FAKE_OS: 'Darwin', FAKE_CPU: 'arm64', ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr, hits, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' }));
  });
  return { run, root, home, apps };
}
const installed = (apps) => fs.readFileSync(path.join(apps, 'Plexiform.app/Contents/MacOS/Plexiform'), 'utf8');

test('install.sh: macOS success path installs the newest release into the chosen folder and opens it', async (t) => {
  const f = await fixture(t);
  const r = await f.run();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(installed(f.apps), 'beta-arm');
  assert.match(r.log, /xattr -dr com\.apple\.quarantine/);
  assert.match(r.log, /open .*Applications\/Plexiform\.app/);
  assert.match(r.stdout, /SHA-256 verified/);
  assert.match(r.stdout, /Uninstall/);
  assert.ok(!/BLOCKED/.test(r.log), 'nothing but the fake server was contacted');
});

test('install.sh: an existing app is moved to the Trash, not deleted', async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.apps, 'Plexiform.app'), { recursive: true });
  fs.writeFileSync(path.join(f.apps, 'Plexiform.app/old.txt'), 'old');
  const r = await f.run();
  assert.equal(r.code, 0, r.stderr);
  const trash = fs.readdirSync(path.join(f.home, '.Trash'));
  assert.equal(trash.length, 1);
  assert.match(trash[0], /^Plexiform-\d{8}-\d{6}\.app$/);
  assert.equal(fs.readFileSync(path.join(f.home, '.Trash', trash[0], 'old.txt'), 'utf8'), 'old');
  assert.equal(installed(f.apps), 'beta-arm');
});

test('install.sh: a checksum mismatch installs nothing and fails', async (t) => {
  const f = await fixture(t, { badSums: true });
  const r = await f.run();
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /SHA-256 mismatch/);
  assert.ok(!fs.existsSync(f.apps), 'applications dir untouched');
  assert.ok(!/open /.test(r.log));
});

test('install.sh: a release without SHA256SUMS.txt fails closed', async (t) => {
  const f = await fixture(t, { sumsMissing: true });
  const r = await f.run();
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /SHA256SUMS\.txt/);
  assert.ok(!fs.existsSync(f.apps));
});

test('install.sh: arch selection picks the Intel zip on x86_64', async (t) => {
  const f = await fixture(t);
  const r = await f.run({ FAKE_CPU: 'x86_64' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(installed(f.apps), 'beta-x64');
});

test('install.sh: stable channel uses the latest non-pre-release; default includes pre-releases', async (t) => {
  const f = await fixture(t);
  const stable = await f.run({ PLEXIFORM_CHANNEL: 'stable' });
  assert.equal(stable.code, 0, stable.stderr);
  assert.equal(installed(f.apps), 'stable-arm');
  assert.ok(stable.hits.includes('/releases/latest'));
  const beta = await f.run();
  assert.equal(beta.code, 0, beta.stderr);
  assert.equal(installed(f.apps), 'beta-arm');
});

test('install.sh: Linux installs the AppImage under ~/.local/bin, executable', async (t) => {
  const f = await fixture(t);
  const r = await f.run({ FAKE_OS: 'Linux', FAKE_CPU: 'x86_64' });
  assert.equal(r.code, 0, r.stderr);
  const file = path.join(f.home, '.local/bin/plexiform.AppImage');
  assert.equal(fs.readFileSync(file, 'utf8'), 'beta-appimage');
  assert.ok(fs.statSync(file).mode & 0o100);
  assert.match(r.stdout, /\.deb/);
  assert.ok(!fs.existsSync(f.apps));
});

test('install.sh: unsupported platform and dry run touch nothing', async (t) => {
  const f = await fixture(t);
  const bad = await f.run({ FAKE_OS: 'Linux', FAKE_CPU: 'aarch64' });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /no build for/);
  const dry = await f.run({ PLEXIFORM_DRY_RUN: '1' });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /dry run: would install Plexiform-2\.0\.0-beta\.1-mac-arm64\.zip/);
  assert.ok(!fs.existsSync(f.apps));
  assert.equal(dry.log, '');
});

test('install.sh: no sudo, no eval, and the build ships it untouched', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/\bsudo\b|\beval\b/.test(src.replace(/^#.*$/gm, '')));
  const { build, DIST } = require('../site/build.js');
  try {
    build();
    assert.equal(fs.readFileSync(path.join(DIST, 'install.sh'), 'utf8'), src);
    assert.match(fs.readFileSync(path.join(DIST, '_headers'), 'utf8'), /\/install\.sh\n  Content-Type: text\/plain/);
  } finally { build(); }
});
