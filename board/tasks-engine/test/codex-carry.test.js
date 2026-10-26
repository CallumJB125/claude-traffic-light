// PR 3 (lab finding A8): Codex Tasks runs and takeovers carry the user's own Codex provider, and a failed
// provider preflight fails loud instead of letting Codex fall back to OpenAI. The fake codex records argv and env;
// the carry reads an in-memory config.toml and a recorded probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './helpers.js';
import { startCodexFixture as setup } from './codex-helpers.js';
import { createCodexCarry, TAKEOVER_TRANSLATED } from '../../shared/codex-carry.cjs';

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

function carry(text, { env = { PLEXLAB_KEY: KEY }, probeOk = true } = {}) {
  return createCodexCarry({
    env, home: HOME, platform: 'linux',
    readFile: (f) => (f === `${HOME}/.codex/config.toml` ? text : null),
    probe: async () => probeOk, burstOwnsPort: async () => false,
  });
}
const getTask = (h, id) => h.client.getTask(id);

test('A8 regression: a Codex Tasks run uses model_provider="plexlab", the user\'s model, and the key only in the CLI env', { skip: !posix }, async () => {
  const h = await setup({ text: 'ok' }, { codexCarry: carry(PLEXLAB) });
  try {
    const { id } = await h.client.createTask({ text: 'Say ok', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.state === 'in_review');
    const start = h.log().find((x) => x.kind === 'start');
    const c = (v) => start.argv[start.argv.indexOf(v) - 1] === '-c';
    assert.ok(c('model_provider="plexlab"'), 'the provider is set, so Codex never falls back to OpenAI');
    assert.ok(c('model_providers.plexlab.base_url="http://10.0.0.5:4001/v1"'));
    assert.ok(c('model_providers.plexlab.env_key="PLEXLAB_KEY"'));
    assert.equal(start.argv[start.argv.indexOf('--model') + 1], 'glm-5.3-flash');
    assert.ok(start.argv.includes('--ignore-user-config'), 'the user config.toml stays ignored: only the allowlisted provider is carried');
    assert.equal(start.env.PLEXLAB_KEY, KEY);
    assert.ok(!start.argv.some((a) => a.includes(KEY)), 'no key on argv');
    const set = start.argv.find((a) => a.startsWith('shell_environment_policy.set='));
    assert.ok(!set.includes('PLEXLAB_KEY'), 'the tool shell env never names it');
  } finally { await h.cleanup(); }
});

test('C4: the Codex takeover argv carries the provider -c values; the takeover env carries no key', { skip: !posix }, async () => {
  const h = await setup({ wait: true, waitFirstOnly: true }, { codexCarry: carry(PLEXLAB) });
  try {
    const { id } = await h.client.createTask({ text: 'Take this over', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    const r = await h.client.act(id, 'takeover', { mode: 'print' });
    const argv = r.takeover.argv;
    assert.equal(argv[argv.indexOf('model_provider="plexlab"') - 1], '-c');
    assert.ok(argv.includes('model_providers.plexlab.env_key="PLEXLAB_KEY"'));
    assert.equal(argv[argv.indexOf('--model') + 1], 'glm-5.3-flash');
    assert.ok(!JSON.stringify(r.takeover).includes(KEY), 'no key in the takeover argv or env');
    assert.ok(!('PLEXLAB_KEY' in r.takeover.env));
  } finally { await h.cleanup(); }
});

test('a provider whose key is written in config.toml can run in the background but refuses a terminal takeover', { skip: !posix }, async () => {
  const inline = `model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.example.test/v1"\nexperimental_bearer_token = "${KEY}"\n`;
  const h = await setup({ wait: true, waitFirstOnly: true }, { codexCarry: carry(inline, { env: {} }) });
  try {
    const { id } = await h.client.createTask({ text: 'Take this over', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    const start = h.log().find((x) => x.kind === 'start');
    assert.equal(start.env.PLEXIFORM_PROVIDER_KEY, KEY, 'the background run gets it in the CLI env');
    assert.ok(!start.argv.some((a) => a.includes(KEY)));
    await assert.rejects(h.client.act(id, 'takeover', { mode: 'print' }), (e) => e.message === TAKEOVER_TRANSLATED);
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
    env: live.env, home: HOME, platform: 'linux',
    readFile: (f) => (f === `${HOME}/.codex/config.toml` ? live.text : null),
    probe: async () => true, burstOwnsPort: async () => false,
  });
}
const INLINE = `model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.example.test/v1"\nexperimental_bearer_token = "${KEY}"\n`;
const carriesPlexlab = (argv) => argv[argv.indexOf('model_provider="plexlab"') - 1] === '-c' && argv.includes('model_providers.plexlab.env_key="PLEXLAB_KEY"');

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

test('takeover after an engine restart carries the provider, and refuses a key written in config.toml', { skip: !posix }, async () => {
  const live = { text: PLEXLAB, env: { PLEXLAB_KEY: KEY } };
  const h = await setup({ wait: true, waitFirstOnly: true }, { codexCarry: liveCarry(live) });
  try {
    const { id } = await h.client.createTask({ text: 'Take this over', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    await h.restart();
    live.text = INLINE;
    await assert.rejects(h.client.act(id, 'takeover', { mode: 'print' }), (e) => e.message === TAKEOVER_TRANSLATED);
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

test('a run whose provider became an inline key since it started refuses the takeover and keeps running', { skip: !posix }, async () => {
  const live = { text: PLEXLAB, env: { PLEXLAB_KEY: KEY } };
  const h = await setup({ wait: true, waitFirstOnly: true }, { codexCarry: liveCarry(live) });
  try {
    const { id } = await h.client.createTask({ text: 'Take this over', cwd: h.repo.checkout, ai: 'codex', permissionLevel: 'auto-edits' });
    await waitFor(() => h.task(id)?.sessionStarted && h.task(id).state === 'running');
    live.text = INLINE;
    await assert.rejects(h.client.act(id, 'takeover', { mode: 'print' }), (e) => e.message === TAKEOVER_TRANSLATED);
    assert.equal(h.task(id).state, 'running', 'checked before the run is stopped');
  } finally { await h.cleanup(); }
});
