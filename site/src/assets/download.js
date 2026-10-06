// The download page: the one-line installer's copy button, and the manual
// download links, read from the public GitHub releases API in the browser.
// Nothing is invented: if the API cannot be read, the page links to the
// releases page instead.
(function () {
  const card = document.getElementById('dl');
  if (!card) return;
  const api = card.dataset.api;
  const fallback = card.dataset.fallback;
  const windowsEnabled = card.dataset.windows === 'true';
  const os = window.__os || 'other';
  const status = document.getElementById('dl-status');
  const el = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v); e.append(...kids.filter((k) => k != null)); return e; };

  const copy = document.getElementById('copy-install');
  if (copy) copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(document.getElementById('install-cmd').textContent); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy it by hand'; }
  });

  const KINDS = [
    ['mac', /-mac-arm64\.dmg$/, 'Apple silicon .dmg'], ['mac', /-mac-arm64\.zip$/, 'Apple silicon .zip'],
    ['mac', /-mac-x64\.dmg$/, 'Intel .dmg'], ['mac', /-mac-x64\.zip$/, 'Intel .zip'],
    ['linux', /\.AppImage$/, 'AppImage'], ['linux', /\.deb$/, '.deb'],
    ['win', /\.exe$/, 'Installer'],
  ];
  const human = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.ceil(n / 1e3)} KB`);

  (async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 7000);
    let release = null;
    try {
      const r = await fetch(`${api}/releases?per_page=10`, { signal: ctl.signal, headers: { Accept: 'application/vnd.github+json' } });
      if (r.ok) release = (await r.json()).find((x) => !x.draft) || null;
    } catch { /* fall through to the releases link */ } finally { clearTimeout(t); }

    const rows = document.querySelectorAll('#dl-all li');
    if (!release) {
      status.replaceChildren('Could not load the latest release. ', el('a', { href: fallback }, 'Browse published GitHub releases'));
      for (const row of rows) { const right = row.lastElementChild; right.classList.add('muted'); right.replaceChildren(row.dataset.os === 'win' && !windowsEnabled ? 'Unavailable pending runtime acceptance' : el('a', { href: fallback }, 'GitHub releases')); }
      return;
    }
    status.replaceChildren(`Latest ${release.prerelease ? 'public preview' : 'release'}: ${release.tag_name.replace(/^v/, '')}. `, el('a', { href: release.html_url }, 'Release notes and checksums'));
    for (const row of rows) {
      const k = row.dataset.os;
      const right = row.lastElementChild;
      if (k === 'win' && !windowsEnabled) continue;
      const links = KINDS.filter(([kind]) => kind === k).map(([, re, label]) => [release.assets.find((a) => re.test(a.name)), label]).filter(([a]) => a);
      if (!links.length) { right.classList.add('muted'); right.replaceChildren(el('a', { href: release.html_url }, 'See the release')); continue; }
      right.classList.remove('muted');
      right.replaceChildren();
      links.forEach(([a, label], i) => { if (i) right.append(' · '); right.append(el('a', { href: a.browser_download_url }, `${label}, ${human(a.size)}`)); });
      if (k === os) row.setAttribute('data-current', '');
    }
  })();
})();
