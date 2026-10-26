// What a Plexiform-started Claude run (or no-tool child) takes from the user's own provider and auth.
// All I/O is injected: no real HOME, helper, CLI or network (a loopback socket stands in for a gateway).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createClaudeCarry, denyRules, oneShotModel, tcpProbe } from '../claude-carry.cjs';
import { fixtureCarry, HOME, CFG, MANAGED, KEY, settingsFile } from '../test-support/claude-carry-fixture.js';
import { testTempDir } from '../test-support/tmp.js';
import { findSecrets } from '../secret-patterns.mjs';

const SIGN_IN = 'your key helper needs you to sign in; run it once in a terminal';
const user = (o) => ({ [`${CFG}/settings.json`]: settingsFile(o) });
const gateway = { ANTHROPIC_BASE_URL: 'https://gw.example/v1', ANTHROPIC_MODEL: 'glm-5.3-flash' };

test('a gateway user: routing in the run settings env, the key only in a 0600 api.key behind /bin/cat', async (t) => {
  const dir = testTempDir('carry-', t);
  const keyFile = path.join(dir, 'api.key');
  const { carry } = fixtureCarry({ files: user({ env: { ...gateway, ANTHROPIC_AUTH_TOKEN: KEY }, model: 'glm-5.3-flash' }) });
  const c = await carry.prepare({ mode: 'bash', keyFile });
  assert.equal(c.failure, null);
  assert.deepEqual(c.settingsEnv, gateway);
  assert.equal(c.apiKeyFile, keyFile);
  assert.equal(fs.readFileSync(keyFile, 'utf8'), KEY);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(c.model, 'glm-5.3-flash');
  const everything = JSON.stringify({ s: c.settingsEnv, e: c.cliEnv, d: c.disallowed, r: c.denyRead, m: c.model });
  assert.ok(!everything.includes(KEY), 'no key in settings env, the CLI env, deny rules or the model');
  c.release();
  assert.equal(fs.existsSync(keyFile), false, 'deleted at run end');
});

test('an ANTHROPIC_API_KEY the person declined interactively (customApiKeyResponses.rejected) is not carried', async (t) => {
  const dir = testTempDir('carry-', t);
  const keyFile = path.join(dir, 'api.key');
  const files = { ...user({ env: { ANTHROPIC_API_KEY: KEY } }), [`${HOME}/.claude.json`]: JSON.stringify({ customApiKeyResponses: { approved: [], rejected: [KEY.slice(-20)] } }) };
  const c = await fixtureCarry({ files }).carry.prepare({ mode: 'bash', keyFile });
  assert.equal(c.failure, null);
  assert.equal(c.apiKeyFile, null);
  assert.equal(fs.existsSync(keyFile), false);
  const n = await fixtureCarry({ files }).carry.prepare({ mode: 'notool' });
  assert.ok(!JSON.stringify(n.childEnv).includes(KEY), 'a no-tool child does not get it either');
});

test('a MANAGED apiKeyHelper is authoritative: nothing runs and no api.key is written', async (t) => {
  const dir = testTempDir('carry-', t);
  const keyFile = path.join(dir, 'api.key');
  const files = { [MANAGED]: settingsFile({ apiKeyHelper: '/opt/corp/get-key' }), ...user({ apiKeyHelper: '/home/mine/get-key', env: gateway }) };
  const { carry, calls } = fixtureCarry({ files, commands: { '/opt/corp/get-key': { ok: true, output: KEY }, '/home/mine/get-key': { ok: true, output: KEY } } });
  const c = await carry.prepare({ mode: 'bash', keyFile });
  assert.equal(c.failure, null);
  assert.equal(calls.length, 0, 'neither helper ran');
  assert.equal(c.apiKeyFile, null);
  assert.equal(fs.existsSync(keyFile), false);
  assert.deepEqual(c.settingsEnv, gateway, 'routing still carries');
});

test("the user's helper runs in Plexiform from $HOME and is refreshed on the TTL; release stops the timer and deletes the key", async (t) => {
  const dir = testTempDir('carry-', t);
  const keyFile = path.join(dir, 'api.key');
  let n = 0;
  const { carry, calls, intervals } = fixtureCarry({
    files: user({ apiKeyHelper: './key.sh', env: { ...gateway, CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '60000' } }),
    commands: { './key.sh': () => ({ ok: true, output: `token-${++n}` }) },
  });
  const c = await carry.prepare({ mode: 'bash', keyFile });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].home, HOME);
  assert.equal(calls[0].command, './key.sh');
  assert.equal(fs.readFileSync(keyFile, 'utf8'), 'token-1');
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 60000);
  assert.ok(!('CLAUDE_CODE_API_KEY_HELPER_TTL_MS' in c.settingsEnv), 'the TTL is Plexiform\'s, not the CLI\'s');
  await intervals[0].fn();
  assert.equal(fs.readFileSync(keyFile, 'utf8'), 'token-2');
  assert.ok(!JSON.stringify(c).includes('token-1'));
  c.release();
  assert.equal(intervals[0].cleared, true);
  assert.equal(fs.existsSync(keyFile), false);
});

