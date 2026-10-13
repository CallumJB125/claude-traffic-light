// Seeded fuzz for the dotfile scrubber (src/borrow/scrub.js), written from
// src/borrow/README.md alone. Each iteration plants one fake secret in a random
// context (template x quoting x noise x position x CRLF) and asserts the output
// leaks nothing, or that the file was blocked. Blocked is safe but useless, so
// the blocked rate is capped at 10%.
//
//   BORROW_FUZZ_SEED=<n|string>   default 0xB0771E (fixed, so CI is reproducible)
//   BORROW_FUZZ_N=<iterations>    default 1500
//   BORROW_FUZZ_ONLY=<iteration>  replay a single iteration
//   BORROW_FUZZ_MAX_BLOCKED=0.10  blocked-rate ceiling
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./fixtures/borrow/seedkit.js');
const { SECRET_PATTERNS } = require('../board/shared/secret-patterns.mjs');

const SEED = kit.seedFrom(process.env.BORROW_FUZZ_SEED, 0xB0771E);
const N = Number(process.env.BORROW_FUZZ_N || 1500);
const ONLY = process.env.BORROW_FUZZ_ONLY == null ? null : Number(process.env.BORROW_FUZZ_ONLY);
const MAX_BLOCKED = Number(process.env.BORROW_FUZZ_MAX_BLOCKED || 0.10);

let scrubFile = null;
let loadError = null;
try {
  ({ scrubFile } = require(process.env.BORROW_SCRUB_MODULE || '../src/borrow/scrub.js'));
  if (typeof scrubFile !== 'function') loadError = 'src/borrow/scrub.js loaded but exports no scrubFile() function';
} catch (e) {
  loadError = e && e.code === 'MODULE_NOT_FOUND' && /scrub\.js/.test(String(e.message).split('\n')[0])
    ? 'src/borrow/scrub.js does not exist yet. The fuzz test needs the scrubber: scrubFile({path, content, format, machine}).'
    : `src/borrow/scrub.js failed to load: ${e && e.stack}`;
}

const { pick, int } = kit;
const chance = (r, p) => r() < p;
const hex40 = (r) => kit.take(r, kit.SETS.hex, 40);
const word = (r) => kit.take(r, kit.SETS.lower, int(r, 3, 9));

// ── key names ───────────────────────────────────────────────────────────────
const SECRET_KEYS = ['password', 'db_password', 'DB_PASSWORD', 'apiKey', 'api_key', 'API-KEY', 'clientSecret', 'client_secret', 'accessToken', 'auth_token', 'github_token', 'openai-api-key', 'privateKey', 'secret', 'passphrase', 'signingKey', 'license_key', 'sessionId', 'cookie'];
const ENV_KEYS = ['MY_SERVICE_TOKEN', 'STRIPE_WEBHOOK_SECRET', 'DB_PASSWORD', 'INTERNAL_API_KEY', 'ADMIN_PASSWORD', 'GITHUB_TOKEN', 'SLACK_SECRET', 'API_KEY', 'SERVICE_PRIVATE_KEY'];
// Neutral and "metadata-looking" names: a token under `path` or `command` is still a token.
const NEUTRAL_KEYS = ['PROXY', 'greeting', 'BUILD_NUMBER', 'theme', 'endpoint', 'notes', 'x-custom', 'LC_ALL', 'defaultModel', 'url', 'label', 'motd', 'tag',
  'path', 'file', 'command', 'helper', 'env', 'name', 'type', 'header', 'provider', 'source', 'mode', 'field', 'prompt', 'hint', 'scope', 'backend', 'store'];
const idOf = (k) => k.replace(/[^A-Za-z0-9_]/g, '_');
const gitKeyOf = (k) => k.replace(/[^A-Za-z0-9-]/g, '-');

