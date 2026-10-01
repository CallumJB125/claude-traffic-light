// Borrow scrubber regressions from the security and code reviews: each test
// uses the reviewer's own input and asserts it is redacted or blocked, never
// leaked. Fake tokens are assembled at run time (j(...)) so the repository
// never holds a string a secret scanner would flag.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scrubFile, formatOf, detectionView } = require('../src/borrow/scrub.js');

const j = (...p) => p.join('');
const M = { home: '/Users/callumbaker', user: 'callumbaker', hostname: 'Callums-MacBook-Pro.local', emails: ['callum.baker.125@gmail.com'], names: ['Callum Baker'] };
const GHP = j('ghp_', '16C7e42F292c6912E7710c838347Ae178B4a');
const P = 'Zq7xW2rT9vLm4Kp8';

// Safe means: blocked, or ok with none of `needles` left in the output.
function safe(path, content, needles, machine = M) {
  const r = scrubFile({ path, content, machine });
  assert.ok(r.status === 'ok' || r.status === 'blocked', `status ${r.status}`);
  if (r.status === 'ok') for (const n of needles) assert.ok(!r.content.includes(n), `${JSON.stringify(n)} survived in ${JSON.stringify(r.content)}`);
  const side = JSON.stringify([r.reason, r.redactions, r.templates]);
  for (const n of needles) assert.ok(!side.includes(n), `${JSON.stringify(n)} in reason or records: ${side}`);
  return r;
}
const ok = (path, content, needles, machine) => { const r = safe(path, content, needles, machine); assert.equal(r.status, 'ok', r.reason); return r; };
const isBlocked = (path, content, machine = M) => { const r = scrubFile({ path, content, machine }); assert.equal(r.status, 'blocked', JSON.stringify(r.content)); return r; };

test('H1: a redacted secret never becomes the next placeholder\'s name', () => {
  for (const [path, content] of [
    ['~/.claude/CLAUDE.md', `The staging password is ${P}: ${GHP}\n`],
    ['~/.zshrc', `password="${P}"=${GHP}\n`],
    ['~/.zshrc', `git clone https://bob:${P}=${GHP}@github.com/x\n`],
    ['~/.zshrc', `# machine x login bob password ${P}= ${GHP}\n`],
  ]) safe(path, content, [P, GHP.slice(4, 16)]);
});

test('H2: ~/.claude.json#mcpServers is JSON, so MCP env values are redacted by position', () => {
  assert.equal(formatOf('~/.claude.json#mcpServers'), 'json');
  const mcp = `${JSON.stringify({ mcpServers: { db: { command: 'npx', env: { PGPASS: 'hunter2hunter2', EXA: 'q8f2k1m9x7' } } } }, null, 2)}\n`;
  ok('~/.claude.json#mcpServers', mcp, ['hunter2hunter2', 'q8f2k1m9x7']);
  ok('~/.claude.json#mcpServers', '{"mcpServers":{"x":{"command":"npx","env":{"FOO":"zzqpw9dkd8sj"}}}}', ['zzqpw9dkd8sj']);
});

test('H3: YAML block scalars in every spelling are joined and redacted, or the file is blocked', () => {
  for (const content of [
    'password: |2\n    hunter2hunter2\n',
    'password: | # the pw\n  hunter2hunter2\n',
    '"password": |\n  hunter2hunter2\n',
    '- password: |\n    hunter2hunter2\n',
    'password:\n  hunter2hunter2\n',
  ]) safe('~/.config/gh/config.yml', content, ['hunter2hunter2']);
  // A secret key whose block could not be read fails closed.
  assert.equal(scrubFile({ path: '~/.config/gh/config.yml', content: 'password: |\nnext: 1\n', machine: M }).status, 'blocked');
});

