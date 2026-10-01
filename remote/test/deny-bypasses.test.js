// Bypasses of the shared deny-list / allow-list found in review. Principle:
// anything that runs code through an argument is desk-only (deny-list), never
// allow-listed; anything that reads secrets or clobbers files is at least not
// allow-listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRules, evaluateDenyList, remoteVerdict, allowListReason, parseShell, tokenize } from '../src/index.js';

const rules = compileRules();
const deny = (command) => evaluateDenyList(rules, { toolName: 'Bash', toolInput: { command } });
const remote = (command, opts = {}) => remoteVerdict(rules, { toolName: 'Bash', toolInput: { command }, cwd: '/Users/a/app' }, opts);
const ch = (...codes) => String.fromCharCode(...codes);

const DANGER = {
  'env -S re-parses its value': ['env -S "git push -f origin main"', 'env --split-string="rm -rf /"', 'env -S"rm -rf /"', 'env -iS "rm -rf /"'],
  'git config keys that run programs': [
    'git -c core.sshCommand=./x fetch', 'git -c core.pager=./x log', 'git -c core.fsmonitor=./x status', 'git -c core.hooksPath=/tmp/h commit -m x',
    'git -c credential.helper=./x fetch', 'git -c diff.x.textconv=./x diff', 'git -c filter.x.smudge=./x status', 'git -c filter.x.process=./x status',
    'git -c diff.external=./x diff', 'git -c uploadpack.packObjectsHook=./x fetch', 'git -c CORE.EDITOR=./x commit',
    'git --config-env=core.pager=EVIL log', 'git --config-env core.askPass=EVIL fetch', 'git -c include.path=/tmp/evil status',
    'git config core.pager ./x', 'git config --global core.sshCommand ./x', 'git config --local alias.st "!rm -rf /"', 'git config set core.fsmonitor ./x',
    'git clone -c core.fsmonitor=./x https://example.invalid/r', 'git --exec-path=/tmp/x status',
  ],
  'git options that run programs or write files': [
    'git log --output=/tmp/x', 'git diff --ext-diff', 'git rebase --exec "rm -rf /" HEAD~3', 'git rebase -x ./x HEAD~3', 'git bisect run ./x',
    'git submodule foreach "rm -rf /"', 'git clone ext::sh', 'git grep -O./x foo', 'git difftool -x ./x', 'git fetch --upload-pack=./x origin',
  ],
  'environment that makes the next program run code': [
    'GIT_SSH_COMMAND=./x git fetch', 'GIT_EXTERNAL_DIFF=./x git diff', 'GIT_PAGER=./x git log', 'GIT_ASKPASS=./x git fetch', 'SSH_ASKPASS=./x ssh h',
    'EDITOR=./x git commit', 'VISUAL=./x crontab -e', 'PAGER=./x man ls', 'env GIT_PAGER=./x git log', 'export GIT_PAGER=./x; git log',
    'LD_PRELOAD=/tmp/x.so ls', 'DYLD_INSERT_LIBRARIES=/tmp/x.dylib ls', 'NODE_OPTIONS="--require ./x" npm test', 'BASH_ENV=./x bash s.sh',
  ],
  'docker / kubectl running containers': [
    'docker run -v /:/host alpine', 'docker run --privileged alpine', 'docker exec -it c sh', 'docker compose run web sh', 'docker-compose exec web sh',
    'docker -H tcp://h:2375 run alpine', 'podman run alpine', 'kubectl exec -it p -- sh', 'kubectl run x --image=alpine',
  ],
  'wrappers: the wrapped command is judged': [
    'echo / | xargs -i rm -rf {}', 'nice --adjustment 5 rm -rf /', 'nice -n 5 rm -rf /', 'timeout -s KILL 5 rm -rf /', 'watch "rm -rf /"', 'watch -n 1 rm -rf /',
    'flock /tmp/l -c "rm -rf /"', 'flock /tmp/l rm -rf /', 'chroot / rm -rf /', 'script -c "rm -rf /" /dev/null', 'script -q /dev/null rm -rf /',
    'parallel rm -rf ::: /', 'stdbuf -oL rm -rf /', 'unbuffer rm -rf /', 'command rm -rf /', 'exec rm -rf /', 'time -p rm -rf /', 'setsid rm -rf /',
    'nohup --frobnicate x rm -rf /', 'find . -exec rm {} +', 'find . -okdir rm {} ;',
  ],
  'shell keywords and code-carrying builtins': [
    'if true; then rm -rf /; fi', 'while true; do rm -rf /; done', 'until false; do rm -rf /; done', '! rm -rf /', 'coproc rm -rf /',
    'trap "rm -rf /" EXIT', 'alias ls="rm -rf /"',
  ],
  'remote command execution and package runners': [
    'ssh host rm -rf /', 'ssh -p 22 host "ls"', 'ssh -o ProxyCommand="sh -c x" host', 'ssh -oProxyCommand=x host', 'scp -o ProxyCommand=x a h:b', 'rsync -e "sh -c x" a h:b',
    'npm exec evil', 'npm x evil', 'npx evil', 'pnpm dlx evil', 'pnpx evil', 'yarn dlx evil', 'bunx evil', 'bun x evil',
  ],
  'interpreters given code in an argument': [
    'python3 -c "print(1)"', 'node -e 1', 'node --eval=1', 'node --print 1', 'node -p 1', 'perl -e 1', 'perl -E 1', 'ruby -e 1', 'php -r "system(1);"',
    'deno eval 1', 'osascript -e x', 'pwsh -Command x', 'bash --command x', "awk 'BEGIN{system(\"rm -rf /\")}'", "awk '{print | \"sh\"}' f",
    "gawk -e 'BEGIN{system(\"x\")}'", "awk '{\"date\" | getline d}' f", "vim -c '!rm -rf /'", "nvim +':!rm -rf /'", 'vim --cmd x f', 'vim -S x.vim f',
    "sed '1e rm -rf /' f", "sed 's/a/b/e' f", "sed -e 's/a/b/;e' f", "sed 's/a/b/w ~/.zshrc' f", 'sed -i s/a/b/ ~/.zshrc',
    'tar --to-command="sh -c x" -xf a.tar', 'tar --checkpoint=1 --checkpoint-action=exec=sh -cf a.tar f', 'tar -I ./x -xf a.tar', 'tar --use-compress-program=./x -xf a',
    'go test -exec ./x ./...', 'go build -toolexec ./x', 'npm test --script-shell=./x', 'sort --compress-program=./x f', 'zip -TT ./x a.zip f',
  ],
  'shell constructs hiding commands': [
    'echo "$(echo \')\' ; rm -rf /)"', 'echo $(echo $(echo $(echo $(rm -rf /))))', 'echo `echo \\`rm -rf /\\``',
    'bash <<< "rm -rf /"', 'bash <<EOF\nrm -rf /\nEOF', 'python3 <<EOF\nimport os\nEOF', "cat <<EOF\nit's\nEOF\nrm -rf /", "cat <<'EOF'\nit's\nEOF\nrm -rf /",
    'cat <<EOF > f\n$(rm -rf /)\nEOF', 'cat <(rm -rf /)', 'tee >(rm -rf /)', 'exec 3<>/dev/tcp/example.invalid/80',
    'echo "$(echo # )\nrm -rf /)"', 'echo "$(cat <<EOF\n)\nEOF\nrm -rf /)"', 'echo "$(case x in a) echo;; esac; rm -rf /)"',
    "echo $'\\''\nrm -rf /\necho '", "ls # it's\nrm -rf /", '((x=1<<2))\nrm -rf /\n2', 'source <(echo rm -rf /)', 'echo rm -rf / | . /dev/stdin',
    '. /dev/stdin <<< "rm -rf /"', 'watch watch watch rm -rf /',
  ],
  'unicode in command names or args': [
    `r${ch(0x200b)}m -rf /`, `${ch(0x43c)}v a b`, `ls ${ch(0x202e)}x`, `${ch(0xff52, 0xff4d)} -rf /`, `ls ${ch(0x2060)}`, `git status ${ch(0xff0d, 0xff0d)}x`,
  ],
};