// ── noise ───────────────────────────────────────────────────────────────────
// [line, mustKeep|null]. @@SLOT@@ are machine values, filled per profile.
const NOISE = {
  shell: [
    ['alias ll="ls -lah"'], ['export EDITOR=nvim'], ['export PATH="$HOME/.local/bin:$PATH"'], ['setopt HIST_IGNORE_DUPS'], ['bindkey -e'], ['plugins=(git z fzf)'],
    ['export LANG=en_US.UTF-8'], ['# load nvm'], ['[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"'], ['PROMPT="%n@%m %~ %# "'], [''],
    ['function mkcd() { mkdir -p "$1" && cd "$1"; }'], ['autoload -Uz compinit && compinit'], ['alias gs="git status"'],
    ['cd @@HOME@@/dev'], ['export PATH="@@HOME@@/bin:$PATH"'], ['# @@EMAIL@@'], ['export DEV_BOX=@@HOST@@'], ['alias work="ssh @@USER@@@@@TSHOST2@@"'],
    ['export ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"', '$ANTHROPIC_API_KEY'],
    ['export GH_TOKEN=$(security find-generic-password -s x -w)', '$(security find-generic-password -s x -w)'],
    ['export FIGMA_TOKEN="op://Private/x/credential"', 'op://Private/x/credential'],
  ],
  json: [
    ['"editor.fontSize": 14'], ['"theme": "dark"'], ['"name": "demo"'], ['"enabled": true'], ['"timeout": 30'], ['"model": "opus"'], ['"editor.tabSize": 2'],
    ['"cwd": "@@HOME@@/dev/app"'], ['"author": "@@EMAIL@@"'], ['"host": "@@HOST@@"'],
    ['"MAX_THINKING_TOKENS": "31999"', '"MAX_THINKING_TOKENS": "31999"'],
    ['"apiKeyHelper": "~/.claude/get-key.sh"', '~/.claude/get-key.sh'],
    ['"lazy.nvim": { "branch": "main", "commit": "@@SHA@@" }', '@@SHA@@'],
  ],
  toml: [
    ['theme = "dark"'], ['timeout = 30'], ['enabled = true'], ['name = "demo"'], ['cwd = "@@HOME@@/dev"'], ['email = "@@EMAIL@@"'],
    ['bearer_token_env_var = "GITHUB_PAT"', 'bearer_token_env_var = "GITHUB_PAT"'], ['rev = "@@SHA@@"', '@@SHA@@'],
  ],
  yaml: [
    ['name: demo'], ['timeout: 30'], ['theme: dark'], ['cwd: @@HOME@@/dev'], ['owner: @@EMAIL@@'], ['sha: @@SHA@@', '@@SHA@@'], ['key_ref: ${OPENAI_API_KEY}', '${OPENAI_API_KEY}'],
  ],
  ini: [
    ['editor = nvim'], ['pager = less'], ['user = @@USER@@'], ['email = @@EMAIL@@'], ['; comment'], ['host = @@IP@@'], ['password_file = ~/.config/x/pw', '~/.config/x/pw'],
  ],
  gitconfig: [
    ['\tautocrlf = input'], ['\teditor = nvim'], ['\temail = @@EMAIL@@'], ['\tname = @@NAME@@'], ['\thelper = osxkeychain', 'helper = osxkeychain'], ['\tsigningkey = ~/.ssh/id_ed25519.pub', '~/.ssh/id_ed25519.pub'],
  ],
  lua: [
    ['vim.opt.number = true'], ['vim.g.mapleader = " "'], ['local M = {}'], ['require("lazy").setup({})'], ['local root = "@@HOME@@/dev"'],
    ['{ "x/y", commit = "@@SHA@@" },', '@@SHA@@'],
  ],
  vim: [['set number'], ['set shiftwidth=2'], ['let mapleader = " "'], ['" @@EMAIL@@'], ['cd @@HOME@@/dev']],
  text: [['font_size 14'], ['set -g mouse on'], ['theme = catppuccin-mocha'], ['# @@EMAIL@@'], ['working-directory = @@HOME@@/dev']],
  npmrc: [['registry=https://registry.npmjs.org/', 'registry=https://registry.npmjs.org/'], ['save-exact=true'], ['email=@@EMAIL@@'], ['fund=false']],
  sshconfig: [['Host github.com', 'Host github.com'], ['    IdentityFile ~/.ssh/id_ed25519', 'IdentityFile ~/.ssh/id_ed25519'], ['    User @@USER@@'], ['    HostName @@IP@@'], ['    AddKeysToAgent yes']],
};

