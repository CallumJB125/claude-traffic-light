// Release smoke test for the installers: the packaged app starts, installs
// its Claude Code hooks, runs one of them exactly as Claude Code would (the
// installed shell command, a hook payload on stdin), sees the session it
// reported, opens its window, and quits with a JSON report.
//
// CI only. It refuses unless HOME and the data folder are throwaway temp
// folders, because installing hooks writes ~/.claude/settings.json.
//   <app> --smoke-test=<report.json>   (HOME and CLAUDE_TRAFFIC_LIGHT_HOME set to temp dirs)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FLAG = '--smoke-test=';

function reportPathFrom(argv) {
  const a = argv.find((x) => x.startsWith(FLAG));
  return a ? a.slice(FLAG.length) : null;
}

const inside = (child, parent) => {
  const rel = path.relative(fs.realpathSync(parent), fs.realpathSync(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// Why this machine is not a place to run the smoke test, or null.
function unsafeReason({ home = os.homedir(), dataDir = process.env.CLAUDE_TRAFFIC_LIGHT_HOME, tmp = os.tmpdir() } = {}) {
  try {
    if (!dataDir) return 'CLAUDE_TRAFFIC_LIGHT_HOME is not set';
    if (!inside(home, tmp)) return `HOME (${home}) is not a temp folder`;
    if (!inside(dataDir, tmp)) return `CLAUDE_TRAFFIC_LIGHT_HOME (${dataDir}) is not a temp folder`;
  } catch (err) {
    return err.message;
  }
  return null;
}

function firstHookCommand(settingsPath, event) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const group of settings.hooks?.[event] || []) {
    for (const h of group.hooks || []) if (h.type === 'command' && typeof h.command === 'string') return h.command;
  }
  return null;
}

function runHook(command, payload, { env, timeoutMs = 15000, onSpawn }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { shell: true, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); // privacy-flow: release-smoke
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, stderr: `${stderr}\n(timed out)` }); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, stderr: err.message }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr: stderr.slice(-2000) }); });
    child.stdin.end(JSON.stringify(payload));
    // Trusted disposable smoke observer only; never change input or wait for it.
    try { if (typeof onSpawn === 'function') onSpawn({ pid: child.pid, parentPid: process.pid, started }); } catch {}
  });
}

async function waitFor(check, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return check();
}

/**
 * deps: { app, installHooks, areHooksInstalled, createWindow, getWindow,
 *         settingsPath, sessionsDir, reportPath }
 */
async function run(deps) {
  const { app, reportPath } = deps;
  const report = { ok: false, platform: process.platform, arch: process.arch, version: app.getVersion(), packaged: app.isPackaged, steps: {} };
  const step = (name, ok, detail) => { report.steps[name] = detail === undefined ? { ok } : { ok, detail }; return ok; };
  try {
    const unsafe = unsafeReason();
    if (!step('temp-home', !unsafe, unsafe || undefined)) throw new Error(unsafe);

    deps.installHooks();
    step('hooks-installed', deps.areHooksInstalled(), deps.settingsPath);

    const command = firstHookCommand(deps.settingsPath, 'SessionStart');
    step('hook-command', !!command, command || 'no SessionStart hook');
    if (command) {
      const onSpawn = process.platform === 'win32' && process.env.PLEXIFORM_PORTABLE_HOOK_OBSERVE === '1' && path.basename(reportPath) === 'portable.json' ? receipt => {
        // Fixed metadata only. Actual shell identity is independently bound by
        // the parent observer to the launcher ancestry and trusted cmd image.
        if (!Number.isInteger(receipt.pid) || receipt.pid <= 0 || receipt.pid > 0xffffffff || !Number.isInteger(receipt.parentPid) || receipt.parentPid <= 0 || receipt.parentPid > 0xffffffff || !Number.isSafeInteger(receipt.started) || receipt.started <= 0) return;
        const text = JSON.stringify({ schema: 1, phase: 'portable-hook-start', ...receipt, image: 'cmd.exe' });
        if (Buffer.byteLength(text) <= 512) fs.writeFileSync(path.join(path.dirname(reportPath), 'portable-hook-start.json'), text, { flag: 'wx', mode: 0o600 });
      } : undefined;
      const sessionId = `smoke-${process.pid}`;
      const cwd = os.tmpdir();
      const res = await runHook(command, { session_id: sessionId, hook_event_name: 'SessionStart', cwd, transcript_path: path.join(cwd, `${sessionId}.jsonl`), source: 'startup' }, { env: process.env, onSpawn });
      step('hook-ran', res.code === 0, res.code === 0 ? undefined : `exit ${res.code}: ${res.stderr}`);
      const seen = await waitFor(() => fs.readdirSync(deps.sessionsDir).some((f) => f.includes(sessionId)), 10000);
      step('session-reported', seen, seen ? undefined : fs.readdirSync(deps.sessionsDir));
    }

    deps.createWindow();
    const win = deps.getWindow();
    const loaded = win ? await windowLoaded(win.webContents) : false;
    step('window-loaded', loaded, loaded ? undefined : win?.webContents.getURL());

    report.ok = Object.values(report.steps).every((s) => s.ok);
  } catch (err) {
    report.error = err.message;
  }
  try { fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); } catch (err) { console.error('[smoke] could not write report:', err.message); }
  console.error('[smoke]', JSON.stringify(report));
  app.exit(report.ok ? 0 : 1);
}

// The widget page itself finished loading. Before loadFile starts, a window
// is "not loading" with an empty URL, so that alone proves nothing: it is the
// page's own did-finish-load, or an idle window already showing the page.
function windowLoaded(wc, { timeoutMs = 20000, page = 'index.html', pollMs = 250 } = {}) {
  const isPage = () => { try { const u = new URL(wc.getURL()); return u.protocol === 'file:' && u.pathname.endsWith(`/${page}`); } catch { return false; } };
  return new Promise((resolve) => {
    let poll = null;
    const finish = (ok) => { clearTimeout(t); clearInterval(poll); wc.removeListener('did-finish-load', onLoad); resolve(ok); };
    const t = setTimeout(() => finish(false), timeoutMs);
    function onLoad() { if (isPage()) finish(true); }
    const check = () => { if (!wc.isLoading() && isPage()) finish(true); };
    wc.on('did-finish-load', onLoad);
    poll = setInterval(check, pollMs);
    check();
  });
}

module.exports = { run, reportPathFrom, unsafeReason, firstHookCommand, windowLoaded, runHook };