test('a helper that times out parks the run as auth with the sign-in reason; one that fails says only its exit code', async () => {
  const slow = fixtureCarry({ files: user({ apiKeyHelper: 'sso-login' }), commands: { 'sso-login': { ok: false, timedOut: true, code: null, reason: SIGN_IN } } });
  const c = await slow.carry.prepare({ mode: 'bash', keyFile: '/nope/api.key' });
  assert.deepEqual(c.failure, { kind: 'auth', reason: SIGN_IN });
  const bad = fixtureCarry({ files: user({ apiKeyHelper: 'oops' }), commands: { oops: { ok: false, timedOut: false, code: 3, reason: 'key helper failed (exit 3)' } } });
  assert.deepEqual((await bad.carry.prepare({ mode: 'bash', keyFile: '/nope/api.key' })).failure, { kind: 'auth', reason: 'key helper failed (exit 3)' });
  const empty = fixtureCarry({ files: user({ apiKeyHelper: 'nothing' }), commands: { nothing: { ok: true, output: '' } } });
  assert.equal((await empty.carry.prepare({ mode: 'bash', keyFile: '/nope/api.key' })).failure.kind, 'auth');
});

test('secrets that cannot go through api.key are refused for a run with a shell, with a "move it to" reason', async () => {
  for (const [env, extra, want] of [
    [{ AWS_BEARER_TOKEN_BEDROCK: 'ABSK-fixture-bedrock-token-00000000000000000000', CLAUDE_CODE_USE_BEDROCK: '1' }, {}, /AWS profile/],
    [{ ANTHROPIC_CUSTOM_HEADERS: `Authorization: Bearer ${KEY}` }, {}, /ANTHROPIC_AUTH_TOKEN or apiKeyHelper/],
    [{ ANTHROPIC_BASE_URL: `https://user:${KEY}@gw.example/v1` }, {}, /apiKeyHelper/],
    [{ CLAUDE_CODE_USE_BEDROCK: '1' }, { awsCredentialExport: 'aws-export' }, /awsCredentialExport.*AWS profile/s],
  ]) {
    const c = await fixtureCarry({ files: user({ env, ...extra }) }).carry.prepare({ mode: 'bash', keyFile: '/nope/api.key' });
    assert.equal(c.failure?.kind, 'provider', JSON.stringify(Object.keys(env)));
    assert.match(c.failure.reason, want);
    assert.ok(!c.failure.reason.includes(KEY) && !c.failure.reason.includes('ABSK'), 'a reason never holds a value');
  }
});