const PATHS = {
  shell: ['~/.zshrc', '~/.bashrc', '~/.zprofile', '~/.config/fish/config.fish', '~/.profile', '~/.config/zsh/aliases.zsh'],
  // ~/.claude.json as the scanner reports it: only its mcpServers, with the key after '#'.
  json: ['~/.claude/settings.json', '~/.claude.json#mcpServers', '~/.config/app/config.json'],
  jsonc: ['~/Library/Application Support/Code/User/settings.json', '~/Library/Application Support/Code/User/keybindings.json'],
  toml: ['~/.codex/config.toml', '~/.config/starship.toml', '~/.config/alacritty/alacritty.toml', '~/.config/mise/config.toml'],
  yaml: ['~/.config/gh/hosts.yml', '~/.aider.conf.yml', '~/.config/lazygit/config.yml'],
  ini: ['~/.config/app/settings.ini', '~/.config/app/app.conf'],
  gitconfig: ['~/.gitconfig', '~/.config/git/config'],
  lua: ['~/.config/nvim/init.lua', '~/.config/wezterm/wezterm.lua'],
  vim: ['~/.vimrc'],
  text: ['~/.tmux.conf', '~/.config/kitty/kitty.conf', '~/.config/ghostty/config'],
  npmrc: ['~/.npmrc'],
  sshconfig: ['~/.ssh/config'],
};
const COMMENT = { shell: '#', toml: '#', yaml: '#', ini: ';', gitconfig: '#', lua: '--', vim: '"', text: '#', npmrc: ';', sshconfig: '#', jsonc: '//' };

// ── templates ───────────────────────────────────────────────────────────────
// make(c) gets { K, id, git, V, o, cl, r } and returns the secret-bearing text.
// kinds: which kind classes the template supports. 'keyed' kinds are only found
// through their key name, so a template without a key next to the value excludes them.
const Q = { none: ['', ''], dq: ['"', '"'], sq: ["'", "'"], bt: ['`', '`'] };
const ALL = ['token', 'frag', 'keyed'];
const NOKEY = ['token', 'frag'];
const T = [];
const t = (name, fmt, opts, make) => T.push({ name, section: !!opts.section, fmt: [].concat(fmt), q: opts.q || ['none'], kinds: opts.kinds || ALL, ml: !!opts.ml, spaceOk: !!opts.spaceOk, yaml: !!opts.yaml, make });

