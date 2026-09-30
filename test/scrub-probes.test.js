// The verifier's probes (item 12 review), kept as tests so the scrubber can
// move onto shared secret patterns later without losing ground. Each case:
// [label, input, substrings that must not survive, options].
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { scrub, PATTERNS, MAX_LINE } = require('../src/scrub.js');
const Health = require('../src/health.js');

const MAC = { home: '/Users/alice', user: 'alice', hostname: 'alices-mbp.local', salt: 'fixedsalt', names: ['acme-corp/topsecret-repo'] };
const WIN = { ...MAC, home: 'C:\\Users\\alice' };

const PROBES = [
 ['win spaces unquoted', 'loading C:\\Users\\alice\\Acme Payroll\\Q3 Plan\\x.json now', ['Acme','Payroll','Q3 Plan','Plan'], WIN],
 ['win spaces quoted', 'open "C:\\Users\\Bob Smith\\Acme Payroll\\x.json" failed', ['Bob','Smith','Acme','Payroll'], WIN],
 ['win other user single-quoted', "open 'D:\\Clients\\Globex Merger\\deal.xlsx'", ['Clients','Globex','Merger','deal'], WIN],
 ['json escaped \\\\', '{"cwd":"C:\\\\Users\\\\alice\\\\acme merger\\\\src"}', ['acme','merger','alice'], WIN],
 ['json escaped \\/', '{"cwd":"\\/Users\\/alice\\/acme-merger\\/src"}', ['acme-merger','alice'], MAC],
 ['forward C:/', 'at C:/Users/alice/projX/app.js:3', ['projX','alice'], WIN],
 ['forward C:/ other', 'at C:/work/Globex/app.js:3', ['Globex'], WIN],
 ['UNC', 'reading \\\\fileserver\\Finance Share\\payroll.xlsx', ['fileserver','Finance','Share','payroll'], WIN],
 ['file://', 'loaded file:///Users/alice/secret-proj/index.html', ['secret-proj','alice'], MAC],
 ['file:// other user', 'loaded file:///Users/bob/secret-proj/index.html', ['secret-proj','bob'], MAC],
 ['path after colon', 'cwd:/work/acme-merger/src', ['acme-merger'], MAC],
 ['path after @', 'dep@/work/acme-merger/pkg', ['acme-merger'], MAC],
 ['url-encoded', 'GET /open?p=%2FUsers%2Falice%2FAcme%20Payroll%2Fx.json', ['Acme','Payroll','alice'], MAC],
 ['url-encoded lower', 'p=%2fwork%2fglobex%2dmerger', ['globex'], MAC],
 ['git ssh', 'remote git@github.com:acme-corp/topsecret-repo.git', ['acme-corp','topsecret'], MAC],
 ['git ssh other', 'remote git@gitlab.com:globex/merger-plan.git', ['globex','merger-plan'], MAC],
 ['https url path', 'fetching https://github.com/globex/merger-plan/pull/4', ['globex','merger-plan'], MAC],
 ['https user', 'https://bob:pw123@github.com/globex/x', ['bob','pw123','globex'], MAC],
 ['org/repo#', 'fixes globex/merger-plan#123', ['globex','merger-plan'], MAC],
 ['Basic auth', 'Authorization: Basic Ym' + '9iOnNlY3JldHB3', ['Ym9iOnNlY3JldHB3'], MAC],
 ['Bearer', 'curl -H "Authorization: Bearer abc.def.ghijklmnop"', ['abc.def.ghijklmnop','ghijklmnop'], MAC],
 ['bare bearer', 'using bearer Zm9vYmFyYmF6cXV4', ['Zm9vYmFyYmF6cXV4'], MAC],
 ['PEM', '-----BE' + 'GIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretkeymaterial\n-----END RSA PRIVATE KEY-----', ['MIIEowIBAAKCAQEAsecretkeymaterial'], MAC],
 ['PEM truncated', '-----BE' + 'GIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA', ['b3BlbnNzaC1rZXktdjEAAAA'], MAC],
 ['aws secret', 'aws_secret_access_key = wJalrXUtnFEMI' + '/K7MDENG/bPxRfiCYEXAMPLEKEY', ['wJalrXUtnFEMI','bPxRfiCYEXAMPLEKEY'], MAC],
 ['aws secret json', '"AWS_SECRET_ACCESS_KEY":"wJalrXUtnFEMI' + '/K7MDENG/bPxRfiCYEXAMPLEKEY"', ['wJalrXUtnFEMI','EXAMPLEKEY'], MAC],
 ['xapp', 'token xa' + 'pp-1-A0123456789-0123456789-abcdef', ['A0123456789'], MAC],
 ['xoxe.xoxp', 'xoxe.xo' + 'xp-1-Mi0yLTEyMzQ1Njc4OTAtabcdef', ['Mi0yLTEyMzQ1Njc4OTAt'], MAC],
 ['npm_', 'np' + 'm_abcdefghijklmnopqrstuvwxyz0123456789', ['abcdefghijklmnopqrst'], MAC],
 ['glpat', 'gl' + 'pat-xxxxYYYYzzzz1234', ['xxxxYYYYzzzz1234'], MAC],
 ['AI' + 'za', 'key AI' + 'zaSyA1234567890abcdefghijklmnopqrstu', ['SyA1234567890abcdef'], MAC],
 ['sk_live', 'sk_' + 'live_51Habcdefghijk', ['51Habcdefghijk'], MAC],
 ['redis', 'redis://:hu' + 'nter2pw@cache.internal:6379/0', ['hunter2pw','cache.internal'], MAC],
 ['password is', 'my password is Tr0ub4dor&3 ok', ['Tr0ub4dor'], MAC],
 ['quoted multiword pw', 'password: "correct horse battery staple"', ['correct horse','battery','staple'], MAC],
 ['single quoted multiword pw', "db_password='correct horse battery'", ['correct','horse'], MAC],
 ['ipv4', 'connect 10.2.3.4:443 and 192.168.1.20', ['10.2.3.4','192.168.1.20'], MAC],
 ['ipv6', 'from fe80::1ff:fe23:4567:890a', ['fe80::1ff','4567:890a'], MAC],
 ['hostname', 'session alices-mbp.local-123 and Alices-MBP', ['alices-mbp','Alices-MBP'], MAC],
 ['hostname underscore', 'file alices-mbp_session.json', ['alices-mbp'], MAC],
 ['user alone', 'user alice logged; ALICE', ['alice','ALICE'], MAC],
 // NEW
 ['ENOENT', "Error: ENOENT: no such file or directory, open '/Users/alice/Acme Payroll/x.json'", ['Acme','Payroll','alice'], MAC],
 ['EACCES', "Error: EACCES: permission denied, mkdir '/Users/alice/secret dir'", ['secret','alice'], MAC],
 ['EACCES unquoted', 'EACCES: permission denied, scandir /Users/alice/secret dir', ['secret','alice'], MAC],
 ['stack frame spaces', '    at fn (/Users/alice/proj x/a.js:1:2)', ['proj','alice'], MAC],
 ['stack frame file url', '    at file:///Users/alice/proj/a.mjs:3:4', ['proj','alice'], MAC],
 ['stack frame file url other', '    at file:///Users/bob/projz/a.mjs:3:4', ['projz','bob'], MAC],
 ['win stack frame', '    at C:\\Users\\Bob Smith\\app\\a.js:1:2', ['Bob','Smith'], WIN],
 ['win stack frame paren', '    at Object.<anonymous> (C:\\Users\\Bob Smith\\globex\\a.js:1:2)', ['Bob','Smith','globex'], WIN],
 ['parens', 'see (/work/globex merger/readme.md) for', ['globex','merger'], MAC],
 ['brackets', 'files [/work/globex/a.js, /work/initech/b.js]', ['globex','initech'], MAC],
 ['markdown link', 'see [notes](/work/globex-notes/plan.md)', ['globex-notes'], MAC],
 ['markdown link text path', 'see [/work/globex/plan.md](https://x.com/globex/plan)', ['globex'], MAC],
 ['sentence end', 'Saved to /work/globex/plan.md.', ['globex'], MAC],
 ['sentence end home', 'Saved to ~/Initech/report.', ['Initech'], MAC],
 ['tabs', 'path\t/work/globex\tsize\t/work/initech/x', ['globex','initech'], MAC],
 ['tab inside path?', '/work/globex\tmerger', ['globex'], MAC],
 ['unicode', 'opening /Users/alice/Проект/x', ['Проект','alice'], MAC],
 ['emoji', 'opening /Users/alice/💰 money/x', ['💰','money'], MAC],
 ['lone slash', 'a / b and / c', [], MAC],
 ['tilde', 'wrote ~/globex-plans/q3.md', ['globex-plans'], MAC],
 ['env vars', 'HOME=/Users/alice PROJECT=/work/acme', ['acme','alice'], MAC],
 ['cwd json', '{"cwd":"/Users/alice/work/acme-merger","x":1}', ['acme-merger','alice'], MAC],
 ['dash encoded', 'read ~/.claude/projects/-Users-alice-work-acme-merger/abc.jsonl', ['acme-merger','alice'], MAC],
 ['dash encoded bare', 'project -Users-alice-work-acme-merger', ['acme-merger','alice'], MAC],
 ['dash encoded other user', '~/.claude/projects/-Users-bob-work-globex/', ['globex','bob'], MAC],
 ['names metachar', 'repo a+b/c(d) here', ['a+b','c(d)'], { ...MAC, names: ['a+b/c(d)'] }],
 ['names in path', 'cloning /work/acme-corp/topsecret-repo/x', ['acme-corp','topsecret'], MAC],
 ['names case', 'ACME-CORP/TopSecret-Repo', ['ACME','TopSecret'], MAC],
 ['names standalone repo', 'repo topsecret-repo only', ['topsecret'], MAC],
 ['path w/ comma dir', '/work/globex, inc/plan.md', ['globex','inc'], MAC],
 ['path w/ colon-space', 'ENOENT /work/globex: merger/plan', ['globex','merger'], MAC],
 ['path digits after colon', '/work/globex:2024 plans/x', ['globex','plans'], MAC],
 ['relative path', 'open globex-merger/plan.md', ['globex-merger'], MAC],
 ['windows relative', 'open .\\globex\\plan.md', ['globex'], WIN],
 ['angle', '<C:\\work\\globex\\a.js>', ['globex'], WIN],
 ['pipe', '/work/globex|merger', ['globex','merger'], MAC],
 ['backtick', 'ran `ls /work/globex merger`', ['globex','merger'], MAC],
 ['percent in path', '/work/globex%merger', ['globex'], MAC],
 ['URL w/ query', 'https://api.example.com/v1/orgs/globex?token=abcsecret123', ['globex','abcsecret123'], MAC],
 ['URL fragment', 'https://docs.globex.com/a', ['globex'], MAC],
 ['email', 'contact bob.smith@globex.com', ['bob.smith','globex'], MAC],
 ['KEYED cookie', 'Cookie: sessionid=abc123secret; other=1', ['abc123secret'], MAC],
 ['set-cookie', 'set-cookie: sid=abc123secret', ['abc123secret'], MAC],
 ['api key header', 'x-api-key: abcdefsecret99', ['abcdefsecret99'], MAC],
 ['ANTHROPIC key', 'ANTHROPIC_API_KEY=sk-' + 'ant-api03-abcdefghijklmnop', ['abcdefghijklmnop'], MAC],
 ['generic kv', 'client_secret: "s3cr3t v@lue"', ['s3cr3t','v@lue'], MAC],
 ['password escaped quote', 'password="a\\"b c"', ['a\\"b','b c'], MAC],
 ['--password flag', 'mysql --password=hunter2 -u root', ['hunter2'], MAC],
 ['-p flag', 'mysql -phunter2', ['hunter2'], MAC],
 ['PASSWORD env space', 'PASSWORD hunter2', ['hunter2'], MAC],
 ['pw after is colon', 'the password is: hunter2', ['hunter2'], MAC],
 ['postgres url', 'postgres://admin:hunter2@db.globex.com:5432/payroll', ['hunter2','admin','globex','payroll'], MAC],
];
const PROBES_2 = [
 ['AI' + 'za real length', 'key AI' + 'zaSyA1234567890abcdefghijklmnopqrstuv', ['SyA1234567890'], MAC],
 ['user underscore', 'alice_notes and alice2 and alice-work', ['alice'], MAC],
 ['host underscore', 'alices-mbp_1234.json', ['alices-mbp'], MAC],
 ['host digits', 'alices-mbp2 alicesmbp', ['alices'], MAC],
 ['user in camel', 'aliceSmith', ['alice'], MAC],
 ['relative quoted ./', "Cannot find module './globex/secret-x'", ['globex','secret-x'], MAC],
 ['relative quoted ../', "require('../acme-merger/lib')", ['acme-merger'], MAC],
 ['git status relative', ' M globex-merger/plan.md', ['globex-merger'], MAC],
 ['app own path spaces', 'at /Applications/Claude Buddy.app/Contents/Resources/app.asar/main.js:120:5', [], MAC],
 ['app own file url', 'at file:///Applications/Claude%20Buddy.app/Contents/Resources/app.asar/src/scrub.js:3:4', [], MAC],
 ['other file url line', 'at file:///opt/globex/a.mjs:3:4', ['globex'], MAC],
 ['home case', '/users/ALICE/Globex/x', ['Globex','ALICE'], MAC],
 ['home prefix other user', '/Users/alicesmith/globex', ['globex','alicesmith'], MAC],
 ['win lowercase drive', 'c:\\users\\alice\\globex\\x', ['globex'], WIN],
 ['win mixed sep', 'C:\\Users\\alice/globex\\x', ['globex'], WIN],
 ['win home in mac mode', 'C:\\Users\\alice\\globex', ['globex'], MAC],
 ['win 8.3', 'C:\\PROGRA~1\\Globex~1\\x', ['Globex'], WIN],
 ['UNC long', '\\\\?\\C:\\Users\\alice\\globex\\x', ['globex'], WIN],
 ['UNC ip', '\\\\10.1.2.3\\share\\globex', ['10.1.2.3','globex'], WIN],
 ['smb url', 'smb://nas.globex.local/finance/q3', ['finance','q3'], MAC],
 ['vscode url', 'vscode://file/Users/alice/globex/x.js:3', ['globex'], MAC],
 ['names in url', 'https://github.com/acme-corp/topsecret-repo/issues/4', ['acme-corp','topsecret'], MAC],
 ['names in text sentence', 'Pushed to acme-corp/topsecret-repo.', ['acme-corp','topsecret'], MAC],
 ['names escaped slash', 'acme-corp\\/topsecret-repo', ['acme-corp','topsecret'], MAC],
 ['names url-encoded', 'acme-corp%2Ftopsecret-repo', ['acme-corp','topsecret'], MAC],
 ['names with regex meta list', 'x (d) y', [], { ...MAC, names: ['a+b/c(d)', '.*', '[x', '(?<'] }],
 ['names dot-star vs text', 'hello world', [], { ...MAC, names: ['.*'] }],
 ['non-string names', 'acme', ['acme'], { ...MAC, names: [null, 5, {}, 'acme'] }],
 ['names non-array string', 'acme-corp here', ['acme-corp'], { ...MAC, names: 'acme-corp' }],
 ['PEM EC', '-----BE' + 'GIN EC PRIVATE KEY-----\nMHcCAQEEIabc\n-----END EC PRIVATE KEY-----', ['MHcCAQEEIabc'], MAC],
 ['PEM encrypted', '-----BE' + 'GIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkq\n-----END ENCRYPTED PRIVATE KEY-----', ['MIIFHDBOBgkq'], MAC],
 ['PEM JSON escaped', '{"key":"-----BE' + 'GIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----\\n"}', ['MIIEvQIBADANBg'], MAC],
 ['bearer lowercase header', 'authorization: bearer abcDEF123456', ['abcDEF123456'], MAC],
 ['Token header', 'Authorization: token gh' + 'p_abc', ['gh' + 'p_abc'], MAC],
 ['x-auth-token', 'X-Auth-Token: abcsecret', ['abcsecret'], MAC],
 ['session id', 'session=abcdefsecret', [], MAC],
 ['private_key json', '"private_key":"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"', ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'], MAC],
 ['credentials json', '"credentials":"s3cr3t"', ['s3cr3t'], MAC],
 ['aws key id', 'AK' + 'IAIOSFODNN7EXAMPLE', ['AK' + 'IAIOSFODNN7EXAMPLE'], MAC],
 ['aws session token', 'aws_session_token=FwoGZXIvYXdzEBYaDHqa0AP', ['FwoGZXIvYXdzEBYaDHqa0AP'], MAC],
 ['slack webhook', 'https://hooks.sl' + 'ack.com/services/T0001/B0001/XXXXXXXXXXXXXXXXXXXXXXXX', ['XXXXXXXXXXXXXXXXXXXXXXXX','T0001'], MAC],
 ['discord webhook', 'https://discord.com/api/web' + 'hooks/123/abcDEFsecret', ['abcDEFsecret'], MAC],
 ['url query token', 'https://x.com/cb?access_token=abc123secret&code=xyz789secret', ['abc123secret','xyz789secret'], MAC],
 ['stripe whsec', 'wh' + 'sec_abcdefghijklmnop1234', ['abcdefghijklmnop1234'], MAC],
 ['twilio SK', 'SK' + '0123456789abcdef0123456789abcdef', [], MAC],
 ['openai proj', 'sk-' + 'proj-abcdefghijklmnopqrstuv', ['abcdefghijklmnop'], MAC],
 ['JWT', 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', ['eyJ' + 'zdWIiOiIxMjM0'], MAC],
 ['ipv4 mapped', '::ffff:192.168.1.5', ['192.168.1.5'], MAC],
 ['ipv4 w/ port and path', 'http://192.168.1.5:8080/x', ['192.168.1.5'], MAC],
 ['ipv4 cidr', '10.0.0.0/8 and 172.16.5.4/24', ['172.16.5.4'], MAC],
 ['ip in version-like', 'v1.2.3.4 node 20.11.1', [], MAC],
 ['mac addr', 'a4:83:e7:12:34:56', [], MAC],
 ['[state] line passes?', '[state] prompt: please fix /Users/alice/globex payroll', ['globex'], MAC],
];

for (const [label, input, secrets, opts] of PROBES.concat(PROBES_2)) {
  test(`probe: ${label}`, () => {
    const out = scrub(input, opts);
    for (const s of secrets) assert.ok(!out.includes(s), `"${s}" survived in: ${out}`);
  });
}

test('probe: readable parts stay readable', () => {
  assert.equal(scrub('a / b and / c', MAC), 'a / b and / c');
  assert.equal(scrub('at /Applications/Claude Buddy.app/Contents/Resources/app.asar/main.js:120:5', MAC), 'at /Applications/Claude Buddy.app/Contents/Resources/app.asar/main.js:120:5');
  assert.equal(scrub('at file:///Applications/Claude%20Buddy.app/Contents/Resources/app.asar/src/scrub.js:3:4', MAC), 'at file:///Applications/Claude Buddy.app/Contents/Resources/app.asar/src/scrub.js:3:4');
  assert.match(scrub('at file:///opt/globex/a.mjs:3:4', MAC), /^at file:\/\/\/opt\/#[0-9a-f]{6}\/#[0-9a-f]{6}:3:4$/);
  assert.match(scrub('postgres://admin:hunter2@db.globex.com:5432/payroll', MAC), /^postgres:\/\/\[user\]@#[0-9a-f]{6}:5432\/#[0-9a-f]{6}$/);
  // A URL path runs on through the words after it (fail closed), up to the next URL.
  assert.match(scrub('http://127.0.0.1:47172/signal and http://localhost:3000', MAC), /^http:\/\/127\.0\.0\.1:47172\/signal #[0-9a-f]{6} http:\/\/localhost:3000$/);
  assert.equal(scrub('http://192.168.1.5:8080/x', MAC), 'http://[ip]:8080/x');
  assert.match(scrub('"https://example.com/My Docs/q3 plan.pdf"', MAC), /^"https:\/\/#[0-9a-f]{6}\/#[0-9a-f]{6} #[0-9a-f]{6}\/#[0-9a-f]{6} #[0-9a-f]{6}"$/);
  assert.match(scrub('project -Users-alice-work-acme-merger', MAC), /^project ~-#[0-9a-f]{6}$/);
});

test('probe: truncation happens after scrubbing, and an unclosed quote redacts to the line end', () => {
  assert.equal(scrub('password: "correct horse battery…', MAC), 'password: "[redacted]');
  assert.equal(scrub("password='correct horse battery", MAC), "password='[redacted]");
  const pad = (n) => 'x'.repeat(n);
  const ts = '2026-09-30T10:00:00.000Z [error] ';
  const lines = [
    ts + pad(400 - ts.length - 30) + 'password: "correct horse battery staple"',
    ts + pad(400 - ts.length - 45) + 'aws_secret_access_key=wJalrXUtnFEMI' + '/K7MDENG/bPxRfiCYEXAMPLEKEY',
    ts + pad(400 - ts.length - 20) + ' open "/Users/bob/Acme Payroll/x.json"',
    '2026-09-30T10:00:01.000Z [log] [state] s1 working prompt="fix globex payroll"',
    '2026-09-30T10:00:02.000Z [warn] something',
    '  continuation line /work/globex/a.js',
  ];
  const out = Health.diagnostics({ report: { at: 'now', version: '1', problems: 0, checks: [] }, logText: lines.join('\n'), scrubWith: MAC });
  for (const s of ['correct horse', 'battery', 'wJalrXUtnFEMI', 'K7MDENG', 'Acme', 'Payroll', 'globex', 'prompt']) assert.ok(!out.includes(s), s);
});

test('probe: a line too long to scrub in bounded time is dropped whole', () => {
  const long = `token=${'a'.repeat(MAX_LINE)}`;
  assert.equal(scrub(`before\n${long}\nafter /work/globex`, MAC).split('\n')[1], `[long line omitted: ${long.length} chars]`);
});

// ── Time ──────────────────────────────────────────────────────────────────
const N = 100 * 1024;
const SHAPES = {
  'a*': 'a'.repeat(N),
  'word chars w/ dash': 'ab-'.repeat(N / 3),
  hex: 'abcdef0123'.repeat(N / 10),
  'hex colons': '0a:'.repeat(N / 3),
  'dots words': 'a.'.repeat(N / 2),
  slashes: '/a'.repeat(N / 2),
  'slash spaces': '/a '.repeat(N / 3),
  colons: 'a:'.repeat(N / 2),
  'colon space': '/a: '.repeat(N / 4),
  backslashes: '\\a'.repeat(N / 2),
  spaces: ' '.repeat(N),
  tokenword: 'tokenx'.repeat(N / 6),
  'password is': 'password is '.repeat(N / 12),
  aws: 'aws '.repeat(N / 4),
  'aws+b64': `aws ${'A'.repeat(N)}`,
  'at signs': 'a@'.repeat(N / 2),
  'emails-ish': `${'a.b-'.repeat(N / 4)}@`,
  'digits dots': '1.'.repeat(N / 2),
  quotes: '"/'.repeat(N / 2),
  'quote path no close': `"/${'a '.repeat(N / 2)}`,
  url: `http://${'a/'.repeat(N / 2)}`,
  urls: 'a://'.repeat(N / 4),
  bearer: 'bearer '.repeat(N / 7),
  BEGIN: `-----BE${''}GIN RSA PRIVATE KEY-----${'A'.repeat(N)}`,
  BEGINs: '-----BE' + 'GIN '.repeat(N / 11),
  percent: '%2F'.repeat(N / 3),
  'hash repo': 'a/b#'.repeat(N / 4),
  'ipv6-ish': '::'.repeat(N / 2),
  eyJ: `eyJ${'a'.repeat(N)}`,
  'Unexpected token': `Unexpected token ${'x'.repeat(N)}`,
  'dash encoded': `-Users-alice${'-a'.repeat(N / 2)}`,
  'base64 random': crypto.randomBytes(N * 3 / 4).toString('base64'),
  'base64url random': crypto.randomBytes(N * 3 / 4).toString('base64url'),
  'json no spaces': JSON.stringify(Object.fromEntries(Array.from({ length: N / 20 }, (_, i) => [`key${i}`, `val-${i}`]))),
  'minified js': 'var a=b.c.d(e,f);function g(h){return h.i.j-k}'.repeat(N / 48),
  'long kebab': Array.from({ length: N / 8 }, (_, i) => `seg${i}`).join('-'),
  'mixed log': '2026-09-30T10:00:00Z [main] loaded /Users/alice/proj/x.js ok token=abc 10.0.0.1 '.repeat(N / 80),
};
// Each shape twice: as one line (dropped for length) and folded into lines
// just under the cap, which every pattern really has to read.
// Timed once; only a run over its limit is retried (up to five runs, best
// kept). A busy runner or a GC pause can stall a run or two, while a
// superlinear pattern is slow every time; and not re-running fast ones keeps
// this file from loading the machine for everyone else's timing tests.
function timed(fn, limit) {
  let ms = Infinity;
  for (let i = 0; i < 5 && ms >= limit; i += 1) {
    const t = process.hrtime.bigint();
    fn();
    ms = Math.min(ms, Number(process.hrtime.bigint() - t) / 1e6);
  }
  return ms;
}

const fold = (s) => s.match(new RegExp(`[\\s\\S]{1,${MAX_LINE - 50}}`, 'g')).join('\n');

test('time: 100 KB of every pathological shape, whole and folded, under 200 ms each (or 3× an ordinary 100 KB log on a loaded machine)', () => {
  scrub('warm up /a/b token=x', MAC);
  // The yardstick: an ordinary log of the same size, timed now, so a machine
  // busy enough to slow everything down moves the limit with it. A
  // superlinear pattern is seconds either way.
  const ordinary = fold(SHAPES['mixed log']);
  for (const [k, s] of Object.entries(SHAPES)) {
    for (const input of [s, fold(s)]) {
      let ms = timed(() => scrub(input, MAC), 200);
      let limit = 200;
      // Over 200 ms: time the yardstick right now, and the shape again after it.
      if (ms >= limit) {
        limit = Math.max(200, 3 * timed(() => scrub(ordinary, MAC), 0));
        ms = Math.min(ms, timed(() => scrub(input, MAC), limit));
      }
      assert.ok(ms < limit, `${k} (${input.includes('\n') ? 'folded' : 'one line'}): ${ms.toFixed(1)} ms, limit ${limit.toFixed(0)} ms`);
    }
  }
});

test('time: each pattern alone on a 4000-char worst case under 20 ms', () => {
  const W = MAX_LINE;
  const worst = ['a', 'ab-', 'a.', 'a b ', 'tokenx', 'TOKENX', '0a:', '/a: ', 'a@', '::', '1.', '"/', '\'/', 'bearer ', 'aws ', 'sk-', 'eyJa.', 'a/b#', '-Users-a', 'x://', '//a:', 'password is ', 'a=', 'a:', 'a,', 'a|', "'/a\"", '-pa', '%2F', '-----BE' + 'GIN ']
    .map((u) => u.repeat(Math.ceil(W / u.length)).slice(0, W));
  const all = Object.entries(PATTERNS).flatMap(([k, v]) => (Array.isArray(v) ? v.map((r, i) => [`${k}[${i}]`, r]) : v instanceof RegExp ? [[k, v]] : []));
  for (const [k, re] of all) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const s of worst) {
      const ms = timed(() => s.replace(g, 'x'), 20);
      assert.ok(ms < 20, `${k} on "${s.slice(0, 12)}…": ${ms.toFixed(1)} ms`);
    }
  }
});

// ── The shared secret list (board/shared/secret-patterns.mjs) ─────────────
const { redactSecretsPass } = require('../src/scrub.js');
const Shared = require('../src/secret-patterns.js');

test('secrets: spans are value-only, keyed values run to the line end, URL logins are the URL pass\'s', () => {
  assert.equal(redactSecretsPass('Authorization: Basic dX' + 'NlcjpwYXNzd29yZA=='), 'Authorization: Basic [redacted]');
  assert.equal(redactSecretsPass(`Authorization: Bearer ${'aB3dE5fG7h'.repeat(4)}`), 'Authorization: Bearer [redacted]');
  assert.equal(redactSecretsPass('export API_KEY="hu' + 'nter2secret"'), 'export API_KEY="[redacted]"');
  assert.equal(redactSecretsPass('password: my secret phrase'), 'password: [redacted]');
  assert.equal(redactSecretsPass('password: "correct horse'), 'password: "[redacted]');
  assert.equal(redactSecretsPass('https://jane:hunter2@example.com'), 'https://jane:[redacted]@example.com');
  assert.match(scrub('https://jane:hunter2@example.com/x', MAC), /^https:\/\/\[user\]@#[0-9a-f]{6}\/x$/);
  assert.equal(redactSecretsPass('mysql -phunter2 PASSWORD hunter3 the password is: hunter4'), 'mysql -p[redacted] PASSWORD [redacted] the password is: [redacted]');
});

// builder-4's positive table, pinned with src/secret-patterns.js by
// `node scripts/pin-secret-patterns.js <commit>` (read with git show, never
// from a working copy; the commit is stamped in the fixture). Each row's
// secret is the span it names or the module's first hit at that commit, and
// must be gone after our pass, so switching src/scrub.js to the shared module
// changes nothing.
const POSITIVES_FIXTURE = require('./fixtures/secret-patterns-positives.json');
test(`secrets: builder-4's positive table (${POSITIVES_FIXTURE.commit}) is fully redacted by our pass`, () => {
  const join = (parts) => (Array.isArray(parts) ? parts.join('') : '');
  const { rows } = POSITIVES_FIXTURE;
  assert.match(require('fs').readFileSync(require.resolve('../src/secret-patterns.js'), 'utf8'), new RegExp(`feat/secret-patterns\\n// ${POSITIVES_FIXTURE.commit} `), 'fixture and mirror pinned to the same commit');
  assert.ok(rows.length >= 100, `read ${rows.length} rows`);
  for (const r of rows) {
    const text = join(r.text);
    const secret = join(r.secret);
    assert.ok(secret, `${r.kind}: fixture row has no secret (input ${JSON.stringify(text)})`);
    const out = redactSecretsPass(text);
    assert.ok(!out.includes(secret), `${r.kind}: secret survived redactSecretsPass (input ${JSON.stringify(text)} → ${JSON.stringify(out)})`);
    assert.equal(redactSecretsPass(out), out, `${r.kind}: a second pass changed an already-redacted line (input ${JSON.stringify(text)})`);
    const full = scrub(text, MAC);
    assert.ok(!full.includes(secret), `${r.kind}: secret survived scrub (input ${JSON.stringify(text)} → ${JSON.stringify(full)})`);
  }
});

test('time: every shared and extra secret pattern on a 4000-char worst case under 20 ms', () => {
  const W = MAX_LINE;
  const worst = ['a', 'ab-', 'a.', 'tokenx', 'TOKENX', 'password: "', 'Bearer ', 'aws ', '-p', 'AI' + 'za', 'x://a:', '-----BE' + 'GIN PRIVATE KEY-----', 'eyJa.', 'sk-', '1//0']
    .map((u) => u.repeat(Math.ceil(W / u.length)).slice(0, W));
  const res = Shared.SECRET_PATTERNS.map((p) => [p.kind, new RegExp(p.re.source, `${p.re.flags.replace('g', '')}g`)]).concat(PATTERNS.EXTRA_SECRETS.map((r, i) => [`extra[${i}]`, r]));
  for (const [k, re] of res) {
    for (const s of worst) {
      const ms = timed(() => s.replace(re, 'x'), 20);
      assert.ok(ms < 20, `${k} on "${s.slice(0, 12)}…": ${ms.toFixed(1)} ms`);
    }
  }
});

// A quadratic pattern can still be quick at 4000 chars (a fast inner scan);
// what gives it away is growth. Four times the input may take about four
// times as long, never sixteen.
test('time: no pattern grows faster than linearly (4000 → 16000 chars)', () => {
  const units = ['a', 'ab-', 'a.', 'a b ', 'tokenx', 'TOKENX', '0a:', '/a: ', 'a@', '::', '1.', '"/', 'a:', 'a,', 'a=', 'password: "', 'Bearer ', 'aws ', 'sk-', 'eyJa.', 'a/b#', '-Users-a', 'x://', '//a:'];
  const all = Object.entries(PATTERNS).flatMap(([k, v]) => (Array.isArray(v) ? v.map((r, i) => [`${k}[${i}]`, r]) : v instanceof RegExp ? [[k, v]] : []))
    .concat(Shared.SECRET_PATTERNS.map((p) => [p.kind, p.re]))
    .map(([k, re]) => [k, new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)]);
  for (const [k, re] of all) {
    if (k === 'LONG_LINE') continue;
    for (const u of units) {
      const small = u.repeat(Math.ceil(4000 / u.length));
      const big = u.repeat(Math.ceil(16000 / u.length));
      // An absolute floor, so sub-millisecond noise can't fail it; the small
      // run is only re-timed (best of three) when the big one looks slow.
      let a = timed(() => small.replace(re, 'x'), Infinity);
      const b = timed(() => big.replace(re, 'x'), Math.max(20, a * 8));
      if (b >= Math.max(20, a * 8)) a = Math.max(a, timed(() => small.replace(re, 'x'), 0));
      assert.ok(b < Math.max(20, a * 8), `${k} on "${u}": ${a.toFixed(2)} ms → ${b.toFixed(2)} ms`);
    }
  }
});

// ── Last round (item 12 final verification) ───────────────────────────────
test('final: values after any auth scheme, $ and <> values, long keys, open quotes and backticks', () => {
  const r = redactSecretsPass;
  assert.equal(r('Authorization: Splunk 3fa85f64-5717-4562-b3fc-2c963f66afa6'), 'Authorization: Splunk [redacted]');
  assert.equal(r('password: "$uperS3cretPass"'), 'password: "[redacted]"');
  assert.equal(r('password=$uperS3cret'), 'password=[redacted]');
  assert.equal(r('password: ${DB_PASS}'), 'password: ${DB_PASS}');
  assert.equal(r('password = <Tr0ub4dor&3>'), 'password = [redacted]');
  assert.equal(r('password = <your_password>'), 'password = <your_password>');
  assert.equal(r(`${'X'.repeat(70)}_API_KEY=Zx81nQ4p`), `${'X'.repeat(70)}_API_KEY=[redacted]`);
  assert.equal(r('export DB_PASSWORD="abc def ghi'), 'export DB_PASSWORD="[redacted]');
  assert.equal(r('token: `abc def'), 'token: `[redacted]');
  assert.equal(r('sk-' + 'proj-abcdefghijklmnopqrstuv'), 'sk-' + 'proj-[redacted]');
});

test('final: URL paths run on through spaces to a clear break; bare dotted hosts are hashed', () => {
  const h = (x) => require('../src/scrub.js').hashName(x, 's');
  const o = { home: '/Users/alice', salt: 's' };
  assert.equal(scrub('see https://example.com/My Docs/q3 plan.pdf', o), `see https://${h('example.com')}/${h('My')} ${h('Docs/q3')} ${h('plan.pdf')}`);
  assert.equal(scrub('see https://example.com/ab cd — then more', o), `see https://${h('example.com')}/${h('ab')} ${h('cd')} — then more`);
  assert.equal(scrub('http://localhost:3000 and more', o), 'http://localhost:3000 and more');
  assert.equal(scrub('connecting to corp.globex.internal:5432 failed', o), `connecting to ${h('corp.globex.internal')}:5432 failed`);
  assert.equal(scrub('db.acme.io:5432 and api.github.com and main.js, v1.2.3, e.g.', o), `${h('db.acme.io')}:5432 and api.github.com and main.js, v1.2.3, e.g.`);
});

// The shared module ignores stand-in shapes by default (since 73a548d), so a
// real token wrapped as {{GH:…}} or <redacted:…> is found with no help.
test('secrets: a real token inside a stand-in shape is still redacted', () => {
  const rnd = (n) => require('crypto').randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, n);
  const gh = 'gh' + 'p_' + rnd(36);
  const ant = 'sk-' + 'ant-api03-' + rnd(40);
  for (const [wrapped, secret] of [[`{{GH:${gh}}}`, gh], [`{{SECRET:${ant}}}`, ant], [`<redacted:${gh}>`, gh], [`token {{ ${gh} }} and <REDACTED:${gh}>`, gh]]) {
    const out = scrub(wrapped, MAC);
    assert.ok(!out.includes(secret.slice(4)), `${JSON.stringify(wrapped)} → ${JSON.stringify(out)}`);
    assert.equal(redactSecretsPass(redactSecretsPass(wrapped)), redactSecretsPass(wrapped), 'a second pass changes nothing');
  }
  // A template placeholder is a placeholder, not a value.
  assert.equal(redactSecretsPass('api_key = {{SECRET:api_key}}'), 'api_key = {{SECRET:api_key}}');
  assert.equal(redactSecretsPass('see {{docs}} and <redacted:x>'), 'see {{docs}} and <redacted:x>');
  assert.equal(redactSecretsPass('password: [redacted]'), 'password: [redacted]');
});

test('secrets: documentation examples are redacted too (docExamples off: fail closed)', () => {
  const r = redactSecretsPass;
  assert.equal(r(`token ${'gh' + 'p_'}${'x'.repeat(36)}`), 'token [redacted]');
  assert.equal(r(`key ${'AK' + 'IA'}IOSFODNN7EXAMPLE`), 'key [redacted]');
});
