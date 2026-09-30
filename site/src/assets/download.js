// The download page: detect the system, read the update feeds from the
// download host, and show what is actually published. Nothing is invented: a
// platform with no feed says so.
(function () {
  const F = window.PlexiformFeed;
  const card = document.getElementById('dl');
  if (!card || !F) return;
  const base = card.dataset.feed;
  const fallback = card.dataset.fallback.replace(/\/download$/, '').replace(/\/releases\/latest.*$/, '/releases/latest');
  const os = window.__os || 'other';
  const status = document.getElementById('dl-status');
  const primary = document.getElementById('dl-primary');
  const meta = document.getElementById('dl-meta');
  const NAME = { mac: 'Mac', win: 'Windows', linux: 'Linux' };

  const el = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v); e.append(...kids.filter((k) => k != null)); return e; };
  async function read(kind) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 7000);
    try {
      const r = await fetch(`${base}/${F.FEEDS[kind]}`, { signal: ctl.signal, cache: 'no-cache' });
      if (!r.ok) return null;
      return F.installers(F.parseFeed(await r.text()), base);
    } catch { return null; } finally { clearTimeout(t); }
  }

  (async () => {
    const [mac, win, linux] = await Promise.all([read('mac'), read('win'), read('linux')]);
    const by = { mac, win, linux };
    // the list of everything published
    for (const row of document.querySelectorAll('#dl-all li')) {
      const k = row.dataset.os;
      const list = by[k];
      const right = row.lastElementChild;
      right.replaceChildren();
      right.classList.remove('muted');
      if (!list || !list.length) { right.classList.add('muted'); right.textContent = 'Not published yet'; continue; }
      const links = list.map((a) => el('a', { href: a.url, download: '' }, `${a.label}${a.size ? `, ${F.human(a.size)}` : ''}`));
      links.forEach((l, i) => { if (i) right.append(' · '); right.append(l); });
      row.setAttribute('data-version', list[0].version);
      if (k === os) row.setAttribute('data-current', '');
    }
    const mine = by[os];
    if (!mine || !mine.length) {
      status.textContent = NAME[os] ? `${NAME[os]} builds aren't published yet.` : 'Pick your system below.';
      primary.replaceChildren(el('a', { class: 'btn', href: fallback }, 'See releases on GitHub'));
      return;
    }
    // Apple silicon first; Intel stays one line below. Chromium can say which.
    let pick = mine[0];
    if (os === 'mac' && navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      try { const h = await navigator.userAgentData.getHighEntropyValues(['architecture']); if (h.architecture === 'x86') pick = mine.find((a) => a.arch === 'x64') || pick; } catch { /* keep the default */ }
    }
    status.textContent = `${'Version'} ${pick.version} for ${NAME[os]}`;
    primary.replaceChildren(el('a', { class: 'btn btn-os', href: pick.url, download: '' }, `Download ${pick.name}`, pick.size ? el('small', {}, F.human(pick.size)) : null));
    meta.replaceChildren(pick.sha512 ? el('span', {}, 'SHA-512 (base64): ', el('code', {}, pick.sha512)) : '');
  })();
})();
