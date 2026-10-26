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
  const r = await carry(null).c.prepare();
  assert.equal(r.carry, false);
  assert.equal(r.failure, null);
  assert.deepEqual(r.overrides, []);
});

test('A8: model_provider="plexlab" is carried as -c values, the model separately, the key only in the CLI env', async () => {
  const { c, probes } = carry(PLEXLAB, { env: { PLEXLAB_KEY: KEY } });
  const r = await c.prepare();
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
  const r = await carry(PLEXLAB, { env: { PLEXLAB_KEY: KEY } }).c.prepare();
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
    const r = await carry(`model_provider = "${id}"\n[model_providers.${id}]\nbase_url = "http://x:1"\n`).c.prepare();
    assert.equal(r.failure?.kind, 'provider', id);
    assert.match(r.failure.reason, /redefines a built-in provider/);
  }
  const bare = await carry('model_provider = "ollama"\n').c.prepare();
  assert.equal(bare.failure, null);
  assert.deepEqual(bare.overrides, ['model_provider="ollama"']);
});

test('C2: an env_key whose value Plexiform cannot see parks auth, naming the variable and nothing else', async () => {
  const r = await carry(PLEXLAB, { env: {} }).c.prepare();
  assert.equal(r.failure.kind, 'auth');
  assert.match(r.failure.reason, /\$PLEXLAB_KEY/);
  assert.match(r.failure.reason, /plexlab/);
  assert.deepEqual(r.overrides, []);
  assert.deepEqual(r.cliEnv, {});
});

test('C2: the login shell supplies a missing env_key; it is asked only for the names it needs', async () => {
  const asked = [];
  const loginShellEnv = async ({ names }) => { asked.push(names); return { PLEXLAB_KEY: KEY, UNASKED: 'x' }; };
  const r = await carry(PLEXLAB, { env: {}, loginShellEnv }).c.prepare();
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
  const r = await carry(text).c.prepare();
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
  const r = await carry('model_provider = "plexlab\n[broken').c.prepare();
  assert.equal(r.carry, true);
  assert.equal(r.failure.kind, 'provider');
  assert.match(r.failure.reason, /not valid TOML/);
  assert.deepEqual(r.overrides, []);
});

test('a provider gateway that does not answer fails with the host, before Codex can wait forever', async () => {
  const r = await carry(PLEXLAB, { env: { PLEXLAB_KEY: KEY }, probeOk: false }).c.prepare();
  assert.deepEqual(r.failure, { kind: 'provider', reason: "the gateway at 10.0.0.5:4001 isn't answering" });
  assert.deepEqual(r.cliEnv, {});
});

test('a loopback gateway Burst owns, without the Burst marker: "Burst gateway isn\'t running"', async () => {
  const text = 'model_provider = "local"\n[model_providers.local]\nbase_url = "http://127.0.0.1:7777/v1"\n';
  const r = await carry(text, { probeOk: false, burstOwns: true }).c.prepare();
  assert.equal(r.failure.reason, "Burst gateway isn't running");
  const other = await carry(text.replace('7777', '4001'), { probeOk: false, burstOwns: false }).c.prepare();
  assert.equal(other.failure.reason, "the gateway at 127.0.0.1:4001 isn't answering");
});

// The Burst fixture is RECONSTRUCTED from the claude-burst binary's template strings, not captured from a live
// `codex-enable` (Burst is macOS-only and not in the DGX lab). These cases run against it so the code path is
// exercised; plan §8 / M5 keeps PR 3 from merging until the real capture replaces it (the todo below).
const burstText = fs.readFileSync(path.join(FIX, 'burst-codex-enable.redacted.toml'), 'utf8');

test('Burst (reconstructed fixture): carried as-is; requires_openai_auth keeps the ChatGPT login, no key in the env', async () => {
  const r = await carry(burstText).c.prepare();
  assert.equal(r.failure, null);
  assert.equal(r.providerId, 'claude-burst');
  assert.equal(r.burst, true);
  assert.ok(r.overrides.includes('model_providers.claude-burst.requires_openai_auth=true'));
  assert.deepEqual(r.cliEnv, {});
});

test('Burst (reconstructed fixture): a gateway that is down says so by name, and the probe carries no credential', async () => {
  const { c, probes } = carry(burstText, { probeOk: false });
  const r = await c.prepare();
  assert.deepEqual(r.failure, { kind: 'provider', reason: "Burst gateway isn't running" });
  assert.deepEqual(probes, [{ host: '127.0.0.1', port: 7777, timeoutMs: 2000 }]);
});

test.todo('Burst (REAL capture): replace burst-codex-enable.redacted.toml with a redacted config.toml from a live `claude-burst codex enable`, re-derive BURST_CODEX_MARKERS from it, and re-run the two Burst cases above (plan §8 M5; blocks the PR 3 merge; needs the user\'s approval to run Burst)');

test('dropped provider fields are logged by name only', async () => {
  const lines = [];
  const r = await carry(`${PLEXLAB}future_field = "fetch-token-fake"\n`, { env: { PLEXLAB_KEY: KEY }, log: (l) => lines.push(l) }).c.prepare();
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
  const r = await carry(text, { env: { PLEXLAB_KEY: KEY } }).c.prepare();
  for (const o of r.overrides) assert.ok(/^model_provider(s\.|=)/.test(o), o);
  assert.ok(!r.overrides.some((o) => /mcp_servers|hooks|notify|projects|sandbox/.test(o)));
});

// Review round 1, item 2: carry:false means only "config read, no model_provider". Nothing else may land there,
// because every caller treats carry:false as "use the built-in OpenAI provider".
test('fail closed: a config.toml that is there but cannot be read fails provider, never carry:false', async () => {
  const c = createCodexCarry({ env: {}, home: HOME, platform: 'linux', readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, probe: async () => true });
  const r = await c.prepare();
  assert.equal(r.carry, true);
  assert.equal(r.failure.kind, 'provider');
  assert.match(r.failure.reason, /config\.toml could not be read/);
});

test('fail closed: an unexpected error while resolving fails provider, never carry:false', async () => {
  const c = createCodexCarry({ env: {}, home: HOME, platform: 'linux', readFile: () => ({}), probe: async () => true });
  const r = await c.prepare();
  assert.deepEqual([r.carry, r.failure], [true, { kind: 'provider', reason: 'Codex settings could not be read' }]);
  assert.deepEqual(r.overrides, []);
});

test('review item 5: a provider id outside [A-Za-z0-9_-] is refused, not quoted into a -c key codex would split', async () => {
  const r = await carry('model_provider = "my.gw"\n[model_providers."my.gw"]\nbase_url = "http://10.0.0.5:4001/v1"\n').c.prepare();
  assert.equal(r.failure.kind, 'provider');
  assert.match(r.failure.reason, /letters, digits, - and _/);
  assert.deepEqual(r.overrides, []);
});

test('review item 7: a provider that signs in with an auth command (or aws) fails auth before the run, not with a late 401', async () => {
  const a = await carry('model_provider = "gw"\n[model_providers.gw]\nbase_url = "http://10.0.0.5:4001/v1"\n[model_providers.gw.auth]\ncommand = "get-token"\n').c.prepare();
  assert.equal(a.failure.kind, 'auth');
  assert.match(a.failure.reason, /signs in with a command \(auth\)/);
  assert.ok(!a.failure.reason.includes('get-token'), 'the command is never named');
  const w = await carry('model_provider = "gw"\n[model_providers.gw]\nbase_url = "http://10.0.0.5:4001/v1"\n[model_providers.gw.aws]\nprofile = "p"\n').c.prepare();
  assert.equal(w.failure.kind, 'auth');
});
