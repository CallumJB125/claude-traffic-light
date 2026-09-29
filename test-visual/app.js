// Hermetic launcher for the visual specs. Every launch gets its own temp
// data dir, signal port and Electron userData, so it can neither read nor
// write ~/.claude-traffic-light and cannot collide with a running install's
// single-instance lock.
const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const FIXED_CONFIG = {
  roam: false,
  randomEvents: false,
  seasonal: false,
  showTasks: false,
  showAgents: false,
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function launchApp({ extraArgs = [], config = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-visual-home-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cbuddy-visual-ud-'));
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  // Pre-mark the first-run help so it never pops up unasked.
  fs.writeFileSync(path.join(home, '.help-shown'), '2000-01-01T00:00:00.000Z');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...FIXED_CONFIG, ...config }));
  fs.writeFileSync(path.join(home, 'window-bounds.json'), JSON.stringify({ x: 200, y: 200, width: 200, height: 200 }));
  const port = await freePort();
  // `--demo visual` is an unrecognised demo name: it flags the run as a dev
  // run (no hook installs, no login item, no background pollers) without
  // overriding CLAUDE_TRAFFIC_LIGHT_HOME/PORT.
  const app = await electron.launch({
    args: [ROOT, `--user-data-dir=${userData}`, '--demo', 'visual', ...extraArgs],
    env: {
      ...process.env,
      CLAUDE_TRAFFIC_LIGHT_HOME: home,
      CLAUDE_TRAFFIC_LIGHT_PORT: String(port),
      CLAUDE_TRAFFIC_LIGHT_ROUTER_HOME: path.join(home, 'router-home'),
    },
  });
  const cleanup = async () => {
    try { await app.close(); } catch { /* already gone */ }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  };
  return { app, home, port, cleanup };
}

async function signal(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/signal`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`signal ${JSON.stringify(body)} -> ${res.status}`);
}

async function status(port) {
  return (await fetch(`http://127.0.0.1:${port}/status`)).json();
}

async function windowByFile(app, file, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const w = app.windows().find((p) => p.url().endsWith(file));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no window for ${file}`);
}

module.exports = { launchApp, signal, status, windowByFile };