// shell
t('sh.export', 'shell', { q: ['none', 'dq', 'sq', 'bt'] }, (c) => `export ${c.id}=${c.o}${c.V}${c.cl}`);
t('sh.assign', 'shell', { q: ['none', 'dq', 'sq'] }, (c) => `${c.id}=${c.o}${c.V}${c.cl}`);
t('sh.fish-set', 'shell', { q: ['none', 'dq', 'sq'] }, (c) => `set -gx ${c.id} ${c.o}${c.V}${c.cl}`);
t('sh.setenv', 'shell', { q: ['none', 'dq'] }, (c) => `${pick(c.r, ['setenv', 'launchctl setenv'])} ${c.id} ${c.o}${c.V}${c.cl}`);
t('sh.alias-curl', 'shell', { kinds: NOKEY }, (c) => `alias ${word(c.r)}='curl -s -H "X-Api-Key: ${c.V}" https://api.example.com/v1'`);
t('sh.alias-escaped', 'shell', { kinds: NOKEY }, (c) => `alias ${word(c.r)}="curl -H \\"X-Custom: ${c.V}\\" https://api.example.com"`);
t('sh.function-curl', 'shell', { kinds: NOKEY }, (c) => `${word(c.r)}() {\n  curl -sS -H "Authorization: ${c.kind === 'token' ? pick(c.r, ['Bearer ', 'token ', '']) : ''}${c.V}" "https://api.example.com/$1"\n}`);
t('sh.continuation-next-line', 'shell', { q: ['none', 'dq'], kinds: ['token', 'frag', 'keyed'] }, (c) => `export ${c.id}=\\\n  ${c.o}${c.V}${c.cl}`);
t('sh.curl-continued', 'shell', { kinds: NOKEY }, (c) => `curl -sS \\\n  -H "X-Auth: ${c.V}" \\\n  https://api.example.com/v1/items`);
t('sh.heredoc', 'shell', { ml: true }, (c) => `cat > "$HOME/.app.conf" <<'EOF'\n${c.id}=${c.V}\nEOF`);
t('sh.default-expansion', 'shell', {}, (c) => `export ${c.id}="\${${c.id}:-${c.V}}"`);
t('sh.inline-env', 'shell', { q: ['none', 'dq', 'sq'] }, (c) => `${c.id}=${c.o}${c.V}${c.cl} npm run build`);
t('sh.docker-e', 'shell', { q: ['none', 'dq'] }, (c) => `docker run -e ${c.id}=${c.o}${c.V}${c.cl} --rm acme/app:latest`);
t('sh.git-clone', 'shell', { kinds: ['token'] }, (c) => `git clone https://x-access-token:${c.V}@github.com/acme/app.git`);
t('sh.if-then', 'shell', { q: ['none', 'dq', 'sq'] }, (c) => `if [ -z "$${c.id}" ]; then export ${c.id}=${c.o}${c.V}${c.cl}; fi`);
t('sh.bash-c-escaped', 'shell', {}, (c) => `bash -c "export ${c.id}=\\"${c.V}\\" && ./run.sh"`);
// json
t('json.flat', ['json', 'jsonc'], {}, (c) => `"${c.K}": "${c.V}"`);
t('json.nested3', ['json', 'jsonc'], {}, (c) => `"a": {\n    "b": {\n      "c": {\n        "${c.K}": "${c.V}"\n      }\n    }\n  }`);
t('json.env-block', ['json', 'jsonc'], {}, (c) => `"env": { "${c.K}": "${c.V}", "LOG_LEVEL": "debug" }`);
t('json.secret-in-key', ['json', 'jsonc'], {}, (c) => `"env": { "prefix_${c.V.slice(0, 12)}": "${c.V}" }`);
t('json.mcp-server', ['json', 'jsonc'], {}, (c) => `"mcpServers": {\n    "x": {\n      "command": "npx",\n      "args": ["-y", "pkg"],\n      "env": { "${c.K}": "${c.V}" }\n    }\n  }`);
t('json.headers-bearer', ['json', 'jsonc'], { kinds: ['token'] }, (c) => `"headers": { "Authorization": "Bearer ${c.V}" }`);
t('json.command-escaped', ['json', 'jsonc'], { kinds: NOKEY }, (c) => `"command": "curl -H \\"X-Key: ${c.V}\\" https://x.io"`);
t('json.args-array', ['json', 'jsonc'], { kinds: ['token'] }, (c) => `"args": ["--flag", "${c.V}", "--other"]`);
t('json.array-of-objects', ['json', 'jsonc'], {}, (c) => `"servers": [{ "name": "a", "${c.K}": "${c.V}" }]`);
t('json.stringified', ['json', 'jsonc'], { kinds: ['token'] }, (c) => `"OPENAPI_MCP_HEADERS": "{\\"Authorization\\": \\"Bearer ${c.V}\\"}"`);
t('json.commented-out', 'jsonc', {}, (c) => `// "${c.K}": "${c.V}",`);
// toml
t('toml.key', 'toml', { q: ['dq', 'sq'] }, (c) => `${c.id} = ${c.o}${c.V}${c.cl}`);
t('toml.inline-table', 'toml', {}, (c) => `env = { ${c.id} = "${c.V}", OTHER = "1" }`);
t('toml.table', 'toml', { section: true,}, (c) => `[mcp_servers.x.env]\n${c.id} = "${c.V}"`);
t('toml.secret-in-key', 'toml', { section: true }, (c) => `[env]\n"prefix_${c.V.slice(0, 12)}" = "${c.V}"`);
t('toml.array', 'toml', { kinds: ['token'] }, (c) => `args = [\n  "--serve",\n  "${c.V}",\n]`);
t('toml.multiline-string', 'toml', { ml: true }, (c) => `${c.id} = """\n${c.V}\n"""`);
t('toml.http-headers', 'toml', { kinds: ['token'] }, (c) => `http_headers = { "Authorization" = "Bearer ${c.V}" }`);
// yaml
t('yaml.plain', 'yaml', { q: ['none', 'dq', 'sq'], spaceOk: true, yaml: true }, (c) => `${c.K}: ${c.o}${c.V}${c.cl}`);
t('yaml.block-scalar', 'yaml', { ml: true }, (c) => `${c.K}: |\n${c.V.split('\n').map((l) => `  ${l}`).join('\n')}`);
t('yaml.tagged-block', 'yaml', { ml: true }, (c) => `${c.K}: !!str &fixture |2-\n${c.V.split('\n').map((l) => `  ${l}`).join('\n')}`);
t('yaml.anchored-block', 'yaml', { ml: true }, (c) => `- "${c.K}": &fixture !!str >+2\n${c.V.split('\n').map((l) => `    ${l}`).join('\n')}`);
t('yaml.folded', 'yaml', { kinds: NOKEY }, (c) => `run: >-\n  curl -sS -H "X-Token: ${c.V}" \\\n  https://x.example.com`);
t('yaml.flow-map', 'yaml', { spaceOk: true, yaml: true }, (c) => `{ ${c.K}: ${c.V}, other: 1 }`);
t('yaml.env-list', 'yaml', { q: ['none', 'dq'] }, (c) => `env:\n  - ${c.id}=${c.o}${c.V}${c.cl}`);
t('yaml.nested3', 'yaml', { spaceOk: true, yaml: true }, (c) => `a:\n  b:\n    c:\n      ${c.K}: ${c.V}`);
// ini / gitconfig / npmrc / sshconfig
t('ini.section', 'ini', { section: true, q: ['none', 'dq'], spaceOk: true }, (c) => `[section]\n${c.id} = ${c.o}${c.V}${c.cl}`);
t('ini.commented', 'ini', { spaceOk: true }, (c) => `; ${c.id} = ${c.V}`);
t('ini.pypirc', 'ini', { section: true, kinds: ['token', 'keyed'], spaceOk: true }, (c) => `[pypi]\nusername = __token__\npassword = ${c.V}`);
t('git.key', 'gitconfig', { section: true, q: ['none', 'dq'], spaceOk: true }, (c) => `[github]\n\t${c.git} = ${c.o}${c.V}${c.cl}`);
t('git.url-insteadof', 'gitconfig', { section: true, kinds: ['token'] }, (c) => `[url "https://x-access-token:${c.V}@github.com/"]\n\tinsteadOf = https://github.com/`);
t('git.extraheader', 'gitconfig', { section: true, kinds: ['token'] }, (c) => `[http]\n\textraheader = Authorization: Bearer ${c.V}`);
t('git.credential-helper', 'gitconfig', { section: true, kinds: ALL, spaceOk: true }, (c) => `[credential]\n\thelper = !f() { echo "password=${c.V}"; }; f`);
t('npmrc.authtoken', 'npmrc', { kinds: ['token', 'keyed'] }, (c) => `//registry.npmjs.org/:_authToken=${c.V}`);
t('ssh.setenv', 'sshconfig', { section: true, spaceOk: true }, (c) => `Host mini\n    SetEnv ${c.id}=${c.V}`);
t('ssh.proxycommand', 'sshconfig', { section: true, kinds: ['token'] }, (c) => `Host jump\n    ProxyCommand sh -c 'curl -H "Authorization: Bearer ${c.V}" https://gw.example.com/%h'`);
// lua / vim / text
t('lua.vim-env', 'lua', { q: ['dq', 'sq'] }, (c) => `vim.env.${c.id} = ${c.o}${c.V}${c.cl}`);
t('lua.table', 'lua', { q: ['dq', 'sq'] }, (c) => `local opts = { ${c.id} = ${c.o}${c.V}${c.cl}, timeout = 500 }`);
t('lua.setenv', 'lua', { kinds: NOKEY }, (c) => `vim.fn.setenv("${c.K}", "${c.V}")`);
t('lua.long-string', 'lua', { ml: true }, (c) => `local ${c.id} = [[${c.V}]]`);
t('lua.wezterm-env', 'lua', { q: ['sq', 'dq'] }, (c) => `config.set_environment_variables = { ${c.id} = ${c.o}${c.V}${c.cl} }`);
t('vim.let-env', 'vim', { q: ['sq', 'dq'] }, (c) => `let $${c.id} = ${c.o}${c.V}${c.cl}`);
t('text.tmux-setenv', 'text', { kinds: NOKEY, q: ['none', 'dq'] }, (c) => `set-environment -g ${c.id} ${c.o}${c.V}${c.cl}`);
t('text.kitty-env', 'text', { q: ['none'], kinds: ALL, spaceOk: true }, (c) => `env ${c.id}=${c.V}`);
t('text.ghostty-env', 'text', { q: ['none'], kinds: ALL, spaceOk: true }, (c) => `env = ${c.id}=${c.V}`);
t('text.tmux-run-shell', 'text', { kinds: NOKEY }, (c) => `bind-key C-w run-shell "curl -s -H 'X-Auth: ${c.V}' https://hooks.example.com/n"`);
// comments, every format (keyed kinds keep their key next to the value)
t('comment.key-value', ['shell', 'toml', 'yaml', 'ini', 'gitconfig', 'lua', 'vim', 'text', 'npmrc', 'sshconfig', 'jsonc'], { spaceOk: true }, (c) => `${COMMENT[c.fmt]} ${c.K}=${c.V}`);
t('comment.old-export', ['shell', 'text'], {}, (c) => `${COMMENT[c.fmt]} export ${c.id}="${c.V}"  # rotate me`);
t('comment.todo', ['shell', 'toml', 'yaml', 'ini', 'lua', 'text', 'jsonc'], { kinds: NOKEY, spaceOk: true }, (c) => `${COMMENT[c.fmt]} TODO rotate ${c.V} before release`);

