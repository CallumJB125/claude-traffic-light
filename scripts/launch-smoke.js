#!/usr/bin/env node
// Launches Electron (source checkout, or a packaged binary given as argv[2]) with throwaway
// data dirs and fails if main throws while loading or after start. A live pid is not proof of a start.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const exe = process.argv[2] || path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const args = process.argv[2] ? [] : [path.join(__dirname, '..')];
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-smoke-'));
// HOME is isolated too: a first run connects Claude Code by editing ~/.claude/settings.json, which must never be the real one.
fs.mkdirSync(path.join(home, 'userhome'), { recursive: true });
const env = { ...process.env, HOME: path.join(home, 'userhome'), CLAUDE_TRAFFIC_LIGHT_HOME: path.join(home, 'home') };
const child = spawn(exe, [...args, `--user-data-dir=${path.join(home, 'ud')}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
setTimeout(() => {
  child.kill('SIGKILL');
  fs.rmSync(home, { recursive: true, force: true });
  const bad = /App threw an error|Uncaught Exception|ReferenceError|TypeError|Cannot access/.test(out);
  const started = /\[startup\]/.test(out);
  if (bad || !started) { console.error(out.slice(0, 3000)); console.error(bad ? 'launch smoke FAILED: main threw' : 'launch smoke FAILED: never reached [startup]'); process.exit(1); }
  console.log('launch smoke ok');
}, Number(process.env.SMOKE_MS) || 20000);
