import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemoteUrl, matchRepo, scopeOf, filterPath, redact, assertNoForeignBytes, serializeOutbound, ForeignBytesError, CREDENTIAL_PATTERNS } from '../scope.js';

const BONDLY = 'github.com/pistorventures/bondly';

test('normalizeRemoteUrl: ssh / https / .git / case / userinfo / port', () => {
  const same = [
    'git@github.com:PistorVentures/bondly.git',
    'git@github.com:PistorVentures/bondly',
    'ssh://git@github.com/PistorVentures/bondly.git',
    'ssh://git@github.com:22/PistorVentures/bondly.git',
    'ssh://git@github.com:PistorVentures/bondly.git',
    'https://github.com/PistorVentures/bondly.git',
    'https://github.com/PistorVentures/Bondly/',
    'https://callum:ghp_secret@GitHub.com/PistorVentures/bondly.git',
    'http://github.com:443/pistorventures/bondly',
    'git://github.com/pistorventures/bondly.git',
    '  git@github.com:PistorVentures/bondly.git\n',
  ];
  for (const u of same) assert.equal(normalizeRemoteUrl(u), BONDLY, u);
});

test('normalizeRemoteUrl: case kept on unknown hosts, subgroups kept', () => {
  assert.equal(normalizeRemoteUrl('git@git.example.com:Team/Repo.git'), 'git.example.com/Team/Repo');
  assert.equal(normalizeRemoteUrl('https://gitlab.com/Group/Sub/Repo.git'), 'gitlab.com/group/sub/repo');
});

test('normalizeRemoteUrl: non-network remotes and junk → null', () => {
  for (const u of ['', null, undefined, '/Users/callum/repo', './repo', 'file:///tmp/repo.git', 'C:\\repos\\x', 'C:/repos/x',
    'https://github.com/onlyowner', 'git@github.com:', 'https://github.com/a/../b', 'ftp://github.com/a/b']) {
    assert.equal(normalizeRemoteUrl(u), null, String(u));
  }
});

const allowlist = [{ repo_id: 'r-bondly', canonical_url: 'https://github.com/PistorVentures/bondly' }, { repo_id: 'r-alias', canonical_url: 'github.com/acme/new', aliases: ['git@github.com:acme/old.git'] }];

test('matchRepo against canonical urls and aliases', () => {
  assert.equal(matchRepo('git@github.com:PistorVentures/bondly.git', allowlist), 'r-bondly');
  assert.equal(matchRepo('https://github.com/acme/old', allowlist), 'r-alias');
  assert.equal(matchRepo('git@github.com:someone/else.git', allowlist), null);
  assert.equal(matchRepo('/local/path', allowlist), null);
});

test('matchRepo: a bare canonical allowlist entry (what the hub stores) matches', () => {
  assert.equal(matchRepo('git@github.com:acme/new.git', allowlist), 'r-alias');
  assert.equal(matchRepo('https://GitHub.com/Acme/New/', [{ repo_id: 'x', canonical_url: 'github.com/acme/new' }]), 'x');
  // leniency is for allowlist names only: a session remote must be a real remote
  assert.equal(matchRepo('github.com/acme/new', allowlist), null);
  assert.equal(matchRepo('git@github.com:acme/new.git', [{ repo_id: 'x', canonical_url: 'acme/new' }]), null);
});

test('scopeOf: default deny — needs allowlist AND local opt-in AND a remote', () => {
  const s = { cwd: '/Users/c/wt/src', toplevel: '/Users/c/wt', remote_url: 'git@github.com:PistorVentures/bondly.git' };
  assert.deepEqual(scopeOf(s, { allowlist, opted_in: ['r-bondly'] }), { repo_id: 'r-bondly', toplevel: '/Users/c/wt' });
  assert.equal(scopeOf(s, { allowlist, opted_in: [] }), null, 'not opted in on this machine');
  assert.equal(scopeOf(s, { allowlist: [], opted_in: ['r-bondly'] }), null, 'not on the board allowlist');
  assert.equal(scopeOf({ ...s, remote_url: null }, { allowlist, opted_in: ['r-bondly'] }), null, 'no origin');
  assert.equal(scopeOf({ ...s, toplevel: null }, { allowlist, opted_in: ['r-bondly'] }), null, 'not a git repo');
  assert.equal(scopeOf({ ...s, cwd: '/Users/c/elsewhere' }, { allowlist, opted_in: new Set(['r-bondly']) }), null, 'cwd outside the repo');
  assert.equal(scopeOf(null, { allowlist, opted_in: ['r-bondly'] }), null);
});

