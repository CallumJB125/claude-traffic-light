import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProvider, CLAUDE_SECRET_KEYS } from '../user-provider.cjs';

const HOME = '/home/u';
const CFG = `${HOME}/.claude`;
const MANAGED = '/etc/claude-code/managed-settings.json';
const MANAGED_D = '/etc/claude-code/managed-settings.d';
const json = (o) => JSON.stringify(o);

// Recording in-memory file system: the module's only I/O.
function run(files = {}, { env = {}, loginEnv = {}, platform = 'linux', dirs = {} } = {}) {
  const read = [];
  const readFile = (p) => { read.push(p); return Object.hasOwn(files, p) ? files[p] : null; };
  const readDir = (p) => dirs[p] ?? null;
  const r = claudeProvider({ env, loginEnv, home: HOME, platform, readFile, readDir });
  return { r, read };
}
const settings = (env, extra = {}) => json({ env, ...extra });

test('1 no files: carry, oauth-or-none, nothing else', () => {
  const { r } = run();
  assert.equal(r.carry, true);
  assert.equal(r.auth.kind, 'oauth-or-none');
  assert.deepEqual(r.routing, {});
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(r.notes, []);
});

test('2 gateway in settings.json: URL in routing, token only in auth.secret', () => {
  const { r } = run({ [`${CFG}/settings.json`]: settings({ ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: 'tok-abc' }) });
  assert.equal(r.routing.ANTHROPIC_BASE_URL, 'https://gw.example.com');
  assert.equal(r.auth.kind, 'auth-token');
  assert.equal(r.auth.secret, 'tok-abc');
  assert.equal(r.auth.secretName, 'ANTHROPIC_AUTH_TOKEN');
  assert.equal(r.auth.origin, 'user');
  assert.ok(!JSON.stringify(r.routing).includes('tok-abc'));
});

test('3 CLAUDE_CONFIG_DIR in app env: that dir is read; ~ expands; relative turns carry off', () => {
  const { r, read } = run({ '/cfg/settings.json': settings({ AWS_PROFILE: 'p' }) }, { env: { CLAUDE_CONFIG_DIR: '/cfg' } });
  assert.equal(r.configDir, '/cfg');
  assert.equal(r.routing.AWS_PROFILE, 'p');
  assert.ok(!read.some((p) => p.startsWith(CFG)));
  assert.equal(run({}, { env: { CLAUDE_CONFIG_DIR: '~/x' } }).r.configDir, `${HOME}/x`);
  const rel = run({ [`${CFG}/settings.json`]: settings({ AWS_PROFILE: 'p' }) }, { env: { CLAUDE_CONFIG_DIR: 'rel/dir' } });
  assert.equal(rel.r.carry, false);
  assert.equal(rel.r.carryOffReason, 'claude_config_dir_relative');
  assert.ok(rel.r.unsupported.some((u) => u.code === 'claude_config_dir_relative'));
  assert.deepEqual(rel.read, []);
});

test('4 CLAUDE_CONFIG_DIR only in loginEnv is used', () => {
  assert.equal(run({}, { loginEnv: { CLAUDE_CONFIG_DIR: '/from/login' } }).r.configDir, '/from/login');
});

test('5 precedence: managed > user > .claude.json env > app env > login shell', () => {
  const key = 'ANTHROPIC_BASE_URL';
  const layers = [
    [MANAGED, settings({ [key]: 'https://managed' }), null],
    [`${CFG}/settings.json`, settings({ [key]: 'https://user' }), null],
    [`${HOME}/.claude.json`, settings({ [key]: 'https://claude-json' }), null],
  ];
  const files = Object.fromEntries(layers.map(([p, c]) => [p, c]));
  const expectations = ['https://managed', 'https://user', 'https://claude-json', 'https://app', 'https://login'];
  const drop = [MANAGED, `${CFG}/settings.json`, `${HOME}/.claude.json`];
  for (let i = 0; i < 5; i++) {
    const f = { ...files };
    for (const p of drop.slice(0, i)) delete f[p];
    const { r } = run(f, { env: { [key]: 'https://app' }, loginEnv: { [key]: 'https://login' } });
    if (i < 3) assert.equal(r.routing[key], expectations[i]);
    else if (i === 3) assert.equal(r.routing[key], 'https://app');
  }
  assert.equal(run({}, { loginEnv: { [key]: 'https://login' } }).r.routing[key], 'https://login');
});

