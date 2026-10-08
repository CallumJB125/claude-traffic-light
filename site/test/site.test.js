const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Feed = require('../src/assets/feed.js');

// ── the waitlist function (an ES module for Pages; run here through vm) ────
function loadFn() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'api', 'waitlist.js'), 'utf8').replace(/export (async )?function/g, '$1function');
  const ctx = { Response, URL, URLSearchParams, JSON, Number, Promise, Date, Object, Array, String, module: { exports: {} } };
  vm.runInNewContext(`${src}\nmodule.exports = { onRequestPost, onRequest };`, ctx);
  return ctx.module.exports;
}
const kv = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; };
const post = (body, { origin = 'https://plexiform.dev', ip = '1.1.1.1', type = 'application/json' } = {}) => new Request('https://plexiform.dev/api/waitlist', { method: 'POST', headers: { 'content-type': type, origin, 'cf-connecting-ip': ip }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('waitlist: stores an email and what they use, and nothing else', async () => {
  const { onRequestPost } = loadFn();
  const WAITLIST = kv();
  const res = await onRequestPost({ request: post({ email: ' Ana@Example.com ', uses: 'Codex', extra: 'x' }), env: { WAITLIST } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const saved = JSON.parse(WAITLIST.m.get('email:ana@example.com'));
  assert.deepEqual(Object.keys(saved).sort(), ['at', 'email', 'uses']);
  assert.equal(saved.uses, 'Codex');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('waitlist: bad emails, unknown answers, big bodies and other origins are turned away', async () => {
  const { onRequestPost } = loadFn();
  const env = { WAITLIST: kv() };
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', 'a@c.com,b@d.com', '<x>@y.com', 'x'.repeat(300) + '@y.com']) assert.equal((await onRequestPost({ request: post({ email: bad }), env })).status, 400, bad);
  assert.equal((await onRequestPost({ request: post({ email: 'a@b.co', uses: '<script>' }), env })).status, 200);
  assert.equal(JSON.parse(env.WAITLIST.m.get('email:a@b.co')).uses, '', 'an unknown answer is dropped');
  assert.equal((await onRequestPost({ request: post({ email: 'a@b.co' }, { origin: 'https://evil.example' }), env })).status, 403);
  assert.equal((await onRequestPost({ request: post('x'.repeat(5000)), env })).status, 413);
  assert.equal((await onRequestPost({ request: post('{nope'), env })).status, 400);
  assert.equal((await onRequestPost({ request: post('[1]'), env })).status, 400);
});

test('waitlist: a filled honeypot gets a yes and keeps nothing; form posts work; a repeat looks the same', async () => {
  const { onRequestPost } = loadFn();
  const WAITLIST = kv();
  const env = { WAITLIST };
  const bot = await onRequestPost({ request: post({ email: 'bot@spam.com', hp: 'Acme' }), env });
  assert.equal(bot.status, 200);
  assert.equal(WAITLIST.m.has('email:bot@spam.com'), false);
  const form = await onRequestPost({ request: post('email=f%40x.io&uses=Cursor', { type: 'application/x-www-form-urlencoded' }), env });
  assert.equal(form.status, 200);
  assert.ok(WAITLIST.m.has('email:f@x.io'));
  const again = await onRequestPost({ request: post({ email: 'f@x.io' }), env });
  assert.deepEqual(await again.json(), { ok: true }, 'no way to ask who is on the list');
});

test('waitlist: five tries per ten minutes per address, and it says so when the list is not configured', async () => {
  const { onRequestPost } = loadFn();
  const env = { WAITLIST: kv() };
  for (let i = 0; i < 5; i += 1) assert.equal((await onRequestPost({ request: post({ email: `a${i}@x.io` }), env })).status, 200);
  assert.equal((await onRequestPost({ request: post({ email: 'a9@x.io' }), env })).status, 429);
  assert.equal((await onRequestPost({ request: post({ email: 'a9@x.io' }, { ip: '2.2.2.2' }), env })).status, 200, 'another address is unaffected');
  assert.equal((await onRequestPost({ request: post({ email: 'a@x.io' }), env: {} })).status, 503);
});

// ── the feed reader ─────────────────────────────────────────────────────
const YML = `version: 1.4.0
files:
  - url: Plexiform-1.4.0-arm64.dmg
    sha512: AAAA+/==
    size: 123456789
  - url: Plexiform-1.4.0.dmg
    sha512: BBBB
    size: 130000000
  - url: https://evil.example/Plexiform.dmg
    sha512: CCCC
    size: 1
path: Plexiform-1.4.0-arm64.dmg
sha512: AAAA+/==
releaseDate: '2026-10-02T10:00:00.000Z'
`;

test('feed: parses version, files, checksums and sizes from an electron-builder feed', () => {
  const f = Feed.parseFeed(YML);
  assert.equal(f.version, '1.4.0');
  assert.equal(f.releaseDate, '2026-10-02T10:00:00.000Z');
  assert.deepEqual(f.files[0], { url: 'Plexiform-1.4.0-arm64.dmg', sha512: 'AAAA+/==', size: 123456789 });
  assert.equal(f.files.length, 3);
});

test('feed: junk, oversize or version-less feeds are refused', () => {
  for (const bad of ['', 'nope', 'version: 1\n', 'files:\n  - url: a.dmg\n', null, 'x'.repeat(300000), 'version: "><script>"\nfiles:\n  - url: a.dmg\n']) assert.equal(Feed.parseFeed(bad), null);
});

test('feed: installers get absolute URLs on the feed host only, with a readable label', () => {
  const list = Feed.installers(Feed.parseFeed(YML), 'https://download.plexiform.dev');
  assert.deepEqual(list.map((a) => [a.os, a.arch, a.name]), [['mac', 'arm64', 'Plexiform-1.4.0-arm64.dmg'], ['mac', 'x64', 'Plexiform-1.4.0.dmg']]);
  assert.equal(list[0].url, 'https://download.plexiform.dev/Plexiform-1.4.0-arm64.dmg');
  assert.ok(!list.some((a) => a.url.includes('evil.example')), 'a file pointing elsewhere is dropped');
  const multi = Feed.parseFeed('version: 2.0.0\nfiles:\n  - url: Plexiform-2.0.0.AppImage\n    size: 1000\n  - url: plexiform_2.0.0_amd64.deb\n  - url: Setup.exe\n');
  assert.deepEqual(Feed.installers(multi, 'https://d.example/').map((a) => a.os + ':' + a.label), ['linux:AppImage', 'linux:Debian package (.deb)', 'win:Installer (.exe)']);
  assert.deepEqual(Feed.installers(null, 'https://d.example'), []);
  assert.equal(Feed.human(130000000), '130 MB');
});

// ── the build ───────────────────────────────────────────────────────────
test('build: every page builds from brand.js, links only to files that exist, and ships no app code but brand.js', () => {
  const { build, DIST } = require('../build.js');
  const r = build();
  assert.ok(r.pages >= 5);
  const Brand = require('../../brand.js');
  const pages = fs.readdirSync(DIST).filter((f) => f.endsWith('.html'));
  assert.ok(pages.includes('index.html') && pages.includes('download.html') && pages.includes('invite-preview.html'));
  for (const f of pages) {
    const html = fs.readFileSync(path.join(DIST, f), 'utf8');
    assert.ok(!/\{\{|\}\}/.test(html), `${f} has a leftover placeholder`);
    assert.ok(html.includes(Brand.name), `${f} says the name`);
    assert.ok(!/Claude Buddy/.test(html.replace(/Formerly Claude Buddy\./g, '')), `${f} uses the old name`);
    for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)/g)) assert.ok(fs.existsSync(path.join(DIST, m[1])), `${f} links ${m[1]}`);
  }
  assert.deepEqual(fs.readdirSync(path.join(DIST, 'assets', 'app')), ['brand.js'], 'the live rig and app tokens are not shipped');
  const headers = fs.readFileSync(path.join(DIST, '_headers'), 'utf8');
  assert.match(headers, /Content-Security-Policy: default-src 'self'/);
  assert.match(headers, new RegExp(Brand.urls.downloads.replace(/\./g, '\\.')));
  assert.match(fs.readFileSync(path.join(DIST, 'sitemap.xml'), 'utf8'), /plexiform\.dev\/download/);
  assert.ok(!/invite-preview/.test(fs.readFileSync(path.join(DIST, 'sitemap.xml'), 'utf8')), 'the invite page is noindex');
});

test('site: no fake proof, no invented numbers, and nothing claimed that is not built', () => {
  const src = fs.readdirSync(path.join(__dirname, '..', 'src')).filter((f) => f.endsWith('.html')).map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
  assert.ok(!/testimonial|trusted by|as seen in|\d+,?\d*\+? (users|teams|developers)/i.test(src));
  // the planned things say so, next to the claim
  assert.match(src, /Agents that can talk to each other\. <span class="tag tag-soon">Coming<\/span>/);
  assert.match(src, /<span class="tag tag-soon">Hatch: coming<\/span>/);
  assert.match(src, /An illustration of how it is planned to work\. Not shipped yet\./);
});

// ── the QR code ─────────────────────────────────────────────────────────
const QR = require('../src/assets/qr.js');
const { spawnSync } = require('child_process');
const os = require('os');

test('qr: the encoder is deterministic, sized for the text, and refuses what it cannot hold', () => {
  const a = QR.encode('https://app.plexiform.dev/phone');
  assert.equal(a.version, 3);
  assert.equal(a.size, 29);
  assert.deepEqual(QR.encode('https://app.plexiform.dev/phone').modules, a.modules);
  assert.ok(QR.encode('x'.repeat(200)).version <= 10);
  assert.throws(() => QR.encode('x'.repeat(400)), /too long/);
  const svg = QR.toSvg('https://plexiform.dev', { label: 'a "b" <c>' });
  assert.match(svg, /^<svg[^>]+viewBox="0 0 33 33"/);
  assert.ok(!/<c>|"b"/.test(svg), 'the label is escaped');
});

test('qr: what the encoder draws is what a real decoder reads (zbar), at several sizes', { skip: spawnSync('zbarimg', ['--version']).status !== 0 && 'zbarimg is not installed' }, () => {
  for (const text of ['https://app.plexiform.dev/phone', 'https://plexiform.dev', `https://app.plexiform.dev/phone?utm=qr&note=${'x'.repeat(150)}`, 'Ünïcode ✓ link']) {
    const { size, modules } = QR.encode(text);
    const scale = 8;
    const quiet = 4;
    const n = (size + quiet * 2) * scale;
    const px = Buffer.alloc(n * n, 255);
    modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) px[((y + quiet) * scale + dy) * n + (x + quiet) * scale + dx] = 0; }));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qr-')), 'q.pgm');
    fs.writeFileSync(file, Buffer.concat([Buffer.from(`P5\n${n} ${n}\n255\n`), px]));
    const r = spawnSync('zbarimg', ['-q', '--raw', file], { encoding: 'utf8' });
    assert.equal(r.stdout.replace(/\n$/, ''), text, `version ${(size - 17) / 4}`);
  }
});

