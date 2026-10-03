'use strict';
// Private plugin bridge: bounded metadata to the existing local session store.
// Deliberately does not load remote reporter configuration or read provider state.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const State = require('./session-state');
const ID = /^[A-Za-z0-9_.-]{1,120}$/;
const TURN = /^[A-Za-z0-9_.:-]{1,256}$/;
function apply(data, root) {
  if (!data || !ID.test(data.sessionId) || typeof data.sessionId !== 'string' || !['start', 'working', 'stop', 'end'].includes(data.event)) return false;
  if (['working', 'stop'].includes(data.event) && (typeof data.turnId !== 'string' || !TURN.test(data.turnId))) return false;
  if (data.event === 'stop' && typeof data.failed !== 'boolean') return false;
  const dir = path.join(root, 'sessions'), host = os.hostname().split('.')[0];
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = State.sessionFileFor(dir, host, 'hermes', data.sessionId);
  return State.withLock(file, () => {
    const prev = State.readJson(file);
    if (data.event === 'end') { fs.rmSync(file, { force: true }); return true; }
    if (data.event === 'start' && prev) return false;
    const closed = Array.isArray(prev?.hermesClosedTurns) ? prev.hermesClosedTurns.slice(-32) : [];
    if (data.event === 'working' && closed.includes(data.turnId)) return false;
    if (data.event === 'stop') {
      if (closed.includes(data.turnId)) return false;
      // A non-streaming turn has no working event. Accept its final outcome
      // after the previous observed turn closed, without letting an old stop
      // overwrite a different currently working turn.
      if (prev?.hermesTurnId && prev.hermesTurnId !== data.turnId && !closed.includes(prev.hermesTurnId)) return false;
      if (!closed.includes(data.turnId)) closed.push(data.turnId);
    }
    const signal = { start: 'session-start', working: 'tool-use', stop: data.failed ? 'turn-failed' : 'stop' }[data.event];
    const next = State.applyBareSignal(prev, { sessionId: data.sessionId, host, source: 'hermes', cwd: '', signal });
    next.hermesTurnId = data.turnId || prev?.hermesTurnId || null;
    next.hermesClosedTurns = closed.slice(-32);
    State.writeJsonAtomic(file, next);
    return true;
  }, 200);
}
if (require.main === module) {
  let bytes = 0, chunks = [];
  const timer = setTimeout(() => process.exit(0), 500);
  process.stdin.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) process.exit(0); chunks.push(chunk); });
  process.stdin.on('end', () => {
    clearTimeout(timer);
    try { apply(JSON.parse(Buffer.concat(chunks).toString('utf8')), process.env.CLAUDE_TRAFFIC_LIGHT_HOME || path.join(os.homedir(), '.claude-traffic-light')); } catch {}
  });
  process.stdin.on('error', () => process.exit(0));
}
module.exports = { apply };
