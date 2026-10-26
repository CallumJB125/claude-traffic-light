// The product name and the user-facing identifiers that go with it, in one
// place (Stage 1 of the rename: user-facing strings only). Technical names stay
// as they are until Stage 2: BOARD_* env vars, route paths, cookie names
// (__Host-buddy_*), the bdt_ token prefix, package names.

export const BRAND = Object.freeze({
  name: 'Plexiform',
  deepLinkScheme: 'plexiform',
  legacyDeepLinkScheme: 'claudebuddy',      // older desktop builds register only this one
  downloadUrlDefault: null,                 // no public download yet: set BOARD_DOWNLOAD_URL
  supportEmail: null,
});

// Platform words, as in the app's brand.js (test/platform-words.test.js keeps the two equal).
// `platform` is a Node id; left out, the running one (process.platform, or the browser's report).
function hostPlatform() {
  if (typeof process === 'object' && process && typeof process.platform === 'string') return process.platform;
  const nav = typeof navigator === 'object' && navigator ? String(navigator.userAgentData?.platform || navigator.platform || '') : '';
  return /mac/i.test(nav) ? 'darwin' : /win/i.test(nav) ? 'win32' : 'linux';
}
// The machine is a "Mac" on macOS and a "computer" elsewhere.
export const machine = (platform = hostPlatform()) => (platform === 'darwin' ? 'Mac' : 'computer');
// ⌘K and Return on a Mac, Ctrl+K and Enter elsewhere.
export function keys(platform = hostPlatform()) {
  const mac = platform === 'darwin';
  return Object.freeze({ mod: mac ? '⌘' : 'Ctrl', combo: (key) => (mac ? `⌘${key}` : `Ctrl+${key}`), enter: mac ? 'Return' : 'Enter' });
}
