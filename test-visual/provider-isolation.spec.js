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
process.stdout.write(JSON.stringify(out));`;
const under = (root, p) => !!p && p.startsWith(root + path.sep);
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
  for (const [id, p] of Object.entries(found)) expect(under(run, p), `${id} resolves to ${p}`).toBe(true);
  for (const name of Object.keys(FAKE_PROVIDER_PATHS)) expect(under(run, onPath(name, process.env.PATH)), `PATH ${name}`).toBe(true);
});

test('an app launched by launchApp finds only the fakes in its own HOME', async () => {
  const h = await launchApp();
  try {
    const found = resolve(homeEnv(h.userHome));
    for (const [id, p] of Object.entries(found)) expect(under(h.userHome, p), `${id} resolves to ${p}`).toBe(true);
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
