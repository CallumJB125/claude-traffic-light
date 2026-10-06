// Runs hooks/set-status.js for one forwarded event inside the app, with the
// same source and the same session-file write a spawned hook would make (the
// state fuzzer runs the script this way too). Only events that need no process
// lookup are taken: the session must already be on record with its host app
// and Claude pid, and that pid must still match what the hook process saw
// (macOS/Linux: its parent; Windows: alive). Anything else returns false and
// the hook process does the work itself.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Fast = require('../hooks/fast-hook.js');

const EXIT = Symbol('exit');
let compiled = null;
function compile(hooksDir) {
  if (compiled && compiled.hooksDir === hooksDir) return compiled.fn;
  const file = path.join(hooksDir, 'set-status.js');
  const fn = new Function('require', 'process', 'Date', '__dirname', '__filename', fs.readFileSync(file, 'utf8').replace(/^#!.*\n/, ''));
  compiled = { hooksDir, fn };
  return fn;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readSession(rootDir, sessionId) {
  const host = os.hostname().split('.')[0];
  try { return JSON.parse(fs.readFileSync(path.join(rootDir, 'sessions', `${host}-${sessionId}.json`), 'utf8')); } catch { return null; }
}

// msg: a validated message from hooks/fast-hook.js build(). → boolean handled.
function runForwarded({ hooksDir, rootDir, msg, platform = process.platform, isAlive = alive }) {
  if (!Fast.FORWARD_SIGNALS.has(msg.signal) || typeof msg.payload !== 'string' || !msg.payload) return false;
  let data;
  try { data = JSON.parse(msg.payload); } catch { return false; }
  if (!data || typeof data !== 'object' || !Fast.eligible(msg.signal, data)) return false;
  const sessionId = data.session_id || data.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const prev = readSession(rootDir, sessionId);
  const pid = prev && prev.claudePid;
  if (!prev || !prev.hostApp || !Number.isInteger(pid) || pid <= 1) return false;
  if (platform === 'win32' ? !isAlive(pid) : pid !== msg.ppid) return false;

  const stdin = Buffer.from(msg.payload);
  let sent = false;
  const fakeFs = {
    ...fs,
    readSync(fd, buf, off, len, pos) {
      if (fd !== 0) return fs.readSync(fd, buf, off, len, pos);
      if (sent) return 0;
      sent = true;
      return stdin.copy(buf, off);
    },
    writeSync(fd, buf, ...rest) { return fd === 1 ? buf.length - (rest[0] || 0) : fs.writeSync(fd, buf, ...rest); },
  };
  const proc = {
    argv: [process.execPath, path.join(hooksDir, 'set-status.js'), msg.signal],
    env: { CLAUDE_TRAFFIC_LIGHT_HOME: rootDir, CLAUDE_TRAFFIC_LIGHT_ASK_MS: '0', PLEXIFORM_NO_FAST: '1', ...msg.env },
    stdin: { isTTY: false }, stderr: { write() {} }, pid: process.pid, ppid: msg.ppid, platform,
    execPath: process.execPath,
    exit(code) { throw { [EXIT]: code ?? 0 }; },
    cwd: () => (typeof msg.cwd === 'string' && msg.cwd ? msg.cwd : process.cwd()),
  };
  const req = (m) => (m === 'fs' ? fakeFs : m.startsWith('.') ? require(path.join(hooksDir, m)) : require(m)); // privacy-flow: local-server
  try {
    compile(hooksDir)(req, proc, Date, hooksDir, path.join(hooksDir, 'set-status.js'));
  } catch (e) {
    if (!(e && typeof e === 'object' && EXIT in e)) return false;
  }
  return true;
}

module.exports = { runForwarded };
