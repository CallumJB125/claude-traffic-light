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

function fixture(tmp) {
  const home = path.join(tmp, 'home');
  const data = path.join(home, '.claude-traffic-light');
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  // First-run help would open a second window; the smoke test only needs the widget.
  fs.writeFileSync(path.join(data, '.help-shown'), new Date().toISOString());
  return { tmp, home, data, userData: path.join(tmp, 'user-data') };
}

async function runPackagedSmoke({ exe, home, data, userData, report, extraEnv = {}, timeoutMs = TIMEOUT_MS, observeBeforeTimeout }) {
  if (!exe || !fs.existsSync(exe)) throw new Error(`no packaged app found (looked in ${DIST}); pass its path`);

  // Its own Electron profile and signal port, so it can never meet a real
  // install's single-instance lock, storage or port on the same machine.
  const args = [`--smoke-test=${report}`, `--user-data-dir=${userData}`];
  // CI Linux has no setuid chrome-sandbox; this is the runner, not a shipped default.
  if (process.platform === 'linux') args.push('--no-sandbox');
  const env = { ...process.env, ...extraEnv, HOME: home, USERPROFILE: home, CLAUDE_TRAFFIC_LIGHT_HOME: data, CLAUDE_TRAFFIC_LIGHT_PORT: String(await freePort()), ELECTRON_ENABLE_LOGGING: '1', ELECTRON_LOG_FILE: `${report}.chromium.log` };
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`smoke: ${exe}`);
  const code = await new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(exe, args, { env, stdio: 'inherit' });
    let settled = false, observed = false;
    const finish = code => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(observationTimer); resolve(code); };
    const timer = setTimeout(() => { if (settled) return; console.error('smoke: timed out'); child.kill(); finish(124); }, timeoutMs);
    // Trusted CI caller only. Capture early enough to see the nested portable
    // hook launch; observation never extends the smoke or hook deadlines.
    const observationTimer = typeof observeBeforeTimeout === 'function' ? setTimeout(() => {
      Promise.resolve().then(() => {
        if (settled || observed) return;
        observed = true;
        return observeBeforeTimeout({ pid: child.pid ?? null, started, exe, elapsedMs: Date.now() - started });
      }).catch(() => {});
    }, 55000) : null;
    child.on('exit', c => finish(c ?? 1));
    child.on('error', err => { console.error(err.message); finish(1); });
  });
  const result = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
  console.log(JSON.stringify(result, null, 2));
  if (code !== 0 || !result?.ok) {
    throw new Error(`smoke: FAILED (exit ${code}); diagnostic report ${report}`);
  }
  console.log('smoke: ok');
  return result;
}

async function main() {
  const fromDist = !process.argv[2];
  const temp = fixture(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'plexiform-smoke-')));
  try {
    await runPackagedSmoke({ ...temp, exe: process.argv[2] || findExecutable(), report: path.join(temp.tmp, 'report.json') });
    fs.rmSync(temp.tmp, { recursive: true, force: true });
    // A local run leaves no extra app registered with macOS (a no-op on CI).
    if (fromDist) require('./forget-local-build.js').forgetLocalBuild({ dist: DIST });
  } catch (err) {
    console.error(`smoke: retained failure diagnostics in ${temp.tmp}`);
    throw err;
  }
}

if (require.main === module) main().catch((err) => { console.error(`smoke: ${err.message}`); process.exitCode = 1; });
module.exports = { fixture, runPackagedSmoke, findExecutable };