test('M1: lower-case $words, single-quoted values and CAPS_WORDS are passwords, not references', () => {
  for (const [path, content, secret] of [
    ['~/.zshrc', "export DB_PASSWORD='$ecretPassw0rd'\n", 'ecretPassw0rd'],
    ['~/.claude/settings.json', '{"env": {"DB_PASSWORD": "$uperS3cret99"}}\n', 'uperS3cret99'],
    ['~/.zshrc', "export API_TOKEN='${hunter2Prod}'\n", 'hunter2Prod'],
    ['~/.zshrc', 'export DB_PASSWORD=MY_DOG_REX_2019\n', 'MY_DOG_REX_2019'],
    ['~/.claude/settings.json', '{"env": {"ADMIN_PASSWORD": "WINTER_IS_COMING_77"}}\n', 'WINTER_IS_COMING_77'],
    ['~/.config/fish/config.fish', "set -gx API_TOKEN '$ecretPassw0rd'\n", 'ecretPassw0rd'],
  ]) ok(path, content, [secret]);
  // Real references are still kept.
  assert.equal(ok('~/.zshrc', 'export API_TOKEN=$OPENAI_TOKEN_V2\n', []).content, 'export API_TOKEN=$OPENAI_TOKEN_V2\n');
  assert.ok(ok('~/.codex/config.toml', 'env_key = "AZURE_OPENAI_API_KEY"\n', []).content.includes('AZURE_OPENAI_API_KEY'));
});

test('M2: stand-in look-alikes in the input block the file (they could hide a token from the recheck)', () => {
  const hex32 = '9f86d081884c7d659a2feaa0c55ad015';
  for (const content of [
    j("alias db='databricks --host x {{DB:dapi", hex32, "}}'\n"),
    j('echo {{GH:', GHP, '}}\n'),
    j('# {{LINEAR:lin_', 'api_abcdefghijklmnopqrstuvwxyz0123456789}}\n'),
    '{{X:password}}: hunter2hunter2\n',
    '{{secret:foo}} {{home}}\n',
    '{{\u200bSECRET:foo}}\n',
  ]) isBlocked('~/.zshrc', content);
  // Slack's token is found even inside a wrapper, and the file is blocked anyway.
  safe('~/.zshrc', j('# {{S:xoxb-', '2048-4096-abcdefghijklmnopqrstuvwx}}\n'), ['abcdefghijklmnop']);
});

test('M3: machine values in encoded or embedded forms are templated or block the file', () => {
  for (const [path, content, needle, machine] of [
    ['~/.config/app/config.json', '{"u": "file://%2FUsers%2Fcallumbaker%2Fwork"}\n', 'callumbaker'],
    ['~/.zshrc', 'export U="mailto:callum.baker.125%40gmail.com"\n', 'callum.baker.125'],
    ['~/.gitconfig', '[github]\n\tuser = callum.baker.125\n', 'callum.baker.125'],
    ['~/.zshrc', 'alias gh-me="open https://github.com/callumbaker125"\nexport X=~/code/callumbakers-notes\n', 'callumbaker'],
    ['~/.zshrc', 'PS1="callums-macbook-pro2 % "\n', 'callums-macbook-pro'],
    ['~/.zshrc', 'H=Callums-MacBook-Pro-2.local\n', 'Callums-MacBook-Pro'],
    ['~/.zshrc', 'export P=/Users/jose\u0301/bin\n', 'jos', { home: '/Users/jos\u00e9', user: 'jos\u00e9', hostname: 'box', emails: [] }],
    ['~/.zshrc', 'export P=/Users/jos\u00e9/bin\n', 'jos', { home: '/Users/jose\u0301', user: 'jose\u0301', hostname: 'box', emails: [] }],
  ]) {
    const r = safe(path, content, [needle], machine);
    if (r.status === 'ok') assert.ok(!r.content.normalize('NFC').toLowerCase().includes(needle.normalize('NFC').toLowerCase()), r.content);
  }
});

