// Runs the packaged app's smoke test (src/smoke.js) against a throwaway HOME:
// launch → install hooks → run one → window loads → quit. Used by the release
// workflow on each OS after electron-builder has written dist/.
//   node scripts/smoke-installed.js [path/to/app/executable]
// Without a path it finds the unpacked app electron-builder left in dist/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const DIST = path.join(__dirname, '..', 'dist');
const TIMEOUT_MS = 120_000;

function findExecutable() {
  const candidates = {
    darwin: () => ['mac-arm64', 'mac', 'mac-universal'].map((d) => path.join(DIST, d)).filter((d) => fs.existsSync(d))
      .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.app')).map((a) => path.join(d, a, 'Contents', 'MacOS', a.replace(/\.app$/, '')))),
    win32: () => (fs.existsSync(path.join(DIST, 'win-unpacked')) ? fs.readdirSync(path.join(DIST, 'win-unpacked')).filter((f) => f.endsWith('.exe') && !/^Uninstall/i.test(f)).map((f) => path.join(DIST, 'win-unpacked', f)) : []),
    linux: () => [path.join(DIST, 'linux-unpacked', 'plexiform')],
  }[process.platform];
  return (candidates ? candidates() : []).find((p) => fs.existsSync(p)) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function main() {
  const fromDist = !process.argv[2];
  const exe = process.argv[2] || findExecutable();
  if (!exe || !fs.existsSync(exe)) throw new Error(`no packaged app found (looked in ${DIST}); pass its path`);
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'plexiform-smoke-'));
  const home = path.join(tmp, 'home');
  const data = path.join(home, '.claude-traffic-light');
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  // First-run help would open a second window; the smoke test only needs the widget.
  fs.writeFileSync(path.join(data, '.help-shown'), new Date().toISOString());
  const report = path.join(tmp, 'report.json');

  // Its own Electron profile and signal port, so it can never meet a real
  // install's single-instance lock, storage or port on the same machine.
  const userData = path.join(tmp, 'user-data');
  const args = [`--smoke-test=${report}`, `--user-data-dir=${userData}`];
  // CI Linux has no setuid chrome-sandbox; this is the runner, not a shipped default.
  if (process.platform === 'linux') args.push('--no-sandbox');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_TRAFFIC_LIGHT_HOME: data, CLAUDE_TRAFFIC_LIGHT_PORT: String(await freePort()), ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`smoke: ${exe}`);
  const code = await new Promise((resolve) => {
    const child = spawn(exe, args, { env, stdio: 'inherit' });
    const timer = setTimeout(() => { console.error('smoke: timed out'); child.kill(); resolve(124); }, TIMEOUT_MS);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c ?? 1); });
    child.on('error', (err) => { clearTimeout(timer); console.error(err.message); resolve(1); });
  });
  const result = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
  console.log(JSON.stringify(result, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
  if (code !== 0 || !result?.ok) {
    console.error(`smoke: FAILED (exit ${code})`);
    process.exit(1);
  }
  console.log('smoke: ok');
  // A local run leaves no extra app registered with macOS (a no-op on CI).
  if (fromDist) require('./forget-local-build.js').forgetLocalBuild({ dist: DIST });
}

main().catch((err) => { console.error(`smoke: ${err.message}`); process.exit(1); });
