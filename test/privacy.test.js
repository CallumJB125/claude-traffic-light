const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { render } = require('../privacy-render.js');

const ROOT = path.join(__dirname, '..');
const privacy = fs.readFileSync(path.join(ROOT, 'PRIVACY.md'), 'utf8');

test('PRIVACY.md carries the draft banner and the required sections', () => {
  assert.match(privacy, /DRAFT — not legal advice; pending legal review before public launch\./);
  const h2 = [...privacy.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  for (const need of ['What stays on your machine', 'What leaves the machine and when', 'How long things are kept', 'Export your data', 'Delete your data', 'Your rights', 'Contact']) {
    assert.ok(h2.includes(need), `missing section: ${need}`);
  }
  assert.ok(privacy.includes('[privacy contact — Callum to fill]'));
});

test('Preferences renders PRIVACY.md itself, so the two cannot drift', () => {
  const html = render(privacy);
  for (const m of privacy.matchAll(/^###? (.+)$/gm)) {
    const text = m[1].replace(/`/g, '');
    assert.ok(html.replace(/<\/?(code|strong)>/g, '').includes(text), `rendered page lacks heading: ${text}`);
  }
  assert.match(html, /<blockquote><strong>DRAFT/);
  const settings = fs.readFileSync(path.join(ROOT, 'settings.html'), 'utf8');
  assert.match(settings, /privacy-render\.js/);
  assert.match(settings, /privacyText\(\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), /get-privacy[^\n]*PRIVACY\.md/);
  const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).build.files;
  assert.ok(files.includes('PRIVACY.md') && files.includes('privacy-render.js'), 'both must ship in the package');
});

test('the renderer escapes HTML', () => {
  assert.equal(render('a <script>x</script>'), '<p>a &lt;script&gt;x&lt;/script&gt;</p>');
});

// ── Outbound network guard ────────────────────────────────────────────────
// Adding a new way for data to leave the machine must be a decision: list it
// in PRIVACY.md and here, or this fails.
function shipped(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'test', 'test-visual', 'tools', 'docs', 'scripts', '.git', 'assets'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) shipped(p, out);
    else if (/\.(js|html)$/.test(e.name) && e.name !== 'playwright.config.js') out.push(p);
  }
  return out;
}
const files = shipped();
const rel = (f) => path.relative(ROOT, f);

test('no code path can reach the network except the documented ones', () => {
  // Any of these in shipped code is a new outbound channel.
  const banned = /\bnet\.(request|fetch)\b|\bhttps?\.(request|get)\b|\bfetch\(|new WebSocket|require\('https'\)|require\("https"\)|autoUpdater|crashReporter|XMLHttpRequest|navigator\.sendBeacon/;
  // mcp-server.js: http.get to 127.0.0.1 only (asserted below).
  const allowed = new Set(['mcp-server.js']);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (allowed.has(rel(f))) continue;
    const hit = src.split('\n').findIndex((l) => !/^\s*\/\//.test(l) && banned.test(l));
    assert.equal(hit, -1, `${rel(f)}:${hit + 1} opens a network channel; document it in PRIVACY.md and allow it here`);
  }
  const mcp = fs.readFileSync(path.join(ROOT, 'mcp-server.js'), 'utf8');
  assert.match(mcp, /http\.get\(\{ host: '127\.0\.0\.1'/);
  assert.equal((mcp.match(/http\.(get|request)\(/g) || []).length, 1);
});

test('the local server only listens on loopback', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'signal-server.js'), 'utf8');
  const listens = src.match(/\.listen\([^)]*\)/g) || [];
  assert.ok(listens.length >= 1);
  for (const l of listens) assert.match(l, /'127\.0\.0\.1'/);
});

test('every external hostname in shipped code is documented in PRIVACY.md', () => {
  const ignore = new Set(['127.0.0.1', 'localhost', 'www.w3.org']);
  const seen = new Map();
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    for (const m of code.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,}|127\.0\.0\.1|localhost)/gi)) {
      if (!ignore.has(m[1].toLowerCase())) seen.set(m[1].toLowerCase(), rel(f));
    }
  }
  for (const [host, file] of seen) assert.ok(privacy.includes(host), `${host} (in ${file}) is not mentioned in PRIVACY.md`);
});

test('only the GitHub module shells out to gh', () => {
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (rel(f) === path.join('src', 'github-signals.js')) continue;
    assert.ok(!/execFile(Sync)?\(\s*['"`](gh|curl|wget|ssh|scp)['"`]/.test(src), `${rel(f)} runs a networking command; document it in PRIVACY.md`);
  }
});