test('build: the phone companion says it is coming until the flag says it is live, and only then shows a code', () => {
  const { build, DIST } = require('../build.js');
  try {
    build({ live: { phone: false } });
    const off = fs.readFileSync(path.join(DIST, 'download.html'), 'utf8');
    assert.match(off, /Phone companion<span class="tag tag-soon">Coming<\/span>/);
    assert.ok(!/QR code for/.test(off), 'no code to a page that is not there yet');
    assert.match(off, /not the desktop app/);
    build({ live: { phone: true } });
    const on = fs.readFileSync(path.join(DIST, 'download.html'), 'utf8');
    assert.match(on, /QR code for https:\/\/app\.plexiform\.dev\/phone/);
    assert.match(on, /Add to Home Screen/);
    assert.ok(!/Coming<\/span>/.test(on.split('first-open')[0].split('id="phone"')[1] || ''), 'the tag changes when it is live');
  } finally { build(); }
});

test('site: the first-open steps match current macOS, and no page still tells people to double-click or only right-click', () => {
  const dir = path.join(__dirname, '..', 'src');
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  for (const [f, html] of all) assert.ok(!/Double-clicking won't offer/.test(html), `${f} still has the old macOS line`);
  const dl = all.find(([f]) => f === 'download.html')[1];
  assert.match(dl, /Privacy &amp; Security/);
  assert.match(dl, /Open Anyway/);
  assert.match(dl, /On macOS 14 and earlier, right-click/);
  assert.doesNotMatch(dl, /xattr -dr com\.apple\.quarantine/);
  assert.match(dl, /verify the checksum and re-download/);
  assert.match(dl, /FUSE support/);
  const invite = all.find(([f]) => f === 'invite-preview.html')[1];
  assert.match(invite, /Open Anyway/);
  assert.match(invite, /Four quick steps/);
  assert.equal((invite.match(/<ol class="steps"[\s\S]*?<\/ol>/)[0].match(/<li/g) || []).length, 4, 'the page counts its steps right');
});

test('site: dark mode never puts dark text on a dark surface (buttons, inputs and the band use fixed light values)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'site.css'), 'utf8');
  for (const sel of ['.cta-band .form input', '.cta-band .btn', '.dl-card .btn']) {
    const rule = css.split('\n').find((l) => l.includes(sel) && /#15171c/.test(l));
    assert.ok(rule, `${sel} sets dark text`);
    assert.ok(!/var\(--paper\)/.test(rule.replace(/\.cta-band \.form label[^}]*\}/, '')), `${sel} must not take its background from --paper`);
  }
  assert.match(css, /\.cta-band \.form-msg\.ok \{ color: #7ee08a; \}/);
});

test('site: the illustration columns are paragraphs, so the page heading outline has no gaps, and the nav marks the current page', () => {
  const { build, DIST } = require('../build.js');
  build();
  const home = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  assert.ok(!/<h4/.test(home));
  const levels = [...home.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
  levels.forEach((l, i) => { if (i) assert.ok(l <= levels[i - 1] + 1, `heading order jumps to h${l} after h${levels[i - 1]}`); });
  assert.match(fs.readFileSync(path.join(DIST, 'docs.html'), 'utf8'), /<a href="\/docs" aria-current="page">/);
});

test('waitlist: the honeypot is a field browsers do not autofill, and the page and function agree on its name', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const fn = fs.readFileSync(path.join(__dirname, '..', 'functions', 'api', 'waitlist.js'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'site.js'), 'utf8');
  assert.match(html, /name="hp_trap_field"/);
  assert.ok(!/name="(company|website|url|name|phone)"/.test(html.match(/<form[\s\S]*?<\/form>/)[0]));
  assert.match(js, /hp: form\.hp_trap_field\.value/);
  assert.match(fn, /data\.hp/);
});

test('public launch: account and Windows copy follows accepted release flags consistently', () => {
  const { build, DIST } = require('../build');
  try {
    build({ live: { publicSignup: true, windowsDownloads: true } });
    const home = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    const download = fs.readFileSync(path.join(DIST, 'download.html'), 'utf8');
    assert.match(home, /Create a free account/);
    assert.doesNotMatch(home, /id="wl-form"|Windows is unavailable|Pricing isn't announced/);
    assert.match(download, /data-windows="true"/);
    assert.doesNotMatch(download, /Windows downloads are unavailable|Unavailable pending runtime acceptance/);
    build({ live: { publicSignup: false, windowsDownloads: false } });
    const gated = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    assert.match(gated, /id="wl-form"/);
    assert.match(gated, /Windows is unavailable/);
    assert.doesNotMatch(gated, /Create a free account/);
  } finally { build(); }
});
