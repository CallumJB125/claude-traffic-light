// PR 3 (lab finding A8): Codex Tasks runs and takeovers carry the user's own Codex provider, and a failed
// provider preflight fails loud instead of letting Codex fall back to OpenAI. The fake codex records argv and env;
// the carry reads an in-memory config.toml and a recorded probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './helpers.js';
import { startCodexFixture as setup } from './codex-helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { createCodexCarry, TAKEOVER_TRANSLATED, CODEX_KEY_FILE, CODEX_TAKEOVER_KEY_FILE, KEY_NOT_KEPT } from '../../shared/codex-carry.cjs';

const HOME = '/home/fixture';
const KEY = 'plexlab-fake-key-0123456789abcdef';
const PLEXLAB = `model = "glm-5.3-flash"
model_provider = "plexlab"
[model_providers.plexlab]
name = "Plexlab"
base_url = "http://10.0.0.5:4001/v1"
wire_api = "responses"
env_key = "PLEXLAB_KEY"
`;
const posix = process.platform !== 'win32';

// keyViaAuthFile: true is (b), the target (the key in a run-dir file behind an auth command); false is (a), today's
// default (a key never reaches a run that has a shell). Background runs with a key use (b) here; (a) has its own tests.
function carry(text, { env = { PLEXLAB_KEY: KEY }, probeOk = true, keyViaAuthFile = true } = {}) {
  return createCodexCarry({
    env, home: HOME, platform: 'linux', keyViaAuthFile,
    readFile: (f) => (f === `${HOME}/.codex/config.toml` ? text : null),
    probe: async () => probeOk, burstOwnsPort: async () => false,
  });
}
const getTask = (h, id) => h.client.getTask(id);

const authArg = (argv) => argv.find((a) => a.startsWith('model_providers.plexlab.auth='));
const keyFileOf = (argv, id = 'plexlab') => JSON.parse(argv.find((a) => a.startsWith(`model_providers.${id}.auth=`)).match(/args=(\[[^\]]*\])/)[1])[0];

