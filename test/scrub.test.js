const test = require('node:test');
const assert = require('node:assert/strict');
const { scrub, hashName, cleanJsonError } = require('../src/scrub.js');

const HOME = '/Users/jane';
const opts = { home: HOME, user: 'jane', hostname: 'Janes-MacBook-Pro.local', salt: 's' };
const H = (x) => hashName(x, 's');

// Every case: after scrubbing, none of `gone` may survive (case-insensitive).
// Fail closed: over-redacting is fine, a surviving substring is a leak.
const LEAKS = [
  // 1. quoted paths, spaces included
  ['quoted posix path with spaces', 'cwd "/Users/jane/My Projects/secret thing/x.js" done', ['jane', 'My Projects', 'secret', 'thing']],
  ['single-quoted path', "open '/opt/client work/q3 plan.txt'", ['client', 'work', 'q3', 'plan']],
  ['backtick path', 'at `~/acme corp/app`', ['acme', 'corp']],
  // 2. unquoted paths with spaces, including double spaces
  ['unquoted path with spaces', 'opened /Users/jane/My Projects/secret thing/app.ts: ok', ['My Projects', 'secret thing', 'app.ts']],
  ['double spaces', 'cwd /Volumes/Work/big  secret  launch', ['Work', 'big', 'secret', 'launch']],
  ['trailing words', 'cwd /w/secret-project for editing', ['secret-project']],
  // 3. Windows
  ['windows backslashes', 'at C:\\Users\\jane\\proj\\main.js:3', ['jane', 'proj']],
  ['windows quoted with spaces', 'cmd "C:\\Users\\jane\\My Docs\\secret plan\\x.js"', ['jane', 'My Docs', 'secret', 'plan']],
  ['JSON-escaped backslashes', '{"cwd":"C:\\\\Users\\\\jane\\\\clientx\\\\app"}', ['jane', 'clientx']],
  ['JSON-escaped slashes', '{"cwd":"\\/Users\\/jane\\/clientx\\/app"}', ['jane', 'clientx']],
  ['forward-slash drive path', 'cwd C:/Users/jane/clientx/app', ['jane', 'clientx']],
  ['home in the other case', 'cwd /users/JANE/clientx', ['jane', 'clientx']],
  ['UNC backslash', 'from \\\\fileserver\\teamshare\\clientx', ['fileserver', 'teamshare', 'clientx']],
  ['UNC forward', 'from //fileserver/teamshare/clientx', ['fileserver', 'teamshare', 'clientx']],
  ['file URL', 'load file:///opt/clientx/index.html', ['clientx']],
  ['drive letter prefix', 'D:\\clientx\\secret', ['clientx', 'secret']],
  ['path right after a colon', 'cwd:/opt/clientx/app', ['clientx']],
  ['path right after @', 'at@/opt/clientx', ['clientx']],
  // 4. separators inside a started path
  ['colon inside a path', 'file /opt/proj:clientx/y', ['proj', 'clientx']],
  ['comma, semicolon, pipe', 'paths /opt/a,clientx;secretb|secretc', ['clientx', 'secretb', 'secretc']],
  // 5. URL-encoded
  ['url-encoded path', 'GET /x?p=%2FUsers%2Fjane%2Fclientx%20secret', ['jane', 'clientx', 'secret']],
  ['url-encoded backslash', 'p=C:%5CUsers%5Cjane%5Cclientx', ['jane', 'clientx']],
  // 6. URLs and repos
  ['https path', 'see https://github.com/acme-corp/clientx/pull/3', ['acme-corp', 'clientx']],
  ['ssh URL with a user', 'ssh://jdoe@git.acme.io/acme-corp/clientx.git', ['jdoe', 'acme-corp', 'clientx']],
  ['git scp form', 'remote git@github.com:acme-corp/clientx.git', ['acme-corp', 'clientx']],
  ['repo names given', '[git] polling acme-corp/clientx and other', ['acme-corp', 'clientx']],
  ['repo ref after [git]', '[git] fired ci-failed for acme-corp/clientx#123', ['acme-corp', 'clientx']],
  // 7. secrets
  ['PEM private key', '-----BE' + 'GIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsecretkeymaterial\n-----END RSA PRIVATE KEY-----', ['MIIEpAIBAAKCAQEA', 'secretkeymaterial']],
  ['Authorization Basic', 'Authorization: Basic dX' + 'NlcjpwYXNzd29yZA==', ['dXNlcjpwYXNzd29yZA']],
  ['Authorization Token', 'authorization=Token abc123secretvalue', ['abc123secretvalue']],
  ['Bearer JWT', 'Authorization: Bearer eyJ' + 'hbGciOiJIUzI1NiJ9.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', ['eyJ' + 'zdWIi', 'dozjgNry']],
  ['keyed with a prefix', 'GITHUB_TOKEN=hu' + 'nter2secret', ['hunter2secret']],
  ['keyed access key', 'aws_access_key_id: AK' + 'IAQQQQQQQQQQQQQQQQ', ['AKIAQQQQ']],
  ['keyed quoted value with spaces', '{"client_secret": "correct horse battery staple"}', ['correct', 'horse', 'staple']],
  ['keyed pwd', 'db_pwd=s3cr3tpass', ['s3cr3tpass']],
  ['cookie', 'Cookie: sessionid=abcdef0123456789', ['abcdef0123456789']],
  ['anthropic key', 'ANTHROPIC_API_KEY=sk-' + 'ant-api03-abcdefghijklmnopqrstuvwxyz', ['abcdefghijklmnop']],
  ['bare anthropic key', 'key sk-' + 'ant-api03-abcdefghijklmnopqrstuvwxyz', ['abcdefghijklmnop']],
  ['github token', 'gh gh' + 'p_abcdefghijklmnopqrstuvwxyz0123', ['gh' + 'p_abcdefghij']],
  ['slack bot', 'slack xo' + 'xb-1234567890-abcdefghij', ['1234567890-abcdefghij']],
  ['slack refresh', 'slack xoxe.xo' + 'xp-1-abcdefghijklmn', ['abcdefghijklmn']],
  ['slack app', 'slack xa' + 'pp-1-A01-abcdefghijklmn', ['abcdefghijklmn']],
  ['npm token', 'np' + 'm_abcdefghijklmnopqrstuvwxyz0123', ['abcdefghijklmnopqrst']],
  ['gitlab token', 'gl' + 'pat-abcdefghij1234567890', ['abcdefghij1234567890']],
  ['google key', 'AI' + 'zaSyA-abcdefghijklmnopqrstuvwxyz01234', ['SyA-abcdefghij']],
  ['stripe keys', 'sk_' + 'live_abcdefghijklmnop rk_' + 'test_abcdefghijklmnop', ['abcdefghijklmnop']],
  ['aws secret near "aws"', 'aws secret wJalrXUtnFEMI' + '/K7MDENG/bPxRfiCYEXAMPLEKEY', ['wJalrXUtnFEMI']],
  ['URL credentials', 'https://jane:hunter2@example.com/x', ['jane', 'hunter2']],
  ['URL password only', 'redis://:hunter2@cache.local:6379', ['hunter2']],
  ['password in prose', 'the password is hunter2 ok', ['hunter2']],
  ['signal token', `x-buddy-token ${'3f'.repeat(32)}`, ['3f3f3f3f3f3f']],
  ['email', 'mail jane.doe+x@example.co.uk', ['jane.doe', 'example.co.uk']],
  // 8. addresses
  ['IPv4', 'connect 192.168.1.23:22 failed', ['192.168.1.23']],
  ['IPv6', 'from fe80::1c2b:3aff:fe4d:5e6f%en0', ['fe80::1c2b', '3aff:fe4d']],
  // 9. host and user
  ['host and user', 'sessions/Janes-MacBook-Pro-claude-abc.json by jane on Janes-MacBook-Pro.local', ['Janes-MacBook', 'jane']],
  ['dash-encoded projects dir', 'project -Users-jane-work-secret', ['jane']],
  // 10. JSON errors quoting their input
  ['JSON.parse snippet', `SyntaxError: Unexpected token 'a', "a secret prompt" is not valid JSON`, ['a secret prompt']],
];