for (const [group, cmds] of Object.entries(DANGER)) {
  test(`deny-list: ${group}`, () => {
    for (const c of cmds) {
      const r = deny(c);
      assert.equal(r.blocked, true, `not desk-only: ${JSON.stringify(c)}`);
      assert.equal(remote(c).blocked, true, `allow-listed: ${JSON.stringify(c)}`);
      assert.equal(remote(c, { trustTestCommands: true }).blocked, true, `allow-listed in a trusted repo: ${JSON.stringify(c)}`);
    }
  });
}

test('allow-list: reads of secrets, hidden-file globs, brace expansion and file clobbers are not approvable', () => {
  for (const c of [
    'cat .env', 'cat .env.local', 'head config/.env.production', 'grep KEY .env', 'cat server.pem', 'printenv', 'env',
    'cat ~/.s*/id_rsa', 'cat ~/.a?s/credentials', 'cat .e*', 'ls .[a-z]*', 'cat ~/.{ssh,x}/id_rsa', 'ls {a,b}', 'cat ~root/x', 'cat ~/L*/Keychains/x', 'cat **/x',
    'sort -o ~/.zshrc f', 'sort --output=f g', 'uniq a b', 'tree -o out', 'file -C -m x', 'ls > f', ': > f',
  ]) assert.equal(remote(c).blocked, true, c);
});