test('A8 regression, (b): a Codex Tasks run uses model_provider="plexlab" and the user\'s model; the key is only in a run-dir file behind an auth command', { skip: !posix }, async () => {
  const h = await setup({ text: 'ok' }, { codexCarry: carry(PLEXLAB) });
  try {
    const { id } = await h.client.createTask({ text: 'Say ok', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.state === 'in_review');
    const start = h.log().find((x) => x.kind === 'start');
    const c = (v) => start.argv[start.argv.indexOf(v) - 1] === '-c';
    assert.ok(c('model_provider="plexlab"'), 'the provider is set, so Codex never falls back to OpenAI');
    assert.ok(c('model_providers.plexlab.base_url="http://10.0.0.5:4001/v1"'));
    assert.equal(start.argv[start.argv.indexOf('--model') + 1], 'glm-5.3-flash');
    assert.ok(start.argv.includes('--ignore-user-config'), 'the user config.toml stays ignored: only the allowlisted provider is carried');
    assert.ok(!start.argv.some((a) => a.startsWith('model_providers.plexlab.env_key=')), 'env_key gives way to the auth command');
    const file = keyFileOf(start.argv);
    assert.equal(authArg(start.argv), `model_providers.plexlab.auth={command="/bin/cat",args=[${JSON.stringify(file)}],timeout_ms=5000}`);
    assert.equal(path.basename(file), CODEX_KEY_FILE);
    assert.ok(file.startsWith(fs.realpathSync(h.dataDir)) || file.startsWith(h.dataDir), 'in the run dir, under the denied data dir');
    assert.equal(start.env.PLEXLAB_KEY, undefined, 'not in the CLI env, so not in /proc/<codex>/environ');
    assert.ok(!start.argv.some((a) => a.includes(KEY)), 'no key on argv');
    assert.equal(fs.existsSync(file), false, 'deleted at run end');
  } finally { await h.cleanup(); }
});

test('(b): the key file is 0600 while the run lives, its run dir is denied to tool shells, and it goes at run end', { skip: !posix }, async () => {
  const h = await setup({ wait: true }, { codexCarry: carry(PLEXLAB) });
  try {
    const { id } = await h.client.createTask({ text: 'Hold', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    const start = h.log().find((x) => x.kind === 'start');
    const file = keyFileOf(start.argv);
    assert.equal(fs.readFileSync(file, 'utf8'), KEY);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const fsTable = start.argv.find((a) => a.startsWith('permissions.plexiform.filesystem='));
    assert.ok(fsTable.includes(`${JSON.stringify(path.dirname(file))}="deny"`), 'the run dir is denied');
    await h.client.act(id, 'stop');
    await waitFor(() => !fs.existsSync(file));
  } finally { await h.cleanup(); }
});

test('(a), today\'s default: a provider with a key parks auth on a Tasks run, before Codex starts; one with no key is carried', { skip: !posix }, async () => {
  const h = await setup({ text: 'ok' }, { codexCarry: carry(PLEXLAB, { keyViaAuthFile: false }) });
  try {
    const { id } = await h.client.createTask({ text: 'Say ok', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    const d = await waitFor(async () => { const x = await getTask(h, id); return x.state === 'parked' ? x : null; });
    assert.equal(d.parkReason, 'auth');
    assert.equal(d.openAsk.text.includes(KEY_NOT_KEPT) || d.openAsk.text.includes("can't be kept from Codex's commands"), true);
    assert.equal(h.log().filter((x) => x.kind === 'start').length, 0);
  } finally { await h.cleanup(); }
  const nokey = `model_provider = "local"\n[model_providers.local]\nbase_url = "http://127.0.0.1:4001/v1"\nwire_api = "responses"\n`;
  const g = await setup({ text: 'ok' }, { codexCarry: carry(nokey, { env: {}, keyViaAuthFile: false }) });
  try {
    const { id } = await g.client.createTask({ text: 'Say ok', cwd: g.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => g.task(id)?.state === 'in_review');
    const start = g.log().find((x) => x.kind === 'start');
    assert.equal(start.argv[start.argv.indexOf('model_provider="local"') - 1], '-c', 'a provider with no secret is carried everywhere');
  } finally { await g.cleanup(); }
});

test('(b): a provider with header values from variables still parks auth on a run with a shell', { skip: !posix }, async () => {
  const hdr = `${PLEXLAB}[model_providers.plexlab.env_http_headers]\n"X-Org" = "PLEXLAB_ORG"\n`;
  const h = await setup({ text: 'ok' }, { codexCarry: carry(hdr, { env: { PLEXLAB_KEY: KEY, PLEXLAB_ORG: 'org-1' } }) });
  try {
    const { id } = await h.client.createTask({ text: 'Say ok', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    const d = await waitFor(async () => { const x = await getTask(h, id); return x.state === 'parked' ? x : null; });
    assert.equal(d.parkReason, 'auth');
    assert.match(d.openAsk.text, /header values/);
  } finally { await h.cleanup(); }
});

test('C4: the Codex takeover reads the key from codex-takeover.key (denied, 0600) until handback; no key in its argv or env', { skip: !posix }, async () => {
  const h = await setup({ wait: true, waitFirstOnly: true }, { codexCarry: carry(PLEXLAB) });
  try {
    const { id } = await h.client.createTask({ text: 'Take this over', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    const r = await h.client.act(id, 'takeover', { mode: 'print' });
    const argv = r.takeover.argv;
    assert.equal(argv[argv.indexOf('model_provider="plexlab"') - 1], '-c');
    assert.ok(!argv.some((a) => a.startsWith('model_providers.plexlab.env_key=')));
    const file = keyFileOf(argv);
    assert.equal(path.basename(file), CODEX_TAKEOVER_KEY_FILE);
    assert.equal(fs.readFileSync(file, 'utf8'), KEY);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.ok(argv.find((a) => a.startsWith('permissions.plexiform.filesystem=')).includes(`${JSON.stringify(path.dirname(file))}="deny"`), 'the takeover denies the key dir');
    assert.equal(argv[argv.indexOf('--model') + 1], 'glm-5.3-flash');
    assert.ok(!JSON.stringify(r.takeover).includes(KEY), 'no key in the takeover argv or env');
    assert.ok(!('PLEXLAB_KEY' in r.takeover.env));
    await h.client.act(id, 'handback', {});
    assert.equal(fs.existsSync(file), false, 'gone at handback');
  } finally { await h.cleanup(); }
});

test('a provider whose key is written in config.toml runs in the background and takes over through the key file', { skip: !posix }, async () => {
  const inline = `model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.example.test/v1"\nexperimental_bearer_token = "${KEY}"\n`;
  const h = await setup({ wait: true, waitFirstOnly: true }, { codexCarry: carry(inline, { env: {} }) });
  try {
    const { id } = await h.client.createTask({ text: 'Take this over', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    const start = h.log().find((x) => x.kind === 'start');
    assert.equal(start.env.PLEXIFORM_PROVIDER_KEY, undefined, '(b): not in the CLI env');
    const auth = start.argv.find((a) => a.startsWith('model_providers.gw.auth='));
    assert.ok(auth);
    assert.equal(fs.readFileSync(keyFileOf(start.argv, 'gw'), 'utf8'), KEY, 'the background run reads it from the key file');
    assert.ok(!start.argv.some((a) => a.includes(KEY)));
    assert.ok(!start.argv.some((a) => a.startsWith('model_providers.gw.env_key=') || a.startsWith('model_providers.gw.experimental_bearer_token=')), 'auth replaces them');
    const r = await h.client.act(id, 'takeover', { mode: 'print' });
    assert.equal(fs.readFileSync(keyFileOf(r.takeover.argv, 'gw'), 'utf8'), KEY);
    assert.ok(!JSON.stringify(r.takeover).includes(KEY));
  } finally { await h.cleanup(); }
});

test('C2: an env_key value Plexiform cannot see parks the task as auth, naming the variable; Codex never starts', { skip: !posix }, async () => {
  const h = await setup({ text: 'ok' }, { codexCarry: carry(PLEXLAB, { env: {} }) });
  try {
    const { id } = await h.client.createTask({ text: 'Say ok', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    const d = await waitFor(async () => { const x = await getTask(h, id); return x.state === 'parked' ? x : null; });
    assert.equal(d.parkReason, 'auth');
    assert.match(d.openAsk.text, /\$PLEXLAB_KEY/);
    assert.equal(h.log().filter((x) => x.kind === 'start').length, 0);
  } finally { await h.cleanup(); }
});

test('a provider gateway that does not answer fails with failKind provider, naming the host; Codex never starts', { skip: !posix }, async () => {
  const h = await setup({ text: 'ok' }, { codexCarry: carry(PLEXLAB, { probeOk: false }) });
  try {
    const { id } = await h.client.createTask({ text: 'Say ok', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    const d = await waitFor(async () => { const x = await getTask(h, id); return x.state === 'failed' ? x : null; });
    assert.equal(d.failKind, 'provider');
    assert.equal(d.reason, "the gateway at 10.0.0.5:4001 isn't answering");
    assert.equal(h.log().filter((x) => x.kind === 'start').length, 0);
  } finally { await h.cleanup(); }
});

test('no config.toml: the run is today\'s (no provider -c values)', { skip: !posix }, async () => {
  const h = await setup({ text: 'ok' }, { codexCarry: carry(null) });
  try {
    const { id } = await h.client.createTask({ text: 'Say ok', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.state === 'in_review');
    const start = h.log().find((x) => x.kind === 'start');
    assert.ok(!start.argv.some((a) => a.startsWith('model_provider')));
  } finally { await h.cleanup(); }
});

// Review round 1, item 1: a takeover reads the provider fresh, never from a background run's cache. `live` is a
// config.toml and env the test can change between steps.
function liveCarry(live) {
  return createCodexCarry({
    env: live.env, home: HOME, platform: 'linux', keyViaAuthFile: true,
    // live.noTakeoverFile: the takeover's key file can't be written, so the takeover falls back to (a).
    writeKey: (file, value) => {
      if (live.noTakeoverFile && path.basename(file) === CODEX_TAKEOVER_KEY_FILE) throw new Error('EACCES');
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, value, { mode: 0o600 });
    },
    readFile: (f) => (f === `${HOME}/.codex/config.toml` ? live.text : null),
    probe: async () => true, burstOwnsPort: async () => false,
  });
}
const INLINE = `model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.example.test/v1"\nexperimental_bearer_token = "${KEY}"\n`;
const carriesPlexlab = (argv) => argv[argv.indexOf('model_provider="plexlab"') - 1] === '-c' && argv.some((a) => a.startsWith('model_providers.plexlab.auth={command="/bin/cat"') || a === 'model_providers.plexlab.env_key="PLEXLAB_KEY"');

test('takeover of a task that never ran in the background carries the provider (no cached carry to read)', { skip: !posix }, async () => {
  const live = { text: PLEXLAB, env: {} };
  const h = await setup({ text: 'ok' }, { codexCarry: liveCarry(live) });
  try {
    const { id } = await h.client.createTask({ text: 'Take this over', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(async () => (await getTask(h, id)).state === 'parked');
    assert.equal(h.log().filter((x) => x.kind === 'start').length, 0, 'Codex never ran');
    await assert.rejects(h.client.act(id, 'takeover', { mode: 'print' }), (e) => /\$PLEXLAB_KEY/.test(e.message), 'a failed check refuses, never OpenAI');
    assert.equal((await getTask(h, id)).state, 'parked', 'a refused takeover leaves the task where it was');
    live.env.PLEXLAB_KEY = KEY;
    const r = await h.client.act(id, 'takeover', { mode: 'print' });
    assert.ok(carriesPlexlab(r.takeover.argv), 'model_provider="plexlab" on the takeover command');
    assert.equal(r.takeover.argv[r.takeover.argv.indexOf('--model') + 1], 'glm-5.3-flash');
    assert.ok(!JSON.stringify(r.takeover).includes(KEY));
  } finally { await h.cleanup(); }
});

test('takeover after an engine restart carries the provider; with no key file, a key written in config.toml is refused', { skip: !posix }, async () => {
  const live = { text: PLEXLAB, env: { PLEXLAB_KEY: KEY } };
  const h = await setup({ wait: true, waitFirstOnly: true }, { codexCarry: liveCarry(live) });
  try {
    const { id } = await h.client.createTask({ text: 'Take this over', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    await h.restart();
    live.text = INLINE;
    live.noTakeoverFile = true;
    await assert.rejects(h.client.act(id, 'takeover', { mode: 'print' }), (e) => e.message === TAKEOVER_TRANSLATED);
    live.noTakeoverFile = false;
    live.text = PLEXLAB;
    const r = await h.client.act(id, 'takeover', { mode: 'print' });
    assert.ok(carriesPlexlab(r.takeover.argv));
  } finally { await h.cleanup(); }
});

test('takeover after the provider was set (or changed) since the last run uses the provider as it is now', { skip: !posix }, async () => {
  const live = { text: null, env: { PLEXLAB_KEY: KEY } };
  const h = await setup({ wait: true, waitFirstOnly: true }, { codexCarry: liveCarry(live) });
  try {
    const { id } = await h.client.createTask({ text: 'Take this over', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    assert.ok(!h.log().find((x) => x.kind === 'start').argv.some((a) => a.startsWith('model_provider')), 'the run had no provider');
    live.text = PLEXLAB;
    const r = await h.client.act(id, 'takeover', { mode: 'print' });
    assert.ok(carriesPlexlab(r.takeover.argv), 'the provider set after the run is carried');
  } finally { await h.cleanup(); }
});

test('(a) fallback: with no takeover key file, a provider that became an inline key refuses the takeover and the run keeps running', { skip: !posix }, async () => {
  const live = { text: PLEXLAB, env: { PLEXLAB_KEY: KEY } };
  const h = await setup({ wait: true, waitFirstOnly: true }, { codexCarry: liveCarry(live) });
  try {
    const { id } = await h.client.createTask({ text: 'Take this over', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    live.text = INLINE;
    live.noTakeoverFile = true;
    await assert.rejects(h.client.act(id, 'takeover', { mode: 'print' }), (e) => e.message === TAKEOVER_TRANSLATED);
    assert.equal(h.task(id).state, 'running', 'checked before the run is stopped');
  } finally { await h.cleanup(); }
});

// Review item 4: a CODEX_HOME found only in the login shell is the run's and the takeover's, and is denied to tool shells.
test('a login-shell CODEX_HOME is the run\'s and the takeover\'s CODEX_HOME and is in the deny list', { skip: !posix }, async () => {
  const ALT = '/home/fixture/alt-codex';
  const c = createCodexCarry({
    env: { PLEXLAB_KEY: KEY }, home: HOME, platform: 'linux', keyViaAuthFile: true,
    loginShellEnv: async ({ names }) => (names.includes('CODEX_HOME') ? { CODEX_HOME: ALT } : {}),
    readFile: (f) => (f === `${ALT}/config.toml` ? PLEXLAB : null),
    probe: async () => true, burstOwnsPort: async () => false,
  });
  const h = await setup({ wait: true, waitFirstOnly: true }, { codexCarry: c });
  try {
    const { id } = await h.client.createTask({ text: 'Take this over', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    const start = h.log().find((x) => x.kind === 'start');
    assert.equal(start.env.CODEX_HOME, ALT);
    assert.equal(start.argv[start.argv.indexOf('model_provider="plexlab"') - 1], '-c', 'the provider came from the login-shell CODEX_HOME');
    assert.ok(start.argv.find((a) => a.startsWith('permissions.plexiform.filesystem=')).includes(`"${ALT}"="deny"`));
    const r = await h.client.act(id, 'takeover', { mode: 'print' });
    assert.equal(r.takeover.env.CODEX_HOME, ALT);
    assert.ok(r.takeover.argv.find((a) => a.startsWith('permissions.plexiform.filesystem=')).includes(`"${ALT}"="deny"`));
  } finally { await h.cleanup(); }
});

// Lab shape (codex-auth-command.md, gotcha 1): a key command that can't start shows on --json only as "Reconnecting…
// high demand" then turn.failed; the cause is one stderr line. It must park auth with a fixed reason, not fail as "error".
const AUTH_STDERR = 'Failed to resolve external auth: provider auth command `/bin/cat` failed to start: Permission denied (os error 13)\n';
const HIGH_DEMAND = "We're currently experiencing high demand, which may cause temporary errors.";
test('an auth command that cannot start (recorded stderr shape) parks auth, not "high demand"', { skip: !posix }, async () => {
  const h = await setup({ stderr: AUTH_STDERR, events: [1, 2, 3, 4, 5].map((n) => ({ type: 'error', message: `Reconnecting... ${n}/5 (${HIGH_DEMAND})` })), error: HIGH_DEMAND }, { codexCarry: carry(PLEXLAB) });
  try {
    const { id } = await h.client.createTask({ text: 'Say ok', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    const d = await waitFor(async () => { const x = await getTask(h, id); return ['parked', 'failed'].includes(x.state) ? x : null; });
    assert.equal(d.state, 'parked');
    assert.equal(d.parkReason, 'auth');
    assert.ok(!JSON.stringify(d).includes('/bin/cat') && !JSON.stringify(d).includes('os error'), 'no stderr text is kept');
  } finally { await h.cleanup(); }
  // The same failure without that stderr line stays an ordinary error.
  const g = await setup({ error: HIGH_DEMAND }, { codexCarry: carry(PLEXLAB) });
  try {
    const { id } = await g.client.createTask({ text: 'Say ok', cwd: g.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    const d = await waitFor(async () => { const x = await getTask(g, id); return ['parked', 'failed'].includes(x.state) ? x : null; });
    assert.notEqual(d.parkReason, 'auth');
  } finally { await g.cleanup(); }
});

test('(b) with a key file that cannot be written falls back to (a): the Tasks run parks auth and Codex never starts', { skip: !posix }, async () => {
  const c = createCodexCarry({ env: { PLEXLAB_KEY: KEY }, home: HOME, platform: 'linux', readFile: (f) => (f === `${HOME}/.codex/config.toml` ? PLEXLAB : null), probe: async () => true, burstOwnsPort: async () => false, writeKey: () => { throw new Error('EROFS'); } });
  const h = await setup({ text: 'ok' }, { codexCarry: c });
  try {
    const { id } = await h.client.createTask({ text: 'Say ok', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    const d = await waitFor(async () => { const x = await getTask(h, id); return x.state === 'parked' ? x : null; });
    assert.equal(d.parkReason, 'auth');
    assert.equal(h.log().filter((x) => x.kind === 'start').length, 0);
  } finally { await h.cleanup(); }
});
