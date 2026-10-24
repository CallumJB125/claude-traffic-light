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

// #52 review: more phone shapes, package@version is no email, two-label private hosts,
// and a tailnet name other than the hub's own.
const REVIEW_LEAKS = [
  ['call (415) 555-0100', '555-0100', '[phone]'],
  ['call 415-555-0100', '415-555-0100', '[phone]'],
  ['call 1-800-555-0100', '800-555-0100', '[phone]'],
  ['call 415.555.0100', '415.555.0100', '[phone]'],
  ['call +27.82.555.0199', '555.0199', '[phone]'],
  ['call +27825550199', '27825550199', '[phone]'],
  ['call 0825550199', '0825550199', '[phone]'],
  ['call +49 (0)30 123456', '123456', '[phone]'],
  ['call 082 555 0199.', '0199', '[phone]'],
  ['mount nas.local', 'nas.local', '[host]'],
  ['deploy via jenkins.corp', 'jenkins.corp', '[host]'],
  ['GET api.internal/health', 'api.internal', '[host]'],
  ['open router.lan', 'router.lan', '[host]'],
  ['open nas.home.arpa', 'nas.home.arpa', '[host]'],
  ['open wiki.intranet', 'wiki.intranet', '[host]'],
  ['ssh callums-mac.tail1234.ts.net', 'callums-mac', '[host]'],
];
const REVIEW_GUARDS = [
  'bump react@18.3.1', 'react-dom@18.3.1', '@types/node@20.1.0', 'npx create-next-app@14.2.3',
  'due 2026-10-24', 'at 10:30:15', 'v1.2.3', 'issue #4155550100', 'PR 1234', 'ENG-4155',
  'hub.tail1234.ts.net', 'port 8080 and 3000',
];
test('scrubTitle: #52 review leaks go, and the guards stay', () => {
  const { scrubTitle } = require('../src/scrub.js');
  const hub = { hubHost: 'hub.tail1234.ts.net' };
  for (const [input, gone, mark] of REVIEW_LEAKS) {
    const out = scrubTitle(input, hub);
    assert.ok(!out.includes(gone) && out.includes(mark), `${input} -> ${out}`);
  }
  for (const g of [...REVIEW_GUARDS, ...TITLE_GUARDS]) assert.equal(scrubTitle(g, hub), g, g);
  // A 40-character hash is never a phone. (The secret pass already takes it as a
  // possible token; that over-redaction is for the follow-up PR, not this one.)
  for (const h of ['commit 3f2c9a0e4b1d8c7f6e5a4b3c2d1e0f9a8b7c6d5e', 'sha 0825550199abcdef0123456789abcdef01234567']) assert.doesNotMatch(scrubTitle(h, hub), /\[phone\]/, h);
  assert.equal(scrubTitle('mail sam@acme.co.za', hub), 'mail [email]');
  assert.equal(scrubTitle('ssh hub.tail1234.ts.net'), 'ssh [host]', 'no hub given: every tailnet name goes');
});
test('scrub: the review phone shapes go and package versions are no email', () => {
  for (const [input, gone] of REVIEW_LEAKS.filter(([, , m]) => m === '[phone]')) {
    const out = scrub(input, opts);
    assert.ok(!out.includes(gone) && out.includes('[phone]'), `${input} -> ${out}`);
  }
  for (const g of REVIEW_GUARDS) { const out = scrub(g, opts); assert.ok(!/\[phone\]|\[email\]/.test(out), `${g} -> ${out}`); }
  for (const h of ['nas.local', 'jenkins.corp', 'api.internal']) assert.ok(!scrub(`open ${h}`, opts).includes(h), h);
});
test('scrubTitle and scrub: a North American number needs NANP area code and exchange (2-9)', () => {
  const { scrubTitle } = require('../src/scrub.js');
  for (const g of ['ids 100-200-3000', 'seq 123-456-7890', 'seq 123.456.7890', 'seq (123) 456-7890', 'n 415-155-0100']) {
    assert.equal(scrubTitle(g), g, g);
    assert.doesNotMatch(scrub(g, opts), /\[phone\]/, g);
  }
  for (const p of ['(415) 555-0100', '415-555-0100', '1-800-555-0100', '415.555.0100']) assert.equal(scrubTitle(`call ${p}`), 'call [phone]', p);
});

