import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { codexProvider, boundedReadFile, readDirOrNull, claudeProvider, BURST_CODEX_MARKERS, BURST_CODEX_BEGIN, BURST_CODEX_END, CONFIG_TOML_MAX_BYTES, CLAUDE_JSON_MAX_BYTES } from '../user-provider.cjs';
import { findSecrets } from '../secret-patterns.mjs';
import { codexConfig } from '../../runner/backends/codex.js';

const HOME = '/home/u';
const CH = `${HOME}/.codex`;
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-config');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

function run(toml, { env = {}, loginEnv = {} } = {}) {
  const home = (env.CODEX_HOME || loginEnv.CODEX_HOME || CH).replace(/^~/, HOME);
  const files = toml == null ? {} : { [`${home}/config.toml`]: toml };
  return codexProvider({ env, loginEnv, home: HOME, readFile: (p) => files[p] ?? null });
}
const keyPaths = (r) => r.overrides.map((o) => o.slice(0, o.indexOf('=')));
const PLEXLAB = `model_provider = "plexlab"
[model_providers.plexlab]
name = "Lab"
base_url = "https://lab.example.com/v1"
env_key = "PLEXLAB_KEY"
`;

test('1 no config.toml: no provider, no overrides', () => {
  const r = run(null);
  assert.equal(r.providerId, null);
  assert.deepEqual(r.overrides, []);
  assert.deepEqual(r.unsupported, []);
});

test('2 custom provider with env_key', () => {
  const r = run(PLEXLAB, { env: { PLEXLAB_KEY: 'from-app' }, loginEnv: { PLEXLAB_KEY: 'from-login' } });
  assert.equal(r.providerId, 'plexlab');
  assert.deepEqual(keyPaths(r).sort(), ['model_provider', 'model_providers.plexlab.base_url', 'model_providers.plexlab.env_key', 'model_providers.plexlab.name']);
  assert.equal(r.cliEnv.PLEXLAB_KEY, 'from-app');
  assert.equal(run(PLEXLAB, { loginEnv: { PLEXLAB_KEY: 'from-login' } }).cliEnv.PLEXLAB_KEY, 'from-login');
  const none = run(PLEXLAB);
  assert.deepEqual(none.missingEnv, ['PLEXLAB_KEY']);
  assert.deepEqual(none.cliEnv, {});
  assert.ok(!r.overrides.join('\n').includes('from-app'));
});

test('3 profile resolution', () => {
  const r = run(`profile = "lab"
model_provider = "openai"
[profiles.lab]
model_provider = "plexlab"
model = "m1"
[model_providers.plexlab]
base_url = "https://lab.example.com/v1"
`);
  assert.equal(r.providerId, 'plexlab');
  assert.equal(r.model, 'm1');
  assert.ok(r.overrides.includes('model="m1"'));
});

test('4 http_headers and experimental_bearer_token are translated; secrets stay out of overrides', () => {
  const r = run(`model_provider = "gw"
[model_providers.gw]
base_url = "https://gw.example.com/v1"
experimental_bearer_token = "bearer-secret-1"
http_headers = { "X-Org" = "org-secret-2" }
`);
  assert.equal(r.cliEnv.PLEXIFORM_PROVIDER_KEY, 'bearer-secret-1');
  assert.equal(r.cliEnv.PLEXIFORM_PROVIDER_H1, 'org-secret-2');
  const o = r.overrides.join('\n');
  assert.ok(o.includes('env_key="PLEXIFORM_PROVIDER_KEY"'));
  assert.ok(o.includes('{X-Org="PLEXIFORM_PROVIDER_H1"}'));
  assert.ok(!o.includes('bearer-secret-1') && !o.includes('org-secret-2'));
});

test('5 env_key with experimental_bearer_token together is unsupported', () => {
  const r = run(`model_provider = "gw"
[model_providers.gw]
env_key = "K"
experimental_bearer_token = "bearer-secret-1"
`, { env: { K: 'v' } });
  assert.ok(r.unsupported.some((u) => u.code === 'codex_env_key_and_bearer_token'));
  assert.ok(!JSON.stringify(r).includes('bearer-secret-1'));
});

test('6 built-in id: a table is unsupported, bare model_provider is carried', () => {
  const t = run(`model_provider = "openai"
[model_providers.openai]
base_url = "https://evil.example.com"
`);
  assert.ok(t.unsupported.some((u) => u.code === 'codex_builtin_provider_override'));
  assert.ok(!t.overrides.some((o) => o.includes('evil.example.com')));
  const bare = run('model_provider = "ollama"\n');
  assert.deepEqual(bare.overrides, ['model_provider="ollama"']);
  assert.deepEqual(bare.unsupported, []);
});

test('7 a secret in query_params is unsupported', () => {
  const tok = `sk-ant-api03-${'A1b2C3d4'.repeat(8)}`;
  const r = run(`model_provider = "gw"
[model_providers.gw]
base_url = "https://gw.example.com"
query_params = { api-version = "1", api_key = "${tok}" }
`);
  assert.ok(r.unsupported.some((u) => u.code === 'codex_query_params_secret'));
  assert.ok(!JSON.stringify(r).includes(tok));
});

