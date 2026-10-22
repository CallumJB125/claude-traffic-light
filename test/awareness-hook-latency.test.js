'use strict';
// AW9: with nothing changed, the awareness check adds at most 5 ms (p95) to a
// Claude UserPromptSubmit hook, with fastHook off (the default) and on; the
// fast path is still taken when it is on; no HTTP call is made for awareness.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const Hook = require('../hooks/awareness.js');
const Receipt = require('../hooks/team-brief-receipt.js');
const { testTempDir } = require('./helpers/tmp');

const HOOKS = path.join(__dirname, '..', 'hooks');
const RUNS = 200;
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };

function world(t, fastHook) {
  const dir = fs.realpathSync(testTempDir('pf-aw-latency-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root');
  const repo = path.join(dir, 'code', 'app');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'awareness'), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(root, 'port'), '1');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ fastHook }));
  const peers = Array.from({ length: 8 }, (_, i) => ({ handle: `codex-peer${i}-abc${i}`, provider: 'codex', folder: `peer${i}`, repo_key: null, branch: null, status: 'working', waiting_on: null }));
  const roster = { v: 1, generated_at: new Date().toISOString(), excluded_roots: Array.from({ length: 20 }, (_, i) => String(i).padStart(32, '0')), peers, groups: [], self: { 'claude|s1': { handle: 'claude-app-a1e0', allowed: true, interactive: true, repo_key: 'aaaaaaaaaaaaaaaa' } } };
  const write = () => { roster.generated_at = new Date().toISOString(); fs.writeFileSync(path.join(root, 'awareness', 'roster.json'), JSON.stringify(roster)); };
  write();
  const payload = { session_id: 's1', cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
  // The first turn prints and records; every later one has nothing new.
  const first = Hook.check({ adapter: 'claude', event: 'UserPromptSubmit', payload, root });
  assert.ok(first);
  assert.equal(Receipt.recordDelivered(first), true);
  return { dir, root, repo, payload, roster, write };
}

for (const fastHook of [false, true]) {
  test(`AW9: the no-change check, ${RUNS} prompts, fastHook ${fastHook ? 'on' : 'off'}: p95 at most 5 ms, and a cold hook process's module load stays small`, (t) => {
    const w = world(t, fastHook);
    const times = [];
    for (let i = 0; i < RUNS; i += 1) {
      const t0 = process.hrtime.bigint();
      const out = Hook.check({ adapter: 'claude', event: 'UserPromptSubmit', payload: w.payload, root: w.root });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      assert.equal(out, null);
    }
    assert.ok(p95(times) <= 5, `warm p95 ${p95(times).toFixed(2)} ms`);
    // Cold: a fresh hook process that has loaded what set-status.js already loads on a prompt (team-brief.js),
    // then pays for loading awareness.js and one check. Measured as CPU time, so a busy test machine's
    // scheduling does not count as hook cost.
    const script = `require(${JSON.stringify(path.join(HOOKS, 'team-brief.js'))});require(${JSON.stringify(path.join(HOOKS, 'session-state.js'))});`
      + `const c0=process.cpuUsage();const H=require(${JSON.stringify(path.join(HOOKS, 'awareness.js'))});`
      + `const out=H.check({adapter:'claude',event:'UserPromptSubmit',payload:${JSON.stringify(w.payload)},root:${JSON.stringify(w.root)}});`
      + 'const c=process.cpuUsage(c0);process.stdout.write(JSON.stringify({ms:(c.user+c.system)/1000,out}))';
    const cold = [];
    for (let i = 0; i < 30; i += 1) {
      const r = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
      assert.equal(r.out, null);
      cold.push(r.ms);
    }
    // The AW9 bound is the check's warm p95 above. A cold process also pays one module load: about 3 ms of CPU
    // when run alone, about double while the whole suite runs in parallel, so here it is only bounded loosely
    // (a regression guard) and reported.
    const median = [...cold].sort((a, b) => a - b)[Math.floor(cold.length / 2)];
    t.diagnostic(`AW9 fastHook ${fastHook ? 'on' : 'off'}: warm p95 ${p95(times).toFixed(2)} ms, cold median ${median.toFixed(2)} ms, cold p95 ${p95(cold).toFixed(2)} ms (CPU)`);
    assert.ok(median <= 25, `cold median ${median.toFixed(2)} ms`);
  });
}

test('AW9: with fastHook on, an unchanged roster still takes the fast path; a changed one takes the full path and prints', async (t) => {
  const w = world(t, true);
  const sock = path.join(w.dir, 'h.sock');
  const got = [];
  const server = net.createServer((c) => { let b = ''; c.setEncoding('utf8'); c.on('data', (d) => { b += d; if (b.includes('\n')) { got.push(JSON.parse(b.slice(0, b.indexOf('\n'))).signal); c.end('{"ok":true}\n'); } }); });
  await new Promise((r) => server.listen(sock, r));
  t.after(() => server.close());
  fs.writeFileSync(path.join(w.root, 'hook-endpoint.json'), JSON.stringify({ v: 1, path: sock, token: 't'.repeat(40) }));
  const hook = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(HOOKS, 'set-status.js'), 'prompt-submit'], { env: { PATH: process.env.PATH, HOME: os.homedir(), CLAUDE_TRAFFIC_LIGHT_HOME: w.root, CLAUDE_CODE_ENTRYPOINT: 'cli' } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => resolve(out));
    c.stdin.end(JSON.stringify(w.payload));
  });
  assert.equal(await hook(), '', 'unchanged: no output');
  assert.deepEqual(got, ['prompt-submit'], 'and forwarded to the app (the fast path)');
  w.roster.peers.unshift({ handle: 'claude-new-0001', provider: 'claude', folder: 'new', status: 'working' });
  w.write();
  const out = await hook();
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /claude-new-0001/);
  assert.deepEqual(got, ['prompt-submit'], 'a change is printed by the hook itself, not forwarded');
  assert.equal(spawnSync(process.execPath, ['-e', `const s=require('fs').readFileSync(${JSON.stringify(path.join(HOOKS, 'awareness.js'))},'utf8');process.exit(/require\\(['"](?:node:)?(?:https?|net)['"]\\)/.test(s)?1:0)`]).status, 0, 'no HTTP or socket in the awareness hook');
});
