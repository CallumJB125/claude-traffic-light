'use strict';
// Guard: no visual spec can reach a real provider CLI. Every finder the app uses to start claude, codex, gemini or an
// ACP agent must resolve below the HOME the spec runs under, to the fakes from test-visual/app.js, and the app's own
// PATH must find those fakes before any real install. Fails the run if a finder gains a system-only candidate order.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, expect } = require('@playwright/test');
const { launchApp, homeEnv, HOME_POINTERS, FAKE_PROVIDER_PATHS } = require('./app');

const ROOT = path.join(__dirname, '..');
const FINDERS = `
const C = require('./src/claude-code-session.js'), X = require('./src/codex-app-server.js'), G = require('./src/gemini-acp.js'), A = require('./src/acp-agents.js');
const out = { claude: C.findClaudeBin(), codex: X.findCodexBin(), gemini: G.findGeminiBin() };
for (const id of Object.keys(A.ACP_AGENTS)) out[id] = A.findAcpBin(id);
import('./board/runner/backends/detect.js').then(({ resolveBin }) => {
  // The Tasks runner's finder skips a binary that fails safeBinary and falls through to the next PATH entry.
  out.runner = {};
  for (const t of require('./src/ai-tools.js').TOOLS) for (const n of t.bins) out.runner[n] = resolveBin(n, process.env);
  process.stdout.write(JSON.stringify(out));
});`;
// resolveBin returns the realpath (/private/var/... for a /var/... temp dir), so compare real paths.
const real = (p) => { try { return require('node:fs').realpathSync(p); } catch { return p; } };
const under = (root, p) => !!p && real(p).startsWith(real(root) + path.sep);
const resolve = (env) => JSON.parse(execFileSync(process.execPath, ['-e', FINDERS], { cwd: ROOT, env, encoding: 'utf8' }));
// What a bare `name` resolves to on this PATH.
const onPath = (name, envPath) => String(envPath).split(path.delimiter).map((d) => path.join(d, name)).find((p) => { try { require('node:fs').accessSync(p, require('node:fs').constants.X_OK); return true; } catch { return false; } });

test('the run itself uses an empty HOME with the fake providers first', () => {
  const run = process.env.PLEXIFORM_VISUAL_RUN_HOME;
  expect(run).toBeTruthy();
  expect(process.env.HOME).toBe(run);
  expect(require('node:os').userInfo().homedir).not.toBe(run);
  for (const k of HOME_POINTERS) expect(process.env[k]).toBeUndefined();
  const found = resolve(process.env);
  const { runner, ...finders } = found;
  for (const [id, p] of Object.entries(finders)) expect(under(run, p), `${id} resolves to ${p}`).toBe(true);
  for (const [name, r] of Object.entries(runner)) expect(under(run, r.bin), `runner ${name}: ${JSON.stringify(r)}`).toBe(true);
  for (const name of Object.keys(FAKE_PROVIDER_PATHS)) expect(under(run, onPath(name, process.env.PATH)), `PATH ${name}`).toBe(true);
});

test('an app launched by launchApp finds only the fakes in its own HOME', async () => {
  // Starts a whole app: allow a second start (launchApp's one retry) and slow boots under load, so the guard itself is not the flaky part.
  test.setTimeout(120000);
  const h = await launchApp();
  try {
    const { runner, ...finders } = resolve(homeEnv(h.userHome));
    for (const [id, p] of Object.entries(finders)) expect(under(h.userHome, p), `${id} resolves to ${p}`).toBe(true);
    for (const [name, r] of Object.entries(runner)) expect(under(h.userHome, r.bin), `runner ${name}: ${JSON.stringify(r)}`).toBe(true);
    const env = await h.app.evaluate(() => ({ HOME: process.env.HOME, PATH: process.env.PATH }));
    expect(env.HOME).toBe(h.userHome);
    for (const name of Object.keys(FAKE_PROVIDER_PATHS)) expect(under(h.userHome, onPath(name, env.PATH)), `PATH ${name}`).toBe(true);
  } finally { await h.cleanup(); }
});

test('every tool the AI tools page probes has a fake, found first on PATH (so it never falls through to /opt/homebrew/bin)', () => {
  // The names come from the tool table in code, not from a list kept by hand here.
  const names = [...new Set(require('../src/ai-tools.js').TOOLS.flatMap((t) => t.bins))];
  expect(names.length).toBeGreaterThan(5);
  const run = process.env.PLEXIFORM_VISUAL_RUN_HOME;
  for (const name of names) {
    expect(Object.keys(FAKE_PROVIDER_PATHS), `no fake for ${name}`).toContain(name);
    expect(under(run, onPath(name, process.env.PATH)), `ai-tools would find ${name} at ${onPath(name, process.env.PATH)}`).toBe(true);
  }
});

test('a launch with a caller-supplied env keeps the app HOME and its fakes; a caller HOME is refused', async () => {
  await expect(launchApp({ env: { HOME: '/tmp/not-the-app-home' } })).rejects.toThrow(/do not pass env\.HOME/);
  await expect(launchApp({ env: { USERPROFILE: '/tmp/not-the-app-home' } })).rejects.toThrow(/do not pass env\.HOME/);
  const h = await launchApp({ env: { SOME_SPEC_VARIABLE: '1' }, homeFiles: { '.seed': 'x' } });
  try {
    const env = await h.app.evaluate(() => ({ HOME: process.env.HOME, PATH: process.env.PATH, extra: process.env.SOME_SPEC_VARIABLE }));
    expect(env.extra).toBe('1');
    expect(env.HOME).toBe(h.userHome);
    expect(under(h.userHome, onPath('codex', env.PATH))).toBe(true);
    // The finders, asked with the app's own final env (what McpAuto's findCodexBin sees), resolve inside its HOME.
    const { runner, ...finders } = resolve({ ...process.env, ...env, SOME_SPEC_VARIABLE: undefined });
    for (const [id, p] of Object.entries(finders)) expect(under(h.userHome, p), `${id} resolves to ${p}`).toBe(true);
  } finally { await h.cleanup(); }
});