test('a no-tool child takes keys in its env (plan C14): API key, bedrock token, custom headers, helper output, exported AWS credentials', async () => {
  const k = fixtureCarry({ files: user({ env: { ...gateway, ANTHROPIC_API_KEY: KEY } }) });
  const a = await k.carry.prepare({ mode: 'notool' });
  assert.equal(a.childEnv.ANTHROPIC_API_KEY, KEY);
  assert.equal(a.childEnv.ANTHROPIC_BASE_URL, gateway.ANTHROPIC_BASE_URL);
  assert.equal(a.apiKeyFile, null);
  assert.deepEqual(a.settingsEnv, {});

  const b = await fixtureCarry({ files: user({ env: { AWS_BEARER_TOKEN_BEDROCK: 'ABSK-fixture', CLAUDE_CODE_USE_BEDROCK: '1' } }) }).carry.prepare({ mode: 'notool' });
  assert.equal(b.failure, null);
  assert.equal(b.childEnv.AWS_BEARER_TOKEN_BEDROCK, 'ABSK-fixture');

  const h = await fixtureCarry({ files: user({ apiKeyHelper: 'get', env: gateway }), commands: { get: { ok: true, output: 'helper-key' } } }).carry.prepare({ mode: 'notool' });
  assert.equal(h.childEnv.ANTHROPIC_API_KEY, 'helper-key');
  assert.equal(h.childEnv.ANTHROPIC_AUTH_TOKEN, 'helper-key');

  const x = await fixtureCarry({
    files: user({ awsCredentialExport: 'aws-export', env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1' } }),
    commands: { 'aws-export': { ok: true, output: JSON.stringify({ Credentials: { AccessKeyId: 'AKIAFIXTURE', SecretAccessKey: 'fixture-secret', SessionToken: 'fixture-session' } }) } },
  }).carry.prepare({ mode: 'notool' });
  assert.equal(x.childEnv.AWS_ACCESS_KEY_ID, 'AKIAFIXTURE');
  assert.equal(x.childEnv.AWS_SESSION_TOKEN, 'fixture-session');
  const bad = await fixtureCarry({ files: user({ awsCredentialExport: 'aws-export', env: { CLAUDE_CODE_USE_BEDROCK: '1' } }), commands: { 'aws-export': { ok: true, output: 'not json' } } }).carry.prepare({ mode: 'notool' });
  assert.equal(bad.failure.kind, 'auth');
});

test('awsAuthRefresh runs once at preflight for a cloud provider; its failure parks auth', async () => {
  const ok = fixtureCarry({ files: user({ awsAuthRefresh: 'aws sso login', env: { CLAUDE_CODE_USE_BEDROCK: '1' } }), commands: { 'aws sso login': { ok: true, output: '' } } });
  assert.equal((await ok.carry.prepare({ mode: 'bash', keyFile: '/x' })).failure, null);
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].home, HOME);
  const bad = fixtureCarry({ files: user({ awsAuthRefresh: 'aws sso login', env: { CLAUDE_CODE_USE_BEDROCK: '1' } }), commands: { 'aws sso login': { ok: false, timedOut: true, reason: 'your aws auth refresh needs you to sign in; run it once in a terminal' } } });
  assert.equal((await bad.carry.prepare({ mode: 'bash', keyFile: '/x' })).failure.kind, 'auth');
});

test('path vars and a custom config dir are denied to file tools and the sandbox (S2/S3)', async () => {
  const files = user({ env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_SHARED_CREDENTIALS_FILE: '/srv/aws/creds', GOOGLE_APPLICATION_CREDENTIALS: '~/adc.json' } });
  const c = await fixtureCarry({ files }).carry.prepare({ mode: 'bash', keyFile: '/x' });
  for (const p of [`${HOME}/.config/gcloud`, `${HOME}/.azure`, '/srv/aws/creds', `${HOME}/adc.json`]) {
    assert.ok(c.denyRead.includes(p), p);
    for (const tool of ['Read', 'Edit', 'Write']) assert.ok(c.disallowed.includes(`${tool}(/${p})`), `${tool} ${p}`);
  }
  assert.equal(c.settingsEnv.AWS_SHARED_CREDENTIALS_FILE, '/srv/aws/creds', 'the variable is routing; the file is what is denied');
  const custom = await fixtureCarry({ env: { CLAUDE_CONFIG_DIR: '/work/claude-cfg' }, files: { '/work/claude-cfg/settings.json': settingsFile({ env: gateway }) } }).carry.prepare({ mode: 'bash', keyFile: '/x' });
  assert.ok(custom.denyRead.includes('/work/claude-cfg'));
  assert.equal(custom.cliEnv.CLAUDE_CONFIG_DIR, '/work/claude-cfg');
  assert.equal(custom.settingsEnv.ANTHROPIC_BASE_URL, gateway.ANTHROPIC_BASE_URL);
  assert.deepEqual(denyRules(['/a']), ['Read(//a)', 'Read(//a/**)', 'Edit(//a)', 'Edit(//a/**)', 'Write(//a)', 'Write(//a/**)']);
});

test('a login-shell value fills what the settings lack, through the injected seam', async () => {
  const seen = [];
  const { carry } = fixtureCarry({ loginShellEnv: async ({ names }) => { seen.push(names); return { ANTHROPIC_BASE_URL: 'https://shell.example/v1', ANTHROPIC_API_KEY: KEY }; } });
  const c = await carry.prepare({ mode: 'notool' });
  assert.equal(c.childEnv.ANTHROPIC_BASE_URL, 'https://shell.example/v1');
  assert.equal(c.childEnv.ANTHROPIC_API_KEY, KEY);
  assert.ok(seen[0].includes('ANTHROPIC_BASE_URL'));
  const broken = fixtureCarry({ loginShellEnv: async () => { throw new Error('boom'); }, files: user({ env: gateway }) });
  assert.equal((await broken.carry.prepare({ mode: 'notool' })).childEnv.ANTHROPIC_BASE_URL, gateway.ANTHROPIC_BASE_URL);
});