test('filterPath: repo-relative or null', () => {
  const top = '/Users/c/wt';
  assert.equal(filterPath('/Users/c/wt/src/a.ts', top), 'src/a.ts');
  assert.equal(filterPath('src/a.ts', top), 'src/a.ts');
  assert.equal(filterPath('./src/../lib/b.ts', top), 'lib/b.ts');
  assert.equal(filterPath('/Users/c/wt', top), '.');
  assert.equal(filterPath('/Users/c/wt/', top), '.');
  assert.equal(filterPath('/Users/c/wt2/x', top), null, 'sibling with a shared prefix');
  assert.equal(filterPath('../secrets.env', top), null);
  assert.equal(filterPath('/Users/c/wt/../other/x', top), null);
  assert.equal(filterPath('/etc/passwd', top), null);
  assert.equal(filterPath('~/.ssh/id_rsa', top), null);
  assert.equal(filterPath('a\0b', top), null);
  assert.equal(filterPath('C:\\Users\\c\\wt\\src\\a.ts', 'C:\\Users\\c\\wt'), 'src/a.ts');
  assert.equal(filterPath('c:\\users\\c\\wt\\x', 'C:\\Users\\c\\wt'), 'x', 'Windows paths compare case-insensitively');
  assert.equal(filterPath('C:\\Users\\c\\wt2\\x', 'C:\\Users\\c\\wt'), null);
});

test('redact: toplevel → relative, other local paths → <path>, credentials → <redacted>', () => {
  const top = '/Users/c/wt';
  const out = redact('at /Users/c/wt/src/a.js:3\nread /Users/c/.aws/credentials\nkey sk-ant-api03-abcdefghijklmnop and AKIAABCDEFGHIJKLMNOP\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123', top);
  assert.match(out, /at src\/a\.js:3/);
  assert.match(out, /read <path>/);
  assert.doesNotMatch(out, /sk-ant-|AKIA|ghp_/);
  assert.match(out, /<redacted:anthropic_key>/);
  assert.doesNotThrow(() => assertNoForeignBytes({ repo_id: 'r', tail: out }, { repo_id: 'r' }));
});