for (const [name, input, gone] of LEAKS) {
  test(`scrub leaks nothing: ${name}`, () => {
    const out = scrub(input, { ...opts, names: ['acme-corp/clientx'] });
    for (const g of gone) assert.ok(!out.toLowerCase().includes(g.toLowerCase()), `"${g}" survived in: ${out}`);
  });
}

test('home paths become ~ and folder names under it are hashed', () => {
  const out = scrub('[hooks] /Users/jane/.claude/settings.json not updated: bad', opts);
  assert.equal(out, `[hooks] ~/.claude/settings.json ${H('not')} ${H('updated')}: bad`);
});

test('the same folder hashes the same within a bundle, differently across salts', () => {
  const out = scrub('"/Users/jane/proj/ab" and "/Users/jane/proj/cd"', opts);
  assert.equal(out, `"~/${H('proj')}/${H('ab')}" and "~/${H('proj')}/${H('cd')}"`);
  assert.notEqual(hashName('proj', 's'), hashName('proj', 't'));
  // Without a salt each call picks its own, so a hash can't be looked up.
  assert.notEqual(scrub('/Users/jane/proj', { home: HOME }), scrub('/Users/jane/proj', { home: HOME }));
});

test("the app's own paths and file names stay readable in stack traces", () => {
  const trace = 'Error: boom\n    at readSessions (/Applications/Claude Buddy.app/Contents/Resources/app.asar/main.js:412:7)\n    at /Users/jane/.claude-traffic-light/hooks/set-status.js:20:1';
  const out = scrub(trace, opts);
  assert.match(out, /\(\/Applications\/Claude Buddy\.app\/Contents\/Resources\/app\.asar\/main\.js:412:7\)/);
  assert.match(out, /~\/\.claude-traffic-light\/hooks\/set-status\.js:20:1$/);
  const json = scrub('{"userData":"/Users/jane/Library/Application Support/Claude Buddy"}', opts);
  assert.equal(json, '{"userData":"~/Library/Application Support/Claude Buddy"}');
});

