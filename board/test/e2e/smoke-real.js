#!/usr/bin/env node
// Opt-in REAL end-to-end smoke (costs real money, budget-capped; not in any
// test script): the real hub process + the real runner process + the real
// board-mcp + the member's own `claude --model haiku`, a tiny temp repo whose
// "GitHub" origin is a local bare repo (insteadOf), and a fake GitHub API that
// knows exactly the commits pushed to that bare repo (so a pushed commit is
// hub_verified). One card, "add a function and a test", Give to Claude → it
// must end In review with a pushed commit and a test run as evidence.
//   node test/e2e/smoke-real.js [--shots <dir>] [--budget 0.15]
// Uses the member's real HOME for the CLI login; BOARD_HOME, the hub data and
// the repo are temp dirs.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { findOnPath } from '../../runner/supervisor.js';
import { makeRepo, tmpDir, rm, REMOTE_URL } from '../../runner/test/helpers.js';
import { BOARD, freePort, until, login, sleep, Proxy } from './harness.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BUDGET = Number(arg('budget', '0.15'));
const SHOTS = arg('shots', null);

function fakeGitHub(bare) {
  const srv = http.createServer((req, res) => {
    const m = /^\/repos\/acme\/app\/commits\/([0-9a-f]{7,40})$/.exec(req.url);
    let sha = null;
    if (m) { try { sha = execFileSync('git', ['rev-parse', '--verify', `${m[1]}^{commit}`], { cwd: bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { sha = null; } }
    res.writeHead(sha ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(sha ? { sha } : { message: 'Not Found' }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const BODY = `Add a function and a test.

1. Create src/sum.js exporting \`export function sum(a, b) { return a + b; }\`.
2. Create test/sum.test.js using node:test and node:assert that checks sum(2, 3) === 5.
3. Run \`node --test\` and make sure it passes.
4. git add -A, then git commit -m "Add sum() with a test".
5. Push with exactly: git push origin <your branch> (board/<KEY>-r<n>; see your instructions).
6. board_attach_evidence kind "commit" with ref = the full commit sha (git rev-parse HEAD), and board_attach_evidence kind "test_run" with ref "node --test", result "pass".
7. board_complete with a one-line summary and both evidence ids.
Keep it minimal; no other files, no refactors.`;

async function main() {
  const claude = findOnPath('claude');
  if (!claude) throw new Error('no claude on PATH');
  const root = tmpDir('bRS-');
  const report = { root, budget_usd: BUDGET };
  const procs = [];
  try {
    const repo = makeRepo(root);
    fs.writeFileSync(path.join(repo.checkout, 'package.json'), `${JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'package.json'); repo.git('push', '-q', 'origin', 'main');
    const gh = await fakeGitHub(repo.bare);
    const dataDir = path.join(root, 'hub');
    fs.mkdirSync(dataDir);
    const port = await freePort();
    const hubOut = fs.openSync(path.join(root, 'hub.log'), 'a');
    const hub = spawn(process.execPath, [path.join(BOARD, 'hub', 'server.js')], {
      env: { PATH: process.env.PATH, HOME: dataDir, BOARD_AUTH: 'dev', BOARD_BIND: '127.0.0.1', BOARD_PORT: String(port), BOARD_DATA_DIR: dataDir, BOARD_DEV_SEED: '1', BOARD_DEV_REPO: REMOTE_URL, BOARD_GITHUB_TOKEN: 'fake', BOARD_GITHUB_API: `http://127.0.0.1:${gh.address().port}` },
      stdio: ['ignore', hubOut, hubOut],
    });
    procs.push(hub);
    const url = `http://127.0.0.1:${port}`;
    await until(async () => { try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; } }, { what: 'hub' });
    const alice = await login(url, 'alice');
    const repoId = (await alice.call('GET', '/api/repos')).body.repos[0].id;

    // Runner: real process, temp BOARD_HOME, real HOME (the member's claude login).
    const home = path.join(root, 'rh');
    fs.mkdirSync(home, { mode: 0o700 });
    const proxy = await new Proxy(port).listen();
    const dev = (await alice.call('POST', '/api/devices', { name: 'Smoke MacBook' })).body;
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR, BOARD_HOME: home };
    execFileSync(process.execPath, [path.join(BOARD, 'runner', 'cli.js'), 'enroll', '--hub', `http://127.0.0.1:${proxy.port}`, '--device', dev.device_id, '--token', dev.device_token], { env });
    fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({
      repos: { [repoId]: { opt_in: true, local_path: repo.checkout, model: 'haiku', budget_per_run: BUDGET, allow_write_extra: [repo.bare] } },
      accept_from: {}, backends: { claude }, never_auto_labels: [],
    }), { mode: 0o600 });
    const runOut = fs.openSync(path.join(root, 'runner.log'), 'a');
    const runner = spawn(process.execPath, [path.join(BOARD, 'runner', 'cli.js'), 'start', '--foreground'], { env, stdio: ['ignore', runOut, runOut] });
    procs.push(runner);
    await until(async () => (await alice.call('GET', '/api/devices')).body.devices.some((d) => d.online), { what: 'runner online' });

    const card = (await alice.call('POST', `/api/boards/${alice.boardId}/cards`, { title: 'Add a function and a test', body: BODY, acceptance: 'sum(2, 3) === 5, tested, committed and pushed on the run branch.', repo_id: repoId })).body.card;
    const t0 = Date.now();
    const d = await alice.call('POST', `/api/cards/${card.id}/actions/dispatch`, { budget_usd: BUDGET });
    if (d.status !== 200) throw new Error(`dispatch ${d.status} ${JSON.stringify(d.body)}`);
    const seen = new Set();
    let green = null;
    const final = await until(async () => {
      const v = (await alice.call('GET', `/api/cards/${card.id}`)).body;
      seen.add(v.card.run_state);
      if (v.card.live?.green && green == null) green = Date.now() - t0;
      return ['in_review', 'failed', 'done', 'handed_over'].includes(v.card.run_state) ? v : null;
    }, { what: 'terminal state', timeout: 6 * 60_000, every: 500 });
    await sleep(1500);
    const detail = (await alice.call('GET', `/api/cards/${card.id}`)).body;
    const branch = detail.card.branch;
    let pushed = null;
    try { pushed = execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: repo.bare, encoding: 'utf8' }).trim(); } catch { pushed = null; }
    let files = null;
    if (pushed) files = execFileSync('git', ['ls-tree', '-r', '--name-only', pushed], { cwd: repo.bare, encoding: 'utf8' }).trim().split('\n');
    const facts = new Set(detail.feed.map((e) => e.kind));
    Object.assign(report, {
      final_state: final.card.run_state, fail_kind: final.card.fail_kind, fail_reason: final.card.fail_reason, states_seen: [...seen], green_after_ms: green,
      elapsed_s: Math.round((Date.now() - t0) / 1000), cost_usd: detail.run?.cost_usd ?? null, branch, pushed_sha: pushed, files_on_branch: files,
      evidence: detail.evidence.map((e) => ({ kind: e.kind, ref: e.ref, verification: e.verification, result: e.result })),
      card_evidence: detail.card.evidence, permission_requests: detail.permission_requests.map((p) => `${p.tool}: ${p.input_summary} → ${p.state}`),
      feed_kinds: [...facts], commands: (detail.handover?.doc?.layers?.facts?.commands ?? []).map((c) => `${c.cmd} → ${c.exit}`),
      runner_errors: fs.readFileSync(path.join(root, 'runner.log'), 'utf8').split('\n').filter((l) => /"level":"(error|warn)"/.test(l)).slice(0, 10),
    });
    // The permission prompts the agent hit: every one would have waited for a human.
    report.ok = final.card.run_state === 'in_review' && !!pushed && detail.evidence.some((e) => e.kind === 'commit' && e.verification === 'hub_verified') && detail.evidence.some((e) => e.kind === 'test_run');

    if (SHOTS) {
      const { chromium } = await import('playwright');
      fs.mkdirSync(SHOTS, { recursive: true });
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      const ctx = await browser.newContext({ baseURL: url, viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
      await ctx.request.post('/api/dev/login', { data: { github_login: 'alice' } });
      const page = await ctx.newPage();
      await page.goto('/');
      await page.waitForSelector(`[data-card-id="${card.id}"]`);
      await sleep(800);
      report.screenshot = path.join(SHOTS, 'board-final.png');
      await page.screenshot({ path: report.screenshot });
      await page.click(`[data-card-id="${card.id}"] .card-open`);
      await sleep(1200);
      report.screenshot_drawer = path.join(SHOTS, 'board-final-drawer.png');
      await page.screenshot({ path: report.screenshot_drawer });
      await browser.close();
    }
    await proxy.close();
    gh.close();
  } finally {
    for (const p of procs.reverse()) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
    await sleep(1500);
    for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
    if (!process.env.BOARD_SMOKE_KEEP) rm(root); else report.kept = root;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(2); });
