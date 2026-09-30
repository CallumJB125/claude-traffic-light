// Reads electron-builder's latest*.yml update feeds (version, files, sha512)
// and picks the right installer for a system. UMD: the download page loads it,
// and a Node test checks it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlexiformFeed = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Only the few keys these feeds use; not a general YAML parser.
  function parseFeed(text) {
    if (typeof text !== 'string' || text.length > 200000) return null;
    const out = { version: null, releaseDate: null, files: [] };
    let cur = null;
    let inFiles = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const top = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      if (top) {
        inFiles = top[1] === 'files';
        cur = null;
        if (top[1] === 'version') out.version = unquote(top[2]);
        else if (top[1] === 'releaseDate') out.releaseDate = unquote(top[2]);
        continue;
      }
      if (!inFiles) continue;
      const item = /^\s*-\s+url:\s*(.+)$/.exec(line);
      if (item) { cur = { url: unquote(item[1]), sha512: null, size: null }; out.files.push(cur); continue; }
      const kv = /^\s+([A-Za-z0-9]+):\s*(.+)$/.exec(line);
      if (kv && cur) { if (kv[1] === 'sha512') cur.sha512 = unquote(kv[2]); else if (kv[1] === 'size') cur.size = Number(kv[2]) || null; }
    }
    return out.version && /^[0-9A-Za-z.+-]{1,40}$/.test(out.version) && out.files.length ? out : null;
  }
  function unquote(v) { return String(v).trim().replace(/^['"]|['"]$/g, ''); }

  const KINDS = [
    { re: /-arm64\.dmg$/i, os: 'mac', arch: 'arm64', label: 'Apple silicon (.dmg)' },
    { re: /\.dmg$/i, os: 'mac', arch: 'x64', label: 'Intel (.dmg)' },
    { re: /\.exe$/i, os: 'win', arch: 'x64', label: 'Installer (.exe)' },
    { re: /\.AppImage$/i, os: 'linux', arch: 'x64', label: 'AppImage' },
    { re: /\.deb$/i, os: 'linux', arch: 'x64', label: 'Debian package (.deb)' },
  ];
  // Every installer in a feed, with an absolute URL on the feed's own host.
  // A file that points anywhere else is ignored.
  function installers(feed, base) {
    if (!feed) return [];
    const root = new URL(`${base.replace(/\/+$/, '')}/`);
    const out = [];
    for (const f of feed.files) {
      const kind = KINDS.find((k) => k.re.test(f.url));
      if (!kind) continue;
      let url;
      try { url = new URL(f.url, root); } catch { continue; }
      if (url.origin !== root.origin) continue;
      out.push({ ...kind, name: decodeURIComponent(url.pathname.split('/').pop()), url: url.href, size: f.size, sha512: f.sha512, version: feed.version });
    }
    return out;
  }
  const FEEDS = { mac: 'latest-mac.yml', win: 'latest.yml', linux: 'latest-linux.yml' };
  const human = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
  return { parseFeed, installers, FEEDS, human, KINDS };
});
