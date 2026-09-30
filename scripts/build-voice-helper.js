#!/usr/bin/env node
// Compiles native/voice/buddy-listen.swift (push-to-talk speech-to-text) into
// a universal (arm64 + x86_64) native/voice/build/buddy-listen, with its
// Info.plist (the microphone and speech usage strings) embedded. Runs before
// `npm run dist`. Off macOS, or without the Swift toolchain, it warns and
// exits 0 so the app still builds and voice reports itself unavailable;
// `--require` (CI, release builds) makes either of those a failure instead.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REQUIRE = process.argv.includes('--require');
const dir = path.join(__dirname, '..', 'native', 'voice');
const out = path.join(dir, 'build', 'buddy-listen');
// Electron's own floor for macOS; the on-device recognizer needs 10.15.
const MIN_MACOS = '12.0';

function skip(why) {
  if (REQUIRE) { console.error(`[voice-helper] ${why}`); process.exit(1); }
  console.warn(`[voice-helper] ${why}; voice will be unavailable`);
  process.exit(0);
}

if (process.platform !== 'darwin') skip('macOS only');
fs.mkdirSync(path.dirname(out), { recursive: true });
try {
  const slices = ['arm64', 'x86_64'].map((arch) => {
    const slice = `${out}-${arch}`;
    execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos${MIN_MACOS}`,
      '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', path.join(dir, 'Info.plist'),
      path.join(dir, 'buddy-listen.swift'), '-o', slice], { stdio: 'inherit' });
    return slice;
  });
  execFileSync('xcrun', ['lipo', '-create', ...slices, '-output', out], { stdio: 'inherit' });
  for (const s of slices) fs.rmSync(s, { force: true });
  console.log(`[voice-helper] built ${out} (arm64 + x86_64)`);
} catch (err) {
  skip(`not built (${err.message})`);
}