test('8 parse error: unsupported with line/column only, never a default provider', () => {
  const r = run('model_provider = "gw"\nsecret = "FAKE-TOKEN-ghp_abcdefghijklmnopqrstuvwxyz0123456789" oops\n');
  assert.equal(r.providerId, null);
  assert.deepEqual(r.overrides, []);
  assert.ok(r.unsupported.some((u) => u.code === 'codex_config_unparseable' && /line 2/.test(u.message)));
  assert.ok(!JSON.stringify(r).includes('FAKE-TOKEN'));
});

test('9 override key paths are disjoint from codexConfig key paths', () => {
  const cfg = codexConfig({ cwd: '/w', cacheDir: '/c', dataDir: '/d', gitDir: '/g', commonGitDir: '/g', env: {}, platform: 'linux' });
  const theirs = (Array.isArray(cfg) ? cfg : Object.values(cfg).flat()).filter((x) => typeof x === 'string').map((x) => x.slice(0, x.indexOf('=')));
  assert.ok(theirs.length > 0);
  const r = run(PLEXLAB.replace('model_provider', 'model = "m"\nmodel_provider'));
  assert.ok(r.overrides.length > 0);
  for (const k of keyPaths(r)) {
    assert.ok(['model_provider', 'model', 'model_providers'].includes(k.split('.')[0]), k);
    for (const t of theirs) assert.ok(k !== t && !t.startsWith(`${k}.`) && !k.startsWith(`${t}.`), `${k} vs ${t}`);
  }
});

test('10 mcp_servers, hooks, notify, projects, sandbox_mode are never looked at', () => {
  const r = run(fixture('ignored-tables.toml'));
  const s = JSON.stringify(r);
  for (const bad of ['evil', 'danger-full-access', 'trusted']) assert.ok(!s.includes(bad), bad);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.providerId, 'gw');
});

test('11 unknown provider field is dropped by name', () => {
  const r = run(`model_provider = "gw"
[model_providers.gw]
base_url = "https://gw.example.com"
mystery_flag = "zzz"
`);
  assert.deepEqual(r.dropped, ['mystery_flag']);
  assert.ok(!JSON.stringify(r).includes('zzz'));
});

test('12 syntax forms give the same provider and base URL', () => {
  for (const [file, id] of [['syntax-dotted.toml', 'gw'], ['syntax-inline.toml', 'gw'], ['syntax-quoted.toml', 'my-gw'], ['syntax-multiline.toml', 'gw'], ['syntax-comments.toml', 'gw']]) {
    const r = run(fixture(file));
    assert.equal(r.providerId, id, file);
    assert.ok(r.overrides.some((o) => /base_url="https:\/\/gw\.example\.com\/v1"$/.test(o)), file);
    assert.deepEqual(r.unsupported, [], file);
  }
  assert.ok(run(fixture('syntax-quoted.toml')).overrides.some((o) => o.startsWith('model_providers."my-gw".base_url=') || o.startsWith('model_providers.my-gw.base_url=')));
});

const burstFixture = path.join(FIX, 'burst-codex-enable.redacted.toml');
// The real capture of `claude-burst codex enable` (claude-burst 0.20.36). BURST_CODEX_MARKERS re-derived from it:
// the provider id, inside a "# BEGIN claude-burst (…)" / "# END claude-burst" block.
test('13 Burst codex-enable fixture (real capture)', () => {
  const text = fs.readFileSync(burstFixture, 'utf8');
  assert.deepEqual(findSecrets(text), []);
  assert.deepEqual([...BURST_CODEX_MARKERS], ['claude-burst']);
  const lines = text.split('\n');
  assert.ok(lines[0].startsWith(BURST_CODEX_BEGIN) && lines[0] !== BURST_CODEX_BEGIN, 'the BEGIN line has a suffix; the prefix matches');
  assert.ok(lines.includes(BURST_CODEX_END));
  const r = run(text);
  assert.equal(r.providerId, 'claude-burst');
  assert.equal(r.burst.detected, true);
  assert.equal(r.burst.block, true);
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(r.dropped, []);
  assert.ok(r.overrides.includes('model_providers.claude-burst.base_url="http://127.0.0.1:7779/backend-api/codex"'));
  assert.ok(r.overrides.includes('model_providers.claude-burst.name="Claude Burst"') && r.overrides.includes('model_providers.claude-burst.wire_api="responses"'));
  assert.ok(r.overrides.includes('model_providers.claude-burst.requires_openai_auth=true'));
  assert.deepEqual(r.missingEnv, []);
});

test('13b a non-Burst provider is not detected as Burst', () => {
  assert.equal(run(PLEXLAB).burst.detected, false);
  assert.equal(run(PLEXLAB).burst.block, false);
});

