// Builds the static site into site/dist (Cloudflare Pages: build command
// `npm run build:site`, output directory `site/dist`). No bundler: pages are
// HTML with {{placeholders}} filled from brand.js (the one place the name and
// URLs live), partials are spliced in, asset links get a content hash, and the
// real pixel rig (rig.js, motion.js, the characters) is copied in from the app
// so the hero is the actual widget, not a picture of it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Brand = require('../brand.js');
const QR = require('./src/assets/qr.js');
// what is live; flip a flag when the thing ships and rebuild
const LIVE_FILE = JSON.parse(fs.readFileSync(path.join(__dirname, 'site.config.json'), 'utf8'));

const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');
const ROOT = path.join(__dirname, '..');

const APP_FILES = ['brand.js', 'rig.js', 'rig.css', 'motion.js', 'characters/contract.js', 'characters/builtin/core.js'];

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}
const hashOf = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lookup = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

function build({ live } = {}) {
  const LIVE = { ...LIVE_FILE, ...live };
  rmrf(DIST);
  fs.mkdirSync(DIST, { recursive: true });
  copyDir(path.join(SRC, 'assets'), path.join(DIST, 'assets'));
  for (const f of APP_FILES) {
    const to = path.join(DIST, 'assets', 'app', f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), to);
  }
  const partials = {};
  for (const f of fs.readdirSync(path.join(SRC, 'partials'))) partials[f.replace(/\.html$/, '')] = fs.readFileSync(path.join(SRC, 'partials', f), 'utf8');

  const pages = [];
  for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.html'))) {
    let html = fs.readFileSync(path.join(SRC, f), 'utf8');
    const m = /^<!--page (\{.*?\})-->\s*/s.exec(html);
    const meta = m ? JSON.parse(m[1]) : {};
    if (m) html = html.slice(m[0].length);
    const slug = f === 'index.html' ? '' : f.replace(/\.html$/, '');
    meta.path = slug ? `/${slug}` : '/';
    meta.canonical = `${Brand.urls.site}${slug ? `/${slug}` : '/'}`;
    meta.contact = Brand.email('support');
    const ctx = { brand: Brand, page: meta };
    // partials first (they carry placeholders too), then placeholders
    html = html.replace(/\{\{include:([a-z-]+)\}\}/g, (_, n) => { if (!partials[n]) throw new Error(`${f}: no partial ${n}`); return partials[n]; });
    html = html.replace(/\{\{asset:([^}]+)\}\}/g, (_, p) => {
      const file = path.join(DIST, p);
      if (!fs.existsSync(file)) throw new Error(`${f}: no asset ${p}`);
      return `/${p}?v=${hashOf(file)}`;
    });
    // {{qr:phone}} becomes an inline QR code for that brand URL; {{live:phone}}...{{/live}} keeps
    // its content only when site.config.json says the thing is live
    html = html.replace(/\{\{qr:([a-z]+)\}\}/g, (_, k) => { if (!Brand.urls[k]) throw new Error(`${f}: no url ${k}`); return QR.toSvg(Brand.urls[k], { label: `QR code for ${Brand.urls[k]}`, dark: '#15171c', light: '#ffffff' }); });
    html = html.replace(/\{\{live:([a-zA-Z]+)\}\}([\s\S]*?)\{\{\/live\}\}/g, (_, k, inner) => (LIVE[k] ? inner : ''));
    html = html.replace(/\{\{notlive:([a-zA-Z]+)\}\}([\s\S]*?)\{\{\/notlive\}\}/g, (_, k, inner) => (LIVE[k] ? '' : inner));
    html = html.replace(/\{\{(raw:)?([a-zA-Z.]+)\}\}/g, (_, raw, key) => {
      const v = lookup(ctx, key);
      if (v == null || typeof v === 'object') throw new Error(`${f}: no value for {{${key}}}`);
      return raw ? String(v) : esc(v);
    });
    // the nav link to this page says so
    html = html.replace(new RegExp(`(<a href="${meta.path}")(?= |>)`), '$1 aria-current="page"');
    fs.writeFileSync(path.join(DIST, f), html);
    if (!meta.noindex) pages.push(meta);
  }

  fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${Brand.urls.site}/sitemap.xml\n`);
  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `  <url><loc>${p.canonical}</loc></url>`).join('\n')}\n</urlset>\n`);
  // Long cache for fingerprinted assets and fonts; pages revalidate.
  fs.writeFileSync(path.join(DIST, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${Brand.urls.downloads} ${Brand.urls.updates.split('/').slice(0, 3).join('/')}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/*.html
  Cache-Control: public, max-age=0, must-revalidate
`);
  return { pages: pages.length };
}

if (require.main === module) {
  const r = build();
  console.log(`[site] built ${r.pages} pages into site/dist`);
}
module.exports = { build, DIST };