test('redact + guard: a local path after any non-path character is caught (file://, <, |, {)', () => {
  for (const s of ['file:///Users/callum/secret.txt', 'cat</Users/callum/.aws/credentials', 'x|/home/bob/x', '{/Users/callum/a}', 'open file:///C:/Users/bob/x', 'x>/tmp/y', 'a;~/.ssh/id_rsa']) {
    assert.throws(() => assertNoForeignBytes({ repo_id: 'r', t: s }, { repo_id: 'r' }), /local absolute path/, s);
    const out = redact(s, '/Users/callum/repo');
    assert.doesNotMatch(out, /callum|bob|\.aws|\.ssh|\/tmp\//, s);
    assert.match(out, /<path>/, s);
    assert.doesNotThrow(() => assertNoForeignBytes({ repo_id: 'r', t: out }, { repo_id: 'r' }), s);
  }
  // A repo-relative path whose segment happens to be tmp/private/home is not local.
  for (const s of ['lib/tmp/x.js', 'src/private/a.ts', 'docs/home/index.md', 'https://example.com/tmp/x']) {
    assert.doesNotThrow(() => assertNoForeignBytes({ repo_id: 'r', t: s }, { repo_id: 'r' }), s);
    assert.equal(redact(s, '/Users/c/wt'), s);
  }
});

test('assertNoForeignBytes: exit (f) — non-repo session and out-of-repo paths produce zero bytes', () => {
  const scope = { repo_id: 'r-bondly', toplevel: '/Users/c/wt' };
  assert.throws(() => serializeOutbound({ kind: 'facts', repo_id: 'r-bondly' }, null), ForeignBytesError);
  assert.throws(() => serializeOutbound({ kind: 'facts', repo_id: 'r-other' }, scope), /does not match/);
  assert.throws(() => serializeOutbound({ kind: 'facts' }, scope, { requireRepoId: true }), /does not match/);
  assert.throws(() => serializeOutbound({ repo_id: 'r-bondly', items: [{ path: '/Users/c/personal/notes.md' }] }, scope), /local absolute path/);
  assert.throws(() => serializeOutbound({ repo_id: 'r-bondly', items: [{ path: '/Users/c/wt/src/a.ts' }] }, scope), /local absolute path/, 'even the worktree path is local-only');
  assert.throws(() => serializeOutbound({ repo_id: 'r-bondly', x: { '/home/c/y': 1 } }, scope), /local absolute path/, 'keys are checked too');
  assert.throws(() => serializeOutbound({ repo_id: 'r-bondly', t: 'cd ~/.ssh' }, scope), /local absolute path/);
  const ok = serializeOutbound({ repo_id: 'r-bondly', items: [{ path: 'src/a.ts' }], url: 'https://github.com/x/y/pull/1' }, scope);
  assert.equal(typeof ok, 'string');
});

test('assertNoForeignBytes: exit (j) — no credential pattern in any hub-bound byte', () => {
  const scope = { repo_id: 'r' };
  const samples = {
    message_receipt: `bmr1.00000000-0000-4000-8000-000000000001.${'A'.repeat(42)}-`,
    anthropic_key: 'sk-ant-oat01-AbCdEfGhIjKlMnOp',
    openai_key: 'sk-proj-abcdefghijklmnopqrstuvwx',
    aws_access_key: 'AKIAIOSFODNN7EXAMPLE',
    github_token: 'ghp_abcdefghijklmnopqrstuvwxyz012345',
    github_pat: 'github_pat_11ABCDEFG0123456789_abcdefghij',
    slack_token: 'xoxb-1234567890-abcdefghij',
    google_api_key: 'AIzaSyA-abcdefghijklmnopqrstuvwxyz01234',
    private_key: '-----BEGIN OPENSSH PRIVATE KEY-----',
    cf_access_secret: 'CF-Access-Client-Secret: abcdef123456',
    bearer: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    env_secret: 'DATABASE_PASSWORD=hunter22222',
  };
  for (const [kind] of CREDENTIAL_PATTERNS) assert.ok(kind in samples, `sample for ${kind}`);
  for (const [kind, s] of Object.entries(samples)) {
    assert.throws(() => serializeOutbound({ repo_id: 'r', deep: [{ text: `x ${s} y` }] }, scope), new RegExp(kind), kind);
  }
  assert.doesNotThrow(() => serializeOutbound({ repo_id: 'r', text: 'sk-ant is a prefix; skills; task-antique; PASSWORD_MIN_LEN = 8' }, scope));
});

test('message receipt credentials redact in ordinary free text and fail outbound serialization without redaction', () => {
  const capability = `bmr1.00000000-0000-4000-8000-000000000002.${'_'.repeat(43)}`;
  const text = `copied(${capability}); another=${capability}`;
  assert.equal(redact(text), 'copied(<redacted:message_receipt>); another=<redacted:message_receipt>');
  assert.throws(() => serializeOutbound({ repo_id: 'r', items: [{ cmd: text, tail: text }] }, { repo_id: 'r' }), /message_receipt/);
  assert.doesNotThrow(() => serializeOutbound({ repo_id: 'r', items: [{ cmd: redact(text), tail: redact(text) }] }, { repo_id: 'r' }));
  assert.equal(redact('bmr1 receipt stage and 00000000-0000-4000-8000-000000000002'), 'bmr1 receipt stage and 00000000-0000-4000-8000-000000000002');
});

test('receipt serialization permits only exact private acknowledgement and host receipt fields', () => {
  const receipt_id = '00000000-0000-4000-8000-000000000002';
  const receipt_token = `bmr1.${receipt_id}.${'_'.repeat(43)}`;
  const receipt = { receipt_id, receipt_token };
  const rpc = { type: 'rpc', repo_id: 'r', method: 'board_ack_message', params: receipt };
  const scope = { repo_id: 'r' };
  assert.deepEqual(JSON.parse(serializeOutbound(rpc, scope)).params, receipt);
  const host = { ...rpc, method: 'runner_messages_received', params: { receipts: [receipt] } };
  assert.deepEqual(JSON.parse(serializeOutbound(host, scope)).params.receipts, [receipt]);
  for (const bad of [
    { ...rpc, type: 'out' },
    { ...rpc, method: 'board_comment' },
    { ...rpc, params: { ...receipt, receipt_id: 'other-id' } },
    { ...rpc, params: { ...receipt, receipt_token: `${receipt_token}suffix` } },
    { ...rpc, params: { ...receipt, body: 'extra' } },
    { ...rpc, params: { nested: receipt } },
    { ...rpc, narrative: receipt_token },
    { ...host, params: { receipts: [{ ...receipt, body: receipt_token }] } },
    { ...host, params: { receipts: [receipt], extra: true } },
    { ...host, params: { receipts: Array(21).fill(receipt) } },
  ]) assert.throws(() => serializeOutbound(bad, scope), /message_receipt/);
  assert.throws(() => serializeOutbound(rpc, { repo_id: 'foreign' }), /does not match/);
});
