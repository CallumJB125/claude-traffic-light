// Tasks runs, takeovers and failed preflights carry the user's own Claude provider (lab T3).
// The fake claude records argv, env and the run's settings.json; the carry reads an in-memory file system.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startEngine, makeRepo, waitFor, fakeLog, rm, tmpDir, writePolicy } from './helpers.js';
import { startMock, waitFor as mockWait } from '../../tasks-api/test/helpers.js';
import { fixtureCarry, CFG, KEY, settingsFile } from '../../shared/test-support/claude-carry-fixture.js';

const gateway = { ANTHROPIC_BASE_URL: 'https://gw.example/v1', ANTHROPIC_MODEL: 'glm-5.3-flash' };
const posix = process.platform !== 'win32';
const user = (o) => ({ [`${CFG}/settings.json`]: settingsFile(o) });

async function withCarry(files, fn, { scenario } = {}) {
  const dir = tmpDir();
  const repo = makeRepo(dir);
  const fx = fixtureCarry({ files });
  const m = await startEngine({ scenario: scenario ?? { steps: [{ result: 'success' }] }, dir, engineOpts: { claudeCarry: fx.carry } });
  writePolicy(m.dataDir, { repos: { [repo.checkout]: { remote_tasks: true } } });
  try { await fn({ ...m, repo, fx, spec: { text: 'Fix the README', cwd: repo.checkout } }); } finally { await m.close().catch(() => {}); rm(dir); }
}
const stateOf = async (c, id) => (await c.getTask(id)).state;

test('engine run: one settings file (routing env + /bin/cat api.key), the person\'s model, no secret in argv or env, api.key under the denied data dir and deleted at run end', { skip: !posix }, () => withCarry(
  user({ model: 'glm-5.3-flash', env: { ...gateway, ANTHROPIC_AUTH_TOKEN: KEY } }),
  async (m) => {
    const { id } = await m.client.createTask(m.spec);
    await waitFor(async () => (await stateOf(m.client, id)) === 'in_review', { label: 'in_review' });
    const runDir = path.join(m.dataDir, 'run', id);
    const start = fakeLog(runDir).find((l) => l.ev === 'start');
    const at = (f) => start.argv[start.argv.indexOf(f) + 1];
    assert.equal(start.argv.filter((a) => a === '--settings').length, 1);
    assert.equal(at('--setting-sources'), '');
    assert.equal(at('--model'), 'glm-5.3-flash');
    const settings = JSON.parse(fs.readFileSync(path.join(runDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.env, gateway);
    assert.equal(settings.apiKeyHelper, `/bin/cat '${path.join(runDir, 'api.key')}'`);
    const dataReal = fs.realpathSync(m.dataDir);
    assert.ok(settings.sandbox.filesystem.denyRead.includes(dataReal), 'the run dir is under a sandbox-denied path');
    for (const tool of ['Read', 'Edit', 'Write']) assert.ok(start.argv.includes(`${tool}(/${dataReal}/**)`), `${tool} refused on the data dir`);
    const dataAsGiven = path.resolve(m.dataDir);
    for (const tool of ['Read', 'Edit', 'Write']) assert.ok(start.argv.includes(`${tool}(/${dataAsGiven}/**)`), `${tool} refused on the data dir as given too (review 11)`);
    assert.ok(settings.sandbox.filesystem.denyRead.includes(dataAsGiven));
    for (const k of ['~/.config/gcloud', '~/.azure']) assert.ok(settings.sandbox.filesystem.denyRead.includes(k));
    for (const r of ['Read(//proc/**)', 'Read(/proc/**)']) assert.ok(settings.permissions.deny.includes(r) && start.argv.includes(r), `${r} in the settings file and the argv`);
    for (const where of [JSON.stringify(start.argv), JSON.stringify(start.env), JSON.stringify(settings)]) assert.ok(!where.includes(KEY));
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in start.env) && !('ANTHROPIC_API_KEY' in start.env));
    assert.equal(fs.existsSync(path.join(runDir, 'api.key')), false, 'the run ended: the key file is gone');
  },
));

