// Borrow scanner: read-only, blocklist before any fs call, links stay home,
// ~/.claude.json gives up only mcpServers. Always a temp HOME, never the real one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, EXEC_ALLOWED, PARSERS } = require('../src/borrow/scan.js');
const { SOURCES } = require('../src/borrow/registry.js');
const { blockedReason } = require('../src/borrow/blocklist.js');

// Every temp folder a test makes is removed when the file's tests finish.
const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tempDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };

function tempHome(files, links = {}) {
  const home = tempDir('borrow-home-');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  for (const [rel, target] of Object.entries(links)) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.symlinkSync(target, p);
  }
  return home;
}

// Records every path any fs call touches; a write of any kind fails the test.
function spyFs(home) {
  const touched = [];
  const rel = (p) => { const r = path.relative(fs.realpathSync(home), fs.existsSync(p) ? fs.realpathSync(p) : p); return r.startsWith('..') ? path.relative(home, p) : r; };
  const wrap = (name) => (p, ...a) => { touched.push({ op: name, path: rel(String(p)) }); return fs[name](p, ...a); };
  const api = {};
  for (const n of ['lstatSync', 'statSync', 'readFileSync', 'readdirSync', 'realpathSync', 'readlinkSync', 'openSync']) api[n] = wrap(n);
  // Descriptor calls name no path; the openSync that made the descriptor was recorded.
  for (const n of ['fstatSync', 'readSync', 'closeSync']) api[n] = (...a) => fs[n](...a);
  for (const n of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'symlinkSync', 'chmodSync']) api[n] = () => { throw new Error(`scan wrote: ${n}`); };
  return { api, touched };
}

const SECRETY = {
  '.ssh/id_ed25519': 'PRIVATE',
  '.ssh/config': 'Host box\n  HostName 10.0.0.9\n',
  '.aws/credentials': '[default]\naws_secret_access_key=x',
  '.gnupg/pubring.kbx': 'x',
  '.netrc': 'machine x login y password z',
  '.zsh_history': 'secret command',
  '.env': 'TOKEN=x',
  '.config/nvim/.env': 'TOKEN=x',
  '.config/nvim/lua/secrets.lua': 'return { token = "x" }',
  '.claude/projects/-Users-x/abc.jsonl': '{"transcript":true}',
  '.claude/.credentials.json': '{"token":"x"}',
  '.docker/config.json': '{"auths":{}}',
  '.kube/config': 'users: []',
};

test('reads registry files, skips what is absent, lists what it looked at', () => {
  const home = tempHome({
    '.zshrc': 'alias ll="ls -la"\n',
    '.gitconfig': '[user]\n\tname = Tonde\n',
    '.config/nvim/init.lua': 'require("lazy").setup({})\n',
    '.config/nvim/lua/plugins/ui.lua': 'return {}\n',
    '.config/nvim/.git/HEAD': 'ref: refs/heads/main\n',
    '.claude/settings.json': '{"env":{}}',
    '.claude/agents/reviewer.md': '---\nname: reviewer\n---\n',
  });
  const r = scan({ home, platform: 'darwin', exec: null });
  const zsh = r.sources.find((s) => s.id === 'zsh');
  assert.equal(zsh.detected, true);
  assert.deepEqual(zsh.files.map((f) => f.path), ['~/.zshrc']);
  assert.equal(zsh.runsAtShellStart, true);
  const nvim = r.sources.find((s) => s.id === 'neovim');
  assert.deepEqual(nvim.files.map((f) => f.path).sort(), ['~/.config/nvim/init.lua', '~/.config/nvim/lua/plugins/ui.lua']);
  assert.ok(r.lookedAt.some((l) => l.path === '~/.bashrc' && l.result === 'absent'));
  assert.ok(r.lookedAt.some((l) => l.path === '~/.zshrc' && l.result === 'read'));
  assert.equal(r.sources.find((s) => s.id === 'powershell').skipped, 'not available on darwin');
  assert.ok(r.neverRead.includes('~/.ssh'));
});