test('M5: 1 MB of every reviewer shape scrubs in under 2 s', () => {
  const KB = 1000;
  const fill = (unit) => unit.repeat(Math.floor((KB * 1024) / unit.length));
  let seed = 7;
  const rnd = (n) => { let s = ''; const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) >>> 0; s += a[seed % 62]; } return s; };
  const upTo = (make) => { let s = ''; let i = 0; while (s.length < KB * 1024) s += make(i++); return s.slice(0, KB * 1024); };
  const shapes = {
    'many IPs': () => fill('10.0.0.1\n'),
    'same key distinct values': () => upTo((i) => `password=hunter${i}x\n`),
    'many random tokens': () => upTo(() => `${rnd(24)}\n`),
    'one line many tokens': () => upTo(() => `a=${rnd(24)} `),
    'triple quote line': () => fill('="""'),
    'netrc login spam': () => fill('login '),
    'open quote lines': () => fill('k="\n'),
    'yaml blocks': () => fill('a: |\n'),
    'minified json': () => `${'{"a":"b",'.repeat(110000)}"z":1}`,
    'many redactions': () => upTo((i) => `export K${i}_TOKEN=abcdefghijklmnopqrstuvwxyz${i}Ab9\n`),
    'open double quotes': () => 'A="'.repeat(300000),
  };
  const slow = [];
  for (const [name, make] of Object.entries(shapes)) {
    const content = make();
    const path = name === 'minified json' ? '~/x.json' : '~/.zshrc';
    const time = () => { const t0 = performance.now(); const r = scrubFile({ path, content, machine: M }); assert.ok(['ok', 'blocked'].includes(r.status)); return performance.now() - t0; };
    // A busy machine can stall one run; super-linear work is slow every time.
    let ms = time();
    if (ms > 2000) ms = Math.min(ms, time());
    if (ms > 2000) slow.push(`${name}: ${ms.toFixed(0)} ms`);
  }
  assert.deepEqual(slow, []);
});

test('M6: env blocks outside the usual spellings are redacted by position', () => {
  for (const [path, content] of [
    ['~/Library/Application Support/Code/User/settings.json', `{"terminal.integrated.env.osx": {"FOO": "${P}"}}`],
    ['~/.codex/config.toml', `[mcp_servers.x]\nenv.FOO = "${P}"\n`],
    ['~/.codex/config.toml', `[mcp_servers.x]\nenv = {\n  FOO = "${P}"\n}\n`],
    ['~/.codex/config.toml', `[mcp_servers."my server".env]\nFOO = "${P}"\n`],
    ['~/.claude/settings.json', `{"\\u0065nv": {"FOO": "${P}"}}`],
    ['~/.cursor/mcp.json', `{\n // don"t\n "env": {"FOO": "${P}"}}`],
  ]) ok(path, content, [P]);
});

test('L1: a secret\'s name never carries a host, an IP or an address', () => {
  for (const [path, content, needle] of [
    ['~/.config/gh/config.yml', j('tokens:\n  build.acme.internal: glpat-', 'AbCdEfGhIjKlMnOpQr12\n'), 'acme.internal'],
    ['~/.config/app/x.ini', j('host_10.0.0.5=', GHP, '\n'), '10.0.0.5'],
    ['~/.config/gh/config.yml', j('bob@acme-bank.co.za: glpat-', 'AbCdEfGhIjKlMnOpQr12\n'), 'acme-bank'],
  ]) {
    const r = safe(path, content, [needle]);
    for (const x of r.redactions) assert.ok(!x.name.includes(needle), x.name);
  }
});

test('L2: an SSH HostName with a trailing comment is hidden', () => {
  ok('~/.ssh/config', 'Host work\n  HostName bastion.acme-bank.co.za # jump box\n  User cbaker\n', ['bastion.acme-bank', 'cbaker']);
  ok('~/.ssh/config', 'Host work\n  HostName bastion.acme-bank.co.za\n', ['bastion.acme-bank']);
});

test('L3: a token split by a line continuation is redacted whole', () => {
  safe('~/.zshrc', j('curl -H "X-Key: ghp_', '16C7e42F29\\\n2c6912E7710c838347Ae178B4a" https://api.github.com\n'), ['ghp_16C7e42F29', '16C7e42F', '2c6912E7710c']);
  safe('~/.zshrc', j('claude --x sk-', 'ant-api03-abcd\\\nEFGHijkl1234567890mnopQRST\n'), ['sk-ant-api03-abcd', 'EFGHijkl1234']);
});

test('L6 / F12: a user named like a placeholder word does not corrupt placeholders', () => {
  assert.equal(ok('~/.zshrc', 'cd /home/home/x\n', [], { home: '/home/home', user: 'home' }).content, 'cd {{HOME}}/x\n');
  const r = ok('~/.zshrc', 'ssh nas.lan # host\n', [], { home: '/home/host', user: 'host', hostname: 'x9', emails: [] });
  assert.equal(r.content, 'ssh {{HOST:1}} # {{USER}}\n');
  assert.equal(ok('~/.zshrc', 'cd /Users/bob && echo ok\n', [], { home: '/home/host', user: 'host', hostname: 'h1' }).content, 'cd /Users/bob && echo ok\n');
});

