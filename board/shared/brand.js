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