test('no config at all, or config the carry cannot use: carry:false and nothing changes', async () => {
  const none = await fixtureCarry({ platform: 'freebsd' }).carry.prepare({ mode: 'bash', keyFile: '/x' });
  assert.equal(none.carry, false);
  assert.equal(none.failure, null);
  assert.equal(none.apiKeyFile, null);
  const rel = await fixtureCarry({ env: { CLAUDE_CONFIG_DIR: 'relative' } }).carry.prepare({ mode: 'bash', keyFile: '/x' });
  assert.equal(rel.carry, false);
});

test('unreadable settings fail loud; an unreadable .claude.json blocks only when an API key needs its rejection list', async () => {
  const bad = await fixtureCarry({ files: { [`${CFG}/settings.json`]: '{not json' } }).carry.prepare({ mode: 'bash', keyFile: '/x' });
  assert.equal(bad.failure.kind, 'provider');
  const withKey = await fixtureCarry({ files: { ...user({ env: { ANTHROPIC_API_KEY: KEY } }), [`${HOME}/.claude.json`]: '{truncated' } }).carry.prepare({ mode: 'bash', keyFile: '/x' });
  assert.equal(withKey.failure.kind, 'provider');
  const noKey = await fixtureCarry({ files: { ...user({ env: gateway }), [`${HOME}/.claude.json`]: '{truncated' } }).carry.prepare({ mode: 'bash', keyFile: '/x' });
  assert.equal(noKey.failure, null);
});

test('a missing login is a loud auth failure for a run, never for a one-shot', async () => {
  const run = await fixtureCarry({ loggedIn: false, files: user({ env: { AWS_REGION: 'x' } }) }).carry.prepare({ mode: 'bash', keyFile: '/x' });
  assert.equal(run.failure.kind, 'auth');
  assert.match(run.failure.reason, /not logged in/);
  const oneShot = await fixtureCarry({ loggedIn: false, files: user({ env: { AWS_REGION: 'x' } }) }).carry.prepare({ mode: 'notool' });
  assert.equal(oneShot.failure, null);
  const gw = await fixtureCarry({ loggedIn: false, files: user({ env: gateway }) }).carry.prepare({ mode: 'bash', keyFile: '/x' });
  assert.equal(gw.failure, null, 'a gateway user needs no Anthropic login');
});

