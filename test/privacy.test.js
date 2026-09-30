const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { render } = require('../privacy-render.js');
const Agents = require('../agents.js');

const ROOT = path.join(__dirname, '..');
const privacy = fs.readFileSync(path.join(ROOT, 'PRIVACY.md'), 'utf8');

test('PRIVACY.md carries the draft banner and the required sections', () => {
  assert.match(privacy, /DRAFT — not legal advice; pending legal review before public launch\./);
  const h2 = [...privacy.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  for (const need of ['What stays on your machine', 'What leaves the machine and when', 'How long things are kept', 'Export your data', 'Delete your data', 'Your rights', 'Contact']) {
    assert.ok(h2.includes(need), `missing section: ${need}`);
  }
  // While it is a draft the placeholders must exist; once the banner is gone none may remain.
  const placeholders = privacy.match(/\[[^\]]*Callum to [^\]]*\]/g) || [];
  if (/DRAFT — not legal advice/.test(privacy)) assert.ok(placeholders.length > 0, 'draft has no placeholders left to fill');
  else assert.deepEqual(placeholders, [], 'banner removed but placeholders remain');
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

test('numbered lists render as <ol>, and HTML comments never show', () => {
  assert.equal(render('1. a\n2. b'), '<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
  assert.equal(render('hello <!-- flow:x --> there'), '<p>hello  there</p>');
  assert.equal(render('<!-- flow:x -->'), '');
});

// ── Outbound network guard ────────────────────────────────────────────────
// HOW TO ADD A NEW OUTBOUND FLOW: put `// privacy-flow: <slug>` at the end of
// the line that opens the channel, and add a section or bullet to PRIVACY.md
// containing `<!-- flow:<slug> -->` that says who receives what, and whether
// it is opt-in. Only that exact line is exempt. A marker without the matching
// PRIVACY.md entry fails, and so does a PRIVACY.md entry no code line uses.
const HOW = 'To add a flow: tag the line with `// privacy-flow: <slug>` and add `<!-- flow:<slug> -->` to the matching PRIVACY.md section.';
const SKIP_DIRS = new Set(['node_modules', 'test', 'test-visual', 'tools', 'docs', 'scripts', '.git']);
function shipped(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) shipped(p, out);
    else if (/\.(js|mjs|cjs|html)$/.test(e.name) && e.name !== 'playwright.config.js') out.push(p);
  }
  return out;
}
const rel = (f) => path.relative(ROOT, f);
const blank = (m) => m.replace(/[^\n]/g, ' ');
// Raw lines (markers live in trailing comments) and code-only lines (no comments).
function lines(f) {
  const raw = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, blank).split('\n');
  return raw.map((l) => ({ raw: l, code: /^\s*\/\//.test(l) ? '' : l }));
}
const MOD = '(?:node:)?(?:https?|http2|net|tls|dgram|undici)';
const CHANNEL = new RegExp([
  `require\\(\\s*['"]${MOD}['"]\\s*\\)`, `\\bfrom\\s+['"]${MOD}['"]`, `\\bimport\\(\\s*['"]${MOD}['"]`,
  '\\bnet\\.(?:request|fetch|connect|createConnection)\\b', '\\btls\\.connect\\b', '\\bhttps?\\.(?:request|get)\\b',
  'new ClientRequest', '\\bfetch\\(', 'new WebSocket', 'XMLHttpRequest', 'sendBeacon',
  'autoUpdater', 'electron-updater', 'update-electron-app', 'crashReporter', 'Sentry\\.init', '@sentry/',
  'loadURL\\(\\s*[`\'"]https?:', 'openExternal\\(\\s*[^\'"`\\s]',
].join('|'));
// Binaries that only ever work on this machine. Anything else, or a computed
// name, must carry a marker.
const LOCAL_BINS = new Set(['afplay', 'say', 'powershell', 'osascript', 'tmux', '/bin/ps', 'git', 'open', 'cmd', '/bin/zsh', 'shortcuts', 'ccusage', 'sh', 'pbcopy']);
const EXEC = /(?<![.\w])(?:execFile|execFileSync|exec|execSync|spawn|spawnSync)\(\s*(['"`])?([^'"`,)]*)/g;
function opensChannel(code) {
  if (CHANNEL.test(code)) return true;
  for (const m of code.matchAll(EXEC)) {
    const bin = m[1] ? m[2].trim().split(/\s+/)[0] : null;
    if (!bin || !LOCAL_BINS.has(bin)) return true;
  }
  return false;
}
const flows = new Set([...privacy.matchAll(/<!-- flow:([\w-]+) -->/g)].map((m) => m[1]));
const files = shipped();
const used = new Set();

test('every line that opens a network channel is tagged and documented in PRIVACY.md', () => {
  for (const f of files) {
    lines(f).forEach(({ raw, code }, i) => {
      if (!code || !opensChannel(code)) return;
      const slug = (raw.match(/privacy-flow:\s*([\w-]+)/) || [])[1];
      assert.ok(slug, `${rel(f)}:${i + 1} opens a network or process channel without a privacy-flow marker. ${HOW}`);
      assert.ok(flows.has(slug), `${rel(f)}:${i + 1} is tagged "${slug}" but PRIVACY.md has no <!-- flow:${slug} -->. ${HOW}`);
      used.add(slug);
    });
  }
});

test('PRIVACY.md documents no flow that the code no longer has', () => {
  for (const slug of flows) assert.ok(used.has(slug), `PRIVACY.md lists flow:${slug} but no code line is tagged with it`);
});

test('the guard catches what it should', () => {
  for (const bad of ["require('node:https')", "import x from 'undici'", "fetch(u)", "net.connect(1)", "tls.connect(1)", "new ClientRequest(u)", "win.loadURL(`https://x`)", "Sentry.init({})", "require('electron-updater')", "execFile('curl', [u])", "execFile(bin, args)", "spawn(cmd)", "shell.openExternal(url)"]) {
    assert.ok(opensChannel(bad), bad);
  }
  for (const ok of ["execFile('git', [])", "execFileSync('/bin/ps', [])", "shell.openExternal('https://claude.ai')", "re.exec(line)", "net.isOnline()", "win.loadFile('a.html')"]) {
    assert.ok(!opensChannel(ok), ok);
  }
});

test('the local server only listens on loopback', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'signal-server.js'), 'utf8');
  const listens = src.match(/\.listen\([^)]*\)/g) || [];
  assert.ok(listens.length >= 1);
  for (const l of listens) assert.match(l, /'127\.0\.0\.1'/);
  const mcp = fs.readFileSync(path.join(ROOT, 'mcp-server.js'), 'utf8');
  assert.match(mcp, /http\.get\(\{ host: '127\.0\.0\.1'/);
});

test('every external hostname in shipped code is documented in PRIVACY.md', () => {
  const ignore = new Set(['127.0.0.1', 'localhost', 'www.w3.org']);
  for (const f of files) {
    const code = lines(f).map((l) => l.code).join('\n');
    for (const m of code.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi)) {
      const host = m[1].toLowerCase();
      if (ignore.has(host)) continue;
      const esc = host.replace(/\./g, '\\.');
      assert.match(privacy, new RegExp(`(?<![\\w.-])${esc}(?![\\w-])`), `${host} (in ${rel(f)}) is not mentioned in PRIVACY.md`);
    }
  }
});

test('the shipped dependency list is an allow-list', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const allowed = new Set(['@modelcontextprotocol/sdk', 'zod']);
  for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dep of Object.keys(pkg[k] || {})) assert.ok(allowed.has(dep), `new dependency ${dep}: check whether it reaches the network, document it in PRIVACY.md, then add it to this list`);
  }
});

