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

// ── Outbound network tripwire ─────────────────────────────────────────────
// THIS IS A TRIPWIRE, NOT A SECURITY BOUNDARY. It is a line-based pattern
// scan: it catches honest mistakes (someone adds a fetch, a new dependency, a
// shell-out to curl) and makes them a deliberate, documented decision. It
// cannot stop code written to evade it (string building, eval, a bundled
// dependency). Review still matters.
//
// HOW TO ADD A NEW OUTBOUND FLOW: put `// privacy-flow: <slug>` at the end of
// the line that opens the channel, and add `<!-- flow:<slug> files=<path>[,<path>] -->`
// to the PRIVACY.md section that says who receives what, and whether it is
// opt-in. Only that exact line, in one of those files, is exempt. A marker with
// no matching PRIVACY.md entry fails, and so does a PRIVACY.md entry no code
// line uses.
const HOW = 'To add a flow: tag the line with `// privacy-flow: <slug>` and add `<!-- flow:<slug> files=<path> -->` to the matching PRIVACY.md section.';
// Directories whose files are scanned only if the app package actually includes them
// (board/runner, board/mcp, board/web/mock and remote/ are dev or server-side tools).
const BY_PACKAGING = new Set(['board', 'remote']);
const SKIP_DIRS = new Set(['node_modules', 'test', 'test-visual', 'tools', 'docs', 'scripts', '.git']);
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
function shipped(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) shipped(p, out);
    else if (/\.(js|mjs|cjs|html|css|swift)$/.test(e.name) && e.name !== 'playwright.config.js') {
      const r = path.relative(ROOT, p);
      if (!BY_PACKAGING.has(r.split(path.sep)[0]) || packaged(PKG, r.split(path.sep).join('/'))) out.push(p);
    }
  }
  return out;
}
function unpackaged(dir = ROOT, out = []) {
  const scanned = new Set(files.map((f) => f));
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) unpackaged(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name) && BY_PACKAGING.has(path.relative(ROOT, p).split(path.sep)[0]) && !scanned.has(p)) out.push(p);
  }
  return out;
}
const rel = (f) => path.relative(ROOT, f);
const blank = (m) => m.replace(/[^\n]/g, ' ');
// Raw lines (markers live in trailing comments) and code-only lines (no comments).
function linesOf(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, blank).split('\n').map((l) => ({ raw: l, code: /^\s*\/\//.test(l) ? '' : l }));
}
const NOT_LITERAL = '(?:[^\'"`\\s)\\]]|`[^`]*\\$\\{)';
const MOD = '(?:node:)?(?:https?|http2|net|tls|dgram|dns|undici|ws)';
const CHANNEL = new RegExp([
  `require\\(\\s*['"]${MOD}['"]\\s*\\)`, `\\bfrom\\s+['"]${MOD}['"]`,
  `\\brequire\\(\\s*${NOT_LITERAL}`, '\\bimport\\(\\s*\\S',
  '\\bnet\\.(?:request|fetch|connect|createConnection)\\b', '\\btls\\.connect\\b', '\\bhttps?\\.(?:request|get)\\b', '\\bdns\\.(?:lookup|resolve\\w*)\\b',
  'require\\(\\s*[\'"]electron[\'"]\\s*\\)\\s*\\.\\s*net\\b', '\\{[^}]*\\bnet\\b[^}]*\\}\\s*=\\s*require\\(\\s*[\'"]electron[\'"]',
  'new ClientRequest', '\\bfetch\\(', 'Reflect\\.apply\\(\\s*(?:globalThis\\.|window\\.)?fetch', 'new WebSocket', 'new EventSource', 'EventSource\\(',
  `new Worker\\(\\s*${NOT_LITERAL}`, 'XMLHttpRequest', 'sendBeacon',
  '(?:globalThis|window|global)\\.fetch\\b', 'globalThis\\s*\\[', '\\bglobal\\s*\\[', 'window\\s*\\[',
  'autoUpdater', 'electron-updater', 'update-electron-app', 'crashReporter', 'Sentry\\.init', '@sentry/',
  `(?:loadURL|downloadURL)\\(\\s*${NOT_LITERAL}`, '(?:loadURL|downloadURL)\\(\\s*[\'"`]https?:', `openExternal\\(\\s*${NOT_LITERAL}`,
  '@import\\b', 'url\\(\\s*[\'"]?(?:https?:)?//',
  'do shell script',
  // a shell told to run a network tool, or git talking to a remote
  '\\b(?:sh|zsh|bash|cmd|powershell)[\'"`]\\s*,\\s*\\[[^\\]]*\\b(?:curl|wget|ssh|scp|nc|ncat|ftp|telnet|gh)\\b',
  '[\'"`]git[\'"`]\\s*,\\s*\\[[^\\]]*[\'"`](?:fetch|pull|push|clone|ls-remote|remote\\s+update)[\'"`]',
  // a shell or powershell running a computed command, and node -e with computed code
  `(?:sh|zsh|bash|powershell|cmd)[\'"\`]\\s*,\\s*\\[[^\\]]*[\'"\`][-/]\\w*[cC][\'"\`]\\s*,\\s*${NOT_LITERAL}`,
  `process\\.execPath\\s*,\\s*\\[\\s*['"\`]-e['"\`]\\s*,\\s*${NOT_LITERAL}`,
  // Swift
  'URLSession', 'NSURLConnection', 'NWConnection', 'URLRequest',
].join('|'));
const EXEC_NAMES = ['execFile', 'execFileSync', 'exec', 'execSync', 'spawn', 'spawnSync', 'fork'];
const EXEC_RE = EXEC_NAMES.join('|');
// Binaries that only ever work on this machine. Anything else, or a computed
// name, must carry a marker. Absolute paths count only from system locations.
const LOCAL_BINS = new Set(['afplay', 'say', 'powershell', 'osascript', 'tmux', 'ps', 'git', 'open', 'cmd', 'zsh', 'sh', 'shortcuts', 'ccusage', 'pbcopy', 'kitten', 'wezterm', 'tailscale', 'process.execPath']);
const LOCAL_PATHS = new Set(['/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
const SYSTEM_DIRS = /^\/(?:usr\/(?:local\/)?bin|bin|usr\/sbin|sbin|opt\/homebrew\/bin)\//;
function localBin(bin) {
  if (LOCAL_PATHS.has(bin) || LOCAL_BINS.has(bin)) return true;
  return SYSTEM_DIRS.test(bin) && LOCAL_BINS.has(bin.replace(SYSTEM_DIRS, ''));
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Identifiers a file binds from child_process / electron's net / fetch, so
// later CALLS of an alias are caught and not only the line that bound it.
function bindingsOf(text) {
  const b = { execCalls: new Set(), receivers: new Set(['child_process', 'childProcess', 'cp']), netNames: new Set(), fetchCalls: new Set() };
  const CP = "(?:node:)?child_process";
  for (const m of text.matchAll(new RegExp(`\\{([^}]*)\\}\\s*=\\s*require\\(\\s*['"]${CP}['"]\\s*\\)`, 'g'))) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.split(':').map((x) => x.trim());
      if (orig && EXEC_NAMES.includes(orig)) b.execCalls.add(alias || orig);
    }
  }
  for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*require\\(\\s*['"]${CP}['"]\\s*\\)(?:\\.(${EXEC_RE}))?`, 'g'))) (m[2] ? b.execCalls : b.receivers).add(m[1]);
  for (const m of text.matchAll(new RegExp(`import\\s+(?:\\*\\s+as\\s+)?(\\w+)\\s+from\\s+['"]${CP}['"]`, 'g'))) b.receivers.add(m[1]);
  for (const m of text.matchAll(/\{([^}]*)\}\s*=\s*require\(\s*['"]electron['"]\s*\)/g)) {
    for (const part of m[1].split(',')) { const [orig, alias] = part.split(':').map((x) => x.trim()); if (orig === 'net') b.netNames.add(alias || 'net'); }
  }
  for (const m of text.matchAll(/(?:const|let|var|[{,(])\s*(\w+)\s*=\s*(?:globalThis\.|window\.|global\.)?fetch\b(?!\s*\()/g)) b.fetchCalls.add(m[1]);
  return b;
}
function opensChannel(code, b = bindingsOf('')) {
  if (CHANNEL.test(code)) return true;
  for (const n of b.netNames) if (new RegExp(`(?<![\\w.])${escRe(n)}\\.(?:request|fetch|connect|createConnection)\\b`).test(code)) return true;
  for (const f of b.fetchCalls) if (new RegExp(`(?<![\\w.])${escRe(f)}\\(`).test(code)) return true;
  const inline = (recv) => /require\(\s*['"](?:node:)?child_process['"]\s*\)$/.test(recv) || b.receivers.has(recv.split(/[\s(,=]/).pop());
  const execBin = (quote, arg) => {
    const bin = quote ? arg.trim().split(/\s+/)[0] : (arg.trim() === 'process.execPath' ? 'process.execPath' : null);
    return !bin || !localBin(bin);
  };
  // member calls on a known child_process binding: cp.spawn(x), require('child_process').execFile(x)
  for (const m of code.matchAll(new RegExp(`(\\S*?)\\.(${EXEC_RE})\\(\\s*(['"\`])?([^'"\`,)]*)`, 'g'))) {
    if (inline(m[1]) && execBin(m[3], m[4])) return true;
  }
  // bare calls: destructured/aliased names from this file's child_process import
  for (const name of b.execCalls) {
    for (const m of code.matchAll(new RegExp(`(?<![\\w.])${escRe(name)}\\(\\s*(['"\`])?([^'"\`,)]*)`, 'g'))) {
      if (/function\s*$/.test(code.slice(0, m.index))) continue;
      if (execBin(m[1], m[2])) return true;
    }
  }
  // a bare call naming a literal non-local binary counts even where the function is injected
  for (const m of code.matchAll(new RegExp(`(?<![\\w.])(?:${EXEC_RE})\\(\\s*(['"\`])([^'"\`,)]*)`, 'g'))) {
    if (!localBin(m[2].trim().split(/\s+/)[0])) return true;
  }
  return false;
}
// <!-- flow:slug files=a.js,b.js -->
const flows = new Map([...privacy.matchAll(/<!-- flow:([\w-]+) files=([^\s>]+) -->/g)].map((m) => [m[1], new Set(m[2].split(','))]));
const files = shipped();

// Every tagged line is checked; all failures are reported together.
function audit(list) {
  const problems = [];
  const used = new Set();
  for (const { file, text } of list) {
    const b = bindingsOf(text);
    linesOf(text).forEach(({ raw, code }, i) => {
      const slug = (raw.match(/privacy-flow:\s*([\w-]+)/) || [])[1];
      // A tagged line counts even when no pattern matches it (a local data flow worth documenting).
      if (!slug && (!code || !opensChannel(code, b))) return;
      const where = `${file}:${i + 1}`;
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
  // Board tooling that is not packaged (runner, MCP) is not scanned, but its tags still count as documented uses.
  for (const f of unpackaged()) {
    linesOf(fs.readFileSync(f, 'utf8')).forEach(({ raw }, i) => {
      const slug = (raw.match(/privacy-flow:\s*([\w-]+)/) || [])[1];
      if (!slug) return;
      const file = rel(f).split(path.sep).join('/');
      if (!flows.has(slug)) problems.push(`${file}:${i + 1} is tagged "${slug}" but PRIVACY.md has no <!-- flow:${slug} files=… -->`);
      else if (!flows.get(slug).has(file)) problems.push(`${file}:${i + 1} is tagged "${slug}" but PRIVACY.md documents that flow only for: ${[...flows.get(slug)].join(', ')}`);
      else used.add(slug);
    });
  }
  for (const slug of flows.keys()) if (!used.has(slug)) problems.push(`PRIVACY.md lists flow:${slug} but no code line is tagged with it`);
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n${HOW}`);
});

// Does a packaging glob (electron-builder style) cover this repo path? Good enough for a tripwire.
function globMatches(pattern, file) {
  const re = pattern.replace(/^\.\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${re}(?:/.*)?$`).test(file);
}
function packaged(pkg, file) {
  const b = pkg.build || {};
  const entries = [...(b.files || []), ...(b.extraResources || []), ...(b.extraFiles || [])];
  for (const os of ['mac', 'win', 'linux']) entries.push(...(b[os]?.files || []), ...(b[os]?.extraResources || []), ...(b[os]?.extraFiles || []));
  let included = false;
  for (const e of entries) {
    const pat = typeof e === 'string' ? e : (e.from || '');
    if (pat.startsWith('!')) { if (globMatches(pat.slice(1), file)) included = false; } else if (globMatches(pat, file)) included = true;
  }
  return included;
}
test('the phone relay (remote/) stays out of the app package until it is documented', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const f of ['remote/src/relay.js', 'remote/package.json', 'remote']) assert.ok(!packaged(pkg, f), `${f} is being packaged: remove remote from SKIP_DIRS and document its flows`);
  assert.ok(packaged({ build: { files: ['**/*'] } }, 'remote/src/relay.js'), 'self-check: a catch-all glob covers remote/');
  assert.ok(packaged({ build: { mac: { extraResources: [{ from: 'remote', to: 'r' }] } } }, 'remote/src/relay.js'), 'self-check: per-OS extraResources');
  assert.ok(!packaged({ build: { files: ['**/*', '!remote/**'] } }, 'remote/src/relay.js'), 'self-check: negation');
});

test('the guard catches what it should', () => {
  const flagged = (code, text = code) => opensChannel(code, bindingsOf(text));
  const bad = ["require('node:https')", "require('ws')", "require('dns')", "import x from 'undici'", "const m = await import(name)", "await import('x')", "require(modName)", "fetch(u)", "globalThis['fe' + 'tch'](u)",
    "net.connect(1)", "tls.connect(1)", "dns.lookup(h)", "new ClientRequest(u)", "new EventSource(u)", "new Worker(file)", "win.loadURL(u)", "win.loadURL(`https://x`)", "s.downloadURL(u)", "Sentry.init({})", "require('electron-updater')",
    "const { request } = require('electron').net", "const { app, net } = require('electron')", "@import url(x.css);", "background: url(https://x/y.png)",
    "execFile('curl', [u])", "cp.spawn(cmd)", "require('child_process').spawn(cmd)", "childProcess.execFile('x')",
    "execFile('/bin/zsh', ['-c', 'curl x'])", "execFile('sh', ['-c', 'wget x'])", "execFile('/bin/zsh', ['-lc', action.arg])", "execFile('powershell', ['-NoProfile', '-c', `Speak('${t}')`])", "execFile('git', ['fetch'])",
    "spawnSync(process.execPath, ['-e', probe])", "osascript -e 'do shell script \"curl x\"'", "shell.openExternal(url)", "spawn('/tmp/x/open', [])", "spawn('claude', args)",
    "URLSession.shared.dataTask(with: u)", "let c = NWConnection(host: h, port: p, using: .tcp)"];
  for (const b of bad) assert.ok(flagged(b), b);
  // aliases: the binding line and the later calls
  const cpAlias = "const { execFile: ef } = require('child_process');\nef(bin, args);";
  assert.ok(flagged('ef(bin, args)', cpAlias), 'call of a destructured alias');
  assert.ok(flagged('sp(cmd)', "const sp = require('child_process').spawn;"), 'call of a spawn alias');
  assert.ok(flagged('c.execFile(cmd)', "const c = require('child_process');"), 'member of a renamed child_process');
  assert.ok(flagged('n.request(o)', "const { net: n } = require('electron');"), 'renamed electron net');
  assert.ok(flagged('f(u)', 'const f = fetch;'), 'call of a fetch alias');
  assert.ok(flagged('async function g({ fetchImpl = globalThis.fetch } = {}) {'), 'globalThis.fetch as a default');
  assert.ok(flagged('await impl(u)', 'function h(impl = fetch) {'), 'a fetch default parameter is an alias');
  assert.ok(flagged('Reflect.apply(fetch, null, [u])'), 'Reflect.apply(fetch');
  const ok = ["execFile('git', ['status'])", "execFileSync('/bin/ps', [])", "spawn(process.execPath, ['x'])", "execFile('/usr/bin/osascript', [])", "shell.openExternal('https://claude.ai')", "win.loadFile('a.html')",
    "HOOK.exec(line)", "/a/g.exec(s)", "re.exec(line)", "match.exec(s)", "tokenRe.exec(s)", "line.exec(s)", "ctx.exec(file, args)", "net.isOnline()", "exec(file)",
    "execFile('/Applications/Tailscale.app/Contents/MacOS/Tailscale', ['status'])", "execFile('/bin/zsh', ['-c', 'echo hi'])", "import('./x.js')".replace('import', 'Import'), "execFile('osascript', ['-e', script])"];
  for (const o of ok) assert.ok(!flagged(o), o);
  assert.ok(!flagged('exec(file)', "const x = 1;"), 'a bare exec( with no child_process binding is an injected wrapper');
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
  const missing = new Set();
  for (const f of files) {
    const code = linesOf(fs.readFileSync(f, 'utf8')).map((l) => l.code).join('\n');
    for (const m of code.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi)) {
      const host = m[1].toLowerCase();
      if (ignore.has(host)) continue;
      if (!new RegExp(`(?<![\\w.-])${host.replace(/\./g, '\\.')}(?![\\w-])`).test(privacy)) missing.add(`${host} (in ${rel(f)})`);
    }
  }
  assert.deepEqual([...missing], [], 'hosts not mentioned in PRIVACY.md');
});

test('the shipped dependency list is an allow-list', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const allowed = new Set(['@modelcontextprotocol/sdk', 'zod', 'ws']); // ws: the team hub websocket, documented under flow:team-hub
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