test('14 size cap runs before parse', () => {
  const r = run('= not toml\n'.repeat(Math.ceil((CONFIG_TOML_MAX_BYTES + 1000) / 11)));
  assert.ok(r.unsupported.some((u) => u.code === 'codex_config_too_large'));
  assert.ok(!r.unsupported.some((u) => u.code === 'codex_config_unparseable'));
});

test('15 CODEX_HOME: ~ expands, relative is unsupported', () => {
  const ok = run(PLEXLAB, { env: { CODEX_HOME: '~/cx' } });
  assert.equal(ok.codexHome, `${HOME}/cx`);
  assert.equal(ok.providerId, 'plexlab');
  const rel = run(PLEXLAB, { env: { CODEX_HOME: 'cx' } });
  assert.ok(rel.unsupported.some((u) => u.code === 'codex_home_relative'));
  assert.equal(rel.providerId, null);
});

const FAKE_KEY = `sk-ant-api03-${'A1b2C3d4'.repeat(8)}`;

test('16 a credential in base_url, name or another field never reaches overrides', () => {
  for (const [field, value] of [['base_url', 'https://gw.example.com/v1?api_key=abc123'], ['base_url', `https://u:${FAKE_KEY}@gw.example.com`], ['name', FAKE_KEY], ['env_key_instructions', FAKE_KEY]]) {
    const okUrl = field === 'base_url' ? '' : 'base_url = "https://ok.example.com"\n';
    const r = run(`model_provider = "gw"\n[model_providers.gw]\n${okUrl}${field} = "${value}"\n`);
    assert.ok(r.unsupported.some((u) => u.code === 'codex_secret_in_field'), field + value);
    assert.ok(!JSON.stringify(r).includes('abc123') && !JSON.stringify(r).includes(FAKE_KEY), field);
    assert.ok(!r.overrides.some((o) => o.startsWith(`model_providers.gw.${field}=`)), field);
  }
  const m = run(`model = "${FAKE_KEY}"\n`);
  assert.deepEqual(m.overrides, []);
  assert.ok(!JSON.stringify(m).includes(FAKE_KEY));
});

test('17 boundedReadFile: missing is null, small is whole, big is capped at max + 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-br-'));
  try {
    assert.equal(boundedReadFile(path.join(dir, 'nope.toml')), null);
    fs.writeFileSync(path.join(dir, 'small.toml'), 'model = "x"\n');
    assert.equal(boundedReadFile(path.join(dir, 'small.toml')), 'model = "x"\n');
    fs.writeFileSync(path.join(dir, 'big.toml'), 'x'.repeat(CONFIG_TOML_MAX_BYTES * 4));
    const big = boundedReadFile(path.join(dir, 'big.toml'));
    assert.equal(big.length, CONFIG_TOML_MAX_BYTES + 1);
    assert.ok(run(big).unsupported.some((u) => u.code === 'codex_config_too_large'));
    assert.equal(boundedReadFile(path.join(dir, 'big.toml'), 10).length, 11);
    assert.throws(() => boundedReadFile(dir), /EISDIR/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('18 boundedReadFile loops over short reads', () => {
  const data = Buffer.from('a'.repeat(1000));
  let pos = 0;
  const fake = {
    openSync: () => 3, closeSync() {},
    readSync: (fd, buf, off, len, at) => { const n = Math.min(7, len, data.length - at); data.copy(buf, off, at, at + n); pos += n; return n; },
  };
  assert.equal(boundedReadFile('/x', 5000, fake).length, 1000);
  assert.equal(boundedReadFile('/x', 100, fake).length, 101);
  assert.equal(CLAUDE_JSON_MAX_BYTES, 16 * 1024 * 1024);
});

test('19 readDirOrNull: missing is null (carry stays true), other errors throw (fail closed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'up-rd-'));
  try {
    assert.equal(readDirOrNull(path.join(dir, 'managed-settings.d')), null);
    fs.writeFileSync(path.join(dir, 'a.json'), '{}');
    assert.deepEqual(readDirOrNull(dir), ['a.json']);
    assert.throws(() => readDirOrNull(path.join(dir, 'a.json', 'x'), { readdirSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }), /x/);
    const r = claudeProvider({ env: {}, home: '/home/u', platform: 'linux', readFile: () => null, readDir: (d) => readDirOrNull(path.join(dir, 'missing', d)) });
    assert.equal(r.carry, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('20 env_http_headers holds variable names: an Authorization header is carried, not refused as a credential', () => {
  const r = run(`${PLEXLAB}env_http_headers = { Authorization = "PLEXLAB_AUTH" }\n`, { env: { PLEXLAB_KEY: 'k-fake', PLEXLAB_AUTH: 'Bearer fake-value' } });
  assert.deepEqual(r.unsupported, []);
  assert.ok(r.overrides.includes('model_providers.plexlab.env_http_headers={Authorization="PLEXLAB_AUTH"}'));
  assert.equal(r.cliEnv.PLEXLAB_AUTH, 'Bearer fake-value');
  assert.ok(!r.overrides.join('\n').includes('fake-value'));
});
