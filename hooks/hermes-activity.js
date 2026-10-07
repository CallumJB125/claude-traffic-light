'use strict';
// Private plugin bridge: bounded metadata to the existing local session store.
// Deliberately does not load remote reporter configuration or read provider state.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const State = require('./session-state');
const ID = /^[A-Za-z0-9_.-]{1,120}$/;
const TURN = /^[A-Za-z0-9_.:-]{1,256}$/;
const cwdOf = (c) => (typeof c === 'string' && c.length <= 1024 && path.isAbsolute(c) && !/[\x00-\x1f\x7f]/.test(c) ? c : '');
function apply(data, root) {
  if (!data || !ID.test(data.sessionId) || typeof data.sessionId !== 'string' || !['start', 'working', 'stop', 'end', 'ask', 'answered'].includes(data.event)) return false;
  if (['working', 'stop', 'ask', 'answered'].includes(data.event) && (typeof data.turnId !== 'string' || !TURN.test(data.turnId))) return false;
  if (data.event === 'stop' && typeof data.failed !== 'boolean') return false;
  const dir = path.join(root, 'sessions'), host = os.hostname().split('.')[0];
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = State.sessionFileFor(dir, host, 'hermes', data.sessionId);
  return State.withLock(file, () => {
    const prev = State.readJson(file);
    const tap = (signal) => { try { require('./handover-tap.js').record({ rootDir: root, adapter: 'hermes', signal, sessionId: data.sessionId, cwd: cwdOf(data.cwd) || prev?.cwd || '', data: {} }); } catch { /* the handover is best effort */ } };
    if (data.event === 'end') { fs.rmSync(file, { force: true }); tap('session-end'); return true; }
    if (data.event === 'start' && prev) return false;
    const closed = Array.isArray(prev?.hermesClosedTurns) ? prev.hermesClosedTurns.slice(-32) : [];
    if (['working', 'ask', 'answered'].includes(data.event) && closed.includes(data.turnId)) return false;
    // An approval needs a known session and never lands on a different turn still in progress.
    if (['ask', 'answered'].includes(data.event) && (!prev || (prev.hermesTurnId && prev.hermesTurnId !== data.turnId && !closed.includes(prev.hermesTurnId)))) return false;
    if (data.event === 'stop') {
      if (closed.includes(data.turnId)) return false;
      // A non-streaming turn has no working event. Accept its final outcome
      // after the previous observed turn closed, without letting an old stop
      // overwrite a different currently working turn.
      if (prev?.hermesTurnId && prev.hermesTurnId !== data.turnId && !closed.includes(prev.hermesTurnId)) return false;
      if (!closed.includes(data.turnId)) closed.push(data.turnId);
    }
    const signal = { start: 'session-start', working: 'tool-use', ask: 'permission-ask', answered: 'tool-use', stop: data.failed ? 'turn-failed' : 'stop' }[data.event];
    const next = State.applyBareSignal(prev, { sessionId: data.sessionId, host, source: 'hermes', cwd: cwdOf(data.cwd) || prev?.cwd || '', signal });
    if (signal === 'permission-ask' && next.signal === 'permission-ask') next.askKind = 'request';
    next.hermesTurnId = data.turnId || prev?.hermesTurnId || null;
    next.hermesClosedTurns = closed.slice(-32);
    State.writeJsonAtomic(file, next);
    tap(signal);
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