test('5b managed drop-ins merge after the base file, in name order', () => {
  const d = '/etc/claude-code/managed-settings.d';
  const { r, read } = run({
    [MANAGED]: settings({ AWS_PROFILE: 'base', AWS_REGION: 'r1' }, { model: 'm-base' }),
    [`${d}/20-b.json`]: settings({ AWS_PROFILE: 'b' }),
    [`${d}/10-a.json`]: settings({ AWS_PROFILE: 'a' }, { model: 'm-a' }),
    [`${CFG}/settings.json`]: settings({ AWS_PROFILE: 'user' }, { model: 'user-model' }),
  }, { dirs: { [d]: ['20-b.json', '10-a.json', 'notes.txt'] } });
  assert.equal(r.routing.AWS_PROFILE, 'b');
  assert.equal(r.routing.AWS_REGION, 'r1');
  assert.equal(r.model, 'm-a');
  assert.ok(!read.includes(`${d}/notes.txt`));
  assert.equal(r.sources[0].kind, 'managed');
});

test('6 model and smallModel chain', () => {
  const s = (env, model) => run({ [`${CFG}/settings.json`]: settings(env, model ? { model } : {}) }).r;
  assert.equal(s({}, 'opus').model, 'opus');
  assert.equal(s({}, 'opus').smallModel, 'opus');
  assert.equal(s({ ANTHROPIC_SMALL_FAST_MODEL: 'fast' }, 'opus').smallModel, 'fast');
  assert.equal(s({ ANTHROPIC_SMALL_FAST_MODEL: 'fast', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku' }, 'opus').smallModel, 'haiku');
  assert.equal(s({}).smallModel, null);
});

test('7 user apiKeyHelper: kind helper, string unchanged', () => {
  const { r } = run({ [`${CFG}/settings.json`]: json({ apiKeyHelper: '/bin/cat "/x y/key"' }) });
  assert.equal(r.auth.kind, 'helper');
  assert.equal(r.auth.helper, '/bin/cat "/x y/key"');
  assert.equal(r.auth.origin, 'user');
  assert.equal(r.auth.secret, null);
});

test('8 bedrock: profile + credentials file in routing/pathVars; deny list', () => {
  const { r } = run({ [`${CFG}/settings.json`]: settings({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'prod', AWS_SHARED_CREDENTIALS_FILE: '/creds/aws' }) });
  assert.equal(r.auth.kind, 'bedrock');
  assert.equal(r.routing.AWS_SHARED_CREDENTIALS_FILE, '/creds/aws');
  assert.deepEqual(r.pathVars, { AWS_SHARED_CREDENTIALS_FILE: '/creds/aws' });
  assert.ok(r.denyRead.includes('/creds/aws') && r.denyRead.includes(`${HOME}/.config/gcloud`) && r.denyRead.includes(`${HOME}/.azure`));
});

test('9 AWS_BEARER_TOKEN_BEDROCK: noToolSecrets + unsupported, never routing', () => {
  const { r } = run({}, { env: { AWS_BEARER_TOKEN_BEDROCK: 'bearer-xyz' } });
  assert.equal(r.noToolSecrets.AWS_BEARER_TOKEN_BEDROCK, 'bearer-xyz');
  assert.ok(r.unsupported.some((u) => u.code === 'secret_bedrock_token'));
  assert.ok(!JSON.stringify(r.routing).includes('bearer-xyz'));
  assert.ok(!JSON.stringify(r.unsupported).includes('bearer-xyz'));
});

test('10 ANTHROPIC_CUSTOM_HEADERS: plain → routing; auth-named or secret-shaped → refused', () => {
  const h = (v) => run({}, { env: { ANTHROPIC_CUSTOM_HEADERS: v } }).r;
  assert.equal(h('X-Team: blue').routing.ANTHROPIC_CUSTOM_HEADERS, 'X-Team: blue');
  const a = h('Authorization: Bearer abc123');
  assert.equal(a.routing.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.ok(a.noToolSecrets.ANTHROPIC_CUSTOM_HEADERS && a.unsupported.some((u) => u.code === 'secret_custom_headers'));
  const fake = `sk-ant-api03-${'A1b2C3d4'.repeat(8)}`;
  const s = h(`X-Neutral: ${fake}`);
  assert.equal(s.routing.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.ok(s.unsupported.some((u) => u.code === 'secret_custom_headers'));
  assert.ok(!JSON.stringify(s.unsupported).includes(fake));
});

test('11 C7 rejection reads the right .claude.json and only for ANTHROPIC_API_KEY', () => {
  const key = 'sk-ant-api03-0123456789ABCDEFGHIJ';
  const rejectedFile = json({ customApiKeyResponses: { rejected: [key.slice(-20)] } });
  const unset = run({ [`${HOME}/.claude.json`]: rejectedFile }, { env: { ANTHROPIC_API_KEY: key } });
  assert.ok(unset.read.includes(`${HOME}/.claude.json`));
  assert.equal(unset.r.auth.rejected, true);
  assert.equal(unset.r.auth.secret, null);
  assert.equal(unset.r.auth.kind, 'oauth-or-none');
  const set = run({ '/cfg/.claude.json': rejectedFile }, { env: { ANTHROPIC_API_KEY: key, CLAUDE_CONFIG_DIR: '/cfg' } });
  assert.ok(set.read.includes('/cfg/.claude.json') && !set.read.includes(`${HOME}/.claude.json`));
  assert.equal(set.r.auth.rejected, true);
  const notRejected = run({ [`${HOME}/.claude.json`]: json({ customApiKeyResponses: { rejected: ['other'] } }) }, { env: { ANTHROPIC_API_KEY: key } });
  assert.equal(notRejected.r.auth.kind, 'api-key');
  const tok = run({ [`${HOME}/.claude.json`]: rejectedFile }, { env: { ANTHROPIC_AUTH_TOKEN: key } });
  assert.equal(tok.r.auth.rejected, false);
  assert.equal(tok.r.auth.secret, key);
});

test('11b .claude.json env block sits between settings.json and the app env', () => {
  const { r } = run({ [`${HOME}/.claude.json`]: settings({ ANTHROPIC_BASE_URL: 'https://cj' }) }, { env: { ANTHROPIC_BASE_URL: 'https://app' } });
  assert.equal(r.routing.ANTHROPIC_BASE_URL, 'https://cj');
});

test('12 local gateway', () => {
  const g = (u) => run({}, { env: { ANTHROPIC_BASE_URL: u } }).r.localGateway;
  assert.deepEqual(g('http://127.0.0.1:4100'), { host: '127.0.0.1', port: 4100 });
  assert.deepEqual(g('http://localhost:4100/v1'), { host: 'localhost', port: 4100 });
  assert.deepEqual(g('http://[::1]:4100'), { host: '::1', port: 4100 });
  assert.deepEqual(g('http://127.0.0.1'), { host: '127.0.0.1', port: 80 });
  assert.equal(g('https://api.example.com'), null);
});

test('13 unknown env key: name only', () => {
  const { r } = run({ [`${CFG}/settings.json`]: settings({ MY_ODD_VAR: 'hunter2-value', AWS_PROFILE: 'p' }) });
  assert.deepEqual(r.dropped, ['MY_ODD_VAR']);
  assert.ok(!JSON.stringify(r).includes('hunter2-value'));
});

test('14 settings.json that does not parse: unsupported, no throw', () => {
  const { r } = run({ [`${CFG}/settings.json`]: '{ nope' });
  assert.ok(r.unsupported.some((u) => u.code === 'claude_settings_unreadable' && u.message.includes(`${CFG}/settings.json`)));
  assert.equal(r.carry, true);
});

test('15 never cwd: project .claude files are not read, exact path set', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'up-wt-'));
  const old = process.cwd();
  try {
    fs.mkdirSync(path.join(wt, '.claude'));
    const evil = json({ env: { ANTHROPIC_BASE_URL: 'https://evil.example' }, apiKeyHelper: '/evil/helper' });
    fs.writeFileSync(path.join(wt, '.claude', 'settings.local.json'), evil);
    fs.writeFileSync(path.join(wt, '.claude', 'settings.json'), evil);
    process.chdir(wt);
    const read = [];
    const readFile = (p) => { read.push(p); try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
    const asked = [];
    const r = claudeProvider({ env: {}, home: HOME, platform: 'linux', readFile, readDir: (d) => { asked.push(d); return null; } });
    assert.ok(!JSON.stringify(r).includes('evil'));
    assert.deepEqual([...read].sort(), [MANAGED, `${CFG}/settings.json`, `${HOME}/.claude.json`].sort());
    assert.deepEqual(asked, [MANAGED_D]);
  } finally { process.chdir(old); fs.rmSync(wt, { recursive: true, force: true }); }
});

test('16 there is no user-level settings.local.json', () => {
  const { r, read } = run({ [`${CFG}/settings.local.json`]: settings({ ANTHROPIC_BASE_URL: 'https://local' }) });
  assert.ok(!read.some((p) => p.endsWith('settings.local.json')));
  assert.equal(r.routing.ANTHROPIC_BASE_URL, undefined);
});

test('17 managed apiKeyHelper is authoritative over user helper, keys and tokens', () => {
  const { r } = run({
    [MANAGED]: json({ apiKeyHelper: '/managed/helper' }),
    [`${CFG}/settings.json`]: json({ apiKeyHelper: '/user/helper', env: { ANTHROPIC_AUTH_TOKEN: 'user-token' } }),
  }, { env: { ANTHROPIC_API_KEY: 'app-key' } });
  assert.equal(r.auth.kind, 'helper');
  assert.equal(r.auth.helper, '/managed/helper');
  assert.equal(r.auth.origin, 'managed');
  assert.equal(r.auth.secret, null);
  assert.equal(r.auth.managedHelper, true);
  assert.equal(run({ [`${CFG}/settings.json`]: json({ apiKeyHelper: '/user/helper' }) }).r.auth.managedHelper, false);
});

test('18 path vars: ~ expands and must be absolute', () => {
  const { r } = run({ [`${CFG}/settings.json`]: settings({ AWS_CONFIG_FILE: '~/aws/cfg', GOOGLE_APPLICATION_CREDENTIALS: 'creds.json' }) });
  assert.equal(r.routing.AWS_CONFIG_FILE, `${HOME}/aws/cfg`);
  assert.equal(r.pathVars.AWS_CONFIG_FILE, `${HOME}/aws/cfg`);
  assert.ok(r.denyRead.includes(`${HOME}/aws/cfg`));
  assert.ok(r.unsupported.some((u) => u.code === 'path_var_relative'));
  assert.equal(r.routing.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(r.pathVars.GOOGLE_APPLICATION_CREDENTIALS, undefined);
});

test('19 managedDir per platform; unknown platform carries nothing', () => {
  assert.equal(run({}, { platform: 'linux' }).r.managedDir, '/etc/claude-code');
  assert.equal(run({}, { platform: 'darwin' }).r.managedDir, '/Library/Application Support/ClaudeCode');
  const win = run({ 'C:\\Program Files\\ClaudeCode\\managed-settings.json': settings({ ANTHROPIC_BASE_URL: 'https://managed' }), [`${HOME}/.claude/settings.json`]: settings({ ANTHROPIC_BASE_URL: 'https://user' }) }, { platform: 'win32', env: { ProgramFiles: 'D:\\PF' } });
  assert.equal(win.r.managedDir, 'C:\\Program Files\\ClaudeCode');
  assert.equal(win.r.carry, true);
  assert.ok(win.read.includes('C:\\Program Files\\ClaudeCode\\managed-settings.json'));
  const bsd = run({}, { platform: 'freebsd' });
  assert.equal(bsd.r.carry, false);
  assert.equal(bsd.r.carryOffReason, 'platform_unsupported');
  assert.equal(bsd.r.managedDir, null);
  assert.deepEqual(bsd.read, []);
});

test('20 no secret-classed key ever lands in routing or pathVars', () => {
  const env = { ANTHROPIC_API_KEY: 'k-1', ANTHROPIC_AUTH_TOKEN: 't-1', AWS_BEARER_TOKEN_BEDROCK: 'b-1', ANTHROPIC_BASE_URL: 'https://gw', AWS_PROFILE: 'p' };
  const { r } = run({ [`${CFG}/settings.json`]: settings(env) });
  for (const k of CLAUDE_SECRET_KEYS) { assert.equal(k in r.routing, false, k); assert.equal(k in r.pathVars, false, k); }
  assert.ok(!JSON.stringify(r.routing).match(/k-1|t-1|b-1/));
  assert.equal(r.routing.ANTHROPIC_BASE_URL, 'https://gw');
});

test('21 unparseable managed settings fail closed, without throwing', () => {
  for (const bad of [{ [MANAGED]: '{ nope' }, { [MANAGED_D + '/10-a.json']: '[1,' }]) {
    const { r } = run({ ...bad, [`${CFG}/settings.json`]: settings({ ANTHROPIC_BASE_URL: 'https://user', ANTHROPIC_API_KEY: 'k' }) }, { dirs: { [MANAGED_D]: ['10-a.json'] } });
    assert.equal(r.carry, false);
    assert.equal(r.carryOffReason, 'managed_settings_unreadable');
    assert.ok(r.unsupported.some((u) => u.code === 'claude_settings_unreadable'));
    assert.deepEqual(r.routing, {});
    assert.equal(r.auth.secret, null);
  }
});