test('a hook command keeps its file name but not its folders', () => {
  const out = scrub('ELECTRON_RUN_AS_NODE=1 node "/Users/jane/Development/claude-traffic-light/hooks/set-status.js" stop', opts);
  assert.equal(out, `ELECTRON_RUN_AS_NODE=1 node "~/${H('Development')}/${H('claude-traffic-light')}/hooks/set-status.js" stop`);
});

test('URLs keep scheme and host; repos are hashed', () => {
  assert.equal(scrub('see https://code.claude.com/docs/en/hooks', opts), `see https://${H('code.claude.com')}/${H('docs')}/${H('en')}/hooks`);
  assert.equal(scrub('see https://github.com/docs', opts), `see https://github.com/${H('docs')}`);
  assert.equal(scrub('remote git@github.com:acme/app.git', opts), `remote git@github.com:${H('acme')}/${H('app.git')}`);
  assert.equal(scrub('[git] polling acme/app', { ...opts, names: ['acme/app'] }), `[git] polling ${H('acme')}/${H('app')}`);
  assert.equal(scrub('[git] pr acme/app#12', opts), `[git] pr ${H('acme')}/${H('app')}#12`);
});

test('loopback, ports, versions and UUIDs pass through', () => {
  const s = '[signal server] listen EADDRINUSE: address already in use 127.0.0.1:47172';
  assert.equal(scrub(s, opts), s);
  assert.equal(scrub('Chrome 140.0.7339.41 · Electron 44.3.0', opts), 'Chrome 140.0.7339.41 · Electron 44.3.0');
  assert.equal(scrub('session 3f2a9c1e-8b7d-4e6f-a5c4-1b2d3e4f5a6b', opts), 'session 3f2a9c1e-8b7d-4e6f-a5c4-1b2d3e4f5a6b');
  // A lone slash in prose is no path; "and/or" is, and fails closed.
  assert.equal(scrub('10:00:00 a / b 1/2', opts), '10:00:00 a / b 1/2');
  assert.equal(scrub(null), '');
});

test('too-short user names would redact ordinary words, so they are left', () => {
  assert.equal(scrub('go to it', { user: 'go' }), 'go to it');
});

test('cleanJsonError drops the quoted input', () => {
  assert.equal(cleanJsonError(`Unexpected token 'a', "a secret" is not valid JSON`), 'invalid JSON (input not shown)');
  assert.equal(cleanJsonError('Expected property name or \'}\' in JSON at position 1'), 'Expected property name or \'}\' in JSON at position 1');
});

test('redactSecretsPass: "password is: X" loses X even though the shared key=value rule also matches', () => {
  for (const t of ['password is: hunter2', 'Password is:hunter2 ok', 'my passphrase is: hunter2']) {
    const out = require('../src/scrub.js').redactSecretsPass(t);
    assert.ok(!out.includes('hunter2'), out);
  }
});

