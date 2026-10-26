// PR 3 (lab finding A8): the user's own Codex provider, carried into Plexiform-started Codex runs.
// In-memory config files, fake env values and a recorded probe: no real HOME, no network, no codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexCarry, productionCodexCarry, overrideKeyAllowed, gatewayOf, TAKEOVER_TRANSLATED } from '../codex-carry.cjs';
import { codexConfig } from '../../runner/backends/codex.js';

const HOME = '/home/fixture';
const CFG = `${HOME}/.codex/config.toml`;
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex-config');
const KEY = 'plexlab-fake-key-0123456789abcdef';
const PLEXLAB = `model = "glm-5.3-flash"
model_provider = "plexlab"
[model_providers.plexlab]
name = "Plexlab"
base_url = "http://10.0.0.5:4001/v1"
wire_api = "responses"
env_key = "PLEXLAB_KEY"
`;

function carry(text, { env = {}, probeOk = true, burstOwns = false, loginShellEnv = null, log } = {}) {
  const probes = [];
  const c = createCodexCarry({
    env, home: HOME, platform: 'linux', loginShellEnv, log,
    readFile: (f) => (f === CFG ? text : null),
    probe: async (args) => { probes.push(args); return probeOk; },
    burstOwnsPort: async () => burstOwns,
  });
  return { c, probes };
}
const keyOf = (o) => o.slice(0, o.indexOf('='));

test('no config.toml: nothing carried, the built-in provider stays', async () => {
  const r = await carry(null).c.prepare({ mode: 'noshell' });
  assert.equal(r.carry, false);
  assert.equal(r.failure, null);
  assert.deepEqual(r.overrides, []);
});

test('A8: model_provider="plexlab" is carried as -c values, the model separately, the key only in the CLI env', async () => {
  const { c, probes } = carry(PLEXLAB, { env: { PLEXLAB_KEY: KEY } });
  const r = await c.prepare({ mode: 'noshell' });
  assert.equal(r.carry, true);
  assert.equal(r.failure, null);
  assert.ok(r.overrides.includes('model_provider="plexlab"'));
  assert.ok(r.overrides.includes('model_providers.plexlab.base_url="http://10.0.0.5:4001/v1"'));
  assert.ok(r.overrides.includes('model_providers.plexlab.env_key="PLEXLAB_KEY"'));
  assert.ok(!r.overrides.some((o) => o.startsWith('model=')), 'the caller passes the model its own way');
  assert.equal(r.model, 'glm-5.3-flash');
  assert.deepEqual(r.cliEnv, { PLEXLAB_KEY: KEY });
  assert.ok(!JSON.stringify(r.overrides).includes(KEY));
  assert.equal(r.translated, false);
  // The probe is a bare TCP connect: host, port and a timeout, nothing else to carry a credential.
  assert.deepEqual(probes, [{ host: '10.0.0.5', port: 4001, timeoutMs: 2000 }]);
});

test('C16: every provider override is under model_provider or model_providers.<id>.*, disjoint from the run profile', async () => {
  const r = await carry(PLEXLAB, { env: { PLEXLAB_KEY: KEY } }).c.prepare({ mode: 'noshell' });
  const profileKeys = new Set(codexConfig({ cwd: '/w', env: { HOME }, boardRunDir: '/r', platform: 'linux' }).map(keyOf));
  for (const o of r.overrides) {
    assert.ok(overrideKeyAllowed(o, 'plexlab'), o);
    const k = keyOf(o);
    assert.ok(k === 'model_provider' || k.startsWith('model_providers.'), k);
    assert.ok(![...profileKeys].some((p) => p === k || p.startsWith(`${k}.`) || k.startsWith(`${p}.`)), `${k} overlaps the profile`);
  }
  assert.equal(overrideKeyAllowed('shell_environment_policy.inherit="all"', 'plexlab'), false);
  assert.equal(overrideKeyAllowed('model_providers.other.base_url="x"', 'plexlab'), false);
  assert.equal(overrideKeyAllowed('model_providers.plexlab.a.b="x"', 'plexlab'), false);
});