test('allow-list: a trusted repo still may not pass program-running options to test commands', () => {
  for (const c of ['go test -exec ./x ./...', 'go vet -vettool=./x', 'npm test --script-shell=./x', 'npm run lint --node-options=--require=./x', 'cargo test --config x', 'pytest -p evil']) {
    assert.equal(remote(c, { trustTestCommands: true }).blocked, true, c);
  }
});

test('allow-list: symlinks are resolved when a realpath is supplied', () => {
  const realpath = (p) => (p.includes('link') ? '/Users/a/.ssh/id_rsa' : p);
  assert.notEqual(allowListReason({ toolName: 'Read', toolInput: { file_path: '/Users/a/app/link' }, cwd: '/Users/a/app' }, { realpath }), null);
  assert.notEqual(allowListReason({ toolName: 'Bash', toolInput: { command: 'cat link' }, cwd: '/Users/a/app' }, { realpath }), null);
  assert.notEqual(allowListReason({ toolName: 'Edit', toolInput: { file_path: '/Users/a/app/link' }, cwd: '/Users/a/app' }, { realpath }), null);
  assert.equal(allowListReason({ toolName: 'Bash', toolInput: { command: 'cat README.md' }, cwd: '/Users/a/app' }, { realpath }), null);
  assert.equal(allowListReason({ toolName: 'Read', toolInput: { file_path: '/Users/a/app/README.md' }, cwd: '/Users/a/app' }, { realpath }), null);
  const throws = () => { throw new Error('ENOENT'); };
  assert.equal(allowListReason({ toolName: 'Bash', toolInput: { command: 'cat new.md' }, cwd: '/Users/a/app' }, { realpath: throws }), null);
});

test('benign forms keep their verdicts', () => {
  for (const c of [
    'git status', 'git -c color.ui=always diff', 'git log --oneline', 'npm test', 'npm run test', 'docker ps', 'docker images', 'docker compose up -d', 'docker compose logs run',
    'ls', 'cat README.md', 'node --version', 'node script.js', 'ssh host', 'ssh -i key host', 'sed -n 1p f', "sed 's/eat/beer/g' f", "awk '{print $1}' f", 'awk -F, \'{print $2}\' f',
    'vim f', 'vim +10 f', 'tar -xzf a.tar.gz', 'time npm test', 'nohup npm test', 'xargs ls', 'echo a | xargs grep x', 'env FOO=1 npm test', 'git config --get core.pager',
    'git config user.name "A B"', 'git commit -m "$(cat <<\'EOF\'\nfix: it\'s done\n\nrm -rf is mentioned here\nEOF\n)"', 'cat > notes.md <<\'EOF\'\nsee $(this)\nEOF',
    'git log --grep "café"', 'echo naïve', 'if [ -f x ]; then echo y; fi', 'for f in *.ts; do echo "$f"; done', 'timeout 5 npm test', 'git -c user.name=x log',
  ]) assert.equal(deny(c).blocked, false, c);
  for (const c of ['git status', 'git log --oneline', 'git log --oneline | head -20', 'git diff 2>&1', 'ls', 'ls -la src', 'cat README.md', 'find . -name "*.ts"', 'ls src/*.ts', 'cat *.md', 'sort f', 'uniq f', 'ls ~', 'cat docs/env.md']) {
    assert.equal(remote(c).blocked, false, c);
  }
  for (const c of ['git -c color.ui=always diff', 'npm test', 'npm run test', 'docker ps', 'node --version']) assert.equal(remote(c).blocked, true, c);
  for (const c of ['npm test', 'npm run test', 'npm run lint -- --fix', 'go test ./...', 'cargo test']) assert.equal(remote(c, { trustTestCommands: true }).blocked, false, c);
});