test('scrubText: zero-width, full-width and other compatibility forms cannot hide a match (#52 follow-up)', () => {
  const { scrubTitle } = require('../src/scrub.js');
  const cases = [
    ['call +27​82 555 0199', 'call [phone]'], ['call +27 82 555 0199', 'call [phone]'],
    ['call ＋２７ ８２ ５５５ ０１９９', 'call [phone]'], ['ping 10​.0.0.5', 'ping [ip]'],
    ['ping 10.0.0.5⁠', 'ping [ip]'], ['ssh db​.corp.acme.internal', 'ssh [host]'], ['mail sam＠acme.com', 'mail [email]'],
    ['mail sam@acme‍.com', 'mail [email]'], ['ping 10.0.‮0.5', 'ping [ip]'], ['tag 10.0.0.5\u{E0041}\u{E0042}', 'tag [ip]'],
    ['ssh nas͏.local', 'ssh [host]'],
  ];
  for (const [input, want] of cases) assert.equal(scrubTitle(input), want, JSON.stringify(input));
  // Format characters that mean something between other letters stay.
  for (const keep of ['family \u{1F468}‍\u{1F469}‍\u{1F467}', 'می‌خواهم', 'сервер работает']) assert.equal(scrubTitle(keep), keep, keep);
  // NFKC growth is capped: ㌕ grows 5x, U+FDFA 18x.
  for (const big of ['㌕'.repeat(20000), 'ﷺ'.repeat(20000), '​'.repeat(1e6)]) {
    const t = performance.now(); const out = scrubTitle(big);
    assert.ok(out.length <= 64 * 1024 && performance.now() - t < 500, `${out.length} chars in ${Math.round(performance.now() - t)} ms`);
  }
});

test('scrubText: variation selectors, combining marks, fillers and doubled spaces cannot hide a match (#58 review)', () => {
  const { scrubTitle } = require('../src/scrub.js');
  const cases = [['call +27️82 555 0199', 'call [phone]'], ['ping 10.0️.0.5', 'ping [ip]'], ['mail bob︀@acme.com', 'mail [email]'],
    ['ping 10.0́.0.5', 'ping [ip]'], ['mail bob́@acme.com', 'mail [email]'], ['ping 10.0᠋.0.5', 'ping [ip]'], ['ping 10.0᠏.0.5', 'ping [ip]'],
    ['ping 10.0឴.0.5', 'ping [ip]'], ['ping 10.0឵.0.5', 'ping [ip]'], ['ping 10.0⠀.0.5', 'ping [ip]'], ['ping 10.0\u{E0100}.0.5', 'ping [ip]'],
    ['ping 10.0\u{E01EF}.0.5', 'ping [ip]'], ['call +27 82 ​ 555 0199', 'call [phone]'], ['call +27 82  555 0199', 'call [phone]'], ['call +27 82\t\t555 0199', 'call [phone]']];
  for (const [input, want] of cases) assert.equal(scrubTitle(input), want, JSON.stringify(input));
  // A variation selector or mark on a letter that is not ASCII is part of it.
  for (const keep of ['❤️ done', 'ok \u{1F44D}️', '\u{1F469}‍\u{1F4BB} done', 'café', 'café au lait', 'tiếng Việt', 'नमस्ते']) {
    assert.equal(scrubTitle(keep), keep.normalize('NFKC'), JSON.stringify(keep));
  }
  // A report keeps its indentation; only runs of spaces inside a line fold.
  const { scrubText } = require('../src/scrub.js');
  assert.equal(scrubText('Done:\n    call +27 82  555 0199\n    ok'), 'Done:\n    call [phone]\n    ok');
});