// Review L2: anything that names a person, a machine or a private network is gone
// from a title before it can leave for a team hub.
const TITLE_LEAKS = [
  ['ssh 10.0.0.5 failing', '10.0.0.5', '[ip]'],
  ['mail sam@acme.co.za today', 'sam@acme.co.za', '[email]'],
  ['fe80::1ff:fe23:4567:890a down', 'fe80::1ff:fe23:4567:890a', '[ip]'],
  ['bind [fe80::1]:8080 fails', 'fe80::1', '[ip]'],
  ['db1.internal.example.com slow', 'db1.internal.example.com', '[host]'],
  ['connect db.corp.acme.internal:5432', 'db.corp.acme.internal', '[host]'],
  ['call +27 82 555 0199 back', '+27 82 555 0199', '[phone]'],
  ['call 082 555 0199 back', '082 555 0199', '[phone]'],
  ['ring +1 (415) 555-0100', '415) 555-0100', '[phone]'],
  ['ring +44 20 7946 0958', '7946 0958', '[phone]'],
  ['open https://grafana.corp.acme.internal/d/x', 'grafana.corp.acme.internal', '[host]'],
];
test('scrubTitle: IPs, emails, IPv6, internal host names and phone numbers never survive', () => {
  const { scrubTitle } = require('../src/scrub.js');
  for (const [input, gone, mark] of TITLE_LEAKS) {
    const out = scrubTitle(input);
    assert.ok(!out.toLowerCase().includes(gone.toLowerCase()), `${input} -> ${out}`);
    assert.ok(out.includes(mark), `${input} -> ${out}`);
    assert.doesNotMatch(out, /\+\d[\d ().-]{7,}|\.internal/, `${input} -> ${out}`);
  }
  assert.equal(scrubTitle('token ghp_' + 'a'.repeat(36)).includes('a'.repeat(36)), false, 'secrets still go');
});

// Titles are mostly code talk: none of these may be touched.
const TITLE_GUARDS = [
  'v1.2.3', 'bump to 1.2.3', 'node 22.4.1', 'release 0.12.30', '1.2.3.4-beta',
  'at 10:30', 'at 10:30:15', '2026-10-24T10:30Z', 'due 2026-10-24', 'due 24/10/2026', 'tag 2026.10.24',
  'ENG-42', 'fix KEY-1234', 'PR #1234', 'owner/repo#12',
  'port :5432', '3000 users', '12 345 rows', 'issue 2026 10 24',
  'index.html', 'foo.test.js', 'README.md', 'src/app.config.ts', 'a.b.c.json',
  'github.com', 'api.github.com', 'claude.ai', 'localhost:3000', '127.0.0.1', '::1',
  'std::vector', 'a::b', 'acme.io',
];
test('scrubTitle: versions, times, dates, ticket keys, counts, file names, public hosts and code survive', () => {
  const { scrubTitle } = require('../src/scrub.js');
  for (const g of TITLE_GUARDS) assert.equal(scrubTitle(g), g, g);
  assert.equal(scrubTitle('Fix login on 10.0.0.5 for ENG-42 (v1.2.3) at 10:30'), 'Fix login on [ip] for ENG-42 (v1.2.3) at 10:30');
});

// The share_summaries path (WorkRecord.forShare) goes through scrub(), which let phone
// numbers through (review L2).
test('scrub: phone numbers go, with the same guards as scrubTitle', () => {
  for (const [input, gone] of [['call +27 82 555 0199 back', '+27 82 555 0199'], ['call 082 555 0199', '082 555 0199'], ['ring +1 (415) 555-0100', '415) 555-0100'], ['ring +44 20 7946 0958', '7946 0958']]) {
    const out = scrub(input, opts);
    assert.ok(!out.includes(gone) && out.includes('[phone]'), `${input} -> ${out}`);
  }
  // scrub() fails closed on some of these (it hashes file names and paths, and reads
  // "a::b" as an address); those are left as they were. None may become a phone.
  const OVER = new Set(['1.2.3.4-beta', 'owner/repo#12', 'foo.test.js', 'src/app.config.ts', 'a.b.c.json', 'a::b']);
  for (const g of TITLE_GUARDS) {
    const out = scrub(g, opts);
    assert.ok(!out.includes('[phone]'), `${g} -> ${out}`);
    if (!OVER.has(g)) assert.equal(out, g, g);
  }
});