test('allow-list: edits are desk-only when the session directory is /, home or above home', () => {
  const w = (file_path, cwd, opts = {}) => remoteVerdict(rules, { toolName: 'Write', toolInput: { file_path, content: 'x' }, cwd }, opts).blocked;
  const home = { home: '/Users/x' };
  for (const p of ['/Users/x/.gitconfig', '/Users/x/.config/git/config', '/Users/x/.config/fish/config.fish', '/Users/x/.local/bin/ls', '/Users/x/bin/git', '/Users/x/notes.txt']) {
    assert.equal(w(p, '/Users/x', home), true, `${p} with cwd = home`);
    assert.equal(w(p, '/Users/x'), true, `${p} with cwd = home, home unknown`);
  }
  for (const p of ['/etc/hosts', '/usr/local/bin/node', 'etc/hosts']) assert.equal(w(p, '/', home), true, `${p} with cwd = /`);
  assert.equal(w('/Users/x/a.txt', '/Users', home), true, 'cwd above home');
  assert.equal(w('/Users/x/app/src/a.ts', '/Users/x/app', home), false, 'a project under home');
  assert.equal(w('/Users/x/app/bin/cli.js', '/Users/x/app', home), false, "a project's own bin/ stays editable");
  for (const p of ['/Users/x/.gitconfig', '/Users/x/.config/git/config', '/Users/x/.config/fish/config.fish', '/Users/x/.local/bin/ls', '/Users/x/bin/git']) {
    assert.equal(evaluateDenyList(rules, { toolName: 'Write', toolInput: { file_path: p, content: 'x' } }).blocked, true, `deny-list: ${p}`);
  }
});

test('shell history counts as credentials', () => {
  for (const p of ['/Users/x/.zsh_history', '/Users/x/.bash_history', '/Users/x/.history', '/Users/x/.local/share/fish/fish_history']) {
    assert.equal(evaluateDenyList(rules, { toolName: 'Read', toolInput: { file_path: p } }).blocked, true, p);
    assert.equal(deny(`cat ${p}`).blocked, true, p);
  }
});

test('allow-list: sort / uniq / tree that write a file are desk-only', () => {
  for (const c of ['sort -o /Users/x/.zshrc /dev/null', 'sort --output=.husky/pre-commit x', 'uniq evil.txt .git/hooks/pre-commit', 'tree -o .git/hooks/post-checkout', 'sort -o Makefile x']) {
    assert.equal(remote(c).blocked, true, c);
  }
});

test('unicode: emoji joiners inside quoted data are fine; bidi controls and Cf in code are not', () => {
  const zwj = ch(0x200d), rlo = ch(0x202e), tag = String.fromCodePoint(0xe0067);
  for (const c of [`git commit -m "ship ${String.fromCodePoint(0x1f468)}${zwj}${String.fromCodePoint(0x1f4bb)}"`, `echo 'flag ${String.fromCodePoint(0x1f3f4)}${tag}'`,
    `cat <<'EOF'\nteam ${zwj} work\nEOF`, `cat <<EOF\nteam ${zwj} work\nEOF`, `git commit -m "a${ch(0x200c)}b"`]) {
    assert.equal(deny(c).blocked, false, JSON.stringify(c));
  }
  for (const c of [`echo "a${rlo}b"`, `echo 'a${ch(0x2066)}b'`, `cat <<'EOF'\na${ch(0x200f)}b\nEOF`, `r${zwj}m x`, `"r${zwj}m" x`, `ls -${zwj}la`, `echo a${zwj}b`,
    `echo "$(r${zwj}m x)"`, `echo "a${ch(0x200b)}b"`, `ls ${tag}`]) {
    assert.equal(deny(c).blocked, true, JSON.stringify(c));
    assert.equal(remote(c).blocked, true, JSON.stringify(c));
  }
});