test('never touches a blocked path, not even to stat it, and never writes', () => {
  const home = tempHome({ ...SECRETY, '.zshrc': 'x\n', '.config/nvim/init.lua': 'x\n' });
  const { api, touched } = spyFs(home);
  const r = scan({ home, platform: 'darwin', fsApi: api, exec: null });
  const bad = touched.filter((t) => t.path && blockedReason(`~/${t.path.split(path.sep).join('/')}`));
  assert.deepEqual(bad, []);
  // neverRead is the static policy list, not something the scan found.
  const all = JSON.stringify({ ...r, neverRead: [] });
  for (const rel of Object.keys(SECRETY)) assert.ok(!all.includes(rel.split('/').pop()) || rel.endsWith('config'), `${rel} appears in the scan result`);
  assert.ok(!all.includes('PRIVATE') && !all.includes('transcript') && !all.includes('secret command'));
});

test('SSH config only when explicitly picked', () => {
  const home = tempHome({ '.ssh/config': 'Host box\n  HostName 10.0.0.9\n', '.ssh/id_rsa': 'KEY' });
  assert.equal(scan({ home, platform: 'darwin', exec: null }).sources.find((s) => s.id === 'ssh-config'), undefined);
  const r = scan({ home, platform: 'darwin', exec: null, optIn: ['ssh-config'] });
  const ssh = r.sources.find((s) => s.id === 'ssh-config');
  assert.deepEqual(ssh.files.map((f) => f.path), ['~/.ssh/config']);
  assert.ok(!JSON.stringify(r).includes('KEY'));
});