test('every window turns spellcheck off (it downloads dictionaries from Google on Windows/Linux)', () => {
  let windows = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const n = (src.match(/new BrowserWindow\(/g) || []).length;
    windows += n;
    assert.equal((src.match(/spellcheck:\s*false/g) || []).length, n, `${rel(f)}: every new BrowserWindow needs webPreferences.spellcheck: false`);
  }
  assert.ok(windows >= 6);
});

// ── Permission previews ───────────────────────────────────────────────────
test('sweepStaleFiles can clear orphaned request files of the given types', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-req-'));
  const DAY = 86400000;
  const now = Date.now();
  const put = (name, age) => { const f = path.join(dir, name); fs.writeFileSync(f, '{}'); const t = new Date(now - age); fs.utimesSync(f, t, t); };
  put('old.json', 2 * DAY); put('old.answer', 2 * DAY); put('young.json', DAY / 2); put('young.answer', 1000);
  const removed = Agents.sweepStaleFiles(dir, DAY, now, ['.json', '.answer', '.tmp']).sort();
  assert.deepEqual(removed, ['old.answer', 'old.json']);
  assert.match(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), /REQUEST_SWEEP_MS = 24 \* 60 \* 60 \* 1000/);
});

test('a permission preview is written readable by its owner only', { skip: process.platform === 'win32' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-perm-'));
  const server = net.createServer((s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(home, 'port'), String(server.address().port));
  const child = spawn(process.execPath, [path.join(ROOT, 'hooks', 'set-status.js'), 'permission-request'], {
    env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_ASK_MS: '8000' },
  });
  child.stdin.end(JSON.stringify({ session_id: 's1', cwd: '/tmp/x', tool_name: 'Bash', tool_input: { command: 'echo hunter2' } }));
  const reqs = path.join(home, 'requests');
  let file = null;
  for (let i = 0; i < 80 && !file; i++) {
    file = (fs.existsSync(reqs) ? fs.readdirSync(reqs) : []).find((n) => n.endsWith('.json'));
    if (!file) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(file, 'the hook never wrote a request');
  const mode = fs.statSync(path.join(reqs, file)).mode & 0o777;
  fs.writeFileSync(path.join(reqs, file.replace(/\.json$/, '.answer')), 'deny');
  await new Promise((r) => child.on('exit', r));
  server.close();
  assert.equal(mode, 0o600);
});