const FMT_NOISE = { jsonc: 'json', npmrc: 'npmrc' };

// ── one iteration ───────────────────────────────────────────────────────────
// PuTTY keys and multi-line netrc only exist across lines, and an args-array
// secret only inside an array; the corpus covers them (heredoc, claude.json).
const MULTI_LINE_ONLY = new Set(['private_key_escaped', 'putty_key', 'netrc_line', 'cli_secret_arg']);
const KINDS = [...Object.keys(kit.GEN).filter((k) => !MULTI_LINE_ONLY.has(k))];

function buildCase(i) {
  const r = kit.mulberry32((SEED + Math.imul(i + 1, 0x9E3779B1)) >>> 0);
  const machine = pick(r, kit.MACHINES);
  const kind = pick(r, KINDS);
  const cls = kit.kindClass(kind);
  const isPem = kind === 'private_key';
  const pool = T.filter((tp) => (isPem ? tp.ml || tp.kinds === ALL : tp.kinds.includes(cls)));
  const tpl = pick(r, pool);
  const fmt = pick(r, tpl.fmt);
  const useMl = isPem && tpl.ml;
  const secret = kit.makeSecret(useMl || !isPem ? kind : 'private_key_escaped', r, machine);
  secret.kind = kind;

  const K = cls === 'keyed' ? (kind === 'env_secret' ? pick(r, ENV_KEYS) : pick(r, SECRET_KEYS)) : pick(r, NEUTRAL_KEYS);
  let V = cls === 'frag' ? kit.FRAG[kind](secret.value) : secret.value;
  const qName = pick(r, tpl.q);
  let [o, cl] = Q[qName];
  const needsQuote = (/\s/.test(V) && !tpl.spaceOk) || (tpl.yaml && /:\s|\s#/.test(V));
  if (needsQuote && !o) [o, cl] = Q.dq;
  if (qName === 'bt' && V.includes('`')) [o, cl] = Q.dq;
  const body = tpl.make({ K, id: idOf(K), git: gitKeyOf(K), V, o, cl, r, kind: cls, fmt });
  if (!secret.rand.every((seg) => body.includes(seg))) throw new Error(`test bug: template ${tpl.name} lost the secret`);

  const slots = kit.slotsOf(machine);
  const sha = hex40(r);
  const fillNoise = (s) => s.replace(/@@SHA@@/g, sha).replace(/@@([A-Z0-9]+)@@/g, (_, n) => slots[n]);
  const pool2 = NOISE[FMT_NOISE[fmt] || fmt] || NOISE.text;
  const makeNoise = (n, plain = false) => Array.from({ length: n }, () => pick(r, plain ? pool2.filter((x) => !x[1]) : pool2));
  const lastLine = chance(r, 0.25);
  const before = makeNoise(int(r, 0, 8));
  const after = lastLine ? [] : makeNoise(int(r, 0, 8), tpl.section);
  const keeps = [];
  const emit = (n) => { const [line, keep] = n; if (keep) keeps.push(fillNoise(keep)); return fillNoise(line); };

  let text;
  if (fmt === 'json' || fmt === 'jsonc') {
    const entries = [...before.map(emit), body, ...after.map(emit)];
    const jc = fmt === 'jsonc';
    const parts = entries.map((e) => (jc && chance(r, 0.15) ? `// ${word(r)} ${word(r)}\n  ${e}` : e));
    const trailing = jc && chance(r, 0.3);
    text = `{\n  ${parts.join(',\n  ')}${trailing ? ',' : ''}\n}`;
    if (fmt === 'json') JSON.parse(text);
  } else if (fmt === 'ini' || fmt === 'gitconfig') {
    text = [`[core]`, ...before.map(emit), body, ...after.map(emit)].join('\n');
  } else {
    text = [...before.map(emit), body, ...after.map(emit)].join('\n');
  }
  if (!lastLine || chance(r, 0.5)) text += '\n';
  else if (lastLine && fmt !== 'json' && fmt !== 'jsonc') text = text.replace(/\n+$/, '');
  if (chance(r, 0.3)) text = text.replace(/\n/g, '\r\n');
  if (chance(r, 0.05)) text = `\uFEFF${text}`;

  const explicit = chance(r, 0.5);
  const format = explicit ? { shell: 'shell', json: 'json', jsonc: 'jsonc', toml: 'toml', yaml: 'yaml', ini: 'ini', gitconfig: 'gitconfig', lua: 'lua', vim: 'vim', text: 'text', npmrc: 'npmrc', sshconfig: 'sshconfig' }[fmt] : undefined;
  return { i, r, machine, kind, tpl: tpl.name, fmt, path: pick(r, PATHS[fmt]), format, text, secret, keeps };
}

const cloneMachine = (m) => ({ home: m.home, user: m.user, hostname: m.hostname, emails: [...m.emails], names: [...m.names] });
const args = (c, text) => ({ path: c.path, content: text, ...(c.format ? { format: c.format } : {}), machine: cloneMachine(c.machine) });

// A case fails when scrubbing it leaks, throws, or returns a malformed result.
function judge(c, text) {
  const { res, threw } = kit.callScrub(scrubFile, args(c, text));
  if (threw) return { bad: [{ type: 'THREW', detail: threw }] };
  if (res.status !== 'ok' && res.status !== 'blocked') return { bad: [{ type: 'SHAPE', detail: `status ${JSON.stringify(res.status)}` }] };
  const bad = [];
  for (const p of kit.findProblems({ out: kit.sideChannels(res), secrets: [c.secret], machine: c.machine })) bad.push({ ...p, type: `${p.type}@reason/records` });
  if (res.status === 'blocked') {
    if (typeof res.reason !== 'string' || !res.reason) bad.push({ type: 'SHAPE', detail: 'blocked without a reason' });
    if (typeof res.content === 'string') for (const p of kit.findProblems({ out: res.content, secrets: [c.secret], machine: c.machine })) bad.push({ ...p, type: `${p.type}@blocked-content` });
    return { bad, blocked: true, reason: res.reason };
  }
  if (typeof res.content !== 'string') return { bad: [...bad, { type: 'SHAPE', detail: 'ok without content string' }] };
  for (const p of kit.findProblems({ out: res.content, secrets: [c.secret], machine: c.machine })) bad.push(p);
  for (const k of c.keeps) if (text.includes(k) && !res.content.includes(k)) bad.push({ type: 'KEPT-LOST', kind: '', detail: 'must-keep string missing from output', text: k });
  return { bad, blocked: false };
}

// Greedy line-deletion shrink: smallest file that still misbehaves the same way.
function shrink(c, firstType) {
  let lines = c.text.split('\n');
  const still = (ls) => { const out = judge(c, ls.join('\n')); return out.bad.some((b) => b.type === firstType); };
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let k = lines.length - 1; k >= 0; k--) {
      if (lines.length <= 1) break;
      const next = lines.slice(0, k).concat(lines.slice(k + 1));
      if (still(next)) { lines = next; changed = true; }
    }
    if (!changed) break;
  }
  return lines.join('\n');
}