test('awk: | inside regex and string literals is data; pipes and system() are not', () => {
  for (const c of ["awk '/a|b/ {print}' f", "awk '{print \"a|b\"}' f", "awk -F'|' '{print $1}' f", "awk '$1 ~ /x|y/ {n++} END{print n}' f"]) assert.equal(deny(c).blocked, false, c);
  for (const c of ["awk '{print | \"sh\"}' f", "awk 'BEGIN{\"id\" | getline x}'", "awk 'BEGIN{system(\"id\")}'", "awk '{print |& \"sh\"}' f", "awk '{print a/2 | \"sh\"}' f",
    "awk 'BEGIN{f=\"system\"; @f(\"id\")}'", "awk '/x/ {print \"\\\"\" | \"sh\"}' f"]) assert.equal(deny(c).blocked, true, c);
});

test('awk: a / after a string is division, so it cannot hide a pipe', () => {
  assert.equal(deny("awk '{print \"a\" / 2 | \"sh\"}' f").blocked, true);
});

test('allow-list: the session directory is normalised and resolved before the home / root check', () => {
  const edit = (cwd, opts = {}, file_path = '.config/nvim/init.lua') => allowListReason({ toolName: 'Edit', toolInput: { file_path, old_string: 'a', new_string: 'b' }, cwd }, { home: '/Users/x', ...opts });
  for (const cwd of ['/Users/x/.', '/Users/x/app/..', '/Users/x//', '/', '/Users/x/app/../..', '/Users/x/./app/../.']) {
    assert.notEqual(edit(cwd, {}, 'notes.txt'), null, cwd);
  }
  const link = { '/Users/x/work/link': '/Users/x', '/Users/x/work/deep/a/b': '/Users/x/work/link2', '/Users/x/work/link2': '/Users/x' };
  const realpath = (p) => {
    for (const [from, to] of Object.entries(link)) if (p === from || p.startsWith(from + '/')) return realpath(to + p.slice(from.length));
    return p;
  };
  assert.notEqual(edit('/Users/x/work/link', { realpath }, 'notes.txt'), null, 'cwd is a symlink to home');
  assert.notEqual(edit('/Users/x/work/deep/a/b', { realpath }, 'notes.txt'), null, 'cwd is a nested symlink to home');
  assert.equal(edit('/Users/x/work/app', { realpath }, 'src/a.ts'), null, 'a real project stays editable');
  const into = (p) => (p === '/Users/x/work/app/out' ? '/Users/x/notes.txt' : p);
  assert.notEqual(edit('/Users/x/work/app', { realpath: into }, 'out'), null, 'a file that resolves straight into home');
});

test('files that run code later include ~/.config, build files and JS config files', () => {
  for (const p of ['/Users/x/.config/autostart/x.desktop', '/Users/x/.config/nvim/init.lua', '/Users/x/.config/systemd/user/x.service', 'Makefile', 'GNUmakefile', 'sub/makefile',
    'justfile', 'Justfile', '.pre-commit-config.yaml', 'tests/conftest.py', 'jest.config.js', 'vitest.config.ts', 'vite.config.mjs', 'playwright.config.ts', '.eslintrc.js', 'eslint.config.mjs',
    'babel.config.js', '.envrc', '.husky/pre-commit', '.github/workflows/ci.yml', '.vscode/tasks.json', '.vscode/settings.json', '.git/hooks/pre-push', '.git/config']) {
    assert.equal(evaluateDenyList(rules, { toolName: 'Write', toolInput: { file_path: p, content: 'x' } }).ruleId, 'runs-code-later', p);
    assert.equal(remoteVerdict(rules, { toolName: 'Edit', toolInput: { file_path: p }, cwd: '/Users/x/app' }).blocked, true, p);
  }
  assert.equal(remoteVerdict(rules, { toolName: 'Edit', toolInput: { file_path: '/Users/x/app/bin/cli.js' }, cwd: '/Users/x/app' }, { home: '/Users/x' }).blocked, false);
});