test('engine takeover: the same one settings file, the person\'s model and the deny rules; the key file lives until handback', { skip: !posix }, () => withCarry(
  user({ model: 'glm-5.3-flash', env: { ...gateway, ANTHROPIC_AUTH_TOKEN: KEY } }),
  async (m) => {
    const { id } = await m.client.createTask(m.spec);
    await waitFor(async () => (await stateOf(m.client, id)) === 'running', { label: 'running' });
    const r = await m.client.act(id, 'takeover', { mode: 'print' });
    const t = r.takeover;
    const runDir = path.join(m.dataDir, 'run', id);
    const at = (f) => t.argv[t.argv.indexOf(f) + 1];
    assert.equal(t.argv.filter((a) => a === '--settings').length, 1);
    assert.equal(at('--settings'), path.join(runDir, 'settings.json'));
    assert.equal(at('--setting-sources'), '');
    assert.equal(at('--model'), 'glm-5.3-flash');
    const dataReal = fs.realpathSync(m.dataDir);
    for (const tool of ['Read', 'Edit', 'Write']) assert.ok(t.argv.includes(`${tool}(/${dataReal}/**)`));
    assert.ok(t.argv.includes('Read(~/.config/gcloud/**)') && t.argv.includes('Read(~/.azure/**)'));
    for (const r of ['Read(//proc/**)', 'Read(/proc/**)']) assert.ok(t.argv.includes(r), `${r} in the takeover argv`);
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in t.env) && !('ANTHROPIC_API_KEY' in t.env));
    assert.ok(!JSON.stringify(t).includes(KEY), 'no key in the takeover argv or env');
    const settings = JSON.parse(fs.readFileSync(path.join(runDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.env, gateway);
    assert.equal(fs.readFileSync(path.join(runDir, 'api.key'), 'utf8'), KEY, 'the terminal session authenticates through the same file');
    assert.ok(settings.sandbox.filesystem.denyRead.includes(dataReal));
    await m.client.act(id, 'handback', {});
    await waitFor(async () => (await stateOf(m.client, id)) === 'in_review', { label: 'in_review after handback' });
    assert.equal(fs.existsSync(path.join(runDir, 'api.key')), false, 'the run ended again: the key file is gone');
  },
  { scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 1' }, ms: 60000 }], resume_steps: [{ result: 'success', text: 'back' }] } },
));

test('engine: a refused secret fails the task with failKind provider and a move-it-to reason, and the CLI never starts', { skip: !posix }, () => withCarry(
  user({ env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: 'ABSK-fixture-token' } }),
  async (m) => {
    const { id } = await m.client.createTask(m.spec);
    const d = await waitFor(async () => { const x = await m.client.getTask(id); return x.state === 'failed' ? x : null; }, { label: 'failed' });
    assert.equal(d.failKind, 'provider');
    assert.match(d.reason, /AWS profile/);
    assert.ok(!JSON.stringify(d).includes('ABSK-fixture-token'));
    assert.equal(fakeLog(path.join(m.dataDir, 'run', id)).length, 0);
  },
));

test('engine: a key helper that needs a sign-in parks the task as auth with that reason', { skip: !posix }, async () => {
  const dir = tmpDir();
  const repo = makeRepo(dir);
  const SIGN_IN = 'your key helper needs you to sign in; run it once in a terminal';
  const fx = fixtureCarry({ files: user({ apiKeyHelper: 'sso-login', env: gateway }), commands: { 'sso-login': { ok: false, timedOut: true, code: null, reason: SIGN_IN } } });
  const m = await startEngine({ dir, engineOpts: { claudeCarry: fx.carry } });
  writePolicy(m.dataDir, { repos: { [repo.checkout]: { remote_tasks: true } } });
  try {
    const { id } = await m.client.createTask({ text: 'Fix the README', cwd: repo.checkout });
    const d = await waitFor(async () => { const x = await m.client.getTask(id); return x.state === 'parked' ? x : null; }, { label: 'parked' });
    assert.equal(d.parkReason, 'auth');
    assert.equal(d.openAsk.kind, 'auth');
    assert.equal(d.openAsk.text, `${SIGN_IN}. Then resume.`);
    assert.equal(fakeLog(path.join(m.dataDir, 'run', id)).length, 0, 'the CLI never started');
  } finally { await m.close().catch(() => {}); rm(dir); }
});

test('engine: no carry (today\'s behaviour): the app env key still goes to api.key and nothing else changes', { skip: !posix }, async () => {
  const dir = tmpDir();
  const repo = makeRepo(dir);
  const m = await startEngine({ dir, engineOpts: { env: { ...(await import('./helpers.js')).ENV, ANTHROPIC_API_KEY: KEY } } });
  writePolicy(m.dataDir, { repos: { [repo.checkout]: { remote_tasks: true } } });
  try {
    const { id } = await m.client.createTask({ text: 'Fix the README', cwd: repo.checkout });
    await waitFor(async () => (await stateOf(m.client, id)) === 'in_review', { label: 'in_review' });
    const settings = JSON.parse(fs.readFileSync(path.join(m.dataDir, 'run', id, 'settings.json'), 'utf8'));
    assert.match(settings.apiKeyHelper, /api\.key/);
    const noCarryStart = fakeLog(path.join(m.dataDir, 'run', id)).find((l) => l.ev === 'start');
    for (const r of ['Read(//proc/**)', 'Read(/proc/**)']) assert.ok(settings.permissions.deny.includes(r) && noCarryStart.argv.includes(r), `${r} even with no carry`);
    assert.ok(!('env' in settings));
  } finally { await m.close().catch(() => {}); rm(dir); }
});