let cached = null;
function runAll() {
  if (cached) return cached;
  const t0 = Date.now();
  const failures = [];
  let blocked = 0;
  let ran = 0;
  const blockedBy = new Map();
  const reasons = new Map();
  const kindsSeen = new Set();
  const range = ONLY == null ? Array.from({ length: N }, (_, i) => i) : [ONLY];
  for (const i of range) {
    const c = buildCase(i);
    kindsSeen.add(c.kind);
    const out = judge(c, c.text);
    ran++;
    if (out.blocked) {
      blocked++;
      blockedBy.set(c.kind, (blockedBy.get(c.kind) || 0) + 1);
      blockedBy.set(`tpl:${c.tpl}`, (blockedBy.get(`tpl:${c.tpl}`) || 0) + 1);
      const why = String(out.reason || '').slice(0, 90);
      reasons.set(why, (reasons.get(why) || 0) + 1);
    }
    if (out.bad.length) failures.push({ c, bad: out.bad });
    if (Date.now() - t0 > 45000) { cached = { failures, blocked, ran, blockedBy, reasons, kindsSeen, truncated: true, ms: Date.now() - t0 }; return cached; }
  }
  cached = { failures, blocked, ran, blockedBy, reasons, kindsSeen, truncated: false, ms: Date.now() - t0 };
  return cached;
}

