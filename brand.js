// The one place the product's name, tagline, URLs and deep-link scheme live.
// Everything user-facing (windows, menus, Help, onboarding, pages, emails,
// the landing site) reads from here, so a rename is an edit to this file.
// Plain script for the renderers (window.Brand) and CommonJS for Node.
//
// Stage 1 of the rename (see .omc/plans/rename-plexiform.md): the user-facing
// name only. Bundle ids, data directories, the CLI and MCP tool names are
// Stage 2 and deliberately NOT here.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Brand = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SITE = 'https://plexiform.dev';
  const HUB = 'https://app.plexiform.dev';
  const DOMAIN = 'plexiform.dev';
  const SCHEME = 'plexiform';
  // Old links keep working: installed copies and shared links predate the rename.
  const LEGACY_SCHEMES = ['claudebuddy'];

  const brand = Object.freeze({
    name: 'Plexiform',
    // where a shorter label is wanted (tray tooltip, a narrow title bar)
    shortName: 'Plexiform',
    tagline: 'One place for every AI coding agent you run.',
    // The pixel character keeps its own name; it is not the product name.
    mascotName: 'Buddy',
    // names the product went by, for migration and "formerly" copy
    formerNames: Object.freeze(['Claude Buddy', 'Claude Traffic Light']),
    domain: DOMAIN,
    urls: Object.freeze({
      site: SITE,
      docs: `${SITE}/docs`,
      changelog: `${SITE}/changelog`,
      download: `${SITE}/download`,
      privacy: `${SITE}/privacy`,
      hub: HUB,
      // where the app looks for updates: the release host (electron-updater reads latest*.yml here)
      updates: 'https://download.plexiform.dev',
    }),
    scheme: SCHEME,
    legacySchemes: Object.freeze(LEGACY_SCHEMES),
  });

  // https://app.plexiform.dev/invite#<token>: the token rides in the fragment,
  // so it is never sent to a server or written to an access log by the page load.
  const TOKEN = /^[A-Za-z0-9._~-]{1,512}$/;
  function inviteUrl(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new Error('invite token has characters a link cannot carry');
    return `${HUB}/invite#${token}`;
  }
  // plexiform://add?id=otter, in the current scheme
  function deepLink(action, params = {}) {
    if (typeof action !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(action)) throw new Error('a deep link action is lowercase letters, digits and dashes');
    const q = Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
    return `${SCHEME}://${action}${q ? `?${q}` : ''}`;
  }
  // Accepts the current scheme and the legacy ones; anything else is null.
  // → { action, params, legacy } with params holding only string values.
  function parseDeepLink(url) {
    if (typeof url !== 'string' || url.length > 4096) return null;
    const m = /^([a-z][a-z0-9+.-]*):\/\/([a-z][a-z0-9-]{0,31})\/?(?:\?([^#]*))?(?:#.*)?$/i.exec(url.trim());
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    const legacy = LEGACY_SCHEMES.includes(scheme);
    if (scheme !== SCHEME && !legacy) return null;
    const params = Object.create(null);
    for (const pair of (m[3] || '').split('&')) {
      if (!pair) continue;
      const [k, ...rest] = pair.split('=');
      let key;
      let val;
      try { key = decodeURIComponent(k); val = decodeURIComponent(rest.join('=')); } catch { return null; }
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return null;
      params[key] = val;
    }
    return { action: m[2].toLowerCase(), params: { ...params }, legacy };
  }
  // support@plexiform.dev; only a plain local part
  function email(local) {
    if (typeof local !== 'string' || !/^[a-z][a-z0-9.+-]{0,63}$/.test(local)) throw new Error('an address needs a plain local part');
    return `${local}@${DOMAIN}`;
  }
  // "Open Plexiform…": a label with the name in it
  const label = (text) => String(text).replace(/\{name\}/g, brand.name).replace(/\{short\}/g, brand.shortName);

  return Object.freeze({ ...brand, inviteUrl, deepLink, parseDeepLink, email, label });
});