test("a shell tool's description is not executed, so it is not judged as a command", () => {
  assert.equal(evaluateDenyList(rules, { toolName: 'Bash', toolInput: { command: 'ls', description: 'rm -rf / then ship 👨‍💻 and r​m' } }).blocked, false);
  assert.equal(evaluateDenyList(rules, { toolName: 'Bash', toolInput: { command: 'rm -rf /', description: 'list files' } }).blocked, true);
  assert.equal(evaluateDenyList(rules, { toolName: 'Bash', toolInput: { command: 'ls', extra: 'rm -rf /' } }).blocked, true, 'other fields are still judged');
});

// ── second review pass ──────────────────────────────────────────────────────
const fileTool = (toolName, toolInput, cwd = '/w/app', opts = {}) => remoteVerdict(rules, { toolName, toolInput, cwd }, { home: '/Users/x', ...opts });

test('protected paths are judged after normalising . // and .. (no realpath needed)', () => {
  for (const p of ['/w/app/.git//hooks/pre-commit', '/w/app/./.github/workflows/x.yml', '/w/app/x/../.husky/pre-commit', '.git/./hooks/pre-push', 'x/../.git/config']) {
    assert.equal(fileTool('Write', { file_path: p, content: 'x' }).blocked, true, p);
    assert.equal(evaluateDenyList(rules, { toolName: 'Write', toolInput: { file_path: p, content: 'x' } }).ruleId, 'runs-code-later', p);
  }
  for (const p of ['/Users/x/.ssh/./id_rsa', '/Users/x/./.aws//credentials', '/w/app/x/../.env']) assert.equal(fileTool('Read', { file_path: p }).blocked, true, p);
  assert.equal(deny('echo x > .git//hooks/pre-commit').blocked, true);
});

test('redirects are dropped only after tokenising, so a newline cannot be merged away', () => {
  for (const c of ['cat README.md\n2>/dev/null touch evil', 'ls\n>/dev/null mkdir x', 'cat a\n2>&1 touch b', 'ls > /dev/null\ntouch x']) assert.equal(remote(c).blocked, true, JSON.stringify(c));
  for (const c of ['git diff 2>&1', 'ls 2>/dev/null', 'ls >/dev/null 2>&1', 'git log &>/dev/null', 'git status 1>&2']) assert.equal(remote(c).blocked, false, c);
  for (const c of ['ls > 1', 'ls 2> err.txt', 'ls >& out', 'cat < /etc/passwd']) assert.equal(remote(c).blocked, true, c);
});

test('protected paths match case-insensitively', () => {
  assert.equal(fileTool('Read', { file_path: '/Users/x/.SSH/id_rsa' }).blocked, true);
  assert.equal(evaluateDenyList(rules, { toolName: 'Write', toolInput: { file_path: '.Git/hooks/x', content: 'x' } }).ruleId, 'runs-code-later');
  assert.equal(evaluateDenyList(rules, { toolName: 'Write', toolInput: { file_path: '.GITHUB/workflows/x.yml', content: 'x' } }).ruleId, 'runs-code-later');
});

test('Grep over home, / or a parent of a credential directory is desk-only', () => {
  for (const [input, cwd] of [[{ pattern: 'TOKEN', path: '/Users/x' }], [{ pattern: 'TOKEN', path: '/' }], [{ pattern: 'TOKEN', path: '/Users/x/.config' }], [{ pattern: 'TOKEN', path: '/Users/x/Library' }],
    [{ pattern: 'TOKEN', path: '/Users/x/app/..' }], [{ pattern: 'TOKEN' }, '/Users/x'], [{ pattern: 'TOKEN', path: '..' }, '/Users/x/app'], [{ pattern: 'TOKEN', path: 'src', glob: '**/.env*' }], [{ pattern: 'TOKEN', glob: '.ssh/*' }]]) {
    assert.equal(fileTool('Grep', input, cwd ?? '/Users/x/app').blocked, true, JSON.stringify([input, cwd]));
  }
  assert.equal(fileTool('Grep', { pattern: 'TOKEN', path: 'src', glob: '*.ts' }, '/Users/x/app').blocked, false);
  assert.equal(fileTool('Grep', { pattern: 'TOKEN' }, '/Users/x/app').blocked, false);
});