const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${String(v).padStart(4)}  ${k}`).join('\n');

if (loadError) {
  test('scrubber module is available', () => assert.fail(loadError));
} else {
  function report(title, list, ran) {
    const byType = {};
    for (const f of list) for (const b of f.bad) byType[b.type] = (byType[b.type] || 0) + 1;
    const byKind = new Map();
    const byTpl = new Map();
    for (const f of list) { byKind.set(f.c.kind, (byKind.get(f.c.kind) || 0) + 1); byTpl.set(f.c.tpl, (byTpl.get(f.c.tpl) || 0) + 1); }
    const shown = list.slice(0, 6).map(({ c, bad }) => {
      const first = bad[0];
      const min = shrink(c, first.type);
      return [
        `--- iteration ${c.i}  kind=${c.kind}  template=${c.tpl}  format=${c.fmt}${c.format ? '(explicit)' : '(inferred)'}  path=${c.path}  machine=${c.machine.label}`,
        ...bad.slice(0, 4).map((b) => `    ${b.type}${b.kind ? ` [${b.kind}]` : ''}: ${b.detail}${b.text ? `  => ${String(b.text).slice(0, 120)}` : ''}`),
        `    secret value: ${JSON.stringify(c.secret.value.length > 140 ? `${c.secret.value.slice(0, 140)}...` : c.secret.value)}`,
        `    minimal reproduction (content): ${JSON.stringify(min)}`,
        `    replay: BORROW_FUZZ_SEED=${process.env.BORROW_FUZZ_SEED || SEED} BORROW_FUZZ_ONLY=${c.i} node --test test/borrow-fuzz.test.js`,
      ].join('\n');
    });
    assert.fail([
      `${title}: ${list.length} of ${ran} iterations. seed=${process.env.BORROW_FUZZ_SEED || SEED} (numeric ${SEED})  N=${N}`,
      `by type: ${JSON.stringify(byType)}`,
      `worst kinds:\n${top(byKind, 8)}`,
      `worst templates:\n${top(byTpl, 8)}`,
      ...shown,
      list.length > 6 ? `... ${list.length - 6} more; replay one with BORROW_FUZZ_ONLY=<iteration>` : '',
    ].join('\n'));
  }
  const only = (failures, keep) => failures.map((f) => ({ c: f.c, bad: f.bad.filter((b) => (b.type === 'KEPT-LOST') === keep) })).filter((f) => f.bad.length);

  test(`fuzz: ${N} random secrets in random contexts leak nothing (or the file is blocked)`, { timeout: 60000 }, () => {
    const { failures, ran, truncated, ms } = runAll();
    assert.ok(!truncated, `fuzz run exceeded 45 s after ${ran} iterations (${ms} ms): the scrubber is too slow`);
    const leaks = only(failures, false);
    if (leaks.length) report('LEAKS, throws or malformed results', leaks, ran);
  });

  test('fuzz: lines README guarantee 5 keeps on purpose survive next to a secret (git SHAs, $VAR refs, $(security ...), op://, ~ paths)', { timeout: 60000 }, () => {
    const { failures, ran } = runAll();
    const lost = only(failures, true);
    if (lost.length) report('KEPT-ON-PURPOSE LINES LOST', lost, ran);
  });

  test(`fuzz: at most ${Math.round(MAX_BLOCKED * 100)}% of files are blocked (over-blocking makes the feature useless)`, { timeout: 60000 }, () => {
    const { blocked, ran, blockedBy, reasons } = runAll();
    const rate = ran ? blocked / ran : 0;
    if (ONLY != null) return;
    assert.ok(rate <= MAX_BLOCKED, [
      `blocked ${blocked} of ${ran} (${(rate * 100).toFixed(1)}%), limit ${(MAX_BLOCKED * 100).toFixed(0)}%. seed=${process.env.BORROW_FUZZ_SEED || SEED}`,
      `most blocked kinds and templates:\n${top(blockedBy, 14)}`,
      `block reasons:\n${top(reasons, 6)}`,
    ].join('\n'));
  });

  test('fuzz: the run exercises every secret kind and most templates', () => {
    const { kindsSeen, ran } = runAll();
    if (ONLY != null || ran < 1000) return;
    const missing = SECRET_PATTERNS.map((p) => p.kind).filter((k) => !kindsSeen.has(k) && !MULTI_LINE_ONLY.has(k));
    assert.deepEqual(missing, [], `kinds never generated: ${missing.join(', ')}`);
  });

  test('fuzz: every generated input really contains its secret and is valid for its format (harness self-check)', () => {
    for (let i = 0; i < 300; i++) {
      const c = buildCase(i);
      assert.ok(c.secret.rand.every((seg) => c.text.includes(seg)), `iteration ${i}: secret missing from input`);
      if (c.fmt === 'json') JSON.parse(c.text.replace(/^\uFEFF/, ''));
    }
  });
}
