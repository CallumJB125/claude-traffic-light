// One identity, Plexiform / dev.plexiform.app, everywhere the installed app,
// its installers, its updater and its signed releases name it; and no stray
// old name (Claude Buddy, claude-buddy, com.callumbaker) left in the source
// except where it is kept on purpose.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const Brand = require('../brand.js');
const pkg = require('../package.json');
const config = require('../electron-builder.config.js');
const DesktopShell = require('../src/desktop-shell.js');
const Verify = require('../src/updater/verify.js');
const Sign = require('../scripts/release-sign.js');
const Rename = require('../src/rename-migration.js');
const { strictJSON } = require('../src/plugins/index-verify');

test('identity: package.json, the builder config, brand.js and the desktop shell agree on Plexiform / dev.plexiform.app', () => {
  assert.equal(Brand.name, 'Plexiform');
  assert.equal(Brand.appId, 'dev.plexiform.app');
  // Electron names userData and the safeStorage Keychain item after the top-level productName.
  assert.equal(pkg.productName, Brand.name);
  assert.equal(pkg.build.productName, Brand.name);
  assert.equal(config.productName, Brand.name);
  assert.equal(pkg.build.appId, Brand.appId);
  assert.equal(config.appId, Brand.appId);
  assert.equal(DesktopShell.APP_ID, Brand.appId);
  // Plexiform.app/Contents/MacOS/Plexiform and Plexiform.exe follow productName; Linux's binary is plexiform.
  for (const p of ['mac', 'win', 'linux']) assert.equal(config[p]?.productName, undefined, p);
  assert.equal(config.mac.executableName, undefined);
  assert.equal(config.win.executableName, undefined);
  assert.equal(config.linux.executableName, 'plexiform');
  assert.deepEqual(pkg.build.mac.protocols, [{ name: Brand.name, schemes: [Brand.scheme, ...Brand.legacySchemes] }]);
  for (const [k, v] of Object.entries(pkg.build.mac.extendInfo)) if (/UsageDescription$/.test(k)) assert.match(v, /^Plexiform /, k);
  const plist = fs.readFileSync(path.join(ROOT, 'native', 'voice', 'Info.plist'), 'utf8');
  assert.match(plist, new RegExp(`<key>CFBundleIdentifier</key>\\s*<string>${Brand.appId.replace(/\./g, '\\.')}\\.listen</string>`));
  // The old identity is only the migration's, and is not the new one.
  assert.notEqual(Rename.OLD.appId, Brand.appId);
  assert.notEqual(Rename.OLD.userDataName, pkg.productName);
});

