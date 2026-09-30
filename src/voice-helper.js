// Runs the on-device speech helper (native/voice/buddy-listen) for one
// push-to-talk question at a time. `spawn` is injected so tests drive a fake
// helper and never reach the microphone or a permission prompt.
//
// The helper keeps audio in memory only; this side only ever sees text.
const readline = require('readline');

const FRIENDLY = {
  'speech-denied': 'Speech recognition is off for Claude Buddy. Turn it on in System Settings, Privacy and Security, Speech Recognition.',
  'mic-denied': 'The microphone is off for Claude Buddy. Turn it on in System Settings, Privacy and Security, Microphone.',
};
const friendly = (e) => FRIENDLY[e] || String(e || 'Listening failed.');

function createListener({ spawn, helperPath, exists, platform = process.platform, onState, onFinal, log = () => {} }) {
  let child = null;
  let holdSupported = false;

  const available = () => platform === 'darwin' && !!helperPath && exists(helperPath);
  const unavailableReason = () => (platform !== 'darwin' ? 'Voice questions are macOS only for now.' : 'The voice helper is not built into this copy of Claude Buddy.');

  // holdKey: the macOS keycode being held (hotkey), or null when the caller
  // says when to stop (a long-press on the widget ends on mouseup).
  function start({ holdKey = null, maxMs = 15000 } = {}) {
    if (child) return { ok: false, reason: 'already listening' };
    if (!available()) return { ok: false, reason: unavailableReason() };
    const args = ['listen', '--max-ms', String(maxMs)];
    if (holdKey != null) args.push('--hold-key', String(holdKey));
    let c;
    try { c = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (err) { return { ok: false, reason: err.message }; }
    child = c;
    holdSupported = holdKey != null;
    let done = false;
    const finish = (fn) => { if (done) return; done = true; fn(); };
    onState({ state: 'listening' });
    readline.createInterface({ input: c.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.event === 'partial' && !done) onState({ state: 'listening', partial: String(m.text || '') });
      else if (m.event === 'hold-unsupported') holdSupported = false;
      else if (m.event === 'final') finish(() => { log(`[voice] transcript ready ${Number(m.ms) || 0} ms after release`); onFinal(String(m.text || '')); });
      else if (m.event === 'error') finish(() => { log(`[voice] helper: ${m.error}`); onState({ state: 'error', error: friendly(m.error) }); });
    });
    if (c.stderr) c.stderr.resume();
    c.on('error', (err) => { if (child === c) child = null; finish(() => onState({ state: 'error', error: `Voice helper failed: ${err.message}` })); });
    // 'close' (not 'exit'): every stdout line has been read by then.
    c.on('close', () => { if (child === c) child = null; finish(() => onState({ state: 'idle' })); });
    return { ok: true };
  }

  function stop() {
    if (!child) return false;
    try { child.stdin.write('stop\n'); child.stdin.end(); } catch { /* already exiting */ }
    return true;
  }

  function cancel() {
    if (!child) return;
    try { child.kill(); } catch { /* gone */ }
  }

  return {
    start, stop, cancel, available, unavailableReason,
    get listening() { return !!child; },
    get holdSupported() { return holdSupported; },
  };
}

module.exports = { createListener, friendly };