test('C16: a table that redefines a built-in provider id fails loud', async () => {
  for (const id of ['openai', 'ollama', 'lmstudio', 'amazon-bedrock']) {
    const r = await carry(`model_provider = "${id}"\n[model_providers.${id}]\nbase_url = "http://x:1"\n`).c.prepare({ mode: 'noshell' });
    assert.equal(r.failure?.kind, 'provider', id);
    assert.match(r.failure.reason, /redefines a built-in provider/);
  }
  const bare = await carry('model_provider = "ollama"\n').c.prepare({ mode: 'noshell' });
  assert.equal(bare.failure, null);
  assert.deepEqual(bare.overrides, ['model_provider="ollama"']);
});

test('C2: an env_key whose value Plexiform cannot see parks auth, naming the variable and nothing else', async () => {
  const r = await carry(PLEXLAB, { env: {} }).c.prepare({ mode: 'noshell' });
  assert.equal(r.failure.kind, 'auth');
  assert.match(r.failure.reason, /\$PLEXLAB_KEY/);
  assert.match(r.failure.reason, /plexlab/);
  assert.deepEqual(r.overrides, []);
  assert.deepEqual(r.cliEnv, {});
});

test('C2: the login shell supplies a missing env_key; it is asked only for the names it needs', async () => {
  const asked = [];
  const loginShellEnv = async ({ names }) => { asked.push(names); return { PLEXLAB_KEY: KEY, UNASKED: 'x' }; };
  const r = await carry(PLEXLAB, { env: {}, loginShellEnv }).c.prepare({ mode: 'noshell' });
  assert.equal(r.failure, null);
  assert.deepEqual(r.cliEnv, { PLEXLAB_KEY: KEY });
  assert.deepEqual(asked, [['CODEX_HOME', 'PLEXLAB_KEY']]);
});

test('C13: inline http_headers and experimental_bearer_token are translated; their values never reach argv', async () => {
  const text = `model_provider = "gw"
[model_providers.gw]
base_url = "https://gw.example.test/v1"
experimental_bearer_token = "${KEY}"
http_headers = { "X-Team-Secret" = "hdr-fake-value-1" }
`;
  const r = await carry(text).c.prepare({ mode: 'noshell' });
  assert.equal(r.failure, null);
  assert.ok(r.overrides.includes('model_providers.gw.env_key="PLEXIFORM_PROVIDER_KEY"'));
  assert.ok(r.overrides.includes('model_providers.gw.env_http_headers={X-Team-Secret="PLEXIFORM_PROVIDER_H1"}'));
  assert.deepEqual(r.cliEnv, { PLEXIFORM_PROVIDER_KEY: KEY, PLEXIFORM_PROVIDER_H1: 'hdr-fake-value-1' });
  const argv = JSON.stringify(r.overrides);
  assert.ok(!argv.includes(KEY) && !argv.includes('hdr-fake-value-1'));
  assert.equal(r.translated, true);
  assert.match(TAKEOVER_TRANSLATED, /env_key/);
});

test('L7: config.toml that does not parse fails loud, never the openai default', async () => {
  const r = await carry('model_provider = "plexlab\n[broken').c.prepare({ mode: 'noshell' });
  assert.equal(r.carry, true);
  assert.equal(r.failure.kind, 'provider');
  assert.match(r.failure.reason, /not valid TOML/);
  assert.deepEqual(r.overrides, []);
});

test('a provider gateway that does not answer fails with the host, before Codex can wait forever', async () => {
  const r = await carry(PLEXLAB, { env: { PLEXLAB_KEY: KEY }, probeOk: false }).c.prepare({ mode: 'noshell' });
  assert.deepEqual(r.failure, { kind: 'provider', reason: "the gateway at 10.0.0.5:4001 isn't answering" });
  assert.deepEqual(r.cliEnv, {});
});