test('scrub: compatibility bombs and very long lines stay bounded and never throw (#58 review, round 2)', () => {
  const four = String.fromCodePoint([...Array(0x100)].map((_, i) => 0x3300 + i).find((c) => String.fromCodePoint(c).normalize('NFKC').length === 4));
  for (const [name, bomb] of [['U+FDFA', '\ufdfa'.repeat(100000)], ['U+3315', '\u3315'.repeat(100000)], ['lines of U+FDFA', ('\ufdfa'.repeat(3000) + '\n').repeat(40)],
    ['4x grower', four.repeat(100000)], ['lines of a 4x grower', (four.repeat(900) + '\n').repeat(120)], ['U+2491 (10.)', '\u2491'.repeat(100000)]]) {
    const t = performance.now();
    const out = scrub(bomb, opts);
    const ms = performance.now() - t;
    assert.ok(out.length <= 2 * bomb.length && ms < 500, `${name}: ${out.length} chars from ${bomb.length} in ${Math.round(ms)} ms`);
  }
  const { scrubTitle } = require('../src/scrub.js');
  assert.ok(scrubTitle('ﷺ'.repeat(100000)).length <= 2 * 64 * 1024);
  // The characters NFKC grows past 4 are left as they are; the list matches this Node's NFKC.
  const grows = [];
  for (let c = 0; c < 0x30000; c++) if ((c < 0xd800 || c > 0xdfff) && String.fromCodePoint(c).normalize('NFKC').length > 4) grows.push(c);
  for (const c of grows) assert.equal(scrub(`x ${String.fromCodePoint(c)} y`, opts), `x ${String.fromCodePoint(c)} y`, c.toString(16));
  // A character that grows into digits still folds, so it cannot rebuild an address.
  assert.equal(scrub('ping \u24910.0.5', opts), 'ping [ip]');
  assert.match(scrub((four.repeat(900) + '\n').repeat(120), opts), /\[cut: the text grew past twice its size\]$/);
  // A 6M-character line is cut, not a RangeError.
  assert.match(scrub('a'.repeat(6e6), opts), /^\[long line omitted: 6000000 chars\]$/);
  assert.equal(scrub(`ok\n${'b'.repeat(5e6)}\ncall +27 82 555 0199`, opts), 'ok\n[long line omitted: 5000000 chars]\ncall [phone]');
});

test('scrubText and scrub: a cut drops whole lines, so nothing straddling it leaves a fragment (#58 review, round 3)', () => {
  const { scrubText } = require('../src/scrub.js');
  const pii = ['+27 82 555 0199', 'dana.smith@acme-corp.example', '10.20.30.40', 'jenkins.corp.acme.com', '415-555-0100'];
  // Any 5 characters of the value in the output is a fragment.
  const fragment = (out, v) => { for (let i = 0; i + 5 <= v.length; i++) if (out.includes(v.slice(i, i + 5))) return v.slice(i, i + 5); return null; };
  const sweep = (label, run, make, from, to) => {
    for (const v of pii) for (let f = from; f <= to; f++) {
      const out = run(make(f, v));
      const bit = fragment(out, v);
      assert.equal(bit, null, `${label} ${v} at ${f}: "${bit}" left in ...${JSON.stringify(out.slice(-80))}`);
    }
  };
  // The tail keeps the text past the limit while the value straddles the cut.
  const tail = ` after ${'y'.repeat(300)}`;
  // scrubText: the folded text (a 15000-char line of \u247d folds to 60000) is cut at 64K.
  sweep('scrubText grown', (t) => scrubText(t), (f, v) => `${'\u247d'.repeat(15000)}\n${'z'.repeat(f)} ${v}${tail}`, 5460, 5500);
  // scrubText: the raw text is cut at 64K before folding.
  sweep('scrubText raw', (t) => scrubText(t), (f, v) => `${'z'.repeat(f)} ${v}${tail}`, 65505, 65535);
  // scrub(): the folded text is cut at twice the input. Lines stay under MAX_LINE, or
  // the long-line cut would drop them first.
  const bomb = `${'\u247d'.repeat(1000)}\n`.repeat(15);
  sweep('scrub grown', (t) => scrub(t, opts), (f, v) => `${bomb}${'zz\n'.repeat(Math.floor(f / 3))}${'z'.repeat(f % 3)} ${v}${tail}`, 29340, 29410);
  // A cut with no newline before it leaves only the marker.
  assert.match(scrubText('⑽'.repeat(20000)), /^\[cut: [^\]]+\]$/);
});