test('an assignment whose value runs a substitution is a deny-list finding', () => {
  for (const c of ['x="$(id)"', 'x=`id`', 'x="`id`"', 'x="$((y))"', 'x="${y@P}"', 'echo "${y@P}"', 'export x="$(id)"', 'x=$[y]', '"$(which rm)" -rf /tmp/x']) assert.equal(deny(c).blocked, true, c);
  for (const c of ['x=1', 'x="a b"', 'echo "$HOME"', 'echo $((1+2))']) assert.equal(deny(c).blocked, false, c);
});

test('the depth fallback only applies when home is unknown', () => {
  const e = (cwd, opts) => allowListReason({ toolName: 'Edit', toolInput: { file_path: 'src/a.ts' }, cwd }, opts);
  for (const cwd of ['/workspaces/repo', '/srv/app', '/opt/app']) {
    assert.equal(e(cwd, { home: '/Users/x' }), null, cwd);
    assert.notEqual(e(cwd, {}), null, `${cwd} without home`);
  }
});

test('file tools: protected-path rules look at path fields, not file content', () => {
  for (const toolName of ['Write', 'Edit']) {
    assert.equal(evaluateDenyList(rules, { toolName, toolInput: { file_path: 'docs/setup.md', content: 'copy your key to ~/.ssh/id_rsa and edit .git/hooks/pre-commit', new_string: '~/.aws/credentials' } }).blocked, false, toolName);
  }
  assert.equal(evaluateDenyList(rules, { toolName: 'apply_patch', toolInput: { input: '*** Update File: /Users/x/.ssh/config' } }).blocked, true, 'tools without a path field are scanned whole');
  assert.equal(deny('cat docs/a.md ~/.ssh/id_rsa').blocked, true, 'Bash commands are scanned whole');
});

test('more files that run code later or steer agents', () => {
  for (const p of ['.npmrc', '.yarnrc.yml', 'pyproject.toml', 'setup.py', 'tox.ini', '.cargo/config.toml', 'build.rs', '.devcontainer/devcontainer.json', '.idea/runConfigurations/x.xml',
    '.idea/workspace.xml', '.vscode/launch.json', '.gitattributes', '.lintstagedrc.json', 'lefthook.yml', 'CLAUDE.md', 'sub/AGENTS.md']) {
    assert.equal(evaluateDenyList(rules, { toolName: 'Write', toolInput: { file_path: p, content: 'x' } }).blocked, true, p);
  }
  for (const p of ['src/index.ts', 'lib/build.ts', 'docs/setup.md', 'README.md']) assert.equal(fileTool('Edit', { file_path: p }).blocked, false, p);
});

test('the real checks stay fast on large pathological inputs', () => {
  const units = ['a', "'", '"', ' ', '(', '$(', '`', ';', '|', '\n', '<<a\n', '#', '\\', '{', "a'", 'x=', '$((', 'sh -c ',
    '*** Update File: ', '*** Move to: a/', '--- a/', '+++ "', 'diff --git "a\\', 'diff --git a b ', 'rename to ', '\r\n+++ b/.git/', '"\\0', ' / ', '\n+++ b/src/a "x\\" '];
  for (const unit of units) {
    const c = unit.repeat(Math.ceil(65536 / unit.length));
    for (const [name, fn] of [['parseShell', () => parseShell(c)], ['tokenize', () => tokenize(c)], ['evaluateDenyList', () => deny(c)], ['allowListReason', () => allowListReason({ toolName: 'Bash', toolInput: { command: c } })],
      ['evaluateDenyList apply_patch 4 KB', () => evaluateDenyList(rules, { toolName: 'apply_patch', toolInput: { input: c.slice(0, 4096) }, cwd: '/Users/a/app' })],
      ['allowListReason apply_patch', () => allowListReason({ toolName: 'apply_patch', toolInput: { input: c }, cwd: '/Users/a/app' })]]) {
      const t = performance.now();
      fn();
      const ms = performance.now() - t;
      assert.ok(ms < 500, `${name} on ${JSON.stringify(unit)} × 64 KB: ${ms.toFixed(0)} ms`);
    }
  }
});