test('a loopback gateway Burst owns, without the Burst marker: "Burst gateway isn\'t running"', async () => {
  const text = 'model_provider = "local"\n[model_providers.local]\nbase_url = "http://127.0.0.1:7779/v1"\n';
  const r = await carry(text, { probeOk: false, burstOwns: true }).c.prepare({ mode: 'noshell' });
  assert.equal(r.failure.reason, "Burst gateway isn't running");
  const other = await carry(text.replace('7779', '4001'), { probeOk: false, burstOwns: false }).c.prepare({ mode: 'noshell' });
  assert.equal(other.failure.reason, "the gateway at 127.0.0.1:4001 isn't answering");
});

test('the production Burst-owned-port check is 7779 for Codex (7777 is Burst\'s Claude gateway)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxburst-'));
  try {
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude-burst'), '', { mode: 0o755 });
    const reasonFor = async (port) => (await createCodexCarry({ env: {}, home, platform: 'darwin', probe: async () => false,
      readFile: (f) => (f === `${home}/.codex/config.toml` ? `model_provider = "local"\n[model_providers.local]\nbase_url = "http://127.0.0.1:${port}/v1"\n` : null) }).prepare({ mode: 'noshell' })).failure.reason;
    assert.equal(await reasonFor(7779), "Burst gateway isn't running");
    assert.equal(await reasonFor(7777), "the gateway at 127.0.0.1:7777 isn't answering");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// The REAL capture of `claude-burst codex enable` (claude-burst 0.20.36, throwaway HOME/CODEX_HOME; no secrets).
const burstText = fs.readFileSync(path.join(FIX, 'burst-codex-enable.redacted.toml'), 'utf8');

test('Burst (real capture): carried as-is on every site; requires_openai_auth is the ChatGPT login, so no secret and no key file', async () => {
  assert.match(burstText, /^# BEGIN claude-burst \(/m);
  assert.match(burstText, /^# END claude-burst$/m);
  for (const mode of ['shell', 'noshell', 'takeover']) {
    const r = await carry(burstText).c.prepare({ mode, keyFile: '/run/x/codex-provider.key' });
    assert.equal(r.failure, null, mode);
    assert.equal(r.providerId, 'claude-burst');
    assert.equal(r.burst, true);
    assert.ok(r.overrides.includes('model_providers.claude-burst.requires_openai_auth=true'), mode);
    assert.ok(r.overrides.includes('model_providers.claude-burst.base_url="http://127.0.0.1:7779/backend-api/codex"'));
    assert.ok(!r.overrides.some((o) => o.includes('.auth=')), 'no auth command: nothing to carry');
    assert.equal(r.keyFile, null);
    assert.deepEqual(r.cliEnv, {});
    assert.equal(r.translated, false);
  }
});

test('Burst (real capture): a gateway that is down says so by name, and the probe carries no credential', async () => {
  const { c, probes } = carry(burstText, { probeOk: false });
  const r = await c.prepare({ mode: 'noshell' });
  assert.deepEqual(r.failure, { kind: 'provider', reason: "Burst gateway isn't running" });
  assert.deepEqual(probes, [{ host: '127.0.0.1', port: 7779, timeoutMs: 2000 }]);
});

test('dropped provider fields are logged by name only', async () => {
  const lines = [];
  const r = await carry(`${PLEXLAB}future_field = "fetch-token-fake"\n`, { env: { PLEXLAB_KEY: KEY }, log: (l) => lines.push(l) }).c.prepare({ mode: 'noshell' });
  assert.equal(r.failure, null);
  assert.deepEqual(lines, ['codex provider fields not carried: future_field']);
  assert.ok(!r.overrides.some((o) => o.includes('fetch-token-fake')));
});

test('gatewayOf: scheme default ports and IPv6 loopback', () => {
  assert.deepEqual(gatewayOf('https://gw.example.test/v1'), { host: 'gw.example.test', port: 443, loopback: false });
  assert.deepEqual(gatewayOf('http://[::1]:8080'), { host: '::1', port: 8080, loopback: true });
  assert.equal(gatewayOf('unix:///tmp/x'), null);
});

test('the production carry is off under the no-real-cli guard', () => {
  assert.equal(globalThis.__plexiformNoRealCli, true);
  assert.equal(productionCodexCarry(), null);
});

test('bus isolation: a config.toml with mcp_servers, hooks and notify carries none of them', async () => {
  const text = fs.readFileSync(path.join(FIX, 'ignored-tables.toml'), 'utf8');
  const r = await carry(text, { env: { PLEXLAB_KEY: KEY } }).c.prepare({ mode: 'noshell' });
  for (const o of r.overrides) assert.ok(/^model_provider(s\.|=)/.test(o), o);
  assert.ok(!r.overrides.some((o) => /mcp_servers|hooks|notify|projects|sandbox/.test(o)));
});

// Review round 1, item 2: carry:false means only "config read, no model_provider". Nothing else may land there,
// because every caller treats carry:false as "use the built-in OpenAI provider".
test('fail closed: a config.toml that is there but cannot be read fails provider, never carry:false', async () => {
  const c = createCodexCarry({ env: {}, home: HOME, platform: 'linux', readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, probe: async () => true });
  const r = await c.prepare({ mode: 'noshell' });
  assert.equal(r.carry, true);
  assert.equal(r.failure.kind, 'provider');
  assert.match(r.failure.reason, /config\.toml could not be read/);
});

test('fail closed: an unexpected error while resolving fails provider, never carry:false', async () => {
  const c = createCodexCarry({ env: {}, home: HOME, platform: 'linux', readFile: () => ({}), probe: async () => true });
  const r = await c.prepare({ mode: 'noshell' });
  assert.deepEqual([r.carry, r.failure], [true, { kind: 'provider', reason: 'Codex settings could not be read' }]);
  assert.deepEqual(r.overrides, []);
});

test('review item 5: a provider id outside [A-Za-z0-9_-] is refused, not quoted into a -c key codex would split', async () => {
  const r = await carry('model_provider = "my.gw"\n[model_providers."my.gw"]\nbase_url = "http://10.0.0.5:4001/v1"\n').c.prepare({ mode: 'noshell' });
  assert.equal(r.failure.kind, 'provider');
  assert.match(r.failure.reason, /letters, digits, - and _/);
  assert.deepEqual(r.overrides, []);
});

test('review item 7: a provider that signs in with an auth command (or aws) fails auth before the run, not with a late 401', async () => {
  const a = await carry('model_provider = "gw"\n[model_providers.gw]\nbase_url = "http://10.0.0.5:4001/v1"\n[model_providers.gw.auth]\ncommand = "get-token"\n').c.prepare({ mode: 'noshell' });
  assert.equal(a.failure.kind, 'auth');
  assert.match(a.failure.reason, /signs in with a command \(auth\)/);
  assert.ok(!a.failure.reason.includes('get-token'), 'the command is never named');
  const w = await carry('model_provider = "gw"\n[model_providers.gw]\nbase_url = "http://10.0.0.5:4001/v1"\n[model_providers.gw.aws]\nprofile = "p"\n').c.prepare({ mode: 'noshell' });
  assert.equal(w.failure.kind, 'auth');
});

test('review item 4: every result without a failure reports the CODEX_HOME it read, the login shell\'s when only it has one', async () => {
  assert.equal((await carry(null).c.prepare({ mode: 'noshell' })).codexHome, `${HOME}/.codex`, 'no provider still says where it looked');
  assert.equal((await carry(PLEXLAB, { env: { PLEXLAB_KEY: KEY } }).c.prepare({ mode: 'noshell' })).codexHome, `${HOME}/.codex`);
  const login = createCodexCarry({ env: {}, home: HOME, platform: 'linux', loginShellEnv: async () => ({ CODEX_HOME: '/fx/alt' }), readFile: () => null, probe: async () => true });
  assert.equal((await login.prepare({ mode: 'noshell' })).codexHome, '/fx/alt');
  assert.equal((await carry(PLEXLAB).c.prepare({ mode: 'noshell' })).codexHome, null, 'a failure carries none');
});

test('codexConfig denies both the run\'s CODEX_HOME and ~/.codex', () => {
  const c = codexConfig({ cwd: '/w', env: { HOME: '/home/u', CODEX_HOME: '/fx/alt' }, platform: 'linux' });
  const fsTable = c.find((x) => x.startsWith('permissions.plexiform.filesystem='));
  assert.ok(fsTable.includes('"/fx/alt"="deny"') && fsTable.includes('"/home/u/.codex"="deny"'));
});

// ── Lead decision after the DGX /proc lab: (a) today, (b) the target, one flag apart ──
import { KEY_VIA_AUTH_FILE, CODEX_KEY_FILE, KEY_NOT_KEPT, HEADER_NOT_KEPT } from '../codex-carry.cjs';
import os from 'node:os';
const NOKEY = 'model_provider = "local"\n[model_providers.local]\nbase_url = "http://127.0.0.1:4001/v1"\nwire_api = "responses"\n';
const withKey = (opts = {}) => createCodexCarry({ env: { PLEXLAB_KEY: KEY }, home: HOME, platform: 'linux', readFile: (f) => (f === CFG ? (opts.text ?? PLEXLAB) : null), probe: async () => true, burstOwnsPort: async () => false, ...opts });

test('the shipped default is (b), proven by the lab (codex-auth-command.md); (a) is only the fallback', () => {
  assert.equal(KEY_VIA_AUTH_FILE, true);
});

test('(a) fallback, with no key file: a key is refused for a run with a shell, kept for no-shell sites and takeover; a keyless provider goes everywhere', async () => {
  const shell = await withKey().prepare();
  assert.deepEqual(shell.failure, { kind: 'auth', reason: KEY_NOT_KEPT });
  assert.deepEqual(shell.cliEnv, {});
  assert.ok(!KEY_NOT_KEPT.includes('PLEXLAB'), 'the reason names no variable or value');
  const inline = await withKey({ env: {}, text: `model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.example.test/v1"\nexperimental_bearer_token = "${KEY}"\n` }).prepare({ mode: 'shell', keyFile: '/run/x/codex-provider.key' });
  assert.equal(inline.failure.reason, KEY_NOT_KEPT, 'a translated bearer token too');
  const noshell = await withKey().prepare({ mode: 'noshell' });
  assert.equal(noshell.failure, null);
  assert.equal(noshell.cliEnv.PLEXLAB_KEY, KEY);
  const takeover = await withKey().prepare({ mode: 'takeover' });
  assert.equal(takeover.failure, null);
  assert.ok(takeover.overrides.includes('model_providers.plexlab.env_key="PLEXLAB_KEY"'), 'the terminal supplies env_key itself');
  for (const mode of ['shell', 'noshell', 'takeover']) {
    const r = await withKey({ env: {}, text: NOKEY }).prepare({ mode });
    assert.equal(r.failure, null, mode);
    assert.ok(r.overrides.includes('model_provider="local"'), mode);
  }
});

test('(b): the key goes to a 0600 file behind auth={command="/bin/cat",args=[file]}; env_key and the CLI env lose it; release deletes it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxck-'));
  const file = path.join(dir, CODEX_KEY_FILE);
  try {
    const r = await withKey({ keyViaAuthFile: true }).prepare({ mode: 'shell', keyFile: file });
    assert.equal(r.failure, null);
    assert.equal(r.keyFile, file);
    assert.deepEqual(r.cliEnv, {});
    assert.ok(!r.overrides.some((o) => o.startsWith('model_providers.plexlab.env_key=')));
    assert.ok(r.overrides.includes(`model_providers.plexlab.auth={command="/bin/cat",args=[${JSON.stringify(file)}],timeout_ms=5000}`), 'the lab shape; no refresh_interval_ms');
    assert.ok(r.overrides.every((o) => overrideKeyAllowed(o, 'plexlab')), 'still only model_provider / model_providers.<id>.*');
    assert.ok(!r.overrides.some((o) => o.includes(KEY)));
    assert.equal(fs.readFileSync(file, 'utf8'), KEY);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    r.release();
    assert.equal(fs.existsSync(file), false);
    // A no-shell site with a key file (the owned chat) uses it too; without one (review) the key stays in the CLI env.
    const n = await withKey({ keyViaAuthFile: true }).prepare({ mode: 'noshell', keyFile: file });
    assert.deepEqual(n.cliEnv, {});
    assert.equal(fs.readFileSync(file, 'utf8'), KEY);
    n.release();
    const e = await withKey({ keyViaAuthFile: true }).prepare({ mode: 'noshell' });
    assert.equal(e.cliEnv.PLEXLAB_KEY, KEY);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('(b) falls back to the (a) refusal: header values, Windows, no or relative key file, a key file that cannot be written', async () => {
  const hdr = await withKey({ keyViaAuthFile: true, env: { PLEXLAB_KEY: KEY, PLEXLAB_ORG: 'o' }, text: `${PLEXLAB}[model_providers.plexlab.env_http_headers]\n"X-Org" = "PLEXLAB_ORG"\n` }).prepare({ mode: 'shell', keyFile: '/r/k' });
  assert.equal(hdr.failure.reason, HEADER_NOT_KEPT);
  for (const [opts, keyFile] of [[{ platform: 'win32' }, 'C:\\r\\k'], [{}, null], [{}, 'rel/k'], [{ writeKey: () => { throw new Error('EACCES'); } }, '/r/k']]) {
    const r = await withKey({ keyViaAuthFile: true, ...opts }).prepare({ mode: 'shell', keyFile });
    assert.deepEqual(r.failure, { kind: 'auth', reason: KEY_NOT_KEPT }, JSON.stringify(opts));
  }
});

test('the start-up sweep removes a left-over codex-provider.key (and its .tmp) except for kept runs', async () => {
  const { sweepKeyFiles } = await import('../claude-carry.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxsw-'));
  try {
    for (const id of ['a', 'b']) { fs.mkdirSync(path.join(root, id)); for (const f of [CODEX_KEY_FILE, `${CODEX_KEY_FILE}.1.2.tmp`, 'mcp.json']) fs.writeFileSync(path.join(root, id, f), 'x'); }
    sweepKeyFiles(root, (id) => id === 'b');
    assert.deepEqual(fs.readdirSync(path.join(root, 'a')), ['mcp.json']);
    assert.ok(fs.existsSync(path.join(root, 'b', CODEX_KEY_FILE)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('(b) drops the fields auth cannot be combined with: env_key, experimental_bearer_token, requires_openai_auth', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxck-'));
  try {
    const text = `${PLEXLAB}requires_openai_auth = true\n`;
    const r = await withKey({ text }).prepare({ mode: 'shell', keyFile: path.join(dir, CODEX_KEY_FILE) });
    assert.equal(r.failure, null);
    for (const f of ['env_key', 'experimental_bearer_token', 'requires_openai_auth']) assert.ok(!r.overrides.some((o) => o.startsWith(`model_providers.plexlab.${f}=`)), f);
    assert.equal(r.overrides.filter((o) => o.startsWith('model_providers.plexlab.auth=')).length, 1);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'the key dir is 0700');
    r.release();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // A keyless provider that relies on requires_openai_auth (Burst) keeps it: no auth command is added.
  const burst = await withKey({ env: {}, text: 'model_provider = "b"\n[model_providers.b]\nbase_url = "http://127.0.0.1:7777/v1"\nrequires_openai_auth = true\n' }).prepare({ mode: 'shell', keyFile: '/r/k' });
  assert.ok(burst.overrides.includes('model_providers.b.requires_openai_auth=true'));
  assert.ok(!burst.overrides.some((o) => o.includes('.auth=')));
});