test('identity: the updater, the feed and the signed manifest say plexiform', () => {
  assert.equal(Verify.PRODUCT, Brand.name.toLowerCase());
  assert.equal(config.publish[0].url, Brand.urls.updates);
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'updater', 'index.js'), 'utf8'), /feedBase: Brand\.urls\.updates/);
  for (const a of [config.artifactName, config.nsis.artifactName, config.deb.artifactName, config.appImage.artifactName]) assert.ok(a.startsWith(`${Brand.name}-`), a);
  // What release-sign writes is what the app's verify accepts, and no other product.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-identity-'));
  const zip = 'zip-bytes';
  fs.writeFileSync(path.join(dir, 'Plexiform-1.0.0-mac-arm64.zip'), zip);
  const sha = crypto.createHash('sha512').update(zip).digest('base64');
  fs.writeFileSync(path.join(dir, 'latest-mac.yml'), `version: 1.0.0\nfiles:\n  - url: Plexiform-1.0.0-mac-arm64.zip\n    sha512: ${sha}\n    size: ${zip.length}\n`);
  const m = Sign.buildManifest({ dir, channel: 'stable', version: '1.0.0' });
  assert.equal(m.product, 'plexiform');
  const key = crypto.generateKeyPairSync('ed25519');
  const keyring = Verify.loadKeyring({ stable: [key.publicKey.export({ type: 'spki', format: 'pem' })], beta: [] });
  const bytes = Buffer.from(JSON.stringify(m));
  const sig = crypto.sign(null, bytes, key.privateKey).toString('base64');
  assert.equal(Verify.openManifest(bytes, sig, keyring, { channel: 'stable' }).product, 'plexiform');
  const old = Buffer.from(JSON.stringify({ ...m, product: 'claude-buddy' }));
  assert.throws(() => Verify.openManifest(old, crypto.sign(null, old, key.privateKey).toString('base64'), keyring, { channel: 'stable' }), /not plexiform/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── no stray old name ───────────────────────────────────────────────────────
const OLD_NAME = /claude(?:%20|[ _-])?buddy|com\.callumbaker/i;
// Kept everywhere: the claudebuddy:// scheme old links use, and the dev-only
// CLAUDE_BUDDY_* environment switches. The bare scheme name is allowed only
// where it is declared (brand.js's LEGACY_SCHEMES and its mirrors).
const ALLOW_ANYWHERE = [/claudebuddy:\/\//g, /CLAUDE_BUDDY_[A-Z_]+/g];
// Kept on purpose, per file.
const ALLOW = {
  'src/rename-migration.js': [/^.*$/g], // the old identity, to migrate from
  // Byte-preserved imported catalogue provenance and an external product's
  // original description; neither identifies the Plexiform application.
  'build/plugin-catalog/catalog.json': [
    /"generator":"claude-buddy-catalog\/0\.1"/g,
    /"description":"Onboard a Code-with-Claude Makers Cardputer with one \/maker-setup command — clones the build-with-claude repo, flashes UIFlow firmware, and installs the Claude Buddy app bundle\."/g,
  ],
  'src/scrub.js': [/'Claude Buddy\.app'|'Claude Buddy'|'claude-buddy'/g], // logs from old installs scrub the same
  'src/leftover-shim.js': [/# claude-buddy router/g], // markers old installs wrote into ~/.zshrc
  'setup.js': [/'claude-buddy-setup'/g], // the setup file format's tag, carried by exported files
  'mcp-install.js': [/'claude-buddy'/g], // the MCP server's name: not renamed yet, so Claude's tool names stay
  'mcp-server.js': [/name: 'claude-buddy'/g],
  'MCP.md': [/claude-buddy/g],
  'settings.html': [/<code>claude-buddy<\/code>/g],
  'PRIVACY.md': [/`claude-buddy`/g, /"Claude Buddy Safe Storage"/g], // the MCP entry and the old data folder's name; the old Keychain item
  'package.json': [/"name":\s*"claude-buddy"/g], // the npm name: the .deb package and updater cache keep it; the protocol exception is checked structurally below
  'package-lock.json': [/"name": "claude-buddy"/g],
  'remote/package.json': [/@claude-buddy\/remote/g],
  'brand.js': [/'Claude Buddy'/g, /LEGACY_SCHEMES = \['claudebuddy'\]/g], // formerNames; the old links' scheme
  'README.md': [/Formerly \*Claude Buddy\*/g],
  'site/src/partials/footer.html': [/Formerly Claude Buddy\./g],
  'main.js': [/rename from Claude Buddy/g],
  'docs/RELEASING.md': [/`com\.callumbaker\.claude-buddy`|`claude-buddy`/g], // what a pre-rename build was
  'board/shared/brand.js': [/legacyDeepLinkScheme: 'claudebuddy'/g], // brand.js's LEGACY_SCHEMES, for the board
  'board/CONTRACT.md': [/\.\.\/claude-buddy-board-[\w-]+\.md/g], // design documents outside the repo
};
const TEXT = /\.(?:js|mjs|cjs|json|html|css|md|sh|nsh|plist|swift|ya?ml|toml|txt|entitlements)$/;
const SKIP = /(?:^|\/)(?:node_modules|test|tests|test-visual|test-results|\.omc|\.git|dist|out)\//;

function sourceFiles() {
  let list;
  try {
    list = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    list = [];
    const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const r = d ? `${d}/${e.name}` : e.name; if (e.isDirectory()) { if (!SKIP.test(`${r}/`)) walk(r); } else list.push(r); } };
    walk('');
  }
  return list.filter((f) => TEXT.test(f) && !SKIP.test(f) && fs.existsSync(path.join(ROOT, f)));
}

function scanIdentitySource(f, content, usedAllow = new Set()) {
  if (f === 'package.json') {
    const parsed = strictJSON(Buffer.from(content), 1024 * 1024);
    assert.deepEqual(parsed.build.mac.protocols, [{ name: Brand.name, schemes: [Brand.scheme, ...Brand.legacySchemes] }]);
    // npm version pretty-prints the array. Permit only the unique, exact
    // protocol tuple; another matching tuple or legacy value is still refused.
    const schemes = /"schemes"\s*:\s*\[\s*"plexiform"\s*,\s*"claudebuddy"\s*\]/g;
    assert.equal([...content.matchAll(schemes)].length, 1, 'one deliberate legacy protocol tuple');
    content = content.replace(schemes, tuple => tuple.replace('"claudebuddy"', '"legacy-protocol"'));
    usedAllow.add(f);
  }
  const stray = [];
  content.split('\n').forEach((line, i) => {
    if (!OLD_NAME.test(line)) return;
    let rest = line;
    for (const re of ALLOW_ANYWHERE) rest = rest.replace(re, '');
    for (const re of ALLOW[f] || []) {
      const next = rest.replace(re, '');
      if (next !== rest) usedAllow.add(f);
      rest = next;
    }
    if (OLD_NAME.test(rest)) stray.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
  });
  return stray;
}

test('identity scan accepts compact and pretty beta metadata but still rejects stray legacy values', () => {
  const fixture = { name: 'claude-buddy', version: '1.0.2-beta.50', build: { mac: { protocols: [{ name: Brand.name, schemes: [Brand.scheme, ...Brand.legacySchemes] }] } } };
  for (const indent of [undefined, 2]) {
    assert.deepEqual(scanIdentitySource('package.json', JSON.stringify(fixture, null, indent)), []);
    for (const extra of [{ description: 'Claude Buddy preview' }, { debugScheme: 'claudebuddy' }, { appId: 'com.callumbaker.old' }]) {
      assert.equal(scanIdentitySource('package.json', JSON.stringify({ ...fixture, ...extra }, null, indent)).length, 1);
    }
  }
  const wrong = { ...fixture, build: { mac: { protocols: [{ name: 'Wrong product', schemes: [Brand.scheme, ...Brand.legacySchemes] }] } } };
  assert.throws(() => scanIdentitySource('package.json', JSON.stringify(wrong)), /Expected values to be strictly deep-equal/);
  assert.throws(() => scanIdentitySource('package.json', JSON.stringify({ ...fixture, extra: { schemes: [Brand.scheme, ...Brand.legacySchemes] } })), /one deliberate legacy protocol tuple/);
  assert.equal(scanIdentitySource('other.js', 'const label = "claudebuddy";').length, 1);
});

test('no stray Claude Buddy / claude-buddy / com.callumbaker outside the deliberate migration constants and old-link schemes', () => {
  const files = sourceFiles();
  assert.ok(files.includes('main.js') && files.includes('brand.js') && files.includes('src/updater/mac-swap.js'), 'the scan sees the source tree');
  const stray = [];
  const usedAllow = new Set();
  for (const f of files) {
    stray.push(...scanIdentitySource(f, fs.readFileSync(path.join(ROOT, f), 'utf8'), usedAllow));
  }
  assert.deepEqual(stray, [], `old name left in:\n${stray.join('\n')}`);
  // An allow-list entry nothing needs any more goes.
  const unused = Object.keys(ALLOW).filter((f) => files.includes(f) && !usedAllow.has(f));
  assert.deepEqual(unused, [], `allow-list entries with nothing to allow: ${unused.join(', ')}`);
});