const flagsOf = (argv) => argv.filter((a) => /^--/.test(a)).filter((f) => f !== '--disallowedTools');

test('L1\': the dev mock\'s takeover argv keeps in step with the engine\'s (same isolation flags, same --model)', { skip: !posix }, async () => {
  let engineArgv;
  await withCarry(user({ model: 'glm-5.3-flash', env: gateway }), async (m) => {
    const { id } = await m.client.createTask(m.spec);
    await waitFor(async () => (await stateOf(m.client, id)) === 'running', { label: 'running' });
    engineArgv = (await m.client.act(id, 'takeover', { mode: 'print' })).takeover.argv;
  }, { scenario: { steps: [{ tool: 'Bash', input: { command: 'sleep 1' }, ms: 60000 }] } });
  const mock = await startMock({ carriedModel: 'glm-5.3-flash' });
  try {
    const t = await mock.client.createTask({ text: 'Fix the README', cwd: '/tmp/mock-repo' });
    await mockWait(async () => (await mock.client.getTask(t.id)).state === 'running', { label: 'mock running' });
    await mock.client.act(t.id, 'pause', {});
    const argv = (await mock.client.act(t.id, 'takeover', { mode: 'print' })).takeover.argv;
    assert.deepEqual(flagsOf(argv), flagsOf(engineArgv));
    assert.equal(argv[argv.indexOf('--model') + 1], engineArgv[engineArgv.indexOf('--model') + 1]);
    assert.equal(argv[argv.indexOf('--setting-sources') + 1], '');
  } finally { await mock.close(); }
});

test('engine start sweeps a key file left by a crash (review 3); other run files stay', { skip: !posix }, async () => {
  const dir = tmpDir();
  const stale = path.join(dir, 'data', 'run', 'tsk_old');
  fs.mkdirSync(stale, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stale, 'api.key'), KEY, { mode: 0o600 });
  fs.writeFileSync(path.join(stale, 'api.key.99.abc.tmp'), KEY, { mode: 0o600 });
  fs.writeFileSync(path.join(stale, 'settings.json'), '{}');
  const m = await startEngine({ dir, engineOpts: { claudeCarry: fixtureCarry({ files: user({ env: gateway }) }).carry } });
  try {
    assert.deepEqual(fs.readdirSync(stale), ['settings.json']);
  } finally { await m.close().catch(() => {}); rm(dir); }
});

test('R2-B: engine start keeps the key file of a handed_over task (a takeover outlives the engine) and sweeps the others', { skip: !posix }, async () => {
  const dir = tmpDir();
  const repo = makeRepo(dir);
  const fx = fixtureCarry({ files: user({ env: gateway }) });
  const m1 = await startEngine({ dir, engineOpts: { claudeCarry: fx.carry } });
  writePolicy(m1.dataDir, { repos: { [repo.checkout]: { remote_tasks: true } } });
  const { id } = await m1.client.createTask({ text: 'Fix the README', cwd: repo.checkout });
  await waitFor(async () => (await stateOf(m1.client, id)) === 'running', { label: 'running' });
  await m1.client.act(id, 'takeover', { mode: 'print' });
  const runDir = path.join(m1.dataDir, 'run', id);
  const other = path.join(m1.dataDir, 'run', 'tsk_stale');
  fs.mkdirSync(other, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runDir, 'api.key'), KEY, { mode: 0o600 });
  fs.writeFileSync(path.join(other, 'api.key'), KEY, { mode: 0o600 });
  await m1.close({ leaveRuns: true }).catch(() => {});
  const m2 = await startEngine({ dir, engineOpts: { claudeCarry: fx.carry } });
  try {
    assert.equal((await stateOf(m2.client, id)), 'handed_over');
    assert.equal(fs.readFileSync(path.join(runDir, 'api.key'), 'utf8'), KEY, 'the takeover keeps its key');
    assert.equal(fs.existsSync(path.join(other, 'api.key')), false, 'a stale one is swept');
  } finally { await m2.close().catch(() => {}); rm(dir); }
});