test('F10 / F11: keybindings and ${NPM_TOKEN} references are kept', () => {
  assert.equal(ok('~/.config/alacritty/alacritty.toml', '[[keyboard.bindings]]\nkey = "V"\nmods = "Control"\n', []).content, '[[keyboard.bindings]]\nkey = "V"\nmods = "Control"\n');
  assert.equal(ok('~/.npmrc', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n', []).content, '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n');
});

test('F14: odd machine objects and arguments never throw', () => {
  for (const machine of [null, undefined, { home: 5, user: 7 }, { emails: 'x', names: [1, null] }]) {
    const r = scrubFile({ path: '~/.zshrc', content: 'x\n', machine });
    assert.equal(r.status, 'ok');
  }
  assert.equal(scrubFile().status, 'blocked');
  assert.equal(scrubFile({ path: '~/.zshrc', content: 'x' }).status, 'ok');
  // Names are rechecked like every other machine value.
  assert.equal(ok('~/.zshrc', 'echo Tonde\n', [], { home: '/Users/alice', user: 'alice', names: ['Tonde'] }).content, 'echo {{PRIVATE:1}}\n');
});

test('F15: a Windows home, plain or JSON-escaped, is templated', () => {
  const r = ok('~/.zshrc', 'cd C:\\Users\\alice\\bin\nx=C:/Users/alice/y\n', ['alice'], { home: 'C:\\Users\\alice', user: 'al' });
  assert.equal(r.content, 'cd {{HOME}}\\bin\nx={{HOME}}/y\n');
  assert.ok(ok('~/.claude/settings.json', '{"cwd": "C:\\\\Users\\\\alice\\\\dev"}\n', ['alice'], { home: 'C:\\Users\\alice' }).content.includes('{{HOME}}'));
});

test('F17 / F20 / F26: VS Code settings are JSONC; PIN_KEY needs a word start; localhost is no one\'s hostname', () => {
  assert.equal(formatOf('~/Library/Application Support/Code/User/settings.json'), 'jsonc');
  const r = ok('~/.config/app/x.toml', 'block = "9f86d081884c7d659a2feaa0c55ad0159f86d081"\nrev = "9f86d081884c7d659a2feaa0c55ad0159f86d081"\n', []);
  assert.equal(r.content.split('\n')[0], 'block = "{{SECRET:block}}"');
  assert.ok(r.content.includes('rev = "9f86d081884c7d659a2feaa0c55ad0159f86d081"'));
  assert.equal(ok('~/.zshrc', 'curl http://localhost:3000\n', [], { home: '/Users/alice', user: 'alice', hostname: 'localhost' }).content, 'curl http://localhost:3000\n');
});

test('a fetched secret is kept only when the whole value is the fetch', () => {
  assert.equal(ok('~/.zshrc', 'export GH_TOKEN=$(security find-generic-password -s x -w)\n', []).content, 'export GH_TOKEN=$(security find-generic-password -s x -w)\n');
  ok('~/.zshrc', 'export GH_TOKEN=$(security find-generic-password -s x -w) || export DB_PASSWORD=plainpassword\n', ['plainpassword']);
  ok('~/.zshrc', `export API_TOKEN=$(security find-generic-password -s x -w) || export API_TOKEN=${P}\n`, [P]);
});

test('the detection view keeps every offset (same length) on awkward input', () => {
  for (const t of ['', 'a', 'password: |\n  x\n  y\nz: 1\n', 'k = """\nabc\n"""\n', 'K="a\nb"\n', "a='x'\\''y'\r\n", 'password:\n  hunter2\n  more\nnext: 1\n', 'x: |2\n', '="""="""\n']) {
    for (const f of ['yaml', 'shell', 'toml', 'text']) assert.equal(detectionView(t, f).length, t.length, `${f} ${JSON.stringify(t)}`);
  }
});

test('N2: a structured key containing redacted value material leaks neither text nor metadata', () => {
  const secret = 'hunter' + 2 + 'hunter' + 2;
  for (const [path, content] of [
    ['~/.config/fixture.json', JSON.stringify({ env: { ['prefix_' + secret]: secret } })],
    ['~/.config/fixture.json', '{"env":{"prefix_hunter\\u0032hunter2":"hunter2hunter2"}}'],
    ['~/.config/fixture.json', '{"env":{"prefix_hunter2hunter2":"hunter\\u0032hunter2"}}'],
    ['~/.config/fixture.jsonc', '// local fixture\n' + JSON.stringify({ headers: { ['x-' + secret]: secret } })],
    ['~/.codex/config.toml', `[mcp_servers.fixture.env]\n"prefix_${secret}" = "${secret}"\n`],
    ['~/.codex/config.toml', `[env]\n"prefix_${secret} with spaces" = "${secret}"\n`],
    ['~/.codex/config.toml', `[env]\n'prefix_${secret} with spaces' = '${secret}'\n`],
    ['~/.codex/config.toml', `env = { 'prefix_${secret} with spaces' = '${secret}' }\n`],
    ...['https://fixture.example/' + secret, 'https://fixture.example/?token=' + secret, 'https://user:' + secret + '@fixture.example/'].map(value => ['~/.config/fixture.json', JSON.stringify({ env: { ['prefix_' + secret.slice(0, 8)]: value } })]),
    ['~/.config/fixture.json', JSON.stringify({ env: { ['prefix_' + secret]: JSON.stringify({ password: secret }) } })],
  ]) safe(path, content, [secret, 'hunter2h', 'hunter\\u0032hunter2']);
});
test('N2: provenance has finite key, nesting and fingerprint budgets with fixed reasons', () => {
  for (const content of [
    JSON.stringify(Object.fromEntries(Array.from({length:32769}, (_,i) => ['k'+i,0]))),
    JSON.stringify({env:{PAYLOAD:JSON.stringify(Array.from({length:32769},()=> 'value'))}}),
    JSON.stringify({env:{PAYLOAD:JSON.stringify(JSON.parse('['.repeat(33)+'"value"'+']'.repeat(33)))}}),
    JSON.stringify({env:{PAYLOAD:Array.from({length:30000}, (_,i) => i.toString(36).padStart(7,'0')+'x').join('')}}),
  ]) {
    const result = isBlocked('~/.config/fixture.json', content);
    assert.match(result.reason, /safe review budget|too many structured keys/);
    assert.deepEqual(result.redactions, []);
    assert.deepEqual(result.templates, []);
  }
});
test('N2: empty and long structured keys never bypass value or provenance redaction', () => {
  const secret = 'hunter' + 2 + 'hunter' + 2;
  for (const key of ['', 'public'.repeat(2000), 'public'.repeat(2000)+secret]) {
    safe('~/.config/fixture.json', JSON.stringify({env:{[key]:secret}}), [secret]);
    safe('~/.codex/config.toml', `[env]\n${JSON.stringify(key)} = "${secret}"\n`, [secret]);
    safe('~/.codex/config.toml', `env = { ${JSON.stringify(key)} = "${secret}" }\n`, [secret]);
  }
});
test('N3: tagged/anchored YAML block scalar properties, modifiers and CRLF are safe', () => {
  const secret = 'hunter' + 2 + 'hunter' + 2;
  for (const props of ['!!str ', '&private ', '!!str &private ', '&private !!str ']) {
    for (const indicator of ['|', '>', '|-', '>+', '|2-', '>+2']) {
      for (const nl of ['\n', '\r\n']) {
        safe('~/.config/fixture.yml', `"password": ${props}${indicator} # value${nl}    ${secret}${nl}next: public${nl}`, [secret]);
        safe('~/.config/fixture.yml', `- password: ${props}${indicator}${nl}    ${secret}${nl}`, [secret]);
        safe('~/.config/fixture.yml', `password: !!str &${secret} ${indicator}${nl}    ${secret}${nl}`, [secret]);
      }
    }
  }
});
test('N3: ambiguous properties, malformed indicators and over-limit scalar bodies fail closed', () => {
  const secret = 'hunter' + 2 + 'hunter' + 2;
  for (const header of ['!!str &a &b |', '!<tag:fixture> |', '!!str &a |9+-', '| !!str &a', '!!str | &a']) {
    isBlocked('~/.config/fixture.yml', `password: ${header}\n  ${secret}\n`);
  }
  isBlocked('~/.config/fixture.yml', 'password: !!str &a |\nnext: public\n');
  isBlocked('~/.config/fixture.yml', `password: !!str |\n${'  harmless\n'.repeat(51)}  ${secret}\n`);
});
