// Fixtures for the waiting-input specs: real blocking hooks (so an answer
// travels the whole way and the request disappears), request files with no
// hook behind them (for expiry), session files written by the real
// set-status hook, and a real tmux pane showing a Claude Code dialog.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { decisionHashOf } = require('../hooks/answer-file.js');

const SET_STATUS = path.join(__dirname, '..', 'hooks', 'set-status.js');
const HOST = os.hostname().split('.')[0];

// A blocking hook that waits for the widget. → { child, done: Promise<{out, code}> }
function blockingHook(h, signal, payload, { askMs = 45000 } = {}) {
  const child = spawn(process.execPath, [SET_STATUS, signal], { // exec: the app's own hook script, run as the tests' agent
    env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: h.home, CLAUDE_TRAFFIC_LIGHT_PORT: String(h.port), CLAUDE_TRAFFIC_LIGHT_ASK_MS: String(askMs) },
  });
  child.stdin.end(JSON.stringify(payload));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const done = new Promise((res) => child.on('exit', (code) => res({ out, code })));
  return { child, done };
}

function hookSync(h, signal, payload, env = {}) {
  const r = spawnSync(process.execPath, [SET_STATUS, signal], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: h.home, CLAUDE_TRAFFIC_LIGHT_PORT: String(h.port), ...env } }); // exec: the app's own hook script
  if (r.status !== 0) throw new Error(`set-status ${signal}: ${r.stderr}`);
}

// A request file with nobody waiting on it (the app can show it, not answer it).
function staleRequest(h, req) {
  const dir = path.join(h.home, 'requests');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const full = { sessionId: 'visual', cwd: '/visual/app', summary: '', toolInputHash: 'x', createdAt: new Date().toISOString(), ...req };
  full.decisionHash = decisionHashOf(full);
  fs.writeFileSync(path.join(dir, `${full.id}.json`), JSON.stringify(full), { mode: 0o600 });
  return full;
}

function clearRequests(h) {
  const dir = path.join(h.home, 'requests');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
}
function clearSessions(h) {
  const dir = path.join(h.home, 'sessions');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
}

// Pretend a session has been in its current state for a while.
function ageSession(h, id, ms) {
  const f = path.join(h.home, 'sessions', `${HOST}-${id}.json`);
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  const at = new Date(Date.now() - ms).toISOString();
  for (const k of ['updatedAt', 'signalSince', 'since']) if (k in s) s[k] = at;
  if (s.ask) s.ask.at = at;
  if (s.blocked) s.blocked.at = at;
  fs.writeFileSync(f, JSON.stringify(s));
}

// A private tmux server whose one pane shows a Claude Code dialog, captured
// from the pane fixtures. → { env: {TMUX, TMUX_PANE}, kill() }
function tmuxDialog(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-tmux-'));
  const sock = path.join(dir, 's');
  const text = path.join(__dirname, '..', 'test', 'fixtures', 'panes', fixture);
  const tmux = (...a) => execFileSync('tmux', ['-S', sock, ...a], { encoding: 'utf8' }).trim(); // exec: a private tmux server for this spec only
  tmux('new-session', '-d', '-x', '100', '-y', '30', `cat '${text}'; sleep 600`);
  let pane = '';
  for (let i = 0; i < 20 && !pane; i++) { try { pane = tmux('display-message', '-p', '#{pane_id}'); } catch { /* starting */ } }
  const pid = tmux('display-message', '-p', '#{pid}');
  return {
    env: { TMUX: `${sock},${pid},0`, TMUX_PANE: pane },
    kill() { try { tmux('kill-server'); } catch { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

module.exports = { HOST, blockingHook, hookSync, staleRequest, clearRequests, clearSessions, ageSession, tmuxDialog };
