#!/usr/bin/env node
// Compiles native/voice/buddy-listen.swift (push-to-talk speech-to-text) into
// native/voice/build/buddy-listen, with its Info.plist (the microphone and
// speech usage strings) embedded. Runs before `npm run dist`. Off macOS, or
// without the Swift toolchain, it warns and exits 0: the app still builds and
// voice reports itself unavailable.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'native', 'voice');
const out = path.join(dir, 'build', 'buddy-listen');

if (process.platform !== 'darwin') {
  console.warn('[voice-helper] macOS only; skipped');
  process.exit(0);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
try {
  execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '5',
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', path.join(dir, 'Info.plist'),
    path.join(dir, 'buddy-listen.swift'), '-o', out], { stdio: 'inherit' });
  console.log(`[voice-helper] built ${out}`);
} catch (err) {
  console.warn(`[voice-helper] not built (${err.message}); voice will be unavailable`);
}
