'use strict';
// Development artifacts can be reviewed locally. This command has no publish,
// upload, live install or production-signing path. A release cannot opt into dev
// through an environment variable or fallback after failed signing.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (process.platform !== 'darwin') throw Error('The Session Keeper preview currently requires macOS.');
if (!process.argv.includes('--development') || process.env.PLEXIFORM_REQUIRE_SIGNING === '1') throw Error('Public Terminal distribution is disabled until Developer ID, notarization and native acceptance pass. Use --development for an explicitly labeled local preview.');
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: root, stdio: 'inherit', ...options });
const scratch = path.resolve(root, '../terminal-native-build');
const output = path.join(root, 'native/keeper-build'); fs.mkdirSync(output, { recursive: true });
run('swift', ['build', '--package-path', 'native/keeper', '--scratch-path', scratch, '-c', 'release', '-Xswiftc', '-DKEEPER_DEV']);
const bundle = path.join(output, 'Plexiform Session Keeper.app');
const mac = path.join(bundle, 'Contents/MacOS'); fs.mkdirSync(mac, { recursive: true });
fs.copyFileSync(path.join(scratch, 'release/PlexiformKeeper'), path.join(mac, 'PlexiformKeeper'));
fs.chmodSync(path.join(mac, 'PlexiformKeeper'), 0o755);
fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.plexiform.keeper</string><key>CFBundleName</key><string>Plexiform Session Keeper</string><key>CFBundleExecutable</key><string>PlexiformKeeper</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>LSBackgroundOnly</key><true/><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSSupportsAutomaticTermination</key><false/><key>NSSupportsSuddenTermination</key><false/></dict></plist>`);
run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'dev.plexiform.keeper', '--options', 'runtime', bundle]);
const info = JSON.parse(execFileSync(path.join(mac, 'PlexiformKeeper'), ['--build-info'], { encoding: 'utf8' }));
if (info.dev !== true) throw Error('Development keeper marker did not match.');
const include = process.env.PLEXIFORM_NODE_HEADERS || '/opt/homebrew/include/node';
if (!fs.existsSync(path.join(include, 'node_api.h'))) throw Error('Node-API headers are required; set PLEXIFORM_NODE_HEADERS to their directory.');
const addon = path.join(root, 'apps/terminal/native/keeper-socket/keeper-socket.node');
run('xcrun', ['clang', '-O2', '-bundle', '-undefined', 'dynamic_lookup', '-mmacosx-version-min=13.0', '-I', include, '-I', path.join(root, 'native/keeper/Support/include'), 'apps/terminal/native/keeper-socket/addon.c', 'native/keeper/Support/keeper.c', '-framework', 'Security', '-framework', 'ApplicationServices', '-o', addon]);
run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', addon]);
fs.writeFileSync(path.join(root, 'apps/terminal/manifest.json'), JSON.stringify({ development: true, team: '', keeperBuild: 1, protocol: 1 }, null, 2) + '\n');
if (!fs.existsSync(path.join(root, 'apps/terminal/node_modules/@xterm/xterm/package.json'))) throw Error('Install the pinned apps/terminal dependencies first.');
if (!process.argv.includes('--native-only')) {
  run(process.execPath, [path.join(root, 'node_modules/electron-builder/out/cli/cli.js'), '--config', 'apps/terminal/electron-builder.config.cjs', '--mac', '--arm64', '--publish', 'never'], { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
}
