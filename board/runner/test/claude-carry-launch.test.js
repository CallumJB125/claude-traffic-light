// Board runs carry the user's own Claude provider (lab T3): the exact argv, the one run settings file, and
// where the key lives. The fake claude records its argv and env; nothing real runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, readFakeLog, waitFor } from './helpers.js';
import { fixtureCarry, CFG, KEY, settingsFile } from '../../shared/test-support/claude-carry-fixture.js';

const gateway = { ANTHROPIC_BASE_URL: 'https://gw.example/v1', ANTHROPIC_MODEL: 'glm-5.3-flash' };
const posix = process.platform !== 'win32';

async function rig(files, env = {}) {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const { carry } = fixtureCarry({ files, env });
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, scenario: { steps: [{ tool: 'Read', input: { file_path: 'README.md' } }, { result: 'success' }] }, opts: { claudeCarry: carry } });
  return { root, hub, sup, home: path.join(root, 'home'), async close() { await sup.shutdown(); await hub.close(); rm(root); } };
}

test('board runner: one --settings file with routing env and /bin/cat api.key; the isolation flags stay; the key is nowhere else', { skip: !posix }, async () => {
  const r = await rig({ [`${CFG}/settings.json`]: settingsFile({ model: 'glm-5.3-flash', env: { ...gateway, ANTHROPIC_AUTH_TOKEN: KEY } }) });
  try {
    const run = await claimRun(r.sup, r.hub, offerFor());
    const start = await waitFor(() => readFakeLog(run.runDir).find((e) => e.ev === 'start'), { what: 'fake start' });
    const argv = start.argv;
    const at = (f) => argv[argv.indexOf(f) + 1];
    assert.equal(argv.filter((a) => a === '--settings').length, 1, 'only the last --settings counts, so exactly one');
    assert.equal(at('--settings'), path.join(run.runDir, 'settings.json'));
    assert.equal(at('--setting-sources'), '');
    assert.ok(argv.includes('--strict-mcp-config'));
    assert.equal(at('--model'), 'glm-5.3-flash', 'the person\'s own model when the repo sets none');
    const settings = JSON.parse(fs.readFileSync(path.join(run.runDir, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.env, gateway, 'routing only');
    assert.equal(settings.apiKeyHelper, `/bin/cat '${path.join(run.runDir, 'api.key')}'`);
    assert.equal(fs.readFileSync(path.join(run.runDir, 'api.key'), 'utf8'), KEY);
    assert.equal(fs.statSync(path.join(run.runDir, 'api.key')).mode & 0o777, 0o600);
    // D26: no secret reachable from a tool shell.
    for (const where of [JSON.stringify(argv), JSON.stringify(start.env), JSON.stringify(settings)]) assert.ok(!where.includes(KEY));
    assert.ok(!('ANTHROPIC_API_KEY' in start.env) && !('ANTHROPIC_AUTH_TOKEN' in start.env));
    // The key file sits in <board home>/run/<id>: sandbox-denied (boardHomeRules) and refused to the file tools.
    assert.ok(path.join(run.runDir, 'api.key').startsWith(path.join(r.home, 'run') + path.sep));
    for (const need of [`${r.home}/run`, '~/.config/gcloud', '~/.azure']) assert.ok(settings.sandbox.filesystem.denyRead.includes(need), need);
    for (const tool of ['Read', 'Edit', 'Write']) assert.ok(argv.includes(`${tool}(/${r.home}/run/**)`), `${tool} on run/**`);
    assert.ok(argv.includes('Read(~/.config/gcloud/**)') && argv.includes('Read(~/.azure/**)'));
    r.sup.cleanupRun(run);
    assert.equal(fs.existsSync(path.join(run.runDir, 'api.key')), false, 'deleted at run end');
  } finally { await r.close(); }
});

test('board runner: a custom CLAUDE_CONFIG_DIR reaches the CLI and is denied to the agent; a carried credentials file is too', { skip: !posix }, async () => {
  const cfg = '/fx/work/claude-cfg';
  const r = await rig({ [`${cfg}/settings.json`]: settingsFile({ env: { ...gateway, CLAUDE_CODE_USE_BEDROCK: '1', AWS_SHARED_CREDENTIALS_FILE: '/fx/aws/creds' } }) }, { CLAUDE_CONFIG_DIR: cfg });
  try {
    const run = await claimRun(r.sup, r.hub, offerFor());
    const start = await waitFor(() => readFakeLog(run.runDir).find((e) => e.ev === 'start'), { what: 'fake start' });
    assert.equal(start.env.CLAUDE_CONFIG_DIR, cfg);
    const settings = JSON.parse(fs.readFileSync(path.join(run.runDir, 'settings.json'), 'utf8'));
    assert.equal(settings.env.AWS_SHARED_CREDENTIALS_FILE, '/fx/aws/creds');
    for (const p of [cfg, '/fx/aws/creds']) {
      assert.ok(settings.sandbox.filesystem.denyRead.includes(p), p);
      assert.ok(start.argv.includes(`Read(/${p})`), `Read rule for ${p}`);
    }
    assert.equal(fs.existsSync(path.join(run.runDir, 'api.key')), false, 'no key, no key file');
  } finally { await r.close(); }
});

test('board runner: a failed preflight never starts the CLI; the reason is prep.failed\'s cause', { skip: !posix }, async () => {
  const r = await rig({ [`${CFG}/settings.json`]: settingsFile({ env: { AWS_BEARER_TOKEN_BEDROCK: 'ABSK-fixture', CLAUDE_CODE_USE_BEDROCK: '1' } }) });
  try {
    r.hub.send(offerFor());
    const failed = await waitFor(() => r.hub.outs('prep.failed')[0], { what: 'prep.failed' });
    assert.equal(failed.cause, 'spawn: Claude provider check failed on this machine', 'the hub gets a fixed sentence (review 5); the detail stays in the local log');
    assert.ok(!JSON.stringify(failed).includes('ABSK-fixture'));
  } finally { await r.close(); }
});

test('board runner start sweeps an api.key left by a crash (review 3)', { skip: !posix }, async () => {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const home = path.join(root, 'home');
  const stale = path.join(home, 'run', 'old-run');
  fs.mkdirSync(stale, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stale, 'api.key'), KEY, { mode: 0o600 });
  fs.writeFileSync(path.join(stale, 'mcp.json'), '{}');
  const sup = await startRunner({ hub, home, repo, scenario: { steps: [{ result: 'success' }] }, opts: { claudeCarry: fixtureCarry({ files: {} }).carry } });
  try {
    assert.deepEqual(fs.readdirSync(stale), ['mcp.json']);
  } finally { await sup.shutdown(); await hub.close(); rm(root); }
});
