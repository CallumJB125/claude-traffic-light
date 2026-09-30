const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { render } = require('../privacy-render.js');

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
// the line that opens the channel, and add `<!-- flow:<slug> files=<path>[,<path>] -->`
// to the PRIVACY.md section that says who receives what, and whether it is
// opt-in. Only that exact line, in one of those files, is exempt. A marker with
// no matching PRIVACY.md entry fails, and so does a PRIVACY.md entry no code
// line uses.
const HOW = 'To add a flow: tag the line with `// privacy-flow: <slug>` and add `<!-- flow:<slug> files=<path> -->` to the matching PRIVACY.md section.';
// remote/ (phone relay) is not packaged or wired in; the package-files test below fails if that changes.
const SKIP_DIRS = new Set(['node_modules', 'test', 'test-visual', 'tools', 'docs', 'scripts', '.git', 'remote']);
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
function linesOf(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, blank).split('\n').map((l) => ({ raw: l, code: /^\s*\/\//.test(l) ? '' : l }));
}
const MOD = '(?:node:)?(?:https?|http2|net|tls|dgram|undici|ws)';
const CHANNEL = new RegExp([
  `require\\(\\s*['"]${MOD}['"]\\s*\\)`, `\\bfrom\\s+['"]${MOD}['"]`, `\\bimport\\(\\s*['"]${MOD}['"]`,
  '\\brequire\\(\\s*[^\'"`\\s)]', '\\brequire\\(\\s*`[^`]*\\$\\{', '\\bimport\\(\\s*[^\'"`\\s)]',
  '\\bnet\\.(?:request|fetch|connect|createConnection)\\b', '\\btls\\.connect\\b', '\\bhttps?\\.(?:request|get)\\b',
  'new ClientRequest', '\\bfetch\\(', 'new WebSocket', 'XMLHttpRequest', 'sendBeacon',
  'globalThis\\s*\\[', '\\bglobal\\s*\\[', 'window\\s*\\[',
  'autoUpdater', 'electron-updater', 'update-electron-app', 'crashReporter', 'Sentry\\.init', '@sentry/',
  'loadURL\\(\\s*[`\'"]https?:', 'openExternal\\(\\s*[^\'"`\\s]',
  // a shell told to run a network tool, or git talking to a remote
  '\\b(?:sh|zsh|bash|cmd|powershell)[\'"`]\\s*,\\s*\\[[^\\]]*\\b(?:curl|wget|ssh|scp|nc|ncat|ftp|telnet|gh)\\b',
  '[\'"`]git[\'"`]\\s*,\\s*\\[[^\\]]*[\'"`](?:fetch|pull|push|clone|ls-remote|remote\\s+update)[\'"`]',
  // child_process reached through an alias: { execFile: ef } = require('child_process')
  '\\{[^}]*\\b(?:exec|spawn)\\w*\\s*:\\s*\\w+[^}]*\\}\\s*=\\s*require\\(\\s*[\'"](?:node:)?child_process',
].join('|'));
const EXEC_NAMES = 'execFile|execFileSync|exec|execSync|spawn|spawnSync|fork';
// Binaries that only ever work on this machine. Anything else, or a computed
// name, must carry a marker. Absolute paths count only from system locations.
const LOCAL_BINS = new Set(['afplay', 'say', 'powershell', 'osascript', 'tmux', 'ps', 'git', 'open', 'cmd', 'zsh', 'sh', 'shortcuts', 'ccusage', 'pbcopy', 'kitten', 'wezterm', 'tailscale', 'process.execPath']);
const LOCAL_PATHS = new Set(['/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
const SYSTEM_DIRS = /^\/(?:usr\/(?:local\/)?bin|bin|usr\/sbin|sbin|opt\/homebrew\/bin)\//;
function localBin(bin) {
  if (LOCAL_PATHS.has(bin)) return true;
  if (LOCAL_BINS.has(bin)) return true;
  return SYSTEM_DIRS.test(bin) && LOCAL_BINS.has(bin.replace(SYSTEM_DIRS, ''));
}
// `x.exec(` is usually a RegExp; a regex literal or an obviously-regex name is exempt.
const REGEXISH = /(?:\/[gimsuy]*|\b(?:re|rx|regex|regexp|pattern)\w*|[A-Z][A-Z0-9_]+)$/;
function opensChannel(code, importsCp) {
  if (CHANNEL.test(code)) return true;
  const call = new RegExp(`(?:(^|[^\\w.])(${EXEC_NAMES})|(\\S*?)\\.(${EXEC_NAMES}))\\(\\s*(['"\`])?([^'"\`,)]*)`, 'g');
  for (const m of code.matchAll(call)) {
    const member = m[4] !== undefined;
    // a bare exec( in a file with no child_process is an injected wrapper (its definition is what gets tagged),
    // unless it names a literal binary: then the binary itself is checked.
    if (!member && /function\s*$/.test(code.slice(0, m.index + (m[1] || '').length))) continue;
    if (!member && !importsCp && !m[5]) continue;
    if (member && m[4] === 'exec' && REGEXISH.test(m[3] || '')) continue;
    const bin = m[5] ? m[6].trim().split(/\s+/)[0] : (m[6].trim() === 'process.execPath' ? 'process.execPath' : null);
    if (!bin || !localBin(bin)) return true;
  }
  return false;
}
const importsChildProcess = (text) => /(?:require\(\s*|from\s+)['"](?:node:)?child_process['"]/.test(text);
// <!-- flow:slug files=a.js,b.js -->
const flows = new Map([...privacy.matchAll(/<!-- flow:([\w-]+) files=([^\s>]+) -->/g)].map((m) => [m[1], new Set(m[2].split(','))]));
const files = shipped();

// Every tagged line is checked; all failures are reported together.
function audit(list) {
  const problems = [];
  const used = new Set();
  for (const { file, text } of list) {
    const cp = importsChildProcess(text);
    linesOf(text).forEach(({ raw, code }, i) => {
      if (!code || !opensChannel(code, cp)) return;
      const where = `${file}:${i + 1}`;
      const slug = (raw.match(/privacy-flow:\s*([\w-]+)/) || [])[1];
      if (!slug) return problems.push(`${where} opens a network or process channel without a privacy-flow marker: ${code.trim().slice(0, 90)}`);
      if (!flows.has(slug)) return problems.push(`${where} is tagged "${slug}" but PRIVACY.md has no <!-- flow:${slug} files=… -->`);
      if (!flows.get(slug).has(file)) return problems.push(`${where} is tagged "${slug}" but PRIVACY.md documents that flow only for: ${[...flows.get(slug)].join(', ')}`);
      used.add(slug);
    });
  }
  return { problems, used };
}

test('every line that opens a network channel is tagged and documented in PRIVACY.md', () => {
  const { problems, used } = audit(files.map((f) => ({ file: rel(f), text: fs.readFileSync(f, 'utf8') })));
  for (const slug of flows.keys()) if (!used.has(slug)) problems.push(`PRIVACY.md lists flow:${slug} but no code line is tagged with it`);
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n${HOW}`);
});

test('the phone relay (remote/) stays out of the app package until it is documented', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const listed = JSON.stringify([...(pkg.build.files || []), ...(pkg.build.extraResources || [])]);
  assert.ok(!/remote/.test(listed), 'remote/ is being packaged: remove it from SKIP_DIRS and document its flows');
});

test('the guard catches what it should', () => {
  const bad = ["require('node:https')", "require('ws')", "import x from 'undici'", "const m = await import(name)", "require(modName)", "fetch(u)", "globalThis['fe' + 'tch'](u)",
    "net.connect(1)", "tls.connect(1)", "new ClientRequest(u)", "win.loadURL(`https://x`)", "Sentry.init({})", "require('electron-updater')",
    "execFile('curl', [u])", "execFile(bin, args)", "cp.spawn(cmd)", "cp.spawn(cmd.execPath)", "child.execFile('x')", "util.exec('curl x')", "const { execFile: ef } = require('child_process')",
    "execFile('/bin/zsh', ['-c', 'curl x'])", "execFile('sh', ['-c', 'wget x'])", "execFile('git', ['fetch'])", "shell.openExternal(url)", "spawn('/tmp/x/open', [])"];
  for (const b of bad) assert.ok(opensChannel(b, true), b);
  const ok = ["execFile('git', ['status'])", "execFileSync('/bin/ps', [])", "spawn(process.execPath, ['x'])", "execFile('/usr/bin/osascript', [])", "shell.openExternal('https://claude.ai')",
    "HOOK.exec(line)", "/a/g.exec(s)", "re.exec(line)", "net.isOnline()", "win.loadFile('a.html')", "exec(file)", "execFile('/Applications/Tailscale.app/Contents/MacOS/Tailscale', ['status'])"];
  for (const o of ok) assert.ok(!opensChannel(o, false), o);
  assert.ok(!opensChannel("exec(file)", false) && opensChannel("exec(file)", true), 'bare exec( counts only where child_process is imported');
  assert.ok(opensChannel("spawn('claude', args)", false), 'a literal non-local binary counts even when spawn is injected');
});

test('a flow slug cannot be reused in a file PRIVACY.md does not list for it', () => {
  const r = audit([{ file: 'src/elsewhere.js', text: "fetch(u); // privacy-flow: gh-poll\n" }]);
  assert.match(r.problems.join('\n'), /documents that flow only for/);
  assert.match(audit([{ file: 'x.js', text: "fetch(u)\n" }]).problems.join('\n'), /without a privacy-flow marker/);
  assert.match(audit([{ file: 'x.js', text: "fetch(u); // privacy-flow: nope\n" }]).problems.join('\n'), /no <!-- flow:nope/);
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
    const code = linesOf(fs.readFileSync(f, 'utf8')).map((l) => l.code).join('\n');
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
