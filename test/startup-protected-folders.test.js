'use strict';
// A session's project folder may sit under ~/Desktop, ~/Documents or
// ~/Downloads, where macOS parks a synchronous open() on the main thread until
// its privacy prompt is answered. On 1.0.2-beta.92/95 the policy spend-cap
// tick (src/policy.js, first run 5 s after module load) walked every folder in
// today's usage with existsSync, so a fresh ad-hoc-signed build could sit
// before app.isReady() with no widget and no signal server. These tests keep
// main-thread policy code off sync fs for project folders, and keep that work
// behind the widget and the signal server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Policy = require('../src/policy.js');

function project(t, policy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-folder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'Desktop', 'proj');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.plexiform'));
  fs.writeFileSync(path.join(repo, '.plexiform', 'policy.json'), JSON.stringify(policy));
  const data = path.join(dir, 'data');
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(data, 'sessions', 'h-s1.json'), JSON.stringify({ sessionId: 's1', cwd: path.join(repo, 'src') }));
  return { repo, data, user: path.join(dir, 'Desktop') };
}

// Every sync fs call on a path under `folder` throws, as a stand-in for the hang.
function forbidSync(t, folder) {
  const hits = [];
  for (const name of Object.keys(fs)) {
    if (!/Sync$/.test(name) || typeof fs[name] !== 'function') continue;
    const real = fs[name];
    fs[name] = function guarded(p, ...rest) {
      if (typeof p === 'string' && (p === folder || p.startsWith(folder + path.sep))) {
        hits.push(`${name} ${p}`);
        throw new Error('sync fs on user folder at startup');
      }
      return real.call(this, p, ...rest);
    };
    t.after(() => { fs[name] = real; });
  }
  return hits;
}

test('the spend-cap pass reads project folders only asynchronously', async (t) => {
  const { repo, data, user } = project(t, { version: 1, name: 'Capped', dailySpendCapUsd: 5 });
  const hits = forbidSync(t, user);
  const now = Date.now();
  const repos = await Policy.overCaps({ rootDir: data, turns: [{ ts: now - 1000, cwd: path.join(repo, 'src') }, { ts: now - 2000, cwd: repo }], now, costOf: () => 3 });
  assert.deepEqual(Object.keys(repos), [repo], 'the policy file was still found and read');
  assert.deepEqual(hits, []);
});

test('Sessions rows, Settings → Policies and the task guard keep off sync fs on project folders', async (t) => {
  const { repo, data, user } = project(t, { version: 1, name: 'Held', dailySpendCapUsd: 5, holdTasksAtLimit: true });
  const hits = forbidSync(t, user);
  const row = await Policy.rowInfo({ sessionId: 's1', cwd: path.join(repo, 'src') }, data);
  assert.equal(row.name, 'Held');
  const state = await Policy.state(data);
  assert.deepEqual(state.repos.map((r) => [r.root, r.name]), [[repo, 'Held']]);
  const pv = await Policy.preview(data, { target: repo, pack: 'careful' });
  assert.equal(pv.path, path.join(repo, '.plexiform', 'policy.json'));
  assert.match(pv.current, /Held/);
  const now = Date.now();
  const hold = await Policy.startHold({ rootDir: data, cwd: repo, turns: [{ ts: now - 1, cwd: repo }, { ts: now - 2, cwd: repo }], now, costOf: () => 3 });
  assert.match(hold.text, /on hold/);
  assert.deepEqual(hits, []);
});

test('a project folder that never answers counts as no repo instead of stalling the pass', async (t) => {
  const never = () => new Promise(() => {});
  const r = await Policy.findRepo('/Users/someone/Desktop/proj', { exists: (p) => (p.includes('Desktop') ? Promise.race([never(), new Promise((res) => setTimeout(res, 20, false))]) : Promise.resolve(false)) });
  assert.deepEqual(r, { root: '/Users/someone/Desktop/proj', policyFile: null });
});

test('the policy tick waits for afterStartup (widget and signal server up)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0;
  let start = null;
  Policy.register({ rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'policy-tick-')), ipcMain: { handle() {} }, fromPage: () => false, usageTurns: async () => { calls += 1; return []; }, afterStartup: (fn) => { start = fn; } });
  t.mock.timers.tick(120000);
  await new Promise(setImmediate);
  assert.equal(calls, 0, 'nothing ran before startup finished');
  assert.equal(typeof start, 'function');
  start();
  t.mock.timers.tick(5000);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
});

test('main.js: startup is marked done only after the widget and the signal server, and paid packages get afterStartup', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const block = src.slice(src.indexOf("Watchdog.step('widget');"));
  const widget = block.indexOf('createWindow();');
  const server = block.indexOf('signalServer = startSignalServer();');
  const up = block.indexOf('startupUp();');
  assert.ok(widget >= 0 && server > widget && up > server, 'createWindow, then startSignalServer, then startupUp');
  assert.match(src, /registerAll\(\{ afterStartup,/);
  assert.doesNotMatch(src, /policy: \(row\) => require\('\.\/src\/policy\.js'\)\.rowInfo/, 'Sessions rows resolve policies before the snapshot, asynchronously');
  const policySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'policy.js'), 'utf8');
  assert.doesNotMatch(policySrc, /Gate\.findRepo\(/, 'src/policy.js walks project folders with its async findRepo');
});
