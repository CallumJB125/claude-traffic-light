// PR 2b: the Tasks helper process accepts {type:'login.env'} over parentPort, keeps it in memory only and never
// logs it. The helper runs here as a plain node child with a fake parentPort (the same stand-in as the runner's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '..', 'utility-entry.js');
const PRELOAD = path.resolve(HERE, '..', '..', 'runner', 'test', 'fixtures', 'fake-parent-port.js');
const SECRET = 'sk-shell-LOGINSECRET000000000000000000000000';

test('the Tasks helper takes login.env before and after it is ready and never logs or echoes a value', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'le-entry-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ['--import', PRELOAD, ENTRY], {
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: os.tmpdir(), PLEXIFORM_TASKS_DATA_DIR: dataDir, CLAUDE_TRAFFIC_LIGHT_HOME: path.join(root, 'tl') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let out = '';
  const messages = [];
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('message', (m) => messages.push(m));
  const exited = new Promise((r) => child.on('exit', r));
  try {
    child.send({ type: 'login.env', values: { ANTHROPIC_BASE_URL: 'https://shell-gw.example/v1', ANTHROPIC_AUTH_TOKEN: SECRET } });
    const until = Date.now() + 15000;
    while (!messages.some((m) => m.type === 'tasks.listening' || m.type === 'tasks.fatal') && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.ok(messages.some((m) => m.type === 'tasks.listening'), `the helper came up (${JSON.stringify(messages.map((m) => m.type))})`);
    child.send({ type: 'login.env', values: { ANTHROPIC_AUTH_TOKEN: `${SECRET}2` } });
    child.send({ type: 'login.env', values: null });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(child.exitCode, null, 'still running');
    assert.equal(out.includes(SECRET) || out.includes('shell-gw.example'), false, 'no value in the output');
    assert.equal(JSON.stringify(messages).includes(SECRET), false, 'none echoed to main');
  } finally {
    child.send({ type: 'tasks.shutdown' });
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