test('~/.claude.json gives up only mcpServers', () => {
  const home = tempHome({
    '.claude.json': JSON.stringify({ oauthAccount: { emailAddress: 'tonde@acme.co.za', accountUuid: 'u-1' }, projects: { '/Users/tonde/secret-client': { history: ['do the thing'] } }, userID: 'abc', mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/sse' } } }),
  });
  const r = scan({ home, platform: 'darwin', exec: null });
  const f = r.sources.find((s) => s.id === 'claude-code').files.find((x) => x.path.startsWith('~/.claude.json'));
  assert.equal(f.path, '~/.claude.json#mcpServers');
  assert.deepEqual(JSON.parse(f.content), { mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/sse' } } });
  const all = JSON.stringify(r);
  for (const leak of ['oauthAccount', 'tonde@acme', 'secret-client', 'do the thing', 'userID']) assert.ok(!all.includes(leak), leak);
});

test('links: followed inside home, refused outside it or into a blocked path', () => {
  const outside = tempDir('borrow-outside-');
  fs.writeFileSync(path.join(outside, 'zshrc'), 'OUTSIDE\n');
  const home = tempHome({ 'dotfiles/zshrc': 'alias g=git\n', '.ssh/id_ed25519': 'KEY' }, {});
  fs.symlinkSync(path.join(home, 'dotfiles/zshrc'), path.join(home, '.zshrc'));
  fs.symlinkSync(path.join(outside, 'zshrc'), path.join(home, '.bashrc'));
  fs.mkdirSync(path.join(home, '.config/nvim'), { recursive: true });
  fs.symlinkSync(path.join(home, '.ssh/id_ed25519'), path.join(home, '.config/nvim/init.lua'));
  const r = scan({ home, platform: 'darwin', exec: null });
  assert.equal(r.sources.find((s) => s.id === 'zsh').files[0].content, 'alias g=git\n');
  assert.deepEqual(r.lookedAt.find((l) => l.path === '~/.bashrc'), { path: '~/.bashrc', result: 'skipped', reason: 'link points outside the home folder' });
  const all = JSON.stringify(r);
  assert.ok(!all.includes('OUTSIDE') && !all.includes('KEY'));
});

test('large and binary files are skipped', () => {
  const home = tempHome({ '.zshrc': 'x'.repeat(300 * 1024), '.bashrc': 'a\0b' });
  const r = scan({ home, platform: 'darwin', exec: null });
  assert.equal(r.lookedAt.find((l) => l.path === '~/.zshrc').reason, 'larger than 256 KB');
  assert.equal(r.lookedAt.find((l) => l.path === '~/.bashrc').reason, 'binary file');
});

test('item lists: files parsed, only allow-listed commands run', () => {
  const home = tempHome({
    '.vscode/extensions/extensions.json': JSON.stringify([{ identifier: { id: 'esbenp.prettier-vscode' }, version: '11.0.0' }]),
    '.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'commit-commands@claude-plugins-official': {} } }),
  });
  const ran = [];
  const exec = (argv) => {
    ran.push(argv.join(' '));
    if (argv[0] === 'brew' && argv[1] === 'leaves') return 'fzf\nripgrep\n';
    if (argv[0] === 'npm') return JSON.stringify({ dependencies: { typescript: { version: '5.6.2' } } });
    return '';
  };
  const r = scan({ home, platform: 'darwin', exec });
  assert.deepEqual(r.sources.find((s) => s.id === 'homebrew').items.filter((i) => i.kind === 'brew-formula').map((i) => i.name), ['fzf', 'ripgrep']);
  assert.deepEqual(r.sources.find((s) => s.id === 'npm-global').items, [{ kind: 'npm-global', name: 'typescript', version: '5.6.2' }]);
  assert.deepEqual(r.sources.find((s) => s.id === 'vscode').items, [{ kind: 'vscode-extension', name: 'esbenp.prettier-vscode', version: '11.0.0' }]);
  assert.deepEqual(r.sources.find((s) => s.id === 'claude-code').items, [{ kind: 'claude-plugin', name: 'commit-commands@claude-plugins-official' }]);
  for (const c of ran) assert.ok(EXEC_ALLOWED.has(c), c);
});

test('blocklist: names and folders', () => {
  for (const p of ['~/.ssh/id_rsa', '~/.ssh/config', '~/.aws/config', '~/.env', '~/.env.local', '~/proj/prod.env', '~/.zsh_history', '~/.config/fish/fish_history', '~/.netrc', '~/key.pem', '~/.git-credentials',
    '~/.claude/projects/x/y.jsonl', '~/.claude/.credentials.json', '~/Library/Keychains/login.keychain-db', '~/Library/Application Support/Google/Chrome/Default/Cookies', '~/.config/nvim/lua/secrets.lua', '~/../etc/passwd', '~/.config/../../x', '~foo/.zshrc', '/etc/passwd', '~/.kube/config']) {
    assert.ok(blockedReason(p), p);
  }
  for (const p of ['~/.zshrc', '~/.gitconfig', '~/.config/nvim/init.lua', '~/.claude/settings.json', '~/.npmrc', '~/.config/gh/config.yml', '~/.tmux.conf']) assert.equal(blockedReason(p), null, p);
  assert.equal(blockedReason('~/.ssh/config', { sshConfig: true }), null);
});

// ── review round ────────────────────────────────────────────────────────────
const readPaths = (r) => r.sources.flatMap((s) => s.files.map((f) => f.path));

test('M4: blocklist folds case and Unicode forms as APFS does, and checks a backslash both ways', () => {
  for (const p of ['~/.ſsh/config', '~/.Kube', '~/.SSH/id_ed25519', '~/.Ssh/config', '~/.Kube/config', '~/.config/nvim/secrets\\..']) assert.ok(blockedReason(p), p);
  assert.equal(blockedReason('~/.config/nvim/init.lua'), null);
});

test('M4: a link in a folder on the path (~/.config/gh -> ~/.aws) is checked hop by hop', () => {
  const home = tempHome({ '.aws/config.yml': 'aws_secret_access_key: AWSSECRETVALUE\n' });
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  fs.symlinkSync(path.join(home, '.aws'), path.join(home, '.config/gh'));
  const r = scan({ home, platform: 'darwin', exec: null });
  assert.ok(!readPaths(r).includes('~/.config/gh/config.yml'));
  assert.deepEqual(r.lookedAt.find((l) => l.path === '~/.config/gh/config.yml'), { path: '~/.config/gh/config.yml', result: 'skipped', reason: 'never read: ~/.aws' });
  assert.ok(!JSON.stringify(r).includes('AWSSECRETVALUE'));
});

test('M4: a link to a case-folded blocked name is refused (APFS opens ~/.ſsh as ~/.ssh)', () => {
  const home = tempHome({ '.ssh/config': 'Host box\n  HostName SSHCONFIGBODY\n' });
  fs.mkdirSync(path.join(home, '.config/gh'), { recursive: true });
  fs.symlinkSync(path.join(home, '.ſsh', 'config'), path.join(home, '.config/gh/config.yml'));
  const r = scan({ home, platform: 'darwin', exec: null });
  assert.ok(!JSON.stringify(r).includes('SSHCONFIGBODY'));
  assert.match(r.lookedAt.find((l) => l.path === '~/.config/gh/config.yml').reason, /never read: ~\/\.ssh|SSH config/);
});

test('M4: a file with another hard link is skipped (its other name may be blocked)', () => {
  const home = tempHome({ '.aws/credentials': '[default]\nHARDLINKED\n' });
  fs.mkdirSync(path.join(home, '.config/mise'), { recursive: true });
  fs.linkSync(path.join(home, '.aws/credentials'), path.join(home, '.config/mise/config.toml'));
  const r = scan({ home, platform: 'darwin', exec: null });
  assert.equal(r.lookedAt.find((l) => l.path === '~/.config/mise/config.toml').reason, 'has other hard links');
  assert.ok(!JSON.stringify(r).includes('HARDLINKED'));
});

test('L5: links into a blocked folder never stat the target, so existence does not leak', () => {
  const home = tempHome({ '.ssh/id_ed25519': 'KEY' });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(path.join(home, '.ssh/nope'), path.join(home, '.claude/CLAUDE.md'));
  fs.symlinkSync(path.join(home, '.ssh/id_ed25519'), path.join(home, '.claude/keybindings.json'));
  // Record each path exactly as touched (spyFs names a link by its target).
  const real = fs.realpathSync(home);
  const touched = [];
  const api = { ...fs };
  for (const n of ['lstatSync', 'statSync', 'readFileSync', 'readdirSync', 'realpathSync', 'readlinkSync', 'openSync']) api[n] = (p, ...x) => { touched.push({ op: n, path: path.relative(real, String(p)) }); return fs[n](p, ...x); };
  const r = scan({ home, platform: 'darwin', fsApi: api, exec: null });
  const a = r.lookedAt.find((l) => l.path === '~/.claude/CLAUDE.md');
  const b = r.lookedAt.find((l) => l.path === '~/.claude/keybindings.json');
  assert.deepEqual({ ...a, path: '' }, { ...b, path: '' });
  assert.equal(a.reason, 'never read: ~/.ssh');
  assert.deepEqual(touched.filter((t) => t.path.split(path.sep)[0] === '.ssh'), []);
});

test('L4: files are read through a descriptor that must be the file that was checked', () => {
  const home = tempHome({ '.zshrc': 'alias a=b\n' });
  const swapped = { ...fs, fstatSync: (fd) => ({ ...fs.fstatSync(fd), ino: -1, dev: fs.fstatSync(fd).dev, isFile: () => true }) };
  const r = scan({ home, platform: 'darwin', fsApi: swapped, exec: null, only: ['zsh'] });
  assert.equal(r.lookedAt.find((l) => l.path === '~/.zshrc').reason, 'changed while it was being read');
  assert.deepEqual(readPaths(r), []);
});

test('M4: a hard link created after the path check is rejected before reading bytes', () => {
  const home = tempHome({ '.zshrc': 'NOT_FOR_SHARING\n' });
  fs.mkdirSync(path.join(home, '.aws'));
  let bytesRead = 0;
  const api = {...fs,
    openSync: (p, ...args) => { fs.linkSync(p, path.join(home, '.aws/credentials')); return fs.openSync(p, ...args); },
    readSync: (...args) => { bytesRead++; return fs.readSync(...args); },
  };
  const result = scan({home, platform:'darwin', fsApi:api, exec:null, only:['zsh']});
  assert.equal(result.lookedAt.find(l => l.path === '~/.zshrc').reason, 'has other hard links');
  assert.equal(bytesRead, 0);
  assert.deepEqual(readPaths(result), []);
});

test('F4: unreadable files, a missing home and garbage command output do not throw', () => {
  const home = tempHome({ '.zshrc': 'x\n' });
  const denied = { ...fs, openSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
  const r = scan({ home, platform: 'darwin', fsApi: denied, exec: null, only: ['zsh'] });
  assert.equal(r.lookedAt.find((l) => l.path === '~/.zshrc').reason, 'could not be read');
  const gone = scan({ home: path.join(home, 'no-such-home'), platform: 'darwin', exec: null });
  assert.deepEqual(gone.sources, []);
  assert.deepEqual(gone.lookedAt, [{ path: '~', result: 'absent' }]);
  const exec = (argv) => {
    if (argv[0] === 'npm') return 'npm WARN not json {';
    if (argv[1] === 'tap') throw Object.assign(new Error('t'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
    if (argv[1] === 'list') throw Object.assign(new Error('x'), { status: 2 });
    throw Object.assign(new Error('nope'), { code: 'ENOENT' });
  };
  const g = scan({ home, platform: 'darwin', exec, only: ['homebrew', 'npm-global'] });
  const at = (cmd) => g.lookedAt.find((l) => l.path === `$ ${cmd}`);
  assert.deepEqual(at('npm ls -g --depth=0 --json'), { path: '$ npm ls -g --depth=0 --json', result: 'skipped', reason: 'could not parse its output' });
  assert.equal(at('brew tap').reason, 'timed out');
  assert.equal(at('brew list --cask -1').reason, 'command failed');
  assert.equal(at('brew leaves --installed-on-request').result, 'absent');
});

test('F5: a large ~/.claude.json still gives up its mcpServers, and says only that is used', () => {
  const big = { projects: { '/x': { history: ['y'.repeat(400 * 1024)] } }, mcpServers: { a: { command: 'npx' } } };
  const home = tempHome({ '.claude.json': JSON.stringify(big) });
  const r = scan({ home, platform: 'darwin', exec: null, only: ['claude-code'] });
  const f = r.sources[0].files.find((x) => x.path === '~/.claude.json#mcpServers');
  assert.deepEqual(JSON.parse(f.content), { mcpServers: { a: { command: 'npx' } } });
  assert.equal(f.format, 'json');
  assert.deepEqual(r.lookedAt.find((l) => l.path === '~/.claude.json'), { path: '~/.claude.json', result: 'read', reason: 'only mcpServers is used' });
  const none = scan({ home: tempHome({ '.claude.json': '{"userID":"u"}' }), platform: 'darwin', exec: null, only: ['claude-code'] });
  assert.equal(none.sources[0].files.length, 0);
  assert.equal(none.lookedAt.find((l) => l.path === '~/.claude.json').reason, 'no mcpServers in it');
});

test('H2: file records carry their format (registry override, else inferred)', () => {
  const home = tempHome({ '.bash_profile': 'export A=1\n', '.bashrc': 'x\n', '.claude/settings.json': '{}' });
  const r = scan({ home, platform: 'darwin', exec: null, only: ['bash', 'claude-code'] });
  const f = Object.fromEntries(r.sources.flatMap((s) => s.files).map((x) => [x.path, x]));
  assert.equal(f['~/.bash_profile'].format, 'shell');
  assert.equal(f['~/.bashrc'].format, 'shell');
  assert.equal(f['~/.claude/settings.json'].format, 'json');
  assert.deepEqual(f['~/.claude/settings.json'].sensitiveKeys, ['env', 'headers']);
});

test('F6: the registry is sound: unique ids, known parsers, ~ paths, nothing blocked it does not allow', () => {
  assert.equal(new Set(SOURCES.map((s) => s.id)).size, SOURCES.length);
  const exec = new Set();
  for (const s of SOURCES) {
    const paths = [...(s.files || []), ...(s.dirs || [])].map((e) => (typeof e === 'string' ? e : e.path));
    for (const i of s.items || []) {
      assert.ok(PARSERS[i.parse || 'lines'], `${s.id}: parser ${i.parse}`);
      if (i.path) paths.push(i.path);
      if (i.from === 'exec') exec.add(i.cmd.join(' '));
    }
    paths.push(...Object.keys(s.extract || {}));
    for (const p of paths) {
      assert.match(p, /^~\//, `${s.id}: ${p}`);
      const allowed = (s.allowBlocked || []).includes(p);
      assert.equal(blockedReason(p, { sshConfig: allowed }), null, `${s.id}: ${p} is blocked`);
    }
    for (const e of [...(s.files || []), ...(s.dirs || [])]) if (typeof e !== 'string') for (const pl of e.platforms) assert.ok(s.platforms.includes(pl), `${s.id}: ${e.path} on ${pl}`);
    for (const k of Object.keys(s.format || {})) assert.ok(paths.includes(k), `${s.id}: format for unknown path ${k}`);
  }
  assert.deepEqual([...EXEC_ALLOWED].sort(), [...exec].sort());
});

test('F7/F8: per-platform paths: Windows reads AppData, macOS never looks there', () => {
  const home = tempHome({ 'AppData/Roaming/Code/User/settings.json': '{"editor.fontSize": 14}' });
  const w = scan({ home, platform: 'win32', exec: null, only: ['vscode'] });
  assert.deepEqual(readPaths(w), ['~/AppData/Roaming/Code/User/settings.json']);
  const d = scan({ home, platform: 'darwin', exec: null, only: ['vscode'] });
  assert.ok(!d.lookedAt.some((l) => l.path.includes('AppData') || l.path.startsWith('~/.config/Code')));
});

test('F21/F24: depth and count limits are reported once; withheld names are counted, not named', () => {
  const files = { '.config/nvim/init.lua': 'x\n', '.config/nvim/lua/secrets.lua': 'S\n', '.config/nvim/lua/token.lua': 'T\n' };
  files['.config/nvim/a/b/c/d/e/deep.lua'] = 'deep\n';
  const home = tempHome(files);
  const r = scan({ home, platform: 'darwin', exec: null, only: ['neovim'] });
  assert.equal(r.lookedAt.find((l) => l.path === '~/.config/nvim').reason, '2 files withheld: the name looks sensitive');
  assert.deepEqual(r.lookedAt.find((l) => l.path === '~/.config/nvim/a/b/c/d/e'), { path: '~/.config/nvim/a/b/c/d/e', result: 'skipped', reason: 'more than 5 folders deep' });
  assert.ok(!JSON.stringify(r).includes('secrets.lua') && !JSON.stringify(r).includes('token.lua'));
  const many = {};
  for (let i = 0; i < 205; i++) many[`.config/nvim/lua/f${String(i).padStart(3, '0')}.lua`] = 'x\n';
  const c = scan({ home: tempHome(many), platform: 'darwin', exec: null, only: ['neovim'] });
  assert.equal(c.sources[0].files.length, 200);
  assert.equal(c.lookedAt.filter((l) => /more than 200 files/.test(l.reason || '')).length, 1);
});