test('a loopback gateway that does not answer fails as a provider error naming the address; Burst is named only when Burst owns the port', async () => {
  const files = user({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:7777' } });
  const plain = await fixtureCarry({ files, probeUp: false }).carry.prepare({ mode: 'bash', keyFile: '/x' });
  assert.deepEqual(plain.failure, { kind: 'provider', reason: "the gateway at 127.0.0.1:7777 isn't answering" });
  const burst = await fixtureCarry({ files, probeUp: false, burst: true }).carry.prepare({ mode: 'bash', keyFile: '/x' });
  assert.deepEqual(burst.failure, { kind: 'provider', reason: "Burst gateway isn't running" });
  const up = fixtureCarry({ files, probeUp: true });
  assert.equal((await up.carry.prepare({ mode: 'bash', keyFile: '/x' })).failure, null);
  assert.deepEqual(up.probes.map((p) => [p.host, p.port]), [['127.0.0.1', 7777]]);
  const remote = fixtureCarry({ files: user({ env: gateway }), probeUp: false });
  assert.equal((await remote.carry.prepare({ mode: 'bash', keyFile: '/x' })).failure, null);
  assert.equal(remote.probes.length, 0, 'only loopback gateways are probed');
});

test('the real probe is a bare TCP connect: a key-bearing config sends the gateway zero bytes', async () => {
  let bytes = 0;
  let connections = 0;
  const server = net.createServer((s) => { connections++; s.on('data', (d) => { bytes += d.length; }); s.on('error', () => {}); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const files = user({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: KEY } });
    const carry = createClaudeCarry({ env: {}, home: HOME, platform: 'linux', readFile: (f) => files[f] ?? null, credentialsExist: () => true });
    const c = await carry.prepare({ mode: 'notool' });
    assert.equal(c.failure, null);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(connections, 1);
    assert.equal(bytes, 0, 'no request line, no header, no key');
  } finally { await new Promise((r) => server.close(r)); }
  assert.equal(await tcpProbe({ host: '127.0.0.1', port }), false, 'a closed port answers false');
});

test('a one-shot asks for the provider\'s small model on a gateway and stays haiku elsewhere (C8)', async () => {
  const gw = await fixtureCarry({ files: user({ model: 'glm-5.3-flash', env: gateway }) }).carry.prepare({ mode: 'notool' });
  assert.equal(gw.oneShotModel, 'glm-5.3-flash');
  const small = await fixtureCarry({ files: user({ model: 'glm-5.3-flash', env: { ...gateway, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-air' } }) }).carry.prepare({ mode: 'notool' });
  assert.equal(small.oneShotModel, 'glm-5.3-air');
  const plain = await fixtureCarry({ files: user({ model: 'opus' }) }).carry.prepare({ mode: 'notool' });
  assert.equal(plain.oneShotModel, 'haiku', 'a subscription user\'s opus must not make a one-shot expensive');
  assert.equal(plain.model, 'opus', 'but a run follows the person\'s model');
  assert.equal(oneShotModel({ routing: {}, auth: { kind: 'bedrock' }, smallModel: null }), 'haiku');
});

// ── The recorded CLI shapes this PR answers (fixtures/claude-cli/README.md) ──────────────────────────────
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/claude-cli/${name}`, import.meta.url), 'utf8'));
const resultOf = (f) => f.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.type === 'result');

test('T3 as recorded: a gateway only in settings.json env gave "Not logged in" as subtype:success + is_error:true; with the carry the run is given that gateway', async (t) => {
  const lab = fixture('2.1.310-no-auth-stream-json.json');
  const r = resultOf(lab);
  assert.equal(lab.exit_code, 1);
  assert.deepEqual([r.subtype, r.is_error, r.result], ['success', true, 'Not logged in · Please run /login']);
  const files = user({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4001', ANTHROPIC_AUTH_TOKEN: KEY }, model: 'glm-5.3-flash' });
  const c = await fixtureCarry({ files }).carry.prepare({ mode: 'bash', keyFile: path.join(testTempDir('carry-', t), 'api.key') });
  assert.equal(c.failure, null);
  assert.equal(c.settingsEnv.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4001', 'the run now has the gateway the lab run was missing');
});

test('an unreachable gateway as recorded (172 s of retries to ECONNREFUSED) now fails in the preflight, fast, naming the address', async () => {
  const lab = fixture('2.1.310-unreachable-stream-json.json');
  assert.ok(lab.duration_ms > 100_000);
  assert.match(resultOf(lab).result, /ECONNREFUSED/);
  const files = user({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: 'glm-5.3-flash' } });
  const carry = createClaudeCarry({ env: {}, home: HOME, platform: 'linux', readFile: (f) => files[f] ?? null, credentialsExist: () => true });
  const t0 = Date.now();
  const c = await carry.prepare({ mode: 'bash', keyFile: '/x/api.key' });
  assert.deepEqual(c.failure, { kind: 'provider', reason: "the gateway at 127.0.0.1:1 isn't answering" });
  assert.ok(Date.now() - t0 < 3000, 'bounded by the probe\'s own short timeout, not the CLI\'s retries');
});

test('a key file that cannot be written fails the preflight instead of starting a run without its key', async () => {
  const c = await fixtureCarry({ files: user({ env: { ...gateway, ANTHROPIC_AUTH_TOKEN: KEY } }) }).carry.prepare({ mode: 'bash', keyFile: '/nonexistent-dir/api.key' });
  assert.deepEqual(c.failure, { kind: 'provider', reason: "the run's key file could not be written" });
});

test('the recorded CLI fixtures hold no secret', () => {
  const dir = new URL('./fixtures/claude-cli/', import.meta.url);
  for (const f of fs.readdirSync(dir)) assert.deepEqual(findSecrets(fs.readFileSync(new URL(f, dir), 'utf8'), { classes: ['credential'] }), [], `${f}: no credential (the only keyed hit is the literal KEY=REDACTED in the recorded command)`);
});

test('the default readers: a 1 MB .claude.json is read whole (CLAUDE_JSON_MAX_BYTES), a missing managed-settings.d is not an error', (t) => {
  const home = testTempDir('carry-home-', t);
  const filler = Object.fromEntries(Array.from({ length: 12000 }, (_, i) => [`/work/project-${i}`, { allowedTools: [], history: ['x'.repeat(60)] }]));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: filler, customApiKeyResponses: { approved: [], rejected: [KEY.slice(-20)] } }));
  assert.ok(fs.statSync(path.join(home, '.claude.json')).size > 1024 * 1024);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ...gateway, ANTHROPIC_API_KEY: KEY } }));
  const carry = createClaudeCarry({ env: {}, home, platform: 'linux', credentialsExist: () => true });
  return carry.prepare({ mode: 'notool' }).then((c) => {
    assert.equal(c.failure, null, 'the big file was not reported unreadable');
    assert.ok(!JSON.stringify(c.childEnv).includes(KEY), 'its rejection list was read and honoured');
    assert.equal(c.childEnv.ANTHROPIC_BASE_URL, gateway.ANTHROPIC_BASE_URL);
  });
});
